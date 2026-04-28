'use strict';
// Sprint 3 真实 E2E：通过 CDP 模拟真人操作 — 创建投研圆桌 → 输入兆易创新 603986
// → 等 Claude 调 MCP 工具 fetch_lindang_stock → 验证 LinDangAgent 数据被拉到
//
// 严格真人操作：
//   1. 点击 #btn-new（+ 号）
//   2. 在弹出的菜单点 [data-kind=meeting]
//   3. 在 modal 选 input[name=meeting-mode][value=research]
//   4. 点 #create-meeting-confirm
//   5. 等三家 CLI spawn（~15s）
//   6. 在 #mr-input-box 输入"分析兆易创新 603986"
//   7. 点 #mr-send-btn 触发 doSend
//   8. 等 turn 1 真实完成（~5-10 min，首次 LinDangAgent 慢）
//
// 验证：
//   - turn-1.json 落盘
//   - Claude 文本含具体数据（营收 / PE / 兆易创新等关键字）
//   - hookServer log 含 [research] fetch-stock kind=claude（=>MCP 工具被真调）

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HUB_DEBUG_PORT = 9277;
const HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\hub-research-dev';
const TURN_WAIT_MS = 900000; // 15 min（首次 LinDangAgent 5 min + 三家 turn）

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
  if (r.exceptionDetails) throw new Error(`Eval: ${r.exceptionDetails.text}`);
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN');

async function main() {
  console.log(`[${ts()}] === Sprint 3 真实 E2E：模拟真人完整操作 ===`);
  console.log(`[${ts()}] 提问："分析兆易创新 603986"，期望 Claude 调 fetch_lindang_stock MCP 工具`);

  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  if (!renderer) throw new Error('找不到 renderer page');
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');
  console.log(`[${ts()}] CDP 连接 OK`);

  // 1. 真人点 + 号
  console.log(`\n[${ts()}] STEP 1: 点击 #btn-new（+ 号）`);
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(400);

  // 2. 真人在弹出菜单点"会议室"
  console.log(`[${ts()}] STEP 2: 在弹出菜单点 [data-kind=meeting]`);
  const clicked = await evalInPage(ws, `
    (() => {
      const item = [...document.querySelectorAll('#new-session-menu [data-kind]')].find(b => b.dataset.kind === 'meeting');
      if (!item) return { ok: false, reason: '菜单中找不到 meeting 项' };
      item.click();
      return { ok: true };
    })()
  `);
  if (!clicked.ok) throw new Error(clicked.reason);
  await sleep(800);

  // 3. 真人选投研圆桌 radio
  console.log(`[${ts()}] STEP 3: 选 radio[value=research]`);
  await evalInPage(ws, `
    (() => {
      const r = document.querySelector('input[name="meeting-mode"][value="research"]');
      if (!r) throw new Error('找不到 research radio');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(500);

  // 4. 真人点创建
  console.log(`[${ts()}] STEP 4: 点击 #create-meeting-confirm`);
  await evalInPage(ws, `document.getElementById('create-meeting-confirm').click()`);
  console.log(`[${ts()}] 等三家 CLI spawn (15s)`);
  await sleep(15000);

  // 拿 meetingId
  const promptsDir = path.join(HUB_DATA_DIR, 'arena-prompts');
  const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-research.md'));
  const latest = promptFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(promptsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const meetingId = latest.replace('-research.md', '');
  console.log(`[${ts()}] meetingId: ${meetingId}`);

  // 验证 mcp config 文件被写入（Sprint 3 关键标志）
  const mcpFile = path.join(promptsDir, `${meetingId}-research-mcp.json`);
  if (fs.existsSync(mcpFile)) {
    const mcpCfg = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    console.log(`[${ts()}] ✓ Claude MCP 配置已注入：${Object.keys(mcpCfg.mcpServers).join(',')}`);
  } else {
    console.log(`[${ts()}] ⚠ 未找到 mcp config 文件 — Claude 可能没启用 MCP（hookPort 不可用？）`);
  }

  // 5/6/7. 真人在输入框输入 + 点发送
  console.log(`\n[${ts()}] STEP 5-7: 输入"分析兆易创新 603986" + 点 #mr-send-btn`);
  await evalInPage(ws, `
    (() => {
      const box = document.getElementById('mr-input-box');
      const sendBtn = document.getElementById('mr-send-btn');
      box.innerText = '分析兆易创新 603986';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      sendBtn.click();
    })()
  `);
  console.log(`[${ts()}] ✓ fanout 已触发，等三家 turn-complete（最长 15 min）`);

  // 8. 轮询 turn 1 完成
  const startWait = Date.now();
  let lastReport = 0;
  while (Date.now() - startWait < TURN_WAIT_MS) {
    await sleep(20000);
    const elapsed = Math.floor((Date.now() - startWait) / 1000);
    const s = await evalInPage(ws, `ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' })`);
    if (elapsed - lastReport >= 60) {
      console.log(`[${ts()}] +${elapsed}s state turns=${s.turns.length} mode=${s.currentMode}`);
      lastReport = elapsed;
    }
    if (s.turns.length >= 1) {
      console.log(`[${ts()}] ✓ turn 1 完成 (${elapsed}s)`);
      break;
    }
  }

  // 验证 turn-1.json
  const turn1File = path.join(promptsDir, `${meetingId}-turn-1.json`);
  if (!fs.existsSync(turn1File)) {
    console.error(`[${ts()}] ❌ turn-1.json 未生成（fanout 未完成或所有家 timeout）`);
    process.exit(1);
  }
  const turn1 = JSON.parse(fs.readFileSync(turn1File, 'utf-8'));

  console.log(`\n[${ts()}] === turn-1.json 内容分析 ===`);
  for (const [sid, text] of Object.entries(turn1.by || {})) {
    const len = (text || '').length;
    const head = (text || '').slice(0, 80).replace(/\n/g, ' / ');
    console.log(`  ${sid.slice(0, 8)}: ${len} 字符  "${head}..."`);

    // 关键验证：是否含具体数据迹象（数字 + 财务关键字）
    const hasNumber = /\d{2,}\.\d+|\d+亿|\d+%/.test(text || '');
    const hasFinancial = /(营收|净利|PE|PB|RPS|净流入|涨跌幅|毛利)/.test(text || '');
    if (hasNumber && hasFinancial) {
      console.log(`    ✓ 含具体数字 + 财务关键字 → 真用了数据`);
    } else if (len > 500) {
      console.log(`    ⚠ 文本够长但缺具体数字/财务词 → 可能没拿到数据`);
    }
  }

  console.log(`\n[${ts()}] === Sprint 3 E2E 主流程完成 ===`);
  console.log(`Hub 保留：会议室 ${meetingId}`);
  console.log(`决策档案预期：summary 后落到 .arena/sessions/`);
  console.log(`turn-1.json：${turn1File}`);
  console.log(`\n关键验证（请在 Hub log 中确认）：`);
  console.log(`  hookServer 应有：[research] fetch-stock kind=claude elapsed=Nms ok=true`);
  console.log(`  这表示 Claude 真调用了 MCP 工具，而不只是用 WebSearch fallback`);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[${ts()}] ❌ E2E 失败:`, e.message);
  console.error(e.stack);
  process.exit(1);
});
