const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');

const STATE_DIR = getHubDataDir();
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CURRENT_VERSION = 1;

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CURRENT_VERSION) {
      try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.old'); } catch {}
      return defaultState();
    }
    if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
    return parsed;
  } catch {
    return defaultState();
  }
}

function defaultState() {
  return { version: CURRENT_VERSION, cleanShutdown: true, sessions: [] };
}

let saveDebounceTimer = null;

function saveImpl(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.warn('[hub] state save failed:', e.message);
  }
}

function save(state, { sync = false } = {}) {
  if (sync) {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
    saveImpl(state);
    return;
  }
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => saveImpl(state), 500);
}

module.exports = { load, save, STATE_FILE, CURRENT_VERSION };
