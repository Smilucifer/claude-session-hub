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
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Wire up session manager callbacks
sessionManager.onData = (sessionId, data) => {
  broadcast({ type: 'terminal-data', sessionId, data });
};

sessionManager.onSessionUpdated = (session) => {
  broadcast({ type: 'session-updated', session });
};

// Handle pty process exit — notify all clients
sessionManager.onSessionClosed = (sessionId) => {
  broadcast({ type: 'session-closed', sessionId });
};

// WebSocket connection handling
wss.on('connection', (ws) => {
  clients.add(ws);

  // Send current sessions list
  const sessions = sessionManager.getAllSessions();
  ws.send(JSON.stringify({ type: 'sessions', sessions } satisfies ServerMessage));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;

      switch (msg.type) {
        case 'create-session': {
          const session = sessionManager.createSession();
          broadcast({ type: 'session-created', session });
          break;
        }
        case 'close-session': {
          sessionManager.closeSession(msg.sessionId);
          broadcast({ type: 'session-closed', sessionId: msg.sessionId });
          break;
        }
        case 'terminal-input': {
          sessionManager.writeToSession(msg.sessionId, msg.data);
          break;
        }
        case 'terminal-resize': {
          sessionManager.resizeSession(msg.sessionId, msg.cols, msg.rows);
          break;
        }
        case 'focus-session': {
          sessionManager.setFocusedSession(msg.sessionId);
          sessionManager.markRead(msg.sessionId);
          break;
        }
        case 'mark-read': {
          sessionManager.markRead(msg.sessionId);
          break;
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' } satisfies ServerMessage));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Serve static files (built client) in production
const clientDist = path.resolve(__dirname, '../client');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Start server
server.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Claude Session Hub running at ${url}`);

  // Auto-open browser
  try {
    const open = (await import('open')).default;
    await open(url);
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  sessionManager.dispose();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  sessionManager.dispose();
  server.close();
  process.exit(0);
});
