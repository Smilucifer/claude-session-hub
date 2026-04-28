'use strict';
// 验证 codex --no-alt-screen：Codex tab 渲染应紧凑，prompt 框 / status line 不重复污染
// 真实流程：创建会议室 → fanout → 等 turn-complete → 切到 Codex tab → 抓渲染文本 → 统计 TUI 元素

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

async function evalInPage(ws, expression) {
  const r = await cdpSend(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(`Page eval error: ${r.exceptionDetails.text}`);
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN');

async function main() {
  console.log(`[${ts()}] === Codex --no-alt-screen E2E ===`);

  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');

  // 创建会议室
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

  // 拿 meetingId
  const promptsDir = path.join(HUB_DATA_DIR, 'arena-prompts');
  const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-research.md'));
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
  console.log(`[${ts()}] 已发送兆易创新提问 (fanout 启动)`);

  // 等 turn 1 完成
  const startWait = Date.now();
  while (Date.now() - startWait < FANOUT_WAIT_MS) {
    await sleep(10000);
    const elapsed = Math.floor((Date.now() - startWait) / 1000);
    const s = await evalInPage(ws, `ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' })`);
    if (elapsed % 30 === 0) console.log(`[${ts()}] +${elapsed}s turns=${s.turns.length}`);
    if (s.turns.length >= 1) {
      console.log(`[${ts()}] ✓ turn 1 完成 (${elapsed}s)`);
      break;
    }
  }

  // 找 Codex tab sid + 切到 Codex tab
  const subInfo = await evalInPage(ws, `
    (async () => {
      const meeting = await ipcRenderer.invoke('roundtable:get-state', { meetingId: '${meetingId}' });
      // 从 turn-1 by 字段拿三家 sid
      const sids = Object.keys((meeting.turns[0] || {}).by || {});
      // 拿每个 sid 的 kind
      const out = [];
      for (const sid of sids) {
        const tab = document.querySelector(\`button[data-sid="\${sid}"]\`);
        const label = tab ? tab.textContent.trim() : 'unknown';
        out.push({ sid, label });
      }
      return out;
    })()
  `);
  console.log(`[${ts()}] subs: ${JSON.stringify(subInfo)}`);

  const codexSub = subInfo.find(x => x.label.toLowerCase().includes('codex'));
  if (!codexSub) throw new Error('找不到 Codex sub session');
  console.log(`[${ts()}] codex sid: ${codexSub.sid}`);

  // 切到 Codex tab，让 xterm 渲染
  await evalInPage(ws, `document.querySelector('button[data-sid="${codexSub.sid}"]')?.click()`);
  await sleep(2000);

  // 抓 Codex tab 渲染文本（active terminal 的 .xterm-rows）
  const codexRender = await evalInPage(ws, `
    (() => {
      // active terminal 容器是当前显示的 xterm 实例
      const allRows = document.querySelectorAll('.xterm-rows');
      // 过滤可见的（display 不是 none）
      const visibleRows = [...allRows].filter(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && rect.height > 0;
      });
      // 拼所有可见 rows 内容
      return visibleRows.map(el => el.innerText || el.textContent || '').join('\\n=== xterm-rows separator ===\\n');
    })()
  `);

  if (!codexRender || codexRender.length === 0) {
    console.log(`[${ts()}] ⚠ 无法抓到 Codex tab 渲染内容`);
  } else {
    console.log(`[${ts()}] Codex tab 渲染抓到 ${codexRender.length} 字符`);
    const implCount = (codexRender.match(/Implement \{feature\}/g) || []).length;
    const ctxCount = (codexRender.match(/Context \d+%/g) || []).length;
    const gptCount = (codexRender.match(/gpt-5\.5 medium/g) || []).length;
    console.log(`\n=== Codex 渲染 TUI 元素出现次数 ===`);
    console.log(`  "Implement {feature}":  ${implCount} 次`);
    console.log(`  "Context X% ...":       ${ctxCount} 次`);
    console.log(`  "gpt-5.5 medium":       ${gptCount} 次`);
    console.log(`\n--- Codex 渲染前 800 字符（让你看观感） ---`);
    console.log(codexRender.slice(0, 800));
    console.log(`\n--- Codex 渲染最后 800 字符 ---`);
    console.log(codexRender.slice(-800));

    // 修改前：之前用户截图显示 Implement 重复 5+ 次
    // 修改后：应该 ≤ 2 次（启动 banner + 完成时各一次）
    const passed = implCount <= 2;
    console.log(`\n=== ${passed ? '✓ PASS' : '⚠ 仍偏多'}: Implement 出现 ${implCount} 次（期望 ≤2）===`);
  }

  // 同时验证 turn-1.json 的 codex 输出（功能性正确）
  const turn1 = JSON.parse(fs.readFileSync(path.join(promptsDir, `${meetingId}-turn-1.json`), 'utf-8'));
  console.log(`\n=== turn-1.json 中 codex 文本 ===`);
  const codexText = turn1.by[codexSub.sid] || '';
  console.log(`长度: ${codexText.length}`);
  console.log(`前 300 字符: ${codexText.slice(0, 300)}`);

  console.log(`\n[${ts()}] Hub 保留运行 - 会议室 ${meetingId}`);
  console.log(`你可以打开 Hub UI Codex tab 直观对比观感`);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[${ts()}] ❌`, e.message);
  console.error(e.stack);
  process.exit(1);
});
