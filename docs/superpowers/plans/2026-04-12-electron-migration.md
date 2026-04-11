# Electron Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Claude Session Hub from Browser+WebSocket to Electron+IPC, eliminating the WebSocket layer and all associated bugs (CPR leaks, port conflicts, startup hangs).

**Architecture:** Electron main process manages PTY via node-pty and exposes IPC channels. Renderer uses native DOM (no React) with xterm.js for terminal rendering. A minimal HTTP server in main process handles hook POST endpoints only.

**Tech Stack:** Electron, node-pty, xterm.js (Canvas only), native DOM, Node.js HTTP server

---

### Task 1: Project setup — package.json + electron dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install electron and update package.json**

Run:
```bash
cd C:/Users/lintian/claude-session-hub && npm install --save-dev electron@latest
```

- [ ] **Step 2: Update package.json scripts and main entry**

Replace the `scripts` and add `main` field in `package.json`:

```json
{
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dev": "electron .",
    "build:old": "npm run build:client && npm run build:server"
  }
}
```

Keep existing `build:client`, `build:server`, `dev:server`, `dev:client` scripts renamed with `:old` suffix for reference. Remove `bin` field.

- [ ] **Step 3: Update start.bat**

```bat
@echo off
cd /d "%~dp0"
electron .
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json start.bat
git commit -m "chore: add electron, update scripts and start.bat"
```

---

### Task 2: Core module — convert session-manager.ts to JS

**Files:**
- Create: `core/session-manager.js`

- [ ] **Step 1: Create core directory and convert session-manager**

Copy `src/server/session-manager.ts` to `core/session-manager.js`. Apply these transformations:
- Remove all TypeScript type annotations (`: string`, `: number`, `Record<string, string>`, etc.)
- Remove `interface` declarations, convert to JSDoc comments
- Change `import` to `require`: `const pty = require('node-pty')` and `const { v4: uuid } = require('uuid')`
- Change `export class` to `module.exports =`
- Remove `as` casts
- Keep ALL business logic identical: `stripAnsi`, `extractCJKSegments`, `hasCJK`, `isNoiseLine`, `extractCJKFromText`, `extractEnglishFromLines`, `extractPreview`, and the full `SessionManager` class

The converted file should start with:

```js
const pty = require('node-pty');
const { v4: uuid } = require('uuid');

const OUTPUT_BUFFER_MAX = 8192;
```

And end with:

```js
module.exports = { SessionManager };
```

- [ ] **Step 2: Verify it loads**

Run:
```bash
node -e "const { SessionManager } = require('./core/session-manager.js'); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add core/session-manager.js
git commit -m "feat: convert session-manager to JS module"
```

---

### Task 3: Electron main process — main.js

**Files:**
- Create: `main.js`

- [ ] **Step 1: Write main.js**

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { SessionManager } = require('./core/session-manager.js');

let mainWindow;
const sessionManager = new SessionManager();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Claude Session Hub',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- IPC handlers ---

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

sessionManager.onData = (sessionId, data) => {
  sendToRenderer('terminal-data', { sessionId, data });
};

sessionManager.onSessionClosed = (sessionId) => {
  sendToRenderer('session-closed', { sessionId });
};

ipcMain.handle('create-session', (_e, kind) => {
  const session = sessionManager.createSession(kind);
  sendToRenderer('session-created', { session });
  return session;
});

ipcMain.handle('close-session', (_e, sessionId) => {
  sessionManager.closeSession(sessionId);
  sendToRenderer('session-closed', { sessionId });
});

ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
  sessionManager.writeToSession(sessionId, data);
});

ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows }) => {
  sessionManager.resizeSession(sessionId, cols, rows);
});

ipcMain.on('focus-session', (_e, { sessionId }) => {
  sessionManager.setFocusedSession(sessionId);
  sessionManager.markRead(sessionId);
  const session = sessionManager.getSession(sessionId);
  if (session) sendToRenderer('session-updated', { session });
});

ipcMain.on('mark-read', (_e, { sessionId }) => {
  sessionManager.markRead(sessionId);
  const session = sessionManager.getSession(sessionId);
  if (session) sendToRenderer('session-updated', { session });
});

ipcMain.handle('rename-session', (_e, { sessionId, title }) => {
  const session = sessionManager.renameSession(sessionId, title);
  if (session) sendToRenderer('session-updated', { session });
  return session;
});

ipcMain.handle('get-sessions', () => {
  return sessionManager.getAllSessions();
});

// --- Hook HTTP server (for session-hub-hook.py) ---

const hookServer = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { sessionId } = JSON.parse(body);
      if (!sessionId) { res.writeHead(400); res.end('missing sessionId'); return; }

      let session;
      if (req.url === '/api/hook/stop') {
        session = sessionManager.handleStopHook(sessionId);
      } else if (req.url === '/api/hook/prompt') {
        session = sessionManager.handlePromptSubmitHook(sessionId);
      }

      if (!session) { res.writeHead(404); res.end('session not found'); return; }
      sendToRenderer('session-updated', { session });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400); res.end('invalid json');
    }
  });
});

// --- App lifecycle ---

app.whenReady().then(() => {
  hookServer.listen(3456, () => {
    console.log('Hook server on :3456');
  });
  createWindow();
});

app.on('window-all-closed', () => {
  sessionManager.dispose();
  hookServer.close();
  app.quit();
});
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "feat: electron main process with IPC + hook server"
```

---

### Task 4: Preload script — preload.js

**Files:**
- Create: `preload.js`

- [ ] **Step 1: Write preload.js**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hubAPI', {
  // Renderer -> Main (request/response)
  createSession: (kind) => ipcRenderer.invoke('create-session', kind),
  closeSession: (sessionId) => ipcRenderer.invoke('close-session', sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke('rename-session', { sessionId, title }),
  getSessions: () => ipcRenderer.invoke('get-sessions'),

  // Renderer -> Main (fire-and-forget)
  sendInput: (sessionId, data) => ipcRenderer.send('terminal-input', { sessionId, data }),
  resizeTerminal: (sessionId, cols, rows) => ipcRenderer.send('terminal-resize', { sessionId, cols, rows }),
  focusSession: (sessionId) => ipcRenderer.send('focus-session', { sessionId }),
  markRead: (sessionId) => ipcRenderer.send('mark-read', { sessionId }),

  // Main -> Renderer (events)
  onTerminalData: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('terminal-data', handler);
    return () => ipcRenderer.removeListener('terminal-data', handler);
  },
  onSessionCreated: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('session-created', handler);
    return () => ipcRenderer.removeListener('session-created', handler);
  },
  onSessionClosed: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('session-closed', handler);
    return () => ipcRenderer.removeListener('session-closed', handler);
  },
  onSessionUpdated: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('session-updated', handler);
    return () => ipcRenderer.removeListener('session-updated', handler);
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add preload.js
git commit -m "feat: preload IPC bridge via contextBridge"
```

---

### Task 5: Renderer — HTML + CSS

**Files:**
- Create: `renderer/index.html`
- Create: `renderer/styles.css`

- [ ] **Step 1: Write index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Claude Session Hub</title>
  <link rel="stylesheet" href="../node_modules/@xterm/xterm/css/xterm.css">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="app-container">
    <div class="session-sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">Sessions</span>
        <div style="display:flex;align-items:center">
          <span class="session-count" id="session-count">0 open</span>
          <div class="new-session-wrapper" id="new-session-wrapper">
            <button class="btn-new-session" id="btn-new" title="New session">+</button>
            <div class="new-session-menu" id="new-session-menu" style="display:none">
              <button class="new-session-option" data-kind="claude">Claude Code</button>
              <button class="new-session-option" data-kind="powershell">PowerShell</button>
            </div>
          </div>
        </div>
      </div>
      <div class="session-list" id="session-list"></div>
    </div>
    <div class="terminal-panel" id="terminal-panel">
      <div class="empty-state" id="empty-state">
        <div class="empty-state-icon">+</div>
        <div class="empty-state-text">No session selected</div>
        <div class="empty-state-hint">Click "+" to create a new session</div>
      </div>
    </div>
  </div>
  <script src="renderer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Copy and adapt styles.css**

Copy `src/client/styles/global.css` to `renderer/styles.css`. Changes:
- Replace `#root` with `body` in the `html, body, #root` selector
- Keep everything else identical (all CSS classes, variables, animations)

- [ ] **Step 3: Commit**

```bash
git add renderer/index.html renderer/styles.css
git commit -m "feat: renderer HTML shell + styles"
```

---

### Task 6: Renderer — renderer.js (native DOM logic)

**Files:**
- Create: `renderer/renderer.js`

- [ ] **Step 1: Write renderer.js**

This is the largest file. It replaces all React components with native DOM manipulation. Key sections:

```js
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

// --- State ---
const sessions = new Map(); // id -> session info
let activeSessionId = null;
const terminalCache = new Map(); // id -> { terminal, fitAddon, container, opened }

// --- DOM refs ---
const sessionListEl = document.getElementById('session-list');
const sessionCountEl = document.getElementById('session-count');
const terminalPanelEl = document.getElementById('terminal-panel');
const emptyStateEl = document.getElementById('empty-state');
const btnNew = document.getElementById('btn-new');
const menuEl = document.getElementById('new-session-menu');
const wrapperEl = document.getElementById('new-session-wrapper');

// --- Session list rendering ---

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

  terminal.onData((data) => { window.hubAPI.sendInput(sessionId, data); });
  terminal.onBinary((data) => { window.hubAPI.sendInput(sessionId, data); });

  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:none';

  const cached = { terminal, fitAddon, container, opened: false };
  terminalCache.set(sessionId, cached);
  return cached;
}

function showTerminal(sessionId) {
  // Hide all
  for (const [, c] of terminalCache) c.container.style.display = 'none';

  const session = sessions.get(sessionId);
  if (!session) return;

  const cached = getOrCreateTerminal(sessionId);

  // Build header
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
  statusSpan.textContent = session.status === 'running' ? '● running' : '○ idle';

  titleSection.append(titleSpan, statusSpan);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-close-session';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => window.hubAPI.closeSession(sessionId));

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
    window.hubAPI.resizeTerminal(sessionId, cached.terminal.cols, cached.terminal.rows);
    cached.terminal.focus();
  });

  // Resize observer
  if (cached._ro) cached._ro.disconnect();
  const handleResize = () => {
    cached.fitAddon.fit();
    window.hubAPI.resizeTerminal(sessionId, cached.terminal.cols, cached.terminal.rows);
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
      await window.hubAPI.renameSession(sessionId, trimmed);
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
  window.hubAPI.focusSession(id);
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
    await window.hubAPI.createSession(btn.dataset.kind);
  });
}

// --- IPC event handlers ---

window.hubAPI.onTerminalData(({ sessionId, data }) => {
  const cached = terminalCache.get(sessionId);
  if (cached) cached.terminal.write(data);
});

window.hubAPI.onSessionCreated(({ session }) => {
  sessions.set(session.id, session);
  activeSessionId = session.id;
  window.hubAPI.focusSession(session.id);
  renderSessionList();
  showTerminal(session.id);
});

window.hubAPI.onSessionClosed(({ sessionId }) => {
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

window.hubAPI.onSessionUpdated(({ session }) => {
  if (!sessions.has(session.id)) return;
  sessions.set(session.id, session);
  renderSessionList();
});

// --- Init ---

(async () => {
  const existing = await window.hubAPI.getSessions();
  for (const s of existing) sessions.set(s.id, s);
  renderSessionList();
})();
```

- [ ] **Step 2: Verify electron starts**

Run:
```bash
cd C:/Users/lintian/claude-session-hub && npx electron .
```
Expected: Window opens with Session Hub UI, sidebar visible, "+" button works.

- [ ] **Step 3: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat: native DOM renderer — session list, terminal, rename, dropdown"
```

---

### Task 7: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Start and verify basic UI**

Run: `npx electron .`

Verify:
- Window opens with dark theme
- Sidebar shows "Sessions" / "0 open" / green "+" button
- Empty state shows "No session selected"

- [ ] **Step 2: Create Claude Code session**

Click "+" → "Claude Code"
Verify:
- Session appears in sidebar as "Claude 1"
- Terminal shows PowerShell → claude auto-launch
- Claude Code starts and shows prompt
- Typing works immediately (no CPR leak)

- [ ] **Step 3: Create PowerShell session**

Click "+" → "PowerShell"
Verify:
- Session appears as "PowerShell 1"
- Full profile loads (Oh My Posh prompt visible)

- [ ] **Step 4: Test conversation + preview**

In Claude Code session, type a Chinese question and submit.
Verify:
- Response appears in terminal
- Sidebar preview updates with Chinese text after response completes
- Status changes: idle → running → idle
- Unread badge appears on non-focused sessions

- [ ] **Step 5: Test rename + close**

Click terminal title → edit inline → Enter.
Verify title updates in sidebar.

Click "Close" → verify session removed, PTY cleaned up.

- [ ] **Step 6: Commit verification checkpoint**

```bash
git add -A
git commit -m "feat: electron migration complete — all features verified"
```

---

### Task 8: Cleanup

**Files:**
- Modify: `package.json` (remove old scripts)
- Modify: `.gitignore`

- [ ] **Step 1: Clean up package.json**

Remove old `:old` script aliases. Remove unused dependencies: `express`, `ws`, `concurrently`, `tsx`, `tsup`, `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@types/*`. Keep: `electron`, `node-pty`, `uuid`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-unicode11`, `open`.

- [ ] **Step 2: Update .gitignore**

Add `dist/` (old build output, no longer needed).

- [ ] **Step 3: Remove old build files**

```bash
rm -rf dist/
```

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: remove browser-era dependencies and build artifacts"
```
