const assert = require('assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const auth = require('../../core/mobile-auth.js');
const { createMobileServer } = require('../../core/mobile-server.js');

const TMP = path.join(os.tmpdir(), 'csh-mobile-rest-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
auth._setStorePath(path.join(TMP, 'devices.json'));

const { EventEmitter } = require('events');
const fakeSM = Object.assign(new EventEmitter(), {
  listSessions: () => [{ id: 's1', title: 'Test', kind: 'claude', cwd: 'C:/', unreadCount: 0, lastMessageTime: 0, lastOutputPreview: '' }],
  getSessionBuffer: (id) => id === 's1' ? 'mock buffer' : null,
});

function req(port, pathS, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathS, method, headers }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const srv = await createMobileServer({ sessionManager: fakeSM, preferredPort: 0 });
  const port = srv.port;

  const r1 = await req(port, '/api/ping');
  assert.strictEqual(r1.status, 401, '/api/ping without token should 401');

  const tok = auth.generateToken();
  await auth.registerDevice(tok, 'dev-test', 'Test', '127.0.0.1');

  const r2 = await req(port, `/api/ping?token=${tok}&deviceId=dev-test`);
  assert.strictEqual(r2.status, 200);
  const j2 = JSON.parse(r2.body);
  assert.ok(j2.serverTime);

  const r3 = await req(port, `/api/sessions?token=${tok}&deviceId=dev-test`);
  assert.strictEqual(r3.status, 200);
  const j3 = JSON.parse(r3.body);
  assert.strictEqual(j3.sessions.length, 1);
  assert.strictEqual(j3.sessions[0].id, 's1');

  const r4 = await req(port, `/api/sessions/s1/buffer?token=${tok}&deviceId=dev-test`);
  assert.strictEqual(r4.status, 200);
  assert.ok(r4.body.includes('mock buffer'));

  const tok2 = auth.generateToken();
  const r5 = await req(port, '/api/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok2, deviceId: 'dev2', name: 'NewPhone' }),
  });
  assert.strictEqual(r5.status, 200);

  const r6 = await req(port, '/api/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok2, deviceId: 'dev-other', name: 'Other' }),
  });
  assert.strictEqual(r6.status, 409);

  // 7. /api/hook/tool-use from loopback succeeds, emits event
  let emitted = null;
  fakeSM.once('tool-use-preview', (evt) => { emitted = evt; });
  const r7 = await req(port, '/api/hook/tool-use', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' } }),
  });
  assert.strictEqual(r7.status, 200);
  assert.ok(emitted, 'should emit tool-use-preview');
  assert.strictEqual(emitted.toolName, 'Bash');

  await srv.close();
  console.log('OK test-rest');
})().catch(e => { console.error(e); process.exit(1); });
