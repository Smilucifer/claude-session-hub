const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./mobile-auth.js');
const protocol = require('./mobile-protocol.js');
const { createRouter } = require('./mobile-routes.js');

const PORT_RANGE = [3470, 3471, 3472, 3473, 3474, 3475, 3476, 3477, 3478, 3479];

function pickPort(preferred) {
  return new Promise((resolve, reject) => {
    const candidates = preferred === 0 ? [0] : (preferred ? [preferred, ...PORT_RANGE] : PORT_RANGE);
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) return reject(new Error('no-port-available'));
      const p = candidates[idx++];
      const s = http.createServer();
      s.once('error', () => { s.close(() => tryNext()); });
      s.listen(p, '0.0.0.0', () => {
        const actualPort = s.address().port;
        s.close(() => resolve(actualPort));
      });
    };
    tryNext();
  });
}

async function createMobileServer({ sessionManager, preferredPort = 3470 }) {
  const port = await pickPort(preferredPort);
  const app = express();
  const pwaRoot = path.join(__dirname, '..', 'renderer-mobile');
  app.use(express.static(pwaRoot, { index: 'index.html', extensions: ['html'] }));
  app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib')));
  app.use('/vendor/xterm-css', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')));
  app.use('/api', createRouter({ sessionManager, authModule: auth }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const clients = new Set();

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://dummy');
    const token = url.searchParams.get('token');
    const deviceId = url.searchParams.get('deviceId');
    const v = await auth.verifyToken(token, deviceId);
    if (!v.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    auth.touchDevice(deviceId, req.socket.remoteAddress);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { deviceId });
    });
  });

  wss.on('connection', (ws, _req, ctx) => {
    const state = { deviceId: ctx.deviceId, subscribed: new Set() };
    const entry = { ws, state };
    clients.add(entry);

    ws.send(protocol.encode({ type: 'session-list', sessions: sessionManager.listSessions() }));

    ws.on('message', (buf) => {
      const msg = protocol.decode(buf.toString());
      if (!protocol.validate(msg)) {
        ws.send(protocol.encode({ type: 'error', code: 'bad-message', message: 'invalid message shape' }));
        return;
      }
      switch (msg.type) {
        case 'subscribe':
          state.subscribed.add(msg.sessionId);
          break;
        case 'unsubscribe':
          state.subscribed.delete(msg.sessionId);
          break;
        case 'input':
          sessionManager.writeToSession(msg.sessionId, msg.data);
          break;
        case 'mark-read':
          if (typeof sessionManager.markRead === 'function') sessionManager.markRead(msg.sessionId);
          break;
        case 'ping':
          ws.send(protocol.encode({ type: 'pong' }));
          break;
      }
    });

    ws.on('close', () => {
      clients.delete(entry);
    });
  });

  const onSessionUpdated = (s) => broadcastAll({ type: 'session-updated', session: s });
  const onOutput = (evt) => broadcastToSubscribers(evt.sessionId, { type: 'output', sessionId: evt.sessionId, seq: evt.seq, data: evt.data });
  const onToolUse = (evt) => broadcastToSubscribers(evt.sessionId, { type: 'permission-prompt', sessionId: evt.sessionId, toolName: evt.toolName, toolInput: evt.toolInput });

  sessionManager.on('session-updated', onSessionUpdated);
  sessionManager.on('output', onOutput);
  sessionManager.on('tool-use-preview', onToolUse);

  function broadcastAll(msg) {
    const enc = protocol.encode(msg);
    for (const { ws } of clients) if (ws.readyState === ws.OPEN) ws.send(enc);
  }
  function broadcastToSubscribers(sessionId, msg) {
    const enc = protocol.encode(msg);
    for (const { ws, state } of clients) {
      if (ws.readyState === ws.OPEN && state.subscribed.has(sessionId)) ws.send(enc);
    }
  }

  await new Promise(r => server.listen(port, '0.0.0.0', r));

  return {
    server, app, port,
    close: () => new Promise((resolve) => {
      sessionManager.off('session-updated', onSessionUpdated);
      sessionManager.off('output', onOutput);
      sessionManager.off('tool-use-preview', onToolUse);
      for (const { ws } of clients) { try { ws.close(); } catch {} }
      wss.close();
      server.close(resolve);
    }),
  };
}

module.exports = { createMobileServer };
