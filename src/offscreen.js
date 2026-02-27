import CaptionDebug from './debug.js';

// Pre-register ONNX Runtime so transformers.js uses it directly
// instead of trying to dynamically import from CDN (blocked by extension CSP).
import * as ort from 'onnxruntime-web';
globalThis[Symbol.for('onnxruntime')] = ort;

// Point ONNX Runtime to local WASM files bundled with the extension
ort.env.wasm.wasmPaths = chrome.runtime.getURL('wasm/');

import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

// ─── Offscreen Log Forwarder ──────────────────────────────────────────────
// Offscreen documents can't access chrome.storage, so CaptionDebug._maybePersist
// silently fails. Route all logs through the background service worker instead.

const _origEntry = CaptionDebug._entry.bind(CaptionDebug);
CaptionDebug._entry = function (level, source, message, data) {
  const entry = _origEntry(level, source, message, data);
  // Forward to background for persistence and popup visibility
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_LOG',
    entry,
  }).catch(() => {});
  return entry;
};

// ─── State ────────────────────────────────────────────────────────────────

let transcriber = null;
let audioContext = null;
let mediaStream = null;
let keepAliveInterval = null;
let isTranscribing = false;
let chunkCount = 0;
let deviceMode = 'unknown'; // 'webgpu' | 'wasm' | 'unknown'
let modelLoading = false;
let scriptNode = null;

// Raw PCM sample buffer — accumulates Float32 samples from Web Audio API
let sampleBuffer = [];
let sampleBufferLength = 0;

// Audio chunk buffer — holds PCM chunks recorded while model is still loading
let pendingChunks = [];

// ─── Settings ─────────────────────────────────────────────────────────────

// Offscreen documents don't have chrome.storage access.
// Settings are passed from background.js via the START_TRANSCRIPTION message.
let currentSettings = {
  modelSize: 'base',
  chunkDurationMs: 5000,
};

// ─── Model Loading ───────────────────────────────────────────────────────

async function loadModel() {
  if (modelLoading) return;
  modelLoading = true;

  const modelId = `onnx-community/whisper-${currentSettings.modelSize}`;

  CaptionDebug.log('offscreen', 'Loading Whisper model', { modelId });

  const startTime = performance.now();

  // Report progress to popup
  const progressCallback = (progress) => {
    chrome.runtime.sendMessage({
      type: 'MODEL_PROGRESS',
      progress,
    }).catch(() => {});
  };

  // Use WASM directly — offscreen documents don't have WebGPU access
  // NOTE: task/language are inference-time options, NOT pipeline constructor options
  transcriber = await pipeline('automatic-speech-recognition', modelId, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: progressCallback,
  });
  deviceMode = 'wasm';
  modelLoading = false;

  CaptionDebug.log('offscreen', 'Whisper model loaded (WASM)', {
    modelId,
    loadTimeMs: Math.round(performance.now() - startTime),
  });

  // Notify background of device mode so popup can display it
  chrome.runtime.sendMessage({ type: 'DEVICE_MODE', deviceMode }).catch(() => {});

  // Process any audio chunks that were buffered during model load
  if (pendingChunks.length > 0) {
    CaptionDebug.log('offscreen', 'Processing buffered audio chunks', {
      count: pendingChunks.length,
    });
    // Only process the most recent chunk (older ones are stale)
    const latestChunk = pendingChunks[pendingChunks.length - 1];
    pendingChunks = [];
    await processAudioChunk(latestChunk);
  }
}

// ─── Audio Processing ────────────────────────────────────────────────────

// Compute RMS energy of audio samples (0.0 = silence, 1.0 = max)
function computeRMS(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) {
    sum += float32[i] * float32[i];
  }
  return Math.sqrt(sum / float32.length);
}

// Silence threshold — RMS below this means no meaningful audio
const SILENCE_RMS_THRESHOLD = 0.005;

// Known Whisper hallucination phrases (lowercase, trimmed)
// These appear when Whisper processes silence, music, or noise
const HALLUCINATION_PHRASES = new Set([
  'the end',
  'the end.',
  'subscribe',
  'subscribe.',
  'thanks for watching',
  'thanks for watching!',
  'thanks for watching.',
  'thank you for watching',
  'thank you for watching!',
  'thank you for watching.',
  'thank you.',
  'like and subscribe',
  'please subscribe',
  'see you next time',
  'bye bye',
  'bye bye.',
  'bye.',
  'goodbye.',
  'you',
  '...',
  'music',
  '[music]',
  '♪',
]);

// Detect repetitive text like "yes, yes, yes, yes" or "Andrium Andrium Andrium"
function isRepetitiveText(text) {
  // Split into words and check if any single word makes up >60% of the text
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length < 3) return false;

  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  const maxFreq = Math.max(...Object.values(freq));
  return maxFreq / words.length > 0.6;
}

async function processAudioChunk(float32_16k) {
  if (!transcriber) {
    CaptionDebug.warn('offscreen', 'Transcriber not ready — buffering chunk', {
      pendingCount: pendingChunks.length,
    });
    pendingChunks.push(float32_16k);
    // Cap buffer at 3 chunks to avoid memory issues
    if (pendingChunks.length > 3) pendingChunks.shift();
    return;
  }

  if (!float32_16k || float32_16k.length === 0) {
    CaptionDebug.warn('offscreen', 'Empty audio data — skipping chunk');
    return;
  }

  chunkCount++;
  const chunkId = chunkCount;

  // Check audio energy — skip inference on silence to save CPU
  const rms = computeRMS(float32_16k);
  if (rms < SILENCE_RMS_THRESHOLD) {
    CaptionDebug.log('offscreen', 'Silence detected — skipping inference', {
      chunkId,
      rms: rms.toFixed(6),
    });
    return;
  }

  CaptionDebug.log('offscreen', 'Processing audio chunk', {
    chunkId,
    audioSamples: float32_16k.length,
    audioDurationMs: Math.round((float32_16k.length / 16000) * 1000),
    rms: rms.toFixed(4),
  });

  const inferenceStart = performance.now();

  try {
    const result = await transcriber(float32_16k, {
      language: 'russian',
      task: 'translate',
    });
    const inferenceMs = Math.round(performance.now() - inferenceStart);

    const text = result.text?.trim();

    CaptionDebug.log('offscreen', 'Inference complete', {
      chunkId,
      inferenceMs,
      textLength: text?.length ?? 0,
      text: text?.slice(0, 100),
    });

    // Filter out known Whisper hallucinations
    if (!text || text.length === 0) return;

    const lowerText = text.toLowerCase();
    if (HALLUCINATION_PHRASES.has(lowerText)) {
      CaptionDebug.log('offscreen', 'Filtered hallucination', { chunkId, text });
      return;
    }

    if (isRepetitiveText(text)) {
      CaptionDebug.log('offscreen', 'Filtered repetitive text', { chunkId, text });
      return;
    }

    chrome.runtime.sendMessage({
      type: 'CAPTION_TEXT',
      text,
      isFinal: true,
    }).catch((err) => {
      CaptionDebug.warn('offscreen', 'Failed to send caption text', { error: err.message });
    });
  } catch (err) {
    CaptionDebug.error('offscreen', 'Whisper inference failed', {
      chunkId,
      error: err.message,
      stack: err.stack,
    });
  }
}

// ─── Web Audio Capture ──────────────────────────────────────────────────

// Uses Web Audio API (ScriptProcessorNode) to capture raw PCM samples directly
// from the tab audio stream. This avoids MediaRecorder's WebM container issue
// where only the first chunk has headers and subsequent chunks can't be decoded.

async function startRecording(streamId) {
  const chunkDurationMs = currentSettings.chunkDurationMs;

  // Acquire the media stream from the stream ID provided by background.js
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
  } catch (err) {
    CaptionDebug.error('offscreen', 'Failed to acquire media stream', {
      streamId,
      error: err.message,
    });
    chrome.runtime.sendMessage({
      type: 'CAPTION_ERROR',
      error: 'STREAM_ACQUISITION_FAILED',
      message: 'Could not access tab audio. Try restarting captions.',
    });
    return false;
  }

  CaptionDebug.log('offscreen', 'Media stream acquired', {
    tracks: mediaStream.getAudioTracks().length,
  });

  // Create AudioContext to process raw PCM samples
  audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);

  // ScriptProcessorNode captures raw Float32 PCM data
  // Buffer size 4096 at 16kHz = ~256ms per callback
  const bufferSize = 4096;
  scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  const samplesPerChunk = Math.round((chunkDurationMs / 1000) * 16000);

  scriptNode.onaudioprocess = (event) => {
    if (!isTranscribing) return;

    const inputData = event.inputBuffer.getChannelData(0);
    // Copy the data (the buffer is reused by the API)
    sampleBuffer.push(new Float32Array(inputData));
    sampleBufferLength += inputData.length;

    // When we've accumulated enough samples for one chunk, process it
    if (sampleBufferLength >= samplesPerChunk) {
      // Concatenate all buffered samples
      const fullBuffer = new Float32Array(sampleBufferLength);
      let offset = 0;
      for (const chunk of sampleBuffer) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Reset buffer
      sampleBuffer = [];
      sampleBufferLength = 0;

      // Process the chunk (fire and forget)
      processAudioChunk(fullBuffer);
    }
  };

  // Connect: source → scriptNode → destination (required for scriptNode to work)
  source.connect(scriptNode);
  scriptNode.connect(audioContext.destination);

  isTranscribing = true;
  chunkCount = 0;

  CaptionDebug.log('offscreen', 'Web Audio capture started', {
    sampleRate: audioContext.sampleRate,
    bufferSize,
    chunkDurationMs,
    samplesPerChunk,
  });

  return true;
}

function stopRecording() {
  isTranscribing = false;
  pendingChunks = [];
  sampleBuffer = [];
  sampleBufferLength = 0;

  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  CaptionDebug.log('offscreen', 'Recording stopped', { chunksProcessed: chunkCount });
}

// ─── Keep-Alive (Layer 1) ────────────────────────────────────────────────

function startKeepAlive() {
  keepAliveInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'KEEP_ALIVE_PING', timestamp: Date.now() })
      .catch((err) => {
        CaptionDebug.error('offscreen', 'Keep-alive ping failed — service worker may be dead', {
          error: err.message,
        });
        attemptRecovery();
      });
  }, 25_000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ─── Recovery (Layer 2) ──────────────────────────────────────────────────

async function attemptRecovery() {
  CaptionDebug.warn('offscreen', 'Service worker connection lost — checking stream health');

  if (audioContext && audioContext.state === 'running') {
    CaptionDebug.log('offscreen', 'AudioContext still active — stream survived worker death');
    return;
  }

  CaptionDebug.error('offscreen', 'Stream is dead — captioning interrupted', {
    audioContextState: audioContext?.state ?? 'null',
  });

  // Notify content script to show user-facing error
  chrome.runtime.sendMessage({
    type: 'CAPTION_ERROR',
    error: 'SERVICE_WORKER_DIED',
    message: 'Captions interrupted. Click the extension icon to restart.',
  }).catch(() => {
    CaptionDebug.error('offscreen', 'Cannot reach content script — full communication breakdown');
  });

  stopKeepAlive();
  stopRecording();
}

// ─── Message Handler ─────────────────────────────────────────────────────

// NOTE: Chrome's onMessage listener does NOT natively support async callbacks.
// Using an async callback silently breaks sendResponse. Instead, call the async
// work in a fire-and-forget manner and return true to keep the channel open.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_TRANSCRIPTION') {
    // Update settings from background (which has chrome.storage access)
    if (msg.settings) {
      currentSettings = { ...currentSettings, ...msg.settings };
    }

    CaptionDebug.log('offscreen', 'Received START_TRANSCRIPTION', {
      streamId: msg.streamId,
      tabId: msg.tabId,
      settings: currentSettings,
    });

    // Fire async work — don't await in the listener
    (async () => {
      // CRITICAL: Start recording FIRST, before model load.
      // The streamId can expire if we wait for the model to load (which can take minutes).
      // Audio chunks will be buffered in pendingChunks until the model is ready.
      const recordingStarted = await startRecording(msg.streamId);
      if (!recordingStarted) {
        sendResponse({ ok: false });
        return;
      }

      startKeepAlive();
      sendResponse({ ok: true });

      // Load model in background — chunks buffer until ready
      if (!transcriber) {
        try {
          await loadModel();
        } catch (err) {
          CaptionDebug.error('offscreen', 'Failed to load Whisper model', {
            error: err.message,
            stack: err.stack,
          });
          chrome.runtime.sendMessage({
            type: 'CAPTION_ERROR',
            error: 'MODEL_LOAD_FAILED',
            message: `Failed to load the AI model: ${err.message}`,
          }).catch(() => {});
          return;
        }
      }
    })();

    return true; // keep message channel open for async sendResponse
  }

  if (msg.type === 'STOP_TRANSCRIPTION') {
    CaptionDebug.log('offscreen', 'Received STOP_TRANSCRIPTION');
    stopKeepAlive();
    stopRecording();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

CaptionDebug.log('offscreen', 'Offscreen document initialized');
