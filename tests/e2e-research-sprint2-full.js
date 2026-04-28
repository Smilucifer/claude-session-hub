'use strict';
// Sprint 2 完整 E2E：等三家真实 turn-complete + 验证 turn-1.json 三家都有输出
// 运行时间长（5-10 min），run_in_background 跑

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HUB_DEBUG_PORT = 9277;
const HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\hub-research-dev';
const FANOUT_WAIT_MS = 600000; // 10 min

let _cdpId = 1;
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _cdpId++;
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(`CDP ${method} failed: ${m.error.message}`));
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

async function evalInPage(ws, expression) {
  const r = await cdpSend(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`Page eval error: ${r.exceptionDetails.text}`);
  }
  return r.result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString('zh-CN'); }

async function main() {
  console.log('=== Sprint 2 完整 E2E：等三家真实 turn-complete ===');
  console.log(`[${ts()}] 开始`);

  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  if (!renderer) throw new Error('找不到 renderer page');
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');
  console.log(`[${ts()}] CDP 已连`);

  // 创建会议室
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(300);
  await evalInPage(ws, `
    (() => {
      const item = [...document.querySelectorAll('#new-session-menu [data-kind]')].find(b => b.dataset.kind === 'meeting');
      if (item) item.click();
    })()
  `);
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

  const promptsDir = path.join(HUB_DATA_DIR, 'arena-prompts');
  const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-research.md'));
  if (promptFiles.length === 0) throw new Error('找不到 -research.md');
  const latest = promptFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(promptsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const meetingId = latest.replace('-research.md', '');
  console.log(`[${ts()}] meetingId: ${meetingId}`);

  // 触发 fanout
  await evalInPage(ws, `
    (() => {
      const box = document.getElementById('mr-input-box');
      const sendBtn = document.getElementById('mr-send-btn');
      box.innerText = '怎么看兆易创新后续走势';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      sendBtn.click();
    })()
  `);
  console.log(`[${ts()}] 已发送 "怎么看兆易创新后续走势" (fanout 启动)`);

  // 轮询等 turn 1 完成
  const startWait = Date.now();
  let lastReport = 0;
  while (Date.now() - startWait < FANOUT_WAIT_MS) {
    await sleep(10000);
    const elapsed = Math.floor((Date.now() - startWait) / 1000);
    const s = await evalInPage(ws, `ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' })`);
    if (elapsed - lastReport >= 30) {
      console.log(`[${ts()}] +${elapsed}s state: turns=${s.turns.length}, currentTurn=${s.currentTurn}, mode=${s.currentMode}`);
      lastReport = elapsed;
    }
    if (s.turns.length >= 1) {
      console.log(`[${ts()}] ✓ turn 1 完成（耗时 ${elapsed}s）`);
      break;
    }
  }

  // 验证 turn-1.json
  const turn1File = path.join(promptsDir, `${meetingId}-turn-1.json`);
  if (!fs.existsSync(turn1File)) {
    console.error(`❌ ${turn1File} 未生成 — fanout 可能未完成`);
    process.exit(1);
  }
  const turn1 = JSON.parse(fs.readFileSync(turn1File, 'utf-8'));
  console.log(`\n=== turn-1.json 内容 ===`);
  console.log(`mode: ${turn1.mode}`);
  console.log(`userInput: ${turn1.userInput.slice(0, 60)}...`);
  console.log(`三家输出长度：`);
  let allOk = true;
  for (const [sid, text] of Object.entries(turn1.by || {})) {
    const len = (text || '').length;
    const preview = (text || '').slice(0, 80).replace(/\n/g, ' / ');
    console.log(`  ${sid.slice(0,8)}: ${len} 字符  "${preview}..."`);
    if (len < 50) {
      console.log(`    ⚠ 输出过短，可能未完成或被中断`);
      allOk = false;
    }
  }

  if (allOk) {
    console.log(`\n=== ✓ Sprint 2 完整 E2E PASS：三家都正常推进 ===`);
  } else {
    console.log(`\n=== ⚠ 部分 AI 输出过短，请打开 Hub UI 查看具体情况 ===`);
  }
  console.log(`Hub 保留运行：会议室 ${meetingId}`);
  console.log(`turn-1.json: ${turn1File}`);

  ws.close();
  process.exit(allOk ? 0 : 2);
}

main().catch((e) => {
  console.error(`[${ts()}] ❌ E2E 失败:`, e.message);
  console.error(e.stack);
  process.exit(1);
});
