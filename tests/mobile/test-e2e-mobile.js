const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const auth = require('../../core/mobile-auth.js');
const { createMobileServer } = require('../../core/mobile-server.js');
const { SessionManager } = require('../../core/session-manager.js');

const TMP = path.join(os.tmpdir(), 'csh-e2e-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
auth._setStorePath(path.join(TMP, 'devices.json'));

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpReq(port, pathS, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathS, method, headers }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const sm = new SessionManager();
  const srv = await createMobileServer({ sessionManager: sm, preferredPort: 0 });
  const port = srv.port;

  // 1. Register a device
  const tok = auth.generateToken();
  await auth.registerDevice(tok, 'dev-e2e', 'E2E Device', '127.0.0.1');

  // 2. Poke a fake session into sessionManager
  // SessionManager.sessions is the internal Map (we're a white-box test)
  sm.sessions.set('e2e-s1', {
    info: {
      id: 'e2e-s1', title: 'E2E Session', kind: 'claude',
      cwd: os.tmpdir(), unreadCount: 0, lastMessageTime: Date.now(),
      lastOutputPreview: 'hello from e2e',
    },
    pty: null,
    pendingTimers: new Map(),
    ringBuffer: 'previous session output\r\n',
  });

  // 3. /api/sessions shows it
  const r1 = await httpReq(port, `/api/sessions?token=${tok}&deviceId=dev-e2e`);
  assert.strictEqual(r1.status, 200);
  const j1 = JSON.parse(r1.body);
  const fake = j1.sessions.find(s => s.id === 'e2e-s1');
  assert.ok(fake, 'fake session appears in list');
  assert.strictEqual(fake.title, 'E2E Session');

  // 4. /api/sessions/:id/buffer returns ring buffer
  const r2 = await httpReq(port, `/api/sessions/e2e-s1/buffer?token=${tok}&deviceId=dev-e2e`);
  assert.strictEqual(r2.status, 200);
  assert.ok(r2.body.includes('previous session output'), 'buffer replayed');

  // 5. WS connects, receives session-list
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}&deviceId=dev-e2e&lastSeq=0`);
  const received = [];
  ws.on('message', (buf) => received.push(JSON.parse(buf.toString())));
  await new Promise(r => ws.on('open', r));
  await wait(100);
  assert.ok(received.find(m => m.type === 'session-list'), 'got session-list on connect');

  // 6. Subscribe + direct output event emission
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'e2e-s1' }));
  await wait(50);
  sm.emit('output', { sessionId: 'e2e-s1', seq: 1, data: 'hello' });
  await wait(100);
  const outMsg = received.find(m => m.type === 'output' && m.sessionId === 'e2e-s1');
  assert.ok(outMsg, 'got output frame');
  assert.strictEqual(outMsg.data, 'hello');
  assert.strictEqual(outMsg.seq, 1);

  // 7. Hook POST /api/hook/tool-use from loopback -> permission-prompt
  const r3 = await httpReq(port, '/api/hook/tool-use', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'e2e-s1', toolName: 'Bash', toolInput: { command: 'ls -la' } }),
  });
  assert.strictEqual(r3.status, 200);
  await wait(100);
  const permMsg = received.find(m => m.type === 'permission-prompt');
  assert.ok(permMsg, 'got permission-prompt after hook POST');
  assert.strictEqual(permMsg.toolName, 'Bash');
  assert.strictEqual(permMsg.toolInput.command, 'ls -la');

  // 8. Input round-trip: send input via WS
  //    SessionManager.writeToSession on a null pty silently no-ops per existing code;
  //    this test just verifies the message is accepted and doesn't crash.
  ws.send(JSON.stringify({ type: 'input', sessionId: 'e2e-s1', data: 'echo hi\r' }));
  await wait(50);
  // no assertion — just verifying no crash

  // 9. mark-read zeros unreadCount + broadcasts session-updated
  sm.sessions.get('e2e-s1').info.unreadCount = 3;
  ws.send(JSON.stringify({ type: 'mark-read', sessionId: 'e2e-s1' }));
  await wait(100);
  const updMsg = received.find(m => m.type === 'session-updated');
  assert.ok(updMsg, 'got session-updated after mark-read');
  assert.strictEqual(updMsg.session.unreadCount, 0);

  ws.close();
  await srv.close();
  console.log('OK test-e2e-mobile');
})().catch(e => { console.error(e); process.exit(1); });
