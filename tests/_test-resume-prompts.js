// Test: resume a real Claude session and inspect what character is used for user prompts
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout: ' + method)); } }, 30000);
  });
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const dir = 'C:\\Users\\lintian\\claude-session-hub\\tests\\e2e-proof-screenshots\\resume-prompts';
  fs.mkdirSync(dir, { recursive: true });
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('SHOT:', fp);
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  console.log('Opening resume modal...');
  await evalJs('document.getElementById("btn-resume-picker").click()');
  await sleep(2500);

  // Find a real conversation row (not /clear or /model) and click it
  const chosen = await evalJs([
    '(function() {',
    '  const rows = Array.from(document.querySelectorAll("#resume-list .modal-row"));',
    '  // Find a row whose text contains real Chinese/English content (not slash commands)',
    '  for (const r of rows) {',
    '    const text = r.textContent.trim();',
    '    if (text.length < 50) continue;',
    '    if (text.startsWith("/") || text.includes("The user named")) continue;',
    '    r.click();',
    '    return text.slice(0, 80);',
    '  }',
    '  return "none-found";',
    '})()'
  ].join('\n'));
  console.log('Clicked row:', chosen);

  // Wait for resume to spawn session and replay
  console.log('Waiting for resume + replay...');
  await sleep(15000);

  await shot('R2-after-resume.png');

  const sid = await evalJs('activeSessionId');
  console.log('Active session:', sid);

  // Wait MORE for buffer to populate
  await sleep(3000);

  // Force minimap rescan
  await evalJs('terminalCache.get(activeSessionId)._minimap && terminalCache.get(activeSessionId)._minimap.invalidate()');
  await sleep(2500);

  const ticks = await evalJs('terminalCache.get(activeSessionId)._minimap ? terminalCache.get(activeSessionId)._minimap.getTicks() : "no-minimap"');
  console.log('TICKS in resumed session:', JSON.stringify(ticks));

  // Dump prompt-like lines from buffer
  const promptLines = await evalJs([
    '(function() {',
    '  const c = terminalCache.get(activeSessionId);',
    '  if (!c) return { err: "no cache" };',
    '  const b = c.terminal.buffer.active;',
    '  const out = [];',
    '  for (let i = 0; i < b.length; i++) {',
    '    const line = b.getLine(i);',
    '    if (!line) continue;',
    '    const text = line.translateToString(true);',
    '    if (!text.trim()) continue;',
    '    // Look for lines with prompt-like first chars',
    '    const firstChar = text.match(/\\\\S/);',
    '    if (!firstChar) continue;',
    '    const ch = firstChar[0];',
    '    const code = ch.charCodeAt(0);',
    '    // Output any "interesting" leading chars (not letters/digits/whitespace)',
    '    if (code < 0x20 || code > 0x7E || /[<>=\\\\[\\\\]\\\\{\\\\}#\\\\$@\\\\^&*]/.test(ch) || /[╭╮╯╰│─❯›>]/.test(ch)) {',
    '      const codes = [];',
    '      for (let k = 0; k < Math.min(8, text.length); k++) codes.push(text.charCodeAt(k).toString(16));',
    '      out.push({ i, codes: codes.join(","), preview: text.slice(0, 70) });',
    '      if (out.length >= 30) break;',
    '    }',
    '  }',
    '  return { total: b.length, found: out.length, samples: out };',
    '})()'
  ].join('\n'));
  console.log('PROMPT-LIKE LINES:', JSON.stringify(promptLines, null, 2));

  // Inspect EXACTLY what character is at the start of detected prompt lines
  const promptDetail = await evalJs([
    '(function() {',
    '  const c = terminalCache.get(activeSessionId);',
    '  const b = c.terminal.buffer.active;',
    '  const lines = [438, 451, 471, 560, 681];',
    '  return lines.map(i => {',
    '    const line = b.getLine(i);',
    '    if (!line) return { i, err: "no line" };',
    '    const text = line.translateToString(true);',
    '    const codes = [];',
    '    for (let k = 0; k < Math.min(10, text.length); k++) codes.push(text.charCodeAt(k).toString(16));',
    '    return { i, codes, preview: text.slice(0, 80) };',
    '  });',
    '})()'
  ].join('\n'));
  console.log('PROMPT LINE DETAILS:', JSON.stringify(promptDetail, null, 2));

  // Take cropped screenshot of right edge to show ticks
  const mmRect = await evalJs('(function(){const m=document.querySelector(".terminal-minimap");if(!m)return null;const r=m.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})()');
  console.log('Minimap rect:', JSON.stringify(mmRect));

  await shot('R3-final-state.png');

  if (mmRect && mmRect.w > 0) {
    const croppedR = await cdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: mmRect.x - 200, y: mmRect.y, width: 220, height: mmRect.h, scale: 1 }
    });
    const fp = 'C:\\Users\\lintian\\claude-session-hub\\tests\\e2e-proof-screenshots\\resume-prompts\\R4-minimap-cropped.png';
    fs.writeFileSync(fp, Buffer.from(croppedR.data, 'base64'));
    console.log('SHOT:', fp);
  }

  // Test Ctrl+Up jump
  console.log('=== Testing Ctrl+Up in resumed session ===');
  await evalJs('terminalCache.get(activeSessionId).terminal.scrollToBottom()');
  await sleep(400);
  let prevY = await evalJs('terminalCache.get(activeSessionId).terminal.buffer.active.viewportY');
  console.log('viewportY at bottom:', prevY);

  for (let i = 0; i < 5; i++) {
    await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", ctrlKey: true, bubbles: true, cancelable: true }))');
    await sleep(100);
    await shot('R5-ctrl-up-' + (i+1) + '.png');
    const y = await evalJs('terminalCache.get(activeSessionId).terminal.buffer.active.viewportY');
    console.log('After Ctrl+Up #' + (i+1) + ': viewportY=' + y + ' (jumped ' + (prevY - y) + ' lines)');
    prevY = y;
  }

  // Test Ctrl+Down
  console.log('=== Testing Ctrl+Down ===');
  for (let i = 0; i < 3; i++) {
    await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true, cancelable: true }))');
    await sleep(100);
    const y = await evalJs('terminalCache.get(activeSessionId).terminal.buffer.active.viewportY');
    console.log('After Ctrl+Down #' + (i+1) + ': viewportY=' + y);
  }

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR:', e); process.exit(1); });
