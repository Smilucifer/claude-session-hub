const { ipcRenderer, clipboard, nativeImage, shell, webFrame } = require('electron');
const { Terminal } = require('@xterm/xterm');

// --- Wheel/scroll diagnostic logger (DEBUG ONLY) ---
// Toggle in DevTools: __scrollDebug.on() / .off() / .read(20)
// Writes a JSON-ish line to scroll-debug.log on each tagged event.
window.__scrollDebug = (() => {
  const fs = require('fs');
  const pathMod = require('path');
  const LOG = pathMod.join(__dirname, '..', 'scroll-debug.log');
  let enabled = false;
  function snap(terminal, sessionId) {
    if (!terminal) return null;
    const buf = terminal.buffer.active;
    const out = {
      sid: sessionId ? sessionId.slice(0, 6) : '?',
      bufLen: buf.length, baseY: buf.baseY, vpY: buf.viewportY,
      cols: terminal.cols, rows: terminal.rows,
    };
    try {
      const vpEl = terminal.element && terminal.element.querySelector('.xterm-viewport');
      if (vpEl) {
        out.scrollH = vpEl.scrollHeight;
        out.scrollT = vpEl.scrollTop;
        out.clientH = vpEl.clientHeight;
        out.canScrollMore = vpEl.scrollHeight - vpEl.scrollTop - vpEl.clientHeight;
      }
      const vpInst = terminal._core && terminal._core._viewport;
      if (vpInst) {
        out.lastBufLen = vpInst._lastRecordedBufferLength;
        out.hasInnerRefresh = typeof vpInst._innerRefresh === 'function';
        out.hasQueueRefresh = typeof vpInst.queueRefresh === 'function';
        if (vpInst._lastRecordedViewportHeight !== undefined) {
          out.lastVpH = vpInst._lastRecordedViewportHeight;
        }
      }
    } catch (e) { out.err = String(e); }
    return out;
  }
  function log(tag, payload) {
    if (!enabled) return;
    try {
      const t = new Date().toISOString().slice(11, 23);
      fs.appendFileSync(LOG, `[${t}] ${tag} ${JSON.stringify(payload)}\n`);
    } catch {}
  }
  function probe(terminal, sessionId) {
    if (!terminal) return;
    try {
      const core = terminal._core || {};
      const out = {
        sid: sessionId ? sessionId.slice(0, 6) : '?',
        coreKeys: Object.keys(core).slice(0, 100),
        publicMethods: ['refresh','resize','scrollToBottom','scrollLines','scrollToLine','reset','clear'].filter(m => typeof terminal[m] === 'function'),
      };
      const candidates = ['_viewport','viewport','_renderService','_inputHandler','_bufferService','_renderer'];
      out.coreSubKeys = {};
      for (const k of candidates) {
        if (core[k]) {
          out.coreSubKeys[k] = Object.keys(core[k]).filter(x => /refresh|scroll|update|recompute|resize|inner/i.test(x)).slice(0, 30);
        }
      }
      const el = terminal.element;
      if (el) {
        out.elClasses = el.className;
        out.children = Array.from(el.children).map(c => c.className || c.tagName);
        const vp = el.querySelector('.xterm-viewport');
        if (vp) {
          out.vpChildren = Array.from(vp.children).map(c => `${c.tagName}.${c.className}(h=${c.clientHeight})`);
        }
      }
      fs.appendFileSync(LOG, `[PROBE] ${JSON.stringify(out, null, 2)}\n`);
      console.log('[scrollDebug] probe written to log');
    } catch (e) {
      fs.appendFileSync(LOG, `[PROBE-ERR] ${String(e)}\n`);
    }
  }
  return {
    on() {
      enabled = true;
      try { fs.writeFileSync(LOG, ''); } catch {}
      console.log('[scrollDebug] ON, log:', LOG);
    },
    off() { enabled = false; console.log('[scrollDebug] OFF'); },
    log, snap, probe,
    isOn() { return enabled; },
    path: LOG,
  };
})();

const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const { CanvasAddon } = require('@xterm/addon-canvas');

// --- Shared regex patterns ---
// One source of truth for UI-parsing heuristics. When Claude Code changes its
// TUI (prompt glyph, box chars, marker emoji) or we add a new file type, fix
// it here and every caller picks it up.
//
// Claude Code's user-input prompt line, e.g. "❯ text" or "│ ❯ text │".
// Deliberately excludes ASCII '>' — matched assistant markdown/list content.
const PROMPT_LINE_RE = /^[\s│╭─╮╰╯]*[❯›]\s+(.+?)(?:\s*[│╯╰╭╮]+\s*)?$/;
// Just the prompt prefix — no capture group. Used when we only need to skip
// prompt lines rather than parse them.
const PROMPT_PREFIX_RE = /^[\s│╭─╮╰╯]*[❯›]\s+/;
// Emoji Claude Code uses at the start of an AI-reply block. A safety net: if
// we ever mis-match a user prompt line, this filters out lines that are
// clearly assistant output.
const AI_MARKERS_RE = /[⏺●◉◐◑◒◓◔◕]/;
// Absolute Windows path ending in a 1-8 char alnum extension. /g so callers
// can iterate with exec(); reset lastIndex before each loop to avoid state
// leakage between calls.
const ABS_PATH_RE = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
// Image-only subset of ABS_PATH_RE for hover-preview detection.
const IMAGE_PATH_RE = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.(?:png|jpe?g|gif|webp|bmp)(?![A-Za-z0-9])/gi;
const PREVIEW_PATH_RE = /\.(?:html?|md|markdown|png|jpe?g|gif|webp|bmp)$/i;
// Our own clipboard-image directory. Stripped from sidebar preview: paste
// injects the path before the user's typed text and would otherwise eat the
// entire 60-char preview.
const HUB_IMG_PATH_RE = /(?:[A-Za-z]:)?[\\/][^\s]*[\\/]\.claude-session-hub[\\/]images[\\/][^\s]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;

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

/** Extract an image path around the given column, if any. Uses the shared
 *  IMAGE_PATH_RE so all path heuristics stay in sync. */
function extractPathAtPosition(lineText, colIndex) {
  IMAGE_PATH_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_PATH_RE.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (colIndex >= start && colIndex <= end) return match[0];
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

    if (filePath) {
      // extractPathAtPosition already scopes to image extensions via
      // IMAGE_PATH_RE, so any match here is safe to preview.
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
let contextMenuIsTeamRoom = false;

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

// --- Global UI zoom (Electron webFrame) ---
// Scales the entire renderer: sidebar, buttons, xterm cells, modals. Used
// mainly to bump everything up for remote/phone control vs. shrink for
// desktop. Distinct from setFontSize, which only touches the xterm font.
// Level is an integer; each step is ~20% per Electron's zoom curve. 0 = 100%.
const ZOOM_KEY = 'claude-hub-zoom-level';
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
let currentZoom = parseInt(localStorage.getItem(ZOOM_KEY), 10);
if (isNaN(currentZoom)) currentZoom = 0;

function applyZoom(level) {
  level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
  currentZoom = level;
  webFrame.setZoomLevel(level);
  localStorage.setItem(ZOOM_KEY, String(level));
  // Re-fit the active xterm so terminal cols/rows match the new render size.
  const active = activeSessionId && terminalCache.get(activeSessionId);
  if (active && active.opened) {
    try { active.fitAddon.fit(); } catch {}
    ipcRenderer.send('terminal-resize', {
      sessionId: activeSessionId,
      cols: active.terminal.cols,
      rows: active.terminal.rows,
    });
  }
}

// Restore persisted zoom on boot.
applyZoom(currentZoom);

// --- Global Memo Panel ---
const MEMO_OPEN_KEY = 'claude-hub-memo-open';
const _memoFs = require('fs');
const _memoPath = require('path');
const _memoFile = _memoPath.join(
  require('../core/data-dir').getHubDataDir(), 'memo.json'
);

function loadMemoItems() {
  try { return JSON.parse(_memoFs.readFileSync(_memoFile, 'utf8')); }
  catch { return []; }
}
function saveMemoItems(items) {
  try {
    _memoFs.mkdirSync(_memoPath.dirname(_memoFile), { recursive: true });
    _memoFs.writeFileSync(_memoFile, JSON.stringify(items, null, 2), 'utf8');
  } catch (e) { console.error('[memo] save failed:', e.message); }
}

function formatMemoTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderMemoList() {
  const listEl = document.getElementById('memo-list');
  if (!listEl) return;
  const items = loadMemoItems();
  if (items.length === 0) {
    listEl.innerHTML = '<div class="memo-empty">暂无备忘</div>';
    return;
  }
  listEl.innerHTML = items.map(item => `
    <div class="memo-item" data-id="${item.id}">
      <div class="memo-item-time">${formatMemoTime(item.ts)}</div>
      <div class="memo-item-body">
        <span class="memo-item-text">${escapeHtml(item.text)}</span>
        <span class="memo-item-actions">
          <button class="memo-item-btn memo-copy-btn" title="复制">📋</button>
          <button class="memo-item-btn memo-del-btn" title="删除">🗑</button>
        </span>
      </div>
    </div>
  `).join('');
}

function addMemoItem(text) {
  if (!text.trim()) return;
  const items = loadMemoItems();
  items.unshift({ id: 'm_' + Date.now(), text: text.trim(), ts: Date.now() });
  saveMemoItems(items);
  renderMemoList();
}

function deleteMemoItem(id) {
  const items = loadMemoItems().filter(i => i.id !== id);
  saveMemoItems(items);
  renderMemoList();
}

function clearAllMemo() {
  saveMemoItems([]);
  renderMemoList();
}

function toggleMemoPanel() {
  const panel = document.getElementById('memo-panel');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  localStorage.setItem(MEMO_OPEN_KEY, String(!isOpen));
  document.querySelectorAll('.btn-memo-toggle').forEach(btn => {
    btn.classList.toggle('active', !isOpen);
  });
  if (!isOpen) renderMemoList();
  // Re-fit active terminal after layout change
  const active = activeSessionId && terminalCache.get(activeSessionId);
  if (active && active.opened) {
    setTimeout(() => { try { active.fitAddon.fit(); } catch {} }, 50);
  }
}

// Memo panel event delegation (runs once on DOMContentLoaded)
function initMemoPanel() {
  const addBtn = document.getElementById('memo-add-btn');
  const input = document.getElementById('memo-input');
  const clearBtn = document.getElementById('memo-clear-btn');
  const listEl = document.getElementById('memo-list');
  if (!addBtn || !input) return;

  // Prevent keyboard events from reaching xterm
  input.addEventListener('keydown', e => e.stopPropagation());
  input.addEventListener('keypress', e => e.stopPropagation());
  input.addEventListener('keyup', e => e.stopPropagation());

  addBtn.addEventListener('click', () => {
    addMemoItem(input.value);
    input.value = '';
    input.focus();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addMemoItem(input.value);
      input.value = '';
    }
  });

  clearBtn.addEventListener('click', () => clearAllMemo());

  listEl.addEventListener('click', e => {
    const copyBtn = e.target.closest('.memo-copy-btn');
    if (copyBtn) {
      const item = copyBtn.closest('.memo-item');
      const text = item.querySelector('.memo-item-text').textContent;
      clipboard.writeText(text);
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
      return;
    }
    const delBtn = e.target.closest('.memo-del-btn');
    if (delBtn) {
      const item = delBtn.closest('.memo-item');
      deleteMemoItem(item.dataset.id);
    }
  });

  // Restore open state
  if (localStorage.getItem(MEMO_OPEN_KEY) === 'true') {
    const panel = document.getElementById('memo-panel');
    if (panel) {
      panel.style.display = 'flex';
      renderMemoList();
      document.querySelectorAll('.btn-memo-toggle').forEach(btn => btn.classList.add('active'));
    }
  }
}

initMemoPanel();

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
// Mixed list: regular sessions + AI Team Rooms share the same sort + rendering.
function renderSessionList() {
  const regularSessions = Array.from(sessions.values()).filter(s => !s.meetingId);

  // Fold team rooms into the unified list. Preview is "actor: content" format,
  // time sort uses the latest message's ts; both parallel how regular sessions
  // work so a team room with a recent reply bubbles up to the top.
  const teamItems = teamRooms.map(room => {
    const preview = teamRoomPreviews[room.id];
    const previewText = preview
      ? `${teamActorDisplay(preview.actor, preview.actorName)}: ${preview.content}`
      : (room.members || []).join(', ');
    const tsSec = preview ? parseInt(preview.ts) : 0;
    const idTs = room.id ? parseInt(room.id.replace('room-', ''), 10) : 0;
    const tsMs = tsSec ? tsSec * 1000 : (idTs || Date.now());
    return {
      id: room.id,
      title: room.display_name || room.id,
      lastMessageTime: tsMs,
      createdAt: tsMs,
      lastOutputPreview: previewText,
      status: 'running',
      unreadCount: teamRoomUnread[room.id] || 0,
      _isTeamRoom: true,
      _room: room,
    };
  });

  const meetingItems = Object.values(meetings).map(m => ({
    id: m.id,
    title: m.title,
    lastMessageTime: m.lastMessageTime,
    createdAt: m.createdAt,
    lastOutputPreview: `${m.subSessions.length} 个子会话`,
    status: m.status || 'idle',
    unreadCount: 0,
    pinned: m.pinned,
    _isMeeting: true,
    _meeting: m,
  }));

  const all = regularSessions.concat(teamItems).concat(meetingItems);

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

  // Hide any leftover [Team] PTY sessions from legacy code path — those are
  // never user-visible entry points; team rooms come in via teamItems above.
  const visible = sorted.filter(s => !s.title || !s.title.startsWith('[Team] '));
  const totalCount = regularSessions.length + teamItems.length;

  sessionCountEl.textContent = searchQuery
    ? `${visible.length}/${totalCount}`
    : `${totalCount} open`;

  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  sessionListEl.innerHTML = '';

  for (const s of visible) {
    if (s._isTeamRoom) {
      const isActive = activeTeamRoomId === s.id;
      const div = document.createElement('div');
      div.className = 'session-item team-room' + (isActive ? ' selected' : '') + (!isActive && s.unreadCount > 0 ? ' has-unread' : '');
      div.innerHTML = `
        <div class="session-item-header">
          <span class="session-title"><span class="session-status running"></span>${escapeHtml(s.title)}</span>
          <span class="session-header-right">
            ${s.unreadCount > 0 && !isActive ? `<span class="unread-badge">${s.unreadCount}</span>` : ''}
            <span class="session-time">${s.lastMessageTime ? formatTime(s.lastMessageTime) : escapeHtml(s._room.task_mode || 'natural')}</span>
          </span>
        </div>
        <div class="session-preview">${escapeHtml(s.lastOutputPreview)}</div>
      `;
      div.addEventListener('click', () => selectTeamRoom(s.id));
      div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY, true); });
      sessionListEl.appendChild(div);
      continue;
    }

    if (s._isMeeting) {
      const isActive = activeMeetingId === s.id;
      const div = document.createElement('div');
      div.className = 'session-item meeting' + (isActive ? ' selected' : '');
      div.innerHTML = `
        <div class="session-item-header">
          <span class="session-title">${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}<span class="session-status running"></span>🏢 ${escapeHtml(s.title)}<span class="meeting-badge">${s._meeting.subSessions.length}</span></span>
          <span class="session-header-right">
            <span class="session-time">${formatTime(s.lastMessageTime)}</span>
          </span>
        </div>
        <div class="session-preview">${escapeHtml(s.lastOutputPreview)}</div>
      `;
      div.addEventListener('click', () => selectMeeting(s.id));
      div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
      sessionListEl.appendChild(div);
      continue;
    }

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
    // Burn attribution: only show if we have a rate ≥ 0.5%/h; clutter guard.
    const burn = sessionBurnRate(s);
    const burnBadge = (burn && burn.pctPerHour >= 0.5)
      ? `<span class="burn-badge ${burn.pctPerHour >= 5 ? 'danger' : burn.pctPerHour >= 2 ? 'warn' : 'ok'}" title="Est. share of 5h cap / hour at current rate (${Math.round(burn.tokensPerMin).toLocaleString()} tok/min)">🔥 ${burn.pctPerHour.toFixed(1)}%/h</span>`
      : '';
    const footerInner = [modelBadge, ctxBadge, burnBadge].filter(Boolean).join('');
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

// --- AI Team Room sidebar ---
let teamRooms = [];
let teamRoomPreviews = {};
let teamRoomUnread = {}; // { roomId: unreadCount } — parallels session.unreadCount
let teamCharacters = {}; // { id: {display_name, ...} } — cached once per boot
let activeTeamRoomId = null;
let activeMeetingId = null;
let meetings = {};

// Resolve actor id → display name. Team event payloads already include `name`,
// but historical previews loaded from DB only have actor id, so we fall back
// to the characters cache.
function teamActorDisplay(actorId, actorName) {
  if (actorId === 'user') return '你';
  if (actorName) return actorName;
  const ch = teamCharacters[actorId];
  return (ch && ch.display_name) || actorId;
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - parseInt(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  const d = new Date(parseInt(ts) * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function loadTeamRooms() {
  try {
    const initialized = await ipcRenderer.invoke('team:isInitialized');
    if (!initialized) { teamRooms = []; return; }
    const [rooms, previews, chars] = await Promise.all([
      ipcRenderer.invoke('team:loadRooms'),
      ipcRenderer.invoke('team:getRoomPreviews').catch(() => ({})),
      ipcRenderer.invoke('team:loadCharacters').catch(() => ({})),
    ]);
    teamRooms = rooms;
    teamRoomPreviews = previews || {};
    teamCharacters = chars || {};
    renderTeamRooms();
  } catch (e) {
    console.warn('[team] loadRooms failed:', e.message);
    teamRooms = [];
  }
}

// Team rooms are now rendered inside renderSessionList with unified sort
// order. Kept as a thin alias so existing callers (loadTeamRooms etc) just
// trigger a full re-render without caring about the mixed-list detail.
function renderTeamRooms() {
  renderSessionList();
}

// Delete a team room: IPC delete from DB+YAML, clean client state, hide panel.
// Called from both header X button (team-room.js) and right-click Close.
async function deleteTeamRoom(roomId) {
  if (!roomId) return;
  try { await ipcRenderer.invoke('team:deleteRoom', roomId); } catch (_) {}
  teamRooms = teamRooms.filter(r => r.id !== roomId);
  delete teamRoomPreviews[roomId];
  delete teamRoomUnread[roomId];
  if (activeTeamRoomId === roomId) {
    activeTeamRoomId = null;
    const trPanel = document.getElementById('team-room-panel');
    if (trPanel) trPanel.style.display = 'none';
    if (emptyStateEl) emptyStateEl.style.display = '';
  }
  renderSessionList();
}

function selectTeamRoom(roomId) {
  activeSessionId = null;
  activeMeetingId = null;
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  const pp = document.getElementById('preview-panel');
  if (pp) { pp.style.display = 'none'; previewSourcePanel = null; currentPreviewPath = null; }
  activeTeamRoomId = roomId;
  // Opening the room counts as "reading" any queued messages — parallels how
  // selectSession resets session.unreadCount = 0.
  if (teamRoomUnread[roomId]) teamRoomUnread[roomId] = 0;
  if (terminalPanelEl) terminalPanelEl.style.display = 'none';
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  const trPanel = document.getElementById('team-room-panel');
  if (trPanel) trPanel.style.display = 'flex';
  if (typeof TeamRoom !== 'undefined' && TeamRoom.openRoom) {
    const room = teamRooms.find(r => r.id === roomId);
    TeamRoom.openRoom(roomId, room);
  }
  renderSessionList();
}

function selectMeeting(meetingId) {
  activeSessionId = null;
  activeTeamRoomId = null;
  activeMeetingId = meetingId;

  if (terminalPanelEl) terminalPanelEl.style.display = 'none';
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  const trp = document.getElementById('team-room-panel');
  if (trp) trp.style.display = 'none';
  const pp = document.getElementById('preview-panel');
  if (pp) { pp.style.display = 'none'; previewSourcePanel = null; currentPreviewPath = null; }

  const meeting = meetings[meetingId];
  if (meeting && typeof MeetingRoom !== 'undefined') {
    if (meeting.status === 'dormant') {
      meeting.status = 'idle';
      for (const sid of meeting.subSessions) {
        const s = sessions.get(sid);
        if (s && s.status === 'dormant') {
          resumeDormantSession(sid);
        }
      }
    }
    MeetingRoom.openMeeting(meetingId, meeting);
  }

  renderSessionList();
}

// Global team:event listener — tracks per-room preview + unread badge so the
// sidebar updates live when messages arrive for rooms the user isn't viewing.
// team-room.js has its own listener scoped to the open-room thread; this one
// is independent and only touches sidebar state.
ipcRenderer.on('team:event', (_e, payload) => {
  if (!payload || payload.type !== 'event') return;
  const rid = payload.roomId;
  const evt = payload.data;
  if (!rid || !evt || evt.type !== 'message') return;
  const content = (evt.content || '').trim();
  if (!content) return;

  teamRoomPreviews[rid] = {
    actor: evt.actor || 'system',
    actorName: evt.name || null,
    content: content.slice(0, 200),
    ts: evt.ts || Math.floor(Date.now() / 1000),
  };
  if (activeTeamRoomId !== rid) {
    teamRoomUnread[rid] = (teamRoomUnread[rid] || 0) + 1;
  }
  renderSessionList();
});

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

  terminal.onData((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });
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
    if (window.__scrollDebug && window.__scrollDebug.isOn()) {
      window.__scrollDebug.log('wheel:before', { deltaY: e.deltaY, mode: e.deltaMode, ctrl: !!e.ctrlKey, ...window.__scrollDebug.snap(terminal, sessionId) });
      requestAnimationFrame(() => {
        window.__scrollDebug.log('wheel:after-raf', window.__scrollDebug.snap(terminal, sessionId));
      });
    }
    if (!e.ctrlKey && !e.metaKey) return;
    const delta = e.deltaY < 0 ? 1 : -1;
    setFontSize(currentFontSize + delta);
  }, { passive: true });

  const cached = {
    terminal, fitAddon, searchAddon, container, opened: false,
  };
  terminalCache.set(sessionId, cached);
  return cached;
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
    modelSpan.title = session.currentModel.id + ' — click to switch model';
    attachModelPickerHandler(modelSpan, sessionId);
    titleSection.appendChild(modelSpan);
  }

  // Zoom controls live right next to the close button so they're always at
  // the top-right of whichever session you're in. Buttons are recreated per
  // showTerminal call; no need to worry about stale references.
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'btn-zoom';
  zoomOutBtn.textContent = 'A−';
  zoomOutBtn.title = 'Shrink UI (for local screen)';
  zoomOutBtn.addEventListener('click', () => applyZoom(currentZoom - 1));

  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'btn-zoom';
  zoomInBtn.textContent = 'A+';
  zoomInBtn.title = 'Enlarge UI (for remote / phone)';
  zoomInBtn.addEventListener('click', () => applyZoom(currentZoom + 1));

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

  const headerActions = document.createElement('div');
  headerActions.className = 'terminal-header-actions';
  const memoBtn = document.createElement('button');
  memoBtn.className = 'btn-zoom btn-memo-toggle';
  memoBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
  memoBtn.title = 'Toggle memo panel';
  if (localStorage.getItem(MEMO_OPEN_KEY) === 'true') memoBtn.classList.add('active');
  memoBtn.addEventListener('click', () => toggleMemoPanel());

  headerActions.append(memoBtn, zoomOutBtn, zoomInBtn, closeBtn);

  titleRow.append(titleSection, headerActions);

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
    const dbg = window.__scrollDebug;
    if (dbg && dbg.isOn()) dbg.log('show:raf-enter', { focus: opts.focus, ...dbg.snap(cached.terminal, sessionId) });
    cached.fitAddon.fit();
    if (dbg && dbg.isOn()) dbg.log('show:after-fit', dbg.snap(cached.terminal, sessionId));
    ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
    if (opts.focus) {
      cached.terminal.scrollToBottom();
      if (dbg && dbg.isOn()) dbg.log('show:after-stb', dbg.snap(cached.terminal, sessionId));
      cached.terminal.focus();
      const vp = cached.container.querySelector('.xterm-viewport');
      if (vp) vp.scrollTop = vp.scrollHeight;
      if (dbg && dbg.isOn()) dbg.log('show:after-vp1', dbg.snap(cached.terminal, sessionId));

      // Ask xterm's Viewport to sync its inner .xterm-scroll-area height with
      // the buffer length. Without this, a session that grew while display:none
      // can have a stale (short) scrollHeight, causing wheel to max out before
      // the real buffer tail. The instance lives at `_core.viewport` in xterm
      // 5.5 (the previous attempt used `_viewport` which doesn't exist).
      // Do NOT manually set .xterm-scroll-area's height — _charSizeService.height
      // is character height, not line height (line-height multiplier missing),
      // so manual recomputation undershoots and breaks scrollHeight further.
      try {
        const vpInst = cached.terminal && cached.terminal._core && cached.terminal._core.viewport;
        if (vpInst && typeof vpInst.syncScrollArea === 'function') {
          vpInst.syncScrollArea(true);
        }
      } catch {}
      if (dbg && dbg.isOn()) dbg.log('show:after-refresh', dbg.snap(cached.terminal, sessionId));
      requestAnimationFrame(() => {
        if (vp) vp.scrollTop = vp.scrollHeight;
        // Re-pin xterm's logical viewport too (scrollToBottom may have been
        // a no-op the first time when scrollArea was still stale).
        try { cached.terminal.scrollToBottom(); } catch {}
        if (dbg && dbg.isOn()) dbg.log('show:raf2-final', dbg.snap(cached.terminal, sessionId));
      });
    }
  });

  if (cached._ro) cached._ro.disconnect();
  if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
  const handleResize = () => {
    // Guard: ResizeObserver/resize can fire while the terminal's parent panel
    // is display:none (e.g. team room is active). Fitting against a zero-width
    // container collapses xterm to the minimum 1 col and the canvas stays
    // squeezed even after the panel re-opens.
    if (!cached.container.offsetWidth) return;
    cached.fitAddon.fit();
    ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
    if (cached._minimap) cached._minimap.invalidate();
  };
  cached._resizeHandler = handleResize;
  window.addEventListener('resize', handleResize);
  cached._ro = new ResizeObserver(handleResize);
  cached._ro.observe(cached.container);

  // Previous minimap (from a prior showTerminal call on any session) gets
  // disposed so xterm onScroll/onRender listeners don't pile up. The new
  // minimap's DOM was already removed when terminalPanelEl.innerHTML cleared.
  if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
  cached._minimap = mountMinimap(sessionId, termContainer, cached.terminal);
}

// Minimap: a narrow strip on the right edge of the terminal that shows prompt
// locations + the viewport window. Scans the xterm buffer on-demand (debounced);
// no line-by-line callbacks, so the terminal.write fast path stays untouched.
function mountMinimap(sessionId, termContainer, terminal) {
  const strip = document.createElement('div');
  strip.className = 'terminal-minimap';
  const viewport = document.createElement('div');
  viewport.className = 'minimap-viewport';
  const ticksLayer = document.createElement('div');
  ticksLayer.className = 'minimap-ticks';
  strip.append(ticksLayer, viewport);
  termContainer.appendChild(strip);

  let ticks = []; // [{line, text}]
  let scanTimer = null;
  let disposed = false;

  function scanBuffer() {
    if (disposed) return;
    const buf = terminal.buffer.active;
    const total = buf.length;
    const found = [];
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text) continue;
      if (AI_MARKERS_RE.test(text)) continue;
      const m = text.match(PROMPT_LINE_RE);
      if (!m) continue;
      const q = m[1].trim();
      if (q.length < 2) continue;
      found.push({ line: i, text: q });
    }
    ticks = found;
    render();
  }

  function invalidate() {
    if (disposed) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanBuffer, 250);
  }

  function render() {
    if (disposed) return;
    const buf = terminal.buffer.active;
    const total = Math.max(1, buf.length);
    const stripH = strip.clientHeight || 1;
    // Ticks
    ticksLayer.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const t of ticks) {
      const y = (t.line / total) * stripH;
      const el = document.createElement('div');
      el.className = 'minimap-tick';
      el.style.top = Math.round(y) + 'px';
      el.title = t.text.slice(0, 80);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        try { terminal.scrollToLine(t.line); } catch {}
      });
      frag.appendChild(el);
    }
    ticksLayer.appendChild(frag);
    // Viewport box
    const top = (buf.viewportY / total) * stripH;
    const height = Math.max(6, (terminal.rows / total) * stripH);
    viewport.style.top = Math.round(top) + 'px';
    viewport.style.height = Math.round(height) + 'px';
  }

  // Strip click (outside ticks) → scroll to proportional line.
  strip.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = strip.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / Math.max(1, rect.height);
    const buf = terminal.buffer.active;
    const target = Math.max(0, Math.min(buf.length - 1, Math.round(rel * buf.length)));
    try { terminal.scrollToLine(target); } catch {}
  });

  // xterm listeners. Keep them disposable.
  const scrollSub = terminal.onScroll(() => render());
  const renderSub = terminal.onRender(() => invalidate());

  // Initial scan (wait a frame so buffer is populated).
  requestAnimationFrame(() => { scanBuffer(); render(); });

  return {
    invalidate,
    dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      try { scrollSub.dispose(); } catch {}
      try { renderSub.dispose(); } catch {}
      if (strip.parentNode) strip.parentNode.removeChild(strip);
    },
  };
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
  // Hide team room if showing. Capture whether we're coming *from* a team room
  // so we can force a re-fit after layout settles — the cached terminal's
  // xterm canvas stayed with stale dimensions while terminal-panel was
  // display:none, and the single rAF inside showTerminal is sometimes too
  // early to see the real width.
  const wasTeamRoom = activeTeamRoomId != null;
  activeTeamRoomId = null;
  const trp = document.getElementById('team-room-panel');
  if (trp) trp.style.display = 'none';
  activeMeetingId = null;
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  const pp = document.getElementById('preview-panel');
  if (pp) { pp.style.display = 'none'; previewSourcePanel = null; currentPreviewPath = null; }
  const tp = document.getElementById('terminal-panel');
  if (tp) tp.style.display = '';

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
  }
  ipcRenderer.send('focus-session', { sessionId: id });
  renderSessionList();
  showTerminal(id, { focus: switching });
  // Terminal squeeze fix (ref commit e07ba0b on feature/lite-pty-rooms, never
  // made it to master before): when coming back from a team room, the first
  // fit inside showTerminal may run before the flex layout has propagated the
  // real width to the terminal container, leaving xterm with a shrunken
  // canvas. Keep rAF-ing until offsetWidth is non-zero, then re-fit + notify
  // the PTY.
  if (wasTeamRoom) {
    const _refit = () => {
      const c = terminalCache.get(id);
      if (!c || !c.fitAddon) return;
      if (!c.container.offsetWidth) { requestAnimationFrame(_refit); return; }
      try { c.fitAddon.fit(); } catch (_) {}
      ipcRenderer.send('terminal-resize', { sessionId: id, cols: c.terminal.cols, rows: c.terminal.rows });
    };
    requestAnimationFrame(_refit);
  }
  // Snapshot the current question signature as "read" AFTER showTerminal —
  // on first selection that's when cached.opened flips to true, and
  // getQuestionsSignature needs an opened buffer to read. Calling before
  // showTerminal always returned '' on first click, which then made the very
  // first AI reply after opening the session never bump unread.
  if (session) {
    session.readSignature = getQuestionsSignature(id);
  }
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
    if (btn.dataset.kind === 'meeting') {
      const meeting = await ipcRenderer.invoke('create-meeting');
      if (meeting) {
        meetings[meeting.id] = meeting;
        selectMeeting(meeting.id);
        renderSessionList();
        schedulePersist();
      }
      return;
    }
    if (btn.dataset.kind === 'team-room') {
      openCreateRoomModal();
      return;
    }
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}

// --- Resume past session modal ---
const resumeModalEl = document.getElementById('resume-modal');
const resumeListEl = document.getElementById('resume-list');
const resumeFilterEl = document.getElementById('resume-filter');
let resumeItems = [];

function openResumeModal() {
  resumeModalEl.style.display = 'flex';
  resumeFilterEl.value = '';
  resumeListEl.innerHTML = '<div class="modal-empty">Scanning…</div>';
  requestAnimationFrame(() => resumeFilterEl.focus());
  ipcRenderer.invoke('list-past-sessions', { limit: 50 }).then((items) => {
    resumeItems = items || [];
    renderResumeList(resumeItems);
  }).catch(() => {
    resumeListEl.innerHTML = '<div class="modal-empty">Scan failed.</div>';
  });
}

function closeResumeModal() {
  resumeModalEl.style.display = 'none';
}

// --- Create Team Room modal ---
const createRoomModalEl = document.getElementById('create-room-modal');
const createRoomNameEl = document.getElementById('create-room-name');
const createRoomMembersEl = document.getElementById('create-room-members');
const createRoomConfirmEl = document.getElementById('create-room-confirm');

const ROOM_NAME_POOL = [
  '赤焰','碧风','苍雷','紫潮','银光','金翼','翠岩','玄冰','朱云','墨虹',
  '烈阳','幽泉','霜月','岚峰','铁壁','惊涛','飞霜','裂空','奔雷','破晓',
  '星河','龙吟','凤鸣','虎啸','鹤唳','鹰击','狼烟','豹变','麟角','鲲鹏',
];

function generateRoomName() {
  const taken = new Set(teamRooms.map(r => r.display_name || ''));
  for (const name of ROOM_NAME_POOL) {
    if (!taken.has(name)) return name;
  }
  let n = teamRooms.length + 1;
  while (taken.has(`作战室 ${n}`)) n++;
  return `作战室 ${n}`;
}

async function openCreateRoomModal() {
  createRoomModalEl.style.display = 'flex';
  createRoomNameEl.value = generateRoomName();
  createRoomConfirmEl.disabled = false;
  createRoomConfirmEl.textContent = '创建';
  createRoomMembersEl.innerHTML = '';

  try {
    const chars = await ipcRenderer.invoke('team:loadCharacters');
    const charEntries = Object.entries(chars || {});
    for (const [id, ch] of charEntries) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;color:var(--text-primary);font-size:14px;cursor:pointer';
      label.innerHTML = `<input type="checkbox" class="create-room-cb" data-char-id="${escapeHtml(id)}" checked>
        ${escapeHtml(ch.display_name || id)} <span style="color:var(--text-secondary);font-size:12px">(${escapeHtml(ch.backing_cli || '')})</span>`;
      createRoomMembersEl.appendChild(label);
    }
  } catch (e) {
    createRoomMembersEl.innerHTML = '<div style="color:var(--text-secondary)">无法加载角色列表</div>';
  }

  requestAnimationFrame(() => createRoomNameEl.focus());
}

function closeCreateRoomModal() {
  createRoomModalEl.style.display = 'none';
}

async function submitCreateRoom() {
  const name = createRoomNameEl.value.trim();
  if (!name) return;
  const memberIds = [...document.querySelectorAll('.create-room-cb:checked')]
    .map(cb => cb.dataset.charId);
  if (memberIds.length === 0) return;

  createRoomConfirmEl.disabled = true;
  createRoomConfirmEl.textContent = '创建中...';

  try {
    const result = await ipcRenderer.invoke('team:createRoom', name, memberIds);
    closeCreateRoomModal();
    await loadTeamRooms();
    if (result && result.id) {
      selectTeamRoom(result.id);
    }
  } catch (e) {
    console.error('[create-room] failed:', e.message);
    createRoomConfirmEl.textContent = '失败，重试';
    createRoomConfirmEl.disabled = false;
  }
}

createRoomNameEl.addEventListener('input', () => {
  createRoomConfirmEl.disabled = !createRoomNameEl.value.trim();
  createRoomConfirmEl.textContent = '创建';
});

createRoomNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !createRoomConfirmEl.disabled) submitCreateRoom();
  if (e.key === 'Escape') closeCreateRoomModal();
});

createRoomConfirmEl.addEventListener('click', submitCreateRoom);
document.getElementById('create-room-cancel').addEventListener('click', closeCreateRoomModal);
document.getElementById('create-room-close').addEventListener('click', closeCreateRoomModal);

createRoomModalEl.addEventListener('mousedown', (e) => {
  if (e.target === createRoomModalEl) closeCreateRoomModal();
});

function renderResumeList(items) {
  if (!items || items.length === 0) {
    resumeListEl.innerHTML = '<div class="modal-empty">No past sessions found.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'modal-row';
    const mtimeStr = it.mtime ? new Date(it.mtime).toLocaleString('zh-CN', { hour12: false }) : '';
    const preview = it.firstUserMessage || '(no user prompt captured)';
    const modelShort = (it.model || '').replace(/^claude-/, '').replace(/-\d+$/, '');
    row.innerHTML = `
      <div class="modal-row-main">
        <span class="modal-row-preview">${escapeHtml(preview)}</span>
      </div>
      <div class="modal-row-meta">
        <span class="modal-meta-time">${escapeHtml(mtimeStr)}</span>
        ${it.turnCount ? `<span class="modal-meta-chip">${it.turnCount}T</span>` : ''}
        ${modelShort ? `<span class="modal-meta-chip">${escapeHtml(modelShort)}</span>` : ''}
        ${it.cwd ? `<span class="modal-meta-cwd" title="${escapeHtml(it.cwd)}">${escapeHtml(it.cwd)}</span>` : ''}
      </div>
    `;
    row.addEventListener('click', async () => {
      closeResumeModal();
      await ipcRenderer.invoke('create-session', {
        kind: 'claude-resume',
        opts: { resumeCCSessionId: it.sessionId, cwd: it.cwd || undefined },
      });
    });
    frag.appendChild(row);
  }
  resumeListEl.innerHTML = '';
  resumeListEl.appendChild(frag);
}

resumeFilterEl.addEventListener('input', () => {
  const q = resumeFilterEl.value.trim().toLowerCase();
  if (!q) { renderResumeList(resumeItems); return; }
  const filtered = resumeItems.filter(it => {
    const hay = ((it.firstUserMessage || '') + ' ' + (it.cwd || '') + ' ' + (it.model || '')).toLowerCase();
    return hay.includes(q);
  });
  renderResumeList(filtered);
});

document.getElementById('btn-resume-picker').addEventListener('click', openResumeModal);
document.getElementById('resume-modal-close').addEventListener('click', closeResumeModal);
resumeModalEl.addEventListener('click', (e) => {
  if (e.target === resumeModalEl) closeResumeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && resumeModalEl.style.display === 'flex') {
    e.preventDefault(); closeResumeModal();
  }
});

// --- "昨日之我" past-session full-text search (Ctrl+Shift+F) ---
const searchModalEl = document.getElementById('search-modal');
const searchQueryEl = document.getElementById('search-query');
const searchResultsEl = document.getElementById('search-results');
let searchDebounce = null;
let searchSeq = 0; // guard against out-of-order async responses

function openSearchModal() {
  searchModalEl.style.display = 'flex';
  searchQueryEl.value = '';
  searchResultsEl.innerHTML = '<div class="modal-empty">Type ≥ 2 chars to search.</div>';
  requestAnimationFrame(() => searchQueryEl.focus());
}
function closeSearchModal() { searchModalEl.style.display = 'none'; }

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const hit = tl.indexOf(ql, i);
    if (hit < 0) { out.push(escapeHtml(text.slice(i))); break; }
    out.push(escapeHtml(text.slice(i, hit)));
    out.push('<mark>' + escapeHtml(text.slice(hit, hit + query.length)) + '</mark>');
    i = hit + query.length;
  }
  return out.join('');
}

function renderSearchHits(hits, query, truncated) {
  if (!hits.length) {
    searchResultsEl.innerHTML = '<div class="modal-empty">No matches.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const h of hits) {
    const row = document.createElement('div');
    row.className = 'modal-row';
    const when = new Date(h.mtime).toLocaleString('zh-CN', { hour12: false });
    row.innerHTML = `
      <div class="modal-row-main">
        <span class="modal-row-preview">${highlightMatch(h.snippet, query)}</span>
      </div>
      <div class="modal-row-meta">
        <span class="modal-meta-time">${escapeHtml(when)}</span>
        <span class="modal-meta-chip">${h.role || '?'}</span>
        <span class="modal-meta-chip">line ${h.lineNo}</span>
      </div>
    `;
    row.title = 'Click to resume this session';
    row.addEventListener('click', async () => {
      closeSearchModal();
      await ipcRenderer.invoke('create-session', {
        kind: 'claude-resume',
        opts: { resumeCCSessionId: h.sessionId },
      });
    });
    frag.appendChild(row);
  }
  searchResultsEl.innerHTML = '';
  if (truncated) {
    const note = document.createElement('div');
    note.className = 'modal-empty';
    note.style.padding = '8px 14px';
    note.style.textAlign = 'left';
    note.textContent = `Showing first ${hits.length} matches (scan truncated — refine query for more).`;
    searchResultsEl.appendChild(note);
  }
  searchResultsEl.appendChild(frag);
}

searchQueryEl.addEventListener('input', () => {
  const q = searchQueryEl.value.trim();
  if (q.length < 2) {
    searchResultsEl.innerHTML = '<div class="modal-empty">Type ≥ 2 chars to search.</div>';
    return;
  }
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const seq = ++searchSeq;
    searchResultsEl.innerHTML = '<div class="modal-empty">Searching…</div>';
    const res = await ipcRenderer.invoke('search-past-sessions', { query: q, limit: 50 });
    if (seq !== searchSeq) return; // newer query in flight
    renderSearchHits(res.hits || [], q, !!res.truncated);
  }, 300);
});

document.getElementById('search-modal-close').addEventListener('click', closeSearchModal);
searchModalEl.addEventListener('click', (e) => {
  if (e.target === searchModalEl) closeSearchModal();
});
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+F — global search
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault(); openSearchModal();
    return;
  }
  if (e.key === 'Escape' && searchModalEl.style.display === 'flex') {
    e.preventDefault(); closeSearchModal();
  }
});

// Ctrl+click on a local file path in the terminal → open with OS default app.
// xterm's WebLinksAddon only handles URLs, so we register a separate link
// provider that scans each buffer line for absolute Windows paths using
// ABS_PATH_RE (shared — see top of file). Click routes to main via open-path,
// which calls shell.openPath().
function registerLocalPathLinks(terminal) {
  terminal.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links = [];
      ABS_PATH_RE.lastIndex = 0;
      let m;
      while ((m = ABS_PATH_RE.exec(text))) {
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
            if (PREVIEW_PATH_RE.test(uri)) {
              openPreviewPanel(uri);
            } else {
              const err = await ipcRenderer.invoke('open-path', uri);
              if (err) console.warn('[hub] open-path failed:', uri, '→', err);
            }
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
  let clean = String(raw).replace(HUB_IMG_PATH_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 60 ? clean.substring(0, 58) + '…' : clean;
}

// --- File Preview Panel ---
const previewPanelEl = document.getElementById('preview-panel');
const previewTitleEl = document.getElementById('preview-title');
const previewBodyEl = document.getElementById('preview-body');
let previewSourcePanel = null;
let currentPreviewPath = null;

async function openPreviewPanel(filePath) {
  currentPreviewPath = filePath;
  const fileName = filePath.replace(/^.*[\\/]/, '');
  previewTitleEl.textContent = fileName;
  previewTitleEl.title = filePath;

  if (!previewSourcePanel) {
    if (document.getElementById('meeting-room-panel').style.display !== 'none'
        && document.getElementById('meeting-room-panel').style.display !== '') {
      previewSourcePanel = 'meeting-room-panel';
    } else if (document.getElementById('team-room-panel').style.display !== 'none'
        && document.getElementById('team-room-panel').style.display !== '') {
      previewSourcePanel = 'team-room-panel';
    } else {
      previewSourcePanel = 'terminal-panel';
    }
  }

  const src = document.getElementById(previewSourcePanel);
  if (src) src.style.display = 'none';
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.style.display = 'none';
  previewPanelEl.style.display = 'flex';

  previewBodyEl.innerHTML = '';

  const ext = filePath.replace(/^.*\./, '.').toLowerCase();

  if (ext === '.html' || ext === '.htm') {
    const wv = document.createElement('webview');
    wv.src = 'file:///' + filePath.replace(/\\/g, '/');
    wv.style.cssText = 'width:100%;height:100%;border:none;';
    previewBodyEl.style.alignItems = 'stretch';
    previewBodyEl.style.justifyContent = 'stretch';
    previewBodyEl.appendChild(wv);
  } else if (ext === '.md' || ext === '.markdown') {
    const { marked } = require('marked');
    const DOMPurify = require('dompurify');
    const result = await ipcRenderer.invoke('read-file', filePath);
    if (result.error) {
      previewBodyEl.innerHTML = `<div class="preview-markdown" style="color:var(--text-secondary)">Failed to load: ${result.error}</div>`;
      return;
    }
    const html = DOMPurify.sanitize(marked.parse(result.content));
    previewBodyEl.style.alignItems = 'flex-start';
    previewBodyEl.style.justifyContent = 'flex-start';
    previewBodyEl.innerHTML = `<div class="preview-markdown">${html}</div>`;
  } else {
    const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    previewBodyEl.style.alignItems = 'center';
    previewBodyEl.style.justifyContent = 'center';
    previewBodyEl.innerHTML = `<img src="${fileUrl}" class="preview-image">`;
  }
}

function closePreviewPanel() {
  previewPanelEl.style.display = 'none';
  currentPreviewPath = null;

  if (previewSourcePanel) {
    const src = document.getElementById(previewSourcePanel);
    if (src) src.style.display = previewSourcePanel === 'terminal-panel' ? '' : 'flex';
    previewSourcePanel = null;
  }
}

document.getElementById('preview-close').addEventListener('click', closePreviewPanel);
document.getElementById('preview-open-external').addEventListener('click', async () => {
  if (currentPreviewPath) {
    const err = await ipcRenderer.invoke('open-path', currentPreviewPath);
    if (err) console.warn('[hub] open-path for preview failed:', currentPreviewPath, '→', err);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewPanelEl.style.display === 'flex') {
    e.preventDefault();
    closePreviewPanel();
  }
});

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
  for (const raw of lines) {
    if (!raw) continue;
    if (AI_MARKERS_RE.test(raw)) continue;
    const m = raw.match(PROMPT_LINE_RE);
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
  let lastMeaningful = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = (lines[i] || '').trim();
    if (!L) continue;
    if (PROMPT_PREFIX_RE.test(L)) continue;
    const stripped = L.replace(AI_MARKERS_RE, '').trim();
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
    //
    // Skip this path entirely when the hook server is up: onReplyCompleteFromHook
    // already drives unread+time with higher precision (fires on Stop, not on
    // 2s silence guess). Running both means every AI reply flips unread twice
    // before the signature compare idempotently kills the second. Keeping it
    // as fallback only when hook is down.
    if (!hookUp && session.lastOutputPreview) {
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
const _cursorDebounce = new Map();

ipcRenderer.on('terminal-data', (_e, { sessionId, data }) => {
  const cached = terminalCache.get(sessionId);
  if (!cached) return;
  const sess = sessions.get(sessionId);
  if (sess && sess.kind === 'codex') {
    cached.terminal.write(data);
    cached.terminal.write('\x1b[?25l');
    clearTimeout(_cursorDebounce.get(sessionId));
    _cursorDebounce.set(sessionId, setTimeout(() => {
      cached.terminal.write('\x1b[?25h');
    }, 150));
  } else {
    cached.terminal.write(data);
  }
  onTerminalOutput(sessionId, data.length);
});

// Status updates from our custom statusline script.
// Carries contextPct / cwd / api time / session_name per session + account-wide usage5h/usage7d.
const accountUsage = { usage5h: null, usage7d: null };
const agentUsage = { gemini: null, codex: null };
let _claudeUsageLastSeen = 0;
// Samples for quota burn-rate attribution. Per-session contextUsed history
// (15 min ring) → tokens/min. Global 5h samples let us estimate tokens-per-pct
// so we can project each session's burn as "% of 5h cap per hour".
const BURN_HISTORY_MS = 15 * 60 * 1000;
const globalUsageSamples = []; // [{t, pct, totalUsedTokens}]
const DEFAULT_TOKENS_PER_PCT = 2_000_000; // fallback baseline if we have no delta

function pruneSamples(arr, now) {
  const cutoff = now - BURN_HISTORY_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}

function aggregateUsedTokens(now) {
  let total = 0;
  for (const s of sessions.values()) {
    // Use each session's most recent contextUsed as a proxy. Not perfect —
    // but good enough to attribute ratably.
    if (typeof s.contextUsed === 'number') total += s.contextUsed;
  }
  return total;
}

function estimateTokensPerPct() {
  // Find two global samples far enough apart with a positive pct delta.
  for (let i = globalUsageSamples.length - 1; i >= 1; i--) {
    const a = globalUsageSamples[i];
    for (let j = i - 1; j >= 0; j--) {
      const b = globalUsageSamples[j];
      if (a.t - b.t < 60 * 1000) continue; // need ≥1 min spread
      const dp = a.pct - b.pct;
      const dt = a.totalUsedTokens - b.totalUsedTokens;
      if (dp > 0.3 && dt > 0) return dt / dp;
    }
  }
  return DEFAULT_TOKENS_PER_PCT;
}

function sessionBurnRate(session) {
  const samples = session._tokenSamples;
  if (!samples || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt < 60 * 1000) return null;
  const dTokens = last.used - first.used;
  if (dTokens <= 0) return null;
  const tokensPerMin = dTokens / (dt / 60000);
  const tokensPerPct = estimateTokensPerPct();
  const pctPerHour = (tokensPerMin * 60) / tokensPerPct;
  return { tokensPerMin, pctPerHour };
}

ipcRenderer.on('status-event', (_e, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session) {
    session.contextPct = payload.contextPct;
    session.contextUsed = payload.contextUsed;
    session.contextMax = payload.contextMax;
    if (typeof payload.contextUsed === 'number') {
      if (!session._tokenSamples) session._tokenSamples = [];
      session._tokenSamples.push({ t: Date.now(), used: payload.contextUsed });
      pruneSamples(session._tokenSamples, Date.now());
    }
    // cwd is write-once: only record it if we don't have one yet. Statusline
    // fires repeatedly and the user's `cd` during the session would otherwise
    // corrupt the saved cwd, breaking future `claude --resume` (CC scopes
    // resume to the transcript's original project slug = original cwd).
    if (payload.cwd && !session.cwd) session.cwd = payload.cwd;
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
  // Usage is account-wide — keep the latest reported values + sample for burn rate.
  if (payload.usage5h) {
    accountUsage.usage5h = payload.usage5h;
    _claudeUsageLastSeen = Date.now();
    const now = Date.now();
    globalUsageSamples.push({ t: now, pct: payload.usage5h.pct, totalUsedTokens: aggregateUsedTokens(now) });
    pruneSamples(globalUsageSamples, now);
  }
  if (payload.usage7d) accountUsage.usage7d = payload.usage7d;
  renderAccountUsage();
  renderSessionList();
});

ipcRenderer.on('agent-usage', (_e, totals) => {
  if (totals.gemini && (totals.gemini.usage5h || totals.gemini.usage7d)) agentUsage.gemini = totals.gemini;
  if (totals.codex && (totals.codex.usage5h || totals.codex.usage7d)) agentUsage.codex = totals.codex;
  renderAccountUsage();
});

// Map a model id to a CSS family class for badge coloring.
function modelClass(id) {
  if (!id) return '';
  const s = id.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('codex') || s.includes('o3') || s.includes('o4-mini')) return 'codex';
  if (s.includes('deepseek')) return 'deepseek';
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
  if (id.includes('gemini')) return id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ');
  if (id.includes('codex')) return 'Codex';
  if (id.includes('deepseek')) return 'DS';
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
    titleSection.appendChild(badge);
  }
  badge.className = 'terminal-model-badge ' + modelClass(session.currentModel.id);
  badge.textContent = session.currentModel.displayName || modelShort(session.currentModel);
  badge.title = session.currentModel.id + ' — click to switch model';
  // attach after className is set — attach uses classList.add to preserve
  attachModelPickerHandler(badge, activeSessionId);
}

// ---- Model picker dropdown ----
// Hub surfaces a short curated list of models that map to Claude Code's `/model`
// slash command. Keep this list in sync with Claude Code's supported IDs.
const MODEL_OPTIONS = [
  { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M context)' },
  { id: 'claude-opus-4-7',     label: 'Opus 4.7' },
  { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M context)' },
  { id: 'claude-opus-4-6',     label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5',    label: 'Haiku 4.5' },
];

let openModelPicker = null; // { el, badge, onDocClick } while a picker is open

function attachModelPickerHandler(badgeEl, sessionId) {
  if (!badgeEl || badgeEl._modelPickerBound) return;
  badgeEl._modelPickerBound = true;
  badgeEl.classList.add('clickable');
  badgeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openModelPicker && openModelPicker.badge === badgeEl) {
      closeModelPicker();
      return;
    }
    showModelPicker(badgeEl, sessionId);
  });
}

function showModelPicker(badgeEl, sessionId) {
  closeModelPicker();
  const session = sessions.get(sessionId);
  const currentId = session && session.currentModel ? (session.currentModel.id || '') : '';
  const menu = document.createElement('div');
  menu.className = 'model-picker-menu';
  MODEL_OPTIONS.forEach((opt) => {
    const item = document.createElement('div');
    item.className = 'model-picker-item';
    item.dataset.modelId = opt.id;
    if (opt.id === currentId) item.classList.add('current');
    item.innerHTML = `<span class="model-picker-check">${opt.id === currentId ? '\u2713' : ''}</span><span class="model-picker-label">${escapeHtml(opt.label)}</span><span class="model-picker-id">${escapeHtml(opt.id)}</span>`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      ipcRenderer.send('terminal-input', { sessionId, data: `/model ${opt.id}\r` });
      closeModelPicker();
    });
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const rect = badgeEl.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  const onDocClick = (e) => { if (!menu.contains(e.target)) closeModelPicker(); };
  // defer so the triggering click doesn't immediately close the menu
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  openModelPicker = { el: menu, badge: badgeEl, onDocClick };
}

function closeModelPicker() {
  if (!openModelPicker) return;
  document.removeEventListener('click', openModelPicker.onDocClick);
  openModelPicker.el.remove();
  openModelPicker = null;
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
  el.style.display = 'block';
  const fmtSlot = (u) => {
    if (!u) return '<span class="usage-na">—</span>';
    const pct = Math.round(u.pct);
    const reset = formatResetIn(u.resetsAt);
    return `<span class="usage-pct ${pctClass(pct)}">${pct}%</span>${reset ? '<span class="usage-reset">' + reset + '</span>' : ''}`;
  };
  const staleCls = (lastSeen) => {
    if (!lastSeen) return '';
    const age = Date.now() - lastSeen;
    if (age > 2 * 3600 * 1000) return ' usage-stale';
    if (age > 5 * 60 * 1000) return ' usage-aging';
    return '';
  };
  const staleTitle = (lastSeen) => {
    if (!lastSeen) return '';
    const age = Date.now() - lastSeen;
    if (age <= 5 * 60 * 1000) return '';
    const mins = Math.round(age / 60000);
    if (mins < 60) return ` title="数据来自 ${mins}m 前"`;
    const h = Math.floor(mins / 60);
    return ` title="数据来自 ${h}h 前"`;
  };
  const buildLine = (badgeClass, label, u5h, u7d, lastSeen) => {
    const sc = staleCls(lastSeen);
    const st = staleTitle(lastSeen);
    return `<div class="usage-line${sc}"${st}><span class="model-badge ${badgeClass} usage-badge">${label}</span><span class="usage-slot">5h ${fmtSlot(u5h)}</span><span class="usage-sep">│</span><span class="usage-slot">7d ${fmtSlot(u7d)}</span></div>`;
  };
  const g = agentUsage.gemini || {};
  const c = agentUsage.codex || {};
  el.innerHTML =
    buildLine('opus', 'Claude', accountUsage.usage5h, accountUsage.usage7d, _claudeUsageLastSeen) +
    buildLine('gemini', 'Gemini', g.usage5h, g.usage7d) +
    buildLine('codex', 'Codex', c.usage5h, c.usage7d);
}

setInterval(renderAccountUsage, 60000);

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
        // Sync lastMessageTime with the preview change. Previously time only
        // updated on Stop (via onReplyCompleteFromHook), so if Stop missed or
        // only UserPromptSubmit fired, the sidebar showed fresh text next to a
        // stale timestamp. Keep text and time in lockstep — a preview change
        // IS a message event regardless of event type.
        s.lastMessageTime = Date.now();
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
    // A new turn landed — ask minimap to rescan for any new prompt ticks.
    const cached = terminalCache.get(sessionId);
    if (cached && cached._minimap) cached._minimap.invalidate();
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
  const wasUp = hookUp;
  hookUp = up;
  renderHookStatus();
  // Hook going down: re-enable the regex-based preview/unread fallback by
  // clearing the "hook is authoritative" flag on every session. Without this
  // the previous successful hook pinned readTerminalPreview into short-circuit
  // forever — so if CC's hook plumbing broke mid-day, the sidebar would go
  // silent with no visible cause. When hook comes back, the next hook-event
  // sets the flag again on the session it touches.
  if (wasUp && !up) {
    for (const s of sessions.values()) {
      if (s._previewFromTranscript) s._previewFromTranscript = false;
    }
  }
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

  // Fallback preview from xterm buffer — only matters when hook didn't supply
  // a transcript-sourced preview (very rare). Primary preview is written by
  // the hook-event handler directly from CC's JSONL.
  readTerminalPreview(sessionId);

  // "Claude is waiting for your input" — classify the tail of the AI's output.
  const wasWaiting = !!session.isWaiting;
  const w = isWaitingForUser(extractTailLines(sessionId, 40));
  session.isWaiting = w.waiting;
  session.waitingReason = w.waiting ? w.reason : null;
  session.waitingText = w.waiting ? String(w.text || '').slice(0, 200) : null;
  const newlyWaiting = w.waiting && !wasWaiting;

  // Stop hook IS the "AI finished replying" signal — fires once per Q&A turn.
  // Bump unread when the user hasn't actually seen the message: either this
  // session isn't the active one, OR the Hub window is unfocused (user alt-
  // tabbed away). The old check `sessionId !== activeSessionId` alone missed
  // the "focus lost, active-session reply lands, user returns with no badge"
  // case — matches the intermittent "有时候不提示" report.
  session.lastMessageTime = Date.now();
  const isActive = sessionId === activeSessionId;
  const seenByUser = isActive && document.hasFocus();
  if (!seenByUser) {
    session.unreadCount = (session.unreadCount || 0) + 1;
  }
  // maybeNotify has its own focus guard (it returns early when focused) so
  // calling it unconditionally is safe — it handles system-notification policy.
  if (!isActive || newlyWaiting) maybeNotify(session);
  renderSessionList();
  schedulePersist();
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

  // Ctrl+End: jump to bottom
  if (!e.shiftKey && !e.altKey && e.key === 'End') {
    e.preventDefault();
    const c = terminalCache.get(activeSessionId);
    if (c) c.terminal.scrollToBottom();
    return;
  }
  // Ctrl+Home: jump to top
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
function openContextMenu(sessionId, x, y, isTeamRoom = false) {
  contextMenuSessionId = sessionId;
  contextMenuIsTeamRoom = isTeamRoom;
  contextMenuEl.style.display = 'block';
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const rect = contextMenuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) contextMenuEl.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) contextMenuEl.style.top = `${y - rect.height}px`;
  });
  const pinBtn = contextMenuEl.querySelector('[data-action="pin"]');
  const restartBtn = contextMenuEl.querySelector('[data-action="restart"]');
  if (isTeamRoom) {
    if (pinBtn) pinBtn.style.display = 'none';
    if (restartBtn) restartBtn.style.display = 'none';
  } else {
    if (pinBtn) pinBtn.style.display = '';
    if (restartBtn) restartBtn.style.display = '';
    const session = sessions.get(sessionId);
    if (pinBtn && session) pinBtn.textContent = session.pinned ? 'Unpin' : 'Pin to top';
  }
}

function closeContextMenu() {
  contextMenuEl.style.display = 'none';
  contextMenuSessionId = null;
  contextMenuIsTeamRoom = false;
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
    const isTeamRoom = contextMenuIsTeamRoom;
    closeContextMenu();
    if (!sid) return;

    if (isTeamRoom) {
      if (action === 'close') deleteTeamRoom(sid);
      return;
    }

    const session = sessions.get(sid);

    if (action === 'close' && meetings[sid]) {
      await ipcRenderer.invoke('close-meeting', sid);
      delete meetings[sid];
      if (activeMeetingId === sid) {
        activeMeetingId = null;
        if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel();
        if (emptyStateEl) emptyStateEl.style.display = '';
      }
      renderSessionList();
      schedulePersist();
      return;
    }

    if (!session) return;

    if (action === 'pin') {
      session.pinned = !session.pinned;
      renderSessionList();
      schedulePersist();
    } else if (action === 'restart') {
      await ipcRenderer.invoke('restart-session', sid);
    } else if (action === 'close') {
      if (session && session.status === 'dormant') {
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

if (typeof MeetingRoom !== 'undefined') {
  MeetingRoom.init(sessions, getOrCreateTerminal);
}

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
  // Sub-sessions belonging to a meeting: just add to sessions Map.
  // Don't switch panels or re-render terminals — the showAddSubMenu
  // callback in meeting-room.js handles terminal mounting.
  if (session.meetingId) {
    renderSessionList();
    return;
  }
  activeSessionId = session.id;
  activeTeamRoomId = null;
  activeMeetingId = null;
  const trp = document.getElementById('team-room-panel');
  if (trp) trp.style.display = 'none';
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  if (terminalPanelEl) terminalPanelEl.style.display = '';
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
    // Minimap holds xterm.onScroll/onRender subscriptions — must dispose before
    // terminal.dispose() so it can cleanly unhook rather than leak listeners.
    if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
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
      if (!s.meetingId && s.kind !== 'claude' && s.kind !== 'claude-resume' && s.kind !== 'gemini' && s.kind !== 'codex' && s.kind !== 'deepseek') continue;
      list.push({
        hubId: s.id,
        title: s.title,
        kind: s.kind,
        cwd: s.cwd || null,
        pinned: !!s.pinned,
        ccSessionId: s.ccSessionId || null,
        meetingId: s.meetingId || null,
        lastMessageTime: s.lastMessageTime || Date.now(),
        lastOutputPreview: s.lastOutputPreview || '',
        unreadCount: s.unreadCount || 0,
        currentModel: s.currentModel || null,
      });
    }
    const meetingList = Object.values(meetings).map(m => ({
      id: m.id, type: 'meeting', title: m.title, subSessions: m.subSessions,
      layout: m.layout, focusedSub: m.focusedSub, syncContext: m.syncContext,
      sendTarget: m.sendTarget, createdAt: m.createdAt, lastMessageTime: m.lastMessageTime,
      pinned: m.pinned || false, lastScene: m.lastScene || null,
    }));
    ipcRenderer.send('persist-sessions', list, meetingList);
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
    meetingId: dormant.meetingId || null,
    lastMessageTime: dormant.lastMessageTime,
    lastOutputPreview: dormant.lastOutputPreview,
  });
  // session-created handler will replace the dormant entry. Clear unread now.
  const s = sessions.get(hubId);
  if (s) { s.unreadCount = 0; renderSessionList(); }
}

// --- Init ---
(async () => {
  const [existing, persisted, dormantMeetings, cached] = await Promise.all([
    ipcRenderer.invoke('get-sessions'),
    ipcRenderer.invoke('get-dormant-sessions'),
    ipcRenderer.invoke('get-dormant-meetings').catch(() => null),
    ipcRenderer.invoke('get-usage-cache').catch(() => null),
  ]);

  for (const s of existing) sessions.set(s.id, s);

  if (persisted && Array.isArray(persisted.sessions)) {
    for (const meta of persisted.sessions) {
      if (sessions.has(meta.hubId)) continue;
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
        meetingId: meta.meetingId || null,
        currentModel: meta.currentModel || null,
      });
    }
  }

  if (Array.isArray(dormantMeetings)) {
    for (const m of dormantMeetings) {
      if (m.layout === 'split') m.layout = 'focus';
      meetings[m.id] = m;
    }
  }

  if (cached) {
    if (cached.claude && cached.claude.usage5h) {
      accountUsage.usage5h = cached.claude.usage5h;
      accountUsage.usage7d = cached.claude.usage7d;
      if (cached.claude.ts) _claudeUsageLastSeen = cached.claude.ts;
    }
    if (cached.gemini) agentUsage.gemini = cached.gemini;
    if (cached.codex) agentUsage.codex = cached.codex;
    renderAccountUsage();
  }

  renderSessionList();
})();

// Persist on relevant changes — listen at renderer-level for mutations that
// touch persistable fields. Debounced.
for (const ch of ['session-created', 'session-closed', 'session-updated', 'meeting-created', 'meeting-updated', 'meeting-closed']) {
  ipcRenderer.on(ch, () => schedulePersist());
}

// --- Meeting Room IPC events ---
ipcRenderer.on('meeting-created', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  renderSessionList();
});

ipcRenderer.on('meeting-updated', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  if (typeof MeetingRoom !== 'undefined') {
    MeetingRoom.updateMeetingData(meeting.id, meeting);
  }
  renderSessionList();
});

ipcRenderer.on('meeting-closed', (_e, { meetingId }) => {
  delete meetings[meetingId];
  if (activeMeetingId === meetingId) {
    activeMeetingId = null;
    if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel();
    if (emptyStateEl) emptyStateEl.style.display = '';
  }
  renderSessionList();
});

// --- Mobile Pair Dialog ---
// This file is loaded as a synchronous <script> in <body> BEFORE the
// #pair-modal element is parsed. Guard with DOMContentLoaded so all
// IDs are present when we wire up listeners.
function initMobilePair() {
  const modal = document.getElementById('pair-modal');
  if (!modal) return; // pair UI not present (dev fallback)

  const btn = document.getElementById('btn-mobile');
  const closeBtn = document.getElementById('pair-close');
  const addrList = document.getElementById('pair-addr-list');
  const addrInput = document.getElementById('pair-addr-input');
  const addrAddBtn = document.getElementById('pair-addr-add');
  const deviceNameInput = document.getElementById('pair-device-name');
  const generateBtn = document.getElementById('pair-generate');
  const qrArea = document.getElementById('pair-qr-area');
  const devicesList = document.getElementById('pair-devices');

  let addresses = [];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderAddrs() {
    addrList.innerHTML = '';
    addresses.forEach((a, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(a)}</span><button aria-label="删除">×</button>`;
      li.querySelector('button').addEventListener('click', () => {
        addresses.splice(i, 1);
        renderAddrs();
      });
      addrList.appendChild(li);
    });
  }

  async function refreshDevices() {
    const list = await ipcRenderer.invoke('mobile:list-devices');
    devicesList.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = '暂无已配对设备';
      devicesList.appendChild(li);
      return;
    }
    for (const d of list) {
      const li = document.createElement('li');
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—';
      li.innerHTML = `
        <div class="device-info">
          <span class="device-name">${escapeHtml(d.name)}</span>
          <span class="device-meta">最近连接 ${escapeHtml(seen)} · IP ${escapeHtml(d.lastIp || '—')}</span>
        </div>
        <button class="revoke-btn" data-id="${escapeHtml(d.deviceId)}">撤销</button>
      `;
      li.querySelector('.revoke-btn').addEventListener('click', async () => {
        if (!confirm(`确定撤销设备 "${d.name}"？撤销后该手机将无法连接`)) return;
        await ipcRenderer.invoke('mobile:revoke-device', d.deviceId);
        refreshDevices();
      });
      devicesList.appendChild(li);
    }
  }

  async function openModal() {
    modal.classList.remove('hidden');
    // Default addresses = LAN IPs + actual mobile port
    const [ips, port] = await Promise.all([
      ipcRenderer.invoke('mobile:get-ips'),
      ipcRenderer.invoke('mobile:get-port'),
    ]);
    addresses = ips.map(i => `${i.address}:${port}`);
    renderAddrs();
    qrArea.innerHTML = '<p class="hint">点左侧"生成"按钮</p>';
    refreshDevices();
  }

  function closeModal() { modal.classList.add('hidden'); }

  btn && btn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  addrAddBtn.addEventListener('click', () => {
    const v = addrInput.value.trim();
    if (v && !addresses.includes(v)) {
      addresses.push(v);
      addrInput.value = '';
      renderAddrs();
    }
  });
  addrInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addrAddBtn.click(); });

  generateBtn.addEventListener('click', async () => {
    if (!addresses.length) { alert('至少填一个地址'); return; }
    generateBtn.disabled = true;
    try {
      const { qrDataUrl, pairUrl } = await ipcRenderer.invoke('mobile:create-pairing', {
        addresses,
        deviceName: deviceNameInput.value.trim() || 'Phone',
      });
      qrArea.innerHTML = `<img src="${qrDataUrl}" alt="Pair QR" /><p>${escapeHtml(pairUrl)}</p>`;
    } catch (e) {
      qrArea.innerHTML = `<p style="color:#e24a4a">生成失败: ${escapeHtml(e.message || String(e))}</p>`;
    } finally {
      generateBtn.disabled = false;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobilePair);
} else {
  initMobilePair();
}

loadTeamRooms();
