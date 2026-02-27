# CLAUDE.md — Twitch Russian-to-English Live Caption Extension

## Project Overview

A Google Chrome Extension (Manifest V3) that captures audio from a Twitch tab, transcribes and translates Russian speech to English in near real-time using a **locally bundled Whisper WASM model** (no API keys, no per-use cost), and renders the translated text as a closed-caption overlay directly on the Twitch video player.

---

## Architecture

### Extension Components

| Component | File | Purpose |
|---|---|---|
| Manifest | `manifest.json` | Declares permissions, registers scripts |
| Background Service Worker | `background.js` | Tab audio capture, keep-alive management, message routing |
| Content Script | `content.js` | Injects caption overlay onto Twitch video DOM |
| Offscreen Document | `offscreen.html` / `offscreen.js` | Runs Whisper WASM inference, processes audio chunks, owns MediaRecorder |
| Popup UI | `popup.html` / `popup.js` | Toggle captions on/off, shows status/errors |
| Options Page | `options.html` / `options.js` | Caption styling, model size selection |
| Debug Logger | `debug.js` | Shared structured logging utility used by all components |

### Data Flow

```
Twitch Tab Audio
    → chrome.tabCapture (background.js)
    → Stream handed off to offscreen document ASAP
    → Audio chunking via MediaRecorder (offscreen.js)
    → whisper.cpp WASM inference (offscreen.js, runs locally)
    → English translated text
    → chrome.runtime.sendMessage
    → Content script (content.js)
    → Caption overlay on Twitch video DOM
```

---

## Service Worker Lifecycle & Resilience

### The Problem

MV3 service workers are **non-persistent** — Chrome terminates `background.js` after ~30 seconds of inactivity. If the worker dies, the `chrome.tabCapture` MediaStream reference can be garbage-collected, silently killing captions mid-stream with no user-facing error.

### Strategy: Keep-Alive + Defensive Stream Handoff

The extension uses a **two-layer resilience approach**:

#### Layer 1: Keep-Alive Ping (Primary)

The offscreen document sends a heartbeat message to the service worker on a 25-second interval for the entire duration of an active captioning session. This prevents Chrome from considering the worker idle.

#### Layer 2: Early Stream Handoff (Backup)

To minimize blast radius if the service worker dies despite the keep-alive:

1. **background.js** captures the tab audio and immediately transfers the stream to the offscreen document via `chrome.runtime.sendMessage` with a `MediaStream` ID or by creating the offscreen document with the stream's `streamId`.
2. **offscreen.js** takes ownership of the `MediaRecorder` and all audio chunking as quickly as possible.
3. If the service worker dies after handoff, the offscreen document's `MediaRecorder` may continue operating on the already-transferred stream.

#### Recovery Flow

If the offscreen document detects the service worker has died (keep-alive ping fails):

1. Log the event with full context.
2. Check if the `MediaRecorder` is still producing data (stream may survive handoff).
3. If the stream is dead, notify the content script to show a "Captions interrupted — click extension to restart" message.
4. Store the failure event so the popup UI can display recovery instructions on next open.

---

## Debug Logging System

All extension components share a structured logging utility. Logs are categorized by source component and severity, and stored for inspection.

### What Gets Logged

| Component | Events Logged |
|---|---|
| `background.js` | Tab capture success/failure, stream handoff, service worker wake/sleep, keep-alive responses, message routing errors |
| `offscreen.js` | Model loading (start/end/error), WebGPU vs WASM device selection, MediaRecorder state changes, audio chunk processing (count, duration), inference time per chunk, keep-alive ping success/failure, stream health checks, recovery attempts |
| `content.js` | Overlay injection success/failure, DOM selector mismatches, caption render events, health-check timeouts, `CAPTION_ERROR` messages received |
| `popup.js` | Session start/stop, last error display from storage, device mode (WebGPU/CPU) |

---

## Local Whisper WASM Setup

### Library
Use **`@xenova/transformers`** package (Hugging Face) which wraps Whisper in a JS-friendly API and handles WASM internally.

### Model Options

| Model | Size | Speed | Quality |
|---|---|---|---|
| `Xenova/whisper-tiny` | ~75MB | Fastest | Lower accuracy |
| `Xenova/whisper-base` | ~150MB | Good balance | Recommended |
| `Xenova/whisper-small` | ~500MB | Slower | Higher accuracy |

**Default: `whisper-base`**, offer `tiny` as a "low resource" option in settings.

### Model Caching
- On first run, the model downloads from Hugging Face CDN and is cached in the browser's Cache API / IndexedDB automatically
- Subsequent uses load from cache instantly — no re-download
- Show a first-run download progress indicator in the popup UI

---

## Key Technical Decisions

### Audio Capture
- Use `chrome.tabCapture.capture()` from the background service worker
- Hand the stream off to the offscreen document immediately after capture
- The offscreen document owns the `MediaRecorder` and chunks audio into **5-second windows**
- Convert chunks to `Float32Array` at 16kHz (Whisper's required sample rate)

### Transcription & Translation
- Run entirely locally via `@xenova/transformers` in the offscreen document
- Use `task: 'translate'` to go Russian → English in one inference pass
- No API key required, no network calls after initial model download
- **WebGPU acceleration enabled by default** — falls back to WASM CPU if unavailable
- Expected inference: under 1s per chunk (WebGPU), 2–4s per chunk (CPU)

### Caption Overlay
- Content script uses `MutationObserver` to detect Twitch video element (SPA)
- Inject `div#twitch-ru-captions` absolutely positioned over the video player
- Style: semi-transparent black background, white text, bottom-center
- Captions fade out after configurable duration (default: 4 seconds)

---

## Permissions Required (`manifest.json`)

```json
"permissions": [
  "tabCapture",
  "offscreen",
  "storage",
  "activeTab",
  "scripting"
],
"host_permissions": [
  "https://*.twitch.tv/*"
]
```

---

## File Structure

```
/extension
├── manifest.json
├── background.js
├── offscreen.html
├── offscreen.js
├── content.js
├── popup.html
├── popup.js
├── options.html
├── options.js
├── debug.js
├── styles/
│   └── captions.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

Note: the Whisper model is NOT bundled — it downloads on first use and caches locally.

---

## Configuration & Settings

| Setting | Default | Notes |
|---|---|---|
| Model size | base | tiny / base selectable in options |
| Audio chunk size | 5 seconds | Shorter = lower latency, more CPU usage |
| Caption font size | 18px | |
| Caption position | Bottom center | Bottom-left / bottom-right also supported |
| Caption display duration | 4 seconds | Time before a caption fades |
| Auto-enable on Twitch | true | Toggle captions on by default |
| Debug mode | false | Persists all log levels when enabled |

---

## Known Constraints & Gotchas

- **Tab audio capture requires user gesture** — must be activated by clicking the popup
- **Service worker termination** — mitigated by keep-alive pings + early stream handoff
- **First-run model download** — ~150MB for whisper-base, show progress indicator
- **Offscreen document memory** — model stays loaded while document is alive
- **Twitch DOM changes** — video element selector may need updating over time
- **Audio format** — Whisper requires 16kHz mono Float32Array

---

## Development Notes

- Install transformers.js: `npm install @xenova/transformers`
- Bundle with **esbuild** — offscreen document needs bundled JS, not raw ESM
- `debug.js` is bundled into each component that uses it
- Test WASM inference in isolation before integrating into extension
- Whisper requires audio at **16kHz mono Float32Array**
