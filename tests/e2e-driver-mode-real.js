#!/usr/bin/env node
// E2E Real Integration Test: Driver Mode — actual AI interaction
// Simulates a real user workflow: task → Claude codes → @review → copilots review
// Usage: node tests/e2e-driver-mode-real.js [cdp-port]

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.argv[2] || 9228;
const SCREENSHOT_DIR = path.join(__dirname, 'e2e-proof-screenshots', 'driver-mode');
const TIMEOUT_CLI_RESPONSE = 60000; // 60s for real AI response

let ws, msgId = 0;
const pending = new Map();

function log(tag, msg) { console.log(`[${new Date().toLocaleTimeString()}][${tag}] ${msg}`); }

async function cdpSend(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: (r) => { clearTimeout(timer); pending.delete(id); resolve(r); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expr, timeout) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('eval timeout')); }, timeout || 10000);
    pending.set(id, { resolve: (r) => {
      clearTimeout(timer); pending.delete(id);
      if (r.result && r.result.result) resolve(r.result.result.value);
      else if (r.result && r.result.exceptionDetails) reject(new Error(r.result.exceptionDetails.text || 'eval error'));
      else resolve(undefined);
    }, reject });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: timeout || 10000 } }));
  });
}

async function screenshot(name) {
  const r = await cdpSend('Page.captureScreenshot', { format: 'png' });
  if (r.result && r.result.data) {
    const file = path.join(SCREENSHOT_DIR, `real-${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    log('SHOT', file);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMessage(text) {
  await evalJs(`(() => {
    const box = document.getElementById('mr-input-box');
    if (box) { box.focus(); box.innerText = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); }
    return 'set';
  })()`);
  await sleep(300);
  await evalJs(`document.getElementById('mr-send-btn')?.click()`);
  log('SEND', text.slice(0, 80) + (text.length > 80 ? '...' : ''));
}

async function getMeetingInfo() {
  const raw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const meetings = await ipcRenderer.invoke('get-meetings');
    const dm = meetings.find(m => m.driverMode);
    return dm ? JSON.stringify({ id: dm.id, driverSid: dm.driverSessionId, subs: dm.subSessions }) : '{}';
  })()`);
  return JSON.parse(raw);
}

async function getTimeline(meetingId) {
  const raw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const tl = await ipcRenderer.invoke('meeting-get-timeline', '${meetingId}');
    return JSON.stringify(tl || []);
  })()`, 10000);
  return JSON.parse(raw);
}

async function waitForClaudeResponse(meetingId, driverSid, prevLen, maxWait) {
  log('WAIT', `等待 Claude 回复 (timeout ${maxWait/1000}s)...`);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const tl = await getTimeline(meetingId);
    const newTurns = tl.slice(prevLen);
    const claudeTurn = newTurns.find(t => t.sid === driverSid);
    if (claudeTurn) {
      log('RECV', `Claude 回复 (${claudeTurn.text.length} 字): ${claudeTurn.text.slice(0, 120)}...`);
      return { turn: claudeTurn, timeline: tl };
    }
    await sleep(3000);
    process.stdout.write('.');
  }
  console.log('');
  log('TIMEOUT', 'Claude 未在限定时间内回复');
  return null;
}

async function waitForCopilotResponse(meetingId, copilotSids, prevLen, maxWait) {
  log('WAIT', `等待副驾回复 (${copilotSids.length} 个, timeout ${maxWait/1000}s)...`);
  const start = Date.now();
  const received = new Set();
  while (Date.now() - start < maxWait) {
    const tl = await getTimeline(meetingId);
    const newTurns = tl.slice(prevLen);
    for (const sid of copilotSids) {
      if (!received.has(sid) && newTurns.find(t => t.sid === sid)) {
        received.add(sid);
        const turn = newTurns.find(t => t.sid === sid);
        log('RECV', `副驾 ${sid.slice(0,8)} 回复 (${turn.text.length} 字): ${turn.text.slice(0, 120)}...`);
      }
    }
    if (received.size === copilotSids.length) return { received: true, timeline: tl };
    await sleep(3000);
    process.stdout.write('.');
  }
  console.log('');
  log('TIMEOUT', `收到 ${received.size}/${copilotSids.length} 个副驾回复`);
  return { received: received.size > 0, timeline: await getTimeline(meetingId) };
}

// ================================================================
// Connect
// ================================================================
async function connect() {
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  const page = JSON.parse(body).find(p => p.type === 'page' && p.url.includes('index.html'));
  if (!page) throw new Error('Hub page not found');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) pending.get(msg.id).resolve(msg);
  });
  log('CDP', 'Connected');
}

// ================================================================
// Test Scenarios
// ================================================================
async function main() {
  await connect();
  await sleep(1000);

  const meeting = await getMeetingInfo();
  if (!meeting.id) { log('FATAL', '无主驾会议室'); process.exit(1); }
  log('INFO', `会议室: ${meeting.id.slice(0,8)}, 主驾: ${meeting.driverSid.slice(0,8)}, 子会话: ${meeting.subs.length}`);
  const copilotSids = meeting.subs.filter(s => s !== meeting.driverSid);
  log('INFO', `副驾: ${copilotSids.map(s => s.slice(0,8)).join(', ')}`);

  // ============================================================
  // Scenario 1: 给 Claude 一个简单编码任务
  // ============================================================
  log('SCENARIO', '====== Scenario 1: 给主驾 Claude 发编码任务 ======');

  const tl0 = await getTimeline(meeting.id);
  const task = '请在当前目录创建一个文件 /tmp/driver-mode-test.js，内容是一个简单的 Node.js HTTP server，监听 3999 端口，GET / 返回 JSON {status:"ok",mode:"driver"}。写完后告诉我文件路径。';

  await sendMessage(task);
  await screenshot('01-task-sent');

  const claudeResult = await waitForClaudeResponse(meeting.id, meeting.driverSid, tl0.length, TIMEOUT_CLI_RESPONSE);
  if (!claudeResult) {
    log('SKIP', 'Claude 未回复，跳过后续场景');
    await screenshot('01-claude-timeout');
    ws.close();
    process.exit(1);
  }

  await screenshot('02-claude-responded');
  log('INFO', `Timeline 长度: ${claudeResult.timeline.length}`);

  // 验证 Claude 确实创建了文件
  await sleep(2000);
  const fileExists = await evalJs(`(() => {
    try { return require('fs').existsSync('/tmp/driver-mode-test.js') ? 'yes' : 'no'; }
    catch { return 'error'; }
  })()`);
  log('CHECK', `文件 /tmp/driver-mode-test.js 存在: ${fileExists}`);

  // ============================================================
  // Scenario 2: 用户触发 @review 审查
  // ============================================================
  log('SCENARIO', '====== Scenario 2: 用户 @review 触发副驾审查 ======');

  const tl1 = await getTimeline(meeting.id);
  await sendMessage('@review 请检查 Claude 刚写的 HTTP server 代码，关注安全性和错误处理');

  // 检查审查横幅
  await sleep(1000);
  const reviewBar = await evalJs(`document.getElementById('mr-review-bar')?.innerHTML?.slice(0, 200) || 'not found'`);
  log('UI', `审查横幅: ${reviewBar.slice(0, 100)}`);
  await screenshot('03-review-triggered');

  // 等待副驾响应（通过 timeline 或审查结果）
  const copilotResult = await waitForCopilotResponse(meeting.id, copilotSids, tl1.length, TIMEOUT_CLI_RESPONSE);
  await screenshot('04-copilots-responded');

  if (copilotResult.received) {
    log('SUCCESS', '副驾审查回复已收到！');
    // 打印副驾的回复内容
    const tl2 = copilotResult.timeline;
    for (const t of tl2.slice(tl1.length)) {
      if (copilotSids.includes(t.sid)) {
        const sess = await evalJs(`(() => { const s = sessions.get('${t.sid}'); return s ? s.kind : 'unknown'; })()`);
        log('REVIEW', `[${sess}] ${t.text.slice(0, 300)}`);
      }
    }
  } else {
    log('INFO', '副驾未通过 timeline 回复——检查审查横幅是否有超时 FLAG 结果');
  }

  // 检查审查结果横幅状态
  await sleep(2000);
  const reviewResult = await evalJs(`(() => {
    const bar = document.getElementById('mr-review-bar');
    if (!bar) return 'no-bar';
    const items = bar.querySelectorAll('.mr-review-item');
    const results = [];
    items.forEach(item => {
      const verdict = item.querySelector('.mr-review-verdict');
      const reason = item.querySelector('.mr-review-reason');
      const agent = item.querySelector('.mr-review-agent');
      results.push({
        agent: agent ? agent.textContent : '?',
        verdict: verdict ? verdict.textContent : '?',
        reason: reason ? reason.textContent.slice(0, 100) : '?'
      });
    });
    return JSON.stringify(results);
  })()`);
  log('VERDICT', `审查结果: ${reviewResult}`);

  // ============================================================
  // Scenario 3: 单独 @gemini 提问
  // ============================================================
  log('SCENARIO', '====== Scenario 3: 单独 @gemini 提问 ======');

  const tl3 = await getTimeline(meeting.id);
  await sendMessage('@gemini 这个 HTTP server 的架构设计合理吗？如果要加 HTTPS 支持应该怎么做？');
  await screenshot('05-gemini-direct');

  const geminiSid = copilotSids[0]; // first copilot should be gemini
  log('WAIT', '等待 Gemini 直接回复...');
  for (let i = 0; i < 20; i++) {
    const tl = await getTimeline(meeting.id);
    const newTurns = tl.slice(tl3.length);
    const geminiTurn = newTurns.find(t => t.sid === geminiSid);
    if (geminiTurn) {
      log('RECV', `Gemini 回复 (${geminiTurn.text.length} 字): ${geminiTurn.text.slice(0, 200)}...`);
      break;
    }
    await sleep(3000);
    process.stdout.write('.');
  }
  console.log('');
  await screenshot('06-gemini-responded');

  // ============================================================
  // Scenario 4: 单独 @codex 提问
  // ============================================================
  log('SCENARIO', '====== Scenario 4: 单独 @codex 提问 ======');

  const tl4 = await getTimeline(meeting.id);
  await sendMessage('@codex 请检查 /tmp/driver-mode-test.js 的代码，列出潜在的 bug 和边界条件问题');
  await screenshot('07-codex-direct');

  const codexSid = copilotSids[1]; // second copilot should be codex
  log('WAIT', '等待 Codex 直接回复...');
  for (let i = 0; i < 20; i++) {
    const tl = await getTimeline(meeting.id);
    const newTurns = tl.slice(tl4.length);
    const codexTurn = newTurns.find(t => t.sid === codexSid);
    if (codexTurn) {
      log('RECV', `Codex 回复 (${codexTurn.text.length} 字): ${codexTurn.text.slice(0, 200)}...`);
      break;
    }
    await sleep(3000);
    process.stdout.write('.');
  }
  console.log('');
  await screenshot('08-codex-responded');

  // ============================================================
  // Final: 打印完整 Timeline
  // ============================================================
  log('SCENARIO', '====== Final: 完整 Timeline 摘要 ======');
  const finalTl = await getTimeline(meeting.id);
  log('INFO', `Timeline 共 ${finalTl.length} 条`);
  for (const t of finalTl) {
    const sidLabel = t.sid === 'user' ? 'USER' : t.sid.slice(0, 8);
    const sess = t.sid !== 'user' ? await evalJs(`(() => { const s = sessions.get('${t.sid}'); return s ? s.kind : '?'; })()`) : 'user';
    log('TL', `#${t.idx} [${sess}] ${t.text.slice(0, 120)}${t.text.length > 120 ? '...' : ''}`);
  }

  await screenshot('99-final');

  log('DONE', '====== 深度测试完成 ======');
  ws.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
