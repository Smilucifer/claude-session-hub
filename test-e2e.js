// E2E test via CDP - connects to Electron's remote debugging port
const WebSocket = require('ws');
const http = require('http');

let ws;
let msgId = 0;

async function getPageWs() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const pages = JSON.parse(data);
        const hub = pages.find(p => p.title === 'Claude Session Hub');
        if (!hub) reject(new Error('Session Hub page not found'));
        else resolve(hub.webSocketDebuggerUrl);
      });
    }).on('error', reject);
  });
}

async function connect() {
  const wsUrl = await getPageWs();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.on('open', resolve));
}

function evaluate(expr) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
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
  try {
    await fn();
    console.log('  + ' + name);
    passed++;
  } catch (e) {
    console.log('  X ' + name + ': ' + e.message.substring(0, 100));
    failed++;
  }
}

async function run() {
  await connect();
  console.log('Connected to Electron');
  console.log('');

  // === Test 1: Basic UI ===
  console.log('=== Test 1: Basic UI ===');
  await test('Sidebar visible', async () => {
    const r = await evaluate('document.querySelector(".session-sidebar") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });
  await test('+ button exists', async () => {
    const r = await evaluate('document.getElementById("btn-new") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });

  // === Test 2: Dropdown menu ===
  console.log('');
  console.log('=== Test 2: Dropdown Menu ===');
  await test('Click + opens menu', async () => {
    await evaluate('document.getElementById("btn-new").click()');
    await sleep(200);
    const d = await evaluate('document.getElementById("new-session-menu").style.display');
    if (d !== 'block') throw new Error('display=' + d);
  });
  await test('Menu has Claude Code option', async () => {
    const r = await evaluate('document.querySelector("[data-kind=claude]") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });
  await test('Menu has PowerShell option', async () => {
    const r = await evaluate('document.querySelector("[data-kind=powershell]") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });

  // === Test 3: Create Claude session ===
  console.log('');
  console.log('=== Test 3: Create Claude Session ===');
  await test('Click Claude Code creates session', async () => {
    await evaluate('document.querySelector("[data-kind=claude]").click()');
    await sleep(1000);
    const count = await evaluate('sessions.size');
    if (count < 1) throw new Error('sessions.size=' + count);
  });
  await test('Title is Claude 1', async () => {
    const t = await evaluate('Array.from(sessions.values())[0].title');
    if (t !== 'Claude 1') throw new Error(t);
  });
  await test('Terminal created', async () => {
    const r = await evaluate('terminalCache.size');
    if (r < 1) throw new Error('terminalCache.size=' + r);
  });
  await test('Canvas rendered (after 1s)', async () => {
    await sleep(1000);
    const r = await evaluate('document.querySelectorAll("canvas").length');
    if (r < 1) throw new Error('canvas count=' + r);
  });

  console.log('  (waiting 15s for Claude Code startup...)');
  await sleep(15000);

  // === Test 4: Create PowerShell session ===
  console.log('');
  console.log('=== Test 4: Create PowerShell Session ===');
  await test('Create PowerShell session', async () => {
    await evaluate('document.getElementById("btn-new").click()');
    await sleep(200);
    await evaluate('document.querySelector("[data-kind=powershell]").click()');
    await sleep(2000);
    const count = await evaluate('sessions.size');
    if (count < 2) throw new Error('sessions.size=' + count);
  });
  await test('PowerShell 1 exists', async () => {
    const titles = await evaluate('JSON.stringify(Array.from(sessions.values()).map(s=>s.title))');
    if (!titles.includes('PowerShell 1')) throw new Error(titles);
  });

  // === Test 5: Session switching ===
  console.log('');
  console.log('=== Test 5: Session Switching ===');
  await test('Switch to Claude 1', async () => {
    const id = await evaluate('Array.from(sessions.values()).find(s=>s.title==="Claude 1").id');
    await evaluate('selectSession("' + id + '")');
    await sleep(300);
    const active = await evaluate('activeSessionId');
    if (active !== id) throw new Error('mismatch');
  });
  await test('Selected item in sidebar', async () => {
    const r = await evaluate('document.querySelector(".session-item.selected") ? "OK" : "NONE"');
    if (r !== 'OK') throw new Error(r);
  });

  // === Test 6: Inline rename ===
  console.log('');
  console.log('=== Test 6: Inline Rename ===');
  await test('Rename via IPC', async () => {
    const id = await evaluate('Array.from(sessions.values()).find(s=>s.title==="Claude 1").id');
    await evaluate('ipcRenderer.invoke("rename-session", { sessionId: "' + id + '", title: "TestRename" })');
    await sleep(500);
    const t = await evaluate('sessions.get("' + id + '").title');
    if (t !== 'TestRename') throw new Error(t);
  });
  await test('Sidebar updated with new name', async () => {
    const html = await evaluate('document.getElementById("session-list").innerHTML');
    if (!html.includes('TestRename')) throw new Error('Name not in sidebar');
  });

  // === Test 7: Hook endpoints (tested via Node http, not renderer fetch) ===
  console.log('');
  console.log('=== Test 7: Hook Endpoints ===');

  function hookPost(path, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port: 3456, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  await test('Stop hook 404 for invalid session', async () => {
    const r = await hookPost('/api/hook/stop', { sessionId: 'fake' });
    if (r !== 404) throw new Error('status=' + r);
  });
  await test('Stop hook 200 for valid session', async () => {
    const id = await evaluate('Array.from(sessions.values())[0].id');
    const r = await hookPost('/api/hook/stop', { sessionId: id });
    if (r !== 200) throw new Error('status=' + r);
  });
  await test('Prompt hook 200 for valid session', async () => {
    const id = await evaluate('Array.from(sessions.values())[0].id');
    const r = await hookPost('/api/hook/prompt', { sessionId: id });
    if (r !== 200) throw new Error('status=' + r);
  });

  // === Test 8: Terminal input ===
  console.log('');
  console.log('=== Test 8: Terminal Input ===');
  await test('Send input to terminal', async () => {
    const id = await evaluate('activeSessionId');
    await evaluate('ipcRenderer.send("terminal-input", { sessionId: "' + id + '", data: "test" })');
    await sleep(300);
    // No error = success
  });

  // === Test 9: Close session ===
  console.log('');
  console.log('=== Test 9: Close Session ===');
  await test('Close PowerShell session', async () => {
    const id = await evaluate('Array.from(sessions.values()).find(s=>s.title==="PowerShell 1").id');
    await evaluate('ipcRenderer.invoke("close-session", "' + id + '")');
    await sleep(2000);
    const count = await evaluate('sessions.size');
    if (count !== 1) throw new Error('sessions.size=' + count);
  });
  await test('Terminal cache cleaned', async () => {
    const r = await evaluate('terminalCache.size');
    if (r !== 1) throw new Error('terminalCache.size=' + r);
  });

  // === Test 10: Create 3 sessions rapidly ===
  console.log('');
  console.log('=== Test 10: Rapid 3-Session Stress ===');
  await test('Create 3 Claude sessions rapidly', async () => {
    for (let i = 0; i < 3; i++) {
      await evaluate('document.getElementById("btn-new").click()');
      await sleep(100);
      await evaluate('document.querySelector("[data-kind=claude]").click()');
      await sleep(500);
    }
    await sleep(2000);
    const count = await evaluate('sessions.size');
    if (count < 4) throw new Error('Expected >=4, got ' + count);
  });
  await test('All sessions have terminals', async () => {
    const s = await evaluate('sessions.size');
    const t = await evaluate('terminalCache.size');
    if (t < s) throw new Error('sessions=' + s + ' terminals=' + t);
  });

  // === Summary ===
  console.log('');
  console.log('=============================');
  console.log('PASSED: ' + passed + '  FAILED: ' + failed);
  console.log('=============================');

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
