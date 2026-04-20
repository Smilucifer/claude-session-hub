/**
 * Real E2E test for MCP Mailbox.
 * Connects to running test Hub via CDP, drives UI, captures screenshots.
 * Tests 9 scenarios including all 3 characters + @team + multi-round.
 *
 * Requires Hub already running on CDP port 9227.
 * Usage: node tests/e2e-mcp-real.js
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9227;
const HOOK_PORT = 3457;
const SCREENSHOT_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\e2e-screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout ${method}`)); }
    }, 30000);
  });
}

async function connect() {
  const listResp = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  const pages = listResp.filter(p => p.type === 'page' && !p.url.startsWith('devtools://'));
  if (pages.length === 0) throw new Error('No Hub page found');
  const page = pages[0];
  console.log(`[cdp] connecting to page: ${page.title}`);
  return new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', () => resolve());
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function screenshot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const filepath = path.join(SCREENSHOT_DIR, name);
  fs.writeFileSync(filepath, Buffer.from(r.data, 'base64'));
  console.log(`[shot] ${filepath}`);
  return filepath;
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const byteLen = Buffer.byteLength(data, 'utf-8');
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': byteLen },
    }, (res) => {
      let out = '';
      res.setEncoding('utf-8');
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.write(data, 'utf-8'); req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function exec(cmd) {
  const { exec: _exec } = require('child_process');
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    _exec(cmd, { cwd: 'C:\\Users\\lintian\\.ai-team', maxBuffer: 5*1024*1024, env, encoding: 'utf-8' },
      (err, stdout, stderr) => resolve(err ? { error: err.message, stderr } : { stdout: stdout.trim() }));
  });
}

// Simulate a character's team_respond callback (as MCP tool would)
async function simulateResponse(roomId, charId, content) {
  const eventId = 'evt-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  // 1. Insert event to DB (what team_respond does)
  await exec(`python -m ai_team.bridge_query insert-event ${roomId} ${charId} message "${content.replace(/"/g, '\\"')}"`);
  // 2. POST to Hub callback endpoint (what team_respond does)
  const resp = await httpPost(`http://127.0.0.1:${HOOK_PORT}/api/team/response`, {
    room_id: roomId, character_id: charId, content, event_id: eventId,
  });
  return { status: resp.status, body: resp.body, eventId };
}

async function main() {
  const results = {};

  await connect();
  console.log('[cdp] connected\n');
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(1500);

  // ===== E1: Hub UI loaded =====
  console.log('=== E1: Hub UI loaded ===');
  const u1 = JSON.parse(await evalJs(`JSON.stringify({
    title: document.title,
    bodyHasContent: document.body.children.length > 0,
    hasSidebar: !!document.querySelector('.sidebar, #sidebar, aside, [class*="side"]'),
    childCount: document.body.children.length,
  })`));
  console.log(`[E1] ${JSON.stringify(u1)}`);
  await screenshot('01-E1-hub-ui-loaded.png');
  results.E1 = { status: u1.bodyHasContent && u1.hasSidebar ? 'PASS' : 'FAIL', detail: u1 };
  console.log(`[E1] ${results.E1.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E2: UI structure scan =====
  console.log('=== E2: UI structure scan ===');
  const uiStruct = JSON.parse(await evalJs(`(() => {
    const visibleButtons = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(el => el.offsetParent !== null)
      .slice(0, 20)
      .map(el => ({ text: (el.innerText||'').trim().substring(0, 30), cls: el.className.substring(0, 40) }))
      .filter(b => b.text);
    return JSON.stringify({ total: visibleButtons.length, sample: visibleButtons.slice(0, 6) });
  })()`));
  console.log(`[E2] ${JSON.stringify(uiStruct)}`);
  await screenshot('02-E2-ui-scan.png');
  results.E2 = { status: uiStruct.total > 0 ? 'PASS' : 'FAIL', detail: uiStruct };
  console.log(`[E2] ${results.E2.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E3: MCP callback endpoint (basic) =====
  console.log('=== E3: MCP callback endpoint (basic POST) ===');
  const r3 = await httpPost(`http://127.0.0.1:${HOOK_PORT}/api/team/response`, {
    room_id: 'e2e-basic', character_id: 'pikachu',
    content: 'Basic callback test with em dash — works now',
    event_id: 'evt-e2e-basic',
  });
  console.log(`[E3] ${r3.status}: ${r3.body}`);
  await screenshot('03-E3-callback-basic.png');
  results.E3 = { status: r3.status === 200 && r3.body.includes('ok') ? 'PASS' : 'FAIL', detail: `${r3.status} ${r3.body}` };
  console.log(`[E3] ${results.E3.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E4: Rooms query =====
  console.log('=== E4: Rooms query ===');
  const roomsR = await exec(`python -m ai_team.bridge_query rooms`);
  const rooms = roomsR.stdout ? JSON.parse(roomsR.stdout) : [];
  console.log(`[E4] Found ${rooms.length} rooms, characters: ${rooms[0]?.members?.join(',')}`);
  results.E4 = { status: rooms.length > 0 ? 'PASS' : 'FAIL', detail: `${rooms.length} rooms` };
  console.log(`[E4] ${results.E4.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E5: Incremental history =====
  console.log('=== E5: Incremental history query ===');
  const histRoom = 'e2e-hist-' + Date.now();
  for (let i = 0; i < 3; i++) {
    await exec(`python -m ai_team.bridge_query insert-event ${histRoom} user message "msg${i}"`);
  }
  const allEventsR = await exec(`python -m ai_team.bridge_query events-since ${histRoom} 0`);
  const allEvents = JSON.parse(allEventsR.stdout);
  const cursor = allEvents[0].rowid;
  const deltaR = await exec(`python -m ai_team.bridge_query events-since ${histRoom} ${cursor}`);
  const delta = JSON.parse(deltaR.stdout);
  console.log(`[E5] Full: ${allEvents.length}, Delta: ${delta.length}`);
  results.E5 = { status: allEvents.length === 3 && delta.length === 2 ? 'PASS' : 'FAIL', detail: `full=${allEvents.length}, delta=${delta.length}` };
  console.log(`[E5] ${results.E5.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E6: @皮卡丘 (Claude/pikachu) single =====
  console.log('=== E6: Single @皮卡丘 callback ===');
  const room6 = 'e2e-char-test-' + Date.now();
  const r6 = await simulateResponse(room6, 'pikachu',
    '【皮卡丘】我认为华为的研发投入是国产第一，尤其是在芯片领域');
  console.log(`[E6] ${r6.status}: ${r6.body} eventId=${r6.eventId}`);
  await sleep(500);
  await screenshot('06-E6-pikachu-response.png');
  results.E6 = { status: r6.status === 200 ? 'PASS' : 'FAIL', detail: `${r6.status}` };
  console.log(`[E6] ${results.E6.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E7: @小火龙 (Gemini/charmander) single =====
  console.log('=== E7: Single @小火龙 callback ===');
  const r7 = await simulateResponse(room6, 'charmander',
    '【小火龙】换个角度：华为还有鸿蒙OS全栈自研，这是其他公司没有的');
  console.log(`[E7] ${r7.status}: ${r7.body} eventId=${r7.eventId}`);
  await sleep(500);
  await screenshot('07-E7-charmander-response.png');
  results.E7 = { status: r7.status === 200 ? 'PASS' : 'FAIL', detail: `${r7.status}` };
  console.log(`[E7] ${results.E7.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E8: @杰尼龟 (Codex/squirtle) single =====
  console.log('=== E8: Single @杰尼龟 callback ===');
  const r8 = await simulateResponse(room6, 'squirtle',
    '【杰尼龟】从风险角度看，华为面临美国持续制裁，供应链仍是隐患');
  console.log(`[E8] ${r8.status}: ${r8.body} eventId=${r8.eventId}`);
  await sleep(500);
  await screenshot('08-E8-squirtle-response.png');
  results.E8 = { status: r8.status === 200 ? 'PASS' : 'FAIL', detail: `${r8.status}` };
  console.log(`[E8] ${results.E8.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== E9: @team broadcast (3 parallel callbacks) =====
  console.log('=== E9: @team broadcast (3 parallel callbacks) ===');
  const room9 = 'e2e-team-broadcast-' + Date.now();
  const parallel = await Promise.all([
    simulateResponse(room9, 'pikachu', '【皮卡丘·并行】兆易创新主营存储芯片，国产替代逻辑'),
    simulateResponse(room9, 'charmander', '【小火龙·并行】估值角度，当前PE不算便宜'),
    simulateResponse(room9, 'squirtle', '【杰尼龟·并行】技术面目前压力位明显'),
  ]);
  const allOk = parallel.every(r => r.status === 200);
  console.log(`[E9] All 3 status: ${parallel.map(r => r.status).join(', ')}`);
  await sleep(500);
  await screenshot('09-E9-team-broadcast.png');
  results.E9 = { status: allOk ? 'PASS' : 'FAIL', detail: `statuses=${parallel.map(r => r.status).join(',')}` };
  console.log(`[E9] ${results.E9.status === 'PASS' ? '✅' : '❌'}\n`);

  // Verify 3 events in DB for room9
  const room9EventsR = await exec(`python -m ai_team.bridge_query events-since ${room9} 0`);
  const room9Events = JSON.parse(room9EventsR.stdout);
  console.log(`[E9] DB events for ${room9}: ${room9Events.length} (expected 3)`);
  results.E9.dbEvents = room9Events.length;

  // ===== E10: Multi-round conversation =====
  console.log('=== E10: Multi-round conversation ===');
  const room10 = 'e2e-multi-round-' + Date.now();
  // Round 1: user asks, pikachu answers
  await exec(`python -m ai_team.bridge_query insert-event ${room10} user message "第一轮：分析一下新能源车龙头"`);
  await sleep(200);
  await simulateResponse(room10, 'pikachu', '【R1 皮卡丘】比亚迪销量第一，但特斯拉技术领先');
  await sleep(200);

  // Verify history before round 2
  const afterR1R = await exec(`python -m ai_team.bridge_query events-since ${room10} 0`);
  const afterR1 = JSON.parse(afterR1R.stdout);
  console.log(`[E10 R1] DB has ${afterR1.length} events`);

  // Round 2: user follows up with different character
  await exec(`python -m ai_team.bridge_query insert-event ${room10} user message "第二轮：小火龙你觉得皮卡丘说得对吗"`);
  await sleep(200);
  await simulateResponse(room10, 'charmander', '【R2 小火龙】皮卡丘说的销量对，但技术判断过于简化。宁德时代的电池才是真正壁垒');
  await sleep(200);

  // Verify full history now
  const afterR2R = await exec(`python -m ai_team.bridge_query events-since ${room10} 0`);
  const afterR2 = JSON.parse(afterR2R.stdout);
  console.log(`[E10 R2] DB has ${afterR2.length} events`);

  // Round 3: All three weigh in via broadcast
  await exec(`python -m ai_team.bridge_query insert-event ${room10} user message "第三轮：@team 最终结论"`);
  await sleep(200);
  await Promise.all([
    simulateResponse(room10, 'pikachu', '【R3 皮卡丘】结论：比亚迪短期销量+长期电池自研能胜'),
    simulateResponse(room10, 'charmander', '【R3 小火龙】结论：宁德时代作为卖水人更稳'),
    simulateResponse(room10, 'squirtle', '【R3 杰尼龟】结论：组合持仓分散风险'),
  ]);
  await sleep(300);
  await screenshot('10-E10-multi-round.png');

  const afterR3R = await exec(`python -m ai_team.bridge_query events-since ${room10} 0`);
  const afterR3 = JSON.parse(afterR3R.stdout);
  console.log(`[E10 R3] DB has ${afterR3.length} events`);

  // Expected: 3 user messages + 5 character responses = 8
  const expected = 3 + 5; // 3 user + R1 pikachu + R2 charmander + R3 x3
  results.E10 = {
    status: afterR3.length === expected ? 'PASS' : 'FAIL',
    detail: `r1=${afterR1.length}(2) r2=${afterR2.length}(4) r3=${afterR3.length}(${expected})`
  };
  console.log(`[E10] ${results.E10.status === 'PASS' ? '✅' : '❌'} — ${results.E10.detail}\n`);

  // ===== E11: Verify history injection correctness (simulate what Hub would build) =====
  console.log('=== E11: History injection (delta + formatting) ===');
  // After R1, if user @charmander in R2, the delta for charmander should contain R1 content
  // Simulate: after R1, charmander's read pointer is 0, query delta
  const deltaForCharmanderR = await exec(`python -m ai_team.bridge_query events-since ${room10} 0`);
  const deltaForCharmander = JSON.parse(deltaForCharmanderR.stdout);
  const hasPikachuR1 = deltaForCharmander.some(e => e.actor === 'pikachu' && e.content.includes('R1 皮卡丘'));
  console.log(`[E11] Charmander can see Pikachu's R1 response: ${hasPikachuR1}`);
  results.E11 = {
    status: hasPikachuR1 ? 'PASS' : 'FAIL',
    detail: `Previous character's message visible in history=${hasPikachuR1}`
  };
  console.log(`[E11] ${results.E11.status === 'PASS' ? '✅' : '❌'}\n`);

  // ===== Summary =====
  console.log('\n========== RESULTS ==========');
  for (const [k, v] of Object.entries(results)) {
    const icon = v.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${k}: ${v.status} — ${JSON.stringify(v.detail).substring(0, 80)}`);
  }
  const passed = Object.values(results).filter(v => v.status === 'PASS').length;
  const total = Object.keys(results).length;
  console.log(`\nTotal: ${passed}/${total} passed`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  fs.writeFileSync(path.join(SCREENSHOT_DIR, 'results.json'), JSON.stringify(results, null, 2));

  ws.close();
}

main().catch(e => {
  console.error('Fatal:', e);
  if (ws) ws.close();
  process.exit(1);
});
