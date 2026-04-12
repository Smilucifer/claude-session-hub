const { ipcRenderer, clipboard, nativeImage, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const { CanvasAddon } = require('@xterm/addon-canvas');

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
const appContainerEl = document.getElementById('app-container');
const btnCollapseEl = document.getElementById('btn-collapse-sidebar');
const btnExpandEl = document.getElementById('btn-expand-sidebar');

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
  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  sessionListEl.innerHTML = '';

  for (const s of sorted) {
    const isActive = s.id === activeSessionId;
    const div = document.createElement('div');
    const dormantCls = s.status === 'dormant' ? ' dormant' : '';
    const waitingCls = s.isWaiting && !isActive ? ' is-waiting' : '';
    div.className = 'session-item' + (isActive ? ' selected' : '') + (!isActive && s.unreadCount > 0 ? ' has-unread' : '') + waitingCls + dormantCls;
    const ctxBadge = typeof s.contextPct === 'number'
      ? `<span class="ctx-badge ${pctClass(s.contextPct)}" title="Context ${s.contextPct}%">Ctx ${s.contextPct}%</span>`
      : '';
    const modelBadge = s.currentModel
      ? `<span class="model-badge ${modelClass(s.currentModel.id)}" title="${escapeHtml(s.currentModel.displayName || s.currentModel.id)}">${escapeHtml(modelShort(s.currentModel))}</span>`
      : '';
    const footerInner = [modelBadge, ctxBadge].filter(Boolean).join('');
    div.innerHTML = `
      <div class="session-item-header">
        <span class="session-title">${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}<span class="session-status ${s.status}"></span>${escapeHtml(s.title)}</span>
        <span class="session-header-right">
          ${s.isWaiting && !isActive ? `<span class="waiting-badge" title="${escapeHtml(s.waitingText || 'Claude is waiting for your input')}">⏸ 等你</span>` : ''}
          ${s.unreadCount > 0 && !isActive ? `<span class="unread-badge">${s.unreadCount}</span>` : ''}
          <span class="session-time">${formatTime(s.lastMessageTime)}</span>
        </span>
      </div>
      <div class="session-preview">${escapeHtml((s.isWaiting && s.waitingText) || s.lastOutputPreview || 'No output yet')}</div>
      ${footerInner ? `<div class="session-footer">${footerInner}</div>` : ''}
    `;
    div.addEventListener('click', () => selectSession(s.id));
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    sessionListEl.appendChild(div);
  }
  sessionListEl.scrollTop = savedScrollTop;
}

// --- Terminal management ---
// Load GPU renderer. Default is Canvas (stable + GPU-accelerated 2D). WebGL
// is faster but on some GPU/driver combos it leaves cursor ghosting artifacts
// in Claude Code's TUI redraw, so it's opt-in only.
// Override via localStorage: setItem('hub.renderer', 'canvas' | 'webgl' | 'dom')
function loadGpuRenderer(cached) {
  if (cached._gpuLoaded) return;
  cached._gpuLoaded = true;
  const pref = localStorage.getItem('hub.renderer') || 'canvas';
  if (pref === 'dom') return;
  if (pref === 'webgl') {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        try { cached.terminal.loadAddon(new CanvasAddon()); } catch (_) {}
      });
      cached.terminal.loadAddon(webgl);
      return;
    } catch (_) { /* fall through to canvas */ }
  }
  try { cached.terminal.loadAddon(new CanvasAddon()); } catch (_) {}
}

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
  registerLocalPathLinks(terminal);
  terminal.unicode.activeVersion = '11';

  terminal.onData((data) => {
    // User typed — unlock scroll so they can see what they're interacting with
    const c = terminalCache.get(sessionId);
    if (c && c.scrollLock !== null) setScrollLock(sessionId, null);
    ipcRenderer.send('terminal-input', { sessionId, data });
  });
  terminal.onBinary((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });

  // Claude Code emits an OSC set-title escape sequence once near the start of a
  // conversation with an AI-generated short summary (e.g. "Greeting in Chinese").
  // xterm fires onTitleChange for it. We capture that as the session title
  // unless the user already renamed in Hub (userRenamed wins). Only for Claude
  // kinds — PowerShell emits title sequences on every prompt, which we don't want.
  const session = sessions.get(sessionId);
  const isClaudeKind = session && (session.kind === 'claude' || session.kind === 'claude-resume');
  if (isClaudeKind) {
    terminal.onTitleChange((newTitle) => {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.userRenamed) return; // user's Hub rename is authoritative
      const clean = String(newTitle || '').trim();
      if (!clean) return;
      if (clean === 'Claude Code') return; // generic startup title — ignore
      // When `claude --resume <id>` fails (stale id, missing transcript), the
      // PTY falls back to a plain PowerShell prompt, which emits OSC sequences
      // setting the title to its own executable path (e.g.
      // "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") or
      // the current working directory. Any of these would clobber the real
      // conversation title. Reject anything that looks like a file path / exe.
      if (/[\\\/]/.test(clean)) return;
      if (/\.exe$/i.test(clean)) return;
      if (clean === s.title) return;
      s.title = clean;
      s.claudeAutoTitle = clean;
      // Persist server-side so reloads / session-updated echoes stay consistent.
      ipcRenderer.invoke('rename-session', { sessionId, title: clean });
    });
  }

  // --- Scroll lock: pin viewport when user scrolls up, release when back at bottom ---
  // State lives on cached (per-session). scrollLock = null means follow-bottom (default).
  // scrollLock = N means pin the viewport at N lines above baseY.
  const SCROLL_LOCK_ENGAGE_THRESHOLD = 3;  // lines above bottom to engage lock
  const SCROLL_LOCK_RELEASE_THRESHOLD = 2; // lines to bottom to release

  // NOTE: scroll-lock feature is currently DISABLED for diagnosis. When a
  // session is switched to, fit()/reflow seems to fire onScroll with
  // transient viewport state and accidentally engage the lock with a bad
  // offset, which then causes the write wrapper to pin viewport at line 0.
  // Disabling the onScroll handler means scrollLock stays null forever, so
  // the write wrapper short-circuits and xterm scrolls natively.
  // Keep the code above for future re-enable once the root cause is fixed.
  // terminal.onScroll(() => { ... });

  // Wrap write so that any viewport shift caused by CC's cursor positioning
  // is re-pinned to the user's locked offset before the frame paints.
  // Fast-path: when no lock is active (the common case), delegate directly.
  const origWrite = terminal.write.bind(terminal);
  terminal.write = function (data, cb) {
    const c = terminalCache.get(sessionId);
    if (!c || c.scrollLock === null) return origWrite(data, cb);
    origWrite(data, () => {
      if (c.scrollLock !== null) {
        const buf = terminal.buffer.active;
        // Release (instead of snapping) when anchor is out of valid range.
        // Uses >= so scrollLock === baseY also releases: that case yields
        // desired=0 and scrollToLine(0) would pin viewport to scrollback top.
        if (c.scrollLock >= buf.baseY) {
          c.scrollLock = null;
          if (sessionId === activeSessionId) renderScrollLockIndicator();
        } else {
          const desired = buf.baseY - c.scrollLock;
          if (buf.viewportY !== desired) {
            c._isRestoringScroll = true;
            try { terminal.scrollToLine(desired); } finally { c._isRestoringScroll = false; }
          }
        }
      }
      if (cb) cb();
    });
  };

  // Intercept Ctrl/Cmd+V ourselves (both text and image) — Electron's Chromium
  // doesn't fire paste events on xterm's helper textarea for real keystrokes.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;

    // Ctrl+V — paste (text or image)
    if (!e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      handlePasteForSession(sessionId);
      return false;
    }
    // Ctrl+Shift+C — always copy selection (VSCode/Windows Terminal style)
    if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (terminal.hasSelection()) {
        clipboard.writeText(terminal.getSelection());
        e.preventDefault();
        return false;
      }
      return true;
    }
    // Ctrl+C — copy if there's a selection, else pass through as SIGINT
    if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      if (terminal.hasSelection()) {
        clipboard.writeText(terminal.getSelection());
        e.preventDefault();
        return false;
      }
      return true;
    }
    return true;
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

  // Ctrl+wheel zoom — passive so xterm's own wheel-scroll stays on the
  // compositor thread. Chromium still lets us observe the event; we just
  // can't preventDefault. The browser's page-zoom on Ctrl+wheel is already
  // disabled globally in Electron for non-text areas.
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const delta = e.deltaY < 0 ? 1 : -1;
    setFontSize(currentFontSize + delta);
  }, { passive: true });

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

function showTerminal(sessionId, opts = { focus: true }) {
  for (const [, c] of terminalCache) c.container.style.display = 'none';

  const session = sessions.get(sessionId);
  if (!session) return;

  const cached = getOrCreateTerminal(sessionId);

  terminalPanelEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'terminal-header';

  const titleRow = document.createElement('div');
  titleRow.className = 'terminal-title-row';

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

  if (session.currentModel) {
    const modelSpan = document.createElement('span');
    modelSpan.className = 'terminal-model-badge ' + modelClass(session.currentModel.id);
    modelSpan.textContent = session.currentModel.displayName || modelShort(session.currentModel);
    modelSpan.title = session.currentModel.id;
    titleSection.appendChild(modelSpan);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-close-session';
  closeBtn.title = 'Close session (Ctrl+W)';
  closeBtn.setAttribute('aria-label', 'Close session');
  closeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
  closeBtn.addEventListener('click', () => ipcRenderer.invoke('close-session', sessionId));

  // Metrics (cwd + api time) live inline with the title now — single-row header.
  const metricsRow = document.createElement('div');
  metricsRow.className = 'terminal-metrics-row inline';
  renderMetricsRow(metricsRow, session);
  titleSection.appendChild(metricsRow);

  titleRow.append(titleSection, closeBtn);

  header.append(titleRow);

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
    loadGpuRenderer(cached);
    setupImageHover(cached.terminal, cached.container);
  }

  requestAnimationFrame(() => {
    cached.fitAddon.fit();
    ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
    if (opts.focus) {
      if (cached.scrollLock !== null) setScrollLock(sessionId, null);
      cached.terminal.scrollToBottom();
      cached.terminal.focus();
    }
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

// Hub → Claude /rename sync. Only fires for Claude sessions after the user
// renames in the Hub UI. We inject the /rename command into the PTY; to keep
// it clean we require the session to be idle (prompt is empty). If the user
// is mid-reply we stash it and flush on the next Stop hook. Title is sanitized
// to strip newlines and cap length so a pasted string can't inject extra input.
function syncRenameToClaude(sessionId, title) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const clean = String(title).replace(/[\r\n]/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  if (session.status === 'idle') {
    ipcRenderer.send('terminal-input', { sessionId, data: '/rename ' + clean + '\r' });
    session._pendingRename = null;
  } else {
    session._pendingRename = clean;
  }
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
      session.userRenamed = true;
      if (session.status === 'dormant') {
        // No live PTY; just mutate locally and persist.
        session.title = trimmed;
        renderSessionList();
        schedulePersist();
      } else {
        await ipcRenderer.invoke('rename-session', { sessionId, title: trimmed });
        if (session.kind === 'claude' || session.kind === 'claude-resume') {
          syncRenameToClaude(sessionId, trimmed);
        }
      }
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
  const session = sessions.get(id);
  // Dormant session: clicking wakes it via resume-session IPC. Don't render
  // terminal now — session-created handler below will take over once PTY is up.
  if (session && session.status === 'dormant') {
    resumeDormantSession(id);
    return;
  }
  const switching = activeSessionId !== id;
  activeSessionId = id;
  if (session) {
    session.unreadCount = 0;
    session.isWaiting = false;
    session.waitingReason = null;
    session.waitingText = null;
    // Snapshot the current question signature as "read" — any future idle
    // transitions will compare against this and only bump unread on real new Q&A.
    session.readSignature = getQuestionsSignature(id);
  }
  ipcRenderer.send('focus-session', { sessionId: id });
  renderSessionList();
  showTerminal(id, { focus: switching });
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

// Ctrl+click on a local file path in the terminal → open with OS default app.
// xterm's WebLinksAddon only handles URLs, so we register a separate link
// provider that matches absolute Windows paths ending in a recognizable
// extension (1-8 alphanumerics). Click routes to main via `open-path` IPC,
// which calls shell.openPath().
//
// Regex notes:
//   - Anchored with [A-Za-z]: drive letter, followed by \ or /
//   - Path segments forbid the Windows-illegal chars :*?"<>| plus whitespace
//     (spaces break the match — rare in paths we emit, acceptable tradeoff)
//   - Extension 1-8 alnum with a negative lookahead so "foo.js" doesn't
//     greedily swallow a trailing letter from ":123" line-number suffixes
const LOCAL_PATH_RE = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

function registerLocalPathLinks(terminal) {
  terminal.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links = [];
      LOCAL_PATH_RE.lastIndex = 0;
      let m;
      while ((m = LOCAL_PATH_RE.exec(text))) {
        const filePath = m[0];
        const startColumn = m.index + 1;
        const endColumn = startColumn + filePath.length - 1;
        links.push({
          range: {
            start: { x: startColumn, y: lineNumber },
            end: { x: endColumn, y: lineNumber },
          },
          text: filePath,
          activate: async (_event, uri) => {
            const err = await ipcRenderer.invoke('open-path', uri);
            if (err) console.warn('[hub] open-path failed:', uri, '→', err);
          },
        });
      }
      callback(links);
    },
  });
}

// Strip artifacts we ourselves injected into the user's prompt before
// forming the sidebar preview. Today that's just clipboard-image paths:
// Ctrl+V on an image calls save-clipboard-image and pastes the resulting
// absolute path into the terminal, so CC's transcript records the path
// immediately before the user's typed text. Without this the 60-char
// preview is pure path and the real question is truncated away.
function buildPreviewFromUserMessage(raw) {
  const HUB_IMG_PATH = /(?:[A-Za-z]:)?[\\/][^\s]*[\\/]\.claude-session-hub[\\/]images[\\/][^\s]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;
  let clean = String(raw).replace(HUB_IMG_PATH, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 60 ? clean.substring(0, 58) + '…' : clean;
}

// --- Terminal buffer reading (xterm.js buffer API) ---

const silenceTimers = new Map();
const dataCounters = new Map();  // sessionId -> bytes received in current burst
const SILENCE_MS = 2000; // 2s silence = idle (Claude Code status bar refreshes ~every 30-60s)

/** Pure parser: extract user prompts from raw buffer line strings.
 *  Claude Code's user-input prompt is "❯ <text>", often wrapped in a
 *  box like "│ ❯ <text> │". This strictly matches ❯ (not > or ›,
 *  which would catch AI output) and skips any line containing an
 *  AI-reply marker (⏺●◐ etc.) as a safety net.
 */
function parseQuestionsFromLines(lines) {
  const questions = [];
  const seen = new Set();
  const AI_MARKERS = /[⏺●◉◐◑◒◓◔◕]/;
  // NOTE: the primary source of preview text is now CC's transcript JSONL,
  // delivered via the Stop hook (see renderer's hook-event handler). This
  // regex is only a fallback for sessions without hook coverage.
  // Restricted to ❯ / › — specifically Claude Code's prompt glyphs. Dropping
  // ASCII '>' on purpose: it was matching assistant markdown/list content
  // like "> Phase 1 …" as if it were a user question.
  const RE = /^[\s│╭─╮╰╯]*[❯›]\s+(.+?)(?:\s*[│╯╰╭╮]+\s*)?$/;
  for (const raw of lines) {
    if (!raw) continue;
    if (AI_MARKERS.test(raw)) continue;
    const m = raw.match(RE);
    if (!m) continue;
    const q = m[1].replace(/\s+$/, '').trim();
    if (q.length < 2) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    questions.push(q);
  }
  return questions;
}

/** Extract user questions from an xterm buffer. */
function extractUserQuestions(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached || !cached.opened) return [];
  const buf = cached.terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.trim()) lines.push(text);
  }
  return parseQuestionsFromLines(lines);
}


/** Read the trailing N lines of the xterm buffer as plain text (post-render). */
function extractTailLines(sessionId, count = 40) {
  const cached = terminalCache.get(sessionId);
  if (!cached || !cached.opened) return [];
  const buf = cached.terminal.buffer.active;
  const out = [];
  const start = Math.max(0, buf.length - count);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    out.push(line.translateToString(true));
  }
  return out;
}

/** Strict classifier: does the session look like Claude is waiting for user input?
 *  False positives are worse than false negatives — only fire on clear question
 *  / choice / confirm patterns. Returns { waiting, reason, text } or { waiting:false }. */
function isWaitingForUser(lines) {
  if (!lines || lines.length === 0) return { waiting: false };
  const AI_MARKERS = /[⏺●◉◐◑◒◓◔◕]/;
  const PROMPT_PREFIX = /^[\s│╭─╮╰╯]*[❯›]\s+/;
  let lastMeaningful = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = (lines[i] || '').trim();
    if (!L) continue;
    if (PROMPT_PREFIX.test(L)) continue;
    const stripped = L.replace(AI_MARKERS, '').trim();
    if (!stripped) continue;
    lastMeaningful = stripped;
    break;
  }
  if (!lastMeaningful) return { waiting: false };
  const tail = lines.slice(-12).join('\n');
  // Rule: [y/N] / [Y/n] / (yes/no) → explicit confirm
  if (/\[y\/N\]|\[Y\/n\]|\(yes\/no\)/i.test(tail)) {
    return { waiting: true, reason: 'confirm', text: lastMeaningful };
  }
  // Rule: numbered list + question word (both Chinese and English)
  const hasList = /(^|\n)\s*[1-9][.\)]\s+\S|(^|\n)\s*[①②③④⑤⑥⑦⑧⑨]/m.test(tail);
  const hasQWord = /\b(which|what|choose|select|option|pick)\b|哪个|哪一|请选择|请确认|选择|选 ?[一二三1-9]/i.test(tail);
  if (hasList && hasQWord) {
    return { waiting: true, reason: 'choice', text: lastMeaningful };
  }
  // Rule: last meaningful line ends with ? / ？ and is short enough to be a question
  if (lastMeaningful.length < 200 && /[?？]\s*$/.test(lastMeaningful)) {
    return { waiting: true, reason: 'question', text: lastMeaningful };
  }
  return { waiting: false };
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
  if (questions.length === 0) return;

  const lastQ = questions[questions.length - 1];
  const newPreview = lastQ.length > 60 ? lastQ.substring(0, 58) + '…' : lastQ;

  // Preview text only; sort time + unread are bumped on AI reply completion.
  // If we've already received an authoritative preview from the CC transcript
  // hook, don't let the regex fallback overwrite it with potentially-stale
  // buffer content.
  if (session._previewFromTranscript) return;
  if (newPreview && newPreview !== session.lastOutputPreview) {
    session.lastOutputPreview = newPreview;
    renderSessionList();
    schedulePersist();
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
// Carries contextPct / cwd / api time / session_name per session + account-wide usage5h/usage7d.
const accountUsage = { usage5h: null, usage7d: null };

ipcRenderer.on('status-event', (_e, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session) {
    session.contextPct = payload.contextPct;
    session.contextUsed = payload.contextUsed;
    session.contextMax = payload.contextMax;
    if (payload.cwd) session.cwd = payload.cwd;
    if (typeof payload.apiMs === 'number') session.apiMs = payload.apiMs;
    if (typeof payload.linesAdded === 'number') session.linesAdded = payload.linesAdded;
    if (typeof payload.linesRemoved === 'number') session.linesRemoved = payload.linesRemoved;
    if (payload.model && payload.model.id) {
      session.currentModel = payload.model;
      if (payload.sessionId === activeSessionId) updateActiveModelBadge();
    }
    // Claude → Hub title sync: only overlay if user hasn't explicitly renamed in Hub.
    // The /rename we inject comes back via this same field — the guard below prevents loops.
    if (payload.sessionName && !session.userRenamed && session.title !== payload.sessionName) {
      session.title = payload.sessionName;
      session.claudeSessionName = payload.sessionName;
      if (payload.sessionId === activeSessionId) {
        const el = terminalPanelEl.querySelector('.terminal-title');
        if (el) el.textContent = payload.sessionName;
      }
    }
    if (payload.sessionId === activeSessionId) updateActiveMetricsRow();
  }
  // Usage is account-wide — keep the latest reported values
  if (payload.usage5h) accountUsage.usage5h = payload.usage5h;
  if (payload.usage7d) accountUsage.usage7d = payload.usage7d;
  renderAccountUsage();
  renderSessionList();
});

// Map a Claude Code model id to a CSS family class for badge coloring.
function modelClass(id) {
  if (!id) return '';
  const s = id.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  return '';
}

// Short label for the sidebar badge. display_name is already compact
// ("Opus 4.6 (1M context)"); we strip the parenthetical to keep the pill slim.
function modelShort(m) {
  if (!m) return '';
  const dn = m.displayName || '';
  if (dn) return dn.replace(/\s*\(.*?\)\s*$/, '').trim();
  const id = (m.id || '').toLowerCase();
  if (id.includes('opus')) return 'Opus';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  return m.id || '';
}

// Refresh just the terminal-header badge for the active session without a full re-render.
function updateActiveModelBadge() {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!session) return;
  const titleSection = terminalPanelEl.querySelector('.terminal-title-section');
  if (!titleSection) return; // header not mounted yet (empty state)
  let badge = titleSection.querySelector('.terminal-model-badge');
  if (!session.currentModel) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'terminal-model-badge';
    titleSection.appendChild(badge);
  }
  badge.className = 'terminal-model-badge ' + modelClass(session.currentModel.id);
  badge.textContent = session.currentModel.displayName || modelShort(session.currentModel);
  badge.title = session.currentModel.id;
}

// Compact "3m20s" / "1h5m" — used for api duration in the header metrics row.
function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? (s % 60) + 's' : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? (m % 60) + 'm' : ''}`;
}

// Render the per-session metrics row (cwd · api time · lines diff). Called on
// session switch + every status-event for the active session.
function renderMetricsRow(el, session) {
  if (!el || !session) return;
  el.innerHTML = '';
  const frags = [];
  if (session.cwd) {
    const a = document.createElement('span');
    a.className = 'metric-cwd';
    a.textContent = '\uD83D\uDCC1 ' + session.cwd;
    a.title = 'Click to copy · ' + session.cwd;
    a.addEventListener('click', () => {
      try { clipboard.writeText(session.cwd); } catch {}
    });
    frags.push(a);
  }
  if (typeof session.apiMs === 'number' && session.apiMs > 0) {
    const s = document.createElement('span');
    s.textContent = '\u23F1 ' + formatDuration(session.apiMs);
    s.title = 'Total API time (AI actually working)';
    frags.push(s);
  }
  frags.forEach((f, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'metric-sep';
      sep.textContent = '\u00b7';
      el.appendChild(sep);
    }
    el.appendChild(f);
  });
}

function updateActiveMetricsRow() {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!session) return;
  const row = terminalPanelEl.querySelector('.terminal-metrics-row');
  if (row) renderMetricsRow(row, session);
}

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
  const buildRow = (label, usage) => {
    const pct = Math.round(usage.pct);
    const reset = formatResetIn(usage.resetsAt);
    return `<div class="usage-row"><span class="usage-label">${label}</span><div class="usage-bar"><div class="usage-bar-fill ${pctClass(pct)}" style="width:${pct}%"></div></div><span class="usage-val">${pct}%${reset ? ' · ' + reset : ''}</span></div>`;
  };
  if (usage5h) parts.push(buildRow('5h', usage5h));
  if (usage7d) parts.push(buildRow('7d', usage7d));
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
ipcRenderer.on('hook-event', (_e, { event, sessionId, claudeSessionId, cwd, latestUserMessage }) => {
  const s = sessions.get(sessionId);
  if (s) {
    // Persist CC session id + cwd the first time we learn them so resumes work.
    if (claudeSessionId && s.ccSessionId !== claudeSessionId) {
      s.ccSessionId = claudeSessionId;
      schedulePersist();
    }
    // Only capture cwd ONCE (first hook). Updating on every hook lets a later
    // user `cd` mutate the saved value, which then breaks `claude --resume` on
    // next launch — CC stores transcripts under a project slug derived from
    // the cwd at CREATE time, so resume must spawn in that same cwd.
    if (cwd && !s.cwd) {
      s.cwd = cwd;
      schedulePersist();
    }
    // Authoritative preview: CC's own transcript JSONL. Wins over any regex
    // extraction from the xterm buffer — no more "assistant content misread
    // as user question" false positives.
    if (latestUserMessage) {
      const preview = buildPreviewFromUserMessage(latestUserMessage);
      if (preview && preview !== s.lastOutputPreview) {
        s.lastOutputPreview = preview;
        s._previewFromTranscript = true;
        renderSessionList();
        schedulePersist();
      }
    }
  }
  if (event === 'stop') {
    onReplyCompleteFromHook(sessionId);
    // Flush any queued /rename now that Claude is idle. Small delay so the
    // prompt fully re-renders before we inject the command.
    const s = sessions.get(sessionId);
    if (s && s._pendingRename) {
      const pending = s._pendingRename;
      s._pendingRename = null;
      setTimeout(() => {
        ipcRenderer.send('terminal-input', { sessionId, data: '/rename ' + pending + '\r' });
      }, 400);
    }
  }
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

  // "Claude is waiting for your input" — classify the tail of the AI's output.
  // Strict rules: only fires when the AI asked a clear question / listed choices /
  // asked for [y/N]. Flag lives until the user selects this session.
  const wasWaiting = !!session.isWaiting;
  const w = isWaitingForUser(extractTailLines(sessionId, 40));
  session.isWaiting = w.waiting;
  session.waitingReason = w.waiting ? w.reason : null;
  session.waitingText = w.waiting ? String(w.text || '').slice(0, 200) : null;
  const newlyWaiting = w.waiting && !wasWaiting;

  if (!session.lastOutputPreview) {
    if (newlyWaiting) {
      if (sessionId !== activeSessionId) maybeNotify(session);
      renderSessionList();
    }
    return;
  }

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
  } else if (newlyWaiting && sessionId !== activeSessionId) {
    maybeNotify(session);
    renderSessionList();
  }
}

// --- System notification (fire when window is in background) ---
async function maybeNotify(session) {
  try {
    const focused = await ipcRenderer.invoke('is-window-focused');
    if (focused) return;
    const isW = !!session.isWaiting;
    ipcRenderer.send('show-notification', {
      title: session.title + (isW ? ' — 等你回复' : ' — reply ready'),
      body: (isW && session.waitingText) ? session.waitingText : (session.lastOutputPreview || ''),
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

  // Ctrl+B: toggle sidebar
  if (!e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault();
    toggleSidebar();
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
      schedulePersist();
    } else if (action === 'restart') {
      await ipcRenderer.invoke('restart-session', sid);
    } else if (action === 'close') {
      if (session.status === 'dormant') {
        // No PTY to kill; just forget the dormant entry and persist.
        sessions.delete(sid);
        if (activeSessionId === sid) activeSessionId = null;
        renderSessionList();
        schedulePersist();
      } else {
        await ipcRenderer.invoke('close-session', sid);
      }
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

// --- Sidebar collapse ---
const SIDEBAR_KEY = 'claude-hub-sidebar-collapsed';
function applySidebarCollapsed(collapsed) {
  appContainerEl.classList.toggle('sidebar-collapsed', collapsed);
  // After CSS transition, refit active xterm so it claims the new width.
  setTimeout(() => {
    const cached = terminalCache.get(activeSessionId);
    if (!cached) return;
    try { cached.fitAddon.fit(); } catch (_) {}
    ipcRenderer.send('terminal-resize', {
      sessionId: activeSessionId,
      cols: cached.terminal.cols,
      rows: cached.terminal.rows,
    });
  }, 200);
}
const initialCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
applySidebarCollapsed(initialCollapsed);
function toggleSidebar() {
  const next = !appContainerEl.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
  applySidebarCollapsed(next);
}
btnCollapseEl.addEventListener('click', toggleSidebar);
btnExpandEl.addEventListener('click', toggleSidebar);

// --- Theme (dark only; toggle button removed) ---
document.body.classList.remove('theme-light');
localStorage.removeItem('claude-hub-theme');

ipcRenderer.on('session-created', (_e, { session }) => {
  // When resuming a dormant session, the hubId matches an existing dormant
  // entry. Merge live PTY info on top of the dormant metadata so title /
  // preview / unread / pinned aren't wiped.
  const existing = sessions.get(session.id);
  if (existing && existing.status === 'dormant') {
    sessions.set(session.id, {
      ...existing,
      ...session,
      status: 'idle',
      // preserve persisted UX state
      pinned: existing.pinned,
      ccSessionId: existing.ccSessionId,
      lastOutputPreview: existing.lastOutputPreview,
    });
  } else {
    sessions.set(session.id, session);
  }
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

// --- Session persistence (dormant restore) ---
// Only Claude sessions persist across app restarts. PowerShell sessions are
// ephemeral by nature. Dormant sessions are rendered with status='dormant'
// and no PTY; clicking them spawns `claude --resume <ccSessionId>`.
let persistDebounceTimer = null;
function schedulePersist() {
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(() => {
    const list = [];
    for (const s of sessions.values()) {
      if (s.kind !== 'claude' && s.kind !== 'claude-resume') continue;
      list.push({
        hubId: s.id,
        title: s.title,
        kind: s.kind,
        cwd: s.cwd || null,
        pinned: !!s.pinned,
        ccSessionId: s.ccSessionId || null,
        lastMessageTime: s.lastMessageTime || Date.now(),
        lastOutputPreview: s.lastOutputPreview || '',
        unreadCount: s.unreadCount || 0,
      });
    }
    ipcRenderer.send('persist-sessions', list);
  }, 400);
}

// Wake a dormant session: call main to spawn PTY with --resume, then wait for
// session-created which will replace the dormant entry.
async function resumeDormantSession(hubId) {
  const dormant = sessions.get(hubId);
  if (!dormant || dormant.status !== 'dormant') return;
  // Keep title / pinned / preview so UI stays stable through the resume.
  await ipcRenderer.invoke('resume-session', {
    hubId,
    kind: dormant.kind,
    title: dormant.title,
    cwd: dormant.cwd,
    ccSessionId: dormant.ccSessionId,
    lastMessageTime: dormant.lastMessageTime,
    lastOutputPreview: dormant.lastOutputPreview,
  });
  // session-created handler will replace the dormant entry. Clear unread now.
  const s = sessions.get(hubId);
  if (s) { s.unreadCount = 0; renderSessionList(); }
}

// --- Init ---
(async () => {
  const existing = await ipcRenderer.invoke('get-sessions');
  for (const s of existing) sessions.set(s.id, s);

  // Restore dormant sessions from persisted state.
  const persisted = await ipcRenderer.invoke('get-dormant-sessions');
  if (persisted && Array.isArray(persisted.sessions)) {
    for (const meta of persisted.sessions) {
      if (sessions.has(meta.hubId)) continue;  // already live (shouldn't happen on fresh boot)
      sessions.set(meta.hubId, {
        id: meta.hubId,
        kind: meta.kind || 'claude',
        title: meta.title || 'Claude',
        status: 'dormant',
        lastMessageTime: meta.lastMessageTime || Date.now(),
        lastOutputPreview: meta.lastOutputPreview || '',
        unreadCount: meta.unreadCount || 0,
        createdAt: meta.lastMessageTime || Date.now(),
        cwd: meta.cwd || null,
        pinned: !!meta.pinned,
        ccSessionId: meta.ccSessionId || null,
      });
    }
  }
  renderSessionList();
})();

// Persist on relevant changes — listen at renderer-level for mutations that
// touch persistable fields. Debounced.
for (const ch of ['session-created', 'session-closed', 'session-updated']) {
  ipcRenderer.on(ch, () => schedulePersist());
}
