const { app, BrowserWindow, ipcMain, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { SessionManager } = require('./core/session-manager.js');

const HOOK_PORT = 3456;

let mainWindow;
const sessionManager = new SessionManager();

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

// --- Clipboard image paste support ---
const imageDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'images');

ipcMain.handle('save-clipboard-image', () => {
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
});

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires Stop / UserPromptSubmit hooks. Forwards to renderer as an IPC event.
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' || !req.url.startsWith('/api/hook/')) {
    res.writeHead(404); res.end('{}'); return;
  }
  const event = req.url.slice('/api/hook/'.length); // 'stop' or 'prompt'
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { sessionId } = JSON.parse(body || '{}');
      if (sessionId) sendToRenderer('hook-event', { event, sessionId });
    } catch {}
    res.writeHead(200); res.end('{}');
  });
});

hookServer.on('error', (e) => {
  console.warn(`[hub] hook server error on :${HOOK_PORT}:`, e.message);
});

app.whenReady().then(() => {
  hookServer.listen(HOOK_PORT, '127.0.0.1', () => {
    console.log(`[hub] hook server listening on 127.0.0.1:${HOOK_PORT}`);
  });
  createWindow();
});

app.on('window-all-closed', () => {
  hookServer.close();
  sessionManager.dispose();
  app.quit();
});
