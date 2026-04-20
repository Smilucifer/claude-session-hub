/**
 * E2E PROOF: real UI-driven test using correct element IDs from team-room.js.
 * #tr-input-box (contenteditable), #tr-send-btn, #tr-thread, .session-item.team-room
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9237;
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

  console.log('\n=== STEP 1: Open existing 作战室 ===');
  const clickRes = await evalJs(`(() => {
    const item = document.querySelector('.session-item.team-room');
    if (!item) {
      const all = [...document.querySelectorAll('.session-item')];
      const t = all.find(el => (el.innerText || '').includes('作战室'));
      if (!t) return JSON.stringify({ found: false, count: all.length });
      t.click();
      return JSON.stringify({ found: true, via: 'fallback' });
    }
    item.click();
    return JSON.stringify({ found: true, via: 'class', text: item.innerText.substring(0, 40) });
  })()`);
  console.log(`Click: ${clickRes}`);
  await sleep(3000);

  console.log('\n=== STEP 2: Verify room opened ===');
  const roomOpen = JSON.parse(await evalJs(`(() => {
    return JSON.stringify({
      hasInput: !!document.getElementById('tr-input-box'),
      hasSendBtn: !!document.getElementById('tr-send-btn'),
      hasThread: !!document.getElementById('tr-thread'),
      msgCount: document.querySelectorAll('.tr-msg').length,
    });
  })()`));
  console.log(`Room state: ${JSON.stringify(roomOpen)}`);
  if (!roomOpen.hasInput) {
    console.error('❌ Room did not open');
    await shot('debug-no-input.png');
    ws.close();
    return;
  }

  const msgCountBefore = roomOpen.msgCount;
  console.log(`Messages BEFORE: ${msgCountBefore}`);
  await shot('01-before-send.png');

  console.log('\n=== STEP 3: Type and send @皮卡丘 message ===');
  const sendStartTs = Date.now();
  const sendRes = await evalJs(`(() => {
    const inputBox = document.getElementById('tr-input-box');
    if (!inputBox) return JSON.stringify({ err: 'no input' });
    inputBox.focus();
    inputBox.innerText = '@皮卡丘 简短回答: hello';
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = document.getElementById('tr-send-btn');
    if (!sendBtn) return JSON.stringify({ err: 'no send btn' });
    if (sendBtn.disabled) return JSON.stringify({ err: 'send btn disabled' });
    sendBtn.click();
    return JSON.stringify({ ok: true });
  })()`);
  console.log(`Send: ${sendRes}`);
  await sleep(1500);
  await shot('02-just-sent.png');

  console.log('\n=== STEP 4: Wait for MCP callback → UI (max 180s) ===');
  const maxWait = 180;
  let gotReply = false;
  let replyContent = '';
  let finalCount = msgCountBefore;
  let lastLog = '';

  for (let i = 0; i < maxWait; i++) {
    await sleep(1000);
    const state = JSON.parse(await evalJs(`(() => {
      const msgs = [...document.querySelectorAll('.tr-msg')];
      const btn = document.getElementById('tr-send-btn');
      const thread = document.getElementById('tr-thread');
      let thinkings = 0;
      if (thread) {
        for (const c of thread.children) {
          if ((c.className||'').includes('thinking')) thinkings++;
        }
      }
      return JSON.stringify({
        count: msgs.length,
        processing: btn ? btn.disabled : false,
        thinkings,
        actors: msgs.slice(-3).map(m => (m.querySelector('.tr-msg-name')?.innerText || '')).filter(Boolean),
        lastText: msgs.length > 0 ? msgs[msgs.length-1].innerText.substring(0, 300) : '',
      });
    })()`));

    const log = `msgs=${state.count} proc=${state.processing} think=${state.thinkings} actors=${JSON.stringify(state.actors)}`;
    if (log !== lastLog || i % 10 === 0) { console.log(`  [${i}s] ${log}`); lastLog = log; }

    finalCount = state.count;

    if (state.count > msgCountBefore && !state.processing && state.thinkings === 0 && i >= 3) {
      gotReply = true;
      replyContent = state.lastText;
      console.log(`\n  ✅ GOT REPLY at t=${i}s: count ${msgCountBefore}→${state.count}`);
      break;
    }
  }

  await shot('03-after-reply.png');
  await sleep(1500);
  await shot('04-final.png');

  const elapsed = Math.floor((Date.now() - sendStartTs) / 1000);
  console.log(`\n========== RESULT ==========`);
  console.log(`Before: ${msgCountBefore}, After: ${finalCount}, Delta: +${finalCount - msgCountBefore}`);
  console.log(`Got reply: ${gotReply}`);
  console.log(`Reply: ${replyContent.substring(0, 200)}`);
  console.log(`Elapsed: ${elapsed}s`);

  fs.writeFileSync(path.join(SCREENSHOT_DIR, 'proof-results.json'), JSON.stringify({
    msgCountBefore, msgCountAfter: finalCount, delta: finalCount - msgCountBefore,
    gotReply, replyContent, elapsedSeconds: elapsed,
  }, null, 2));

  ws.close();
}

main().catch(e => { console.error('Fatal:', e); if (ws) ws.close(); process.exit(1); });
