/**
 * E2E Test: Meeting Room v2 Integration
 *
 * Verifies ALL v2 changes:
 *   1. No Split button (only Focus / Blackboard / + 添加)
 *   2. Default Focus mode with full-width terminal
 *   3. Tab status indicators (streaming -> new-output)
 *   4. Sync button in Focus toolbar
 *   5. Blackboard Markdown rendering with per-AI tabs
 *   6. Switch back to Focus — terminal still works
 *
 * Usage:
 *   node tests/e2e-meeting-v2.js
 */
'use strict';

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const CDP_PORT = 9877;
const DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-v2-test';
const SCREENSHOT_DIR = 'C:\\Users\\lintian\\claude-session-hub\\tests\\e2e-proof-screenshots\\meeting-v2';
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';

let ws;
let msgId = 0;
const pending = new Map();
const results = [];
let hubProc = null;

// ── Helpers ──

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

// ── Main ──

async function main() {
  // 0. Prep data dir
  log('=== STEP 0: Prepare isolated data dir ===');
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
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

  // Wait for CDP to be ready (retry up to 30s)
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

  // Extra wait for renderer to finish loading
  await sleep(3000);

  // 2. Connect CDP
  log('=== STEP 2: Connect via CDP ===');
  await connectCDP();
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(1500);

  // 3. Create meeting and add subs
  log('=== STEP 3: Create meeting + add Gemini & Codex subs ===');
  const meetingRaw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const meeting = await ipcRenderer.invoke('create-meeting');
    return JSON.stringify(meeting);
  })()`);
  const meeting = JSON.parse(meetingRaw);
  log(`Meeting created: ${meeting.id} "${meeting.title}"`);

  // Add Gemini sub
  const geminiRaw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const r = await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meeting.id}', kind: 'gemini' });
    return JSON.stringify({ sid: r && r.session ? r.session.id : null, kind: r && r.session ? r.session.kind : null });
  })()`);
  const gemini = JSON.parse(geminiRaw);
  log(`Gemini sub added: ${gemini.sid}`);

  // Add Codex sub
  const codexRaw = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const r = await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meeting.id}', kind: 'codex' });
    return JSON.stringify({ sid: r && r.session ? r.session.id : null, kind: r && r.session ? r.session.kind : null });
  })()`);
  const codex = JSON.parse(codexRaw);
  log(`Codex sub added: ${codex.sid}`);

  // 4. Click meeting in sidebar
  log('=== STEP 4: Open meeting in sidebar ===');
  const clickRes = await evalJs(`(() => {
    const item = document.querySelector('.session-item.meeting');
    if (!item) return JSON.stringify({ found: false });
    item.click();
    return JSON.stringify({ found: true, text: item.innerText.substring(0, 60) });
  })()`);
  log(`Sidebar click: ${clickRes}`);
  await sleep(5000);

  // ────────────────────────────────────────────
  // CHECK 1: No Split button
  // ────────────────────────────────────────────
  log('=== CHECK 1: No Split button ===');
  const headerBtnsRaw = await evalJs(`(() => {
    const btns = document.querySelectorAll('.mr-header-btn');
    const texts = [];
    btns.forEach(b => texts.push(b.textContent.trim()));
    return JSON.stringify(texts);
  })()`);
  const headerBtns = JSON.parse(headerBtnsRaw);
  log(`Header buttons: ${JSON.stringify(headerBtns)}`);
  const hasSplit = headerBtns.some(t => t.toLowerCase().includes('split'));
  record('No Split button', !hasSplit, `Buttons: [${headerBtns.join(', ')}]`);

  const hasFocus = headerBtns.some(t => t.toLowerCase().includes('focus'));
  const hasBlackboard = headerBtns.some(t => t.toLowerCase().includes('blackboard'));
  const hasAdd = headerBtns.some(t => t.includes('添加'));
  record('Has Focus button', hasFocus, '');
  record('Has Blackboard button', hasBlackboard, '');
  record('Has + 添加 button', hasAdd, '');

  // ────────────────────────────────────────────
  // CHECK 2: Default Focus mode
  // ────────────────────────────────────────────
  log('=== CHECK 2: Default Focus mode ===');
  const layoutRaw = await evalJs(`(() => {
    const focusBtn = document.getElementById('mr-btn-focus');
    const isFocusActive = focusBtn ? focusBtn.classList.contains('active') : false;
    const container = document.getElementById('mr-terminals');
    const isFocusMode = container ? container.classList.contains('focus-mode') : false;
    const panel = document.getElementById('meeting-room-panel');
    const panelVisible = panel ? panel.style.display !== 'none' : false;
    return JSON.stringify({ isFocusActive, isFocusMode, panelVisible });
  })()`);
  const layout = JSON.parse(layoutRaw);
  log(`Layout state: ${JSON.stringify(layout)}`);
  record('Default Focus mode active', layout.isFocusActive, '');
  record('Terminals in focus-mode', layout.isFocusMode, '');
  record('Meeting panel visible', layout.panelVisible, '');

  // ────────────────────────────────────────────
  // CHECK 4: Sync button in Focus toolbar
  // ────────────────────────────────────────────
  log('=== CHECK 4: Sync button in Focus toolbar ===');
  const toolbarRaw = await evalJs(`(() => {
    const syncBtn = document.getElementById('mr-sync-btn');
    const syncToggle = document.getElementById('mr-sync-toggle');
    const targetSelect = document.getElementById('mr-target-select');
    const toolbar = document.getElementById('mr-toolbar');
    const toolbarHtml = toolbar ? toolbar.innerHTML : '';
    return JSON.stringify({
      hasSyncBtn: !!syncBtn,
      syncBtnText: syncBtn ? syncBtn.textContent.trim() : null,
      hasSyncToggle: !!syncToggle,
      syncToggleText: syncToggle ? syncToggle.textContent.trim() : null,
      hasTargetSelect: !!targetSelect,
      toolbarSnippet: toolbarHtml.substring(0, 300),
    });
  })()`);
  const toolbar = JSON.parse(toolbarRaw);
  log(`Toolbar: ${JSON.stringify(toolbar)}`);
  record('Sync button exists in Focus toolbar', toolbar.hasSyncBtn, toolbar.syncBtnText);
  record('Sync toggle exists', toolbar.hasSyncToggle, toolbar.syncToggleText);
  record('Target select exists', toolbar.hasTargetSelect, '');

  // Screenshot 1: Focus mode, no split
  const shot1 = await shot('01-focus-no-split.png');

  // ────────────────────────────────────────────
  // CHECK 3: Tab status indicators — send message
  // ────────────────────────────────────────────
  log('=== CHECK 3: Tab status after sending message ===');

  // Check tabs exist before sending
  const tabsBefore = await evalJs(`(() => {
    const tabs = document.querySelectorAll('.mr-tab');
    const info = [];
    tabs.forEach(t => {
      const dot = t.querySelector('.mr-tab-status');
      info.push({
        label: t.textContent.trim().substring(0, 30),
        sid: t.dataset.sid,
        dotClass: dot ? dot.className : 'no-dot',
      });
    });
    return JSON.stringify(info);
  })()`);
  log(`Tabs before send: ${tabsBefore}`);
  const tabsBeforeArr = JSON.parse(tabsBefore);
  record('Tabs exist with status dots', tabsBeforeArr.length >= 2,
    `${tabsBeforeArr.length} tabs found`);
  const allHaveDots = tabsBeforeArr.every(t => t.dotClass.includes('mr-tab-status'));
  record('All tabs have mr-tab-status dot', allHaveDots, '');

  // Type and send "hi"
  log('Sending "hi" to all subs...');
  await evalJs(`(() => {
    const box = document.getElementById('mr-input-box');
    if (box) {
      box.focus();
      box.innerText = 'hi';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return 'set';
  })()`);
  await sleep(200);
  await evalJs(`(() => {
    const btn = document.getElementById('mr-send-btn');
    if (btn) btn.click();
    return 'clicked';
  })()`);

  log('Message sent, waiting 15s for responses...');
  await sleep(15000);

  // Check tab status after sending
  const tabsAfter = await evalJs(`(() => {
    const tabs = document.querySelectorAll('.mr-tab');
    const info = [];
    tabs.forEach(t => {
      const dot = t.querySelector('.mr-tab-status');
      const newBadge = t.querySelector('.new-badge');
      info.push({
        label: t.textContent.trim().substring(0, 30),
        sid: t.dataset.sid,
        dotClass: dot ? dot.className : 'no-dot',
        active: t.classList.contains('active'),
        hasNew: !!newBadge,
        hasNewCls: t.classList.contains('has-new'),
      });
    });
    return JSON.stringify(info);
  })()`);
  log(`Tabs after send: ${tabsAfter}`);
  const tabsAfterArr = JSON.parse(tabsAfter);
  // The non-focused tab should show new-output or streaming
  const nonFocusedTabs = tabsAfterArr.filter(t => !t.active);
  const hasStatusChange = nonFocusedTabs.some(t =>
    t.dotClass.includes('streaming') || t.dotClass.includes('new-output')
  );
  record('Non-focused tab shows status indicator', hasStatusChange || nonFocusedTabs.length === 0,
    nonFocusedTabs.map(t => `${t.label}: ${t.dotClass}`).join('; '));

  // Screenshot 2: After message
  const shot2 = await shot('02-after-message.png');

  // ────────────────────────────────────────────
  // CHECK 5: Blackboard Markdown rendering
  // ────────────────────────────────────────────
  log('=== CHECK 5: Switch to Blackboard ===');
  await evalJs(`(() => {
    const btn = document.getElementById('mr-btn-blackboard');
    if (btn) btn.click();
    return 'clicked';
  })()`);
  await sleep(3000);

  const bbRaw = await evalJs(`(() => {
    const container = document.getElementById('mr-terminals');
    const isBlackboard = container ? container.classList.contains('mr-blackboard') : false;
    const bbTabs = document.querySelectorAll('.mr-bb-tab');
    const tabLabels = [];
    bbTabs.forEach(t => tabLabels.push(t.textContent.trim()));
    const content = document.querySelector('.mr-bb-content');
    const markdown = document.querySelector('.mr-bb-markdown');
    const bbBtn = document.getElementById('mr-btn-blackboard');
    const bbActive = bbBtn ? bbBtn.classList.contains('active') : false;
    return JSON.stringify({
      isBlackboard,
      bbActive,
      tabCount: bbTabs.length,
      tabLabels,
      hasContent: !!content,
      hasMarkdown: !!markdown,
      markdownSnippet: markdown ? markdown.innerHTML.substring(0, 200) : null,
      contentSnippet: content ? content.innerHTML.substring(0, 200) : null,
    });
  })()`);
  const bb = JSON.parse(bbRaw);
  log(`Blackboard: ${JSON.stringify(bb)}`);
  record('Blackboard mode active', bb.isBlackboard && bb.bbActive,
    `isBlackboard=${bb.isBlackboard}, bbActive=${bb.bbActive}`);
  record('Blackboard has per-AI tabs', bb.tabCount >= 2,
    `${bb.tabCount} tabs: [${bb.tabLabels.join(', ')}]`);
  record('Blackboard has content area', bb.hasContent, '');
  record('Blackboard has Markdown rendering', bb.hasMarkdown,
    bb.markdownSnippet ? bb.markdownSnippet.substring(0, 80) : 'empty');

  // Screenshot 3: Blackboard
  const shot3 = await shot('03-blackboard.png');

  // ────────────────────────────────────────────
  // CHECK 6: Switch back to Focus
  // ────────────────────────────────────────────
  log('=== CHECK 6: Switch back to Focus ===');
  await evalJs(`(() => {
    const btn = document.getElementById('mr-btn-focus');
    if (btn) btn.click();
    return 'clicked';
  })()`);
  await sleep(2000);

  const focusBackRaw = await evalJs(`(() => {
    const focusBtn = document.getElementById('mr-btn-focus');
    const isFocusActive = focusBtn ? focusBtn.classList.contains('active') : false;
    const container = document.getElementById('mr-terminals');
    const isFocusMode = container ? container.classList.contains('focus-mode') : false;
    const terminal = container ? container.querySelector('.mr-sub-terminal') : null;
    const hasTerminal = !!terminal;
    const syncBtn = document.getElementById('mr-sync-btn');
    const hasSyncBtn = !!syncBtn;
    return JSON.stringify({ isFocusActive, isFocusMode, hasTerminal, hasSyncBtn });
  })()`);
  const focusBack = JSON.parse(focusBackRaw);
  log(`Focus back: ${JSON.stringify(focusBack)}`);
  record('Focus mode restored after Blackboard', focusBack.isFocusActive && focusBack.isFocusMode,
    `active=${focusBack.isFocusActive}, focusMode=${focusBack.isFocusMode}`);
  record('Terminal still present', focusBack.hasTerminal, '');
  record('Sync button still in toolbar', focusBack.hasSyncBtn, '');

  // Screenshot 4: Back to Focus
  const shot4 = await shot('04-back-to-focus.png');

  // ────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────
  log('\n========================================');
  log('  Meeting Room v2 E2E Results');
  log('========================================');
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  for (const r of results) {
    log(`  [${r.status}] ${r.name}${r.detail ? ' -- ' + r.detail : ''}`);
  }
  log(`\n  Total: ${passCount} PASS, ${failCount} FAIL`);
  log('========================================\n');

  // Save results JSON
  const resultsPath = path.join(SCREENSHOT_DIR, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({ results, passCount, failCount, timestamp: new Date().toISOString() }, null, 2));
  log(`Results saved to: ${resultsPath}`);

  // Open screenshots for user
  log('Opening screenshots...');
  const screenshotsToOpen = [shot1, shot4];
  for (const fp of screenshotsToOpen) {
    try {
      execSync(`start "" "${fp}"`, { shell: true });
    } catch {}
  }

  // Cleanup
  cleanup();

  process.exit(failCount > 0 ? 1 : 0);
}

function cleanup() {
  log('Cleaning up...');
  if (ws) {
    try { ws.close(); } catch {}
  }
  if (hubProc) {
    try {
      // Kill the hub process tree
      execSync(`taskkill /PID ${hubProc.pid} /T /F`, { stdio: 'ignore' });
    } catch {}
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
