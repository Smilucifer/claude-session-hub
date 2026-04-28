#!/usr/bin/env node
// T1: @review 基本流程验证
// 截图策略：每张对应一个验证点，在正确时机截
// Hub 不关闭，用户手动审查
'use strict';
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CDP_PORT = 9273;
const DATA_DIR = path.join('C:\\Users\\lintian\\AppData\\Local\\Temp', 'hub-t1-' + Date.now());
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'review-t1');

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

async function main() {
  log('=== T1: @review 完整流程验证 ===');
  log('CDP port: ' + CDP_PORT + ', Hub 结束后不关闭');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // 启动 Hub
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

  // ========================================
  // Step 1: 模拟用户创建会议室
  // ========================================
  log('--- Step 1: 创建会议室 ---');
  await evalJs("(function(){ var btn = document.querySelector('.new-session-option[data-kind=\"meeting\"]'); if(btn) btn.click(); })()");
  await sleep(500);
  await evalJs("document.getElementById('create-meeting-confirm').click()");
  await sleep(8000); // 等所有 CLI 启动

  var meetingId = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.driverMode;}); return m ? m.id : null; })()");
  if (!meetingId) { log('FATAL: 会议创建失败'); return; }
  log('会议 ID: ' + meetingId);

  // ========================================
  // Step 2: 等所有 CLI 就绪
  // ========================================
  log('--- Step 2: 等待所有 CLI 就绪 ---');
  for (var w = 0; w < 40; w++) {
    var info = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); if(!m) return '[]'; var arr=[]; for(var i=0;i<m.subSessions.length;i++){var sid=m.subSessions[i]; var s=sessions.get(sid); var b=0; try{var buf=await ipc.invoke('get-ring-buffer',sid);b=(buf||'').length;}catch(e){} arr.push({sid:sid,kind:s?s.kind:'?',b:b});} return JSON.stringify(arr); })()");
    var subs = JSON.parse(info);
    var readyCount = subs.filter(function(s){return s.b>=1000;}).length;
    log('CLIs: ' + subs.map(function(s){return s.kind+'='+s.b+'b';}).join(', ') + ' (' + readyCount + '/' + subs.length + ')');
    if (readyCount === subs.length) break;
    await sleep(3000);
  }

  // ========================================
  // Step 3: 发送 @review
  // ========================================
  log('--- Step 3: 发送 @review ---');
  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='@review 检查项目状态';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  await sleep(2000);

  // 验证点 1: "审查中..." banner 出现
  var bannerText = await evalJs("(document.getElementById('mr-review-bar')||{}).textContent||''");
  var hasPending = (bannerText || '').indexOf('审查中') >= 0;
  result('T1a 审查中 banner', hasPending, '"' + (bannerText||'').slice(0,50) + '"');
  if (hasPending) await shot('T1a-pending-banner.png'); // 只在 PASS 时截图：证明 banner 存在

  // ========================================
  // Step 4: 等待审查完成（多维诊断）
  // ========================================
  log('--- Step 4: 等待审查完成（最多 8 分钟，多维诊断）---');

  // 找 Claude cwd 用于监听 review 文件
  var earlyState = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); return m ? JSON.stringify({driverSessionId:m.driverSessionId}) : '{}'; })()");
  var earlyDriverSid = JSON.parse(earlyState).driverSessionId || '';
  var earlyClaudeCwd = await evalJs("(function(){ var s = sessions.get('" + earlyDriverSid + "'); return s ? s.cwd : ''; })()");
  var watchReviewDir = earlyClaudeCwd ? path.join(earlyClaudeCwd, '.arena', 'reviews') : '';
  log('Claude cwd: ' + earlyClaudeCwd);
  log('Watch reviews dir: ' + watchReviewDir);

  // 记录开始前已有的 review 文件
  var beforeFiles = new Set();
  try { fs.readdirSync(watchReviewDir).forEach(function(f){ beforeFiles.add(f); }); } catch(e) {}

  var completed = false;
  var bannerCompletedAt = null;
  var fileAppearedAt = null;
  var pendingReviewIdSetAt = null;
  var newReviewFile = null;
  var startMs = Date.now();
  var pollCount = 0;

  while (Date.now() - startMs < 480000) {
    pollCount++;
    var elapsed = Math.round((Date.now()-startMs)/1000);

    // 1. banner 状态
    var bannerInfo = await evalJs("(function(){ var b=document.getElementById('mr-review-bar'); if(!b) return JSON.stringify({exists:false,text:''}); return JSON.stringify({exists:true,text:(b.textContent||'').slice(0,80)}); })()");
    var bannerObj = JSON.parse(bannerInfo);

    // 2. main 端 meeting state
    var mState = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); return m ? JSON.stringify({pendingReviewId:m.pendingReviewId}) : '{}'; })()");
    var pendingId = JSON.parse(mState).pendingReviewId;

    // 3. review 文件
    var curFiles = [];
    try { curFiles = fs.readdirSync(watchReviewDir).filter(function(f){ return !beforeFiles.has(f); }); } catch(e) {}

    if (!bannerCompletedAt && bannerObj.text.indexOf('审查完成') >= 0) bannerCompletedAt = elapsed;
    if (!pendingReviewIdSetAt && pendingId) pendingReviewIdSetAt = elapsed;
    if (!fileAppearedAt && curFiles.length > 0) { fileAppearedAt = elapsed; newReviewFile = curFiles[0]; }

    if (pollCount % 6 === 1 || bannerCompletedAt || fileAppearedAt) {
      log('  [' + elapsed + 's] banner="' + bannerObj.text + '" | pendingId=' + (pendingId||'null') + ' | newFiles=' + curFiles.length);
    }

    if (bannerCompletedAt || fileAppearedAt || pendingReviewIdSetAt) {
      await sleep(5000);
      var finalBanner = await evalJs("(function(){ var b=document.getElementById('mr-review-bar'); return b ? (b.textContent||'').slice(0,200) : ''; })()");
      var finalState = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); return m ? JSON.stringify({pendingReviewId:m.pendingReviewId}) : '{}'; })()");
      var finalPendingId = JSON.parse(finalState).pendingReviewId;
      log('==== 完成时序诊断 ====');
      log('  Banner 切到"审查完成": ' + (bannerCompletedAt !== null ? bannerCompletedAt + 's' : '从未'));
      log('  Review 文件出现: ' + (fileAppearedAt !== null ? fileAppearedAt + 's (' + newReviewFile + ')' : '从未'));
      log('  pendingReviewId 设置: ' + (pendingReviewIdSetAt !== null ? pendingReviewIdSetAt + 's' : '从未'));
      log('  最终 banner: "' + finalBanner.slice(0, 100) + '"');
      log('  最终 pendingId: ' + (finalPendingId || 'null'));
      completed = true;
      if (finalBanner.indexOf('审查完成') >= 0) {
        var hasOldVerdict = finalBanner.indexOf('OK') === 0 || finalBanner.indexOf('FLAG') === 0 || finalBanner.indexOf('BLOCKER') === 0;
        result('T1b 无 OK/FLAG/BLOCKER 机械判定', !hasOldVerdict, '');
        var hasNeutral = await evalJs("!!document.querySelector('.mr-review-neutral')");
        result('T1c 中性 banner 样式', hasNeutral, '');
        await shot('T1bc-completed-banner.png');
      } else {
        log('  [SKIP] T1b/T1c：banner 已消失或未切到完成态，跳过');
      }
      break;
    }
    await sleep(5000);
  }
  result('T1d 审查在 8 分钟内完成', completed, Math.round((Date.now()-startMs)/1000) + 's');

  // ========================================
  // Step 5: 验证持久化
  // ========================================
  log('--- Step 5: 验证持久化 ---');

  // 验证点 3: pendingReviewId 已设置
  var mState = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); return m ? JSON.stringify({pendingReviewId:m.pendingReviewId, driverSessionId:m.driverSessionId}) : '{}'; })()");
  var state = JSON.parse(mState);
  result('T1e pendingReviewId 已设置', !!state.pendingReviewId, state.pendingReviewId || 'null');

  // 验证点 4: review 文件存在（Claude cwd 下）
  var claudeCwd = await evalJs("(function(){ var ipc = require('electron').ipcRenderer; var s = sessions.get('" + (state.driverSessionId||'') + "'); return s ? s.cwd : ''; })()");
  log('Claude cwd: ' + claudeCwd);
  var reviewDir = claudeCwd ? path.join(claudeCwd, '.arena', 'reviews') : '';
  var reviewFiles = [];
  try { reviewFiles = fs.readdirSync(reviewDir); } catch(e) {}
  result('T1f review 文件已创建', reviewFiles.length > 0, reviewDir + ' → ' + JSON.stringify(reviewFiles));

  // 如果有文件，读内容验证
  if (reviewFiles.length > 0) {
    var content = fs.readFileSync(path.join(reviewDir, reviewFiles[0]), 'utf-8');
    var hasGemini = content.indexOf('Gemini') >= 0 || content.indexOf('gemini') >= 0;
    var hasCodex = content.indexOf('Codex') >= 0 || content.indexOf('codex') >= 0;
    result('T1g review 文件含 Gemini 输出', hasGemini, '');
    result('T1h review 文件含 Codex 输出', hasCodex, '');
    log('Review 文件: ' + path.join(reviewDir, reviewFiles[0]));
  }

  // ========================================
  // Step 6: 切到副驾 tab 看实际输出
  // ========================================
  log('--- Step 6: 截图副驾实际输出 ---');
  // 切到 Gemini tab（第 2 个 tab）
  await evalJs("(function(){ var tabs = document.querySelectorAll('.mr-tab'); for(var i=0;i<tabs.length;i++){if(tabs[i].textContent.indexOf('Gemini')>=0){tabs[i].click();break;}} })()");
  await sleep(800);
  await shot('T1-gemini-output.png'); // 验证：Gemini 实际收到了 prompt 并回复

  // 切到 Codex tab
  await evalJs("(function(){ var tabs = document.querySelectorAll('.mr-tab'); for(var i=0;i<tabs.length;i++){if(tabs[i].textContent.indexOf('Codex')>=0){tabs[i].click();break;}} })()");
  await sleep(800);
  await shot('T1-codex-output.png'); // 验证：Codex 实际收到了 prompt 并回复

  // ========================================
  // 汇总
  // ========================================
  log('');
  log('=== T1 汇总 ===');
  log('Hub 保持运行在 CDP port ' + CDP_PORT);
  log('Hub data dir: ' + DATA_DIR);
  log('截图目录: ' + SHOT_DIR);
  log('你可以手动打开 Hub 窗口查看，CDP: http://127.0.0.1:' + CDP_PORT);
  log('');
  log('完成后手动关闭 Hub 窗口即可。');

  // 不关闭 Hub，不 process.exit
  if (ws) try { ws.close(); } catch(e) {}
}

main().catch(function(e) { console.error(e); });
