#!/usr/bin/env node
// Deep integration test: creates driver meeting, waits for CLI ready, sends real tasks
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.argv[2] || 9228;
const SHOT_DIR = path.join(__dirname, 'e2e-proof-screenshots', 'driver-mode');

let ws, msgId = 0;
const pending = new Map();

function log(tag, msg) { console.log(`[${new Date().toLocaleTimeString()}][${tag}] ${msg}`); }

async function cdpSend(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: r => { clearTimeout(timer); pending.delete(id); resolve(r); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expr, timeout) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const t = timeout || 12000;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('eval timeout')); }, t);
    pending.set(id, { resolve: r => {
      clearTimeout(timer); pending.delete(id);
      if (r.result?.result) resolve(r.result.result.value);
      else if (r.result?.exceptionDetails) reject(new Error(r.result.exceptionDetails.text || 'eval error'));
      else resolve(undefined);
    }, reject });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: t } }));
  });
}

async function shot(name) {
  const r = await cdpSend('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    const f = path.join(SHOT_DIR, `real2-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    log('SHOT', f);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMsg(text) {
  await evalJs(`(() => {
    const box = document.getElementById('mr-input-box');
    if (box) { box.focus(); box.innerText = ${JSON.stringify(text)}; }
    return 'ok';
  })()`);
  await sleep(200);
  await evalJs(`document.getElementById('mr-send-btn')?.click()`);
  log('SEND', text.slice(0, 100));
}

async function getTimeline(mid) {
  const r = await evalJs(`(async()=>{const{ipcRenderer}=require('electron');const t=await ipcRenderer.invoke('meeting-get-timeline','${mid}');return JSON.stringify(t||[]);})()`);
  return JSON.parse(r);
}

async function getBuffer(sid) {
  const r = await evalJs(`(async()=>{const{ipcRenderer}=require('electron');return await ipcRenderer.invoke('get-ring-buffer','${sid}')||'';})()`);
  return r || '';
}

// ================================================================
async function main() {
  // Connect
  const body = await new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
  });
  const page = JSON.parse(body).find(p => p.type === 'page' && p.url.includes('index.html'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) pending.get(m.id).resolve(m); });
  log('CDP', 'Connected');

  // ============================================================
  // Step 1: 创建主驾会议室
  // ============================================================
  log('STEP', '=== 1. 创建主驾会议室 ===');

  // 打开 modal
  await evalJs(`document.querySelector('.new-session-option[data-kind="meeting"]')?.click()`);
  await sleep(500);

  // 确认主驾模式默认选中
  const driverChecked = await evalJs(`document.querySelector('input[name="meeting-mode"][value="driver"]')?.checked`);
  log('CHECK', `主驾模式默认选中: ${driverChecked}`);

  // 点创建
  await evalJs(`document.getElementById('create-meeting-confirm')?.click()`);
  log('WAIT', '等待会议室创建 + 3 个子会话...');
  await sleep(5000);

  // 获取会议信息
  const mRaw = await evalJs(`(async()=>{const{ipcRenderer}=require('electron');const ms=await ipcRenderer.invoke('get-meetings');const dm=ms.find(m=>m.driverMode);return dm?JSON.stringify({id:dm.id,driverSid:dm.driverSessionId,subs:dm.subSessions}):'{}';})()`);
  const meeting = JSON.parse(mRaw);
  log('INFO', `会议: ${meeting.id?.slice(0,8)}, 主驾: ${meeting.driverSid?.slice(0,8)}, subs: ${meeting.subs?.length}`);

  if (!meeting.driverSid) {
    log('BUG', 'driverSessionId 为空！竞态条件仍存在？');
    await shot('00-no-driver-sid');

    // Debug: check meeting state
    const allMeetings = await evalJs(`(async()=>{const{ipcRenderer}=require('electron');return JSON.stringify(await ipcRenderer.invoke('get-meetings'));})()`);
    log('DEBUG', allMeetings);
    ws.close();
    process.exit(1);
  }

  const copilotSids = meeting.subs.filter(s => s !== meeting.driverSid);
  await shot('01-meeting-created');

  // ============================================================
  // Step 2: 等待 Claude CLI 完全就绪
  // ============================================================
  log('STEP', '=== 2. 等待 Claude CLI 就绪 ===');

  let claudeReady = false;
  for (let i = 0; i < 40; i++) { // 最多 80 秒
    const buf = await getBuffer(meeting.driverSid);
    const stripped = buf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    const bufLen = buf.length;

    // Claude CLI 就绪标志：显示了 tip box 或 prompt（含 ">" 或 "claude" 字样或超过 1KB）
    if (bufLen > 1000 || stripped.includes('>') || stripped.includes('Claude') || stripped.includes('claude')) {
      log('READY', `Claude CLI 就绪 (buffer ${bufLen} bytes, ${i*2}s)`);
      claudeReady = true;
      break;
    }
    if (i % 5 === 0) log('WAIT', `  Claude buffer: ${bufLen} bytes (${i*2}s)...`);
    await sleep(2000);
  }

  if (!claudeReady) {
    log('WARN', 'Claude CLI 未就绪（80s 超时）。检查 buffer...');
    const buf = await getBuffer(meeting.driverSid);
    log('DEBUG', `Claude buffer (${buf.length} bytes): ${buf.slice(-200)}`);
    await shot('02-claude-not-ready');
  }

  await shot('02-claude-ready');

  // ============================================================
  // Step 3: 同时检查 Gemini/Codex 状态
  // ============================================================
  log('STEP', '=== 3. 检查副驾状态 ===');
  for (const sid of copilotSids) {
    const buf = await getBuffer(sid);
    const sess = await evalJs(`(()=>{const s=sessions.get('${sid}');return s?s.kind:'?';})()`);
    log('INFO', `  ${sess} (${sid.slice(0,8)}): buffer ${buf.length} bytes`);
  }

  // ============================================================
  // Step 4: 发送真实编码任务给 Claude
  // ============================================================
  log('STEP', '=== 4. 发送编码任务给 Claude ===');

  const tl0 = await getTimeline(meeting.id);
  await sendMsg('请创建文件 /tmp/driver-test-server.js，写一个简单的 Node.js HTTP server：监听 3999 端口，GET / 返回 JSON {"status":"ok","mode":"driver","time":"<当前时间>"}。代码要有基本错误处理。写完告诉我文件路径。');

  // 等待 Claude 回复
  log('WAIT', '等待 Claude 回复（最多 90s）...');
  let claudeResponse = null;
  for (let i = 0; i < 30; i++) {
    const tl = await getTimeline(meeting.id);
    const newT = tl.slice(tl0.length + 1); // +1 skip the user message
    const ct = newT.find(t => t.sid === meeting.driverSid);
    if (ct) {
      claudeResponse = ct;
      log('RECV', `Claude 回复! (${ct.text.length} 字, ${i*3}s)`);
      log('PREVIEW', ct.text.slice(0, 300));
      break;
    }
    await sleep(3000);
    if (i % 5 === 0) log('WAIT', `  ${i*3}s...`);
  }

  await shot('03-claude-response');

  if (!claudeResponse) {
    log('FAIL', 'Claude 未回复。检查终端...');
    const buf = await getBuffer(meeting.driverSid);
    log('DEBUG', `Claude buffer tail: ${buf.slice(-400).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()}`);
    // 不退出，继续测试其他功能
  }

  // ============================================================
  // Step 5: @review 触发副驾审查
  // ============================================================
  log('STEP', '=== 5. @review 触发审查 ===');

  const tl1 = await getTimeline(meeting.id);
  await sendMsg('@review 请审查 Claude 刚写的 HTTP server 代码，关注安全性和错误处理');

  await sleep(1500);
  const barHTML = await evalJs(`document.getElementById('mr-review-bar')?.textContent?.trim() || 'no-bar'`);
  log('UI', `审查横幅: ${barHTML.slice(0, 80)}`);
  await shot('04-review-bar');

  // 等待审查结果（副驾回复或超时 FLAG）
  log('WAIT', '等待审查结果（最多 40s）...');
  for (let i = 0; i < 14; i++) {
    const verdict = await evalJs(`(() => {
      const bar = document.getElementById('mr-review-bar');
      if (!bar) return 'no-bar';
      const items = bar.querySelectorAll('.mr-review-item');
      if (items.length === 0) return 'pending';
      const results = [];
      items.forEach(it => {
        const v = it.querySelector('.mr-review-verdict')?.textContent || '?';
        const r = it.querySelector('.mr-review-reason')?.textContent || '?';
        const a = it.querySelector('.mr-review-agent')?.textContent || '?';
        results.push(a + ': ' + v + ' - ' + r.slice(0, 60));
      });
      return results.join(' | ');
    })()`);
    if (verdict !== 'pending' && verdict !== 'no-bar') {
      log('VERDICT', verdict);
      break;
    }
    await sleep(3000);
    if (i % 3 === 0) log('WAIT', `  ${i*3}s... (${verdict})`);
  }
  await shot('05-review-result');

  // ============================================================
  // Step 6: @gemini 单独提问
  // ============================================================
  log('STEP', '=== 6. @gemini 单独提问 ===');

  const tl2 = await getTimeline(meeting.id);
  await sendMsg('@gemini 你觉得这个 HTTP server 的架构合理吗？如果要支持 HTTPS 和路由应该怎么做？');

  log('WAIT', '等待 Gemini 回复（最多 60s）...');
  let geminiGot = false;
  for (let i = 0; i < 20; i++) {
    const tl = await getTimeline(meeting.id);
    const newT = tl.slice(tl2.length + 1);
    const gt = newT.find(t => copilotSids.includes(t.sid));
    if (gt) {
      const kind = await evalJs(`(()=>{const s=sessions.get('${gt.sid}');return s?s.kind:'?';})()`);
      log('RECV', `${kind} 回复! (${gt.text.length} 字)`);
      log('PREVIEW', gt.text.slice(0, 300));
      geminiGot = true;
      break;
    }
    await sleep(3000);
    if (i % 5 === 0) log('WAIT', `  ${i*3}s...`);
  }
  await shot('06-gemini-response');

  // ============================================================
  // Step 7: @codex 单独提问
  // ============================================================
  log('STEP', '=== 7. @codex 单独提问 ===');

  const tl3 = await getTimeline(meeting.id);
  await sendMsg('@codex 请检查 /tmp/driver-test-server.js 的代码质量：有没有 bug、缺少的错误处理、或者安全隐患？');

  log('WAIT', '等待 Codex 回复（最多 60s）...');
  for (let i = 0; i < 20; i++) {
    const tl = await getTimeline(meeting.id);
    const newT = tl.slice(tl3.length + 1);
    const ct = newT.find(t => copilotSids.includes(t.sid));
    if (ct) {
      const kind = await evalJs(`(()=>{const s=sessions.get('${ct.sid}');return s?s.kind:'?';})()`);
      log('RECV', `${kind} 回复! (${ct.text.length} 字)`);
      log('PREVIEW', ct.text.slice(0, 300));
      break;
    }
    await sleep(3000);
    if (i % 5 === 0) log('WAIT', `  ${i*3}s...`);
  }
  await shot('07-codex-response');

  // ============================================================
  // Summary
  // ============================================================
  log('STEP', '=== 最终 Timeline ===');
  const finalTl = await getTimeline(meeting.id);
  log('INFO', `共 ${finalTl.length} 条 turns`);
  for (const t of finalTl) {
    const kind = t.sid === 'user' ? 'USER' : await evalJs(`(()=>{const s=sessions.get('${t.sid}');return s?s.kind:'?';})()`);
    log('TL', `#${t.idx} [${kind}] ${t.text.slice(0, 150)}${t.text.length > 150 ? '...' : ''}`);
  }

  await shot('99-final');
  log('DONE', '深度测试完成');
  ws.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
