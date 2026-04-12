const { ipcRenderer, clipboard, nativeImage, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');

// --- Paste support (text + image) ---
// Attached per-terminal via attachCustomKeyEventHandler in getOrCreateTerminal.
// Fires only when the xterm has focus. We intercept ALL Ctrl+V, not just image
// pastes, because Chromium's native Ctrl+V on xterm's hidden helper textarea
// does NOT fire a paste event in Electron — if we let xterm handle the default,
// nothing happens. So we read the clipboard ourselves and call terminal.paste().
async function handlePasteForSession(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached) return;

  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const filePath = await ipcRenderer.invoke('save-clipboard-image');
    if (filePath) cached.terminal.paste(filePath);
    return;
  }

  const text = clipboard.readText();
  if (text) cached.terminal.paste(text);
}

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
const searchInputEl = document.getElementById('search-input');
const contextMenuEl = document.getElementById('context-menu');
const btnThemeEl = document.getElementById('btn-theme');

let searchQuery = '';
let contextMenuSessionId = null;

// Font size — shared across all terminals, persisted
const FONT_SIZE_KEY = 'claude-hub-font-size';
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;
let currentFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
if (!currentFontSize || isNaN(currentFontSize)) currentFontSize = 16;

function setFontSize(size) {
  size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  if (size === currentFontSize) return;
  currentFontSize = size;
  localStorage.setItem(FONT_SIZE_KEY, String(size));
  for (const [, c] of terminalCache) {
    c.terminal.options.fontSize = size;
    if (c.opened) {
      try { c.fitAddon.fit(); } catch {}
    }
  }
}

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
// Sort: pinned sessions first (by their own time), then unpinned by lastMessageTime.
// Filter: search query matches title or preview (case-insensitive).
function renderSessionList() {
  const all = Array.from(sessions.values());

  const filtered = searchQuery
    ? all.filter(s => {
        const q = searchQuery.toLowerCase();
        return s.title.toLowerCase().includes(q) || (s.lastOutputPreview || '').toLowerCase().includes(q);
      })
    : all;

  const sorted = filtered.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt;
  });

  sessionCountEl.textContent = searchQuery
    ? `${sorted.length}/${all.length}`
    : `${all.length} open`;
  sessionListEl.innerHTML = '';

  for (const s of sorted) {
    const isActive = s.id === activeSessionId;
    const div = document.createElement('div');
    div.className = 'session-item' + (isActive ? ' selected' : '') + (!isActive && s.unreadCount > 0 ? ' has-unread' : '');
    const ctxBadge = typeof s.contextPct === 'number'
      ? `<span class="ctx-badge ${pctClass(s.contextPct)}" title="Context ${s.contextPct}%">Ctx ${s.contextPct}%</span>`
      : '';
    div.innerHTML = `
      <div class="session-item-header">
        <span class="session-title">${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}<span class="session-status ${s.status}"></span>${escapeHtml(s.title)}</span>
        <span class="session-header-right">
          ${s.unreadCount > 0 && !isActive ? `<span class="unread-badge">${s.unreadCount}</span>` : ''}
          <span class="session-time">${formatTime(s.lastMessageTime)}</span>
        </span>
      </div>
      <div class="session-preview">${escapeHtml(s.lastOutputPreview || 'No output yet')}</div>
      ${ctxBadge ? `<div class="session-footer">${ctxBadge}</div>` : ''}
    `;
    div.addEventListener('click', () => selectSession(s.id));
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
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
    fontSize: currentFontSize,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new Unicode11Addon());
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon((e, uri) => { shell.openExternal(uri); }));
  terminal.unicode.activeVersion = '11';

  terminal.onData((data) => {
    // User typed — unlock scroll so they can see what they're interacting with
    const c = terminalCache.get(sessionId);
    if (c && c.scrollLock !== null) setScrollLock(sessionId, null);
    ipcRenderer.send('terminal-input', { sessionId, data });
  });
  terminal.onBinary((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });

  // --- Scroll lock: pin viewport when user scrolls up, release when back at bottom ---
  // State lives on cached (per-session). scrollLock = null means follow-bottom (default).
  // scrollLock = N means pin the viewport at N lines above baseY.
  const SCROLL_LOCK_ENGAGE_THRESHOLD = 3;  // lines above bottom to engage lock
  const SCROLL_LOCK_RELEASE_THRESHOLD = 2; // lines to bottom to release

  terminal.onScroll(() => {
    const c = terminalCache.get(sessionId);
    if (!c || c._isRestoringScroll) return;
    const buf = terminal.buffer.active;
    const offset = buf.baseY - buf.viewportY;
    if (c.scrollLock === null) {
      // Currently following. Did user scroll up past the engage threshold?
      if (offset >= SCROLL_LOCK_ENGAGE_THRESHOLD) setScrollLock(sessionId, offset);
    } else {
      // Currently locked. Did user scroll (nearly) back to bottom?
      if (offset <= SCROLL_LOCK_RELEASE_THRESHOLD) setScrollLock(sessionId, null);
      else c.scrollLock = offset; // update anchor as user fine-tunes scroll
    }
  });

  // Wrap write so that any viewport shift caused by CC's cursor positioning
  // is re-pinned to the user's locked offset before the frame paints.
  const origWrite = terminal.write.bind(terminal);
  terminal.write = function (data, cb) {
    origWrite(data, () => {
      const c = terminalCache.get(sessionId);
      if (c && c.scrollLock !== null) {
        const buf = terminal.buffer.active;
        const desired = Math.max(0, buf.baseY - c.scrollLock);
        if (buf.viewportY !== desired) {
          c._isRestoringScroll = true;
          try { terminal.scrollToLine(desired); } finally { c._isRestoringScroll = false; }
        }
      }
      if (cb) cb();
    });
  };

  // Intercept Ctrl/Cmd+V ourselves (both text and image) — Electron's Chromium
  // doesn't fire paste events on xterm's helper textarea for real keystrokes.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const isPaste = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V');
    if (!isPaste) return true;
    e.preventDefault();
    handlePasteForSession(sessionId);
    return false;
  });

  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:none';

  // Drag-and-drop: dropping a file/folder into the terminal inserts its path(s).
  container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    const quoted = files.map(f => {
      const p = f.path;
      return /\s/.test(p) ? `"${p}"` : p;
    }).join(' ');
    terminal.paste(quoted);
  });

  // Ctrl+wheel zoom
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    setFontSize(currentFontSize + delta);
  }, { passive: false });

  const cached = {
    terminal, fitAddon, searchAddon, container, opened: false,
    scrollLock: null,          // null = follow bottom; N = pin N lines above baseY
    _isRestoringScroll: false, // guard against self-triggered onScroll loops
  };
  terminalCache.set(sessionId, cached);
  return cached;
}

function setScrollLock(sessionId, offsetOrNull) {
  const c = terminalCache.get(sessionId);
  if (!c) return;
  c.scrollLock = offsetOrNull;
  if (sessionId === activeSessionId) renderScrollLockIndicator();
}

function renderScrollLockIndicator() {
  let el = document.getElementById('scroll-lock-indicator');
  const cached = terminalCache.get(activeSessionId);
  const locked = cached && cached.scrollLock !== null;
  if (!locked) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'scroll-lock-indicator';
    el.className = 'scroll-lock-indicator';
    el.textContent = '🔒 Scroll locked — click or Ctrl+End to resume';
    el.addEventListener('click', () => {
      const c = terminalCache.get(activeSessionId);
      if (!c) return;
      setScrollLock(activeSessionId, null);
      c.terminal.scrollToBottom();
    });
    terminalPanelEl.appendChild(el);
  }
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
  if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
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
  renderScrollLockIndicator();
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

/** Extract a short AI-answer snippet that follows the most recent question. */
function extractLatestAnswer(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached || !cached.opened) return '';
  const buf = cached.terminal.buffer.active;

  // Find the most recent non-empty ❯ question line (not the current empty prompt).
  let qIdx = -1;
  for (let i = buf.length - 1; i >= 0; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const t = line.translateToString(true).trim();
    const m = t.match(/^[❯›>]\s*(.+)/);
    if (m && m[1].length > 1) { qIdx = i; break; }
  }
  if (qIdx === -1) return '';

  // Walk forward and take the first substantive line that isn't status bar / UI chrome.
  for (let i = qIdx + 1; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const t = line.translateToString(true).trim();
    if (!t) continue;
    // Skip decorative lines
    if (/^[─━┌┐└┘│├┤┬┴┼╭╮╰╯╱╲═║╔╗╚╝]+$/.test(t)) continue;
    if (/^[❯›>]/.test(t)) continue;
    // Skip the Claude Code status bar strings
    if (/^(Context|Usage|⏵⏵|CLAUDE\.md|MCPs|hooks|medium|high|low|bypass permissions|\d+\s*CLAUDE)/.test(t)) continue;
    if (/\[(Opus|Sonnet|Haiku)/i.test(t)) continue;
    // Strip common AI-reply prefixes (⏺ filled circle, ● bullet, > quote)
    const cleaned = t.replace(/^[⏺●◉○•·⊙]\s*/, '').trim();
    if (cleaned.length < 2) continue;
    return cleaned;
  }
  return '';
}

function readTerminalPreview(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const questions = extractUserQuestions(sessionId);
  if (questions.length === 0) return;

  const lastQ = questions[questions.length - 1];
  const qLine = 'Q: ' + (lastQ.length > 50 ? lastQ.substring(0, 48) + '…' : lastQ);

  const ans = extractLatestAnswer(sessionId);
  const aLine = ans ? 'A: ' + (ans.length > 50 ? ans.substring(0, 48) + '…' : ans) : '';

  const newPreview = aLine ? `${qLine}\n${aLine}` : qLine;

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

// Status updates from our custom statusline script.
// Carries contextPct per session + account-wide usage5h/usage7d.
const accountUsage = { usage5h: null, usage7d: null };
ipcRenderer.on('status-event', (_e, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session) {
    session.contextPct = payload.contextPct;
    session.contextUsed = payload.contextUsed;
    session.contextMax = payload.contextMax;
  }
  // Usage is account-wide — keep the latest reported values
  if (payload.usage5h) accountUsage.usage5h = payload.usage5h;
  if (payload.usage7d) accountUsage.usage7d = payload.usage7d;
  renderAccountUsage();
  renderSessionList();
});

function formatResetIn(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (isNaN(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return `${h}h${m ? ' ' + m + 'm' : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function renderAccountUsage() {
  const el = document.getElementById('account-usage');
  if (!el) return;
  const { usage5h, usage7d } = accountUsage;
  if (!usage5h && !usage7d) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const parts = [];
  if (usage5h) {
    const pct = Math.round(usage5h.pct);
    const reset = formatResetIn(usage5h.resetsAt);
    parts.push(`<div class="usage-row"><span class="usage-label">5h</span><div class="usage-bar"><div class="usage-bar-fill ${pctClass(pct)}" style="width:${pct}%"></div></div><span class="usage-val">${pct}%${reset ? ' · ' + reset : ''}</span></div>`);
  }
  if (usage7d) {
    const pct = Math.round(usage7d.pct);
    const reset = formatResetIn(usage7d.resetsAt);
    parts.push(`<div class="usage-row"><span class="usage-label">7d</span><div class="usage-bar"><div class="usage-bar-fill ${pctClass(pct)}" style="width:${pct}%"></div></div><span class="usage-val">${pct}%${reset ? ' · ' + reset : ''}</span></div>`);
  }
  el.innerHTML = parts.join('');
}

function pctClass(pct) {
  if (pct >= 85) return 'danger';
  if (pct >= 70) return 'warn';
  return 'ok';
}

// Claude Code hooks drive the session state.
// - 'prompt' (UserPromptSubmit): fires the moment user presses Enter.
//   Immediately flag the session as running — faster & more precise than
//   the 200-byte PTY heuristic.
// - 'stop' (Stop): fires when the agent loop finishes. Triggers unread/time bump.
ipcRenderer.on('hook-event', (_e, { event, sessionId }) => {
  if (event === 'stop') onReplyCompleteFromHook(sessionId);
  else if (event === 'prompt') onPromptSubmittedFromHook(sessionId);
});

function onPromptSubmittedFromHook(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status !== 'running') {
    session.status = 'running';
    renderSessionList();
  }
}

// Hook-server health indicator (banner in sidebar when down)
let hookUp = true;
ipcRenderer.on('hook-status', (_e, { up }) => {
  hookUp = up;
  renderHookStatus();
});

function renderHookStatus() {
  let banner = document.getElementById('hook-status-banner');
  if (hookUp) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'hook-status-banner';
    banner.className = 'hook-status-banner';
    banner.textContent = 'Hook server offline — unread notifications may be delayed (silence fallback active)';
    document.querySelector('.session-sidebar').prepend(banner);
  }
}

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
      maybeNotify(session);
    }
    renderSessionList();
  }
}

// --- System notification (fire when window is in background) ---
async function maybeNotify(session) {
  try {
    const focused = await ipcRenderer.invoke('is-window-focused');
    if (focused) return;
    ipcRenderer.send('show-notification', {
      title: session.title + ' — reply ready',
      body: session.lastOutputPreview || '',
    });
  } catch {}
}

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;

  // Ctrl+N: new Claude session
  if (!e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    ipcRenderer.invoke('create-session', 'claude');
    return;
  }

  // Ctrl+W: close active session
  if (!e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
    e.preventDefault();
    if (activeSessionId) ipcRenderer.invoke('close-session', activeSessionId);
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab: cycle sessions
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleSession(e.shiftKey ? -1 : 1);
    return;
  }

  // Ctrl+1..9: jump to Nth session in current sort order
  if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    jumpToSessionByIndex(parseInt(e.key, 10) - 1);
    return;
  }

  // Ctrl+F: terminal in-buffer search (when a terminal is active)
  // Ctrl+K: sidebar session search
  if (!e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    if (activeSessionId) openTerminalSearch();
    else { searchInputEl.focus(); searchInputEl.select(); }
    return;
  }
  if (!e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    searchInputEl.focus();
    searchInputEl.select();
    return;
  }

  // Ctrl+Shift+C: copy selected terminal text
  if (e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
    const cached = terminalCache.get(activeSessionId);
    const sel = cached && cached.terminal.getSelection();
    if (sel) {
      e.preventDefault();
      clipboard.writeText(sel);
    }
    return;
  }

  // Ctrl+End: jump to bottom and release scroll lock
  if (!e.shiftKey && !e.altKey && e.key === 'End') {
    e.preventDefault();
    const c = terminalCache.get(activeSessionId);
    if (c) { setScrollLock(activeSessionId, null); c.terminal.scrollToBottom(); }
    return;
  }
  // Ctrl+Home: jump to top (engages lock at max offset)
  if (!e.shiftKey && !e.altKey && e.key === 'Home') {
    e.preventDefault();
    const c = terminalCache.get(activeSessionId);
    if (c) c.terminal.scrollToTop();
    return;
  }

  // Ctrl+Plus / Ctrl+Minus / Ctrl+0: font size
  if (!e.shiftKey && !e.altKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); setFontSize(currentFontSize + 1); return;
  }
  if (!e.shiftKey && !e.altKey && e.key === '-') {
    e.preventDefault(); setFontSize(currentFontSize - 1); return;
  }
  if (!e.shiftKey && !e.altKey && e.key === '0') {
    e.preventDefault(); setFontSize(16); return;
  }
}, true);

function getSortedVisibleSessionIds() {
  // Same sort as renderSessionList so Ctrl+N maps to what user sees.
  const all = Array.from(sessions.values());
  const filtered = searchQuery
    ? all.filter(s => {
        const q = searchQuery.toLowerCase();
        return s.title.toLowerCase().includes(q) || (s.lastOutputPreview || '').toLowerCase().includes(q);
      })
    : all;
  return filtered
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt;
    })
    .map(s => s.id);
}

function cycleSession(direction) {
  const ids = getSortedVisibleSessionIds();
  if (ids.length === 0) return;
  const i = Math.max(0, ids.indexOf(activeSessionId));
  const next = (i + direction + ids.length) % ids.length;
  selectSession(ids[next]);
}

function jumpToSessionByIndex(idx) {
  const ids = getSortedVisibleSessionIds();
  if (idx < 0 || idx >= ids.length) return;
  selectSession(ids[idx]);
}

// --- Search ---
searchInputEl.addEventListener('input', () => {
  searchQuery = searchInputEl.value.trim();
  renderSessionList();
});
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInputEl.value = '';
    searchQuery = '';
    renderSessionList();
    searchInputEl.blur();
  }
});

// --- Context menu (right-click session) ---
function openContextMenu(sessionId, x, y) {
  contextMenuSessionId = sessionId;
  contextMenuEl.style.display = 'block';
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;
  // Keep in viewport
  requestAnimationFrame(() => {
    const rect = contextMenuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) contextMenuEl.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) contextMenuEl.style.top = `${y - rect.height}px`;
  });
  // Update pin label to reflect current state
  const session = sessions.get(sessionId);
  const pinBtn = contextMenuEl.querySelector('[data-action="pin"]');
  if (pinBtn && session) pinBtn.textContent = session.pinned ? 'Unpin' : 'Pin to top';
}

function closeContextMenu() {
  contextMenuEl.style.display = 'none';
  contextMenuSessionId = null;
}

document.addEventListener('mousedown', (e) => {
  if (contextMenuEl.style.display === 'block' && !contextMenuEl.contains(e.target)) {
    closeContextMenu();
  }
});

for (const btn of contextMenuEl.querySelectorAll('.context-menu-item')) {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const sid = contextMenuSessionId;
    closeContextMenu();
    if (!sid) return;
    const session = sessions.get(sid);
    if (!session) return;

    if (action === 'pin') {
      session.pinned = !session.pinned;
      renderSessionList();
    } else if (action === 'restart') {
      await ipcRenderer.invoke('restart-session', sid);
    } else if (action === 'close') {
      await ipcRenderer.invoke('close-session', sid);
    }
  });
}

// --- Terminal in-buffer search (Ctrl+F) ---
const termSearchEl = document.getElementById('terminal-search');
const termSearchInput = document.getElementById('terminal-search-input');
const termSearchCount = document.getElementById('terminal-search-count');
const termSearchPrev = document.getElementById('terminal-search-prev');
const termSearchNext = document.getElementById('terminal-search-next');
const termSearchClose = document.getElementById('terminal-search-close');

function openTerminalSearch() {
  termSearchEl.style.display = 'flex';
  termSearchInput.focus();
  termSearchInput.select();
}
function closeTerminalSearch() {
  termSearchEl.style.display = 'none';
  const cached = terminalCache.get(activeSessionId);
  if (cached && cached.searchAddon) cached.searchAddon.clearDecorations();
  if (cached) cached.terminal.focus();
}

const SEARCH_OPTS = {
  decorations: {
    matchBackground: '#58a6ff66',
    matchBorder: '#58a6ff',
    matchOverviewRuler: '#58a6ff',
    activeMatchBackground: '#f0883e88',
    activeMatchBorder: '#f0883e',
    activeMatchColorOverviewRuler: '#f0883e',
  },
};

function runSearch(direction) {
  const cached = terminalCache.get(activeSessionId);
  if (!cached || !cached.searchAddon) return;
  const q = termSearchInput.value;
  if (!q) { cached.searchAddon.clearDecorations(); termSearchCount.textContent = ''; return; }
  const found = direction >= 0
    ? cached.searchAddon.findNext(q, SEARCH_OPTS)
    : cached.searchAddon.findPrevious(q, SEARCH_OPTS);
  termSearchCount.textContent = found ? '' : 'no match';
}

termSearchInput.addEventListener('input', () => runSearch(1));
termSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeTerminalSearch(); }
});
termSearchPrev.addEventListener('click', () => runSearch(-1));
termSearchNext.addEventListener('click', () => runSearch(1));
termSearchClose.addEventListener('click', closeTerminalSearch);

// --- Theme toggle ---
const THEME_KEY = 'claude-hub-theme';
function applyTheme(theme) {
  if (theme === 'light') document.body.classList.add('theme-light');
  else document.body.classList.remove('theme-light');
  btnThemeEl.textContent = theme === 'light' ? '☀' : '◐';
}
const initialTheme = localStorage.getItem(THEME_KEY) || 'dark';
applyTheme(initialTheme);
btnThemeEl.addEventListener('click', () => {
  const current = document.body.classList.contains('theme-light') ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
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
  if (silenceTimers.has(sessionId)) {
    clearTimeout(silenceTimers.get(sessionId));
    silenceTimers.delete(sessionId);
  }
  dataCounters.delete(sessionId);
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
