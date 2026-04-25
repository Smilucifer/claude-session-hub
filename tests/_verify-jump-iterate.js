'use strict';
// Verify Ctrl+Up/Down iterates through multiple prompts and active highlight is visible.
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = parseInt(process.argv[2] || '9228', 10);
const SHOT_DIR = path.join(__dirname, 'e2e-proof-screenshots', 'jump-iterate');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let ws, msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout: ' + method)); } }, 25000);
  });
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evalJs failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const fp = path.join(SHOT_DIR, name);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('Shot:', fp);
  return fp;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connect() {
  const list = await new Promise((ok, no) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => ok(JSON.parse(d)));
    }).on('error', no);
  });
  const page = list.filter(p => p.type === 'page')[0];
  return new Promise((ok, no) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', ok);
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    ws.on('error', no);
  });
}

async function pressCtrlArrow(direction) {
  const code = `
    (function() {
      var c = terminalCache.get(activeSessionId);
      if (!c) return 'no cache';
      var helper = c.terminal.element.querySelector('.xterm-helper-textarea');
      if (!helper) return 'no helper';
      helper.focus();
      var ev = new KeyboardEvent('keydown', {
        key: 'Arrow${direction}',
        code: 'Arrow${direction}',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      });
      helper.dispatchEvent(ev);
      return 'dispatched';
    })()
  `;
  return await evalJs(code);
}

async function getState(label) {
  const code = `
    (function() {
      var c = terminalCache.get(activeSessionId);
      if (!c) return 'no cache';
      var ticks = c._minimap.getTicks();
      var active = c._activePromptLine;
      var viewY = c.terminal.buffer.active.viewportY;
      var activeMarker = document.querySelectorAll('.prompt-line-marker-active').length;
      var totalMarkers = document.querySelectorAll('.prompt-line-marker').length;
      return JSON.stringify({
        viewportY: viewY,
        activePromptLine: active,
        tickLines: ticks.map(function(t){return t.line + ':' + t.text.substring(0,20)}),
        activeMarkers: activeMarker,
        totalMarkers: totalMarkers
      });
    })()
  `;
  const r = await evalJs(code);
  console.log(label + ': ' + r);
  return r;
}

async function run() {
  await connect();
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.bringToFront');

  console.log('Reloading to load latest renderer.js...');
  await cdp('Page.reload');
  await sleep(5000);

  await evalJs(`
    (function() {
      var items = document.querySelectorAll('.session-item');
      for (var i = 0; i < items.length; i++) {
        if (items[i].textContent.indexOf('Claude') >= 0 || items[i].querySelector('.session-title')) {
          items[i].click();
          return 'clicked ' + i;
        }
      }
      return 'no session';
    })()
  `);
  await sleep(2000);

  await getState('Initial state');
  await shot('00-initial.png');

  await evalJs('terminalCache.get(activeSessionId).terminal.scrollToBottom()');
  await sleep(500);
  await getState('After scrollToBottom');
  await shot('01-bottom.png');

  console.log('\n=== Press Ctrl+Up #1 ===');
  await pressCtrlArrow('Up');
  await sleep(700);
  await getState('After Ctrl+Up #1');
  await shot('02-ctrl-up-1.png');

  console.log('\n=== Press Ctrl+Up #2 ===');
  await pressCtrlArrow('Up');
  await sleep(700);
  await getState('After Ctrl+Up #2');
  await shot('03-ctrl-up-2.png');

  console.log('\n=== Press Ctrl+Up #3 ===');
  await pressCtrlArrow('Up');
  await sleep(700);
  await getState('After Ctrl+Up #3');
  await shot('04-ctrl-up-3.png');

  console.log('\n=== Press Ctrl+Down #1 ===');
  await pressCtrlArrow('Down');
  await sleep(700);
  await getState('After Ctrl+Down #1');
  await shot('05-ctrl-down-1.png');

  console.log('\n=== Press Ctrl+Down #2 ===');
  await pressCtrlArrow('Down');
  await sleep(700);
  await getState('After Ctrl+Down #2');
  await shot('06-ctrl-down-2.png');

  console.log('\nAll screenshots saved to:', SHOT_DIR);
  ws.close();
  process.exit(0);
}

run().catch(e => { console.error('FATAL:', e); if (ws) ws.close(); process.exit(1); });
