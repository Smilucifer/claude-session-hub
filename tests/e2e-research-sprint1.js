'use strict';
// Sprint 1 E2E（修复后）：CDP 真实 UI 操作 + 三处 bug 修复回归验证
// 基础链：+号 → 弹菜单 → 选会议室项 → 选投研圆桌 radio
// 修复验证：
//   T-fix1: 投研模式下三家 checkbox 都 disabled（之前未 disable，用户可手动取消导致 AI 缺失）
//   T-fix2: 切回主驾模式时 disable 状态正确（仅 Claude disabled）
//   T-fix3: reset 按钮 click 真触发（之前 DOMContentLoaded 包裹可能错过）

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HUB_DEBUG_PORT = 9277;
const HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\hub-research-dev';

let _cdpId = 1;
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _cdpId++;
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(`CDP ${method} failed: ${m.error.message || JSON.stringify(m.error)}`));
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
    throw new Error(`Page eval error: ${r.exceptionDetails.text} -- ${JSON.stringify(r.result)}`);
  }
  return r.result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Sprint 1 E2E（修复后）：投研圆桌创建 + 3 处 bug 修复回归 ===');
  console.log(`Hub data dir: ${HUB_DATA_DIR}`);
  console.log(`Hub CDP port: ${HUB_DEBUG_PORT}`);

  // 1. 连 Electron renderer
  console.log('\n[1] 发现 Electron renderer page');
  const pages = await getJson(`http://127.0.0.1:${HUB_DEBUG_PORT}/json/list`);
  const renderer = pages.find(p => p.type === 'page' && p.url.includes('renderer/index.html'));
  if (!renderer) throw new Error('找不到 renderer page');
  console.log(`  ✓ ws=${renderer.webSocketDebuggerUrl}`);

  const ws = new WebSocket(renderer.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');

  // 2. 点 + 号弹菜单 → 点会议室项
  console.log('\n[2] 点 + 号 → 弹菜单 → 点会议室项');
  await evalInPage(ws, `document.getElementById('btn-new').click()`);
  await sleep(300);
  const meetingItem = await evalInPage(ws, `
    (() => {
      const menu = document.getElementById('new-session-menu');
      if (!menu) return { ok: false, reason: 'no menu' };
      const items = [...menu.querySelectorAll('[data-kind]')];
      const meetingItem = items.find(b => b.dataset.kind === 'meeting');
      if (!meetingItem) return { ok: false, reason: 'no meeting item' };
      meetingItem.click();
      return { ok: true };
    })()
  `);
  if (!meetingItem.ok) throw new Error('找不到会议室菜单项: ' + JSON.stringify(meetingItem));
  console.log('  ✓ modal 应已打开');
  await sleep(800);

  // 3. 切到投研圆桌
  console.log('\n[3] 选投研圆桌 radio');
  const switched = await evalInPage(ws, `
    (() => {
      const radio = document.querySelector('input[name="meeting-mode"][value="research"]');
      if (!radio) return false;
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  if (!switched) throw new Error('research radio 不存在');
  console.log('  ✓ research radio 选中');
  await sleep(500);

  // T-fix1: 投研模式下三家 checkbox 都 disabled + checked
  console.log('\n[T-fix1] 投研模式下三家 checkbox 都 disabled + checked');
  const cbState = await evalInPage(ws, `
    (() => {
      const claude = document.querySelector('.create-meeting-cb[data-kind="claude"]');
      const gemini = document.querySelector('.create-meeting-cb[data-kind="gemini"]');
      const codex = document.querySelector('.create-meeting-cb[data-kind="codex"]');
      return {
        claude: { checked: claude?.checked, disabled: claude?.disabled },
        gemini: { checked: gemini?.checked, disabled: gemini?.disabled },
        codex: { checked: codex?.checked, disabled: codex?.disabled },
      };
    })()
  `);
  console.log('  ' + JSON.stringify(cbState));
  if (!cbState.claude.disabled || !cbState.gemini.disabled || !cbState.codex.disabled) {
    throw new Error('T-fix1 FAIL: 投研模式下三家 checkbox 应全 disabled');
  }
  if (!cbState.claude.checked || !cbState.gemini.checked || !cbState.codex.checked) {
    throw new Error('T-fix1 FAIL: 投研模式下三家 checkbox 应全 checked');
  }
  console.log('  ✓ T-fix1 PASS：三家 checkbox 全 disabled + checked');

  // T-fix2: 切回主驾，仅 Claude disabled，Gemini/Codex 可选
  console.log('\n[T-fix2] 切回主驾 → 仅 Claude disabled');
  await evalInPage(ws, `
    (() => {
      const r = document.querySelector('input[name="meeting-mode"][value="driver"]');
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    })()
  `);
  await sleep(300);
  const cbStateDriver = await evalInPage(ws, `
    (() => {
      const claude = document.querySelector('.create-meeting-cb[data-kind="claude"]');
      const gemini = document.querySelector('.create-meeting-cb[data-kind="gemini"]');
      const codex = document.querySelector('.create-meeting-cb[data-kind="codex"]');
      return {
        claude: { disabled: claude?.disabled },
        gemini: { disabled: gemini?.disabled },
        codex: { disabled: codex?.disabled },
      };
    })()
  `);
  console.log('  ' + JSON.stringify(cbStateDriver));
  if (!cbStateDriver.claude.disabled) throw new Error('T-fix2 FAIL: 主驾下 Claude 应 disabled');
  if (cbStateDriver.gemini.disabled || cbStateDriver.codex.disabled) {
    throw new Error('T-fix2 FAIL: 主驾下 Gemini/Codex 不应 disabled（disable 状态从 research 残留）');
  }
  console.log('  ✓ T-fix2 PASS：disable 状态切换无残留');

  // 切回 research 模式（继续后续测试）
  await evalInPage(ws, `
    (() => {
      const r = document.querySelector('input[name="meeting-mode"][value="research"]');
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    })()
  `);
  await sleep(500);

  // 4. 验证 covenant 编辑器
  console.log('\n[4] 验证 covenant 编辑器');
  const covenantState = await evalInPage(ws, `
    (() => {
      const box = document.getElementById('create-meeting-covenant');
      const ta = document.getElementById('create-meeting-covenant-text');
      const desc = document.getElementById('meeting-mode-desc');
      return {
        boxDisplay: box ? box.style.display : 'NO_BOX',
        textareaLen: ta ? ta.value.length : 0,
        textareaSnippet: ta ? ta.value.slice(0, 50) : '',
        desc: desc ? desc.textContent : 'NO_DESC',
      };
    })()
  `);
  console.log('  ' + JSON.stringify(covenantState));
  if (covenantState.boxDisplay !== 'block') throw new Error('T4 FAIL: covenant box 未显示');
  if (covenantState.textareaLen < 100) throw new Error('T4 FAIL: 模板未预填或太短');
  console.log('  ✓ T4 PASS：covenant 编辑器显示 + 模板已预填');

  // T-fix3: reset 按钮 click 真触发（手动改 textarea，再点 reset，验证恢复）
  console.log('\n[T-fix3] reset 按钮真触发（DOMContentLoaded readyState 兜底）');
  await evalInPage(ws, `
    (() => {
      const ta = document.getElementById('create-meeting-covenant-text');
      ta.value = '__USER_MODIFIED__';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  // 验证 input listener 触发（fromTemplate 应被设为 '0'）
  const fromTplAfterInput = await evalInPage(ws, `document.getElementById('create-meeting-covenant-text').dataset.fromTemplate`);
  console.log(`  textarea input 后 fromTemplate=${fromTplAfterInput} (期望 '0' 表示已修改)`);
  if (fromTplAfterInput !== '0') {
    throw new Error('T-fix3 FAIL: textarea input listener 未触发（DOMContentLoaded 时机问题）');
  }
  // 点 reset 按钮
  await evalInPage(ws, `document.getElementById('create-meeting-covenant-reset').click()`);
  await sleep(500);
  const afterReset = await evalInPage(ws, `
    (() => {
      const ta = document.getElementById('create-meeting-covenant-text');
      return {
        value: ta.value.slice(0, 50),
        len: ta.value.length,
        fromTemplate: ta.dataset.fromTemplate,
      };
    })()
  `);
  console.log(`  reset 后: len=${afterReset.len}, fromTemplate=${afterReset.fromTemplate}, snippet="${afterReset.value}"`);
  if (afterReset.value === '__USER_MODIFIED__') {
    throw new Error('T-fix3 FAIL: reset 按钮 click listener 未触发');
  }
  if (afterReset.len < 100) throw new Error('T-fix3 FAIL: reset 后模板未恢复');
  if (afterReset.fromTemplate !== '1') throw new Error('T-fix3 FAIL: reset 后 fromTemplate 应被设为 1');
  console.log('  ✓ T-fix3 PASS：reset 按钮 + textarea input listener 都已绑定');

  // 5. 点击创建
  console.log('\n[5] 点击创建按钮');
  await evalInPage(ws, `document.getElementById('create-meeting-confirm').click()`);
  console.log('  ✓ 已点击');
  await sleep(10000);

  // 6. 扫磁盘验证
  console.log('\n[6] 扫磁盘验证 prompt 文件');
  const promptsDir = path.join(HUB_DATA_DIR, 'arena-prompts');
  if (!fs.existsSync(promptsDir)) throw new Error('arena-prompts 目录不存在');
  const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('-research.md'));
  if (promptFiles.length === 0) throw new Error('找不到 -research.md');
  const latest = promptFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(promptsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const meetingId = latest.replace('-research.md', '');
  const promptFile = path.join(promptsDir, latest);
  const promptContent = fs.readFileSync(promptFile, 'utf-8');
  console.log(`  ✓ meetingId: ${meetingId}`);
  console.log(`  ✓ research.md 大小 ${promptContent.length} 字符`);
  if (!promptContent.includes('Arena Rules — 投研圆桌')) throw new Error('rules 缺失');
  if (!promptContent.includes('立花道雪投研圆桌')) throw new Error('covenant 缺失');
  if (!promptContent.includes('任何一家') || !promptContent.includes('联网能力查询')) throw new Error('联网段缺失');
  if (!promptContent.includes('沙箱') || !promptContent.includes('不要乱改本地代码')) throw new Error('沙箱段缺失');
  console.log('  ✓ T6 PASS：rules + covenant 注入完整');

  console.log('\n=== Sprint 1 E2E（修复后）全部 PASS ===');
  console.log('Hub 保持运行供你查看：');
  console.log(`  数据目录：${HUB_DATA_DIR}`);
  console.log(`  CDP 端口：${HUB_DEBUG_PORT}`);
  console.log(`  会议室 ID：${meetingId}`);
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ E2E 失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
