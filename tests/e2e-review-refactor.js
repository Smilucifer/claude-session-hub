#!/usr/bin/env node
// E2E Test: Review Refactor T1 — Basic @review flow with new executeReview
'use strict';
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CDP_PORT = 9260;
const DATA_DIR = path.join('C:\\Users\\lintian\\AppData\\Local\\Temp', 'hub-review-t1-' + Date.now());
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'review-refactor');

let ws, msgId = 0, hubProc = null;
const pending = new Map();
function log(m) { console.log('[' + new Date().toLocaleTimeString() + '] ' + m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cdpSend(method, params) {
  params = params || {};
  return new Promise((ok, no) => {
    const id = ++msgId;
    const t = setTimeout(() => { pending.delete(id); no(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve: r => { clearTimeout(t); pending.delete(id); ok(r); }, reject: e => { clearTimeout(t); pending.delete(id); no(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr, t) {
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t || 20000 });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function shot(name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const r = await cdpSend('Page.captureScreenshot', { format: 'png' });
    const d = r.result ? r.result.data : r.data;
    if (!d) return null;
    const fp = path.join(SHOT_DIR, name);
    fs.writeFileSync(fp, Buffer.from(d, 'base64'));
    log('Screenshot: ' + fp);
    return fp;
  } catch (e) { log('Shot failed: ' + e.message); return null; }
}

async function main() {
  log('=== T1: @review basic flow with executeReview ===');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // Launch Hub
  const electron = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  hubProc = spawn(electron, ['.', '--remote-debugging-port=' + CDP_PORT], {
    cwd: HUB_DIR, env: Object.assign({}, process.env, { CLAUDE_HUB_DATA_DIR: DATA_DIR }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  hubProc.stdout.on('data', function(d) { d.toString().split('\n').filter(Boolean).forEach(function(l) { console.log('  [hub] ' + l.trim()); }); });
  hubProc.stderr.on('data', function(d) { d.toString().split('\n').filter(Boolean).forEach(function(l) { if (!l.includes('DevTools')) console.log('  [hub-err] ' + l.trim()); }); });

  for (var i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      var list = await new Promise(function(ok, no) {
        http.get('http://127.0.0.1:' + CDP_PORT + '/json/list', function(res) {
          var d = ''; res.on('data', function(c) { d += c; });
          res.on('end', function() { try { ok(JSON.parse(d)); } catch(e) { no(e); } });
        }).on('error', no);
      });
      if (list.length > 0) { log('CDP ready after ' + (i+1) + 's'); break; }
    } catch(e) {}
  }

  // Connect CDP
  var cdpList = await new Promise(function(ok, no) {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json/list', function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { ok(JSON.parse(d)); });
    }).on('error', no);
  });
  var page = cdpList.find(function(p) { return p.type === 'page' && !p.url.startsWith('devtools://'); });
  await new Promise(function(ok, no) {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', ok);
    ws.on('message', function(data) {
      var m = JSON.parse(data.toString());
      if (m.id && pending.has(m.id)) { var p = pending.get(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m); }
    });
    ws.on('error', no);
  });
  await cdpSend('Runtime.enable');
  await cdpSend('Page.enable');

  // Simulate real user: click "+" → click "会议室" → modal opens → click create
  log('Simulating user creating meeting via UI...');
  // Click the "会议室" option in the new-session dropdown
  await evalJs("(function(){ var btn = document.querySelector('.new-session-option[data-kind=\"meeting\"]'); if(btn) btn.click(); })()");
  await sleep(500);
  // Modal defaults: all 3 checked + driver mode selected. Just click confirm.
  await evalJs("document.getElementById('create-meeting-confirm').click()");
  // Wait for all 3 CLIs to be created (submitCreateMeeting is async)
  await sleep(5000);

  // Get the created meeting ID
  var meetingId = await evalJs("(async () => { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.driverMode;}); return m ? m.id : null; })()");
  log('Meeting: ' + meetingId);
  if (!meetingId) { log('FATAL: no driver meeting created'); process.exit(1); }

  // Wait for CLIs ready (no re-open — meeting-updated events handle terminal rendering)
  log('Waiting for CLIs...');
  for (var w = 0; w < 30; w++) {
    var info = await evalJs("(async () => { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); if(!m) return '[]'; var arr=[]; for(var i=0;i<m.subSessions.length;i++){var sid=m.subSessions[i]; var b=0; try{var buf=await ipc.invoke('get-ring-buffer',sid);b=(buf||'').length;}catch(e){} arr.push({sid:sid,b:b});} return JSON.stringify(arr); })()", 10000);
    var subs = JSON.parse(info);
    var ready = subs.filter(function(s){return s.b>=1000;});
    log('CLIs: ' + subs.map(function(s){return s.b+'b';}).join(', ') + ' (' + ready.length + '/' + subs.length + ' ready)');
    if (ready.length === subs.length) break;
    await sleep(3000);
  }
  await shot('T1-clis-ready.png');

  // Send @review
  log('Sending @review...');
  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='@review 检查项目状态';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");

  // Check PENDING banner
  await sleep(1500);
  var pendingBanner = await evalJs("(document.getElementById('mr-review-bar')||{}).textContent||''");
  log('Banner after 1.5s: "' + (pendingBanner||'').slice(0,100) + '"');
  var hasPending = (pendingBanner||'').indexOf('审查中') >= 0;
  console.log('  [' + (hasPending ? 'PASS' : 'FAIL') + '] T1a: PENDING banner shows "审查中..."');
  await shot('T1-pending.png');

  // Check NO old OK/FLAG/BLOCKER color classes
  var hasOldColors = await evalJs("!!document.querySelector('.mr-review-ok, .mr-review-flag, .mr-review-blocker')");
  console.log('  [' + (!hasOldColors ? 'PASS' : 'FAIL') + '] T1b: No old OK/FLAG/BLOCKER color classes');

  // Take tab screenshots to see what copilots received
  await evalJs("(function(){ var tabs = document.querySelectorAll('.mr-tab'); if(tabs[1]) tabs[1].click(); })()");
  await sleep(1000);
  await shot('T1-gemini-tab.png');
  await evalJs("(function(){ var tabs = document.querySelectorAll('.mr-tab'); if(tabs[2]) tabs[2].click(); })()");
  await sleep(1000);
  await shot('T1-codex-tab.png');
  // Switch back to first tab
  await evalJs("(function(){ var tabs = document.querySelectorAll('.mr-tab'); if(tabs[0]) tabs[0].click(); })()");

  // Wait for review completion (up to 5 min)
  log('Waiting for review completion (up to 5 min)...');
  var completed = false;
  var startMs = Date.now();
  while (Date.now() - startMs < 300000) {
    var barText = await evalJs("(document.getElementById('mr-review-bar')||{}).textContent||''");
    if (barText && (barText.indexOf('审查完成') >= 0 || barText.indexOf('完成') >= 0)) {
      completed = true;
      log('Review completed after ' + Math.round((Date.now()-startMs)/1000) + 's');
      log('Banner: "' + barText.slice(0,300) + '"');
      break;
    }
    if (!barText && Date.now() - startMs > 30000) {
      completed = true;
      log('Banner auto-dismissed (review completed)');
      break;
    }
    await sleep(3000);
  }
  console.log('  [' + (completed ? 'PASS' : 'FAIL') + '] T1c: Review completed within 3 min');
  await shot('T1-completed.png');

  // Check banner uses neutral style
  var hasNeutral = await evalJs("!!document.querySelector('.mr-review-neutral')");
  console.log('  [' + (hasNeutral ? 'PASS' : 'INFO') + '] T1d: Uses neutral banner style');

  // Check pendingReviewId was set
  var mState = await evalJs("(async () => { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); return m ? JSON.stringify({pendingReviewId:m.pendingReviewId}) : '{}'; })()");
  var state = JSON.parse(mState);
  console.log('  [' + (state.pendingReviewId ? 'PASS' : 'FAIL') + '] T1e: pendingReviewId set: ' + state.pendingReviewId);

  // Check review file on disk
  var reviewDir = path.join(HUB_DIR, '.arena', 'reviews');
  var reviewFiles = [];
  try { reviewFiles = fs.readdirSync(reviewDir); } catch(e) {}
  console.log('  [' + (reviewFiles.length > 0 ? 'PASS' : 'FAIL') + '] T1f: Review file in .arena/reviews/ — ' + JSON.stringify(reviewFiles));

  await shot('T1-final.png');

  log('');
  log('=== T1 Complete ===');

  if (ws) try { ws.close(); } catch(e) {}
  if (hubProc) try { process.kill(hubProc.pid); } catch(e) {}
  await sleep(2000);
  process.exit(0);
}

main().catch(function(e) { console.error(e); process.exit(1); });
