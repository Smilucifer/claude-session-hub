const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const auth = require('../../core/mobile-auth.js');
const { createMobileServer } = require('../../core/mobile-server.js');

const TMP = path.join(os.tmpdir(), 'csh-mobile-ws-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
auth._setStorePath(path.join(TMP, 'devices.json'));

class FakeSM extends EventEmitter {
  constructor() {
    super();
    this.sessions = [{ id: 's1', title: 'T', kind: 'claude', cwd: 'C:/', unreadCount: 0, lastMessageTime: 0, lastOutputPreview: '' }];
    this.inputLog = [];
    this.seq = 0;
  }
  listSessions() { return this.sessions; }
  getSessionBuffer() { return ''; }
  writeToSession(id, data) { this.inputLog.push({ id, data }); }
  markRead(id) { const s = this.sessions.find(x => x.id === id); if (s) s.unreadCount = 0; this.emit('session-updated', s); }
  pushOutput(id, data) { this.emit('output', { sessionId: id, seq: ++this.seq, data }); }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const sm = new FakeSM();
  const srv = await createMobileServer({ sessionManager: sm, preferredPort: 0 });
  const port = srv.port;
  const tok = auth.generateToken();
  await auth.registerDevice(tok, 'dev-ws', 'X', '127.0.0.1');

  // 1. Bad token -> HTTP 401 via unexpected-response (can't upgrade)
  const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad&deviceId=dev-ws`);
  const badStatus = await new Promise(r => badWs.on('unexpected-response', (_req, res) => r(res.statusCode)));
  assert.strictEqual(badStatus, 401, 'bad auth should get HTTP 401');

  // 2. Good token -> connects, receives session-list
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}&deviceId=dev-ws`);
  const listMsg = await new Promise(r => ws.on('message', (buf) => r(JSON.parse(buf.toString()))));
  assert.strictEqual(listMsg.type, 'session-list');
  assert.strictEqual(listMsg.sessions.length, 1);

  // 3. subscribe -> output event -> client receives
  const received = [];
  ws.on('message', (buf) => received.push(JSON.parse(buf.toString())));
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' }));
  await wait(50);
  sm.pushOutput('s1', 'hello');
  await wait(100);
  const outMsg = received.find(m => m.type === 'output');
  assert.ok(outMsg, 'should receive output');
  assert.strictEqual(outMsg.data, 'hello');

  // 4. input -> sessionManager.writeToSession called
  ws.send(JSON.stringify({ type: 'input', sessionId: 's1', data: 'hi\r' }));
  await wait(50);
  assert.strictEqual(sm.inputLog.length, 1);
  assert.strictEqual(sm.inputLog[0].data, 'hi\r');

  // 5. ping/pong
  ws.send(JSON.stringify({ type: 'ping' }));
  await wait(50);
  const pong = received.find(m => m.type === 'pong');
  assert.ok(pong, 'should receive pong');

  // 6. unknown type ignored (no crash)
  ws.send(JSON.stringify({ type: 'rogue' }));
  await wait(50);

  // 7. tool-use-preview -> permission-prompt broadcast
  sm.emit('tool-use-preview', { sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' } });
  await wait(50);
  const promptMsg = received.find(m => m.type === 'permission-prompt');
  assert.ok(promptMsg, 'should receive permission-prompt from tool-use-preview');
  assert.strictEqual(promptMsg.toolName, 'Bash');
  assert.strictEqual(promptMsg.toolInput.command, 'ls');

  ws.close();
  await srv.close();
  console.log('OK test-ws');
})().catch(e => { console.error(e); process.exit(1); });
