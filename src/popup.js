import CaptionDebug from './debug.js';

// ─── DOM Elements ────────────────────────────────────────────────────────

const toggleBtn = document.getElementById('toggleBtn');
const statusText = document.getElementById('statusText');
const deviceText = document.getElementById('deviceText');
const errorBanner = document.getElementById('errorBanner');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const logPanel = document.getElementById('logPanel');
const logCopyBtn = document.getElementById('logCopyBtn');
const logClearBtn = document.getElementById('logClearBtn');

// ─── State ────────────────────────────────────────────────────────────────

let currentTabId = null;
const MAX_LOG_ENTRIES = 100;

// ─── Live Log ─────────────────────────────────────────────────────────────

function formatLogEntry(entry) {
  const ts = entry.timestamp?.split('T')[1]?.slice(0, 12) ?? '';
  const dataStr = entry.data && Object.keys(entry.data).length > 0
    ? ' ' + JSON.stringify(entry.data)
    : '';
  return `<div class="log-entry ${entry.level}">` +
    `<span class="ts">${ts}</span> ` +
    `<span class="src">[${entry.source}]</span> ` +
    `<span class="msg">${entry.message}${dataStr}</span>` +
    `</div>`;
}

function appendLogEntry(entry) {
  // Remove the "Waiting for events..." placeholder
  const empty = logPanel.querySelector('.log-empty');
  if (empty) empty.remove();

  logPanel.insertAdjacentHTML('beforeend', formatLogEntry(entry));

  // Cap the number of visible entries
  while (logPanel.children.length > MAX_LOG_ENTRIES) {
    logPanel.removeChild(logPanel.firstChild);
  }

  // Auto-scroll to bottom
  logPanel.scrollTop = logPanel.scrollHeight;
}

async function loadPersistedLogs() {
  const { errorLog = [], debugLog = [] } = await chrome.storage.local.get({
    errorLog: [],
    debugLog: [],
  });

  const all = [...errorLog, ...debugLog]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-MAX_LOG_ENTRIES);

  if (all.length === 0) return;

  // Clear placeholder
  logPanel.innerHTML = '';
  logPanel.insertAdjacentHTML('beforeend', all.map(formatLogEntry).join(''));
  logPanel.scrollTop = logPanel.scrollHeight;
}

logCopyBtn.addEventListener('click', () => {
  const text = Array.from(logPanel.querySelectorAll('.log-entry'))
    .map((el) => el.textContent)
    .join('\n');
  navigator.clipboard.writeText(text || 'No logs to copy.').then(() => {
    logCopyBtn.textContent = 'Copied!';
    logCopyBtn.classList.add('copied');
    setTimeout(() => {
      logCopyBtn.textContent = 'Copy';
      logCopyBtn.classList.remove('copied');
    }, 1500);
  });
});

logClearBtn.addEventListener('click', async () => {
  await CaptionDebug.clearPersistedErrors();
  logPanel.innerHTML = '<div class="log-empty">Logs cleared.</div>';
});

// Hook into CaptionDebug so any log from popup.js itself shows up in the panel
const _origEntry = CaptionDebug._entry.bind(CaptionDebug);
CaptionDebug._entry = function (level, source, message, data) {
  const entry = _origEntry(level, source, message, data);
  appendLogEntry(entry);
  return entry;
};

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  // Load persisted logs immediately
  await loadPersistedLogs();

  // Get the current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url?.includes('twitch.tv')) {
    toggleBtn.textContent = 'Not on Twitch';
    toggleBtn.disabled = true;
    toggleBtn.className = 'toggle-btn start';
    statusText.textContent = 'Navigate to a Twitch stream';
    statusText.className = 'status-value inactive';
    CaptionDebug.log('popup', 'Not on a Twitch tab');
    return;
  }

  currentTabId = tab.id;

  // Query current capture state from background
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) {
      CaptionDebug.error('popup', 'Failed to get status', { error: chrome.runtime.lastError.message });
      showError('Could not connect to extension.');
      return;
    }

    updateUI(response.isCapturing);
  });

  // Load device mode from storage
  const { deviceMode, lastError } = await chrome.storage.local.get({
    deviceMode: 'unknown',
    lastError: null,
  });

  updateDeviceDisplay(deviceMode);

  // Show last error if it exists
  if (lastError) {
    showError(lastError.message);
    await chrome.storage.local.remove('lastError');
  }

  toggleBtn.disabled = false;
}

// ─── UI Updates ──────────────────────────────────────────────────────────

function updateUI(isCapturing) {
  if (isCapturing) {
    toggleBtn.textContent = '⏹ Stop Captions';
    toggleBtn.className = 'toggle-btn stop';
    statusText.textContent = 'Active';
    statusText.className = 'status-value active';
  } else {
    toggleBtn.textContent = '▶ Start Captions';
    toggleBtn.className = 'toggle-btn start';
    statusText.textContent = 'Idle';
    statusText.className = 'status-value inactive';
  }
  toggleBtn.disabled = false;
}

function updateDeviceDisplay(mode) {
  switch (mode) {
    case 'webgpu':
      deviceText.textContent = 'WebGPU';
      deviceText.className = 'status-value webgpu';
      break;
    case 'wasm':
      deviceText.textContent = 'CPU (WASM)';
      deviceText.className = 'status-value wasm';
      break;
    default:
      deviceText.textContent = '—';
      deviceText.className = 'status-value';
      break;
  }
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.add('visible');
}

function showProgress(pct, label) {
  progressWrap.classList.add('visible');
  progressFill.style.width = `${Math.round(pct)}%`;
  progressLabel.textContent = label || `Downloading model... ${Math.round(pct)}%`;
}

function hideProgress() {
  progressWrap.classList.remove('visible');
}

// ─── Toggle Handler ──────────────────────────────────────────────────────

toggleBtn.addEventListener('click', async () => {
  if (!currentTabId) return;

  toggleBtn.disabled = true;
  errorBanner.classList.remove('visible');

  CaptionDebug.log('popup', 'Toggle requested', { tabId: currentTabId });

  chrome.runtime.sendMessage(
    { type: 'TOGGLE_CAPTIONS', tabId: currentTabId },
    (response) => {
      if (chrome.runtime.lastError) {
        CaptionDebug.error('popup', 'Toggle failed', { error: chrome.runtime.lastError.message });
        showError('Failed to toggle captions.');
        toggleBtn.disabled = false;
        return;
      }

      if (!response.ok) {
        CaptionDebug.error('popup', 'Toggle returned error', { error: response.error });
        showError(response.error || 'Unknown error');
        toggleBtn.disabled = false;
        return;
      }

      // Re-query state to update UI
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
        updateUI(status.isCapturing);
      });
    }
  );
});

// ─── Listen for runtime messages (progress, captions, errors) ────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'MODEL_PROGRESS' && msg.progress) {
    const p = msg.progress;

    if (p.status === 'progress' && p.progress != null) {
      const pct = Math.round(p.progress);
      showProgress(p.progress, `Downloading ${p.file || 'model'}... ${pct}%`);
      // Only log every 5% to avoid flooding the panel
      if (pct % 5 === 0) {
        appendLogEntry({
          timestamp: new Date().toISOString(),
          level: 'log',
          source: 'model',
          message: `Download ${pct}%`,
          data: { file: p.file },
        });
      }
    }

    if (p.status === 'done' || p.status === 'ready') {
      hideProgress();
      appendLogEntry({
        timestamp: new Date().toISOString(),
        level: 'log',
        source: 'model',
        message: 'Model ready',
        data: {},
      });
    }
  }

  // Stream incoming log-worthy events into the panel
  if (msg.type === 'CAPTION_TEXT') {
    appendLogEntry({
      timestamp: new Date().toISOString(),
      level: 'log',
      source: 'caption',
      message: msg.text,
      data: {},
    });
  }

  if (msg.type === 'CAPTION_ERROR') {
    appendLogEntry({
      timestamp: new Date().toISOString(),
      level: 'error',
      source: 'pipeline',
      message: msg.message || msg.error,
      data: {},
    });
  }

  // Update device mode when it changes
  if (msg.type === 'CAPTION_TEXT' || msg.type === 'CAPTION_ERROR') {
    chrome.storage.local.get({ deviceMode: 'unknown' }, ({ deviceMode }) => {
      updateDeviceDisplay(deviceMode);
    });
  }
});

// ─── Poll storage for new logs from other components ─────────────────────

// Other components (background, offscreen) persist logs to storage.
// Poll periodically to surface them in the live panel.
let lastKnownLogCount = 0;

setInterval(async () => {
  const { errorLog = [], debugLog = [] } = await chrome.storage.local.get({
    errorLog: [],
    debugLog: [],
  });
  const total = errorLog.length + debugLog.length;
  if (total > lastKnownLogCount) {
    // New entries — append only the new ones
    const all = [...errorLog, ...debugLog]
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const newEntries = all.slice(lastKnownLogCount);
    for (const entry of newEntries) {
      appendLogEntry(entry);
    }
    lastKnownLogCount = total;
  }
}, 2000);

// ─── Launch ──────────────────────────────────────────────────────────────

init();
CaptionDebug.log('popup', 'Popup opened');
