# 终端用户提问高亮与上下导航按钮 设计文档

**Date**: 2026-04-25
**Status**: Draft（待用户审阅）
**Scope**: 渲染层（renderer-only），不动主进程 / IPC / hooks

## 背景与问题

Hub 主界面是 xterm.js 终端面板（PTY 文本流），用户在 Claude Code session 里和 AI 对话时，主界面由"用户提问行（`❯ xxx`）"和"AI 回复"交替组成。当前痛点：

1. **用户提问视觉强化太弱**：现有 `prompt-line-marker` 用 `rgba(210,153,34,0.08)` 背景 + 3px 暖橙左边——8% 透明度在深色终端背景上几乎不可见，肉眼扫一眼分不出哪句是用户说的、哪段是 AI 回的。
2. **跳转入口不明显**：现有 `Ctrl+↑/↓` 跳转和 minimap 点击跳转都已实现，但快捷键无可见入口、minimap tick 太细（4px）容易忽略——鼠标用户没有显眼操作入口。

参考截图（用户实测）：长中文提问行左边只有一道淡得几乎看不见的橙边，视觉上等同于"高亮没生效"。

## 现状梳理（已有能力）

| 能力 | 文件位置 | 现状 |
|---|---|---|
| 识别用户提问行（`❯ xxx`）| `renderer/renderer.js:105` `PROMPT_LINE_RE` | 单行匹配，跨行 box 只识别首行 |
| 终端右侧 minimap + 橙色 tick + 点击跳转 | `renderer/renderer.js:1239 mountMinimap` | 4px 高 tick，颜色 `#d29922`，95% 透明度 |
| 提问行左侧 marker bar | `renderer/renderer.js:1340-1349` | `prompt-line-marker` + `prompt-line-marker-active` 两档 |
| `Ctrl+↑ / Ctrl+↓` 跳转 | `renderer/renderer.js:941` | 跳转后调 `flashPromptLine` 闪烁 |
| 跳转后高亮闪烁 | `renderer/renderer.js:1385 flashPromptLine` | 0.8s 衰减；**目前不在 Ctrl+↑/↓ 跳转链路里被调用**（仅在少数其他场景调用） |
| `_activePromptLine` 状态 | `terminalCache.get(sessionId)._activePromptLine` (`number`) | 跨快捷键调用维持光标位置 |
| Minimap 已暴露 API | `mountMinimap` 返回对象 | 已有 `getTicks() / setActiveLine(line) / invalidate() / dispose()` |

结论：能力已基本齐全，问题主要在 **CSS 对比度** 和 **缺少鼠标用户的可见入口**。

## 目标

1. 用户提问行从远距离扫一眼即可识别（足够强的视觉对比度）。
2. 鼠标用户能直接点按钮在提问之间上下跳，键盘用户的 `Ctrl+↑/↓` 不受影响。
3. 不影响现有任何功能（minimap、Ctrl+↑/↓、`flashPromptLine`、`getQuestionsSignature`、preview/memo/team-room/meeting-room panel 等）。

## 非目标（YAGNI）

- ❌ 不识别跨行 prompt 的延续行（`│ xxx │` 那几行不画高亮）。原因：`PROMPT_LINE_RE` 当前只匹配带 `❯` 的首行；扩展为"识别 box 段落"工作量翻倍且依赖 Claude Code TUI 格式稳定。首行那一道亮橙左边在视觉上已足够定位。
- ❌ 不加 `J/K` / `Home/End` / 数字键跳第 N 条等额外键位。
- ❌ 不加问题序号徽章。
- ❌ 不加问题预览悬浮卡片 / 问题列表面板（如未来需要，单独立项做 B 方案）。
- ❌ 不动 hooks / 主进程 / IPC。

## 方案

### 选型决策

经过逐项澄清，确定方向：

- **操作入口**：方案 A（浮动迷你按钮组）+ minimap tick 加亮配套。
- **高亮形态**：方案 B（单档统一强高亮，不分 active；跳转用现有 `flashPromptLine` 闪烁做瞬时反馈）。

放弃的方向：
- 方案 B（常驻问题列表侧栏）：影响布局，要协调 preview/memo panel 显隐规则，工作量大；当前痛点用最轻方案就能解决。
- 方案 C（块状气泡 + 序号徽章）：xterm 单元格对齐风险、跨行段落识别成本高。

### 改动范围

| 文件 | 改什么 | 是否新增 |
|---|---|---|
| `renderer/styles.css` | 加深 marker 样式、加按钮容器样式、加深 minimap-tick | 改，无新增节 |
| `renderer/renderer.js` | 在 `mountMinimap` 同级加 `mountPromptNavButtons`；marker 渲染单档化 | 改，约 +60 行 |
| `renderer/index.html` | 不动 | — |
| 其他 panel / 主进程 / IPC / hooks | 不动 | — |

### 兼容现有功能的硬约束

| 现有功能 | 兼容策略 |
|---|---|
| `Ctrl+↑/↓` 跳转 | 行为不变（仍是上/下一条提问），但**实现重构**：把 `renderer.js:942-973` 的内联查找/跳转逻辑搬进 `mountMinimap` 返回对象的新方法 `navPrev() / navNext()`，keydown 处理函数收缩到调一次 `cache._minimap.navPrev()` / `navNext()` + `e.preventDefault()`。按钮点击调同一个方法，避免分叉 |
| `_activePromptLine` 状态 | 字段位置（`terminalCache[sessionId]._activePromptLine`）不变；读写从内联 keydown 代码挪进 `navPrev/navNext`。CSS 不再渲染 active 差异样式（统一外观）|
| `flashPromptLine` 闪烁 | **新增**统一调用：`navPrev/navNext` 内部跳转后调一次 `flashPromptLine`。这意味着 `Ctrl+↑/↓` 也会获得跳转闪烁反馈（属于行为增强，不是回归）|
| `getQuestionsSignature` 已读未读 | 不动 |
| Minimap tick 点击跳转 | 保留，只改样式 |
| `mountMinimap.dispose()` 链路 | 新加按钮容器同步 dispose；按钮挂在 `termContainer` 下，session 切换时 termContainer 整个清空，按钮自然销毁 |
| Preview / memo / team-room / meeting-room panel | 按钮 `position: absolute` 锚到 `terminal-container`，不在右侧 panel 里，右侧任何 panel 显隐都不影响按钮 |
| 多 session 切换 | 按钮属于每个 session 的 `terminal-container` 内部 DOM，和现有 minimap 走同一套生命周期 |

### 组件设计

#### 按钮组件（新增）

**位置**：终端右上角，贴在 minimap 左侧 4px 处。

**DOM 结构**（在 `mountMinimap` 时一并创建，挂到 `termContainer`）：

```html
<div class="prompt-nav-buttons">
  <button class="prompt-nav-btn" data-dir="up" title="上一个问题 (Ctrl+↑)">▲</button>
  <button class="prompt-nav-btn" data-dir="down" title="下一个问题 (Ctrl+↓)">▼</button>
</div>
```

**视觉规格**：

| 状态 | 背景 | 透明度 |
|---|---|---|
| 默认 | `rgba(48,54,61,0.6)` 深灰半透 | `opacity: 0.45` |
| 容器 hover | 同上 | `opacity: 1` |
| 单按钮 hover | `rgba(210,153,34,0.25)` | `opacity: 1` |
| 单按钮 active（按下瞬间）| `rgba(210,153,34,0.45)` | `opacity: 1` |
| disabled（边界）| 默认背景 | `opacity: 0.2`，cursor: `not-allowed` |

**尺寸**：每个按钮 28×24px，垂直堆叠（▲ 上 ▼ 下），整组 28×52px；圆角 4px；箭头字符 13px。

**定位**：

```css
.prompt-nav-buttons {
  position: absolute;
  top: 8px;
  right: 18px;          /* minimap 10px + 4px gap = 14px，再留 4px = 18px */
  z-index: 6;            /* 比 minimap 的 5 高，比 modal-overlay 低 */
  display: flex;
  flex-direction: column;
  gap: 2px;
}
```

#### 按钮行为

| 事件 | 行为 |
|---|---|
| 点击 `▲` | 调 `cache._minimap.navPrev()`（内部：找上一 tick → 更新 `_activePromptLine` → `scrollToLine` → `flashPromptLine` → `setActiveLine`） |
| 点击 `▼` | 调 `cache._minimap.navNext()`（同上反向） |
| 已在最上/最下边界 | 按钮 disabled；点击无反应；不循环 |
| 显示/隐藏 | 始终显示，零 prompt 时两个按钮都 disabled |
| Tooltip | 注明对应快捷键（`Ctrl+↑` / `Ctrl+↓`），告知键盘替代 |

`mountMinimap` 返回对象**新增**方法（落地接口）：

```javascript
navPrev(): boolean        // 跳到上一条；成功返回 true，已在边界返回 false
navNext(): boolean        // 跳到下一条；成功返回 true，已在边界返回 false
canNavPrev(): boolean     // 是否还有更靠上的提问可跳；按钮据此置 disabled
canNavNext(): boolean     // 是否还有更靠下的提问可跳；按钮据此置 disabled
```

#### 高亮 CSS 改动（B 方案落地）

```css
.prompt-line-marker {
  position: absolute;
  left: 0;
  right: 12px;
  background: rgba(210, 153, 34, 0.22);        /* 0.08 → 0.22，约 3 倍 */
  border-left: 5px solid #ffb84d;               /* 3px #d29922 → 5px #ffb84d */
}

.prompt-line-marker-active {
  /* 留空类：保留 JS 状态字段，B 方案不做差异样式 */
}
```

JS 里 `marker.className = 'prompt-line-marker' + (t.line === activeLine ? ' prompt-line-marker-active' : '')` 这行**不删**，class 还在挂，只是 active 类没视觉差异。

#### Minimap tick 加亮（A 方案配套）

```css
.minimap-tick {
  height: 6px;                                  /* 4px → 6px */
  background: #ffb84d;                           /* #d29922 → #ffb84d */
  opacity: 1;                                    /* 0.95 → 1 */
  box-shadow: 0 0 4px rgba(255, 184, 77, 0.7);  /* 加强外发光 */
}
.minimap-tick:hover { height: 8px; }             /* 6px → 8px */
```

## 数据流

整个特性是纯渲染层改动，没有 IPC、没有持久化。

```
xterm buffer (PTY 写入)
    │
    └─→ scanBuffer() [debounced 250ms] (renderer.js:1254)
           │
           └─→ ticks: [{line, text}, ...]   (匹配 PROMPT_LINE_RE 的行)
                  │
                  ├─→ render() 画 minimap-tick + prompt-line-marker
                  │     ↑ 改动点：tick 样式加亮（CSS-only）
                  │     ↑ 改动点：marker 单档统一（CSS-only）
                  │
                  └─→ promptNavButtons.refreshState(ticks, activeLine)
                        ↑ 新增：根据 activeLine 是否在边界，置 disabled
```

按钮点击链路：

```
click ▲ / Ctrl+↑
       │
       └─→ cache._minimap.navPrev()
              ├─→ 找上一 tick（已是边界 → return false）
              ├─→ cache._activePromptLine = target.line
              ├─→ terminal.scrollToLine(target.line)
              ├─→ flashPromptLine(terminal, target.line)        ← 注：相对现状新增
              ├─→ this.setActiveLine(target.line)               ← 重新渲染 marker
              └─→ promptNavButtons.refreshState()               ← 更新 disabled
```

按钮和 `Ctrl+↑/↓` 都走 `navPrev/navNext`，不再有分叉的内联查找逻辑。

## 错误处理

按 "trust internal code" 原则，只在真实边界处理。

| 场景 | 处理 |
|---|---|
| `ticks` 为空 | `canNavPrev/canNavNext` 都返回 `false`，两个按钮都 disabled |
| 没有当前焦点（`cache._activePromptLine` 为 `undefined`）| 复用 `renderer.js:954-955` 已有 anchor 逻辑：`navPrev` 锚到 `buf.viewportY + terminal.rows`（先跳到当前可见区或上方最近一条），`navNext` 锚到 `buf.viewportY` |
| `terminal.scrollToLine` 抛异常 | `try/catch` 静默——和 `mountMinimap` 内 strip 点击处理一致 |
| `flashPromptLine` 找不到 dimensions | 现有代码 early return，不动 |
| Session 切换、按钮容器随 termContainer 销毁 | `mountMinimap.dispose()` 里把按钮容器 `removeChild`，闭包 GC 回收 listener |
| 多 session 同时存在 | 每个 session 的 termContainer 各自挂自己的按钮容器，class 选择器不冲突 |

## 测试方案

### 视觉自检（人工）

打开隔离 Hub，在一个有几条用户提问的 session 里肉眼对比：
- 用户提问行远距离能识别（5px 亮橙左边 + 22% 暖橙背景）
- 终端右上角能看到一组半透明 ▲▼ 按钮
- Minimap tick 比改动前明显粗 + 亮

### E2E 测试（脚本化）

**位置**：`tests/e2e-prompt-nav.js`

**启动**：按 Hub CLAUDE.md 启动模板 A 隔离实例：

```javascript
process.env.CLAUDE_HUB_DATA_DIR = path.join(os.tmpdir(), 'hub-prompt-nav-test');
spawn(
  path.join(repo, 'node_modules/electron/dist/electron.exe'),
  [repo, '--remote-debugging-port=9229'],
  { env: process.env }
);
```

**驱动**：CDP HTTP API + WebSocket（不依赖 puppeteer/playwright；和 `tests/mobile/` 风格一致）。

**伪造提问**：起一个 PowerShell session，通过 `Runtime.evaluate` 直接调 `terminal.write('❯ test prompt 1\r\n')`——让 `PROMPT_LINE_RE` 命中。**不起 Claude session**，避免消耗 API 配额。

**测试用例**：

| 用例 | 验证 |
|---|---|
| T1 · 按钮 DOM 存在 | `document.querySelectorAll('.prompt-nav-btn').length === 2` |
| T2 · 高亮强度 | 写入 3 条假 prompt 等 debounce；`getComputedStyle('.prompt-line-marker').borderLeftWidth === '5px'` 且 `backgroundColor` 含 `0.22` |
| T3 · 按钮跳转 | 模拟点 `▲`，断言 `_activePromptLine` 切到上一 tick |
| T4 · 边界禁用 | 跳到第一条后 `.prompt-nav-btn[data-dir="up"][disabled]` 存在 |
| T5 · 不影响快捷键 | dispatch `Ctrl+↑`，断言 `_activePromptLine` 同样切换 |
| T6 · Session 切换不泄漏 | 创建第二个 session 切过去切回，断言只有一组按钮 DOM |
| T7 · 不影响 preview panel | 显示 preview-panel，断言按钮仍可见可点 |

**清理**：`hubProc.kill()` + 删除 `CLAUDE_HUB_DATA_DIR`。

### 回归冒烟（强制）

按 Hub CLAUDE.md 铁律，改动后必须跑：

```powershell
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

看到 `[hub] hook server listening on 127.0.0.1:...` 才放行。

## 回滚成本

整个特性 = CSS + 60 行 JS + 一个新 DOM 容器，回滚成本极低：
- `git revert` 一个 commit 回到改动前。
- CSS 出问题不影响 JS 逻辑。
- JS 出问题：`mountPromptNavButtons` 异常被 `mountMinimap` 外层 `try/catch` 兜住，按钮挂载失败时用户只是看不到按钮，Ctrl+↑/↓ 仍可用。
