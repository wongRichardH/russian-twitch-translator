import CaptionDebug from './debug.js';

// ─── State ────────────────────────────────────────────────────────────────

let activeTabId = null;
let isCapturing = false;

// ─── Offscreen Document Management ───────────────────────────────────────

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  CaptionDebug.log('background', 'Creating offscreen document');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Audio processing and Whisper WASM inference for live captioning',
  });
  CaptionDebug.log('background', 'Offscreen document created');
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    try {
      await chrome.offscreen.closeDocument();
      CaptionDebug.log('background', 'Offscreen document closed');
    } catch (err) {
      CaptionDebug.warn('background', 'Error closing offscreen document', { error: err.message });
    }
  }
}

// ─── Tab Capture Helpers ────────────────────────────────────────────────

// Check if Chrome thinks a tab is currently captured
async function isTabCaptured(tabId) {
  try {
    const captured = await chrome.tabCapture.getCapturedTabs();
    const match = captured.find((t) => t.tabId === tabId);
    if (match) {
      CaptionDebug.log('background', 'Tab capture status from Chrome', {
        tabId,
        status: match.status,
        fullscreen: match.fullscreen,
      });
      return match.status !== 'stopped' && match.status !== 'error';
    }
    return false;
  } catch (err) {
    CaptionDebug.warn('background', 'getCapturedTabs failed', { error: err.message });
    return false;
  }
}

// Wait for Chrome to report the tab capture as stopped
function waitForCaptureRelease(tabId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabCapture.onStatusChanged.removeListener(listener);
      CaptionDebug.warn('background', 'Timed out waiting for capture release', { tabId, timeoutMs });
      resolve(false);
    }, timeoutMs);

    function listener(info) {
      if (info.tabId === tabId && (info.status === 'stopped' || info.status === 'error')) {
        clearTimeout(timer);
        chrome.tabCapture.onStatusChanged.removeListener(listener);
        CaptionDebug.log('background', 'Chrome confirmed capture released', { tabId, status: info.status });
        resolve(true);
      }
    }

    chrome.tabCapture.onStatusChanged.addListener(listener);
  });
}

// ─── Tab Audio Capture ───────────────────────────────────────────────────

async function releaseExistingCapture(tabId) {
  // Tell offscreen doc to stop its MediaRecorder and release MediaStream tracks
  if (await hasOffscreenDocument()) {
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'STOP_TRANSCRIPTION' }, (response) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(response);
        });
      });
      CaptionDebug.log('background', 'STOP_TRANSCRIPTION acknowledged by offscreen');
    } catch (_) {
      CaptionDebug.warn('background', 'STOP_TRANSCRIPTION failed — offscreen may be dead');
    }
  }

  // If Chrome still thinks the tab is captured, wait for it to release
  if (tabId && await isTabCaptured(tabId)) {
    CaptionDebug.log('background', 'Waiting for Chrome to release tab capture...', { tabId });
    const released = await waitForCaptureRelease(tabId, 5000);
    if (!released) {
      // Nuclear: close the offscreen document to force-release the getUserMedia stream
      CaptionDebug.warn('background', 'Force-closing offscreen doc to release stuck capture');
      await closeOffscreenDocument();
      // Wait again for Chrome to process the closure
      if (await isTabCaptured(tabId)) {
        await waitForCaptureRelease(tabId, 3000);
      }
    }
  }

  isCapturing = false;
  activeTabId = null;
  CaptionDebug.log('background', 'Existing capture released');
}

async function startCapture(tabId) {
  if (isCapturing && activeTabId === tabId) {
    CaptionDebug.warn('background', 'Capture already active on this tab — ignoring', { tabId });
    return;
  }

  // Log what Chrome thinks is captured right now
  try {
    const captured = await chrome.tabCapture.getCapturedTabs();
    CaptionDebug.log('background', 'Currently captured tabs', {
      tabs: captured.map((t) => ({ tabId: t.tabId, status: t.status })),
    });
  } catch (_) {}

  // Release any existing capture (properly waits for Chrome to confirm)
  await releaseExistingCapture(tabId);

  // Ensure the offscreen document is running (reuse if already alive)
  await ensureOffscreenDocument();
  // Let the offscreen document's message listener register
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Verify the tab is actually free now
  if (await isTabCaptured(tabId)) {
    CaptionDebug.error('background', 'Tab still captured after cleanup — refreshing tab', { tabId });
    // Last resort: refresh the tab to force Chrome to release
    await chrome.tabs.reload(tabId);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  try {
    // Read settings from storage to pass to offscreen doc (which can't access chrome.storage)
    const settings = await chrome.storage.local.get({
      modelSize: 'base',
      chunkDurationMs: 5000,
    });

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    CaptionDebug.log('background', 'Tab audio stream ID acquired', { tabId, streamId });

    await chrome.runtime.sendMessage({
      type: 'START_TRANSCRIPTION',
      streamId,
      tabId,
      settings: {
        modelSize: settings.modelSize,
        chunkDurationMs: settings.chunkDurationMs,
      },
    });

    activeTabId = tabId;
    isCapturing = true;

    // Notify content script — if it's not ready yet, inject it first
    chrome.tabs.sendMessage(tabId, { type: 'CAPTION_SESSION_START' }).catch(async () => {
      CaptionDebug.warn('background', 'Content script not ready — injecting', { tabId });
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        await new Promise((r) => setTimeout(r, 300));
        chrome.tabs.sendMessage(tabId, { type: 'CAPTION_SESSION_START' }).catch(() => {});
      } catch (err) {
        CaptionDebug.warn('background', 'Could not inject content script', { error: err.message });
      }
    });

    chrome.action.setBadgeText({ text: 'ON', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });

    CaptionDebug.log('background', 'Stream handed off to offscreen document', { tabId });
  } catch (err) {
    CaptionDebug.error('background', 'Tab capture failed', {
      tabId,
      error: err.message,
    });
    isCapturing = false;
    activeTabId = null;
  }
}

async function stopCapture() {
  CaptionDebug.log('background', 'Stopping capture', { tabId: activeTabId });

  // Notify content script (tab may be closed, so wrap everything in try/catch)
  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'CAPTION_SESSION_STOP' });
    } catch (_) {}
    try {
      await chrome.action.setBadgeText({ text: '', tabId: activeTabId });
    } catch (_) {}
  }

  // Release the capture (properly waits for Chrome to confirm)
  await releaseExistingCapture(activeTabId);
}

// ─── Message Router ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // Keep-alive from offscreen document (Layer 1)
    case 'KEEP_ALIVE_PING':
      CaptionDebug.log('background', 'Keep-alive ping received', { timestamp: msg.timestamp });
      sendResponse({ status: 'alive' });
      return true;

    // Popup requests to toggle captioning
    case 'TOGGLE_CAPTIONS':
      handleToggle(msg.tabId).then(() => sendResponse({ ok: true })).catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
      return true;

    // Popup queries current state
    case 'GET_STATUS':
      sendResponse({
        isCapturing,
        activeTabId,
      });
      return true;

    // Offscreen document forwards translated caption text
    case 'CAPTION_TEXT':
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
          type: 'CAPTION_TEXT',
          text: msg.text,
          isFinal: msg.isFinal,
        }).catch(async (err) => {
          // Content script not responding — try re-injecting it
          CaptionDebug.warn('background', 'Content script not responding — re-injecting', {
            error: err.message,
          });
          try {
            await chrome.scripting.executeScript({
              target: { tabId: activeTabId },
              files: ['content.js'],
            });
            // Retry sending after injection
            await new Promise((r) => setTimeout(r, 300));
            chrome.tabs.sendMessage(activeTabId, {
              type: 'CAPTION_TEXT',
              text: msg.text,
              isFinal: msg.isFinal,
            }).catch(() => {});
          } catch (injectErr) {
            CaptionDebug.error('background', 'Failed to inject content script', {
              error: injectErr.message,
            });
          }
        });
      }
      return false;

    // Offscreen document reports an error
    case 'CAPTION_ERROR':
      CaptionDebug.error('background', 'Pipeline error from offscreen', {
        error: msg.error,
        message: msg.message,
      });
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
          type: 'CAPTION_ERROR',
          error: msg.error,
          message: msg.message,
        }).catch(() => {});
      }
      return false;

    // Offscreen document reports model loading progress
    case 'MODEL_PROGRESS':
      return false;

    // Offscreen document reports which device it's using (webgpu/wasm)
    case 'DEVICE_MODE':
      chrome.storage.local.set({ deviceMode: msg.deviceMode });
      return false;

    // Offscreen document forwards its logs (it can't access chrome.storage directly)
    case 'OFFSCREEN_LOG':
      if (msg.entry) {
        CaptionDebug._maybePersist(msg.entry);
      }
      return false;

    default:
      return false;
  }
});

async function handleToggle(tabId) {
  if (isCapturing) {
    await stopCapture();
  } else {
    if (!tabId) throw new Error('No tab ID provided');
    await startCapture(tabId);
  }
}

// ─── Startup Cleanup ────────────────────────────────────────────────────

// On service worker startup, clean up any stale offscreen documents
// left from a previous session (e.g. after extension reload).
(async () => {
  // Check for any tabs Chrome thinks are still captured
  try {
    const captured = await chrome.tabCapture.getCapturedTabs();
    if (captured.length > 0) {
      CaptionDebug.log('background', 'Found stale captures on startup', {
        tabs: captured.map((t) => ({ tabId: t.tabId, status: t.status })),
      });
    }
  } catch (_) {}

  await closeOffscreenDocument();
  CaptionDebug.log('background', 'Startup cleanup done — cleared stale offscreen documents');
})();

// ─── Tab Lifecycle ───────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    CaptionDebug.log('background', 'Active tab closed — stopping capture', { tabId });
    stopCapture();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.url) {
    const isTwitch = changeInfo.url.includes('twitch.tv');
    if (!isTwitch) {
      CaptionDebug.log('background', 'Active tab navigated away from Twitch — stopping', { tabId, url: changeInfo.url });
      stopCapture();
    }
  }
});

CaptionDebug.log('background', 'Service worker initialized');
