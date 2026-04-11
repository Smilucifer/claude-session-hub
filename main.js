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
