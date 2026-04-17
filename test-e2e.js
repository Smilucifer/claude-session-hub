// E2E test via CDP - connects to Electron's remote debugging port
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

const APP_ROOT = __dirname;
const ELECTRON_CLI = path.join(APP_ROOT, 'node_modules', 'electron', 'cli.js');

let electronProcess = null;
let msgId = 0;

async function getPageWs() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      http.get('http://127.0.0.1:9222/json', (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const pages = JSON.parse(data);
            const hub = pages.find(p => p.title === 'Claude Session Hub');
            resolve(hub ? hub.webSocketDebuggerUrl : null);
          } catch {
            resolve(null);
          }
        });
      }).on('error', () => resolve(null));
    });
    if (result) return result;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Session Hub page not found');
}

async function ensureElectronRunning() {
  const ready = await new Promise((resolve) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
  if (ready) return;

  electronProcess = spawn(process.execPath, [ELECTRON_CLI, APP_ROOT, '--remote-debugging-port=9222'], {
    cwd: APP_ROOT,
    stdio: 'ignore',
    shell: false,
    detached: false,
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      http.get('http://127.0.0.1:9222/json', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }).on('error', () => resolve(false));
    });
    if (up) return;
    await sleep(500);
  }
  throw new Error('Electron debug endpoint did not start');
}

async function connect() {
  await ensureElectronRunning();
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

async function getHookStatus() {
  return await evaluate(`ipcRenderer.invoke('get-hook-status')`);
}

function hookPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function waitForHookPort() {
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = await getHookStatus();
      if (status && status.up && status.port) return resolve(status);
      await sleep(200);
    }
    reject(new Error('hook status not ready'));
  });
}

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

function evaluateWithLog(label, expr) {
  return evaluate(`(async () => { try { return await (${expr}); } catch (e) { return 'EVAL_ERROR:' + (e && e.message || String(e)); } })()`)
    .then((value) => {
      console.log(`    [diag] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      return value;
    });
}

let createdClaudeSessionId = null;

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
  await test('Context menu has Rename session item', async () => {
    const r = await evaluate('document.querySelector("#context-menu [data-action=rename]") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });
  await test('Menu has Claude Code option', async () => {
    const r = await evaluate('document.querySelector("[data-kind=claude]") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });
  await test('Menu has PowerShell option', async () => {
    const r = await evaluate('document.querySelector("[data-kind=powershell]") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });
  await test('Menu has PowerShell (Admin) option', async () => {
    const r = await evaluate('document.querySelector("[data-kind=powershell-admin]") ? "OK" : "MISSING"');
    if (r !== 'OK') throw new Error(r);
  });
  await test('Clicking PowerShell (Admin) sends powershell-admin kind', async () => {
    const result = await evaluate(`
      (async () => {
        const original = ipcRenderer.invoke;
        let seen = null;
        ipcRenderer.invoke = async (channel, payload) => {
          if (channel === 'create-session') {
            seen = payload;
            return { ok: true, action: 'launched' };
          }
          return original(channel, payload);
        };
        document.getElementById('btn-new').click();
        await new Promise(r => setTimeout(r, 100));
        document.querySelector('[data-kind=powershell-admin]').click();
        await new Promise(r => setTimeout(r, 100));
        ipcRenderer.invoke = original;
        return seen;
      })()
    `);
    if (result !== 'powershell-admin') throw new Error(String(result));
  });
  await test('Admin launch success shows feedback', async () => {
    const result = await evaluate(`
      (async () => {
        const originalInvoke = ipcRenderer.invoke;
        ipcRenderer.invoke = async (channel, payload) => {
          if (channel === 'create-session' && payload === 'powershell-admin') {
            return { ok: true, action: 'launched' };
          }
          return originalInvoke(channel, payload);
        };
        document.getElementById('btn-new').click();
        await new Promise(r => setTimeout(r, 100));
        document.querySelector('[data-kind=powershell-admin]').click();
        await new Promise(r => setTimeout(r, 100));
        const text = document.getElementById('launch-feedback-banner')?.textContent || '';
        ipcRenderer.invoke = originalInvoke;
        return text;
      })()
    `);
    if (!result.includes('管理员 PowerShell 启动中')) throw new Error(result);
  });

  // === Test 3: Create Claude session ===
  console.log('');
  console.log('=== Test 3: Create Claude Session ===');
  await test('Click Claude Code creates session', async () => {
    const before = await evaluate('JSON.stringify(Array.from(sessions.keys()))');
    await evaluate('document.querySelector("[data-kind=claude]").click()');
    await sleep(1000);
    const count = await evaluate('sessions.size');
    if (count < 1) throw new Error('sessions.size=' + count);
    const after = await evaluate('JSON.stringify(Array.from(sessions.keys()))');
    const beforeIds = new Set(JSON.parse(before));
    const afterIds = JSON.parse(after);
    createdClaudeSessionId = afterIds.find(id => !beforeIds.has(id)) || null;
    if (!createdClaudeSessionId) throw new Error('no new Claude session id');
  });
  await test('Claude session gets a non-empty title', async () => {
    const t = await evaluate('Array.from(sessions.values())[0].title');
    if (!t || !String(t).trim()) throw new Error(String(t));
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
  await test('PowerShell session exists', async () => {
    const kinds = await evaluate('JSON.stringify(Array.from(sessions.values()).map(s => s.kind))');
    if (!kinds.includes('powershell')) throw new Error(kinds);
  });

  // === Test 5: Session switching ===
  console.log('');
  console.log('=== Test 5: Session Switching ===');
  await test('Switch to first Claude session', async () => {
    const id = await evaluate('Array.from(sessions.values()).find(s => s.kind === "claude").id');
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
  await test('Rename active Claude session via IPC', async () => {
    if (!createdClaudeSessionId) throw new Error('missing created Claude session id');
    await evaluate('ipcRenderer.invoke("rename-session", { sessionId: "' + createdClaudeSessionId + '", title: "TestRename" })');
    await sleep(500);
    const t = await evaluate('sessions.get("' + createdClaudeSessionId + '").title');
    if (t !== 'TestRename') throw new Error(t);
  });
  await test('Sidebar updated with new name', async () => {
    const html = await evaluate('document.getElementById("session-list").innerHTML');
    if (!html.includes('TestRename')) throw new Error('Name not in sidebar');
  });

  // === Test 7: Hook endpoints (tested via Node http, not renderer fetch) ===
  console.log('');
  console.log('=== Test 7: Hook Endpoints ===');

  const hookStatus = await waitForHookPort();
  await test('Hook status exposes dynamic port', async () => {
    if (!hookStatus.up) throw new Error('hook server is down');
    if (!hookStatus.port) throw new Error('missing hook port');
  });

  await test('Stop hook 403 without token for invalid session', async () => {
    const r = await hookPost(hookStatus.port, '/api/hook/stop', { sessionId: 'fake' });
    if (r !== 403) throw new Error('status=' + r);
  });
  await test('Stop hook 200 with token for invalid session', async () => {
    const token = await evaluate('require("electron").ipcRenderer.invoke("debug:get-hook-token")');
    const r = await hookPost(hookStatus.port, '/api/hook/stop', { sessionId: 'fake', token });
    if (r !== 200) throw new Error('status=' + r);
  });
  await test('Stop hook 200 with token for valid session', async () => {
    const id = await evaluate('Array.from(sessions.values())[0].id');
    const token = await evaluate('require("electron").ipcRenderer.invoke("debug:get-hook-token")');
    const r = await hookPost(hookStatus.port, '/api/hook/stop', { sessionId: id, token });
    if (r !== 200) throw new Error('status=' + r);
  });
  await test('Prompt hook 200 with token for valid session', async () => {
    const id = await evaluate('Array.from(sessions.values())[0].id');
    const token = await evaluate('require("electron").ipcRenderer.invoke("debug:get-hook-token")');
    const r = await hookPost(hookStatus.port, '/api/hook/prompt', { sessionId: id, token });
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
  await test('Close current PowerShell session', async () => {
    const before = await evaluate('sessions.size');
    const id = await evaluate('Array.from(sessions.values()).find(s => s.kind === "powershell").id');
    await evaluate('ipcRenderer.invoke("close-session", "' + id + '")');
    await sleep(2000);
    const count = await evaluate('sessions.size');
    if (count !== before - 1) throw new Error('sessions.size=' + count);
  });
  await test('Closed session terminal cache is removed', async () => {
    const snapshot = await evaluate(`JSON.stringify({
      sessionIds: Array.from(sessions.keys()),
      terminalIds: Array.from(terminalCache.keys())
    })`);
    const parsed = JSON.parse(snapshot);
    const dangling = parsed.terminalIds.filter(id => !parsed.sessionIds.includes(id));
    if (dangling.length) throw new Error('dangling terminals=' + dangling.join(','));
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
  await test('All live sessions have terminals', async () => {
    const snapshot = await evaluate(`JSON.stringify({
      sessions: Array.from(sessions.values()).filter(s => s.status !== 'dormant').map(s => ({ id: s.id, kind: s.kind })),
      terminals: Array.from(terminalCache.keys())
    })`);
    const parsed = JSON.parse(snapshot);
    const liveIds = parsed.sessions.map(s => s.id);
    const missing = liveIds.filter(id => !parsed.terminals.includes(id));
    if (missing.length) throw new Error('missing terminals for ' + missing.join(','));
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
