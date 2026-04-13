const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');  // ← note WebSocket import (Fix 3)
const auth = require('./mobile-auth.js');
const protocol = require('./mobile-protocol.js');
const { createRouter } = require('./mobile-routes.js');

const PORT_RANGE = [3470, 3471, 3472, 3473, 3474, 3475, 3476, 3477, 3478, 3479];

async function createMobileServer({ sessionManager, preferredPort = 3470 }) {
  const app = express();
  const pwaRoot = path.join(__dirname, '..', 'renderer-mobile');
  app.use(express.static(pwaRoot, { index: 'index.html', extensions: ['html'] }));
  app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib')));
  app.use('/vendor/xterm-css', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')));
  app.use('/api', createRouter({ sessionManager, authModule: auth }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  // Listen with direct-fallback, no probe race
  const candidates = preferredPort === 0
    ? [0]
    : [preferredPort, ...PORT_RANGE.filter(p => p !== preferredPort)];
  const port = await new Promise((resolve, reject) => {
    let idx = 0;
    const onError = () => {
      server.removeListener('error', onError);
      tryNext();
    };
    const tryNext = () => {
      if (idx >= candidates.length) return reject(new Error('no-port-available'));
      const p = candidates[idx++];
      server.once('error', onError);
      server.listen(p, '0.0.0.0', () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      });
    };
    tryNext();
  });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://dummy');
    const token = url.searchParams.get('token');
    const deviceId = url.searchParams.get('deviceId');
    const lastSeqStr = url.searchParams.get('lastSeq');
    const lastSeq = lastSeqStr != null ? Number(lastSeqStr) : null;
    const v = await auth.verifyToken(token, deviceId);
    if (!v.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    auth.touchDevice(deviceId, req.socket.remoteAddress);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { deviceId, lastSeq });
    });
  });

  wss.on('connection', (ws, _req, ctx) => {
    const state = { deviceId: ctx.deviceId, subscribed: new Set(), lastSeq: ctx.lastSeq };
    const entry = { ws, state };
    clients.add(entry);

    ws.send(protocol.encode({ type: 'session-list', sessions: sessionManager.listSessions() }));

    ws.on('message', (buf) => {
      const msg = protocol.decode(buf.toString());
      if (!protocol.validate(msg)) {
        safeSend(ws, protocol.encode({ type: 'error', code: 'bad-message', message: 'invalid message shape' }));
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
          safeSend(ws, protocol.encode({ type: 'pong' }));
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

  function safeSend(ws, data) {
    try { ws.send(data); } catch {}
  }
  function broadcastAll(msg) {
    const enc = protocol.encode(msg);
    for (const { ws } of clients) if (ws.readyState === WebSocket.OPEN) safeSend(ws, enc);
  }
  function broadcastToSubscribers(sessionId, msg) {
    const enc = protocol.encode(msg);
    for (const { ws, state } of clients) {
      if (ws.readyState === WebSocket.OPEN && state.subscribed.has(sessionId)) safeSend(ws, enc);
    }
  }

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
