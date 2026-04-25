'use strict';
// One-shot screenshot helper: connects to a running Hub via CDP, scrolls
// the active terminal so all injected prompts are visible, and saves a
// screenshot to tests/e2e-proof-screenshots/prompt-jump/acceptance-fix.png.

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = parseInt(process.argv[2] || '9229', 10);
const OUT_DIR = path.join(__dirname, 'e2e-proof-screenshots', 'prompt-jump');
const OUT_FILE = path.join(OUT_DIR, 'acceptance-fix.png');

let ws;
let msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }
    }, 30000);
  });
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function connectCDP() {
  const list = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const page = list.filter(p => p.type === 'page' && !p.url.startsWith('devtools://'))[0];
  if (!page) throw new Error('No CDP page');
  console.log(`Target: ${page.title}`);
  return new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', resolve);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

(async () => {
  console.log(`Connecting to CDP port ${CDP_PORT}...`);
  await connectCDP();
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  console.log('Connected.');

  // Ensure active session exists
  const sid = await evalJs(`activeSessionId`);
  if (!sid) {
    console.log('No active session - creating PowerShell...');
    await evalJs(`document.getElementById('btn-new').click()`);
    await new Promise(r => setTimeout(r, 500));
    await evalJs(`
      const opts = document.querySelectorAll('.new-session-option[data-kind="powershell"]');
      if (opts.length) opts[0].click();
    `);
    await new Promise(r => setTimeout(r, 2500));
  }

  const finalSid = await evalJs(`activeSessionId`);
  console.log(`Active session: ${finalSid}`);

  // Inject prompts using > (ASCII) prefix to prove the fix works on real CC v2.1.119 format
  const injectResult = await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (!c) return 'no cache';
      const t = c.terminal;
      t.write('\\r\\n> what is 1+1?\\r\\n');
      t.write('  AI answering...\\r\\n');
      for (let i = 0; i < 5; i++) t.write('  Line ' + i + ' of response.\\r\\n');
      t.write('\\r\\n> what is 2+2?\\r\\n');
      t.write('  AI answering...\\r\\n');
      for (let i = 0; i < 5; i++) t.write('  Line ' + i + ' of response.\\r\\n');
      t.write('\\r\\n> what is 3+3?\\r\\n');
      t.write('  AI answering...\\r\\n');
      for (let i = 0; i < 5; i++) t.write('  Line ' + i + ' of response.\\r\\n');
      return 'injected';
    })()
  `);
  console.log(`Inject result: ${injectResult}`);
  await new Promise(r => setTimeout(r, 500));

  // Force minimap rescan
  await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (c && c._minimap) c._minimap.invalidate();
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));

  // Verify ticks
  const tickCount = await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      return c && c._minimap ? c._minimap.getTicks().length : -1;
    })()
  `);
  console.log(`Ticks detected: ${tickCount}`);

  // Verify button enabled state
  const btnState = await evalJs(`
    (function() {
      const btns = document.querySelectorAll('.prompt-nav-btn');
      return JSON.stringify(Array.from(btns).map(b => ({ dir: b.dataset.dir, disabled: b.disabled })));
    })()
  `);
  console.log('Button state: ' + btnState);

  // Scroll to top so all 3 prompts visible in viewport
  await evalJs(`terminalCache.get(activeSessionId).terminal.scrollToTop()`);
  await new Promise(r => setTimeout(r, 500));

  // Hover terminal to make buttons fully opaque (CSS :hover)
  await evalJs(`
    (function() {
      const tc = document.querySelector('.terminal-container');
      if (tc) {
        const ev = new MouseEvent('mouseover', { bubbles: true });
        tc.dispatchEvent(ev);
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 300));

  // Capture screenshot
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const result = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT_FILE, Buffer.from(result.data, 'base64'));
  console.log(`SAVED: ${OUT_FILE}`);
  console.log(`Ticks=${tickCount}, buttons=${btnState}`);

  ws.close();
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  if (ws) ws.close();
  process.exit(1);
});
