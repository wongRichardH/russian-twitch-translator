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
let captionTextEl = null;
let fadeTimeout = null;
let lastCaptionTimestamp = null;
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
    captionTextEl = overlayEl.querySelector('.caption-text');
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
  overlayEl.innerHTML = '<span class="caption-text"></span>';
  captionTextEl = overlayEl.querySelector('.caption-text');

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

  if (captionTextEl) {
    captionTextEl.style.fontSize = settings.captionFontSize;
  }
}

function removeOverlay() {
  overlayEl?.remove();
  overlayEl = null;
  captionTextEl = null;
}

// ─── Caption Rendering ──────────────────────────────────────────────────

function renderCaption(text) {
  if (!captionTextEl) {
    if (!createOverlay()) return;
  }

  captionTextEl.textContent = text;
  overlayEl.classList.add('visible');
  overlayEl.classList.remove('fading');

  // Clear previous fade timeout
  if (fadeTimeout) clearTimeout(fadeTimeout);

  // Start fade after configured duration
  fadeTimeout = setTimeout(() => {
    overlayEl?.classList.add('fading');
    // Fully hide after fade animation (500ms in CSS)
    setTimeout(() => {
      overlayEl?.classList.remove('visible', 'fading');
    }, 500);
  }, settings.captionDuration);
}

function showCaptionError(message) {
  if (!captionTextEl) {
    if (!createOverlay()) return;
  }

  captionTextEl.textContent = message;
  captionTextEl.classList.add('caption-error');
  overlayEl.classList.add('visible');

  // Auto-dismiss error after 10 seconds
  setTimeout(() => {
    captionTextEl?.classList.remove('caption-error');
    overlayEl?.classList.remove('visible');
  }, 10_000);
}

// ─── Health Check Watchdog ───────────────────────────────────────────────

function startHealthCheck() {
  healthCheckInterval = setInterval(() => {
    if (lastCaptionTimestamp && (Date.now() - lastCaptionTimestamp > CAPTION_TIMEOUT_MS)) {
      CaptionDebug.warn('content', 'No captions received recently — pipeline may be stalled', {
        lastCaption: new Date(lastCaptionTimestamp).toISOString(),
        silenceMs: Date.now() - lastCaptionTimestamp,
      });
      showCaptionError('Captions may have stalled. Click the extension icon to check status.');
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  lastCaptionTimestamp = null;
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
      renderCaption(msg.text);
      break;

    case 'CAPTION_ERROR':
      CaptionDebug.error('content', 'Received error from pipeline', {
        error: msg.error,
        message: msg.message,
      });
      showCaptionError(msg.message);
      break;

    case 'CAPTION_SESSION_START':
      CaptionDebug.log('content', 'Caption session started');
      sessionActive = true;
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
