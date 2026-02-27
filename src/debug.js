// debug.js — Shared structured logging utility used by all extension components.
// Logs are categorized by source component and severity.
// Errors are persisted to chrome.storage.local for popup/options display.

const CaptionDebug = {
  _LOG_BUFFER_MAX: 500,
  _buffer: [],

  _entry(level, source, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,    // 'log' | 'warn' | 'error'
      source,   // 'background' | 'offscreen' | 'content' | 'popup' | 'options'
      message,
      data,
    };

    this._buffer.push(entry);
    if (this._buffer.length > this._LOG_BUFFER_MAX) {
      this._buffer.shift();
    }

    const prefix = `[CaptionDebug][${source}][${level.toUpperCase()}]`;
    const consoleMethod =
      level === 'error' ? console.error :
      level === 'warn'  ? console.warn  :
      console.log;
    consoleMethod(prefix, message, data);

    // Persist errors (and all levels if debug mode) to storage
    this._maybePersist(entry);

    return entry;
  },

  async _maybePersist(entry) {
    try {
      const { debugMode = false } = await chrome.storage.local.get({ debugMode: false });

      // Always persist errors; persist everything if debug mode is on
      if (entry.level !== 'error' && !debugMode) return;

      const key = entry.level === 'error' ? 'errorLog' : 'debugLog';
      const maxEntries = entry.level === 'error' ? 50 : 200;

      const result = await chrome.storage.local.get({ [key]: [] });
      const log = result[key];
      log.push(entry);
      if (log.length > maxEntries) log.splice(0, log.length - maxEntries);
      await chrome.storage.local.set({ [key]: log });
    } catch {
      // Storage may not be available in all contexts during shutdown
    }
  },

  log(source, message, data)   { return this._entry('log', source, message, data); },
  warn(source, message, data)  { return this._entry('warn', source, message, data); },
  error(source, message, data) { return this._entry('error', source, message, data); },

  // Retrieve persisted error log (for popup / options page)
  async getPersistedErrors() {
    const result = await chrome.storage.local.get({ errorLog: [] });
    return result.errorLog;
  },

  // Retrieve full debug log (for options debug panel)
  async getPersistedDebugLog() {
    const result = await chrome.storage.local.get({ debugLog: [] });
    return result.debugLog;
  },

  async clearPersistedErrors() {
    await chrome.storage.local.set({ errorLog: [], debugLog: [] });
  },

  // In-memory buffer for current session
  getBuffer() {
    return [...this._buffer];
  },
};

// Make available as a global and as a module export
if (typeof globalThis !== 'undefined') {
  globalThis.CaptionDebug = CaptionDebug;
}

export default CaptionDebug;
