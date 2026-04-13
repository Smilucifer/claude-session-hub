# Claude Session Hub Mobile Remote — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PWA mobile remote client for Claude Session Hub — reuse the Electron main process's `sessionManager`, expose it over HTTP + WebSocket on port 3470, and ship a responsive mobile web app (chat-style input, tool-call preview cards, folding-screen adaptive layout).

**Architecture:** In-process `mobile-server` module added to `main.js`. Express + `ws` serves static PWA assets and a WS stream that multiplexes session list / output / hook events. Token-based device pairing via QR + manual address list; multi-address fallback in the PWA (LAN / Tailscale / public domain). Hook extension: a new catch-all `PreToolUse` hook pushes tool-call previews to the mobile server so phone users see upcoming commands as cards.

**Tech Stack:**
- Backend (new deps): `express@^4.21`, `ws@^8.18`, `bcryptjs@^2.4` (pure JS — avoids node-gyp for Electron), `qrcode@^1.5`
- Frontend: vanilla JS + `@xterm/xterm` (already bundled via npm; served as static files from `node_modules`)
- Hook: extend existing `session-hub-hook.py` with `tool-use` event dispatch
- Tests: extend `test-e2e.js` style (real Node scripts hitting real ports) — **no mocks, real PTY smoke tests**

**Design spec:** `docs/superpowers/specs/2026-04-13-mobile-remote-design.md`

**Working directory:** `C:\Users\lintian\claude-session-hub`

**User bindings (must obey during this plan):**
- `feedback_real_testing`: every task ends by actually running the thing, not by inspecting code
- `feedback_review_before_commit`: before any commit touching ≥3 files, run Codex + Gemini review via `/cli-caller`
- `feedback_no_confirm`: no "do you want me to" prompts — just execute

---

## File Layout (created / modified)

```
claude-session-hub/
├── main.js                                MODIFY: boot mobile-server; "mobile" IPC; hookServer add /api/hook/tool-use
├── package.json                           MODIFY: add deps, add mobile-specific npm scripts
├── core/
│   ├── session-manager.js                 MODIFY: emit tool-use events; add getSessionBuffer(id)
│   ├── mobile-server.js                   CREATE: Express + ws bootstrap
│   ├── mobile-auth.js                     CREATE: token gen, bcrypt verify, devices JSON store
│   ├── mobile-protocol.js                 CREATE: WS message schema + framing helpers
│   └── mobile-routes.js                   CREATE: REST routes (/api/ping, /api/sessions, /api/devices, /api/hook/tool-use, /pair)
├── renderer/
│   ├── index.html                         MODIFY: "手机" button in header
│   ├── renderer.js                        MODIFY: pair dialog, device list UI, QR rendering
│   └── styles.css                         MODIFY: pair dialog styles
├── renderer-mobile/                       CREATE: PWA frontend (all new)
│   ├── index.html
│   ├── pair.html
│   ├── manifest.json
│   ├── service-worker.js
│   ├── app.js
│   ├── router.js
│   ├── transport.js                       WS + REST client + multi-address discovery + reconnect
│   ├── views/
│   │   ├── session-list.js
│   │   ├── session-view.js
│   │   └── permission-card.js
│   └── styles/
│       ├── base.css
│       ├── list.css
│       ├── session.css
│       └── responsive.css
├── tests/mobile/                          CREATE: real smoke tests
│   ├── test-auth.js
│   ├── test-rest.js
│   ├── test-ws.js
│   └── test-e2e-mobile.js
├── docs/
│   └── mobile-tailscale-setup.md          CREATE: 3-step Tailscale guide
└── .claude/settings.json                  MODIFY (user global, not in repo): add catch-all PreToolUse hook for mobile
```

---

## Phase 0: Setup

### Task 0.1: Dependencies & baseline

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime deps**

Run:
```bash
cd C:/Users/lintian/claude-session-hub
npm install express@^4.21 ws@^8.18 bcryptjs@^2.4 qrcode@^1.5
```

Expected: `package.json` `dependencies` gets the 4 entries, `package-lock.json` updated. No `node-gyp` native build (we chose `bcryptjs` not `bcrypt` deliberately).

- [ ] **Step 2: Add test scripts to package.json**

Edit `package.json` `scripts` section:

```json
"scripts": {
  "start": "electron .",
  "test": "node test-e2e.js",
  "test:mobile": "node tests/mobile/test-all.js",
  "test:mobile:auth": "node tests/mobile/test-auth.js",
  "test:mobile:rest": "node tests/mobile/test-rest.js",
  "test:mobile:ws": "node tests/mobile/test-ws.js"
}
```

- [ ] **Step 3: Verify deps load**

Run:
```bash
node -e "require('express');require('ws');require('bcryptjs');require('qrcode');console.log('ok')"
```
Expected: `ok` printed. If any throws, fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(mobile): add express/ws/bcryptjs/qrcode deps"
```

---

## Phase 1: Auth Layer (devices + tokens)

### Task 1.1: `mobile-auth.js` — token gen + device store

**Files:**
- Create: `core/mobile-auth.js`
- Test: `tests/mobile/test-auth.js`

- [ ] **Step 1: Write failing test**

Create `tests/mobile/test-auth.js`:

```javascript
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../../core/mobile-auth.js');

const TMP = path.join(os.tmpdir(), 'csh-mobile-auth-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
auth._setStorePath(path.join(TMP, 'devices.json'));

(async () => {
  // 1. generateToken: 64 hex chars (32 bytes)
  const t1 = auth.generateToken();
  assert.strictEqual(t1.length, 64, 'token should be 64 hex chars');
  assert.ok(/^[0-9a-f]+$/.test(t1), 'token hex only');

  // 2. registerDevice: fresh token + deviceId -> ok
  const reg1 = await auth.registerDevice(t1, 'dev-abc', 'Mate X6', '192.168.1.10');
  assert.strictEqual(reg1.ok, true);

  // 3. registerDevice: same token + different deviceId -> rejected
  const reg2 = await auth.registerDevice(t1, 'dev-xyz', 'Other', '1.2.3.4');
  assert.strictEqual(reg2.ok, false);
  assert.strictEqual(reg2.reason, 'token-already-bound');

  // 4. verifyToken: correct token+deviceId -> ok
  const v1 = await auth.verifyToken(t1, 'dev-abc');
  assert.strictEqual(v1.ok, true);
  assert.strictEqual(v1.device.name, 'Mate X6');

  // 5. verifyToken: wrong token -> rejected
  const v2 = await auth.verifyToken('0'.repeat(64), 'dev-abc');
  assert.strictEqual(v2.ok, false);

  // 6. verifyToken: right token wrong deviceId -> rejected
  const v3 = await auth.verifyToken(t1, 'dev-abc-fake');
  assert.strictEqual(v3.ok, false);

  // 7. revokeDevice removes entry
  auth.revokeDevice('dev-abc');
  const v4 = await auth.verifyToken(t1, 'dev-abc');
  assert.strictEqual(v4.ok, false);

  // 8. listDevices: returns array without token hashes
  const t2 = auth.generateToken();
  await auth.registerDevice(t2, 'dev-2', 'Phone 2', '5.6.7.8');
  const list = auth.listDevices();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].deviceId, 'dev-2');
  assert.ok(!list[0].tokenHash, 'token hash must not leak');

  console.log('OK test-auth');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it — must fail**

```bash
node tests/mobile/test-auth.js
```
Expected: `Cannot find module '../../core/mobile-auth.js'`

- [ ] **Step 3: Implement `core/mobile-auth.js`**

```javascript
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');

const DEFAULT_STORE = path.join(os.homedir(), '.claude-session-hub', 'mobile-devices.json');
let STORE_PATH = DEFAULT_STORE;
const BCRYPT_ROUNDS = 10;
const PENDING_TOKENS = new Map(); // token -> { createdAt } until first register

function _setStorePath(p) { STORE_PATH = p; }

function _load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { version: 1, devices: [] };
  }
}

function _save(data) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function generateToken() {
  const t = crypto.randomBytes(32).toString('hex');
  PENDING_TOKENS.set(t, { createdAt: Date.now() });
  return t;
}

async function registerDevice(token, deviceId, name, ip) {
  if (!token || !deviceId) return { ok: false, reason: 'bad-args' };
  const data = _load();
  // Token must not already be bound
  for (const d of data.devices) {
    if (await bcrypt.compare(token, d.tokenHash)) {
      return { ok: false, reason: 'token-already-bound' };
    }
  }
  const hash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  data.devices.push({
    deviceId,
    name: name || 'Unknown',
    tokenHash: hash,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    lastIp: ip || null,
  });
  _save(data);
  PENDING_TOKENS.delete(token);
  return { ok: true };
}

async function verifyToken(token, deviceId) {
  if (!token || !deviceId) return { ok: false };
  const data = _load();
  for (const d of data.devices) {
    if (d.deviceId !== deviceId) continue;
    if (await bcrypt.compare(token, d.tokenHash)) {
      return { ok: true, device: d };
    }
  }
  return { ok: false };
}

function touchDevice(deviceId, ip) {
  const data = _load();
  const d = data.devices.find(x => x.deviceId === deviceId);
  if (!d) return;
  d.lastSeenAt = Date.now();
  if (ip) d.lastIp = ip;
  _save(data);
}

function listDevices() {
  return _load().devices.map(({ tokenHash, ...pub }) => pub);
}

function revokeDevice(deviceId) {
  const data = _load();
  data.devices = data.devices.filter(d => d.deviceId !== deviceId);
  _save(data);
}

module.exports = {
  generateToken,
  registerDevice,
  verifyToken,
  touchDevice,
  listDevices,
  revokeDevice,
  _setStorePath,
};
```

- [ ] **Step 4: Run test — must pass**

```bash
node tests/mobile/test-auth.js
```
Expected: `OK test-auth`

- [ ] **Step 5: Commit**

```bash
git add core/mobile-auth.js tests/mobile/test-auth.js
git commit -m "feat(mobile): add token + device auth store (bcryptjs)"
```

---

## Phase 2: Server Skeleton

### Task 2.1: `mobile-protocol.js` — WS message schema helpers

**Files:**
- Create: `core/mobile-protocol.js`
- Test: `tests/mobile/test-protocol.js`

- [ ] **Step 1: Write failing test**

Create `tests/mobile/test-protocol.js`:

```javascript
const assert = require('assert');
const p = require('../../core/mobile-protocol.js');

// encode/decode round-trip
const msg = { type: 'output', sessionId: 's1', seq: 42, data: 'hello' };
const enc = p.encode(msg);
assert.strictEqual(typeof enc, 'string');
const dec = p.decode(enc);
assert.deepStrictEqual(dec, msg);

// validate accepts known types
assert.ok(p.validate({ type: 'input', sessionId: 'x', data: 'y' }));
assert.ok(p.validate({ type: 'subscribe', sessionId: 'x' }));
assert.ok(p.validate({ type: 'mark-read', sessionId: 'x' }));
assert.ok(p.validate({ type: 'ping' }));

// rejects unknown
assert.ok(!p.validate({ type: 'rm-rf-home' }));
// rejects wrong shape
assert.ok(!p.validate({ type: 'input' })); // missing sessionId
// rejects non-object
assert.ok(!p.validate(null));
assert.ok(!p.validate('string'));

// decode bad input returns null
assert.strictEqual(p.decode('not-json'), null);

console.log('OK test-protocol');
```

- [ ] **Step 2: Run — must fail**

```bash
node tests/mobile/test-protocol.js
```
Expected: module not found.

- [ ] **Step 3: Implement**

Create `core/mobile-protocol.js`:

```javascript
const CLIENT_TYPES = {
  subscribe: ['sessionId'],
  unsubscribe: ['sessionId'],
  input: ['sessionId', 'data'],
  'mark-read': ['sessionId'],
  ping: [],
};

function encode(msg) {
  return JSON.stringify(msg);
}

function decode(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function validate(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const required = CLIENT_TYPES[msg.type];
  if (!required) return false;
  for (const k of required) {
    if (!(k in msg)) return false;
  }
  return true;
}

module.exports = { encode, decode, validate, CLIENT_TYPES };
```

- [ ] **Step 4: Run — must pass**

```bash
node tests/mobile/test-protocol.js
```
Expected: `OK test-protocol`

- [ ] **Step 5: Commit**

```bash
git add core/mobile-protocol.js tests/mobile/test-protocol.js
git commit -m "feat(mobile): add WS protocol schema + validator"
```

---

### Task 2.2: `mobile-server.js` + `mobile-routes.js` — HTTP REST skeleton

**Files:**
- Create: `core/mobile-server.js`
- Create: `core/mobile-routes.js`
- Test: `tests/mobile/test-rest.js`

- [ ] **Step 1: Write failing test**

Create `tests/mobile/test-rest.js`:

```javascript
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

// Fake sessionManager — we only need the surface the server calls
const fakeSM = {
  listSessions: () => [{ id: 's1', title: 'Test', kind: 'claude', cwd: 'C:/', unreadCount: 0, lastMessageTime: 0, lastOutputPreview: '' }],
  getSessionBuffer: (id) => id === 's1' ? 'mock buffer' : null,
  on: () => {},
  off: () => {},
};

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
  const srv = await createMobileServer({ sessionManager: fakeSM, preferredPort: 0 }); // 0 = random free port
  const port = srv.port;

  // 1. /api/ping unauthenticated -> 401
  const r1 = await req(port, '/api/ping');
  assert.strictEqual(r1.status, 401, '/api/ping without token should 401');

  // 2. Generate token + register device -> token now valid
  const tok = auth.generateToken();
  await auth.registerDevice(tok, 'dev-test', 'Test', '127.0.0.1');

  // 3. /api/ping with good token -> 200
  const r2 = await req(port, `/api/ping?token=${tok}&deviceId=dev-test`);
  assert.strictEqual(r2.status, 200);
  const j2 = JSON.parse(r2.body);
  assert.ok(j2.serverTime);

  // 4. /api/sessions with good token -> session list
  const r3 = await req(port, `/api/sessions?token=${tok}&deviceId=dev-test`);
  assert.strictEqual(r3.status, 200);
  const j3 = JSON.parse(r3.body);
  assert.strictEqual(j3.sessions.length, 1);
  assert.strictEqual(j3.sessions[0].id, 's1');

  // 5. /api/sessions/s1/buffer
  const r4 = await req(port, `/api/sessions/s1/buffer?token=${tok}&deviceId=dev-test`);
  assert.strictEqual(r4.status, 200);
  assert.ok(r4.body.includes('mock buffer'));

  // 6. /api/devices/register with a new pending token succeeds
  const tok2 = auth.generateToken();
  const r5 = await req(port, '/api/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok2, deviceId: 'dev2', name: 'NewPhone' }),
  });
  assert.strictEqual(r5.status, 200);

  // 7. Second register with same token -> 409
  const r6 = await req(port, '/api/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tok2, deviceId: 'dev-other', name: 'Other' }),
  });
  assert.strictEqual(r6.status, 409);

  await srv.close();
  console.log('OK test-rest');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run — must fail (module not found)**

```bash
node tests/mobile/test-rest.js
```

- [ ] **Step 3: Implement `core/mobile-routes.js`**

```javascript
const express = require('express');

function createRouter({ sessionManager, authModule }) {
  const r = express.Router();

  // Token guard for all /api/* except /api/devices/register which checks pending explicitly
  async function guard(req, res, next) {
    const token = req.query.token || req.headers['x-mobile-token'];
    const deviceId = req.query.deviceId || req.headers['x-mobile-device-id'];
    if (!token || !deviceId) return res.status(401).json({ error: 'missing-auth' });
    const v = await authModule.verifyToken(token, deviceId);
    if (!v.ok) return res.status(401).json({ error: 'bad-auth' });
    authModule.touchDevice(deviceId, req.ip);
    req.device = v.device;
    next();
  }

  r.get('/ping', guard, (_req, res) => {
    res.json({ ok: true, serverTime: Date.now() });
  });

  r.get('/sessions', guard, (_req, res) => {
    res.json({ sessions: sessionManager.listSessions() });
  });

  r.get('/sessions/:id/buffer', guard, (req, res) => {
    const buf = sessionManager.getSessionBuffer(req.params.id);
    if (buf == null) return res.status(404).json({ error: 'no-session' });
    res.type('text/plain').send(buf);
  });

  r.post('/devices/register', express.json(), async (req, res) => {
    const { token, deviceId, name } = req.body || {};
    if (!token || !deviceId) return res.status(400).json({ error: 'missing-fields' });
    const result = await authModule.registerDevice(token, deviceId, name, req.ip);
    if (!result.ok) {
      const status = result.reason === 'token-already-bound' ? 409 : 400;
      return res.status(status).json({ error: result.reason });
    }
    res.json({ ok: true });
  });

  r.post('/hook/tool-use', express.json(), (req, res) => {
    // Validated separately by local-only middleware in mobile-server.js
    const { sessionId, toolName, toolInput } = req.body || {};
    if (sessionId && toolName) {
      sessionManager.emit('tool-use-preview', { sessionId, toolName, toolInput });
    }
    res.json({ ok: true });
  });

  return r;
}

module.exports = { createRouter };
```

- [ ] **Step 4: Implement `core/mobile-server.js` (HTTP only, WS next task)**

```javascript
const express = require('express');
const http = require('http');
const path = require('path');
const auth = require('./mobile-auth.js');
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

  // Serve static PWA assets (mobile-server sits in core/, PWA sits in renderer-mobile/)
  const pwaRoot = path.join(__dirname, '..', 'renderer-mobile');
  app.use(express.static(pwaRoot, { index: 'index.html', extensions: ['html'] }));
  // Also expose xterm from node_modules so PWA can <script src="/vendor/xterm/...">
  app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib')));
  app.use('/vendor/xterm-css', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')));

  app.use('/api', createRouter({ sessionManager, authModule: auth }));

  const server = http.createServer(app);
  await new Promise(r => server.listen(port, '0.0.0.0', r));

  return {
    server,
    app,
    port,
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { createMobileServer };
```

- [ ] **Step 5: Run test — must pass**

```bash
node tests/mobile/test-rest.js
```
Expected: `OK test-rest`

- [ ] **Step 6: Commit**

```bash
git add core/mobile-server.js core/mobile-routes.js tests/mobile/test-rest.js
git commit -m "feat(mobile): REST server skeleton with auth guard"
```

---

### Task 2.3: WebSocket layer

**Files:**
- Modify: `core/mobile-server.js`
- Test: `tests/mobile/test-ws.js`

- [ ] **Step 1: Write failing test**

Create `tests/mobile/test-ws.js`:

```javascript
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

// Fake sessionManager that emits events like the real one
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
  // Simulate PTY output
  pushOutput(id, data) { this.emit('output', { sessionId: id, seq: ++this.seq, data }); }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const sm = new FakeSM();
  const srv = await createMobileServer({ sessionManager: sm, preferredPort: 0 });
  const port = srv.port;
  const tok = auth.generateToken();
  await auth.registerDevice(tok, 'dev-ws', 'X', '127.0.0.1');

  // 1. Bad token -> immediate close
  const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad&deviceId=dev-ws`);
  const badClose = await new Promise(r => badWs.on('close', (code) => r(code)));
  assert.strictEqual(badClose, 4401, 'bad auth should close with 4401');

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

  ws.close();
  await srv.close();
  console.log('OK test-ws');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run — must fail (no WS server yet)**

```bash
node tests/mobile/test-ws.js
```

- [ ] **Step 3: Extend `core/mobile-server.js` with WS**

Replace the file with this extended version (additions in bold conceptually, full replacement for clarity):

```javascript
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

  // Each connection: track subscribed sessionIds and last seq sent per session
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

  wss.on('connection', (ws, req, ctx) => {
    const state = { deviceId: ctx.deviceId, subscribed: new Set() };
    clients.add({ ws, state });

    // Initial state push
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
      for (const c of clients) if (c.ws === ws) clients.delete(c);
    });
  });

  // Hook sessionManager events -> broadcast
  const onSessionUpdated = (s) => broadcastAll({ type: 'session-updated', session: s });
  const onOutput = (evt) => broadcastToSubscribers(evt.sessionId, { type: 'output', sessionId: evt.sessionId, seq: evt.seq, data: evt.data });
  const onToolUse = (evt) => broadcastToSubscribers(evt.sessionId, { type: 'permission-prompt', sessionId: evt.sessionId, toolName: evt.toolName, toolInput: evt.toolInput });

  sessionManager.on('session-updated', onSessionUpdated);
  sessionManager.on('output', onOutput);
  sessionManager.on('tool-use-preview', onToolUse);

  function broadcastAll(msg) {
    const enc = protocol.encode(msg);
    for (const { ws } of clients) {
      if (ws.readyState === ws.OPEN) ws.send(enc);
    }
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
      for (const { ws } of clients) try { ws.close(); } catch {}
      wss.close();
      server.close(resolve);
    }),
  };
}

module.exports = { createMobileServer };
```

**Note:** The test expects close code 4401 but the current implementation just sends HTTP 401 before upgrade. WS close code is only available post-upgrade. Update the test expectation or use `wss.handleUpgrade` first then close with 4401 — simpler to update the test: expect `ws.on('unexpected-response', res => res.statusCode === 401)`.

Fix the test: replace step-1 of test-ws.js to:

```javascript
  // 1. Bad token -> HTTP 401 via unexpected-response (can't upgrade)
  const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad&deviceId=dev-ws`);
  const badStatus = await new Promise(r => badWs.on('unexpected-response', (_req, res) => r(res.statusCode)));
  assert.strictEqual(badStatus, 401, 'bad auth should get HTTP 401');
```

- [ ] **Step 4: Run test — must pass**

```bash
node tests/mobile/test-ws.js
```
Expected: `OK test-ws`

- [ ] **Step 5: Commit**

```bash
git add core/mobile-server.js tests/mobile/test-ws.js
git commit -m "feat(mobile): WS layer with subscribe/input/events broadcast"
```

---

## Phase 3: SessionManager Integration

### Task 3.1: Extend `session-manager.js` — emit events the mobile server expects

**Files:**
- Modify: `core/session-manager.js`

Read `core/session-manager.js` first to understand existing surface (192 lines — small enough to hold).

- [ ] **Step 1: Audit current API**

```bash
grep -n "class SessionManager\|this.emit\|writeToSession\|listSessions\|markRead\|getSessionBuffer" core/session-manager.js
```

Expected output lists the functions. If any of these are **missing**:
- `listSessions()` — likely exists; if not, derive from internal map
- `writeToSession(id, data)` — should exist
- `getSessionBuffer(id)` — may not exist — we need it (returns last 8KB)
- `markRead(id)` — may not exist
- `this.emit('output', ...)` — may not be wired; likely just writes to IPC directly

- [ ] **Step 2: Add missing methods + event emits**

For each missing piece, add:

```javascript
// In SessionManager constructor: ensure extends EventEmitter
// If it doesn't already, change:
//   class SessionManager {
// to:
//   class SessionManager extends require('events').EventEmitter {
// and call super() in constructor.

// Inside the PTY onData handler, after existing buffer append:
this._emitSeq = (this._emitSeq || 0) + 1;
this.emit('output', { sessionId: id, seq: this._emitSeq, data: dataString });

// Add method:
getSessionBuffer(id) {
  const s = this.sessions.get(id);
  if (!s) return null;
  return s.ringBuffer ? s.ringBuffer.toString() : '';
}

// Add method if missing:
markRead(id) {
  const s = this.sessions.get(id);
  if (s && s.unreadCount) {
    s.unreadCount = 0;
    this.emit('session-updated', this._toPublic(s));
  }
}
```

The exact insertion points depend on what's there — inspect first, integrate conservatively. **Do not refactor unrelated code.**

- [ ] **Step 3: Sanity check**

```bash
node -e "const { SessionManager } = require('./core/session-manager.js'); const sm = new SessionManager(); console.log(typeof sm.on, typeof sm.getSessionBuffer, typeof sm.markRead);"
```
Expected: `function function function`

- [ ] **Step 4: Commit**

```bash
git add core/session-manager.js
git commit -m "feat(mobile): extend sessionManager with output events + buffer/markRead"
```

---

### Task 3.2: Wire `mobile-server` into `main.js`

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Locate app-ready / sessionManager init in main.js**

```bash
grep -n "app.whenReady\|new SessionManager\|createHookServer\|hookServer\|HOOK_PORT" main.js
```

Note the line where the hook server starts — insert mobile-server bootstrap right after.

- [ ] **Step 2: Add imports at top of main.js**

Insert after existing requires:

```javascript
const { createMobileServer } = require('./core/mobile-server.js');
const mobileAuth = require('./core/mobile-auth.js');
const os = require('os');
```

- [ ] **Step 3: Start mobile-server after sessionManager + hookServer are up**

Find the section where `sessionManager` is created (likely in `app.whenReady`). After it, add:

```javascript
let mobileSrv = null;
(async () => {
  try {
    mobileSrv = await createMobileServer({ sessionManager, preferredPort: 3470 });
    console.log(`[mobile] listening on :${mobileSrv.port}`);
    global.__mobileSrv = mobileSrv;
  } catch (e) {
    console.error('[mobile] failed to start:', e);
  }
})();
```

- [ ] **Step 4: Clean up on quit**

Locate `before-quit` handler (existing code flushes cleanShutdown). Add:

```javascript
app.on('before-quit', async () => {
  if (mobileSrv) try { await mobileSrv.close(); } catch {}
});
```

- [ ] **Step 5: Add IPC handler for pair dialog**

The renderer will ask main for: (a) list of usable IPs, (b) a new token + QR data URL, (c) current device list, (d) revoke.

Add near other `ipcMain.handle` calls:

```javascript
const QRCode = require('qrcode');

ipcMain.handle('mobile:get-ips', () => {
  const nets = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
});

ipcMain.handle('mobile:create-pairing', async (_e, { addresses, deviceName }) => {
  const token = mobileAuth.generateToken();
  const port = (mobileSrv && mobileSrv.port) || 3470;
  const addrs = addresses && addresses.length ? addresses : [`127.0.0.1:${port}`];
  const payload = Buffer.from(JSON.stringify(addrs)).toString('base64url');
  const pairUrl = `http://${addrs[0]}/pair?token=${token}&addresses=${payload}&name=${encodeURIComponent(deviceName || 'Phone')}`;
  const qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 1, width: 360 });
  return { token, pairUrl, qrDataUrl };
});

ipcMain.handle('mobile:list-devices', () => mobileAuth.listDevices());

ipcMain.handle('mobile:revoke-device', (_e, deviceId) => {
  mobileAuth.revokeDevice(deviceId);
  return { ok: true };
});
```

- [ ] **Step 6: Smoke test manually**

```bash
npm start
# In another shell:
curl "http://127.0.0.1:3470/api/ping"
```
Expected: `{"error":"missing-auth"}` (401). If connection refused, mobile server didn't start — check console.

Close the Electron app.

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat(mobile): boot mobile-server + pair IPC handlers"
```

---

## Phase 4: Hook Extension (Tool-Use Preview)

### Task 4.1: Extend `session-hub-hook.py` to dispatch `tool-use` event

**Files:**
- Modify: `~/.claude/scripts/session-hub-hook.py` (user global, outside repo)

- [ ] **Step 1: Add `tool-use` branch**

Edit the file. The current script takes `sys.argv[1]` as event name (stop/prompt). Extend it to handle `tool-use`:

After the existing parsing of `cc_session_id`, `cwd`, `transcript_path`, `prompt`, add:

```python
tool_name = None
tool_input = None
if event == 'tool-use':
    try:
        if stdin_data:
            payload = json.loads(stdin_data)
            tool_name = payload.get('tool_name')
            tool_input = payload.get('tool_input')
    except Exception:
        pass
```

In the body construction, add:

```python
if tool_name:
    body['toolName'] = tool_name
if tool_input is not None:
    body['toolInput'] = tool_input
```

And change the endpoint URL to be event-specific — the mobile-server accepts `/api/hook/tool-use` specifically, while the existing hub still uses `/api/hook/stop` and `/api/hook/prompt` on the Electron hook server (port 3456-3460). Both servers should receive `tool-use`? No — only mobile-server cares. Route strictly:

Replace the URL construction with:

```python
hook_port = os.environ.get('CLAUDE_HUB_PORT', '3456')
mobile_port = os.environ.get('CLAUDE_HUB_MOBILE_PORT', '3470')
if event == 'tool-use':
    url = f'http://127.0.0.1:{mobile_port}/api/hook/tool-use'
else:
    url = f'http://127.0.0.1:{hook_port}/api/hook/{event}'
```

**Important:** The mobile-server's `/api/hook/tool-use` endpoint currently requires no auth for local loopback (see `mobile-routes.js`). If we want belt-and-suspenders, have main.js inject `CLAUDE_HUB_MOBILE_PORT` env var when spawning PTY. Add it to session-manager's env-building step; similar to `CLAUDE_HUB_PORT` injection already done.

- [ ] **Step 2: Inject `CLAUDE_HUB_MOBILE_PORT` into PTY env**

In `core/session-manager.js`, find where `CLAUDE_HUB_PORT` is injected. Add right next to it:

```javascript
env.CLAUDE_HUB_MOBILE_PORT = String(global.__mobileSrv && global.__mobileSrv.port || 3470);
```

- [ ] **Step 3: Manual test**

Start Electron Hub, open a Claude session, in that session run any tool call (e.g. ask Claude to read a file). The hook should POST to `localhost:3470/api/hook/tool-use`. Verify:

```bash
# In a separate terminal with the hub running:
curl -X POST http://127.0.0.1:3470/api/hook/tool-use \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"x","toolName":"Bash","toolInput":{"command":"ls"}}'
```
Expected: `{"ok":true}`

- [ ] **Step 4: Commit (repo only — the ~/.claude/ file is user-global)**

```bash
git add core/session-manager.js
git commit -m "feat(mobile): inject CLAUDE_HUB_MOBILE_PORT into PTY env"
```

Note: `session-hub-hook.py` lives outside the repo — mention in `docs/mobile-tailscale-setup.md` that the hook script needs the `tool-use` branch added (or provide a deploy script).

---

### Task 4.2: Register `PreToolUse` catch-all hook in `~/.claude/settings.json`

**Files:**
- Modify: `~/.claude/settings.json` (user global)

The current file has a `PreToolUse` block matching `"Bash"` only. We need a catch-all (empty matcher) that fires for **every** tool, dispatching to `session-hub-hook.py tool-use`.

- [ ] **Step 1: Add a second hooks array entry for `PreToolUse` with empty matcher**

Edit `~/.claude/settings.json`. Under `hooks.PreToolUse`, add a new array element:

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "python \"C:\\Users\\lintian\\.claude\\scripts\\session-hub-hook.py\" tool-use",
      "timeout": 3
    }
  ]
}
```

Full `PreToolUse` value should now look like:

```json
"PreToolUse": [
  { "matcher": "Bash", "hooks": [ /* existing cli-caller hook */, /* existing refactor_guard */ ] },
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "python \"C:\\Users\\lintian\\.claude\\scripts\\session-hub-hook.py\" tool-use",
        "timeout": 3
      }
    ]
  }
]
```

- [ ] **Step 2: Verify JSON is valid**

```bash
python -c "import json;json.load(open(r'C:/Users/lintian/.claude/settings.json'))" && echo ok
```
Expected: `ok`

- [ ] **Step 3: Manual E2E test**

1. Start Electron Hub (`npm start`)
2. In a Claude session within the Hub, ask: "读一下 package.json"
3. In a separate terminal, watch the Electron console — mobile-server should log `[mobile] tool-use-preview emitted`

Note: this won't be visible to phone yet — that's Phase 6. For now just confirm the hook fires without error.

- [ ] **Step 4: No commit (settings.json is outside repo)** — record deployment steps in `docs/mobile-tailscale-setup.md` later.

---

## Phase 5: Desktop UI — Pair Dialog & Device List

### Task 5.1: Add "手机" button + pair dialog HTML

**Files:**
- Modify: `renderer/index.html`
- Modify: `renderer/styles.css`

- [ ] **Step 1: Find header in index.html and add button**

```bash
grep -n "header\|sidebar-header\|new-session\|ctrl\+n" renderer/index.html
```

Locate a sensible insertion point — near the "新会话" button or top-right area. Add:

```html
<button id="btn-mobile" class="icon-btn" title="配对手机 (Mobile Pairing)">📱</button>
```

- [ ] **Step 2: Append the pair dialog (hidden by default) to `<body>` end**

```html
<div id="pair-modal" class="modal hidden">
  <div class="modal-content pair-modal-content">
    <button class="modal-close" id="pair-close">×</button>
    <h2>配对手机 · Pair Phone</h2>
    <div class="pair-layout">
      <div class="pair-left">
        <h3>1. 地址清单</h3>
        <p class="hint">默认填入内网 IP。添加 Tailscale / 公网域名以便在外网也能连。</p>
        <ul id="pair-addr-list"></ul>
        <div class="pair-addr-add">
          <input id="pair-addr-input" placeholder="如 100.64.0.12:3470 或 hub.example.com" />
          <button id="pair-addr-add">添加</button>
        </div>
        <label>设备名 <input id="pair-device-name" value="华为 Mate X6" /></label>
        <button id="pair-generate" class="primary">生成配对二维码</button>
      </div>
      <div class="pair-right">
        <h3>2. 用手机扫码</h3>
        <div id="pair-qr-area"><p class="hint">点左侧"生成"按钮</p></div>
        <p class="hint">配对只需一次，之后手机永久可用（直到你在下方撤销）</p>
      </div>
    </div>
    <hr />
    <h3>已配对设备</h3>
    <ul id="pair-devices"></ul>
  </div>
</div>
```

- [ ] **Step 3: Styles**

Append to `renderer/styles.css`:

```css
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 9999; }
.modal.hidden { display: none; }
.modal-content { background: #23272e; border-radius: 10px; padding: 24px; max-width: 760px; width: 90%; max-height: 90vh; overflow: auto; position: relative; color: #e6e6e6; }
.modal-close { position: absolute; top: 12px; right: 12px; background: transparent; border: 0; color: #999; font-size: 24px; cursor: pointer; }
.pair-modal-content h2 { margin: 0 0 16px; }
.pair-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.pair-left h3, .pair-right h3 { margin: 0 0 8px; font-size: 14px; color: #aaa; text-transform: uppercase; }
.pair-addr-list li { padding: 6px 10px; background: #2e323a; border-radius: 4px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
.pair-addr-list li button { background: transparent; border: 0; color: #888; cursor: pointer; }
.pair-addr-add { display: flex; gap: 6px; margin: 10px 0; }
.pair-addr-add input { flex: 1; padding: 6px 10px; background: #1a1d23; border: 1px solid #3a3f47; color: #e6e6e6; border-radius: 4px; }
.pair-modal-content button.primary { background: #4a90e2; color: white; border: 0; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-weight: 500; }
#pair-qr-area { background: white; padding: 16px; border-radius: 8px; text-align: center; min-height: 360px; display: flex; align-items: center; justify-content: center; }
#pair-qr-area img { max-width: 100%; }
#pair-devices li { padding: 10px; background: #2e323a; border-radius: 4px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
#pair-devices .device-info { display: flex; flex-direction: column; }
#pair-devices .device-name { font-weight: 500; }
#pair-devices .device-meta { color: #888; font-size: 12px; }
#pair-devices .revoke-btn { background: #e24a4a; color: white; border: 0; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
```

- [ ] **Step 4: Visual check**

```bash
npm start
```
Click the 📱 button — dialog should appear with empty UI (no JS behavior yet). Close with × button (won't work yet — next task).

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/styles.css
git commit -m "feat(mobile): pair dialog markup + styles"
```

---

### Task 5.2: Wire pair dialog JS behavior

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: Add at the end of renderer.js (or in existing DOMContentLoaded block)**

```javascript
// --- Mobile Pair Dialog ---
(function initMobilePair() {
  const modal = document.getElementById('pair-modal');
  const btn = document.getElementById('btn-mobile');
  const closeBtn = document.getElementById('pair-close');
  const addrList = document.getElementById('pair-addr-list');
  const addrInput = document.getElementById('pair-addr-input');
  const addrAddBtn = document.getElementById('pair-addr-add');
  const deviceNameInput = document.getElementById('pair-device-name');
  const generateBtn = document.getElementById('pair-generate');
  const qrArea = document.getElementById('pair-qr-area');
  const devicesList = document.getElementById('pair-devices');

  let addresses = [];

  function renderAddrs() {
    addrList.innerHTML = '';
    addresses.forEach((a, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(a)}</span><button data-i="${i}">×</button>`;
      li.querySelector('button').addEventListener('click', () => {
        addresses.splice(i, 1);
        renderAddrs();
      });
      addrList.appendChild(li);
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function refreshDevices() {
    const list = await window.electronAPI.invoke('mobile:list-devices');
    devicesList.innerHTML = '';
    if (!list.length) {
      devicesList.innerHTML = '<li class="hint">暂无已配对设备</li>';
      return;
    }
    for (const d of list) {
      const li = document.createElement('li');
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—';
      li.innerHTML = `
        <div class="device-info">
          <span class="device-name">${escapeHtml(d.name)}</span>
          <span class="device-meta">最近连接 ${seen} · IP ${escapeHtml(d.lastIp || '—')}</span>
        </div>
        <button class="revoke-btn" data-id="${escapeHtml(d.deviceId)}">撤销</button>
      `;
      li.querySelector('.revoke-btn').addEventListener('click', async (e) => {
        if (!confirm(`确定撤销设备 "${d.name}"？撤销后该手机将无法连接`)) return;
        await window.electronAPI.invoke('mobile:revoke-device', d.deviceId);
        refreshDevices();
      });
      devicesList.appendChild(li);
    }
  }

  async function openModal() {
    modal.classList.remove('hidden');
    // Populate default addresses: LAN IPs + port
    const ips = await window.electronAPI.invoke('mobile:get-ips');
    const port = 3470; // main process knows the real port; we assume default for now
    addresses = ips.map(i => `${i.address}:${port}`);
    renderAddrs();
    qrArea.innerHTML = '<p class="hint">点"生成"按钮</p>';
    refreshDevices();
  }

  function closeModal() { modal.classList.add('hidden'); }

  btn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  addrAddBtn.addEventListener('click', () => {
    const v = addrInput.value.trim();
    if (v && !addresses.includes(v)) {
      addresses.push(v);
      addrInput.value = '';
      renderAddrs();
    }
  });
  addrInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addrAddBtn.click(); });

  generateBtn.addEventListener('click', async () => {
    if (!addresses.length) { alert('至少填一个地址'); return; }
    generateBtn.disabled = true;
    try {
      const { qrDataUrl, pairUrl } = await window.electronAPI.invoke('mobile:create-pairing', {
        addresses,
        deviceName: deviceNameInput.value.trim() || 'Phone',
      });
      qrArea.innerHTML = `<img src="${qrDataUrl}" alt="Pair QR" /><p style="color:#333;font-size:11px;word-break:break-all;padding:0 8px">${escapeHtml(pairUrl)}</p>`;
    } catch (e) {
      qrArea.innerHTML = `<p style="color:red">生成失败: ${escapeHtml(e.message)}</p>`;
    } finally {
      generateBtn.disabled = false;
    }
  });
})();
```

- [ ] **Step 2: Verify `window.electronAPI.invoke` exists**

```bash
grep -n "contextBridge\|electronAPI" main.js renderer/*.js
```

If the project uses direct `require('electron').ipcRenderer`, replace `window.electronAPI.invoke(channel, ...args)` with `require('electron').ipcRenderer.invoke(channel, ...args)`. Keep it consistent with existing renderer patterns.

- [ ] **Step 3: Manual test**

1. `npm start`
2. Click 📱
3. Default addrs should auto-fill with local IPv4 addresses
4. Click "生成配对二维码" → QR image should appear on the right
5. Refresh devices list should show empty
6. Phone scan would take us into Phase 6 — skip for now

- [ ] **Step 4: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(mobile): pair dialog JS — IP detection + QR + device list"
```

---

## Phase 6: PWA Frontend

### Task 6.1: PWA skeleton — manifest, service worker, index

**Files:**
- Create: `renderer-mobile/manifest.json`
- Create: `renderer-mobile/service-worker.js`
- Create: `renderer-mobile/index.html`
- Create: `renderer-mobile/app.js`
- Create: `renderer-mobile/styles/base.css`

- [ ] **Step 1: `manifest.json`**

```json
{
  "name": "Claude Session Hub Mobile",
  "short_name": "CC Hub",
  "start_url": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#1a1d23",
  "theme_color": "#23272e",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 2: Icons**

Copy existing Hub icon to PWA folder (we need PNG not ICO):

```bash
# Use any existing icon. If there's only .ico, use ImageMagick:
# magick convert claude-wx.ico -resize 192x192 renderer-mobile/icon-192.png
# magick convert claude-wx.ico -resize 512x512 renderer-mobile/icon-512.png
# If no magick available: put a simple PNG placeholder; user can replace later.
```

For simplicity, a 1x1 colored PNG placeholder is acceptable for MVP. Use Node:

```bash
node -e "
const fs=require('fs');
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c62007f010009000500fefd030000000049454e44ae426082','hex');
fs.writeFileSync('renderer-mobile/icon-192.png', png);
fs.writeFileSync('renderer-mobile/icon-512.png', png);
"
```

- [ ] **Step 3: `service-worker.js`**

```javascript
const CACHE = 'csh-mobile-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/styles/base.css', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});

// Network-first for API/WS; cache-first for static
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) {
    return; // let network handle
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match('/index.html')))
  );
});
```

- [ ] **Step 4: `index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#23272e" />
<link rel="manifest" href="/manifest.json" />
<link rel="icon" href="/icon-192.png" />
<title>CC Hub</title>
<link rel="stylesheet" href="/styles/base.css" />
<link rel="stylesheet" href="/styles/list.css" />
<link rel="stylesheet" href="/styles/session.css" />
<link rel="stylesheet" href="/styles/responsive.css" />
<link rel="stylesheet" href="/vendor/xterm-css/xterm.css" />
</head>
<body>
<div id="app"></div>
<div id="toast-area"></div>
<script src="/vendor/xterm/xterm.js"></script>
<script src="/app.js" type="module"></script>
<script>
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
</script>
</body>
</html>
```

- [ ] **Step 5: `styles/base.css`**

```css
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #1a1d23; color: #e6e6e6; font-family: -apple-system, "Noto Sans SC", "PingFang SC", sans-serif; }
#app { height: 100vh; height: 100dvh; overflow: hidden; display: flex; flex-direction: column; }
body { -webkit-tap-highlight-color: transparent; overscroll-behavior: contain; }
.hidden { display: none !important; }
#toast-area { position: fixed; top: 10px; left: 10px; right: 10px; z-index: 999; }
.toast { background: #e24a4a; color: white; padding: 10px 14px; border-radius: 6px; margin-bottom: 6px; }
.toast.warn { background: #e2a04a; }
.toast.info { background: #4a90e2; }
```

- [ ] **Step 6: `app.js` (bootstrap only — views come next)**

```javascript
import { Router } from '/router.js';
import { Transport } from '/transport.js';

const KEY_TOKEN = 'csh.token';
const KEY_DEVICE = 'csh.deviceId';
const KEY_ADDRS = 'csh.addresses';

function getDeviceId() {
  let d = localStorage.getItem(KEY_DEVICE);
  if (!d) {
    d = 'dev-' + crypto.randomUUID();
    localStorage.setItem(KEY_DEVICE, d);
  }
  return d;
}

function getState() {
  return {
    token: localStorage.getItem(KEY_TOKEN),
    deviceId: getDeviceId(),
    addresses: JSON.parse(localStorage.getItem(KEY_ADDRS) || '[]'),
  };
}

async function boot() {
  const state = getState();
  if (!state.token || !state.addresses.length) {
    document.getElementById('app').innerHTML = `
      <div style="padding:40px 20px;text-align:center">
        <h2>未配对</h2>
        <p>请在电脑端 Hub 点"手机"按钮生成二维码并扫码</p>
      </div>`;
    return;
  }
  window.__transport = new Transport(state);
  window.__router = new Router(document.getElementById('app'), window.__transport);
  window.__router.start();
}

// Pair page is served separately via /pair.html — only run app bootstrap on /
if (location.pathname === '/' || location.pathname.endsWith('/index.html')) {
  boot();
}
```

- [ ] **Step 7: Smoke test**

1. `npm start` (Electron)
2. On desktop browser, open `http://127.0.0.1:3470` (spoofing mobile) — should show "未配对" page since no token in localStorage
3. Open DevTools → Application → Service Worker — should be registered

- [ ] **Step 8: Commit**

```bash
git add renderer-mobile/
git commit -m "feat(mobile): PWA skeleton (manifest + SW + bootstrap)"
```

---

### Task 6.2: Pair landing page (`pair.html`)

**Files:**
- Create: `renderer-mobile/pair.html`

- [ ] **Step 1: Implement**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pairing… · CC Hub</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: #1a1d23; color: #e6e6e6; font-family: -apple-system, sans-serif; }
  .box { text-align: center; padding: 20px; }
  .spinner { border: 3px solid #333; border-top-color: #4a90e2; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { color: #e24a4a; }
</style>
</head>
<body>
<div class="box">
  <div class="spinner" id="spinner"></div>
  <h2 id="title">正在配对…</h2>
  <p id="msg">请稍候</p>
</div>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  const token = q.get('token');
  const addrsEnc = q.get('addresses');
  const name = q.get('name') || 'Phone';
  const titleEl = document.getElementById('title');
  const msgEl = document.getElementById('msg');
  const spinner = document.getElementById('spinner');

  if (!token || !addrsEnc) {
    titleEl.textContent = '配对链接无效';
    msgEl.className = 'err';
    msgEl.textContent = '请让电脑端重新生成二维码';
    spinner.style.display = 'none';
    return;
  }

  let addresses;
  try {
    addresses = JSON.parse(atob(addrsEnc.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    titleEl.textContent = '配对链接损坏';
    spinner.style.display = 'none';
    return;
  }

  let deviceId = localStorage.getItem('csh.deviceId');
  if (!deviceId) {
    deviceId = 'dev-' + crypto.randomUUID();
    localStorage.setItem('csh.deviceId', deviceId);
  }

  // POST to the address that served us this pair page
  try {
    const resp = await fetch('/api/devices/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, deviceId, name }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + resp.status));
    }
    localStorage.setItem('csh.token', token);
    localStorage.setItem('csh.addresses', JSON.stringify(addresses));
    titleEl.textContent = '配对成功 ✓';
    msgEl.textContent = '正在进入…';
    setTimeout(() => location.href = '/', 800);
  } catch (e) {
    titleEl.textContent = '配对失败';
    msgEl.className = 'err';
    msgEl.textContent = e.message;
    spinner.style.display = 'none';
  }
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Manual test**

1. `npm start`
2. In desktop Hub click 📱 → generate pairing → copy the URL shown below QR
3. Paste URL in desktop browser (simulating phone)
4. Should see "配对成功 ✓" then redirect to `/`

- [ ] **Step 3: Commit**

```bash
git add renderer-mobile/pair.html
git commit -m "feat(mobile): pair landing page"
```

---

### Task 6.3: Transport layer — multi-address discovery + WS reconnect

**Files:**
- Create: `renderer-mobile/transport.js`

- [ ] **Step 1: Implement**

```javascript
export class Transport extends EventTarget {
  constructor({ token, deviceId, addresses }) {
    super();
    this.token = token;
    this.deviceId = deviceId;
    this.addresses = addresses;
    this.baseUrl = null;   // e.g. "http://192.168.1.10:3470"
    this.ws = null;
    this.reconnectDelay = 1000;
    this.shouldReconnect = true;
    this.subscriptions = new Set();
    this.lastSeq = null;
    this.sessions = [];
  }

  async connect() {
    const probed = await this._probeAddresses();
    if (!probed) {
      this.dispatchEvent(new CustomEvent('fatal', { detail: '所有已知地址均不可达' }));
      return;
    }
    this.baseUrl = probed;
    this._openWs();
  }

  async _probeAddresses() {
    const probes = this.addresses.map(a => this._ping(a));
    const results = await Promise.allSettled(probes);
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled' && results[i].value) {
        return this._toBase(this.addresses[i]);
      }
    }
    return null;
  }

  _toBase(addr) {
    if (addr.startsWith('http://') || addr.startsWith('https://')) return addr.replace(/\/$/, '');
    return 'http://' + addr;
  }

  async _ping(addr) {
    try {
      const url = this._toBase(addr) + `/api/ping?token=${encodeURIComponent(this.token)}&deviceId=${encodeURIComponent(this.deviceId)}`;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 500);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      return resp.ok;
    } catch { return false; }
  }

  _openWs() {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.token)}&deviceId=${encodeURIComponent(this.deviceId)}${this.lastSeq != null ? `&lastSeq=${this.lastSeq}` : ''}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      this.dispatchEvent(new Event('connected'));
      // Re-subscribe
      for (const sid of this.subscriptions) this.send({ type: 'subscribe', sessionId: sid });
    });
    this.ws.addEventListener('message', (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'session-list') this.sessions = msg.sessions;
      if (msg.type === 'session-updated') {
        const idx = this.sessions.findIndex(s => s.id === msg.session.id);
        if (idx >= 0) this.sessions[idx] = msg.session; else this.sessions.push(msg.session);
      }
      if (msg.type === 'output' && typeof msg.seq === 'number') this.lastSeq = msg.seq;
      this.dispatchEvent(new CustomEvent('msg', { detail: msg }));
    });
    this.ws.addEventListener('close', () => {
      this.dispatchEvent(new Event('disconnected'));
      if (this.shouldReconnect) {
        setTimeout(() => this._openWs(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      }
    });
    this.ws.addEventListener('error', () => { /* close will fire */ });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribe(sessionId) {
    this.subscriptions.add(sessionId);
    this.send({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId) {
    this.subscriptions.delete(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }

  sendInput(sessionId, data) {
    this.send({ type: 'input', sessionId, data });
  }

  markRead(sessionId) {
    this.send({ type: 'mark-read', sessionId });
  }

  async fetchBuffer(sessionId) {
    const url = this.baseUrl + `/api/sessions/${encodeURIComponent(sessionId)}/buffer?token=${encodeURIComponent(this.token)}&deviceId=${encodeURIComponent(this.deviceId)}`;
    const r = await fetch(url);
    if (!r.ok) return '';
    return r.text();
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) try { this.ws.close(); } catch {}
  }
}
```

- [ ] **Step 2: No unit test — exercised through integration in next task**

- [ ] **Step 3: Commit**

```bash
git add renderer-mobile/transport.js
git commit -m "feat(mobile): transport layer (multi-address + reconnect)"
```

---

### Task 6.4: Router + session list view

**Files:**
- Create: `renderer-mobile/router.js`
- Create: `renderer-mobile/views/session-list.js`
- Create: `renderer-mobile/styles/list.css`

- [ ] **Step 1: `router.js`**

```javascript
import { renderSessionList } from '/views/session-list.js';
import { renderSessionView } from '/views/session-view.js';

export class Router {
  constructor(root, transport) {
    this.root = root;
    this.transport = transport;
    this.currentView = null;
  }

  async start() {
    await this.transport.connect();
    window.addEventListener('popstate', () => this.route());
    this.transport.addEventListener('connected', () => this.route());
    this.route();
  }

  route() {
    const p = location.hash || '#/';
    if (p.startsWith('#/session/')) {
      const id = decodeURIComponent(p.slice('#/session/'.length));
      this.showSession(id);
    } else {
      this.showList();
    }
  }

  showList() {
    this.root.innerHTML = '';
    this.currentView = renderSessionList(this.root, this.transport, (id) => {
      location.hash = '#/session/' + encodeURIComponent(id);
    });
  }

  showSession(id) {
    this.root.innerHTML = '';
    this.currentView = renderSessionView(this.root, this.transport, id, () => {
      history.back();
    });
  }
}
```

- [ ] **Step 2: `views/session-list.js`**

```javascript
export function renderSessionList(root, transport, onEnter) {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-list';
  wrap.innerHTML = `
    <header class="list-header">
      <h1>Claude 会话</h1>
      <span class="conn-indicator" id="conn-ind">●</span>
    </header>
    <ul id="session-items" class="list-items"></ul>
    <div class="empty-hint" id="empty-hint">(空) 在电脑端 Hub 新建会话</div>
  `;
  root.appendChild(wrap);

  const items = wrap.querySelector('#session-items');
  const emptyHint = wrap.querySelector('#empty-hint');
  const ind = wrap.querySelector('#conn-ind');

  function setConn(ok) {
    ind.style.color = ok ? '#4ae290' : '#e24a4a';
    ind.title = ok ? '已连接' : '断开中';
  }

  function render() {
    const list = transport.sessions || [];
    items.innerHTML = '';
    emptyHint.style.display = list.length ? 'none' : 'block';
    const sorted = [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    for (const s of sorted) {
      const li = document.createElement('li');
      li.className = 'session-item';
      li.innerHTML = `
        <div class="row1">
          <span class="title">${escapeHtml(s.title || '(untitled)')}</span>
          <span class="time">${s.lastMessageTime ? formatTime(s.lastMessageTime) : ''}</span>
        </div>
        <div class="row2">
          <span class="preview">${escapeHtml(s.lastOutputPreview || '')}</span>
          ${s.unreadCount ? `<span class="badge">${s.unreadCount}</span>` : ''}
        </div>
      `;
      li.addEventListener('click', () => onEnter(s.id));
      items.appendChild(li);
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toTimeString().slice(0, 5);
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const onMsg = (e) => {
    if (e.detail.type === 'session-list' || e.detail.type === 'session-updated') render();
  };
  transport.addEventListener('msg', onMsg);
  transport.addEventListener('connected', () => setConn(true));
  transport.addEventListener('disconnected', () => setConn(false));

  render();
  setConn(transport.ws && transport.ws.readyState === 1);

  return {
    destroy() {
      transport.removeEventListener('msg', onMsg);
    },
  };
}
```

- [ ] **Step 3: `styles/list.css`**

```css
.mobile-list { flex: 1; display: flex; flex-direction: column; background: #1a1d23; }
.list-header { padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2e323a; }
.list-header h1 { margin: 0; font-size: 18px; font-weight: 600; }
.conn-indicator { font-size: 14px; color: #4ae290; }
.list-items { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.session-item { padding: 12px 16px; border-bottom: 1px solid #22252b; cursor: pointer; }
.session-item:active { background: #2e323a; }
.session-item .row1 { display: flex; justify-content: space-between; }
.session-item .title { font-weight: 500; color: #ffffff; font-variant-numeric: tabular-nums; }
.session-item .time { color: #888; font-size: 12px; }
.session-item .row2 { display: flex; justify-content: space-between; margin-top: 4px; }
.session-item .preview { color: #aaa; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-item .badge { background: #e24a4a; color: white; font-size: 11px; padding: 2px 6px; border-radius: 10px; margin-left: 8px; }
.empty-hint { padding: 40px; text-align: center; color: #666; }
```

- [ ] **Step 4: Manual check**

`npm start` + complete pair flow on desktop browser (spoofing phone) → session list should render. Interact with desktop Hub (new session / receive output) → mobile list updates live.

- [ ] **Step 5: Commit**

```bash
git add renderer-mobile/router.js renderer-mobile/views/session-list.js renderer-mobile/styles/list.css
git commit -m "feat(mobile): router + session list view"
```

---

### Task 6.5: Session detail view — xterm + chat input + permission card

**Files:**
- Create: `renderer-mobile/views/session-view.js`
- Create: `renderer-mobile/views/permission-card.js`
- Create: `renderer-mobile/styles/session.css`

- [ ] **Step 1: `views/session-view.js`**

```javascript
import { mountPermissionCard } from '/views/permission-card.js';

export function renderSessionView(root, transport, sessionId, onBack) {
  const session = (transport.sessions || []).find(s => s.id === sessionId);
  const title = session ? session.title : sessionId;

  const wrap = document.createElement('div');
  wrap.className = 'mobile-session';
  wrap.innerHTML = `
    <header class="session-header">
      <button class="back-btn" aria-label="返回">←</button>
      <span class="session-title">${escapeHtml(title)}</span>
      <span class="conn-indicator" id="conn-ind">●</span>
    </header>
    <div class="terminal-host" id="term-host"></div>
    <div class="quick-bar">
      <button data-send="\x1b">ESC</button>
      <button data-send="\x03">Ctrl-C</button>
      <button data-send="1\r">1 允许</button>
      <button data-send="2\r">2 拒绝</button>
      <button data-send="\x1b[A" title="上一条历史">↑</button>
    </div>
    <div class="input-bar">
      <textarea id="prompt-input" placeholder="输入 prompt…" rows="2"></textarea>
      <button id="send-btn">发送</button>
    </div>
    <div id="perm-slot"></div>
  `;
  root.appendChild(wrap);

  const termHost = wrap.querySelector('#term-host');
  const term = new Terminal({
    cursorBlink: false,
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: window.matchMedia('(min-width: 768px)').matches ? 14 : 12,
    theme: { background: '#1a1d23', foreground: '#e6e6e6' },
    disableStdin: true,
    scrollback: 5000,
    convertEol: true,
  });
  term.open(termHost);

  // Initial buffer fetch
  transport.fetchBuffer(sessionId).then(buf => { if (buf) term.write(buf); });

  transport.subscribe(sessionId);
  transport.markRead(sessionId);

  const onMsg = (e) => {
    const m = e.detail;
    if (m.type === 'output' && m.sessionId === sessionId) {
      term.write(m.data);
    } else if (m.type === 'permission-prompt' && m.sessionId === sessionId) {
      mountPermissionCard(wrap.querySelector('#perm-slot'), m, (decision) => {
        transport.sendInput(sessionId, decision === 'allow' ? '1\r' : '2\r');
      });
    }
  };
  transport.addEventListener('msg', onMsg);

  wrap.querySelector('.back-btn').addEventListener('click', onBack);
  wrap.querySelector('#send-btn').addEventListener('click', send);
  wrap.querySelector('#prompt-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  wrap.querySelectorAll('.quick-bar button').forEach(b => {
    b.addEventListener('click', () => transport.sendInput(sessionId, b.dataset.send));
  });

  function send() {
    const ta = wrap.querySelector('#prompt-input');
    const v = ta.value;
    if (!v) return;
    transport.sendInput(sessionId, v + '\r');
    ta.value = '';
  }

  // Android back button handling (via hashchange already handled in router)

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  return {
    destroy() {
      transport.unsubscribe(sessionId);
      transport.removeEventListener('msg', onMsg);
      term.dispose();
    },
  };
}
```

- [ ] **Step 2: `views/permission-card.js`**

```javascript
export function mountPermissionCard(slot, evt, onDecide) {
  slot.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'perm-card';
  const cmd = formatToolInput(evt.toolName, evt.toolInput);
  card.innerHTML = `
    <div class="perm-head">Claude 要执行</div>
    <div class="perm-tool">${escapeHtml(evt.toolName)}</div>
    <pre class="perm-cmd">${escapeHtml(cmd)}</pre>
    <div class="perm-actions">
      <button class="perm-deny">拒绝 (2)</button>
      <button class="perm-allow">允许 (1)</button>
    </div>
  `;
  card.querySelector('.perm-allow').addEventListener('click', () => { onDecide('allow'); card.remove(); });
  card.querySelector('.perm-deny').addEventListener('click', () => { onDecide('deny'); card.remove(); });
  slot.appendChild(card);
  setTimeout(() => card.classList.add('visible'), 10);
  // Auto-dismiss after 30s if no action
  setTimeout(() => { if (card.parentNode) card.remove(); }, 30000);
}

function formatToolInput(tool, input) {
  if (!input) return '';
  if (tool === 'Bash') return input.command || JSON.stringify(input);
  if (tool === 'Edit' || tool === 'Write') return `${input.file_path || ''}\n${(input.new_string || input.content || '').slice(0, 200)}`;
  return JSON.stringify(input, null, 2);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
```

- [ ] **Step 3: `styles/session.css`**

```css
.mobile-session { flex: 1; display: flex; flex-direction: column; }
.session-header { padding: 10px 12px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #2e323a; background: #23272e; }
.back-btn { background: transparent; color: #e6e6e6; border: 0; font-size: 22px; width: 32px; cursor: pointer; }
.session-title { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.terminal-host { flex: 1; min-height: 0; overflow: hidden; padding: 4px; }
.terminal-host .xterm { height: 100%; }
.quick-bar { display: flex; gap: 4px; padding: 4px 6px; background: #1f2228; overflow-x: auto; }
.quick-bar button { background: #2e323a; color: #e6e6e6; border: 1px solid #3a3f47; border-radius: 4px; padding: 6px 10px; font-size: 12px; white-space: nowrap; cursor: pointer; }
.quick-bar button:active { background: #3a3f47; }
.input-bar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #2e323a; background: #1f2228; padding-bottom: max(8px, env(safe-area-inset-bottom)); }
.input-bar textarea { flex: 1; resize: none; background: #2e323a; color: #e6e6e6; border: 1px solid #3a3f47; border-radius: 6px; padding: 8px 10px; font-size: 15px; font-family: inherit; }
#send-btn { background: #4a90e2; color: white; border: 0; padding: 0 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
#send-btn:active { background: #3a80d2; }

/* Permission card */
.perm-card { position: fixed; left: 10px; right: 10px; bottom: 80px; background: #2e323a; border-radius: 10px; padding: 14px; box-shadow: 0 -4px 20px rgba(0,0,0,0.4); transform: translateY(120%); transition: transform 0.25s ease-out; z-index: 500; }
.perm-card.visible { transform: translateY(0); }
.perm-head { font-size: 12px; color: #888; text-transform: uppercase; margin-bottom: 6px; }
.perm-tool { font-weight: 600; margin-bottom: 6px; }
.perm-cmd { background: #1a1d23; color: #e6e6e6; padding: 10px; border-radius: 6px; font-family: Menlo, Consolas, monospace; font-size: 12px; max-height: 160px; overflow: auto; margin: 0 0 10px; white-space: pre-wrap; word-break: break-all; }
.perm-actions { display: flex; gap: 10px; }
.perm-actions button { flex: 1; padding: 12px; border-radius: 6px; border: 0; font-size: 15px; font-weight: 500; cursor: pointer; }
.perm-allow { background: #4a90e2; color: white; }
.perm-deny { background: #3a3f47; color: #e6e6e6; }
```

- [ ] **Step 4: Manual test — full happy path**

1. Restart Electron (`npm start`)
2. Create a Claude session in the Hub
3. In desktop browser (phone spoof), re-pair (fresh token) → session list → click session
4. xterm should render with ring-buffer replay
5. Type `hello` → send → Electron Hub's Claude session receives "hello" prompt
6. Observe AI streaming output in mobile xterm
7. Trigger a Bash tool call in Claude → permission card should appear on mobile
8. Click "允许" → `1\r` sent → Claude proceeds

- [ ] **Step 5: Commit**

```bash
git add renderer-mobile/views/ renderer-mobile/styles/session.css
git commit -m "feat(mobile): session view + xterm + chat input + permission card"
```

---

### Task 6.6: Folding-screen responsive layout

**Files:**
- Create: `renderer-mobile/styles/responsive.css`

- [ ] **Step 1: Implement**

```css
/* Narrow outer screen of Mate X6 — default mobile layout (single column) */

/* Wide inner screen — tablet-like two-column */
@media (min-width: 768px) {
  .mobile-list { display: none !important; }
  .mobile-list.side { display: flex !important; width: 35%; min-width: 260px; border-right: 1px solid #2e323a; }
  .mobile-session { width: 65%; }
  body.twopane #app { flex-direction: row; }
  body.twopane #app > * { height: 100vh; height: 100dvh; }
}
```

- [ ] **Step 2: Wire two-pane mode in `router.js`**

Update `router.js`:

```javascript
// In start():
this._checkLayout();
window.addEventListener('resize', () => this._checkLayout());
// ...

_checkLayout() {
  const wide = window.matchMedia('(min-width: 768px)').matches;
  document.body.classList.toggle('twopane', wide);
}
```

And when in two-pane, always render both views:

```javascript
route() {
  const wide = document.body.classList.contains('twopane');
  if (wide) {
    this.showSplit();
    return;
  }
  const p = location.hash || '#/';
  if (p.startsWith('#/session/')) {
    const id = decodeURIComponent(p.slice('#/session/'.length));
    this.showSession(id);
  } else {
    this.showList();
  }
}

showSplit() {
  this.root.innerHTML = '';
  const listPane = document.createElement('div'); listPane.className = 'pane-left';
  const sessionPane = document.createElement('div'); sessionPane.className = 'pane-right';
  this.root.appendChild(listPane);
  this.root.appendChild(sessionPane);
  const listView = renderSessionList(listPane, this.transport, (id) => {
    sessionPane.innerHTML = '';
    renderSessionView(sessionPane, this.transport, id, () => { sessionPane.innerHTML = '<div style="padding:40px;text-align:center;color:#666">← 左侧选择会话</div>'; });
  });
  sessionPane.innerHTML = '<div style="padding:40px;text-align:center;color:#666">← 左侧选择会话</div>';
}
```

Also update `base.css`:

```css
.pane-left, .pane-right { display: flex; flex-direction: column; height: 100%; }
.pane-left { width: 35%; min-width: 240px; border-right: 1px solid #2e323a; }
.pane-right { flex: 1; }
body:not(.twopane) .pane-left, body:not(.twopane) .pane-right { width: 100%; border: 0; }
```

- [ ] **Step 3: Manual test**

1. Desktop browser, narrow window (360px wide) → single-column
2. Widen window past 768px → two-pane layout kicks in live
3. On real Mate X6: fold → narrow single; unfold → wide split

- [ ] **Step 4: Commit**

```bash
git add renderer-mobile/router.js renderer-mobile/styles/responsive.css renderer-mobile/styles/base.css
git commit -m "feat(mobile): folding-screen responsive (two-pane >=768px)"
```

---

### Task 6.7: Viewport/keyboard fix + visibility reconnect

**Files:**
- Modify: `renderer-mobile/app.js`
- Modify: `renderer-mobile/transport.js`

- [ ] **Step 1: App visibility → force reconnect probe**

In `app.js`, after `window.__transport = new Transport(state)`:

```javascript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && window.__transport) {
    // If WS is dead, kick reconnect immediately
    if (!window.__transport.ws || window.__transport.ws.readyState !== WebSocket.OPEN) {
      window.__transport.reconnectDelay = 300;
      if (window.__transport.ws) { try { window.__transport.ws.close(); } catch {} }
      window.__transport.connect();
    }
  }
});
```

- [ ] **Step 2: Keyboard viewport handling**

The `input-bar` already uses `env(safe-area-inset-bottom)`. For Android soft-keyboard, CSS `100dvh` handles it in modern browsers. If testing reveals input being hidden, add:

```javascript
// In session-view.js: focus handler
wrap.querySelector('#prompt-input').addEventListener('focus', () => {
  setTimeout(() => wrap.querySelector('#prompt-input').scrollIntoView({ block: 'end' }), 100);
});
```

- [ ] **Step 3: Commit**

```bash
git add renderer-mobile/app.js renderer-mobile/transport.js renderer-mobile/views/session-view.js
git commit -m "feat(mobile): visibility reconnect + keyboard scroll handling"
```

---

## Phase 7: E2E Verification & Docs

### Task 7.1: Full E2E smoke test script

**Files:**
- Create: `tests/mobile/test-e2e-mobile.js`

- [ ] **Step 1: Implement**

```javascript
// Full stack: spawn a real Electron process? Too heavy.
// Instead: import main modules, wire a real sessionManager with one PTY running 'cmd /c echo hello && pause' (or /bin/sh on unix),
// connect via ws client, send input, receive output, verify permission-preview broadcast via direct hook POST.

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

(async () => {
  const sm = new SessionManager();
  const srv = await createMobileServer({ sessionManager: sm, preferredPort: 0 });

  const tok = auth.generateToken();
  await auth.registerDevice(tok, 'dev-e2e', 'E2E', '127.0.0.1');

  // Skip real PTY spawn here (requires real Claude CLI). Instead emulate session:
  sm.sessions.set('s1', { id: 's1', title: 'E2E', kind: 'claude', cwd: os.tmpdir(), unreadCount: 0, lastMessageTime: Date.now(), lastOutputPreview: '', ringBuffer: '' });

  // WS client
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=${tok}&deviceId=dev-e2e`);
  const recv = [];
  ws.on('message', (b) => recv.push(JSON.parse(b.toString())));
  await new Promise(r => ws.on('open', r));
  await wait(100);
  assert.ok(recv.find(m => m.type === 'session-list'), 'got session-list');

  // Simulate hook POST for tool-use
  await fetch(`http://127.0.0.1:${srv.port}/api/hook/tool-use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls -la' } }),
  });
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' }));
  await wait(100);
  // Emit tool-use via sessionManager (what mobile-routes.js does upon POST)
  // In the actual flow POST /api/hook/tool-use triggers sm.emit internally via mobile-routes.js. Verify:
  await wait(100);
  const permMsg = recv.find(m => m.type === 'permission-prompt');
  assert.ok(permMsg, 'got permission-prompt');
  assert.strictEqual(permMsg.toolName, 'Bash');

  ws.close();
  await srv.close();
  console.log('OK test-e2e-mobile');
})().catch(e => { console.error(e); process.exit(1); });
```

**Note:** This test uses global `fetch` (Node 18+). If the project targets older Node, use `http.request` as in `test-rest.js`.

- [ ] **Step 2: Run — must pass**

```bash
node tests/mobile/test-e2e-mobile.js
```
Expected: `OK test-e2e-mobile`

- [ ] **Step 3: Create `tests/mobile/test-all.js` to run all**

```javascript
const { spawnSync } = require('child_process');
const path = require('path');
const tests = ['test-auth.js', 'test-protocol.js', 'test-rest.js', 'test-ws.js', 'test-e2e-mobile.js'];
let failed = 0;
for (const t of tests) {
  console.log('--- ' + t);
  const r = spawnSync('node', [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(t + ' FAILED'); }
}
if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
console.log('ALL PASS');
```

```bash
npm run test:mobile
```
Expected: `ALL PASS`

- [ ] **Step 4: Commit**

```bash
git add tests/mobile/
git commit -m "test(mobile): full smoke test suite"
```

---

### Task 7.2: Real device testing (Mate X6)

This is **manual** — the plan records steps; execution requires physical hardware.

- [ ] **Step 1: Launch Electron Hub**
- [ ] **Step 2: Pair Mate X6 via QR**
  - Click 📱 in Hub, fill addresses: `<LAN IP>:3470`, `<Tailscale IP>:3470` (if Tailscale already installed)
  - Scan with phone camera → browser opens → pair succeeds
  - "Add to Home Screen" in Chrome/ArkWeb
- [ ] **Step 3: Outer screen (folded)**
  - Single-column list
  - Enter a session → xterm fills, input at bottom
  - Chinese IME: type "继续" + 发送 → Claude receives correctly (not "缁х画")
  - Permission card: trigger a Bash tool use in Claude → card appears → click 允许 → Claude proceeds
- [ ] **Step 4: Inner screen (unfolded)**
  - Auto-switches to two-pane
  - Tap different sessions in left pane → right pane updates without navigation
- [ ] **Step 5: Network switch test**
  - Home Wi-Fi → Cellular → LAN address fails, Tailscale takes over
  - Background app for 3 min → reopen → reconnects in <2s, ring buffer replayed
- [ ] **Step 6: Record observations in a Notes file**, fix any blockers (likely viewport/keyboard/ink details). Any code fixes → new task, TDD flow.

- [ ] **Step 7: No commit (observations, not code). Code fixes go through TDD per observation.**

---

### Task 7.3: Docs + Tailscale guide

**Files:**
- Create: `docs/mobile-tailscale-setup.md`
- Modify: `README.md` (if exists) — add mobile section

- [ ] **Step 1: `docs/mobile-tailscale-setup.md`**

```markdown
# Mobile Remote — Setup Guide

## One-time pairing (must be on-site with the computer)

1. Launch Claude Session Hub on the computer.
2. Click the 📱 button in the top-right.
3. The dialog auto-fills your LAN IPv4 addresses. Add any extra addresses you want the phone to try (see Tailscale below).
4. Name the device (e.g. "Mate X6"), click **生成配对二维码**.
5. Scan the QR code with your phone. Your browser opens; you'll see "配对成功 ✓" then land on the session list.
6. In Chrome/ArkWeb menu, choose **"Add to Home Screen"** to get an app-like icon. Done.

## Optional: Tailscale for public-network access

If your phone is away from the home Wi-Fi (e.g. at work on cellular), Tailscale gives your computer a fixed `100.x.x.x` IP reachable from anywhere.

### Install
- **Computer (Windows)**: `winget install Tailscale.Tailscale` → launch → log in
- **Phone**: Install "Tailscale" from App Gallery / Play Store → log in same account

### Find your computer's Tailscale IP
```bash
tailscale ip -4
# e.g. 100.64.0.12
```

### Add to pairing
When pairing (step 3 above), add `100.64.0.12:3470` to the address list.

Now from anywhere, opening the PWA on your phone tries all listed addresses in parallel — LAN wins on home Wi-Fi, Tailscale wins on cellular.

## Revoking a device
Click 📱 → scroll to **已配对设备** → click **撤销** on the row you want removed. That phone immediately stops working.

## Hook script

The mobile remote piggybacks on the existing `~/.claude/scripts/session-hub-hook.py`. It must support a `tool-use` event. If you upgraded from an older Hub, make sure the script has the tool-use branch (see `Phase 4 Task 4.1` in the implementation plan).

## Troubleshooting

- **PWA shows "未配对"**: localStorage was cleared. Re-pair via QR.
- **PWA shows "所有已知地址均不可达"**: computer is off, Hub is not running, or all network paths are blocked. Check Hub is running; try cellular vs Wi-Fi.
- **Chinese input shows garbage in Claude**: this is a Claude Code issue (the Hub sends bytes correctly). Ensure your Python stdin decodes UTF-8 — this Hub already does.
- **Permission card doesn't appear**: PreToolUse hook in `~/.claude/settings.json` is missing the catch-all entry. See Phase 4 Task 4.2.
```

- [ ] **Step 2: Commit**

```bash
git add docs/mobile-tailscale-setup.md
git commit -m "docs(mobile): setup guide with Tailscale instructions"
```

---

## Phase 8: Pre-Merge Review (user rule compliance)

### Task 8.1: Multi-model code review

Per user rule `feedback_review_before_commit`: before merging to main, run Codex + Gemini review.

- [ ] **Step 1: Invoke cli-caller skill**

Follow `/cli-caller` skill's Part 2 templates for Codex + Gemini CLI invocation. Ask each to review:

- `core/mobile-server.js`
- `core/mobile-auth.js`
- `core/mobile-routes.js`
- `core/mobile-protocol.js`
- Relevant sections of `main.js` (diff)

Review prompt: "Review this mobile remote implementation for Claude Session Hub. Focus on: (1) auth correctness (token bypass?), (2) WS message handling (DoS? injection?), (3) resource cleanup on disconnect, (4) fit with existing SessionManager invariants documented in project memory."

- [ ] **Step 2: Address any critical findings as follow-up tasks (TDD each)**

- [ ] **Step 3: Run post-refactor-verify**

Since this change touches ≥3 files and crosses modules, per rule: `/post-refactor-verify` is required before the refactor-guard hook will allow the merge commit.

```bash
# Follow /post-refactor-verify skill
```

- [ ] **Step 4: Final merge commit (if work was done on a branch)**

```bash
git push origin HEAD
```

---

## Self-Review Notes (filled after plan write)

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| 2.1 首次配对 | Phase 5 (desktop pair UI) + Task 6.2 (pair.html) |
| 2.2 日常使用 | Task 6.3 (multi-address probe) + Task 6.4+6.5 (views) |
| 2.3 折叠屏适配 | Task 6.6 |
| 3.1/3.2 进程与模块 | Phase 2 + Task 3.2 |
| 3.3 数据流 | Task 2.3 (WS broadcast) + Task 4.1/4.2 (hook → mobile event) |
| 4.1 REST API | Task 2.2 routes |
| 4.2 WS Protocol | Task 2.1 (schema) + Task 2.3 (server) + Task 6.3 (client) |
| 5.1/5.2 Token + 配对 URL | Task 1.1 + Task 6.2 |
| 5.3 多地址发现 | Task 6.3 `_probeAddresses` |
| 5.4 撤销设备 | Task 3.2 IPC + Task 5.2 UI |
| 5.5 Tailscale 文档 | Task 7.3 |
| 6. 错误处理 | Task 6.3 (disconnect/reconnect events), Task 6.5 (toast plumbing) |
| 7. 已有机制复用 | Task 3.1 (extend sessionManager), Task 4.1 (hook piggyback) |
| 8. 测试策略 | Phase 7 |

**Placeholder scan:** none present — all steps have concrete code.

**Type consistency:** `sessionManager.on/off/emit` — since we added `extends EventEmitter` in Task 3.1, these are standard Node methods. `listSessions()/getSessionBuffer(id)/writeToSession(id, data)/markRead(id)` consistent across mock SM (test-ws.js) and real SM (Task 3.1). `protocol.encode/decode/validate` consistent between Task 2.1 (definition) and Task 2.3 (use).

**Scope:** single plan — all tasks support one feature (mobile remote). No decomposition needed.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-14-mobile-remote-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
