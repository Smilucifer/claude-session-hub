/**
 * E2E MULTI-ROUND PROOF: 3 rounds with different messages. Verify real Claude
 * replies + incremental history + no duplicate DB events.
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const CDP_PORT = 9238;
const SCREENSHOT_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\e2e-screenshots';

let ws;
let msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }}, 30000);
  });
}

async function connect() {
  const listResp = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  const pages = listResp.filter(p => p.type === 'page' && !p.url.startsWith('devtools://'));
  const page = pages[0];
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

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SCREENSHOT_DIR, name), Buffer.from(r.data, 'base64'));
  console.log(`[shot] ${name}`);
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shellExec(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: 'C:\\Users\\lintian\\.ai-team', env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 5*1024*1024 },
      (err, stdout) => resolve(err ? { err: err.message } : { stdout: stdout.trim() }));
  });
}

async function openRoom() {
  await evalJs(`(() => {
    const item = document.querySelector('.session-item.team-room');
    if (item) item.click();
  })()`);
  await sleep(3000);
  const roomOpen = JSON.parse(await evalJs(`(() => JSON.stringify({
    hasInput: !!document.getElementById('tr-input-box'),
    msgCount: document.querySelectorAll('.tr-msg').length,
  }))()`));
  console.log(`Room opened: ${JSON.stringify(roomOpen)}`);
  if (!roomOpen.hasInput) throw new Error('room did not open');
  return roomOpen.msgCount;
}

async function sendAndWait(message, maxWait, roundLabel) {
  const before = parseInt(await evalJs(`document.querySelectorAll('.tr-msg').length`));
  console.log(`\n=== ${roundLabel}: "${message}" (before=${before}) ===`);

  const sendRes = await evalJs(`(() => {
    const inputBox = document.getElementById('tr-input-box');
    if (!inputBox) return 'no-input';
    inputBox.focus();
    inputBox.innerText = ${JSON.stringify(message)};
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = document.getElementById('tr-send-btn');
    if (!sendBtn) return 'no-btn';
    if (sendBtn.disabled) return 'disabled';
    sendBtn.click();
    return 'sent';
  })()`);
  console.log(`Send: ${sendRes}`);

  const startTs = Date.now();
  let gotReply = false;
  let replyContent = '';

  for (let i = 0; i < maxWait; i++) {
    await sleep(1000);
    const state = JSON.parse(await evalJs(`(() => {
      const msgs = [...document.querySelectorAll('.tr-msg')];
      const btn = document.getElementById('tr-send-btn');
      const lastMsg = msgs[msgs.length-1];
      return JSON.stringify({
        count: msgs.length,
        processing: btn ? btn.disabled : false,
        lastActor: lastMsg?.querySelector('.tr-msg-name')?.innerText || '',
        lastText: lastMsg?.innerText?.substring(0, 400) || '',
      });
    })()`));
    if (i % 5 === 0) console.log(`  [${i}s] count=${state.count} proc=${state.processing} actor=${state.lastActor}`);
    if (state.count > before && !state.processing && i >= 3 && /pikachu|皮卡丘/i.test(state.lastActor)) {
      gotReply = true;
      replyContent = state.lastText;
      const elapsed = Math.floor((Date.now() - startTs) / 1000);
      console.log(`  ✅ ${roundLabel} REPLY in ${elapsed}s: ${replyContent.substring(0, 200)}`);
      break;
    }
  }
  const after = parseInt(await evalJs(`document.querySelectorAll('.tr-msg').length`));
  return { gotReply, replyContent, before, after };
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await connect();
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(1500);

  await openRoom();
  await shot('00-room-opened.png');

  const rounds = [
    { label: 'ROUND 1', msg: '@皮卡丘 R1 测试: 我说个数字 42' },
    { label: 'ROUND 2', msg: '@皮卡丘 R2 测试: 上一轮我说的数字是什么？' },
    { label: 'ROUND 3', msg: '@皮卡丘 R3 测试: 简短总结一下我们刚才聊了什么' },
  ];

  const results = [];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const out = await sendAndWait(r.msg, 150, r.label);
    results.push({ ...r, ...out });
    await shot(`0${i+1}-after-${r.label.toLowerCase().replace(' ','-')}.png`);
    await sleep(3000);
  }

  console.log('\n=== DB check: look for duplicate consecutive events ===');
  const rooms = JSON.parse((await shellExec('python -m ai_team.bridge_query rooms')).stdout);
  const teamRoom = rooms.find(r => r.members && r.members.includes('pikachu'));
  if (teamRoom) {
    const eventsRaw = (await shellExec(`python -m ai_team.bridge_query events ${teamRoom.id} 50`)).stdout;
    const events = JSON.parse(eventsRaw);
    const recent = events.slice(-10);
    console.log(`Last ${recent.length} events in ${teamRoom.id}:`);
    for (const e of recent) {
      console.log(`  [${e.actor}] ${(e.content||'').substring(0, 80)}`);
    }
    let dupes = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].actor === recent[i-1].actor && recent[i].content === recent[i-1].content) dupes++;
    }
    console.log(`Duplicate consecutive events: ${dupes}`);
  }

  console.log('\n========== MULTI-ROUND RESULTS ==========');
  for (const r of results) {
    const icon = r.gotReply ? '✅' : '❌';
    console.log(`${icon} ${r.label}: before=${r.before} after=${r.after}`);
    console.log(`   reply: ${r.replyContent.substring(0, 150)}`);
  }

  fs.writeFileSync(path.join(SCREENSHOT_DIR, 'multi-round-results.json'), JSON.stringify(results, null, 2));
  await shot('99-final.png');
  ws.close();
}

main().catch(e => { console.error('Fatal:', e); if (ws) ws.close(); process.exit(1); });
