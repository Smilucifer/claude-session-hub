/**
 * REAL E2E: drive UI to send message, wait for real Claude CLI response via MCP,
 * capture before/during/after screenshots as proof.
 *
 * This test CONSUMES Claude API tokens — keep message short.
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9228;
const SCREENSHOT_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\e2e-screenshots';

let ws;
let msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
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
  const page = pages[0];
  console.log(`[cdp] connected to: ${page.title}`);
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
  const fp = path.join(SCREENSHOT_DIR, name);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log(`[shot] ${fp}`);
  return fp;
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await connect();
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(1500);

  console.log('\n=== STEP 1: Initial Hub state ===');
  await shot('01-initial-state.png');

  console.log('\n=== STEP 2: Create new test Team Room ===');
  const createResult = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const roomName = 'E2E真实测试-' + Date.now();
    try {
      const room = await ipcRenderer.invoke('team:createRoom', roomName, ['pikachu'], 'lite');
      return JSON.stringify({ ok: true, room });
    } catch (e) {
      return JSON.stringify({ ok: false, err: e.message });
    }
  })()`);
  console.log(`Room create: ${createResult}`);
  const roomInfo = JSON.parse(createResult);
  if (!roomInfo.ok) { console.error('Abort'); ws.close(); return; }
  const roomId = roomInfo.room.id;
  await sleep(2000);
  await shot('02-room-created.png');

  console.log('\n=== STEP 3: Click new room ===');
  const clickRes = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    await ipcRenderer.invoke('team:loadRooms');
    await new Promise(r => setTimeout(r, 500));
    const items = [...document.querySelectorAll('span.session-title')];
    const target = items.find(el => el.innerText.includes('E2E真实测试'));
    if (!target) return JSON.stringify({ found: false, all: items.map(e => e.innerText) });
    target.click();
    return JSON.stringify({ found: true, text: target.innerText });
  })()`);
  console.log(`Click: ${clickRes}`);
  await sleep(3000);
  await shot('03-room-opened-empty.png');

  console.log('\n=== STEP 4: Verify empty room ===');
  const emptyState = await evalJs(`(() => {
    const msgs = [...document.querySelectorAll('.tr-msg')];
    return JSON.stringify({ msgCount: msgs.length, inputExists: !!document.querySelector('textarea') });
  })()`);
  console.log(`Empty state: ${emptyState}`);

  console.log('\n=== STEP 5: Send message ===');
  const sendStartTs = Date.now();
  const sendRes = await evalJs(`(async () => {
    const textarea = document.querySelector('textarea');
    if (!textarea) return JSON.stringify({ err: 'no textarea' });
    textarea.value = '@皮卡丘 回答: hello';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const btns = [...document.querySelectorAll('button')];
    const sendBtn = btns.find(b => /send|发送|➤|▶/.test(b.innerText || '') || b.title?.includes('发送'));
    if (!sendBtn) {
      const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      textarea.dispatchEvent(evt);
      return JSON.stringify({ sent: 'via-enter' });
    }
    sendBtn.click();
    return JSON.stringify({ sent: 'via-button', btnText: sendBtn.innerText });
  })()`);
  console.log(`Send: ${sendRes}`);
  await sleep(2000);
  await shot('04-just-sent.png');

  console.log('\n=== STEP 6: Wait for MCP callback → UI update ===');
  const maxWait = 120;
  let gotReply = false;
  let replyContent = '';
  for (let i = 0; i < maxWait; i++) {
    await sleep(1000);
    const state = await evalJs(`(() => {
      const msgs = [...document.querySelectorAll('.tr-msg')];
      return JSON.stringify({
        count: msgs.length,
        actors: msgs.map(m => (m.querySelector('.tr-msg-name')?.innerText || m.className)).slice(0, 10),
        lastText: msgs.length > 0 ? msgs[msgs.length-1].innerText.substring(0, 300) : '',
      });
    })()`);
    const s = JSON.parse(state);
    if (i % 5 === 0) console.log(`  [${i}s] msgs=${s.count} actors=${JSON.stringify(s.actors)}`);
    const hasPikachu = s.actors.some(a => /pikachu|皮卡丘/i.test(a));
    if (hasPikachu) {
      gotReply = true;
      replyContent = s.lastText;
      console.log(`  ✅ Got pikachu reply at ${i}s`);
      await shot('05-got-reply-moment.png');
      break;
    }
  }

  await sleep(1500);
  await shot('06-final-state.png');

  console.log('\n=== STEP 7: Verify DB has real event ===');
  const { exec } = require('child_process');
  const dbCheck = await new Promise((resolve) => {
    exec(`python -m ai_team.bridge_query events-since ${roomId} 0`,
      { cwd: 'C:\\Users\\lintian\\.ai-team', env: { ...process.env, PYTHONUTF8: '1' }, encoding: 'utf-8' },
      (err, stdout) => resolve(err ? { err: err.message } : { stdout: stdout.trim() }));
  });
  console.log(`DB: ${(dbCheck.stdout || dbCheck.err || '').substring(0, 500)}`);

  const elapsed = Math.floor((Date.now() - sendStartTs) / 1000);
  console.log(`\n========== RESULT ==========`);
  console.log(`Got UI reply: ${gotReply}`);
  console.log(`Reply: ${replyContent.substring(0, 150)}`);
  console.log(`Elapsed: ${elapsed}s`);
  console.log(`Room: ${roomId}`);

  fs.writeFileSync(path.join(SCREENSHOT_DIR, 'real-results.json'), JSON.stringify({
    roomId, gotReply, replyContent, elapsedSeconds: elapsed,
    dbResult: dbCheck.stdout || dbCheck.err,
  }, null, 2));

  ws.close();
}

main().catch(e => { console.error('Fatal:', e); if (ws) ws.close(); process.exit(1); });
