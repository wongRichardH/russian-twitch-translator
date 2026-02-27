import CaptionDebug from './debug.js';

// ─── DOM Elements ────────────────────────────────────────────────────────

const modelSize = document.getElementById('modelSize');
const captionFontSize = document.getElementById('captionFontSize');
const fontSizeValue = document.getElementById('fontSizeValue');
const captionPosition = document.getElementById('captionPosition');
const captionDuration = document.getElementById('captionDuration');
const durationValue = document.getElementById('durationValue');
const autoEnable = document.getElementById('autoEnable');
const debugMode = document.getElementById('debugMode');
const loadLogBtn = document.getElementById('loadLogBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const logPanel = document.getElementById('logPanel');
const saveStatus = document.getElementById('saveStatus');

// ─── Load Settings ───────────────────────────────────────────────────────

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    modelSize: 'base',
    captionFontSize: '18px',
    captionPosition: 'bottom-center',
    captionDuration: 4000,
    autoEnable: true,
    debugMode: false,
  });

  modelSize.value = settings.modelSize;
  captionFontSize.value = parseInt(settings.captionFontSize, 10);
  fontSizeValue.textContent = settings.captionFontSize;
  captionPosition.value = settings.captionPosition;
  captionDuration.value = settings.captionDuration;
  durationValue.textContent = `${settings.captionDuration / 1000}s`;
  autoEnable.checked = settings.autoEnable;
  debugMode.checked = settings.debugMode;
}

// ─── Save Settings ───────────────────────────────────────────────────────

async function saveSettings() {
  await chrome.storage.local.set({
    modelSize: modelSize.value,
    captionFontSize: `${captionFontSize.value}px`,
    captionPosition: captionPosition.value,
    captionDuration: parseInt(captionDuration.value, 10),
    autoEnable: autoEnable.checked,
    debugMode: debugMode.checked,
  });

  // Flash save indicator
  saveStatus.classList.add('visible');
  setTimeout(() => saveStatus.classList.remove('visible'), 2000);

  CaptionDebug.log('options', 'Settings saved', {
    modelSize: modelSize.value,
    captionFontSize: `${captionFontSize.value}px`,
    captionPosition: captionPosition.value,
    captionDuration: parseInt(captionDuration.value, 10),
  });
}

// ─── Event Listeners ─────────────────────────────────────────────────────

// Auto-save on any change
[modelSize, captionPosition, autoEnable, debugMode].forEach((el) => {
  el.addEventListener('change', saveSettings);
});

captionFontSize.addEventListener('input', () => {
  fontSizeValue.textContent = `${captionFontSize.value}px`;
});
captionFontSize.addEventListener('change', saveSettings);

captionDuration.addEventListener('input', () => {
  durationValue.textContent = `${parseInt(captionDuration.value, 10) / 1000}s`;
});
captionDuration.addEventListener('change', saveSettings);

// ─── Debug Log ───────────────────────────────────────────────────────────

loadLogBtn.addEventListener('click', async () => {
  const errors = await CaptionDebug.getPersistedErrors();
  const debugLogs = await CaptionDebug.getPersistedDebugLog();
  const allLogs = [...errors, ...debugLogs]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (allLogs.length === 0) {
    logPanel.innerHTML = '<div style="color:#6c7086">No logs recorded.</div>';
  } else {
    logPanel.innerHTML = allLogs.map((entry) => {
      const ts = entry.timestamp.split('T')[1]?.slice(0, 8) ?? '';
      const dataStr = Object.keys(entry.data || {}).length > 0
        ? ` ${JSON.stringify(entry.data)}`
        : '';
      return `<div class="log-entry ${entry.level}">` +
        `<span class="ts">${ts}</span> ` +
        `<span class="src">[${entry.source}]</span> ` +
        `<span class="msg">${entry.message}${dataStr}</span>` +
        `</div>`;
    }).join('');
  }

  logPanel.classList.add('visible');
  logPanel.scrollTop = logPanel.scrollHeight;
});

clearLogBtn.addEventListener('click', async () => {
  await CaptionDebug.clearPersistedErrors();
  logPanel.innerHTML = '<div style="color:#6c7086">Logs cleared.</div>';
  logPanel.classList.add('visible');
});

// ─── Init ────────────────────────────────────────────────────────────────

loadSettings();
CaptionDebug.log('options', 'Options page opened');
