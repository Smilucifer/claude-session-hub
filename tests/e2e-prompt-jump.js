/**
 * E2E Test: Ctrl+Up/Down prompt jump + highlight flash
 *
 * Verifies:
 *   1. Minimap getTicks() returns prompt positions
 *   2. Ctrl+ArrowUp scrolls to previous prompt
 *   3. Ctrl+ArrowDown scrolls to next prompt
 *   4. Prompt highlight element appears after jump
 *   5. Multiple jumps navigate correctly
 *
 * Usage:
 *   1. Start Hub: $env:CLAUDE_HUB_DATA_DIR="C:\temp\hub-pj-test"
 *      .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9225
 *   2. node tests/e2e-prompt-jump.js [CDP_PORT]
 */
'use strict';

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = parseInt(process.argv[2] || process.env.CDP_PORT || '9224', 10);
const SCREENSHOT_DIR = path.join(__dirname, 'e2e-proof-screenshots', 'prompt-jump');

let ws;
let msgId = 0;
const pending = new Map();
const results = [];

function log(msg) { console.log(`[e2e] ${msg}`); }

function record(name, pass, detail) {
  const status = pass ? 'PASS' : 'FAIL';
  results.push({ name, status, detail });
  console.log(`  [${status}] ${name}${detail ? ' -- ' + detail : ''}`);
}

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
  const r = await cdp('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function shot(name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const fp = path.join(SCREENSHOT_DIR, name);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  log(`Screenshot: ${fp}`);
  return fp;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connectCDP() {
  const listResp = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Failed to parse CDP /json/list: ' + d)); }
      });
    }).on('error', reject);
  });

  const pages = listResp.filter(p => p.type === 'page' && !p.url.startsWith('devtools://'));
  if (pages.length === 0) throw new Error('No CDP pages found');
  const page = pages[0];
  log(`CDP target: ${page.title} (${page.url})`);

  return new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', () => resolve());
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
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

async function dispatchKeyEvent(key, ctrl = false) {
  await evalJs(`
    (function() {
      const ev = new KeyboardEvent('keydown', {
        key: '${key}', code: '${key}',
        ctrlKey: ${ctrl}, bubbles: true, cancelable: true
      });
      document.dispatchEvent(ev);
    })()
  `);
  await sleep(100);
}

async function run() {
  log('Connecting to Hub via CDP...');
  await connectCDP();
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  log('Connected.');

  // --- Test 1: Ensure active session + inject test prompts ---
  log('Test 1: Minimap ticks availability');

  const activeId = await evalJs(`activeSessionId`);
  if (!activeId) {
    log('No active session. Creating a PowerShell session...');
    await evalJs(`document.getElementById('btn-new').click()`);
    await sleep(500);
    await evalJs(`
      const opts = document.querySelectorAll('.new-session-option[data-kind="powershell"]');
      if (opts.length) opts[0].click();
    `);
    await sleep(2000);
  }

  const sid = await evalJs(`activeSessionId`);
  record('Active session exists', !!sid, sid);
  if (!sid) { log('ABORT: no active session'); return; }

  log('Injecting test prompts into terminal buffer...');
  await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (!c) return 'no cache';
      const t = c.terminal;
      t.write('\\r\\n❯ first test question\\r\\n');
      t.write('⏺ AI answering first question...\\r\\n');
      for (let i = 0; i < 30; i++) t.write('  Line ' + i + ' of AI response.\\r\\n');
      t.write('\\r\\n❯ second test question\\r\\n');
      t.write('⏺ AI answering second question...\\r\\n');
      for (let i = 0; i < 30; i++) t.write('  Line ' + i + ' of more output.\\r\\n');
      t.write('\\r\\n❯ third test question\\r\\n');
      t.write('⏺ AI answering third...\\r\\n');
      for (let i = 0; i < 20; i++) t.write('  Line ' + i + ' of third response.\\r\\n');
      return 'injected';
    })()
  `);
  await sleep(500);

  await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (c && c._minimap) c._minimap.invalidate();
    })()
  `);
  await sleep(800);

  const tickCount = await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (!c || !c._minimap || !c._minimap.getTicks) return -1;
      return c._minimap.getTicks().length;
    })()
  `);
  record('getTicks() returns prompts', tickCount >= 3, `found ${tickCount} ticks`);

  await shot('01-after-inject.png');

  // --- Test 2: Scroll to bottom, then Ctrl+Up ---
  log('Test 2: Ctrl+Up jumps to previous prompt');

  await evalJs(`terminalCache.get(activeSessionId).terminal.scrollToBottom()`);
  await sleep(200);

  const viewBefore = await evalJs(`terminalCache.get(activeSessionId).terminal.buffer.active.viewportY`);

  await dispatchKeyEvent('ArrowUp', true);
  await sleep(300);

  const viewAfterUp1 = await evalJs(`terminalCache.get(activeSessionId).terminal.buffer.active.viewportY`);
  record('Ctrl+Up scrolls up', viewAfterUp1 < viewBefore, `${viewBefore} -> ${viewAfterUp1}`);

  const highlightVisible = await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (!c) return false;
      const container = c.terminal.element.closest('.terminal-container');
      const h = container ? container.querySelector('.prompt-highlight') : null;
      return h ? h.style.display !== 'none' : false;
    })()
  `);
  record('Highlight element appears', highlightVisible === true, String(highlightVisible));

  await shot('02-after-ctrl-up.png');

  // --- Test 3: Ctrl+Up again ---
  log('Test 3: Second Ctrl+Up jumps further up');

  await dispatchKeyEvent('ArrowUp', true);
  await sleep(300);

  const viewAfterUp2 = await evalJs(`terminalCache.get(activeSessionId).terminal.buffer.active.viewportY`);
  record('2nd Ctrl+Up goes further up', viewAfterUp2 < viewAfterUp1, `${viewAfterUp1} -> ${viewAfterUp2}`);

  await shot('03-after-ctrl-up-2.png');

  // --- Test 4: Ctrl+Down ---
  log('Test 4: Ctrl+Down jumps to next prompt');

  await dispatchKeyEvent('ArrowDown', true);
  await sleep(300);

  const viewAfterDown = await evalJs(`terminalCache.get(activeSessionId).terminal.buffer.active.viewportY`);
  record('Ctrl+Down scrolls down', viewAfterDown > viewAfterUp2, `${viewAfterUp2} -> ${viewAfterDown}`);

  await shot('04-after-ctrl-down.png');

  // --- Test 5: Ctrl+Down again ---
  log('Test 5: Ctrl+Down to last prompt');

  await dispatchKeyEvent('ArrowDown', true);
  await sleep(300);

  const viewAfterDown2 = await evalJs(`terminalCache.get(activeSessionId).terminal.buffer.active.viewportY`);
  record('2nd Ctrl+Down reaches last prompt', viewAfterDown2 >= viewAfterDown, `${viewAfterDown} -> ${viewAfterDown2}`);

  await shot('05-after-ctrl-down-2.png');

  // --- Test 6: navPrev() method directly triggers flashPromptLine ---
  log('Test 6: minimap.navPrev() exists and triggers highlight');

  await evalJs(`terminalCache.get(activeSessionId).terminal.scrollToBottom()`);
  await sleep(200);

  // 先把 highlight 元素清掉，避免上一轮残留
  await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      const container = c.terminal.element.closest('.terminal-container');
      const h = container && container.querySelector('.prompt-highlight');
      if (h) h.style.display = 'none';
    })()
  `);
  await sleep(100);

  const navPrevExists = await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      return !!(c && c._minimap && typeof c._minimap.navPrev === 'function');
    })()
  `);
  record('minimap.navPrev() method exists', navPrevExists === true, String(navPrevExists));

  if (navPrevExists) {
    const navResult = await evalJs(`terminalCache.get(activeSessionId)._minimap.navPrev()`);
    record('navPrev() returns true on success', navResult === true, String(navResult));
    await sleep(300);

    const flashAfterNav = await evalJs(`
      (function() {
        const c = terminalCache.get(activeSessionId);
        const container = c.terminal.element.closest('.terminal-container');
        const h = container && container.querySelector('.prompt-highlight');
        return h ? h.style.display !== 'none' : false;
      })()
    `);
    record('navPrev() triggers flashPromptLine', flashAfterNav === true, String(flashAfterNav));
  }

  await shot('06-after-navPrev.png');

  // --- Test 7: CSS visual strength ---
  log('Test 7: prompt-line-marker has strong contrast and minimap-tick is bold');

  const markerStyle = await evalJs(`
    (function() {
      const m = document.querySelector('.prompt-line-marker');
      if (!m) return null;
      const cs = getComputedStyle(m);
      return {
        borderLeftWidth: cs.borderLeftWidth,
        backgroundColor: cs.backgroundColor,
      };
    })()
  `);
  if (markerStyle === null) {
    log('SKIP: prompt-line-marker not in viewport (ticks=0 or scroll pos); marker CSS assertions skipped');
  } else {
    record('prompt-line-marker exists in DOM', true, JSON.stringify(markerStyle));
    record(
      'prompt-line-marker border-left is 5px',
      markerStyle.borderLeftWidth === '5px',
      markerStyle.borderLeftWidth
    );
    // 22% alpha = 0.22, computed style returns "rgba(210, 153, 34, 0.219...)" or similar
    const bgMatch = /rgba\(210,\s*153,\s*34,\s*0\.2[12]/.test(markerStyle.backgroundColor);
    record(
      'prompt-line-marker background ~0.22 alpha',
      bgMatch,
      markerStyle.backgroundColor
    );
  }

  const tickStyle = await evalJs(`
    (function() {
      const t = document.querySelector('.minimap-tick');
      if (!t) return null;
      const cs = getComputedStyle(t);
      return { height: cs.height, backgroundColor: cs.backgroundColor };
    })()
  `);
  record('minimap-tick exists in DOM', tickStyle !== null, JSON.stringify(tickStyle));

  if (tickStyle) {
    record(
      'minimap-tick height is 6px',
      tickStyle.height === '6px',
      tickStyle.height
    );
    // #ffb84d = rgb(255, 184, 77)
    record(
      'minimap-tick color is bright orange #ffb84d',
      tickStyle.backgroundColor === 'rgb(255, 184, 77)',
      tickStyle.backgroundColor
    );
  }

  // --- Summary ---
  console.log('\n=== RESULTS ===');
  let pass = 0, fail = 0;
  for (const r of results) {
    console.log(`  [${r.status}] ${r.name}${r.detail ? ' -- ' + r.detail : ''}`);
    if (r.status === 'PASS') pass++; else fail++;
  }
  console.log(`\nTotal: ${pass} passed, ${fail} failed out of ${results.length}`);

  ws.close();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('E2E FATAL:', e);
  if (ws) ws.close();
  process.exit(1);
});
