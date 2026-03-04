import CaptionDebug from './debug.js';

// ─── Constants ────────────────────────────────────────────────────────────

const OVERLAY_ID = 'twitch-ru-captions';
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const CAPTION_TIMEOUT_MS = 60_000; // WASM inference can take 30-60s per chunk

// Twitch video player selectors (ordered by specificity)
const VIDEO_PLAYER_SELECTORS = [
  '.video-player__container',
  '[data-a-target="video-player"]',
  '.persistent-player',
  'video',
];

// ─── State ────────────────────────────────────────────────────────────────

let overlayEl = null;
let lastCaptionTimestamp = null;
const MAX_VISIBLE_LINES = 4;
let lastPipelineActivity = null; // updated by both captions AND heartbeats
let healthCheckInterval = null;
let sessionActive = false;
let settings = {
  captionFontSize: '18px',
  captionPosition: 'bottom-center',
  captionDuration: 4000,
};

// ─── Settings ─────────────────────────────────────────────────────────────

async function loadSettings() {
  const result = await chrome.storage.local.get({
    captionFontSize: '18px',
    captionPosition: 'bottom-center',
    captionDuration: 4000,
  });
  settings = result;
  if (overlayEl) applyPositionStyle();
}

// ─── Overlay Injection ───────────────────────────────────────────────────

function findVideoContainer() {
  for (const sel of VIDEO_PLAYER_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function createOverlay() {
  if (document.getElementById(OVERLAY_ID)) {
    overlayEl = document.getElementById(OVERLAY_ID);
    CaptionDebug.log('content', 'Overlay already exists — reusing');
    return true;
  }

  const container = findVideoContainer();
  if (!container) {
    CaptionDebug.warn('content', 'Video container not found — cannot inject overlay', {
      triedSelectors: VIDEO_PLAYER_SELECTORS,
    });
    return false;
  }

  // Ensure container is positioned
  const containerStyle = window.getComputedStyle(container);
  if (containerStyle.position === 'static') {
    container.style.position = 'relative';
  }

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;

  applyPositionStyle();
  container.appendChild(overlayEl);

  CaptionDebug.log('content', 'Caption overlay injected', {
    container: container.tagName,
    containerClass: container.className.slice(0, 80),
  });

  return true;
}

function applyPositionStyle() {
  if (!overlayEl) return;

  overlayEl.className = '';
  overlayEl.classList.add('twitch-caption-overlay');

  switch (settings.captionPosition) {
    case 'bottom-left':
      overlayEl.classList.add('caption-pos-bl');
      break;
    case 'bottom-right':
      overlayEl.classList.add('caption-pos-br');
      break;
    default:
      overlayEl.classList.add('caption-pos-bc');
      break;
  }

}

function removeOverlay() {
  overlayEl?.remove();
  overlayEl = null;
}

// ─── Caption Rendering ──────────────────────────────────────────────────

function renderCaption(text) {
  if (!overlayEl) {
    if (!createOverlay()) return;
  }

  // Create a new line element
  const line = document.createElement('span');
  line.className = 'caption-line';
  line.textContent = text;
  line.style.fontSize = settings.captionFontSize;
  overlayEl.appendChild(line);

  // Cap visible lines — remove oldest immediately
  while (overlayEl.children.length > MAX_VISIBLE_LINES) {
    overlayEl.removeChild(overlayEl.firstChild);
  }

  // Fade out and remove this line after the configured duration
  setTimeout(() => {
    line.classList.add('fading');
    setTimeout(() => {
      line.remove();
    }, 500);
  }, settings.captionDuration);
}

// ─── Health Check Watchdog ───────────────────────────────────────────────

function startHealthCheck() {
  healthCheckInterval = setInterval(() => {
    // Use pipeline activity (captions + heartbeats) to determine if pipeline is alive.
    // This prevents false stall warnings during silence — the offscreen document
    // sends heartbeats even when skipping silent chunks.
    if (
      lastPipelineActivity &&
      Date.now() - lastPipelineActivity > CAPTION_TIMEOUT_MS
    ) {
      CaptionDebug.warn('content', 'No pipeline activity recently — pipeline may be stalled', {
        lastActivity: new Date(lastPipelineActivity).toISOString(),
        silenceMs: Date.now() - lastPipelineActivity,
      });
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  lastCaptionTimestamp = null;
  lastPipelineActivity = null;
}

// ─── MutationObserver for Twitch SPA ─────────────────────────────────────

// Twitch is a SPA — the video player may not exist on initial page load.
// Watch for DOM changes and inject the overlay once the player appears.
const observer = new MutationObserver(() => {
  if (sessionActive && !document.getElementById(OVERLAY_ID)) {
    const found = createOverlay();
    if (found) {
      CaptionDebug.log('content', 'Re-injected overlay after DOM change');
    }
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

// ─── Message Handler ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'CAPTION_TEXT':
      lastCaptionTimestamp = Date.now();
      lastPipelineActivity = Date.now();
      renderCaption(msg.text);
      break;

    case 'PIPELINE_HEARTBEAT':
      lastPipelineActivity = Date.now();
      break;

    case 'CAPTION_ERROR':
      CaptionDebug.error('content', 'Received error from pipeline', {
        error: msg.error,
        message: msg.message,
      });
      break;

    case 'CAPTION_SESSION_START':
      CaptionDebug.log('content', 'Caption session started');
      sessionActive = true;
      lastCaptionTimestamp = Date.now();
      lastPipelineActivity = Date.now(); // prevent premature stall warning during model load
      loadSettings();
      createOverlay();
      renderCaption('Captions started — loading model...');
      startHealthCheck();
      break;

    case 'CAPTION_SESSION_STOP':
      CaptionDebug.log('content', 'Caption session stopped');
      sessionActive = false;
      stopHealthCheck();
      removeOverlay();
      break;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────

loadSettings();
CaptionDebug.log('content', 'Content script initialized', {
  url: window.location.href,
});
