#!/usr/bin/env node
// T8: 主驾模式 MCP 升级 E2E
// 验证 Claude 通过 MCP 工具调用触发副驾审查（替代字符串触发）。
'use strict';
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CDP_PORT = 9282;
const DATA_DIR = path.join('C:\\Users\\lintian\\AppData\\Local\\Temp', 'hub-t8-' + Date.now());
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'driver-mcp');

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
  log('=== T8: 主驾模式 MCP E2E ===');
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

  // ============ Step 1: 创建主驾会议室 ============
  log('--- Step 1: 创建主驾会议室 ---');
  await evalJs("(function(){ var btn = document.querySelector('.new-session-option[data-kind=\"meeting\"]'); if(btn) btn.click(); })()");
  await sleep(500);
  await evalJs("document.getElementById('create-meeting-confirm').click()");
  await sleep(8000);

  var meetingId = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.driverMode;}); return m ? m.id : null; })()");
  if (!meetingId) { log('FATAL: 会议创建失败'); return; }
  log('会议 ID: ' + meetingId);

  // T8a: MCP config 文件存在
  var mcpConfigPath = path.join(DATA_DIR, 'arena-prompts', meetingId + '-mcp.json');
  var mcpConfigExists = fs.existsSync(mcpConfigPath);
  result('T8a arena-prompts/<meetingId>-mcp.json 文件已写入', mcpConfigExists, mcpConfigPath);
  if (mcpConfigExists) {
    var cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
    var hasArenaDriver = cfg.mcpServers && cfg.mcpServers['arena-driver'];
    var hasEnv = hasArenaDriver && cfg.mcpServers['arena-driver'].env && cfg.mcpServers['arena-driver'].env.ARENA_HUB_PORT;
    result('T8a-1 mcp config 含 arena-driver server', !!hasArenaDriver, '');
    result('T8a-2 mcp config 含 ARENA_HUB_PORT env', !!hasEnv, hasEnv || '');
  }

  // ============ Step 2: 等待所有 CLI 就绪 ============
  log('--- Step 2: 等待所有 CLI 就绪 ---');
  for (var w = 0; w < 40; w++) {
    var info = await evalJs("(async function() { var ipc = require('electron').ipcRenderer; var ms = await ipc.invoke('get-meetings'); var m = ms.find(function(x){return x.id==='" + meetingId + "';}); if(!m) return '[]'; var arr=[]; for(var i=0;i<m.subSessions.length;i++){var sid=m.subSessions[i]; var s=sessions.get(sid); var b=0; try{var buf=await ipc.invoke('get-ring-buffer',sid);b=(buf||'').length;}catch(e){} arr.push({sid:sid,kind:s?s.kind:'?',b:b});} return JSON.stringify(arr); })()");
    var subs = JSON.parse(info);
    var readyCount = subs.filter(function(s){return s.b>=1000;}).length;
    log('CLIs: ' + subs.map(function(s){return s.kind+'='+s.b+'b';}).join(', ') + ' (' + readyCount + '/' + subs.length + ')');
    if (readyCount === subs.length) break;
    await sleep(3000);
  }

  // T8b: Claude PTY buf 含 --mcp-config（启动命令字符串）
  var st0 = await getMeetingState(meetingId);
  var claudeSid = st0.driverSessionId;
  var claudeBuf = await getRingBuf(claudeSid);
  var hasMcpFlag = claudeBuf.indexOf('--mcp-config') >= 0;
  result('T8b Claude 启动命令含 --mcp-config', hasMcpFlag, hasMcpFlag ? 'OK' : ('claudeBuf 前300字: ' + claudeBuf.slice(0, 300).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')));
  await clickTabByLabel('Claude');
  await sleep(500);
  await shot('T8b-claude-mcp-launch.png');

  // ============ Step 3: 给 Claude 发一条会触发审查的 prompt ============
  log('--- Step 3: 发 prompt 让 Claude 调用 request_review ---');
  // 直接引导 Claude 调用 MCP 工具——验证链路。Claude 应该看到 system prompt 中的规则
  // 加上工具描述，然后实际调用工具。
  var triggerPrompt = '我准备做一个跨 main.js、core/session-manager.js、core/driver-mode.js 三个文件的重构：把 hookPort 重命名为 controlPort。请先调用 request_review 工具请求副驾审查这个改动方案。scope 写"重命名 hookPort→controlPort，跨 3 文件"，open_risks 写"是否有外部脚本依赖 hookPort 字面量需要兼容"。';
  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText=" + JSON.stringify(triggerPrompt) + ";} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  log('prompt 已发送');

  // ============ Step 4: 等 banner 出现"审查中..."（最多 90s—Claude 思考 + 工具调用）============
  log('--- Step 4: 等 banner 出现"审查中..." ---');
  var bannerAppearAt = null;
  var bannerStartMs = Date.now();
  while (Date.now() - bannerStartMs < 90000) {
    var t = await evalJs("(function(){ var b=document.getElementById('mr-review-bar'); return b ? (b.textContent||'').slice(0,80) : ''; })()");
    if (t && t.indexOf('审查中') >= 0) { bannerAppearAt = Math.round((Date.now() - bannerStartMs)/1000); break; }
    await sleep(2000);
  }
  result('T8d banner 出现"审查中..."', bannerAppearAt !== null, bannerAppearAt !== null ? bannerAppearAt + 's' : 'never (90s timeout)');
  if (bannerAppearAt !== null) await shot('T8d-banner-pending.png');

  // T8c: Claude PTY buf 含 request_review（工具调用 UI 块）
  var claudeBufAfter = await getRingBuf(claudeSid);
  var claudeBufNew = claudeBufAfter.slice(claudeBuf.length);
  var hasToolCall = claudeBufNew.indexOf('request_review') >= 0;
  result('T8c Claude PTY 显示了 request_review 工具调用', hasToolCall, hasToolCall ? 'OK' : ('claudeBufNew 前 400 字: ' + claudeBufNew.slice(0, 400).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')));
  await clickTabByLabel('Claude');
  await sleep(500);
  await shot('T8c-claude-tool-use.png');

  // ============ Step 5: 等审查完成（最多 5min）============
  log('--- Step 5: 等审查完成 ---');
  var startMs = Date.now();
  var reviewId = null;
  while (Date.now() - startMs < 300000) {
    var st = await getMeetingState(meetingId);
    if (st.pendingReviewId) { reviewId = st.pendingReviewId; break; }
    await sleep(5000);
  }
  result('T8e 审查在 5min 内完成', reviewId !== null, reviewId || 'never');
  result('T8f pendingReviewId 已设置', !!reviewId, reviewId || 'null');

  if (reviewId) {
    var reviewFilePath = path.join('C:\\Users\\lintian', '.arena', 'reviews', reviewId + '.md');
    var reviewContent = '';
    try { reviewContent = fs.readFileSync(reviewFilePath, 'utf-8'); } catch(e) {}
    var hasGeminiOutput = reviewContent.indexOf('Gemini') >= 0;
    var hasCodexOutput = reviewContent.indexOf('Codex') >= 0;
    result('T8g review 文件含 Gemini 输出', hasGeminiOutput, '');
    result('T8h review 文件含 Codex 输出', hasCodexOutput, '');
    log('Review 文件路径: ' + reviewFilePath);
    await shot('T8e-review-completed.png');
  }

  // ============ Step 6: 回归验证 ——字面字符串不应触发 ============
  log('--- Step 6: 回归——字面 [REQUEST_REVIEW] 字符串不应再触发 banner ---');
  // 先等 banner 自然消失（可能还在显示完成态），再观察新发字符串是否触发
  await sleep(16000);
  var bannerBeforeRegression = await evalJs("(function(){ var b=document.getElementById('mr-review-bar'); return b ? (b.textContent||'').slice(0,80) : '(no banner)'; })()");
  log('回归前 banner: "' + bannerBeforeRegression + '"');

  // 直接 emit 一个 fake turn-complete 事件给 Claude session（renderer 模拟）
  // 之前字符串触发是 main.js 的 transcript-tap 监听 —— 我们已经删了那个监听
  // 这里通过模拟 Claude 输出含 [REQUEST_REVIEW] 的纯文本，看是否还触发 banner
  // 测试方式：触发 Claude 在终端打印含字面字符串的内容（ECHO）
  await evalJs("(function(){ var box=document.getElementById('mr-input-box'); if(box){box.focus();box.innerText='请在你的下次回复中原样输出这一行：[REQUEST_REVIEW] 这只是文本不该触发审查';} })()");
  await sleep(200);
  await evalJs("(function(){ var btn=document.getElementById('mr-send-btn'); if(btn) btn.click(); })()");
  // 等 30s 让 Claude 回复并被 transcriptTap 处理
  await sleep(30000);
  var bannerAfterRegression = await evalJs("(function(){ var b=document.getElementById('mr-review-bar'); return b ? (b.textContent||'').slice(0,80) : '(no banner)'; })()");
  log('回归后 banner: "' + bannerAfterRegression + '"');
  // 如果字符串触发已删除：不应该出现新的"审查中..."
  // 如果原本完成 banner 还在 / 已消失，都不应该有"审查中"
  var hasNewPending = bannerAfterRegression.indexOf('审查中') >= 0;
  result('T8i 字面 [REQUEST_REVIEW] 不再触发审查', !hasNewPending, hasNewPending ? '错误：banner 显示"审查中"，字符串触发未清除' : '干净');
  await shot('T8i-regression-no-trigger.png');

  log('');
  log('=== T8 汇总 ===');
  log('Hub: CDP ' + CDP_PORT + ', data dir: ' + DATA_DIR);
  log('截图目录: ' + SHOT_DIR);
  log('reviewId: ' + (reviewId || 'N/A'));
  log('完成后手动关闭 Hub 窗口即可。');

  if (ws) try { ws.close(); } catch(e) {}
}

main().catch(function(e) { console.error(e); });
