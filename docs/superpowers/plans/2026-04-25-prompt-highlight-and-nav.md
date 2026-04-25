# 终端用户提问高亮与上下导航按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 xterm 终端里的用户提问行视觉显著，并在终端右上角加 ▲▼ 按钮供鼠标用户在提问之间上下跳转，不影响现有任何功能。

**Architecture:** 纯 renderer 层改动。把现有 `mountMinimap` 返回对象扩展出 `navPrev/navNext/canNavPrev/canNavNext` 四个方法，把 keydown 里 Ctrl+↑/↓ 的内联跳转逻辑搬进去，按钮和快捷键共用一份实现。CSS 把 `prompt-line-marker` 单档化、加深背景边框，把 `minimap-tick` 加粗加亮。新增 `mountPromptNavButtons` 创建悬浮按钮组并和 `mountMinimap` 共生命周期。

**Tech Stack:** Electron renderer / xterm.js 5.5 / 原生 DOM + CSS / Hub 现有 CDP+ws 测试模式（`tests/e2e-prompt-jump.js`）

**Spec:** `docs/superpowers/specs/2026-04-25-prompt-highlight-and-nav-design.md`

**Working Directory**: 本计划在 git worktree `C:\Users\lintian\hub-prompt-nav` 下执行（已经创建好；node_modules 通过 `mklink /J` 共享 `C:\Users\lintian\claude-session-hub\node_modules`）。所有 subagent 必须在这个 worktree 目录里跑命令，不得切到主目录 `C:\Users\lintian\claude-session-hub`（那里有另一个会话在工作）。

- worktree 路径：`C:\Users\lintian\hub-prompt-nav`
- 当前分支：`feature/prompt-highlight-and-nav`
- 启动测试 Hub 命令（在 worktree 目录里跑；junction 让 `.\node_modules\` 通到主目录的 electron）：
  ```powershell
  cd C:\Users\lintian\hub-prompt-nav
  $env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\hub-prompt-nav-data"
  .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9229
  ```
- 跑 e2e 命令（在 worktree 目录里跑）：
  ```powershell
  cd C:\Users\lintian\hub-prompt-nav
  node tests/e2e-prompt-jump.js 9229
  ```

**实施前必读**：
- Hub 项目 CLAUDE.md（`C:\Users\lintian\hub-prompt-nav\CLAUDE.md`，worktree 自带一份）的两条铁律：node_modules 完整性 + 隔离 Hub 测试
- 任何代码改动后必须跑冒烟（任务 6 的 smoke test）
- 禁止 `npm install`（除非确实缺包）；禁止动用户生产 Hub
- 启动测试 Hub 用 `CLAUDE_HUB_DATA_DIR` env（必须设到 worktree 外的独立路径如 `C:\Users\lintian\hub-prompt-nav-data`），端口 9229（避开生产 9222 和现有测试 9224/9225）

---

## File Structure

| 路径 | 操作 | 责任 |
|---|---|---|
| `renderer/renderer.js` | 修改 | `mountMinimap` 加四个 nav 方法 + 加 `mountPromptNavButtons` 函数 + keydown Ctrl+↑/↓ 重构调 nav 方法 |
| `renderer/styles.css` | 修改 | `.prompt-line-marker` 单档加深；`.minimap-tick` 加亮；新增 `.prompt-nav-buttons` / `.prompt-nav-btn` 样式 |
| `tests/e2e-prompt-jump.js` | 修改 | 末尾追加新断言：高亮强度、按钮 DOM、按钮点击跳转、边界 disabled、minimap-tick 高度 |
| 其他 | 不动 | — |

`mountPromptNavButtons` 写在 `renderer/renderer.js` 同文件（不新建文件）——和 `mountMinimap` 一样是渲染层的小工具函数，留在同处便于一起读。

---

## Task 1: 在 mountMinimap 闭包内新增 navPrev/navNext + 行内辅助函数

**目标**：把 `renderer.js:942-973` keydown Ctrl+↑/↓ 内联的"找上/下条 prompt + 跳"逻辑抽进 `mountMinimap` 闭包，**先不改 keydown**，让两个新方法独立可用。

**Files:**
- Modify: `renderer/renderer.js`（在 `mountMinimap` 函数 line ~1369 的 `return { ... }` 之前加内部函数；在 return 里加 4 个方法）

**前置说明**：现有 `tests/e2e-prompt-jump.js` 的 Test 2 断言 "Highlight element appears"（line 196-205）——这条**目前是 fail**（因为现状 keydown 没调 `flashPromptLine`）。本任务实现完成后这条仍然 fail（因为 keydown 还没改），Task 2 完成后才会 GREEN。把"按钮直接调 navPrev → flashPromptLine 出现"作为本任务的 RED→GREEN。

- [ ] **Step 1: 启动隔离 Hub（首次启动 Task 用，后续任务 reload 即可）**

打开 PowerShell 在 Hub 项目根目录跑：

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\hub-prompt-nav-data"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9229
```

确认窗口启动 + 控制台打印 `[hub] hook server listening on 127.0.0.1:...`。**保留这个窗口开着**，后续任务通过 CDP reload 即可。

- [ ] **Step 2: 写"按钮 navPrev 触发后 flashPromptLine 出现"的失败断言**

在 `tests/e2e-prompt-jump.js` 的 `// --- Summary ---` 行（约 line 242）**之前**插入：

```javascript
// --- Test 6: navPrev() method directly triggers flashPromptLine ---
log('Test 6: minimap.navPrev() exists and triggers highlight');

await evalJs(`terminalCache.get(activeSessionId).terminal.scrollToBottom()`);
await sleep(200);

// 先把 highlight 元素清掉，避免上一轮残留
await evalJs(`
  (function() {
    const c = terminalCache.get(activeSessionId);
    const container = c.terminal.element.closest('.terminal-container');
    const h = container && container.querySelector('.prompt-highlight');
    if (h) h.style.display = 'none';
  })()
`);
await sleep(100);

const navPrevExists = await evalJs(`
  (function() {
    const c = terminalCache.get(activeSessionId);
    return !!(c && c._minimap && typeof c._minimap.navPrev === 'function');
  })()
`);
record('minimap.navPrev() method exists', navPrevExists === true, String(navPrevExists));

if (navPrevExists) {
  const navResult = await evalJs(`terminalCache.get(activeSessionId)._minimap.navPrev()`);
  record('navPrev() returns true on success', navResult === true, String(navResult));
  await sleep(300);

  const flashAfterNav = await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      const container = c.terminal.element.closest('.terminal-container');
      const h = container && container.querySelector('.prompt-highlight');
      return h ? h.style.display !== 'none' : false;
    })()
  `);
  record('navPrev() triggers flashPromptLine', flashAfterNav === true, String(flashAfterNav));
}

await shot('06-after-navPrev.png');
```

- [ ] **Step 3: 跑测试看 RED**

```powershell
node tests/e2e-prompt-jump.js 9229
```

期望：最后 summary 里 `[FAIL] minimap.navPrev() method exists` —— `false`。其他几条 record 因为 if 短路不输出。

- [ ] **Step 4: 在 mountMinimap 闭包内实现 navPrev/navNext + canNavPrev/canNavNext**

打开 `renderer/renderer.js`，找到 `mountMinimap` 函数末尾的 `return { ... }`（约 line 1369）。在 `return` 之前**插入**以下内部函数：

```javascript
// --- nav helpers (shared by Ctrl+Up/Down keyboard and ▲▼ buttons) ---
function findNavTarget(direction) {
  if (!ticks.length) return null;
  const buf = terminal.buffer.active;
  const hasActive = activeLine >= 0;
  let cur;
  if (hasActive) cur = activeLine;
  else if (direction === 'up') cur = buf.viewportY + terminal.rows;
  else cur = buf.viewportY;
  if (direction === 'up') {
    for (let i = ticks.length - 1; i >= 0; i--) {
      if (ticks[i].line < cur) return ticks[i];
    }
  } else {
    for (let i = 0; i < ticks.length; i++) {
      if (ticks[i].line > cur) return ticks[i];
    }
  }
  return null;
}

function navTo(direction) {
  const target = findNavTarget(direction);
  if (!target) return false;
  try { terminal.scrollToLine(target.line); } catch {}
  activeLine = target.line;
  flashPromptLine(terminal, target.line);
  render();
  // Sync external state field (kept for backward compat with any reader)
  const cache = terminalCache.get(sessionId);
  if (cache) cache._activePromptLine = target.line;
  return true;
}
```

然后修改 `return { ... }` 块，加 4 个方法，**整块替换为**：

```javascript
return {
  invalidate,
  getTicks() { return ticks; },
  setActiveLine(line) { activeLine = line; render(); },
  navPrev() { return navTo('up'); },
  navNext() { return navTo('down'); },
  canNavPrev() { return findNavTarget('up') !== null; },
  canNavNext() { return findNavTarget('down') !== null; },
  dispose() {
    disposed = true;
    if (scanTimer) clearTimeout(scanTimer);
    if (maxDebounceTimer) clearTimeout(maxDebounceTimer);
    try { scrollSub.dispose(); } catch {}
    try { renderSub.dispose(); } catch {}
    if (strip.parentNode) strip.parentNode.removeChild(strip);
    if (promptMarkerLayer && promptMarkerLayer.parentNode) promptMarkerLayer.parentNode.removeChild(promptMarkerLayer);
  },
};
```

- [ ] **Step 5: Reload renderer + 跑测试看 GREEN**

在 Hub 窗口里按 `Ctrl+R`（或 `Ctrl+Shift+I` 打开 DevTools 跑 `location.reload()`），renderer 加载新代码。然后：

```powershell
node tests/e2e-prompt-jump.js 9229
```

期望 summary 里：
- `[PASS] minimap.navPrev() method exists`
- `[PASS] navPrev() returns true on success`
- `[PASS] navPrev() triggers flashPromptLine`
- 现有 5 个 PASS 不能挂

注意：现有 Test 2 的 "Highlight element appears"（Ctrl+Up 触发的）此时**仍 FAIL**（因为 Ctrl+Up keydown 还没改用 navPrev）。Task 2 修。

- [ ] **Step 6: Commit**

```powershell
git add renderer/renderer.js tests/e2e-prompt-jump.js
git commit -m "$(cat <<'EOF'
feat(prompt-nav): add navPrev/navNext to mountMinimap return

Extract the prompt-jump search logic from the keydown handler into
mountMinimap's closure so that ▲▼ buttons (next task) and Ctrl+Up/Down
(refactored next task) can share one implementation. navTo also fires
flashPromptLine for consistent visual feedback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 重构 keydown Ctrl+↑/↓ 调 navPrev/navNext

**目标**：把 `renderer.js:942-973` 的 30 行内联查找跳转逻辑收缩到 6 行，调 `cache._minimap.navPrev()` / `navNext()`。外部行为不变 + 新增 flashPromptLine 反馈（Task 1 已实现在 navTo 里）。

**Files:**
- Modify: `renderer/renderer.js:942-973`

- [ ] **Step 1: Reload Hub + 跑现有测试做基线（确认现状）**

```powershell
node tests/e2e-prompt-jump.js 9229
```

记下 summary：现有 Test 2 "Highlight element appears" 是 `FAIL`（这是我们要修复的，重构 keydown 后变 PASS）。现有 5 个 Ctrl+Up/Down 跳转断言应该 PASS（Task 1 没动 keydown）。

- [ ] **Step 2: 重构 keydown 处理函数**

打开 `renderer/renderer.js`，找到 line 941-973 的 `Ctrl+Up / Ctrl+Down` 块。整块替换为：

```javascript
    // Ctrl+Up / Ctrl+Down — jump between user prompts
    if (!e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const c = terminalCache.get(sessionId);
      if (!c || !c._minimap) return true;
      const moved = e.key === 'ArrowUp' ? c._minimap.navPrev() : c._minimap.navNext();
      if (moved) {
        e.preventDefault();
        return false;
      }
      return true;
    }
```

注意：
- 已在边界（`navPrev/navNext` 返回 `false`）时**不 preventDefault**，让按键穿透到 xterm 默认行为（避免无意义的吞键）。
- `c._minimap` 不存在时直接 return true，由 xterm 处理。

- [ ] **Step 3: Reload renderer + 跑测试**

Hub 窗口 `Ctrl+R`，然后：

```powershell
node tests/e2e-prompt-jump.js 9229
```

期望 summary：
- `[PASS] Ctrl+Up scrolls up`（仍然 PASS，行为不变）
- `[PASS] Highlight element appears`（**之前 FAIL，现在 PASS**——重构副作用是修复 highlight 反馈）
- `[PASS] 2nd Ctrl+Up goes further up`
- `[PASS] Ctrl+Down scrolls down`
- `[PASS] 2nd Ctrl+Down reaches last prompt`
- 全部 Task 1 新增 PASS

- [ ] **Step 4: Commit**

```powershell
git add renderer/renderer.js
git commit -m "$(cat <<'EOF'
refactor(prompt-nav): keydown Ctrl+Up/Down delegates to minimap.navPrev/navNext

Replaces 30 lines of inline find-prompt-and-jump logic in the keydown
handler with a call to the shared minimap nav method. Side effect: the
flashPromptLine highlight now fires on Ctrl+Up/Down as well (previously
only the underlying scroll happened). E2E test 'Highlight element
appears' goes from FAIL to PASS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: CSS — prompt-line-marker 单档化 + minimap-tick 加亮

**目标**：把现有 8% 透明度的几乎不可见橙边换成 22% + 5px 亮橙，把 4px 的 minimap tick 换成 6px 亮橙带外发光。

**Files:**
- Modify: `renderer/styles.css:709-720`（`.minimap-tick` 块）
- Modify: `renderer/styles.css:739-752`（`.prompt-line-marker` 和 `.prompt-line-marker-active` 块）

- [ ] **Step 1: 写"marker 强度 + tick 高度"的失败断言**

在 `tests/e2e-prompt-jump.js` 末尾（`// --- Summary ---` 之前，Task 1 加的 Test 6 之后）插入：

```javascript
// --- Test 7: CSS visual strength ---
log('Test 7: prompt-line-marker has strong contrast and minimap-tick is bold');

const markerStyle = await evalJs(`
  (function() {
    const m = document.querySelector('.prompt-line-marker');
    if (!m) return null;
    const cs = getComputedStyle(m);
    return {
      borderLeftWidth: cs.borderLeftWidth,
      backgroundColor: cs.backgroundColor,
    };
  })()
`);
record('prompt-line-marker exists in DOM', markerStyle !== null, JSON.stringify(markerStyle));

if (markerStyle) {
  record(
    'prompt-line-marker border-left is 5px',
    markerStyle.borderLeftWidth === '5px',
    markerStyle.borderLeftWidth
  );
  // 22% alpha = 0.22, computed style returns "rgba(210, 153, 34, 0.219...)" or similar
  const bgMatch = /rgba\(210,\s*153,\s*34,\s*0\.2[12]/.test(markerStyle.backgroundColor);
  record(
    'prompt-line-marker background ~0.22 alpha',
    bgMatch,
    markerStyle.backgroundColor
  );
}

const tickStyle = await evalJs(`
  (function() {
    const t = document.querySelector('.minimap-tick');
    if (!t) return null;
    const cs = getComputedStyle(t);
    return { height: cs.height, backgroundColor: cs.backgroundColor };
  })()
`);
record('minimap-tick exists in DOM', tickStyle !== null, JSON.stringify(tickStyle));

if (tickStyle) {
  record(
    'minimap-tick height is 6px',
    tickStyle.height === '6px',
    tickStyle.height
  );
  // #ffb84d = rgb(255, 184, 77)
  record(
    'minimap-tick color is bright orange #ffb84d',
    tickStyle.backgroundColor === 'rgb(255, 184, 77)',
    tickStyle.backgroundColor
  );
}
```

- [ ] **Step 2: Reload + 跑测试看 RED**

Hub `Ctrl+R`，然后 `node tests/e2e-prompt-jump.js 9229`。

期望 FAIL：
- `[FAIL] prompt-line-marker border-left is 5px` — `3px`
- `[FAIL] prompt-line-marker background ~0.22 alpha` — `rgba(..., 0.08)`
- `[FAIL] minimap-tick height is 6px` — `4px`
- `[FAIL] minimap-tick color is bright orange #ffb84d` — `rgb(210, 153, 34)`

- [ ] **Step 3: 改 CSS**

打开 `renderer/styles.css`。

**第一处**（line 709-720 的 `.minimap-tick` 块），整块替换为：

```css
.minimap-tick {
  position: absolute;
  left: 0;
  right: 0;
  height: 6px;
  background: #ffb84d;
  pointer-events: auto;
  cursor: pointer;
  opacity: 1;
  box-shadow: 0 0 4px rgba(255, 184, 77, 0.7);
}
.minimap-tick:hover { height: 8px; opacity: 1; background: #ffc869; }
```

**第二处**（line 739-752 的 `.prompt-line-marker` 和 `.prompt-line-marker-active` 块），整块替换为：

```css
.prompt-line-marker {
  position: absolute;
  left: 0;
  right: 12px;
  background: rgba(210, 153, 34, 0.22);
  border-left: 5px solid #ffb84d;
}

.prompt-line-marker-active {
  /* Reserved class slot. JS still tags this class on the active row,
     but B-plan visual style is unified across all prompts. Leave empty
     to make it trivial to reintroduce a different active style later
     without JS changes. */
}
```

- [ ] **Step 4: Reload + 跑测试看 GREEN**

Hub `Ctrl+R`，`node tests/e2e-prompt-jump.js 9229`。

期望 Test 7 全 PASS，所有现有断言仍 PASS。

- [ ] **Step 5: Commit**

```powershell
git add renderer/styles.css tests/e2e-prompt-jump.js
git commit -m "$(cat <<'EOF'
style(prompt-marker): strengthen prompt-line-marker and minimap-tick contrast

prompt-line-marker: 0.08→0.22 background, 3px→5px left border, color
shifts to bright #ffb84d. Active variant unified (B-plan: no per-active
differentiation; flashPromptLine provides transient feedback instead).

minimap-tick: 4px→6px height, color #d29922→#ffb84d, hover 6→8px.

User feedback was that the prior 8% alpha overlay was effectively
invisible against the dark terminal background. New values measured to
be clearly distinguishable at a glance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 新增 mountPromptNavButtons 浮动按钮组

**目标**：在终端右上角浮 ▲▼ 两个按钮，按钮 click 调 `cache._minimap.navPrev/navNext()`。按钮和 mountMinimap 同生命周期（mountMinimap 销毁时一起销毁）。

**Files:**
- Modify: `renderer/renderer.js`（在 `mountMinimap` 函数定义之后插入新函数 `mountPromptNavButtons`；在调 `mountMinimap` 的 `attachTerminalToPanel` 末尾追加按钮挂载）
- Modify: `renderer/styles.css`（追加 `.prompt-nav-buttons` 和 `.prompt-nav-btn` 样式）

- [ ] **Step 1: 写"按钮 DOM 存在 + 点击触发跳转"的失败断言**

在 `tests/e2e-prompt-jump.js` 末尾（Test 7 之后）追加：

```javascript
// --- Test 8: Floating ▲▼ nav buttons ---
log('Test 8: prompt-nav-buttons DOM and click behavior');

const btnInfo = await evalJs(`
  (function() {
    const btns = document.querySelectorAll('.prompt-nav-btn');
    if (btns.length !== 2) return { count: btns.length };
    return {
      count: btns.length,
      upDir: btns[0].getAttribute('data-dir'),
      downDir: btns[1].getAttribute('data-dir'),
      upText: btns[0].textContent,
      downText: btns[1].textContent,
    };
  })()
`);
record('Two .prompt-nav-btn elements exist', btnInfo.count === 2, JSON.stringify(btnInfo));
if (btnInfo.count === 2) {
  record('First button is data-dir="up"', btnInfo.upDir === 'up', btnInfo.upDir);
  record('Second button is data-dir="down"', btnInfo.downDir === 'down', btnInfo.downDir);
}

// 准备：scroll to bottom，clear active state
await evalJs(`
  (function() {
    const c = terminalCache.get(activeSessionId);
    c.terminal.scrollToBottom();
    if (c._minimap && c._minimap.setActiveLine) c._minimap.setActiveLine(-1);
    delete c._activePromptLine;
  })()
`);
await sleep(300);

const viewBeforeBtn = await evalJs(`terminalCache.get(activeSessionId).terminal.buffer.active.viewportY`);

await evalJs(`document.querySelector('.prompt-nav-btn[data-dir="up"]').click()`);
await sleep(300);

const viewAfterBtn = await evalJs(`terminalCache.get(activeSessionId).terminal.buffer.active.viewportY`);
record('Click ▲ scrolls up', viewAfterBtn < viewBeforeBtn, `${viewBeforeBtn} -> ${viewAfterBtn}`);

await shot('08-after-button-up.png');
```

- [ ] **Step 2: Reload + 跑测试看 RED**

Hub `Ctrl+R`，`node tests/e2e-prompt-jump.js 9229`。

期望 `[FAIL] Two .prompt-nav-btn elements exist` — count 0。后续 if 短路。

- [ ] **Step 3: 实现 mountPromptNavButtons + 调用挂载**

打开 `renderer/renderer.js`。

**A. 在 `mountMinimap` 函数定义结束之后（line ~1383 `}` 之后），插入新函数**：

```javascript
// Floating ▲▼ buttons in the terminal's top-right corner. Shares lifecycle
// with mountMinimap: created by attachTerminalToPanel after mountMinimap,
// disposed when the terminalCache entry's _minimap is disposed (we attach
// our dispose to the same chain via the returned object).
function mountPromptNavButtons(sessionId, termContainer, minimap) {
  const wrap = document.createElement('div');
  wrap.className = 'prompt-nav-buttons';

  const btnUp = document.createElement('button');
  btnUp.className = 'prompt-nav-btn';
  btnUp.setAttribute('data-dir', 'up');
  btnUp.title = '上一个问题 (Ctrl+↑)';
  btnUp.textContent = '▲';

  const btnDown = document.createElement('button');
  btnDown.className = 'prompt-nav-btn';
  btnDown.setAttribute('data-dir', 'down');
  btnDown.title = '下一个问题 (Ctrl+↓)';
  btnDown.textContent = '▼';

  wrap.appendChild(btnUp);
  wrap.appendChild(btnDown);
  termContainer.appendChild(wrap);

  function refreshState() {
    btnUp.disabled = !minimap.canNavPrev();
    btnDown.disabled = !minimap.canNavNext();
  }

  btnUp.addEventListener('click', (e) => {
    e.stopPropagation();
    minimap.navPrev();
    refreshState();
  });
  btnDown.addEventListener('click', (e) => {
    e.stopPropagation();
    minimap.navNext();
    refreshState();
  });

  refreshState();

  return {
    refreshState,
    dispose() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  };
}
```

**B. 让按钮在 mountMinimap 之后挂载并随 dispose 一起销毁。** 找到 `attachTerminalToPanel` 函数（或任何调用 `mountMinimap` 的地方——参考 line 1233 `cached._minimap = mountMinimap(...)`）。在那一行**之后**追加：

```javascript
  cached._navButtons = mountPromptNavButtons(sessionId, termContainer, cached._minimap);
```

**C. 让 minimap 的 dispose 顺带把按钮也 dispose 掉。** 修改 `mountMinimap` 返回对象的 `dispose()`（Task 1 修改过的那块），改为：

```javascript
    dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      if (maxDebounceTimer) clearTimeout(maxDebounceTimer);
      try { scrollSub.dispose(); } catch {}
      try { renderSub.dispose(); } catch {}
      if (strip.parentNode) strip.parentNode.removeChild(strip);
      if (promptMarkerLayer && promptMarkerLayer.parentNode) promptMarkerLayer.parentNode.removeChild(promptMarkerLayer);
    },
```

（注意 `mountMinimap` 内部不知道 `_navButtons` 的存在——按钮 dispose 由调用方在销毁 `_minimap` 时也手动销毁 `_navButtons`。）

**D. 找到调用方销毁 `_minimap` 的地方**（grep `_minimap.dispose` 找出 1233 行附近的：`if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }`）。在那个 dispose 链路里**加上**对 `_navButtons` 的销毁。改为：

```javascript
  if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
  if (cached._navButtons) { try { cached._navButtons.dispose(); } catch {} cached._navButtons = null; }
```

**E. 按钮也要在 prompt 列表变化时刷新 disabled 状态。** 在 mountMinimap 的 `render()` 函数末尾（line ~1349 `layer.appendChild(markerFrag);` 之后）追加：

```javascript
    // Notify any external listeners (e.g. nav buttons) that ticks/active changed.
    const cache = terminalCache.get(sessionId);
    if (cache && cache._navButtons && cache._navButtons.refreshState) {
      cache._navButtons.refreshState();
    }
```

- [ ] **Step 4: 加 CSS**

打开 `renderer/styles.css`，**追加到文件末尾**（不要插入已有 prompt 区块中间）：

```css
/* --- Floating prompt-nav buttons (▲▼) at terminal top-right --- */
.prompt-nav-buttons {
  position: absolute;
  top: 8px;
  right: 18px;       /* minimap is 10px wide + 4px gap to its left + 4px to inner edge */
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 2px;
  opacity: 0.45;
  transition: opacity 0.15s ease;
}
.terminal-container:hover .prompt-nav-buttons { opacity: 1; }

.prompt-nav-btn {
  width: 28px;
  height: 24px;
  border: 1px solid rgba(139, 148, 158, 0.25);
  border-radius: 4px;
  background: rgba(48, 54, 61, 0.6);
  color: #ffb84d;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.1s ease, opacity 0.1s ease;
}
.prompt-nav-btn:hover:not(:disabled) {
  background: rgba(210, 153, 34, 0.25);
}
.prompt-nav-btn:active:not(:disabled) {
  background: rgba(210, 153, 34, 0.45);
}
.prompt-nav-btn:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Reload + 跑测试看 GREEN**

Hub `Ctrl+R`，`node tests/e2e-prompt-jump.js 9229`。

期望 Test 8 全 PASS，所有现有 PASS 不能挂。打开 `tests/e2e-proof-screenshots/prompt-jump/08-after-button-up.png` 肉眼看终端右上角是否能看到按钮组（半透明态，hover 时变深）。

- [ ] **Step 6: Commit**

```powershell
git add renderer/renderer.js renderer/styles.css tests/e2e-prompt-jump.js
git commit -m "$(cat <<'EOF'
feat(prompt-nav): add floating ▲▼ buttons in terminal top-right

Mouse users can now click ▲/▼ to jump to previous/next user prompt
without remembering Ctrl+Up/Down. Buttons share lifecycle with
mountMinimap (created and disposed together) and delegate to the
same minimap.navPrev/navNext methods, so keyboard and mouse paths
converge on one implementation. Buttons are 45% opacity by default
and full opacity on terminal-container hover, to avoid stealing
visual attention from the terminal content.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 按钮边界 disabled 状态

**目标**：跳到最上一条后 ▲ 按钮 disabled，最下一条后 ▼ 按钮 disabled。Task 4 已经写了 `refreshState` 和 `canNavPrev/canNavNext` 接口，但要验证边界场景下 disabled 真的生效，并补一个"零 ticks 时两个都 disabled"的边界。

**Files:**
- Modify: `tests/e2e-prompt-jump.js`（追加边界断言）
- 代码层不需要改（Task 4 已实现），本 task 是验证 + 补漏

- [ ] **Step 1: 加边界断言**

在 `tests/e2e-prompt-jump.js` 末尾（Test 8 之后）追加：

```javascript
// --- Test 9: Boundary disabled state ---
log('Test 9: nav buttons disabled at top/bottom boundary');

// 跳到最上一条 prompt（多按几次 ▲ 直到不动）
for (let i = 0; i < 10; i++) {
  await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (c && c._minimap) c._minimap.navPrev();
    })()
  `);
}
await sleep(300);

const upDisabledAtTop = await evalJs(`document.querySelector('.prompt-nav-btn[data-dir="up"]').disabled`);
record('▲ disabled at first prompt', upDisabledAtTop === true, String(upDisabledAtTop));

// 跳到最下一条
for (let i = 0; i < 10; i++) {
  await evalJs(`
    (function() {
      const c = terminalCache.get(activeSessionId);
      if (c && c._minimap) c._minimap.navNext();
    })()
  `);
}
await sleep(300);

const downDisabledAtBottom = await evalJs(`document.querySelector('.prompt-nav-btn[data-dir="down"]').disabled`);
record('▼ disabled at last prompt', downDisabledAtBottom === true, String(downDisabledAtBottom));

await shot('09-boundary-disabled.png');
```

- [ ] **Step 2: Reload + 跑测试**

Hub `Ctrl+R`，`node tests/e2e-prompt-jump.js 9229`。

可能结果：
- 如果 Task 4 的 `refreshState` 调用链工作正常 → 两条都 PASS，本 task 跳到 Step 4 commit
- 如果 FAIL → 进 Step 3 修

- [ ] **Step 3: 如果 FAIL，修 refreshState 调用时机**

可能 fail 的原因：`navPrev/navNext` 内部调 `render()`，render 里调 `refreshState`——但 `activeLine` 已更新到最上/最下后，下一次按 ▲ 会 `findNavTarget('up')` 返回 `null` → `canNavPrev()` 也返回 `null` → `disabled = true`。理论上没问题。

如果实际 fail，最可能是 `refreshState` 没在 `navTo` 之后立即调用。修复：在 `mountMinimap` 的 `navTo` 函数末尾（return true 之前）追加同步调用：

```javascript
function navTo(direction) {
  const target = findNavTarget(direction);
  if (!target) return false;
  try { terminal.scrollToLine(target.line); } catch {}
  activeLine = target.line;
  flashPromptLine(terminal, target.line);
  render();
  const cache = terminalCache.get(sessionId);
  if (cache) {
    cache._activePromptLine = target.line;
    if (cache._navButtons && cache._navButtons.refreshState) {
      cache._navButtons.refreshState();
    }
  }
  return true;
}
```

（`render()` 末尾也调了 `refreshState`，所以这里是冗余兜底；render 异步或被 debounce 时这一路确保按钮状态实时。）

Reload + 重跑 → GREEN。

- [ ] **Step 4: Commit**

```powershell
git add renderer/renderer.js tests/e2e-prompt-jump.js
git commit -m "$(cat <<'EOF'
test(prompt-nav): verify ▲▼ disabled at boundary positions

Asserts that ▲ becomes disabled when active line is at the topmost
prompt and ▼ becomes disabled at the bottom. Adds a redundant
refreshState() call inside navTo() so button state stays in sync even
if the render() debounce path lags.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 冒烟启动 + 视觉自检 + 收尾

**目标**：按 Hub CLAUDE.md 铁律，任何 renderer 改动后必须跑完整启动冒烟，并人工对比改动前/后视觉。

**Files:** 无代码改动。

- [ ] **Step 1: 关闭测试 Hub，跑无 env 的冒烟启动**

关闭 Step 1 启动的隔离 Hub 窗口。在 Hub 项目根**新开 PowerShell 窗口**（不带 `CLAUDE_HUB_DATA_DIR`），跑：

```powershell
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | Select-Object -First 20
```

**期望**：
- 6 秒内输出包含 `[hub] hook server listening on 127.0.0.1:` 一行
- 没有 `Cannot find module` 任何错误
- 没有未捕获异常堆栈

如果出现 `Cannot find module 'XXX'`，按 Hub CLAUDE.md 铁律 3：立即 `npm install` 重对齐。

- [ ] **Step 2: 启动正常 Hub 视觉自检**

如果 Step 1 通过，**不带 timeout** 启动：

```powershell
.\node_modules\electron\dist\electron.exe .
```

打开任意一个有现有用户提问历史的 session（或新建一个 PowerShell session 自己输入几条 `❯ test 1` `❯ test 2` 这种行）。

**人工核查清单**（拍一张对比截图存 `tests/e2e-proof-screenshots/prompt-jump/manual-after.png`）：

- [ ] 用户提问行左侧能**远距离扫一眼识别**（5px 亮橙 + 22% 背景）
- [ ] 终端右上角能看到 ▲▼ 按钮（默认半透明 45%）
- [ ] 鼠标移到终端区域时按钮变全不透明
- [ ] 点 ▲ 终端跳到上一条提问 + 跳过去时闪一下橙色高亮（`flashPromptLine`）
- [ ] 点 ▼ 同理跳下一条
- [ ] 跳到第一条后 ▲ 变灰（disabled）
- [ ] Ctrl+↑ / Ctrl+↓ 仍工作（且现在跳转后也有闪烁）
- [ ] Minimap 右侧的橙色 tick 比改动前明显粗 + 亮
- [ ] 切换到另一个 session 再切回来：按钮和 marker 都还在（不重复、不丢）
- [ ] 打开 preview-panel / memo-panel 等任何右侧 panel：按钮仍可见可点

- [ ] **Step 3: 跑完整 E2E 最后一次**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\hub-prompt-nav-data"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9229
```

新窗口跑：

```powershell
node tests/e2e-prompt-jump.js 9229
```

期望 summary 行 `Total: N passed, 0 failed out of N`，N ≥ 12（5 现有 + Task 1 的 3 + Task 3 的 5 + Task 4 的 3 + Task 5 的 2 = 18，部分重叠）。0 fail。

- [ ] **Step 4: 关闭测试 Hub，清理 env data**

```powershell
Remove-Item -Recurse -Force C:\Users\lintian\hub-prompt-nav-data -ErrorAction SilentlyContinue
```

- [ ] **Step 5: 最终 commit（如有截图）+ git status 检查**

```powershell
git add tests/e2e-proof-screenshots/prompt-jump/
git commit -m "$(cat <<'EOF'
docs(prompt-nav): add visual smoke screenshots

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git status
```

期望 `git status` 显示 working tree clean。`git log --oneline -10` 应能看到 5 个本特性 commit（Task 1/2/3/4/5）+ Task 6 的截图 commit。

---

## Self-Review

| 检查项 | 结果 |
|---|---|
| **Spec coverage** · `mountMinimap` 加 nav 方法 | Task 1 |
| **Spec coverage** · keydown Ctrl+↑/↓ 重构 | Task 2 |
| **Spec coverage** · `flashPromptLine` 新增触达 keydown 链路 | Task 1 + Task 2（副作用 PASS 转换） |
| **Spec coverage** · prompt-line-marker 单档强高亮 | Task 3 |
| **Spec coverage** · minimap-tick 加亮 | Task 3 |
| **Spec coverage** · 按钮 DOM + 视觉规格 + click 行为 | Task 4 |
| **Spec coverage** · 按钮和 mountMinimap 共生命周期 / dispose 链 | Task 4 step 3-D |
| **Spec coverage** · 按钮边界 disabled | Task 5 |
| **Spec coverage** · 多 session 切换不泄漏（spec test T6）| Task 4 step 3-D 的 dispose 链路保证；Task 6 manual checklist |
| **Spec coverage** · preview/memo panel 不影响按钮（spec test T7）| Task 6 manual checklist |
| **Spec coverage** · 不识别跨行 prompt（YAGNI）| 不实施，符合 spec |
| **Spec coverage** · 不动 hooks/IPC/主进程 | 全程 |
| **Placeholder scan** · 无 TBD/TODO/"add error handling"/"similar to" | ✅ |
| **Type consistency** · `navPrev/navNext/canNavPrev/canNavNext` 命名一致 | ✅ Task 1 / 4 / 5 |
| **Type consistency** · `_navButtons` 字段名一致 | ✅ Task 4 step 3-B/C/D/E + Task 5 |
| **Type consistency** · `findNavTarget` / `navTo` 内部辅助函数命名 | ✅ Task 1 / 5 |
| **TDD 节奏** · 每 task 含 RED→GREEN→commit | ✅（Task 2 是纯重构，用现有 fail 断言作 RED） |
| **Spec 偏离** · spec 里写 "tests/e2e-prompt-nav.js"，plan 改为扩展 "tests/e2e-prompt-jump.js" | 已说明，文件复用比新建更合理；不影响设计本身 |

**额外**：所有 commit message 都附 `Co-Authored-By: Claude Opus 4.7 (1M context)` 行；不使用 `--no-verify`；不修改 git config。
