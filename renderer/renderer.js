const { ipcRenderer, clipboard, nativeImage } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

// --- Image paste support ---
// Intercept Ctrl/Cmd+V at keydown: in Electron the browser's native paste
// action often doesn't fire a paste event for us when focus is on xterm's
// helper textarea, so the only reliable hook is keydown.
document.addEventListener('keydown', async (e) => {
  if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V'))) return;

  const img = clipboard.readImage();
  if (img.isEmpty()) return; // No image: let xterm handle normal text paste

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if (!activeSessionId) return;

  const filePath = await ipcRenderer.invoke('save-clipboard-image');
  if (!filePath) return;

  // xterm.paste() applies bracketed-paste-mode framing which Claude Code CLI requires
  const cached = terminalCache.get(activeSessionId);
  if (cached) cached.terminal.paste(filePath);
}, true);

// --- Image hover preview tooltip ---
const previewTooltip = document.createElement('div');
previewTooltip.className = 'image-preview-tooltip';
previewTooltip.style.display = 'none';
document.body.appendChild(previewTooltip);

/** Check if a string looks like an image file path */
function isImagePath(text) {
  return /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(text.trim());
}

/** Extract potential file path from terminal line at a given position */
function extractPathAtPosition(lineText, colIndex) {
  // Find path-like substring around the cursor position
  // Match Windows paths like C:\...\file.png or Unix paths like /home/.../file.png
  const pathRegex = /[A-Za-z]:\\[^\s<>"|?*]+\.(png|jpg|jpeg|gif|bmp|webp)|\/[^\s<>"|?*]+\.(png|jpg|jpeg|gif|bmp|webp)/gi;
  let match;
  while ((match = pathRegex.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (colIndex >= start && colIndex <= end) {
      return match[0];
    }
  }
  return null;
}

let previewTimeout = null;

function setupImageHover(terminal, container) {
  container.addEventListener('mousemove', (e) => {
    const coords = getTerminalCoords(terminal, container, e);
    if (!coords) { hidePreview(); return; }

    const buf = terminal.buffer.active;
    const line = buf.getLine(coords.row);
    if (!line) { hidePreview(); return; }

    const lineText = line.translateToString(false);
    const filePath = extractPathAtPosition(lineText, coords.col);

    if (filePath && isImagePath(filePath)) {
      showPreview(filePath, e.clientX, e.clientY);
    } else {
      hidePreview();
    }
  });

  container.addEventListener('mouseleave', hidePreview);
}

function getTerminalCoords(terminal, container, mouseEvent) {
  const rect = container.getBoundingClientRect();
  const renderer = terminal._core._renderService;
  if (!renderer || !renderer.dimensions) return null;

  const dims = renderer.dimensions;
  const x = mouseEvent.clientX - rect.left;
  const y = mouseEvent.clientY - rect.top;

  const col = Math.floor(x / dims.css.cell.width);
  const row = Math.floor(y / dims.css.cell.height) + terminal.buffer.active.viewportY;

  if (col < 0 || row < 0 || col >= terminal.cols) return null;
  return { col, row };
}

function showPreview(filePath, mouseX, mouseY) {
  // Debounce to avoid flickering
  if (previewTooltip.dataset.path === filePath && previewTooltip.style.display === 'block') {
    // Just update position
    positionTooltip(mouseX, mouseY);
    return;
  }

  clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    // Use file:// protocol for local images
    const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    previewTooltip.innerHTML = `<img src="${fileUrl}" alt="preview" style="max-width:400px;max-height:300px;border-radius:6px;">`;
    previewTooltip.dataset.path = filePath;
    previewTooltip.style.display = 'block';
    positionTooltip(mouseX, mouseY);
  }, 300);
}

function positionTooltip(x, y) {
  const pad = 12;
  previewTooltip.style.left = `${x + pad}px`;
  previewTooltip.style.top = `${y + pad}px`;

  // Keep within viewport
  requestAnimationFrame(() => {
    const rect = previewTooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      previewTooltip.style.left = `${x - rect.width - pad}px`;
    }
    if (rect.bottom > window.innerHeight) {
      previewTooltip.style.top = `${y - rect.height - pad}px`;
    }
  });
}

function hidePreview() {
  clearTimeout(previewTimeout);
  previewTooltip.style.display = 'none';
  previewTooltip.dataset.path = '';
}

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
    setupImageHover(cached.terminal, cached.container);
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
  if (session) {
    session.unreadCount = 0;
    // Snapshot the current question signature as "read" — any future idle
    // transitions will compare against this and only bump unread on real new Q&A.
    session.readSignature = getQuestionsSignature(id);
  }
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

/** Extract user questions (lines starting with ❯/›/>) from xterm buffer. */
function extractUserQuestions(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached || !cached.opened) return [];
  const buf = cached.terminal.buffer.active;
  const questions = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trim();
    if (!text) continue;
    const m = text.match(/^[❯›>]\s*(.+)/);
    if (m && m[1].length > 1) questions.push(m[1].trim());
  }
  return questions;
}

/** Signature: last question text. Used to distinguish real Q&A turns from TUI noise. */
function getQuestionsSignature(sessionId) {
  const qs = extractUserQuestions(sessionId);
  return qs.length === 0 ? '' : qs[qs.length - 1].slice(0, 200);
}

function readTerminalPreview(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const questions = extractUserQuestions(sessionId);
  // Take last 3, newest first, each truncated to ~40 chars
  const recent = questions.slice(-3).reverse();
  const previewLines = recent.map(q => 'Q: ' + (q.length > 40 ? q.substring(0, 38) + '...' : q));
  const newPreview = previewLines.join('\n');

  // Preview text only; sort time + unread are bumped on AI reply completion
  if (newPreview && newPreview !== session.lastOutputPreview) {
    session.lastOutputPreview = newPreview;
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

    const wasRunning = session.status === 'running';
    if (wasRunning) session.status = 'idle';

    readTerminalPreview(sessionId);

    // Semantic signal: unread/time bump only when the last-question signature
    // actually changed (= a new Q&A turn), not just on any running→idle cycle.
    // This ignores Claude Code's periodic TUI redraws (status bar, context %).
    if (session.lastOutputPreview) {
      const sig = getQuestionsSignature(sessionId);
      const prev = session.readSignature || '';
      if (sig !== prev) {
        session.lastMessageTime = Date.now();
        session.readSignature = sig;
        if (sessionId !== activeSessionId) {
          session.unreadCount = (session.unreadCount || 0) + 1;
        }
      }
    }

    renderSessionList();
  }, SILENCE_MS));
}

// --- IPC event handlers ---
ipcRenderer.on('terminal-data', (_e, { sessionId, data }) => {
  const cached = terminalCache.get(sessionId);
  if (cached) cached.terminal.write(data);
  onTerminalOutput(sessionId, data.length);
});

// Primary signal for Claude sessions: the session-hub-hook.py Stop hook
// POSTs here the moment Claude Code finishes a reply (<50ms latency).
// The silence+signature path in onTerminalOutput stays as a fallback.
ipcRenderer.on('hook-event', (_e, { event, sessionId }) => {
  if (event !== 'stop') return;
  onReplyCompleteFromHook(sessionId);
});

function onReplyCompleteFromHook(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // No setTimeout wait: sig is derived from the user's question line (❯ ...)
  // which is already in the buffer since the moment the user pressed Enter,
  // long before Claude's Stop hook fires.
  readTerminalPreview(sessionId);
  if (!session.lastOutputPreview) return;

  const sig = getQuestionsSignature(sessionId);
  const prev = session.readSignature || '';
  if (sig !== prev) {
    session.lastMessageTime = Date.now();
    session.readSignature = sig;
    if (sessionId !== activeSessionId) {
      session.unreadCount = (session.unreadCount || 0) + 1;
    }
    renderSessionList();
  }
}

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
