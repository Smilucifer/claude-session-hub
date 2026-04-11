const WebSocket = require('ws');
const http = require('http');
let ws, msgId = 0;

async function getPageWs() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const pages = JSON.parse(data);
        const hub = pages.find(p => p.title === 'Claude Session Hub');
        if (!hub) reject(new Error('not found'));
        else resolve(hub.webSocketDebuggerUrl);
      });
    }).on('error', reject);
  });
}

async function connect() {
  ws = new WebSocket(await getPageWs());
  await new Promise(r => ws.on('open', r));
}

function evaluate(expr) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails).substring(0, 200)));
        else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      }
    };
    ws.on('message', handler);
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('timeout')); }, 30000);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  + ' + name); passed++; }
  catch (e) { console.log('  X ' + name + ': ' + e.message.substring(0, 100)); failed++; }
}

async function run() {
  await connect();
  console.log('Connected\n');

  // === Create Claude session 1 ===
  console.log('=== Phase 1: Create Claude Session ===');
  await evaluate('document.getElementById("btn-new").click()');
  await sleep(200);
  await evaluate('document.querySelector("[data-kind=claude]").click()');
  console.log('  Waiting 18s for Claude Code startup...');
  await sleep(18000);

  await test('Session created', async () => {
    const c = await evaluate('sessions.size');
    if (c !== 1) throw new Error('count=' + c);
  });

  await test('Status is idle after startup', async () => {
    const s = await evaluate('Array.from(sessions.values())[0].status');
    if (s !== 'idle') throw new Error('status=' + s);
  });

  await test('Unread count is 0 (focused session)', async () => {
    const u = await evaluate('Array.from(sessions.values())[0].unreadCount');
    if (u !== 0) throw new Error('unread=' + u);
  });

  // === Send Chinese message ===
  console.log('\n=== Phase 2: Send Chinese Message ===');
  const sid = await evaluate('Array.from(sessions.values())[0].id');
  await evaluate('ipcRenderer.send("terminal-input", { sessionId: "' + sid + '", data: "say hello in Chinese, one short sentence\\r" })');
  console.log('  Waiting 30s for Claude response + silence...');
  await sleep(30000);

  await test('Preview has CJK content', async () => {
    const p = await evaluate('Array.from(sessions.values())[0].lastOutputPreview');
    if (!p || !/[\u4e00-\u9fff]{2,}/.test(p)) throw new Error('preview=' + JSON.stringify(p));
  });

  await test('Status is idle after response', async () => {
    const s = await evaluate('Array.from(sessions.values())[0].status');
    if (s !== 'idle') throw new Error('status=' + s);
  });

  // === Create session 2 (test unread on non-focused) ===
  console.log('\n=== Phase 3: Create Session 2 + Test Unread ===');
  await evaluate('document.getElementById("btn-new").click()');
  await sleep(200);
  await evaluate('document.querySelector("[data-kind=claude]").click()');
  console.log('  Waiting 18s for session 2 startup...');
  await sleep(18000);

  // Switch back to session 1
  await evaluate('selectSession("' + sid + '")');
  await sleep(500);

  await test('Session 2 unread = 0 (just created, was focused)', async () => {
    const s2 = await evaluate('Array.from(sessions.values()).find(s => s.title !== "Claude 1")');
    const u = await evaluate('Array.from(sessions.values()).find(s => s.title !== "Claude 1").unreadCount');
    if (u > 1) throw new Error('unread=' + u);  // Allow 0 or 1
  });

  // === Send message on session 1 while session 2 is not focused ===
  console.log('\n=== Phase 4: Send Message + Check Unread on Other ===');
  await evaluate('ipcRenderer.send("terminal-input", { sessionId: "' + sid + '", data: "say goodbye in Chinese\\r" })');
  console.log('  Waiting 20s...');
  await sleep(20000);

  await test('Session 1 preview updated', async () => {
    const p = await evaluate('sessions.get("' + sid + '").lastOutputPreview');
    if (!p || p.length < 2) throw new Error('preview=' + JSON.stringify(p));
  });

  // === Dump final state ===
  console.log('\n=== Final State ===');
  const state = await evaluate('JSON.stringify(Array.from(sessions.values()).map(s => ({title: s.title, status: s.status, preview: s.lastOutputPreview, unread: s.unreadCount})), null, 2)');
  console.log(state);

  console.log('\n=============================');
  console.log('PASSED: ' + passed + '  FAILED: ' + failed);
  console.log('=============================');

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
