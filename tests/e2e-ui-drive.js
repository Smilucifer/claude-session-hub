/**
 * UI-driven E2E test — opens existing Team Room and captures message rendering.
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9227;
const SCREENSHOT_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\e2e-screenshots';

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
  const page = pages[0];
  console.log(`[cdp] connecting to: ${page.title}`);
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
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(1500);

  console.log('\n=== UI-1: Click existing Team Room ===');
  const clickResult = await evalJs(`(() => {
    // Find smallest element containing exactly "作战室" — avoid parent containers
    const all = [...document.querySelectorAll('*')];
    const candidates = all.filter(el => {
      const t = (el.innerText || el.textContent || '').trim();
      if (!t.includes('作战室')) return false;
      // Must be leaf-like (small text, few children)
      return t.length < 100 && el.children.length < 10;
    });
    // Sort by text length (smaller = more specific)
    candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const target = candidates[0];
    if (!target) return { found: false };
    target.click();
    return { found: true, cls: target.className, tag: target.tagName, text: target.innerText.substring(0, 80) };
  })()`);
  console.log(`[UI-1] ${JSON.stringify(clickResult)}`);
  await sleep(3000);
  await screenshot('11-UI1-team-room-opened.png');

  console.log('\n=== UI-2: Room state ===');
  const roomState = await evalJs(`JSON.stringify({
    hasTeamPanel: !!document.querySelector('.team-room, #teamRoom, [class*="team-room"]'),
    hasChatArea: !!document.querySelector('.chat, [class*="chat"], [class*="thread"], [class*="message"]'),
    bodySnippet: document.body.innerText.substring(0, 600),
  })`);
  console.log(`[UI-2] ${roomState.substring(0, 500)}`);
  await screenshot('12-UI2-room-state.png');

  console.log('\n=== UI-3: Message elements ===');
  const msgInfo = await evalJs(`(() => {
    const msgs = [...document.querySelectorAll('[class*="message"], [class*="msg"], [class*="thread"] > *')];
    return JSON.stringify({
      count: msgs.length,
      samples: msgs.slice(0, 5).map(el => ({
        cls: el.className.substring(0, 60),
        text: (el.innerText || '').substring(0, 100),
      })),
    });
  })()`);
  console.log(`[UI-3] ${msgInfo.substring(0, 600)}`);
  await screenshot('13-UI3-messages.png');

  await sleep(1000);
  await screenshot('14-UI4-final.png');

  ws.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e); if (ws) ws.close(); process.exit(1); });
