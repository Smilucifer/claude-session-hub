#!/usr/bin/env node
// T4: busy 防重入；T5: .arena/context.md 快照；T6: timeline 审查摘要
'use strict';
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CDP_PORT = 9276;
const DATA_DIR = path.join('C:\\Users\\lintian\\AppData\\Local\\Temp', 'hub-t4-' + Date.now());
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'review-t4-t6');

let ws, msgId = 0, hubProc = null;
const pending = new Map();
function log(m) { console.log('[' + new Date().toLocaleTimeString() + '] ' + m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function result(name, pass, detail) { console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' — ' + detail : '')); }

function cdpSend(method, params) {
  params = params || {};
  return new Promise(function(ok, no) {
    var id = ++msgId;
    var t = setTimeout(function() { pending.delete(id); no(new Error('CDP timeout: ' + method)); }, 25000);
    pending.set(id, { resolve: function(r) { clearTimeout(t); pending.delete(id); ok(r); }, reject: function(e) { clearTimeout(t); pending.delete(id); no(e); } });
    ws.send(JSON.stringify({ id: id, method: method, params: params }));
  });
}
async function evalJs(expr, t) {
  var r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t || 25000 });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function shot(name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    var r = await cdpSend('Page.captureScreenshot', { format: 'png' });
    var d = r.result ? r.result.data : r.data;
    if (!d) return null;
    var fp = path.join(SHOT_DIR, name);
    fs.writeFileSync(fp, Buffer.from(d, 'base64'));
    log('Screenshot: ' + fp);
    return fp;
  } catch (e) { log('Shot failed: ' + e.message); return null; }
}
async function getMeetingState(meetingId) {
  var raw = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); return m ? JSON.stringify({pendingReviewId:m.pendingReviewId, driverSessionId:m.driverSessionId}) : '{}'; })()");
  return JSON.parse(raw);
}
async function getTimeline(meetingId) {
  var raw = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; try { var t = await ipc.invoke('get-meeting-timeline','" + meetingId + "'); return JSON.stringify(t || []); } catch(e) { return '[]'; } })()");
  return JSON.parse(raw);
}

async function main() {
  log('=== T4-T6: busy 防重入 + context.md 快照 + timeline 审查摘要 ===');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  var electron = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
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

  // Step 1: 创建会议室
  log('--- Step 1: 创建主驾会议室 ---');
  await evalJs("(function(){ var btn = document.querySelector('.new-session-option[data-kind=\"meeting\"]'); if(btn) btn.click(); })()");
  await sleep(500);
  await evalJs("document.getElementById('create-meeting-confirm').click()");
  await sleep(8000);

  var meetingId = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.driverMode;}); return m ? m.id : null; })()");
  if (!meetingId) { log('FATAL: 会议创建失败'); return; }
  log('会议 ID: ' + meetingId);

  // Step 2: 等 CLI 就绪
  log('--- Step 2: 等待所有 CLI 就绪 ---');
  for (var w = 0; w < 40; w++) {
    var info = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); if(!m) return '[]'; var arr=[]; for(var i=0;i<m.subSessions.length;i++){var sid=m.subSessions[i]; var s=sessions.get(sid); var b=0; try{var buf=await ipc.invoke('get-ring-buffer',sid);b=(buf||'').length;}catch(e){} arr.push({sid:sid,kind:s?s.kind:'?',b:b});} return JSON.stringify(arr); })()");
    var subs = JSON.parse(info);
    var readyCount = subs.filter(function(s){return s.b>=1000;}).length;
    log('CLIs: ' + subs.map(function(s){return s.kind+'='+s.b+'b';}).join(', ') + ' (' + readyCount + '/' + subs.length + ')');
    if (readyCount === subs.length) break;
    await sleep(3000);
  }

  // 找 Claude cwd
  var st = await getMeetingState(meetingId);
  var claudeCwd = await evalJs("(function(){ var s = sessions.get('" + st.driverSessionId + "'); return s ? s.cwd : ''; })()");
  log('Claude cwd: ' + claudeCwd);
  var arenaContextPath = path.join(claudeCwd, '.arena', 'context.md');
  log('Watch context.md path: ' + arenaContextPath);

  // 记录之前 review 文件数量
  var reviewsDir = path.join(claudeCwd, '.arena', 'reviews');
  var beforeReviewFiles = new Set();
  try { fs.readdirSync(reviewsDir).forEach(function(f){ beforeReviewFiles.add(f); }); } catch(e) {}

  // Step 3: 发第一次 @review
  log('--- Step 3: 发第一次 @review ---');
  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='@review 第一次';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  await sleep(3000); // 让审查启动 + main.js 开始 waitCliReady

  // T5: 检查 .arena/context.md 是否被写入（main.js executeReview 写）
  var contextExists = false;
  var contextSize = 0;
  var contextContent = '';
  try {
    var stat = fs.statSync(arenaContextPath);
    contextExists = true;
    contextSize = stat.size;
    contextContent = fs.readFileSync(arenaContextPath, 'utf-8');
  } catch(e) {}
  result('T5a .arena/context.md 已写入', contextExists, arenaContextPath + ' size=' + contextSize);
  result('T5b context.md 含 timeline 内容', contextExists && contextSize > 50, 'size=' + contextSize);
  if (contextExists) {
    log('context.md 前300字: ' + contextContent.slice(0, 300));
  }

  // Step 4: 立即发第二次 @review（应该 busy）
  log('--- Step 4: 立即发第二次 @review（验证 busy） ---');
  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='@review 第二次';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  await sleep(800); // 短等，捕获 busy banner（5s 后消失）

  var busyBanner = await evalJs("(function(){ var b=document.getElementById('mr-review-bar'); return b ? (b.textContent||'').slice(0,100) : ''; })()");
  log('Banner after 2nd @review: "' + busyBanner + '"');
  var hasBusyText = busyBanner.indexOf('审查进行中') >= 0 || busyBanner.indexOf('请等待') >= 0;
  result('T4a 第二次 @review 被 busy 拒绝', hasBusyText, '"' + busyBanner + '"');
  if (hasBusyText) await shot('T4a-busy-banner.png');

  // Step 5: 等第一次审查完成
  log('--- Step 5: 等第一次审查完成 ---');
  var startMs = Date.now();
  var reviewId = null;
  while (Date.now() - startMs < 300000) {
    var s = await getMeetingState(meetingId);
    if (s.pendingReviewId) { reviewId = s.pendingReviewId; break; }
    await sleep(5000);
  }
  if (!reviewId) { log('FATAL: 第一次审查未完成'); return; }
  log('审查完成 reviewId=' + reviewId + '，耗时 ' + Math.round((Date.now()-startMs)/1000) + 's');

  // T4b: 验证只有一个新 review 文件（不是两个）
  await sleep(2000);
  var afterReviewFiles = [];
  try { afterReviewFiles = fs.readdirSync(reviewsDir).filter(function(f){ return !beforeReviewFiles.has(f); }); } catch(e) {}
  log('新 review 文件: ' + JSON.stringify(afterReviewFiles));
  result('T4b busy 期间只产生 1 个 review 文件（未重入）', afterReviewFiles.length === 1, '产生了 ' + afterReviewFiles.length + ' 个');

  // T6: 验证 timeline 含审查总结 turn
  log('--- Step 6: 验证 timeline 审查摘要 ---');
  var tl = await getTimeline(meetingId);
  log('Timeline 长度: ' + tl.length);
  var summaryTurn = tl.find(function(t){ return typeof t.text === 'string' && t.text.indexOf('**审查完成**') >= 0; });
  result('T6a timeline 含 **审查完成** 摘要 turn', !!summaryTurn, summaryTurn ? '找到 idx=' + summaryTurn.idx : '未找到');
  if (summaryTurn) {
    var txt = summaryTurn.text;
    log('摘要 turn 内容前300字: ' + txt.slice(0, 300));
    var hasGeminiLabel = txt.indexOf('Gemini') >= 0;
    var hasCodexLabel = txt.indexOf('Codex') >= 0;
    result('T6b 摘要含 Gemini 标签', hasGeminiLabel, '');
    result('T6c 摘要含 Codex 标签', hasCodexLabel, '');
  }

  await shot('T6-final-state.png');

  log('');
  log('=== T4-T6 汇总 ===');
  log('Hub: CDP ' + CDP_PORT + ', data dir: ' + DATA_DIR);
  log('截图目录: ' + SHOT_DIR);
  log('reviewId: ' + reviewId);
  log('完成后手动关闭 Hub 窗口即可。');

  if (ws) try { ws.close(); } catch(e) {}
}

main().catch(function(e) { console.error(e); });
