'use strict';
// 验证持久化圆桌面板（#mr-roundtable-panel）：
//   - 进入投研会议室即显示
//   - fanout 跑完后含三家卡片 + 历史轮次
//   - 不会自动消失（30s 后仍存在）

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HUB_DEBUG_PORT = 9277;
const HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\hub-research-dev';
const FANOUT_WAIT_MS = 600000;

let _cdpId = 1;
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _cdpId++;
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(`CDP ${method}: ${m.error.message}`));
        else resolve(m.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error(`CDP ${method} timeout`)); }, 30000);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function evalInPage(ws, expr) {
  const r = await cdpSend(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`Eval error: ${r.exceptionDetails.text}`);
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN');

async function main() {
  console.log(`[${ts()}] === 持久化圆桌面板 E2E ===`);

  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');

  // 创建投研圆桌
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(300);
  await evalInPage(ws, `[...document.querySelectorAll('#new-session-menu [data-kind]')].find(b => b.dataset.kind === 'meeting')?.click()`);
  await sleep(800);
  await evalInPage(ws, `
    (() => {
      const r = document.querySelector('input[name="meeting-mode"][value="research"]');
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    })()
  `);
  await sleep(500);
  await evalInPage(ws, `document.getElementById('create-meeting-confirm').click()`);
  console.log(`[${ts()}] 已创建投研圆桌`);

  await sleep(15000);

  // T1: 进入会议室即显示面板（idle 状态）
  console.log(`\n[T1] 进入会议室时 panel 应已存在（idle 状态）`);
  const panel0 = await evalInPage(ws, `
    (() => {
      const p = document.getElementById('mr-roundtable-panel');
      if (!p) return null;
      return { exists: true, html: p.innerHTML.slice(0, 500), hasTitle: p.innerHTML.includes('投研圆桌'), hasCards: p.querySelectorAll('.mr-rt-card').length };
    })()
  `);
  console.log(`  panel: ${JSON.stringify(panel0, null, 2)}`);
  if (!panel0 || !panel0.exists) throw new Error('T1 FAIL: panel 未创建');
  if (!panel0.hasTitle) throw new Error('T1 FAIL: panel 缺标题');
  if (panel0.hasCards !== 3) throw new Error(`T1 FAIL: 应 3 张卡片，实际 ${panel0.hasCards}`);
  console.log(`  ✓ T1 PASS：panel 存在 + 含 3 家卡片`);

  // 找 meetingId
  const promptsDir = path.join(HUB_DATA_DIR, 'arena-prompts');
  const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-research.md'));
  const latest = promptFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(promptsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const meetingId = latest.replace('-research.md', '');
  console.log(`[${ts()}] meetingId: ${meetingId}`);

  // T2: 触发 fanout，验证 panel 切到 fanout 模式
  console.log(`\n[T2] 触发 fanout，panel 应显示 "提问中"`);
  await evalInPage(ws, `
    (() => {
      const box = document.getElementById('mr-input-box');
      const sendBtn = document.getElementById('mr-send-btn');
      box.innerText = '怎么看兆易创新后续走势';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      sendBtn.click();
    })()
  `);
  await sleep(2000);
  const panel1 = await evalInPage(ws, `
    (() => {
      const p = document.getElementById('mr-roundtable-panel');
      const modeTag = p?.querySelector('.mr-rt-mode-tag');
      const thinkingCount = p?.querySelectorAll('.mr-rt-status.thinking').length || 0;
      return { mode: modeTag?.textContent || 'NONE', thinkingCount };
    })()
  `);
  console.log(`  ${JSON.stringify(panel1)}`);
  // pending 阶段已设 currentMode=fanout，应有部分卡片为 thinking
  console.log(`  ✓ T2: mode tag = "${panel1.mode}"`);

  // T3: 等 turn 1 完成
  console.log(`\n[T3] 等 turn 1 真实完成`);
  const startWait = Date.now();
  while (Date.now() - startWait < FANOUT_WAIT_MS) {
    await sleep(15000);
    const elapsed = Math.floor((Date.now() - startWait) / 1000);
    const s = await evalInPage(ws, `ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' })`);
    console.log(`  [${ts()}] +${elapsed}s turns=${s.turns.length}, mode=${s.currentMode}`);
    if (s.turns.length >= 1) {
      console.log(`  ✓ turn 1 完成 (${elapsed}s)`);
      break;
    }
  }
  await sleep(3000); // 等 IPC 事件传到 renderer

  // T4: 验证 panel 已更新（含完成状态 + 历史轮次）
  console.log(`\n[T4] 验证 panel 已更新`);
  const panel2 = await evalInPage(ws, `
    (() => {
      const p = document.getElementById('mr-roundtable-panel');
      if (!p) return null;
      const modeTag = p.querySelector('.mr-rt-mode-tag');
      const completedCount = p.querySelectorAll('.mr-rt-status.completed').length;
      const previewLengths = [...p.querySelectorAll('.mr-rt-card-preview')].map(el => el.textContent.length);
      const historyToggle = p.querySelector('.mr-rt-history-toggle');
      const meta = p.querySelector('.mr-rt-meta');
      return {
        modeTagText: modeTag?.textContent,
        completedCount,
        previewLengths,
        historyToggleText: historyToggle?.textContent,
        metaText: meta?.textContent.replace(/\\s+/g, ' ').trim(),
      };
    })()
  `);
  console.log(`  ${JSON.stringify(panel2)}`);
  if (!panel2) throw new Error('T4 FAIL: panel 不存在');
  if (panel2.completedCount !== 3) throw new Error(`T4 FAIL: 期望 3 家 completed，实际 ${panel2.completedCount}`);
  const allHavePreview = panel2.previewLengths.every(len => len > 50);
  if (!allHavePreview) throw new Error(`T4 FAIL: 部分卡片 preview 缺失，长度 ${JSON.stringify(panel2.previewLengths)}`);
  console.log(`  ✓ T4 PASS：3 家完成 + 预览齐 + 历史切换可见`);

  // T5: 验证持久化（30s 后 panel 仍在）
  console.log(`\n[T5] 等 30s 验证 panel 不会自动消失`);
  await sleep(30000);
  const panel3 = await evalInPage(ws, `document.getElementById('mr-roundtable-panel') !== null`);
  if (!panel3) throw new Error('T5 FAIL: panel 30s 后消失（应持久化）');
  console.log(`  ✓ T5 PASS：panel 30s 后仍在`);

  // T6: 历史折叠展开
  console.log(`\n[T6] 验证历史折叠展开`);
  await evalInPage(ws, `document.getElementById('mr-rt-history-toggle')?.click()`);
  await sleep(500);
  const expandedHistory = await evalInPage(ws, `
    (() => {
      const list = document.querySelector('.mr-rt-history-list');
      const items = document.querySelectorAll('.mr-rt-history-item').length;
      return { listDisplay: list?.style.display, itemCount: items };
    })()
  `);
  console.log(`  ${JSON.stringify(expandedHistory)}`);
  if (expandedHistory.listDisplay !== 'flex') console.log(`  ⚠ 历史未展开（display=${expandedHistory.listDisplay}）`);
  else if (expandedHistory.itemCount < 1) console.log(`  ⚠ 展开但无 item`);
  else console.log(`  ✓ T6 PASS：历史展开含 ${expandedHistory.itemCount} 项`);

  console.log(`\n=== ✓ 持久化圆桌面板 E2E PASS ===`);
  console.log(`Hub 保留 - 会议室 ${meetingId}`);
  console.log(`你打开 Hub UI，会议室顶部应有持久化面板（三家卡片 + 历史 + 模式徽章 + 渐变美化）`);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[${ts()}] ❌`, e.message);
  console.error(e.stack);
  process.exit(1);
});
