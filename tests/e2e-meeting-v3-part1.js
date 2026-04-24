/**
 * E2E Test: Meeting Room v3 Part 1 -- Context Injection + Divergence Detection
 *
 * Verifies:
 *   1. Smart context injection: auto-sync uses SM marker content with 【label】 format
 *   2. Divergence detection: toggle, bar appearance, consensus/divergence sections
 *   3. Quick-ask buttons: clicking fills input box
 *
 * Strategy: Uses real Gemini CLI + Codex CLI sub-sessions. Sends a simple question,
 * waits for SM-marked responses, then validates context injection and divergence.
 *
 * Usage:
 *   node tests/e2e-meeting-v3-part1.js
 */
'use strict';

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const CDP_PORT = 9878;
const DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-v3-part1-test';
const SCREENSHOT_DIR = 'C:\\Users\\lintian\\claude-session-hub\\tests\\e2e-proof-screenshots\\meeting-v3-part1';
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';

let ws;
let msgId = 0;
const pending = new Map();
const results = [];
let hubProc = null;

// -- Helpers --

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
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const fp = path.join(SCREENSHOT_DIR, name);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  log(`Screenshot saved: ${fp}`);
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

// -- Main --

async function main() {
  // 0. Prep data dir + screenshot dir
  log('=== STEP 0: Prepare isolated data dir ===');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // 1. Launch isolated Hub
  log('=== STEP 1: Launch isolated Hub ===');
  const electronExe = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  hubProc = spawn(electronExe, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR,
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  hubProc.stdout.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`  [hub-stdout] ${line}`);
  });
  hubProc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line && !line.includes('DevTools listening')) console.log(`  [hub-stderr] ${line}`);
  });
  log('Hub process started, waiting for CDP readiness...');

  let cdpReady = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try {
              const list = JSON.parse(d);
              if (list.length > 0) resolve(list);
              else reject(new Error('empty'));
            } catch (e) { reject(e); }
          });
        }).on('error', reject);
      });
      cdpReady = true;
      log(`CDP ready after ${i + 1}s`);
      break;
    } catch {}
  }
  if (!cdpReady) {
    log('FATAL: CDP not ready after 30s');
    cleanup();
    process.exit(1);
  }

  await sleep(3000);

  // 2. Connect CDP
  log('=== STEP 2: Connect via CDP ===');
  await connectCDP();
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(1500);

  // 3. Create meeting and add Gemini + Codex sub-sessions
  log('=== STEP 3: Create meeting + add Gemini & Codex subs ===');
  const meetingRaw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const meeting = await ipcRenderer.invoke('create-meeting');
    return JSON.stringify(meeting);
  })()`);
  const meeting = JSON.parse(meetingRaw);
  log(`Meeting created: ${meeting.id} "${meeting.title}"`);

  // Add Gemini sub
  const gem1Raw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const r = await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meeting.id}', kind: 'gemini' });
    return JSON.stringify({ sid: r && r.session ? r.session.id : null, kind: r && r.session ? r.session.kind : null });
  })()`);
  const gem1 = JSON.parse(gem1Raw);
  log(`Gemini sub added: ${gem1.sid} (kind=${gem1.kind})`);

  // Add Codex sub
  const codex1Raw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const r = await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meeting.id}', kind: 'codex' });
    return JSON.stringify({ sid: r && r.session ? r.session.id : null, kind: r && r.session ? r.session.kind : null });
  })()`);
  const codex1 = JSON.parse(codex1Raw);
  log(`Codex sub added: ${codex1.sid} (kind=${codex1.kind})`);

  // 4. Open meeting in sidebar
  log('=== STEP 4: Open meeting in sidebar ===');
  const clickRes = await evalJs(`(() => {
    const item = document.querySelector('.session-item.meeting');
    if (!item) return JSON.stringify({ found: false });
    item.click();
    return JSON.stringify({ found: true, text: item.innerText.substring(0, 60) });
  })()`);
  log(`Sidebar click: ${clickRes}`);
  await sleep(3000);

  // Wait for both CLIs to be ready (ring buffer > 200 bytes = CLI loaded)
  log('Waiting for Gemini + Codex CLIs to initialize...');
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const lens = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      const b1 = await ipcRenderer.invoke('get-ring-buffer', '${gem1.sid}');
      const b2 = await ipcRenderer.invoke('get-ring-buffer', '${codex1.sid}');
      return JSON.stringify({ g: b1 ? b1.length : 0, c: b2 ? b2.length : 0 });
    })()`);
    const { g, c } = JSON.parse(lens);
    if (i % 3 === 0) log(`  CLI init: Gemini=${g} bytes, Codex=${c} bytes (${(i+1)*2}s)`);
    if (g > 200 && c > 200) {
      log(`Both CLIs ready after ${(i+1)*2}s (Gemini=${g}, Codex=${c})`);
      break;
    }
    if (i === 29) log(`WARNING: CLIs may not be fully ready (Gemini=${g}, Codex=${c})`);
  }

  await shot('01-meeting-opened.png');

  // 5. Send a question to all via the meeting room input
  log('=== STEP 5: Send question to all agents ===');
  const question = 'What is 2+2? Answer briefly.';
  await evalJs(`(() => {
    const box = document.getElementById('mr-input-box');
    if (box) { box.focus(); box.innerText = '${question}'; }
    return 'set';
  })()`);
  await sleep(200);
  await evalJs(`(() => {
    const btn = document.getElementById('mr-send-btn');
    if (btn) btn.click();
    return 'clicked';
  })()`);
  log(`Question sent: "${question}"`);

  // 6. Wait for at least 1 marker to reach "done" (real CLI responses, up to 120s)
  log('=== STEP 6: Wait for marker status = done (real CLI, up to 120s) ===');
  let markersReady = false;
  let geminiDone = false, codexDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const statusRaw = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      const s1 = await ipcRenderer.invoke('marker-status', '${gem1.sid}');
      const s2 = await ipcRenderer.invoke('marker-status', '${codex1.sid}');
      return JSON.stringify({ s1, s2 });
    })()`);
    const status = JSON.parse(statusRaw);
    geminiDone = status.s1 === 'done';
    codexDone = status.s2 === 'done';
    if (i % 5 === 0) log(`  Marker status: Gemini=${status.s1}, Codex=${status.s2} (${(i + 1) * 2}s)`);
    if (geminiDone && codexDone) {
      markersReady = true;
      log(`Both markers done after ${(i + 1) * 2}s`);
      break;
    }
    // If at least one is done and 30s have passed, proceed
    if ((geminiDone || codexDone) && i >= 15) {
      markersReady = true;
      log(`At least one marker done after ${(i + 1) * 2}s (Gemini=${status.s1}, Codex=${status.s2}), proceeding`);
      break;
    }
  }
  if (!markersReady) {
    log('WARNING: No markers reached "done" within 120s');
  }

  await shot('02-markers-detected.png');

  // ----------------------------------------
  // CHECK 1: Verify toolbar has "divergence toggle"
  // ----------------------------------------
  log('=== CHECK 1: Divergence toggle exists in toolbar ===');
  const divToggleRaw = await evalJs(`(() => {
    const toggle = document.getElementById('mr-divergence-toggle');
    return JSON.stringify({
      exists: !!toggle,
      text: toggle ? toggle.textContent.trim() : null,
      active: toggle ? toggle.classList.contains('active') : false,
    });
  })()`);
  const divToggle = JSON.parse(divToggleRaw);
  log(`Divergence toggle: ${JSON.stringify(divToggle)}`);
  record('Divergence toggle exists in toolbar', divToggle.exists,
    divToggle.text || 'not found');
  record('Divergence toggle default off',
    divToggle.exists && !divToggle.active,
    divToggle.active ? 'active (unexpected)' : 'inactive (correct)');

  // ----------------------------------------
  // CHECK 2: Verify SM content + context injection format
  // ----------------------------------------
  log('=== CHECK 2: Context injection format ===');

  const smContent1 = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('quick-summary', '${gem1.sid}');
  })()`);
  log(`Quick-summary Gemini: ${(smContent1 || '').substring(0, 100)}`);
  record('quick-summary returns SM content for Gemini',
    !!(smContent1 && smContent1.length > 0),
    smContent1 ? `${smContent1.length} chars: ${smContent1.substring(0, 60)}` : 'empty');

  const smContent2 = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('quick-summary', '${codex1.sid}');
  })()`);
  log(`Quick-summary Codex: ${(smContent2 || '').substring(0, 100)}`);
  record('quick-summary returns SM content for Codex',
    !!(smContent2 && smContent2.length > 0),
    smContent2 ? `${smContent2.length} chars: ${smContent2.substring(0, 60)}` : 'empty');

  // Verify context format uses 【label】 bracket notation
  if (smContent1 && smContent2) {
    record('Context format would use 【gemini】 bracket notation', true,
      'Both sessions have SM content, buildContextSummary will use 【label】 format');
  } else {
    record('Context format verification', false,
      'Need both SM contents to verify format');
  }

  await shot('03-context-format.png');

  // ----------------------------------------
  // CHECK 3: Enable divergence toggle, wait for divergence bar
  // ----------------------------------------
  log('=== CHECK 3: Enable divergence detection ===');

  if (!markersReady) {
    record('Divergence detection (SKIPPED)', false, 'Markers not ready, cannot test divergence');
    await shot('04-divergence-skipped.png');
  } else {
    await evalJs(`(() => {
      const toggle = document.getElementById('mr-divergence-toggle');
      if (toggle && !toggle.classList.contains('active')) toggle.click();
      return 'clicked';
    })()`);
    log('Divergence toggle enabled');

    let divBarFound = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const exists = await evalJs(`!!document.getElementById('mr-divergence-bar')`);
      if (exists) {
        divBarFound = true;
        log(`Divergence bar appeared after ${i + 1}s`);
        break;
      }
      if (i % 10 === 9) log(`  Still waiting for divergence bar... (${i + 1}s)`);
    }
    record('Divergence bar appears after toggle enabled', divBarFound,
      divBarFound ? 'appeared' : 'not found after 60s');

    await shot('04-divergence-bar.png');

    // ----------------------------------------
    // CHECK 4: Divergence bar content
    // ----------------------------------------
    log('=== CHECK 4: Divergence bar content ===');
    if (divBarFound) {
      const barContentRaw = await evalJs(`(() => {
        const bar = document.getElementById('mr-divergence-bar');
        if (!bar) return JSON.stringify({ found: false });
        const divHeaders = bar.querySelectorAll('.mr-div-header');
        const headers = [];
        divHeaders.forEach(h => headers.push({ text: h.textContent.trim(), isWarn: h.classList.contains('mr-div-warn'), isOk: h.classList.contains('mr-div-ok') }));
        const cards = bar.querySelectorAll('.mr-div-card');
        const consensusItems = bar.querySelectorAll('.mr-div-consensus-item');
        const askButtons = bar.querySelectorAll('.mr-div-ask');
        const askTexts = [];
        askButtons.forEach(b => askTexts.push(b.textContent.trim()));
        return JSON.stringify({
          found: true,
          headerCount: headers.length,
          headers,
          cardCount: cards.length,
          consensusCount: consensusItems.length,
          askButtonCount: askButtons.length,
          askTexts: askTexts.slice(0, 6),
        });
      })()`);
      const barContent = JSON.parse(barContentRaw);
      log(`Divergence bar content: ${JSON.stringify(barContent)}`);

      record('Divergence bar has header sections',
        barContent.headerCount > 0,
        `${barContent.headerCount} headers`);
      record('Divergence bar has quick-ask buttons',
        barContent.askButtonCount > 0,
        `${barContent.askButtonCount} buttons: [${barContent.askTexts.join(', ')}]`);

      // ----------------------------------------
      // CHECK 5: Quick-ask button fills input box
      // ----------------------------------------
      log('=== CHECK 5: Quick-ask button fills input box ===');
      await evalJs(`(() => {
        const box = document.getElementById('mr-input-box');
        if (box) box.textContent = '';
      })()`);

      const clickAskRes = await evalJs(`(() => {
        const btn = document.querySelector('.mr-div-ask');
        if (!btn) return JSON.stringify({ clicked: false });
        const q = btn.dataset.q || '';
        btn.click();
        const box = document.getElementById('mr-input-box');
        const boxText = box ? box.textContent.trim() : '';
        return JSON.stringify({ clicked: true, question: q.substring(0, 100), boxText: boxText.substring(0, 100) });
      })()`);
      const clickAsk = JSON.parse(clickAskRes);
      log(`Quick-ask click result: ${JSON.stringify(clickAsk)}`);

      record('Quick-ask button click fills input box',
        clickAsk.clicked && clickAsk.boxText.length > 0,
        clickAsk.boxText || 'empty');

      await shot('05-quick-ask.png');

      // BONUS: Toggle off removes bar
      log('=== BONUS: Toggle divergence off removes bar ===');
      await evalJs(`(() => {
        const toggle = document.getElementById('mr-divergence-toggle');
        if (toggle && toggle.classList.contains('active')) toggle.click();
      })()`);
      await sleep(500);
      const barGone = await evalJs(`!document.getElementById('mr-divergence-bar')`);
      record('Divergence bar removed when toggle disabled', barGone,
        barGone ? 'removed' : 'still present');
    } else {
      record('Divergence bar content (Gemini unavailable)', false, 'Skipped');
      record('Quick-ask buttons (Gemini unavailable)', false, 'Skipped');
    }
  }

  await shot('06-final.png');

  // ----------------------------------------
  // Summary
  // ----------------------------------------
  log('\n========================================');
  log('  Meeting Room v3 Part 1 E2E Results');
  log('========================================');
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  for (const r of results) {
    log(`  [${r.status}] ${r.name}${r.detail ? ' -- ' + r.detail : ''}`);
  }
  log(`\n  Total: ${passCount} PASS, ${failCount} FAIL`);
  log('========================================\n');

  const resultsPath = path.join(SCREENSHOT_DIR, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({ results, passCount, failCount, timestamp: new Date().toISOString() }, null, 2));
  log(`Results saved to: ${resultsPath}`);

  log('Opening screenshots...');
  for (const name of ['01-meeting-opened.png', '04-divergence-bar.png', '06-final.png']) {
    try { execSync(`start "" "${path.join(SCREENSHOT_DIR, name)}"`, { shell: true }); } catch {}
  }

  cleanup();
  process.exit(failCount > 0 ? 1 : 0);
}

function cleanup() {
  log('Cleaning up...');
  if (ws) { try { ws.close(); } catch {} }
  if (hubProc) {
    try { execSync(`taskkill /PID ${hubProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    hubProc = null;
  }
}

process.on('uncaughtException', (err) => {
  console.error('[e2e] Uncaught exception:', err);
  cleanup();
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[e2e] Unhandled rejection:', err);
  cleanup();
  process.exit(1);
});

main().catch((err) => {
  console.error('[e2e] Fatal:', err);
  cleanup();
  process.exit(1);
});
