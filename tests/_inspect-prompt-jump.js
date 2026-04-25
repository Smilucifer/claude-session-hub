const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '9224', 10);
let ws, msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout: ' + method)); } }, 25000);
  });
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name, clip) {
  const dir = 'C:\\Users\\lintian\\claude-session-hub\\tests\\e2e-proof-screenshots\\prompt-jump-deep';
  fs.mkdirSync(dir, { recursive: true });
  const params = { format: 'png' };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await cdp('Page.captureScreenshot', params);
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('SHOT:', fp);
  return fp;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + PORT + '/json/list', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej);
  });
  const page = list.find(p => p.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');

  // Use Emulation to force viewport size
  try {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
    });
    console.log('Emulation viewport set to 1600x1000');
  } catch (e) { console.log('Emulation failed:', e.message); }
  await sleep(800);

  // Diagnose all panels
  const layoutDiag = await evalJs([
    '(function() {',
    '  const all = ["terminal-panel","preview-panel","memo-panel","team-room-panel","meeting-room-panel"];',
    '  const out = {};',
    '  for (const id of all) {',
    '    const el = document.getElementById(id);',
    '    if (!el) { out[id] = "missing"; continue; }',
    '    const r = el.getBoundingClientRect();',
    '    out[id] = { display: el.style.display, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };',
    '  }',
    '  return out;',
    '})()'
  ].join('\n'));
  console.log('LAYOUT DIAG:', JSON.stringify(layoutDiag, null, 2));

  // Force hide preview, force show terminal
  await evalJs([
    '(function() {',
    '  const pp = document.getElementById("preview-panel");',
    '  if (pp) { pp.style.display = "none"; pp.classList.remove("preview-split"); }',
    '  const tp = document.getElementById("terminal-panel");',
    '  if (tp) tp.style.display = "";',
    '  return "ok";',
    '})()'
  ].join('\n'));
  await sleep(500);

  // Inspect the .app-container children
  const containerChildren = await evalJs([
    '(function() {',
    '  const c = document.getElementById("app-container");',
    '  if (!c) return null;',
    '  return Array.from(c.children).map(el => {',
    '    const r = el.getBoundingClientRect();',
    '    const cs = getComputedStyle(el);',
    '    return {',
    '      tag: el.tagName,',
    '      id: el.id,',
    '      cls: el.className,',
    '      display: cs.display,',
    '      flex: cs.flex,',
    '      width: cs.width,',
    '      x: Math.round(r.x),',
    '      w: Math.round(r.width)',
    '    };',
    '  });',
    '})()'
  ].join('\n'));
  console.log('CONTAINER CHILDREN:', JSON.stringify(containerChildren, null, 2));

  // Inspect inline style of terminal-panel
  const tpInline = await evalJs([
    '(function() {',
    '  const tp = document.getElementById("terminal-panel");',
    '  return { cssText: tp.style.cssText, inlineWidth: tp.style.width, inlineDisplay: tp.style.display, inlineFlex: tp.style.flex };',
    '})()'
  ].join('\n'));
  console.log('TERMINAL inline:', JSON.stringify(tpInline));

  // Clear all inline styles on terminal-panel
  await evalJs([
    '(function() {',
    '  const tp = document.getElementById("terminal-panel");',
    '  if (tp) tp.removeAttribute("style");',
    '  window.dispatchEvent(new Event("resize"));',
    '})()'
  ].join('\n'));
  await sleep(500);

  const tpFixed = await evalJs('(function(){ const tp=document.getElementById("terminal-panel"); const r=tp.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), cssText: tp.style.cssText }; })()');
  console.log('TERMINAL after removeAttribute:', JSON.stringify(tpFixed));

  const sessions = await evalJs('Array.from(sessions.entries()).map(([id, s]) => ({ id, kind: s.kind }))');
  const codex = sessions.find(s => s.kind === 'codex');
  await evalJs('selectSession(' + JSON.stringify(codex.id) + ')');
  await sleep(500);

  // Force scan
  await evalJs('terminalCache.get(activeSessionId)._minimap.invalidate()');
  await sleep(1800);

  const ticks = await evalJs('terminalCache.get(activeSessionId)._minimap.getTicks()');
  console.log('TICKS:', ticks.length, 'entries');

  await evalJs('terminalCache.get(activeSessionId).terminal.scrollToBottom()');
  await sleep(400);

  const mmRect = await evalJs([
    '(function() {',
    '  const m = document.querySelector(".terminal-minimap");',
    '  if (!m) return null;',
    '  const r = m.getBoundingClientRect();',
    '  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };',
    '})()'
  ].join('\n'));
  console.log('Minimap rect:', JSON.stringify(mmRect));

  // Take full screenshot of CURRENT (default 2px tick) state
  await shot('G1-default-ticks.png');

  // Crop to right edge for current default ticks
  if (mmRect) {
    await shot('G2-default-ticks-cropped.png', {
      x: mmRect.x - 200, y: mmRect.y,
      width: 220, height: mmRect.h,
    });
  }

  // Apply emphasized style (bigger ticks)
  await evalJs([
    '(function() {',
    '  const style = document.createElement("style");',
    '  style.id = "tick-debug-style";',
    '  style.textContent = ".terminal-minimap { width: 16px !important; } .terminal-container { padding-right: 20px !important; } .minimap-tick { height: 6px !important; opacity: 1 !important; background: #ff6b1a !important; box-shadow: 0 0 4px #ff6b1a; }";',
    '  document.head.appendChild(style);',
    '})()'
  ].join('\n'));
  await sleep(300);

  // Re-measure
  const mmRect2 = await evalJs([
    '(function() {',
    '  const m = document.querySelector(".terminal-minimap");',
    '  if (!m) return null;',
    '  const r = m.getBoundingClientRect();',
    '  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };',
    '})()'
  ].join('\n'));

  await shot('G3-emphasized-ticks.png');
  if (mmRect2) {
    await shot('G4-emphasized-cropped.png', {
      x: mmRect2.x - 250, y: mmRect2.y,
      width: 280, height: mmRect2.h,
    });
  }

  // Test Ctrl+Up
  console.log('=== Ctrl+Up test ===');
  const before = await evalJs('terminalCache.get(activeSessionId).terminal.buffer.active.viewportY');

  await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", ctrlKey: true, bubbles: true, cancelable: true }))');
  await shot('H1-flash-immediate.png');
  await sleep(80);
  await shot('H2-flash-80ms.png');
  await sleep(150);
  await shot('H3-flash-230ms.png');

  const after = await evalJs('terminalCache.get(activeSessionId).terminal.buffer.active.viewportY');
  console.log('viewportY: ' + before + ' -> ' + after);

  // Cleanup
  await evalJs('document.getElementById("tick-debug-style") && document.getElementById("tick-debug-style").remove()');

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR:', e); process.exit(1); });
