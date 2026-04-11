const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

// --- State ---
const sessions = new Map();
let activeSessionId = null;
const terminalCache = new Map();

// --- DOM refs ---
const sessionListEl = document.getElementById('session-list');
const sessionCountEl = document.getElementById('session-count');
const terminalPanelEl = document.getElementById('terminal-panel');
const emptyStateEl = document.getElementById('empty-state');
const btnNew = document.getElementById('btn-new');
const menuEl = document.getElementById('new-session-menu');
const wrapperEl = document.getElementById('new-session-wrapper');

// --- Helpers ---
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Session list rendering ---
function renderSessionList() {
  const sorted = Array.from(sessions.values())
    .sort((a, b) => b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt);

  sessionCountEl.textContent = `${sorted.length} open`;
  sessionListEl.innerHTML = '';

  for (const s of sorted) {
    const isActive = s.id === activeSessionId;
    const div = document.createElement('div');
    div.className = 'session-item' + (isActive ? ' selected' : '') + (!isActive && s.unreadCount > 0 ? ' has-unread' : '');
    div.innerHTML = `
      <div class="session-item-header">
        <span class="session-title"><span class="session-status ${s.status}"></span>${escapeHtml(s.title)}</span>
        <span class="session-header-right">
          ${s.unreadCount > 0 && !isActive ? `<span class="unread-badge">${s.unreadCount}</span>` : ''}
          <span class="session-time">${formatTime(s.lastMessageTime)}</span>
        </span>
      </div>
      <div class="session-preview">${escapeHtml(s.lastOutputPreview || 'No output yet')}</div>
    `;
    div.addEventListener('click', () => selectSession(s.id));
    sessionListEl.appendChild(div);
  }
}

// --- Terminal management ---
function getOrCreateTerminal(sessionId) {
  if (terminalCache.has(sessionId)) return terminalCache.get(sessionId);

  const terminal = new Terminal({
    theme: {
      background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
      cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan: '#56d364', brightWhite: '#ffffff',
    },
    fontSize: 16,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';

  terminal.onData((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });
  terminal.onBinary((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });

  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:none';

  const cached = { terminal, fitAddon, container, opened: false };
  terminalCache.set(sessionId, cached);
  return cached;
}

function showTerminal(sessionId) {
  for (const [, c] of terminalCache) c.container.style.display = 'none';

  const session = sessions.get(sessionId);
  if (!session) return;

  const cached = getOrCreateTerminal(sessionId);

  terminalPanelEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'terminal-header';

  const titleSection = document.createElement('div');
  titleSection.className = 'terminal-title-section';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'terminal-title';
  titleSpan.textContent = session.title;
  titleSpan.title = 'Click to rename';
  titleSpan.addEventListener('click', () => startRename(sessionId, titleSpan));

  const statusSpan = document.createElement('span');
  statusSpan.className = `terminal-status ${session.status}`;
  statusSpan.textContent = session.status === 'running' ? '\u25cf running' : '\u25cb idle';

  titleSection.append(titleSpan, statusSpan);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-close-session';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => ipcRenderer.invoke('close-session', sessionId));

  header.append(titleSection, closeBtn);

  const termContainer = document.createElement('div');
  termContainer.className = 'terminal-container';
  termContainer.addEventListener('click', () => cached.terminal.focus());

  terminalPanelEl.append(header, termContainer);
  emptyStateEl.style.display = 'none';

  if (!termContainer.contains(cached.container)) {
    termContainer.appendChild(cached.container);
  }
  cached.container.style.display = 'block';

  if (!cached.opened) {
    cached.terminal.open(cached.container);
    cached.opened = true;
  }

  requestAnimationFrame(() => {
    cached.fitAddon.fit();
    ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
    cached.terminal.focus();
  });

  if (cached._ro) cached._ro.disconnect();
  const handleResize = () => {
    cached.fitAddon.fit();
    ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
  };
  cached._resizeHandler = handleResize;
  window.addEventListener('resize', handleResize);
  cached._ro = new ResizeObserver(handleResize);
  cached._ro.observe(cached.container);
}

// --- Inline rename ---
function startRename(sessionId, titleSpan) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const input = document.createElement('input');
  input.className = 'terminal-title-input';
  input.value = session.title;

  const finish = async () => {
    const trimmed = input.value.trim();
    if (trimmed && trimmed !== session.title) {
      await ipcRenderer.invoke('rename-session', { sessionId, title: trimmed });
    }
    input.replaceWith(titleSpan);
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = session.title; input.blur(); }
  });

  titleSpan.replaceWith(input);
  input.focus();
  input.select();
}

// --- Session selection ---
function selectSession(id) {
  activeSessionId = id;
  const session = sessions.get(id);
  if (session) session.unreadCount = 0;
  ipcRenderer.send('focus-session', { sessionId: id });
  renderSessionList();
  showTerminal(id);
}

// --- Dropdown menu ---
btnNew.addEventListener('click', () => {
  menuEl.style.display = menuEl.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('mousedown', (e) => {
  if (!wrapperEl.contains(e.target)) menuEl.style.display = 'none';
});

for (const btn of document.querySelectorAll('.new-session-option')) {
  btn.addEventListener('click', async () => {
    menuEl.style.display = 'none';
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}

// --- Terminal buffer reading (xterm.js buffer API) ---

const silenceTimers = new Map();
const dataCounters = new Map();  // sessionId -> bytes received in current burst
const SILENCE_MS = 2000; // 2s silence = idle (Claude Code status bar refreshes ~every 30-60s)

/** Check if line contains meaningful CJK content (>=2 consecutive chars) */
function hasCJK(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]{2,}/.test(text);
}

function readTerminalPreview(sessionId) {
  const cached = terminalCache.get(sessionId);
  const session = sessions.get(sessionId);
  if (!cached || !session || !cached.opened) return;

  const buf = cached.terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) {
      const text = line.translateToString(true).trim();
      if (text) lines.push(text);
    }
  }

  // Strategy: find last line with CJK content OR Claude response marker (●)
  // Scan top-to-bottom, collect all "content" lines, take the last one
  let lastContent = '';
  for (const l of lines) {
    // Match Claude response lines (● prefix)
    if (/^●/.test(l) && l.length > 3) {
      lastContent = l.replace(/^●\s*/, '');
      continue;
    }
    // Match lines with meaningful CJK content
    if (hasCJK(l)) {
      lastContent = l;
      continue;
    }
  }

  const newPreview = lastContent.length > 120 ? lastContent.substring(0, 120) + '...' : lastContent;

  if (newPreview && newPreview !== session.lastOutputPreview) {
    const oldPreview = session.lastOutputPreview;
    session.lastOutputPreview = newPreview;
    session.lastMessageTime = Date.now();
    // Only count as unread if preview actually changed to new content
    if (oldPreview !== newPreview && sessionId !== activeSessionId) {
      session.unreadCount = (session.unreadCount || 0) + 1;
    }
    renderSessionList();
  }
}

function onTerminalOutput(sessionId, dataLen) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Track data volume in current burst
  dataCounters.set(sessionId, (dataCounters.get(sessionId) || 0) + dataLen);

  // Only mark running if significant data (>200 bytes), not status bar refreshes
  if (dataCounters.get(sessionId) > 200 && session.status !== 'running') {
    session.status = 'running';
    renderSessionList();
  }

  // Reset silence timer
  if (silenceTimers.has(sessionId)) clearTimeout(silenceTimers.get(sessionId));
  silenceTimers.set(sessionId, setTimeout(() => {
    silenceTimers.delete(sessionId);
    dataCounters.delete(sessionId);

    // Output stopped → idle + read preview
    if (session.status !== 'idle') {
      session.status = 'idle';
      renderSessionList();
    }
    readTerminalPreview(sessionId);
  }, SILENCE_MS));
}

// --- IPC event handlers ---
ipcRenderer.on('terminal-data', (_e, { sessionId, data }) => {
  const cached = terminalCache.get(sessionId);
  if (cached) cached.terminal.write(data);
  onTerminalOutput(sessionId, data.length);
});

ipcRenderer.on('session-created', (_e, { session }) => {
  sessions.set(session.id, session);
  activeSessionId = session.id;
  ipcRenderer.send('focus-session', { sessionId: session.id });
  renderSessionList();
  showTerminal(session.id);
});

ipcRenderer.on('session-closed', (_e, { sessionId }) => {
  sessions.delete(sessionId);
  const cached = terminalCache.get(sessionId);
  if (cached) {
    if (cached._ro) cached._ro.disconnect();
    if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
    cached.terminal.dispose();
    cached.container.remove();
    terminalCache.delete(sessionId);
  }
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    terminalPanelEl.innerHTML = '';
    terminalPanelEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
  }
  renderSessionList();
});

ipcRenderer.on('session-updated', (_e, { session }) => {
  if (!sessions.has(session.id)) return;
  const local = sessions.get(session.id);
  // Merge server updates but keep local preview/status (managed by renderer)
  local.title = session.title;
  renderSessionList();
});

// --- Init ---
(async () => {
  const existing = await ipcRenderer.invoke('get-sessions');
  for (const s of existing) sessions.set(s.id, s);
  renderSessionList();
})();
