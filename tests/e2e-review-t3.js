#!/usr/bin/env node
// T3: pendingReviewId 注入验证
// 验证审查完成后 pendingReviewId 被设置，下次发消息给 Claude 时自动注入系统提示，消费一次后清空。
'use strict';
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CDP_PORT = 9275;
const DATA_DIR = path.join('C:\\Users\\lintian\\AppData\\Local\\Temp', 'hub-t3-' + Date.now());
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'review-t3');

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
  var raw = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); return m ? JSON.stringify({pendingReviewId:m.pendingReviewId, driverSessionId:m.driverSessionId, subSessions:m.subSessions}) : '{}'; })()");
  return JSON.parse(raw);
}
async function getRingBuf(sid) {
  return await evalJs("(async function(){ var ipc = require('electron').ipcRenderer; try { return await ipc.invoke('get-ring-buffer','" + sid + "') || ''; } catch(e) { return ''; } })()");
}
async function clickTabByLabel(label) {
  await evalJs("(function(){ var tabs = document.querySelectorAll('.mr-tab'); for(var i=0;i<tabs.length;i++){if(tabs[i].textContent.indexOf('" + label + "')>=0){tabs[i].click();break;}} })()");
}

async function main() {
  log('=== T3: pendingReviewId 注入验证 ===');
  log('CDP port: ' + CDP_PORT);
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

  // ============ Step 1: 创建会议室 ============
  log('--- Step 1: 创建主驾会议室 ---');
  await evalJs("(function(){ var btn = document.querySelector('.new-session-option[data-kind=\"meeting\"]'); if(btn) btn.click(); })()");
  await sleep(500);
  await evalJs("document.getElementById('create-meeting-confirm').click()");
  await sleep(8000);

  var meetingId = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.driverMode;}); return m ? m.id : null; })()");
  if (!meetingId) { log('FATAL: 会议创建失败'); return; }
  log('会议 ID: ' + meetingId);

  // ============ Step 2: 等 CLI 就绪 ============
  log('--- Step 2: 等待所有 CLI 就绪 ---');
  for (var w = 0; w < 40; w++) {
    var info = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); if(!m) return '[]'; var arr=[]; for(var i=0;i<m.subSessions.length;i++){var sid=m.subSessions[i]; var s=sessions.get(sid); var b=0; try{var buf=await ipc.invoke('get-ring-buffer',sid);b=(buf||'').length;}catch(e){} arr.push({sid:sid,kind:s?s.kind:'?',b:b});} return JSON.stringify(arr); })()");
    var subs = JSON.parse(info);
    var readyCount = subs.filter(function(s){return s.b>=1000;}).length;
    log('CLIs: ' + subs.map(function(s){return s.kind+'='+s.b+'b';}).join(', ') + ' (' + readyCount + '/' + subs.length + ')');
    if (readyCount === subs.length) break;
    await sleep(3000);
  }

  // ============ Step 3: 触发 @review 并等完成 ============
  log('--- Step 3: 触发 @review 等审查完成 ---');
  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='@review 检查项目状态';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  await sleep(2000);

  // 等审查完成（最多 5 分钟）
  var startMs = Date.now();
  var reviewId = null;
  while (Date.now() - startMs < 300000) {
    var st = await getMeetingState(meetingId);
    if (st.pendingReviewId) { reviewId = st.pendingReviewId; break; }
    await sleep(5000);
  }
  if (!reviewId) { log('FATAL: 审查未完成'); return; }
  log('审查完成，reviewId = ' + reviewId + '，耗时 ' + Math.round((Date.now()-startMs)/1000) + 's');

  result('T3a pendingReviewId 已设置', !!reviewId, reviewId);
  await shot('T3a-pending-review-set.png');

  // ============ Step 4: 发普通消息 "继续"（关键验证：注入） ============
  log('--- Step 4: 发普通消息"继续"（关键验证：注入） ---');
  var st = await getMeetingState(meetingId);
  var claudeSid = st.driverSessionId;
  log('Claude sid: ' + claudeSid);

  await clickTabByLabel('Claude');
  await sleep(500);

  var bufBefore = await getRingBuf(claudeSid);
  log('Claude buf before: ' + bufBefore.length + ' bytes');

  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='继续';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  await sleep(6000); // 等 Claude 接收

  var bufAfter = await getRingBuf(claudeSid);
  log('Claude buf after: ' + bufAfter.length + ' bytes');

  // delta = 新增的部分（buf 是 ring buffer，但容量足够大不会翻转）
  var delta = bufAfter.slice(bufBefore.length);
  log('Buf delta length: ' + delta.length + ' bytes');

  var hasFullInjected = delta.indexOf('[系统提示] 副驾审查已完成') >= 0;
  var hasReviewPath = delta.indexOf('.arena/reviews/' + reviewId) >= 0;
  var hasUserText = delta.indexOf('继续') >= 0;

  result('T3b Claude 收到的输入含完整注入文本', hasFullInjected, hasFullInjected ? 'OK' : ('delta前300字: ' + delta.slice(0, 300).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')));
  result('T3c Claude 收到的输入含完整 review 文件路径', hasReviewPath, '.arena/reviews/' + reviewId + '.md');
  result('T3d Claude 收到的输入含原始用户文本', hasUserText, '继续');

  // 验证 pendingReviewId 已清空
  var stAfter = await getMeetingState(meetingId);
  result('T3e pendingReviewId 已清空（消费一次）', stAfter.pendingReviewId === null, 'pendingReviewId=' + stAfter.pendingReviewId);

  await shot('T3bcd-claude-injected.png');

  // ============ Step 5: 再发"OK"，验证不重复注入 ============
  log('--- Step 5: 再发"OK"，验证不重复注入 ---');
  var bufBefore2 = await getRingBuf(claudeSid);
  log('Claude buf before "OK": ' + bufBefore2.length + ' bytes');

  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='OK';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  await sleep(5000);

  var bufAfter2 = await getRingBuf(claudeSid);
  var delta2 = bufAfter2.slice(bufBefore2.length);
  log('Buf delta2 length: ' + delta2.length + ' bytes');

  // 精确匹配完整注入文本（避免 Claude 回复中引用"系统提示"四字造成误判）
  var hasInjectedFullText = delta2.indexOf('[系统提示] 副驾审查已完成') >= 0;
  var hasInjectedReviewPath = delta2.indexOf('.arena/reviews/' + reviewId) >= 0;
  var hasOkText = delta2.indexOf('OK') >= 0;

  result('T3f 第二次普通消息不再注入完整系统提示', !hasInjectedFullText, hasInjectedFullText ? '错误：仍含完整注入文本' : '干净');
  result('T3f-extra 第二次不再注入 review 路径', !hasInjectedReviewPath, hasInjectedReviewPath ? '错误：仍含路径' : '干净');
  result('T3f-input Claude 收到原始 "OK"', hasOkText, 'OK');

  await shot('T3f-claude-second-no-inject.png');

  // ============ 汇总 ============
  log('');
  log('=== T3 汇总 ===');
  log('Hub 保持运行在 CDP port ' + CDP_PORT);
  log('Hub data dir: ' + DATA_DIR);
  log('截图目录: ' + SHOT_DIR);
  log('reviewId: ' + reviewId);
  log('完成后手动关闭 Hub 窗口即可。');

  if (ws) try { ws.close(); } catch(e) {}
}

main().catch(function(e) { console.error(e); });
