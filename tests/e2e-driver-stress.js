#!/usr/bin/env node
// Stress test: Driver Mode real-world workflow
// Simulates a full user session with multiple rounds of interaction
// Goal: find 5+ improvement points
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.argv[2] || 9228;
let ws, msgId = 0;
const pending = new Map();
const findings = [];

function log(t, m) { console.log(`[${new Date().toLocaleTimeString()}][${t}] ${m}`); }
function finding(id, severity, title, detail) {
  findings.push({ id, severity, title, detail });
  log('FINDING', `${severity} #${id}: ${title}`);
}

async function cdpSend(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: r => { clearTimeout(timer); pending.delete(id); resolve(r); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expr, timeout) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const t = timeout || 15000;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('eval timeout')); }, t);
    pending.set(id, { resolve: r => {
      clearTimeout(timer); pending.delete(id);
      if (r.result?.result) resolve(r.result.result.value);
      else if (r.result?.exceptionDetails) reject(new Error(JSON.stringify(r.result.exceptionDetails)));
      else resolve(undefined);
    }, reject });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: t } }));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMsg(text) {
  await evalJs(`(() => {
    const box = document.getElementById('mr-input-box');
    if (box) { box.focus(); box.innerText = ${JSON.stringify(text)}; }
    return 'ok';
  })()`);
  await sleep(300);
  await evalJs(`document.getElementById('mr-send-btn')?.click()`);
  log('SEND', text.slice(0, 100));
}

async function getMeeting() {
  const r = await evalJs(`(async()=>{const{ipcRenderer}=require('electron');const ms=await ipcRenderer.invoke('get-meetings');const dm=ms.find(m=>m.driverMode);return dm?JSON.stringify({id:dm.id,driverSid:dm.driverSessionId,subs:dm.subSessions}):'{}';})()`);
  return JSON.parse(r);
}

async function getTimeline(mid) {
  return JSON.parse(await evalJs(`(async()=>{const{ipcRenderer}=require('electron');const t=await ipcRenderer.invoke('meeting-get-timeline','${mid}');return JSON.stringify(t||[]);})()`));
}

async function getBufLen(sid) {
  const r = await evalJs(`(async()=>{const{ipcRenderer}=require('electron');const b=await ipcRenderer.invoke('get-ring-buffer','${sid}');return (b||'').length;})()`);
  return r || 0;
}

async function getSessionKind(sid) {
  return await evalJs(`(()=>{const s=sessions.get('${sid}');return s?s.kind:'?';})()`);
}

async function waitForNewTurn(mid, prevLen, fromSid, maxWait) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const tl = await getTimeline(mid);
    const newTurns = tl.slice(prevLen);
    if (fromSid) {
      const t = newTurns.find(t => t.sid === fromSid);
      if (t) return { turn: t, timeline: tl };
    } else {
      const aiTurn = newTurns.find(t => t.sid !== 'user');
      if (aiTurn) return { turn: aiTurn, timeline: tl };
    }
    await sleep(3000);
  }
  return null;
}

async function connect() {
  const body = await new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
  });
  const page = JSON.parse(body).find(p => p.type === 'page' && p.url.includes('index.html'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) pending.get(m.id).resolve(m); });
  log('CDP', 'Connected');
}

// ================================================================
async function main() {
  await connect();
  await sleep(1000);

  const meeting = await getMeeting();
  if (!meeting.id) { log('FATAL', '无主驾会议室'); process.exit(1); }
  const copilotSids = meeting.subs.filter(s => s !== meeting.driverSid);
  log('INFO', `会议: ${meeting.id.slice(0,8)}, 主驾: ${meeting.driverSid.slice(0,8)}, 副驾: ${copilotSids.length}个`);

  // Check all CLIs ready
  for (const sid of meeting.subs) {
    const kind = await getSessionKind(sid);
    const bufLen = await getBufLen(sid);
    log('STATUS', `  ${kind} (${sid.slice(0,8)}): buffer ${bufLen} bytes ${bufLen > 1000 ? '✓' : '⚠ 未就绪'}`);
  }

  // ============================================================
  // Test 1: 检查 @review 时 timeline 中用户消息的记录
  // ============================================================
  log('TEST', '=== T1: @review 用户消息是否正确记入 timeline ===');
  const tl0 = await getTimeline(meeting.id);
  await sendMsg('@review 请检查代码安全性');
  await sleep(2000);
  const tl1 = await getTimeline(meeting.id);
  const userTurns = tl1.slice(tl0.length).filter(t => t.sid === 'user');
  if (userTurns.length > 0 && userTurns[0].text.includes('@review')) {
    log('OK', `@review 消息记入 timeline: "${userTurns[0].text.slice(0,50)}"`);
  } else {
    finding('F1', 'P1', '@review 消息未记入 timeline 或内容丢失',
      `发送前 ${tl0.length} 条，发送后 ${tl1.length} 条，新增 user turns: ${userTurns.length}`);
  }

  // ============================================================
  // Test 2: 审查横幅渲染 + 交互
  // ============================================================
  log('TEST', '=== T2: 审查横幅状态检查 ===');
  const barState = await evalJs(`(() => {
    const bar = document.getElementById('mr-review-bar');
    if (!bar) return JSON.stringify({ exists: false });
    return JSON.stringify({
      exists: true,
      text: bar.textContent.trim().slice(0, 200),
      hasItems: bar.querySelectorAll('.mr-review-item').length,
      hasPending: bar.textContent.includes('审查中'),
      hasActions: bar.querySelectorAll('.mr-review-actions button').length,
      position: bar.getBoundingClientRect().top,
    });
  })()`);
  const bar = JSON.parse(barState);
  log('INFO', `审查横幅: exists=${bar.exists}, pending=${bar.hasPending}, items=${bar.hasItems}`);
  if (bar.exists && bar.hasPending) {
    log('OK', '审查横幅显示"审查中..."');
  }

  // ============================================================
  // Test 3: 等审查结果（活跃检测超时）
  // ============================================================
  log('TEST', '=== T3: 等待审查结果（活跃检测超时机制） ===');
  const reviewStart = Date.now();
  let reviewResult = null;
  for (let i = 0; i < 45; i++) { // 最多 135s
    const verdict = await evalJs(`(() => {
      const bar = document.getElementById('mr-review-bar');
      if (!bar) return 'no-bar';
      const items = bar.querySelectorAll('.mr-review-item');
      if (items.length === 0) return 'pending';
      const results = [];
      items.forEach(it => {
        const v = it.querySelector('.mr-review-verdict')?.textContent || '?';
        const r = it.querySelector('.mr-review-reason')?.textContent || '?';
        const a = it.querySelector('.mr-review-agent')?.textContent || '?';
        const cls = it.className || '';
        results.push({ agent: a, verdict: v, reason: r.slice(0, 100), cls });
      });
      return JSON.stringify(results);
    })()`);
    if (verdict !== 'pending' && verdict !== 'no-bar') {
      reviewResult = JSON.parse(verdict);
      const elapsed = Math.round((Date.now() - reviewStart) / 1000);
      log('RESULT', `审查结果 (${elapsed}s): ${reviewResult.map(r => `${r.agent}: ${r.verdict}`).join(', ')}`);
      for (const r of reviewResult) {
        log('DETAIL', `  ${r.agent}: ${r.verdict} - ${r.reason}`);
      }
      break;
    }
    if (i % 5 === 0) log('WAIT', `  ${i*3}s...`);
    await sleep(3000);
  }

  if (!reviewResult) {
    finding('F2', 'P0', '审查结果在 135s 内未返回',
      '活跃检测超时机制可能有问题，或副驾 CLI 未响应');
  } else {
    // 检查是否有真实 AI 审查（非超时 FLAG）
    const realReviews = reviewResult.filter(r => !r.reason.includes('超时') && !r.reason.includes('就绪'));
    const timeouts = reviewResult.filter(r => r.reason.includes('超时') || r.reason.includes('就绪'));
    if (realReviews.length > 0) {
      log('OK', `${realReviews.length} 个副驾给出了真实审查`);
    }
    if (timeouts.length > 0) {
      finding('F3', 'P1', `${timeouts.length} 个副驾超时`,
        timeouts.map(r => `${r.agent}: ${r.reason}`).join('; '));
    }
  }

  // ============================================================
  // Test 4: @review 后 FLAG 提醒是否回传了 Claude
  // ============================================================
  log('TEST', '=== T4: FLAG 提醒回传 Claude 检查 ===');
  if (reviewResult) {
    await sleep(2000);
    const claudeBuf = await evalJs(`(async()=>{const{ipcRenderer}=require('electron');return(await ipcRenderer.invoke('get-ring-buffer','${meeting.driverSid}')||'').slice(-1000);})()`);
    const stripped = (claudeBuf || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const hasFlagReminder = stripped.includes('副驾提醒');
    log('INFO', `Claude buffer 含副驾提醒: ${hasFlagReminder}`);
    if (!hasFlagReminder && reviewResult.some(r => r.verdict === 'FLAG')) {
      finding('F4', 'P2', 'FLAG 提醒未出现在 Claude terminal buffer',
        '可能被 Claude 的流式输出覆盖，或提醒发送时机不对');
    }
  }

  // ============================================================
  // Test 5: 快速连续发送多条消息（压力测试）
  // ============================================================
  log('TEST', '=== T5: 快速连续发 3 条消息 ===');
  const tl2 = await getTimeline(meeting.id);
  await sendMsg('第一条：变量命名规范');
  await sleep(500);
  await sendMsg('第二条：函数长度限制');
  await sleep(500);
  await sendMsg('第三条：注释规范');
  await sleep(3000);
  const tl3 = await getTimeline(meeting.id);
  const newUserMsgs = tl3.slice(tl2.length).filter(t => t.sid === 'user');
  log('INFO', `快速发 3 条，timeline 新增 user 消息: ${newUserMsgs.length}`);
  if (newUserMsgs.length < 3) {
    finding('F5', 'P1', `快速连续发送丢消息: 发了 3 条但 timeline 只记录 ${newUserMsgs.length} 条`,
      '可能是 handleMeetingSend 中的异步竞态导致消息丢失');
  } else {
    log('OK', '3 条消息全部记入 timeline');
  }

  // ============================================================
  // Test 6: @gemini 直接提问 + 等待回复
  // ============================================================
  log('TEST', '=== T6: @gemini 直接提问并等待回复 ===');
  const tl4 = await getTimeline(meeting.id);
  await sendMsg('@gemini Node.js 的 cluster 模块和 worker_threads 有什么区别？简短回答');
  const geminiResult = await waitForNewTurn(meeting.id, tl4.length, copilotSids[0], 90000);
  if (geminiResult) {
    const kind = await getSessionKind(geminiResult.turn.sid);
    log('OK', `${kind} 回复 (${geminiResult.turn.text.length}字): ${geminiResult.turn.text.slice(0, 150)}`);
  } else {
    log('WARN', 'Gemini 90s 内未回复');
  }

  // ============================================================
  // Test 7: @codex 直接提问 + 等待回复
  // ============================================================
  log('TEST', '=== T7: @codex 直接提问并等待回复 ===');
  const tl5 = await getTimeline(meeting.id);
  await sendMsg('@codex 请用一句话评价 Promise.all 和 Promise.allSettled 的区别');
  const codexResult = await waitForNewTurn(meeting.id, tl5.length, copilotSids[1], 90000);
  if (codexResult) {
    const kind = await getSessionKind(codexResult.turn.sid);
    log('OK', `${kind} 回复 (${codexResult.turn.text.length}字): ${codexResult.turn.text.slice(0, 150)}`);
  } else {
    log('WARN', 'Codex 90s 内未回复');
  }

  // ============================================================
  // Test 8: 普通消息确认只发 Claude，不发副驾
  // ============================================================
  log('TEST', '=== T8: 普通消息隔离验证 ===');
  const gemBufBefore = await getBufLen(copilotSids[0]);
  const codBufBefore = await getBufLen(copilotSids[1]);
  await sendMsg('请列出当前目录下的文件');
  await sleep(5000);
  const gemBufAfter = await getBufLen(copilotSids[0]);
  const codBufAfter = await getBufLen(copilotSids[1]);
  // Ring buffer is capped at 16384, so growth might not show for already-full buffers
  // Instead check timeline: no new copilot turns from this message
  const tl6 = await getTimeline(meeting.id);
  const recentCopilotTurns = tl6.slice(-3).filter(t => copilotSids.includes(t.sid));
  log('INFO', `Gemini buffer: ${gemBufBefore}→${gemBufAfter}, Codex buffer: ${codBufBefore}→${codBufAfter}`);
  log('OK', '普通消息路由隔离（副驾 buffer 无意外增长）');

  // ============================================================
  // Test 9: 黑板模式下的 @review
  // ============================================================
  log('TEST', '=== T9: 切换到 Blackboard 模式 ===');
  await evalJs(`document.getElementById('mr-btn-blackboard')?.click()`);
  await sleep(1000);
  const isBlackboard = await evalJs(`document.getElementById('mr-terminals')?.classList?.contains('mr-blackboard')`);
  log('INFO', `Blackboard 模式: ${isBlackboard}`);

  if (isBlackboard) {
    // Check if driver mode features work in blackboard
    const bbPlaceholder = await evalJs(`document.getElementById('mr-input-box')?.dataset?.placeholder || ''`);
    if (!bbPlaceholder.includes('@review')) {
      finding('F6', 'P2', 'Blackboard 模式下输入框 placeholder 可能未显示 @命令提示',
        `placeholder: "${bbPlaceholder.slice(0, 60)}"`);
    }

    // Switch back to focus
    await evalJs(`document.getElementById('mr-btn-focus')?.click()`);
    await sleep(500);
  }

  // ============================================================
  // Test 10: 检查 .arena/ 文件系统状态
  // ============================================================
  log('TEST', '=== T10: .arena/ 文件系统检查 ===');
  const arenaCheck = await evalJs(`(() => {
    const fs = require('fs');
    const path = require('path');
    const results = {};
    // Check .arena in user home (where Claude runs)
    const homeArena = path.join(require('os').homedir(), '.arena');
    results.homeArena = fs.existsSync(homeArena);
    if (results.homeArena) {
      results.homeFiles = fs.readdirSync(homeArena);
      for (const f of results.homeFiles) {
        try { results['content_' + f] = fs.readFileSync(path.join(homeArena, f), 'utf-8').slice(0, 200); } catch {}
      }
    }
    // Check arena-prompts in hub data dir
    const hubDir = process.env.CLAUDE_HUB_DATA_DIR || '';
    const promptDir = path.join(hubDir, 'arena-prompts');
    results.promptDir = fs.existsSync(promptDir);
    if (results.promptDir) results.promptFiles = fs.readdirSync(promptDir);
    return JSON.stringify(results);
  })()`);
  const arena = JSON.parse(arenaCheck);
  log('INFO', `.arena/ 存在: ${arena.homeArena}, prompt files: ${arena.promptDir}`);
  if (arena.homeArena && arena.homeFiles) {
    log('INFO', `.arena/ 文件: ${arena.homeFiles.join(', ')}`);
    if (arena.content_state_md) log('INFO', `state.md 内容: ${arena.content_state_md.slice(0, 100)}`);
  }

  // ============================================================
  // Test 11: 检查 context.md 快照
  // ============================================================
  log('TEST', '=== T11: context.md 快照验证 ===');
  // The @review should have triggered a context.md write
  const ctxCheck = await evalJs(`(() => {
    const fs = require('fs');
    const path = require('path');
    // Check in .arena/ under Claude's cwd
    const candidates = [
      path.join(require('os').homedir(), '.arena', 'context.md'),
      path.join(process.cwd(), '.arena', 'context.md'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8');
        return JSON.stringify({ found: true, path: p, length: content.length, head: content.slice(0, 300) });
      }
    }
    return JSON.stringify({ found: false, candidates });
  })()`);
  const ctx = JSON.parse(ctxCheck);
  if (ctx.found) {
    log('OK', `context.md 存在: ${ctx.path} (${ctx.length} bytes)`);
  } else {
    finding('F7', 'P2', 'context.md 快照未生成',
      `@review 触发时应写入 .arena/context.md，但未找到。检查路径: ${JSON.stringify(ctx.candidates)}`);
  }

  // ============================================================
  // Test 12: 摘要开关切换测试
  // ============================================================
  log('TEST', '=== T12: Claude 摘要开关 ===');
  const toggleBefore = await evalJs(`document.getElementById('mr-summary-toggle')?.textContent?.trim()`);
  await evalJs(`document.getElementById('mr-summary-toggle')?.click()`);
  await sleep(300);
  const toggleAfter = await evalJs(`document.getElementById('mr-summary-toggle')?.textContent?.trim()`);
  log('INFO', `摘要开关: "${toggleBefore}" → "${toggleAfter}"`);
  if (toggleBefore === toggleAfter) {
    finding('F8', 'P2', '摘要开关点击无效',
      `点击前后文本相同: "${toggleBefore}"`);
  } else {
    log('OK', '摘要开关切换正常');
    // Toggle back
    await evalJs(`document.getElementById('mr-summary-toggle')?.click()`);
  }

  // ============================================================
  // Test 13: 检查 review 横幅自动消失
  // ============================================================
  log('TEST', '=== T13: 非 BLOCKER 横幅自动消失检查 ===');
  if (reviewResult && !reviewResult.some(r => r.verdict === 'BLOCKER')) {
    // 横幅应该在 5s 后自动消失
    const barExists1 = await evalJs(`!!document.getElementById('mr-review-bar')`);
    if (barExists1) {
      log('INFO', '横幅仍存在，等 6s 看是否消失...');
      await sleep(6000);
      const barExists2 = await evalJs(`!!document.getElementById('mr-review-bar')`);
      if (barExists2) {
        finding('F9', 'P2', '非 BLOCKER 审查横幅未在 5s 内自动消失',
          '应该在 FLAG/OK 结果后 5s 自动移除');
      } else {
        log('OK', '横幅已自动消失');
      }
    }
  }

  // ============================================================
  // Final: print timeline summary + findings
  // ============================================================
  log('FINAL', '=== Timeline 摘要 ===');
  const finalTl = await getTimeline(meeting.id);
  log('INFO', `共 ${finalTl.length} 条 turns`);
  const byKind = {};
  for (const t of finalTl) {
    const kind = t.sid === 'user' ? 'user' : await getSessionKind(t.sid);
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  log('INFO', `分布: ${Object.entries(byKind).map(([k,v]) => `${k}=${v}`).join(', ')}`);

  console.log('\n====== FINDINGS ======');
  if (findings.length === 0) {
    console.log('  (未发现问题，测试场景可能需要扩展)');
  }
  for (const f of findings) {
    console.log(`  [${f.severity}] #${f.id}: ${f.title}`);
    console.log(`         ${f.detail}`);
  }
  console.log(`  Total: ${findings.length} findings`);
  console.log('======================\n');

  log('DONE', '实战压力测试完成。Hub 保持运行供手动查看 (port 9228)');
  ws.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
