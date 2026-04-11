import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { SessionManager } from './session-manager.js';
import type { ClientMessage, ServerMessage } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3456');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const sessionManager = new SessionManager();
const clients = new Set<WebSocket>();

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

sessionManager.onData = (sessionId, data) => {
  broadcast({ type: 'terminal-data', sessionId, data });
};

sessionManager.onSessionClosed = (sessionId) => {
  broadcast({ type: 'session-closed', sessionId });
};

// --- Hook HTTP endpoints ---

app.use(express.json());

app.post('/api/hook/stop', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) { res.status(400).json({ error: 'missing sessionId' }); return; }
  const session = sessionManager.handleStopHook(sessionId);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  broadcast({ type: 'session-updated', session });
  res.json({ ok: true });
});

app.post('/api/hook/prompt', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) { res.status(400).json({ error: 'missing sessionId' }); return; }
  const session = sessionManager.handlePromptSubmitHook(sessionId);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  broadcast({ type: 'session-updated', session });
  res.json({ ok: true });
});

// Debug: list sessions via HTTP (useful for testing)
app.get('/api/sessions', (_req, res) => {
  res.json(sessionManager.getAllSessions());
});



// --- WebSocket ---

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionManager.getAllSessions() } satisfies ServerMessage));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;

      switch (msg.type) {
        case 'create-session': {
          const session = sessionManager.createSession(msg.kind);
          broadcast({ type: 'session-created', session });
          break;
        }
        case 'close-session': {
          sessionManager.closeSession(msg.sessionId);
          broadcast({ type: 'session-closed', sessionId: msg.sessionId });
          break;
        }
        case 'terminal-input':
          sessionManager.writeToSession(msg.sessionId, msg.data);
          break;
        case 'terminal-resize':
          sessionManager.resizeSession(msg.sessionId, msg.cols, msg.rows);
          break;
        case 'focus-session': {
          sessionManager.setFocusedSession(msg.sessionId);
          sessionManager.markRead(msg.sessionId);
          const focused = sessionManager.getSession(msg.sessionId);
          if (focused) broadcast({ type: 'session-updated', session: focused });
          break;
        }
        case 'mark-read': {
          sessionManager.markRead(msg.sessionId);
          const marked = sessionManager.getSession(msg.sessionId);
          if (marked) broadcast({ type: 'session-updated', session: marked });
          break;
        }
        case 'rename-session': {
          const renamed = sessionManager.renameSession(msg.sessionId, msg.title);
          if (renamed) broadcast({ type: 'session-updated', session: renamed });
          break;
        }
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' } satisfies ServerMessage));
    }
  });

  ws.on('close', () => { clients.delete(ws); });
});

// --- Static files ---

const clientDist = path.resolve(__dirname, '../client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => { res.sendFile(path.join(clientDist, 'index.html')); });

server.listen(PORT, () => {
  console.log(`Claude Session Hub running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => { sessionManager.dispose(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { sessionManager.dispose(); server.close(); process.exit(0); });
