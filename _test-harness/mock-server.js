// Standalone mock backend for the mobile PWA.
// Serves renderer-mobile/ statically + fakes the /api and /ws endpoints with
// fixture sessions + realistic terminal buffers. Does NOT touch the real Hub.
//
// Usage:   node _test-harness/mock-server.js [port]
// Default port is 3481 (real mobile-server uses 3470-3479).

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { SESSIONS, BUFFERS } = require('./test-data.js');

const PORT = Number(process.argv[2] || process.env.PORT || 3481);
const ROOT = path.join(__dirname, '..');

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'renderer-mobile'), { index: 'index.html', extensions: ['html'] }));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib')));
app.use('/vendor/xterm-css', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css')));

// Permissive auth — harness only
app.get('/api/ping', (_req, res) => res.json({ ok: true, harness: true, serverSelfAddrHint: `localhost:${PORT}` }));
app.get('/api/sessions', (_req, res) => res.json({ sessions: SESSIONS }));
app.get('/api/sessions/:id/buffer', (req, res) => {
  const buf = BUFFERS[req.params.id] || '';
  res.type('text/plain').send(buf);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'session-list', sessions: SESSIONS }));

  const subscribed = new Set();
  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type === 'subscribe') subscribed.add(msg.sessionId);
    if (msg.type === 'unsubscribe') subscribed.delete(msg.sessionId);
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type === 'input') {
      // Echo the input back as if the terminal printed it
      const sid = msg.sessionId;
      if (subscribed.has(sid)) {
        ws.send(JSON.stringify({ type: 'output', sessionId: sid, seq: Date.now(), data: '\r\n\x1b[36m你:\x1b[0m ' + msg.data }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'output', sessionId: sid, seq: Date.now(), data: '\r\n\x1b[36m●\x1b[0m 收到（mock 回复）\r\n\x1b[90m >\x1b[0m \r\n' }));
        }, 300);
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] mobile harness ready  http://localhost:${PORT}/`);
  console.log('[mock] bootstrap page:       http://localhost:' + PORT + '/_bootstrap');
});

// Bootstrap page that pre-populates localStorage so the PWA skips pairing.
app.get('/_bootstrap', (_req, res) => {
  res.type('html').send(`<!doctype html><html><body><script>
    localStorage.setItem('csh.token', 'mock-token-xxx');
    localStorage.setItem('csh.deviceId', 'mock-device-xxx');
    localStorage.setItem('csh.addresses', JSON.stringify(['localhost:${PORT}']));
    location.replace('/');
  </script>Bootstrapping mock PWA…</body></html>`);
});
