const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { SessionManager } = require('./core/session-manager.js');

// Hook server picks the first free port in this range.
const HOOK_PORT_CANDIDATES = [3456, 3457, 3458, 3459, 3460];
// Random per-launch token; hook POSTs must carry it. Stops any other local
// process from forging unread bumps.
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

let hookPort = null;  // set after listen() succeeds

let mainWindow;
const sessionManager = new SessionManager();
sessionManager.hookToken = HOOK_TOKEN;  // port set after listen

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Claude Session Hub',
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

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
});

ipcMain.on('mark-read', (_e, { sessionId }) => {
  sessionManager.markRead(sessionId);
});

ipcMain.handle('rename-session', (_e, { sessionId, title }) => {
  const session = sessionManager.renameSession(sessionId, title);
  if (session) sendToRenderer('session-updated', { session });
  return session;
});

ipcMain.handle('get-sessions', () => {
  return sessionManager.getAllSessions();
});

// Restart a Claude/PowerShell session in place: close old PTY, spawn a new one
// with the same kind. The session gets a new id because PTY identity changes.
ipcMain.handle('restart-session', (_e, sessionId) => {
  const old = sessionManager.getSession(sessionId);
  if (!old) return null;
  sessionManager.closeSession(sessionId);
  sendToRenderer('session-closed', { sessionId });
  const fresh = sessionManager.createSession(old.kind);
  sendToRenderer('session-created', { session: fresh });
  return fresh;
});

// Show a Windows/OS notification. Renderer decides when to call it.
ipcMain.on('show-notification', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || 'Claude Session Hub', body: body || '', silent: false });
  n.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  n.show();
});

ipcMain.handle('is-window-focused', () => {
  return mainWindow ? mainWindow.isFocused() : false;
});

// --- Clipboard image paste support ---
const imageDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'images');

ipcMain.handle('save-clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    fs.mkdirSync(imageDir, { recursive: true });

    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // 20260412143052
    const id = crypto.randomBytes(3).toString('hex'); // a1b2c3
    const filename = `${ts}-${id}.png`;
    const filePath = path.join(imageDir, filename);

    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  } catch (e) {
    console.warn('[hub] save-clipboard-image failed:', e.message);
    return null;
  }
});

// Let renderer inspect current hook server health for UI indicator.
ipcMain.handle('get-hook-status', () => ({
  up: hookPort !== null,
  port: hookPort,
}));

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires Stop / UserPromptSubmit hooks. Forwards to renderer as IPC events.
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const isHook = req.method === 'POST' && req.url.startsWith('/api/hook/');
  const isStatus = req.method === 'POST' && req.url === '/api/status';
  if (!isHook && !isStatus) {
    res.writeHead(404); res.end('{}'); return;
  }

  // Cap body size at 16KB — statusline payloads are tiny, hooks tinier
  let body = '';
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    if (body.length + c.length > 16384) { tooBig = true; return; }
    body += c;
  });
  req.on('end', () => {
    if (tooBig) { res.writeHead(413); res.end('{}'); return; }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    if (parsed.token !== HOOK_TOKEN) {
      res.writeHead(403); res.end('{}'); return;
    }
    if (parsed.sessionId && sessionManager.getSession(parsed.sessionId)) {
      if (isHook) {
        const event = req.url.slice('/api/hook/'.length); // 'stop' or 'prompt'
        sendToRenderer('hook-event', { event, sessionId: parsed.sessionId });
      } else {
        sendToRenderer('status-event', {
          sessionId: parsed.sessionId,
          contextPct: parsed.contextPct,
          contextUsed: parsed.contextUsed,
          contextMax: parsed.contextMax,
          usage5h: parsed.usage5h,
          usage7d: parsed.usage7d,
        });
      }
    }
    res.writeHead(200); res.end('{}');
  });
});

// Try candidate ports in order; return the first that listens successfully.
// Any bind error on a candidate (EADDRINUSE, EACCES, EPERM, …) falls through
// to the next; only when all candidates fail do we give up.
function listenWithFallback() {
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= HOOK_PORT_CANDIDATES.length) return resolve(null);
      const port = HOOK_PORT_CANDIDATES[idx++];
      hookServer.removeAllListeners('error');
      hookServer.removeAllListeners('listening');
      hookServer.once('error', (e) => {
        console.warn(`[hub] hook server bind failed on :${port} (${e.code}): ${e.message}`);
        tryNext();
      });
      hookServer.once('listening', () => resolve(port));
      hookServer.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

app.whenReady().then(async () => {
  hookPort = await listenWithFallback();
  if (hookPort) {
    console.log(`[hub] hook server listening on 127.0.0.1:${hookPort}`);
    sessionManager.hookPort = hookPort;
  } else {
    console.warn('[hub] hook server failed to bind — falling back to silence detection');
  }
  createWindow();
  // Push status to renderer after window is ready
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });
    });
  }
});

app.on('window-all-closed', () => {
  hookServer.close();
  sessionManager.dispose();
  app.quit();
});
