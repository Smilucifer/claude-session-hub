# 会议室 v2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精简会议室为 Focus + Blackboard 两种模式，增加 tab 状态指示，同步按钮移入 Focus toolbar，Blackboard 重做为 Markdown 渲染的会议纪要面板。

**Architecture:** 删除 Split 模式代码和 CSS，Focus 成为默认且唯一的终端布局。在 meeting-room.js 中新增 `_tabState` Map 追踪各 sub-session 的 streaming/idle/new-output/error 状态。同步逻辑从 meeting-blackboard.js 的 handleSync 提取为独立函数供 Focus toolbar 调用。Blackboard 从 grid 并排列重写为 tab 切换 + marked Markdown 渲染。

**Tech Stack:** Electron IPC, xterm.js, node-pty, marked (npm)

---

### Task 1: 去掉 Split 模式

**Files:**
- Modify: `core/meeting-room.js:16` — layout 默认值
- Modify: `renderer/meeting-room.js:82-266` — renderHeader, renderTerminals, setLayout
- Modify: `renderer/meeting-room.css:106-189` — 清理 Split 专用样式
- Modify: `main.js:459-463` — boot restore 数据迁移

- [ ] **Step 1: 修改 `core/meeting-room.js` 默认 layout**

```javascript
// core/meeting-room.js:16 — 改 'split' 为 'focus'
layout: 'focus',
```

- [ ] **Step 2: 修改 `renderer/meeting-room.js` — renderHeader 移除 Split 按钮**

在 `renderHeader()` 函数（line 82）中，删除 Split 按钮和对应 listener。

当前 header-right 区域 (lines 105-110):
```html
<button class="mr-header-btn ${meeting.layout === 'split' ? 'active' : ''}" id="mr-btn-split">Split</button>
<button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>
<button class="mr-header-btn ${meeting.layout === 'blackboard' ? 'active' : ''}" id="mr-btn-blackboard">Blackboard</button>
```

改为:
```html
<button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>
<button class="mr-header-btn ${meeting.layout === 'blackboard' ? 'active' : ''}" id="mr-btn-blackboard">Blackboard</button>
```

删除 line 113 的 `document.getElementById('mr-btn-split').addEventListener(...)`.

- [ ] **Step 3: 修改 `renderer/meeting-room.js` — renderTerminals 删除 Split 分支**

当前 `renderTerminals()` (lines 219-266):
- Lines 223-230: blackboard 分支 → 保留
- Lines 238-240: focus 分支 → 保留
- Lines 243-265: split 分支（for 循环 + 空 slot）→ 删除

删除后，非 blackboard 的所有情况都走 `renderFocusMode()`:
```javascript
function renderTerminals(meeting) {
    const container = terminalsEl();
    if (!container) return;
    container.innerHTML = '';

    if (meeting.layout === 'blackboard') {
      container.className = 'mr-terminals mr-blackboard';
      if (typeof MeetingBlackboard !== 'undefined') {
        MeetingBlackboard.renderBlackboard(meeting, container);
      }
      return;
    }

    container.className = 'mr-terminals focus-mode';
    renderFocusMode(meeting, container);
  }
```

- [ ] **Step 4: 修改 `renderer/meeting-room.js` — setLayout 移除 split case**

当前 `setLayout()` (lines 381-391) 中 `if (layout === 'focus' && !meeting.focusedSub)` 分支保留。只需确保不再有 `'split'` 值传入。

- [ ] **Step 5: 修改 `renderer/meeting-room.css` — 删除 Split 专用样式**

删除以下 CSS 块:
- `.mr-empty-slot` 及其子元素 (lines 164-189)
- `.mr-sub-slot.selected` (lines 114-117)

- [ ] **Step 6: 数据迁移 — boot restore 时 split → focus**

在 `main.js` 的 boot restore 循环 (line 459-463) 中，恢复 meeting 后检查 layout:
```javascript
for (const m of bootMeetings) {
  if (m.layout === 'split') m.layout = 'focus';
  meetingManager.restoreMeeting(m);
}
```

同样在 `renderer/renderer.js` 的 dormant meeting restore（`get-dormant-meetings` 处理）中:
```javascript
if (m.layout === 'split') m.layout = 'focus';
```

- [ ] **Step 7: 验证模块加载**

Run: `node -e "require('./core/meeting-room.js'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 8: Commit**

```bash
git add core/meeting-room.js renderer/meeting-room.js renderer/meeting-room.css main.js renderer/renderer.js
git commit -m "refactor(meeting): remove Split mode, default to Focus"
```

- [ ] **Step 9: E2E 测试 — 创建会议室验证无 Split 按钮**

启动隔离 Hub → CDP 创建会议 + 添加 Gemini 子 session → 截图验证:
- header 只有 `[Focus] [Blackboard] [+ 添加]`
- 默认进入 Focus 模式（全宽终端）
- 无 Split 按钮

---

### Task 2: Focus Tab 状态指示

**Files:**
- Modify: `renderer/meeting-room.js` — 新增 _tabState, 修改 renderHeader, 添加 terminal-data 监听
- Modify: `renderer/meeting-room.css` — 新增 tab 状态样式

- [ ] **Step 1: 在 meeting-room.js IIFE 内添加 tab 状态管理**

在 `let subTerminals = {};` (line 10) 下方添加:
```javascript
const _tabState = {};     // { sessionId: 'streaming'|'new-output'|'idle'|'error' }
const _tabTimers = {};    // { sessionId: silenceTimerId }
```

- [ ] **Step 2: 添加 terminal-data 监听器追踪输出状态**

在 `// --- Live badge refresh on status-event ---` 之前添加:
```javascript
  // --- Tab output state tracking ---
  ipcRenderer.on('terminal-data', (_e, { sessionId }) => {
    if (!activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (!meeting || !meeting.subSessions.includes(sessionId)) return;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (sessionId === focused) return; // 当前聚焦 tab 不需要提示

    _tabState[sessionId] = 'streaming';
    updateTabIndicator(sessionId);

    if (_tabTimers[sessionId]) clearTimeout(_tabTimers[sessionId]);
    _tabTimers[sessionId] = setTimeout(() => {
      if (_tabState[sessionId] === 'streaming') {
        _tabState[sessionId] = 'new-output';
        updateTabIndicator(sessionId);
      }
    }, 2000);
  });

  ipcRenderer.on('session-closed', (_e, { sessionId }) => {
    if (_tabState[sessionId] !== undefined) {
      _tabState[sessionId] = 'error';
      updateTabIndicator(sessionId);
    }
  });

  function updateTabIndicator(sessionId) {
    const tab = document.querySelector(`.mr-tab[data-sid="${sessionId}"]`);
    if (!tab) return;
    const state = _tabState[sessionId] || 'idle';
    // Update status dot
    let dot = tab.querySelector('.mr-tab-status');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'mr-tab-status';
      tab.prepend(dot);
    }
    dot.className = `mr-tab-status ${state}`;
    // NEW badge
    let badge = tab.querySelector('.new-badge');
    if (state === 'new-output') {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'new-badge';
        badge.textContent = 'NEW';
        tab.appendChild(badge);
      }
      tab.classList.add('has-new');
    } else {
      if (badge) badge.remove();
      tab.classList.remove('has-new');
    }
  }
```

- [ ] **Step 3: 修改 renderHeader 中 tab 渲染添加状态点**

在 `renderHeader()` 的 tab map (line 90-95) 中，给每个 tab 加上状态点:
```javascript
const tabs = meeting.subSessions.map(sid => {
  const s = sessions ? sessions.get(sid) : null;
  const label = s ? (s.title || s.kind) : 'session';
  const badges = subModelBadgeHtml(s) + subCtxBadgeHtml(s);
  const cls = sid === focused ? 'mr-tab active' : 'mr-tab';
  const state = _tabState[sid] || 'idle';
  const statusDot = `<span class="mr-tab-status ${state}"></span>`;
  const newBadge = state === 'new-output' ? ' <span class="new-badge">NEW</span>' : '';
  const hasNewCls = state === 'new-output' ? ' has-new' : '';
  return `<button class="${cls}${hasNewCls}" data-sid="${sid}">${statusDot}${escapeHtml(label)}${badges ? ' ' + badges : ''}${newBadge}</button>`;
}).join('');
```

- [ ] **Step 4: 切 tab 时重置状态**

在 tab click handler (line 125) 中，切换前重置目标 tab 的状态:
```javascript
if (sid && sid !== focused) {
  _tabState[sid] = 'idle';
  if (_tabTimers[sid]) { clearTimeout(_tabTimers[sid]); delete _tabTimers[sid]; }
  meeting.focusedSub = sid;
  // ... 原有逻辑
}
```

- [ ] **Step 5: 添加 CSS 样式**

在 `renderer/meeting-room.css` 的 `.mr-tab` 样式块后添加:
```css
.mr-tab-status {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.mr-tab-status.streaming  { background: #22c55e; }
.mr-tab-status.new-output { background: #eab308; }
.mr-tab-status.idle       { background: #6b7280; }
.mr-tab-status.error      { background: #ef4444; }
.mr-tab .new-badge {
  font-size: 9px;
  padding: 1px 4px;
  background: rgba(250,204,21,0.25);
  border-radius: 3px;
  color: #eab308;
  font-weight: 600;
  margin-left: 4px;
}
.mr-tab.has-new {
  border: 1px solid rgba(250,204,21,0.5);
}
```

- [ ] **Step 6: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(meeting): add tab status indicators (streaming/new/idle/error)"
```

- [ ] **Step 7: E2E 测试 — 验证 tab 状态变化**

启动隔离 Hub → 创建会议 + Gemini + Codex → 选中会议(Focus) → 广播 "hi" → 等待回复 → 截图验证:
- 当前聚焦 tab: 绿色状态点
- 另一个 tab: 黄色点 + NEW badge
- 切换 tab 后 NEW 消失

---

### Task 3: 同步按钮移入 Focus Toolbar

**Files:**
- Modify: `renderer/meeting-room.js:395-432` — renderToolbar 添加同步按钮
- Modify: `renderer/meeting-blackboard.js:129-204` — handleSync 不再切换 layout
- Modify: `renderer/meeting-blackboard.js:77-127` — toolbar 移除同步按钮

- [ ] **Step 1: 修改 Focus 的 renderToolbar 添加同步按钮**

在 `renderToolbar()` (line 395) 中，blackboard 委托后（line 399-404），Focus 模式的 toolbar HTML (lines 414-418) 改为:
```javascript
el.innerHTML = `
  <label>发送到: <select class="mr-target-select" id="mr-target-select">${optionsHtml}</select></label>
  <button class="mr-header-btn" id="mr-sync-btn">⟳ 同步</button>
  <div class="mr-sync-toggle ${meeting.syncContext ? 'active' : ''}" id="mr-sync-toggle">
    <span>自动同步: ${meeting.syncContext ? '开' : '关'}</span>
  </div>
`;
```

添加同步按钮的 click handler:
```javascript
document.getElementById('mr-sync-btn').addEventListener('click', () => {
  if (typeof MeetingBlackboard !== 'undefined' && MeetingBlackboard.handleSyncFromFocus) {
    MeetingBlackboard.handleSyncFromFocus(meeting);
  }
});
```

- [ ] **Step 2: 在 meeting-blackboard.js 中暴露 handleSyncFromFocus**

新增函数，复用 handleSync 逻辑但不切换 layout:
```javascript
async function handleSyncFromFocus(meeting) {
  if (_syncing) return;
  _syncing = true;
  try {
    const inputBox = document.getElementById('mr-input-box');
    const userFollowUp = inputBox ? inputBox.innerText.trim() : '';
    const targetIds = meeting.sendTarget === 'all'
      ? meeting.subSessions.filter(sid => { const s = getSession(sid); return s && s.status !== 'dormant'; })
      : [meeting.sendTarget];

    for (const targetId of targetIds) {
      const otherIds = meeting.subSessions.filter(id => id !== targetId);
      const summaryResults = await Promise.all(otherIds.map(async (otherId) => {
        const label = getLabel(otherId);
        const summary = await ipcRenderer.invoke('quick-summary', otherId);
        return summary ? { label, summary } : null;
      }));
      const summaries = summaryResults.filter(Boolean);
      if (summaries.length > 0) {
        const payload = await ipcRenderer.invoke('build-injection', { summaries, userFollowUp });
        if (payload) {
          ipcRenderer.send('terminal-input', { sessionId: targetId, data: payload });
          setTimeout(() => ipcRenderer.send('terminal-input', { sessionId: targetId, data: '\r' }), 80);
        }
      }
    }
    if (inputBox && userFollowUp) inputBox.textContent = '';
  } catch (err) {
    console.error('[blackboard] sync from focus error:', err);
  } finally {
    _syncing = false;
  }
}
```

在 `window.MeetingBlackboard` 导出中添加 `handleSyncFromFocus`.

- [ ] **Step 3: Blackboard toolbar 移除同步按钮**

修改 `renderBlackboardToolbar()` (line 77)，移除"快速同步"和"深度同步"按钮，只保留发送目标下拉菜单。

- [ ] **Step 4: 修改 handleSync 不再自动切换 layout**

在 `handleSync()` (line 129) 中，删除 lines 193-198（`meeting.layout = prevLayout` + `MeetingRoom.openMeeting()`），改为只刷新黑板:
```javascript
// 替换原 lines 193-198:
const container = document.querySelector('.mr-blackboard');
if (container) renderBlackboard(meeting, container);
```

- [ ] **Step 5: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-blackboard.js
git commit -m "feat(meeting): move sync button to Focus toolbar"
```

- [ ] **Step 6: E2E 测试 — Focus toolbar 同步**

启动隔离 Hub → 创建会议 + Gemini + Codex → 发消息 → 点 Focus toolbar 的同步按钮 → 截图验证:
- 同步完成后仍在 Focus 模式（不跳转）
- 被同步的 AI 收到注入消息

---

### Task 4: Blackboard 重做为 Markdown 渲染纪要

**Files:**
- Modify: `renderer/meeting-blackboard.js:26-75` — renderBlackboard 重写
- Modify: `renderer/meeting-room.css:370-472` — blackboard CSS 重写
- Modify: `renderer/index.html` — 确认 marked 加载（如需）

- [ ] **Step 1: 确认 marked 可用**

Run: `node -e "const m = require('marked'); console.log(typeof m.parse)"`
Expected: `function`

如果失败: `npm install marked`

- [ ] **Step 2: 重写 renderBlackboard 为 tab 切换 + Markdown**

替换 `renderBlackboard()` (lines 26-75):
```javascript
async function renderBlackboard(meeting, container) {
  container.innerHTML = '';
  container.className = 'mr-terminals mr-blackboard';
  const subs = meeting.subSessions || [];
  if (subs.length === 0) {
    container.innerHTML = '<div class="mr-bb-empty">暂无子会话，请先添加 AI</div>';
    return;
  }

  const focused = _bbFocusedTab || subs[0];

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'mr-bb-tabs';
  for (const sid of subs) {
    const label = getLabel(sid);
    const btn = document.createElement('button');
    btn.className = `mr-bb-tab${sid === focused ? ' active' : ''}`;
    btn.dataset.sid = sid;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      _bbFocusedTab = sid;
      renderBlackboard(meeting, container);
    });
    tabBar.appendChild(btn);
  }
  container.appendChild(tabBar);

  // Content area
  const contentEl = document.createElement('div');
  contentEl.className = 'mr-bb-content';
  container.appendChild(contentEl);

  // Fetch and render summary for focused tab
  const session = getSession(focused);
  const summary = await ipcRenderer.invoke('quick-summary', focused);
  _summaryCache[focused] = { quick: summary || '', deep: (_summaryCache[focused] || {}).deep || '' };
  const displayText = _summaryCache[focused].deep || _summaryCache[focused].quick || '(暂无输出)';

  // Info header
  const infoHtml = [];
  if (session && session.currentModel) {
    const cls = typeof modelClass === 'function' ? modelClass(session.currentModel.id) : '';
    const label = typeof modelShort === 'function' ? modelShort(session.currentModel) : (session.currentModel.displayName || '');
    infoHtml.push(`<span class="model-badge ${cls}">${label}</span>`);
  }
  if (session && typeof session.contextPct === 'number') {
    const cls = typeof pctClass === 'function' ? pctClass(session.contextPct) : 'ok';
    infoHtml.push(`<span class="ctx-badge ${cls}">Ctx ${session.contextPct}%</span>`);
  }
  infoHtml.push(`<span class="mr-bb-time">最后更新 ${new Date().toLocaleTimeString()}</span>`);

  // Markdown render
  const { marked } = require('marked');
  const renderedHtml = marked.parse(displayText);

  contentEl.innerHTML = `
    <div class="mr-bb-info">${infoHtml.join(' ')}</div>
    <div class="mr-bb-markdown">${renderedHtml}</div>
  `;
}
```

在 IIFE 内 `let _expandedRaw = {};` 后添加:
```javascript
let _bbFocusedTab = null;
```

- [ ] **Step 3: 重写 blackboard CSS**

替换 `.mr-blackboard` 到 `.mr-bb-empty` 区间 (lines 370-472):
```css
/* Blackboard: tab-switched Markdown summary */
.mr-blackboard {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-primary, #0d1117);
}
.mr-bb-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--border, #30363d);
}
.mr-bb-tab {
  padding: 6px 16px;
  background: var(--bg-secondary, #161b22);
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  color: var(--text-secondary, #8b949e);
  font-size: 12px;
  cursor: pointer;
}
.mr-bb-tab:hover { color: var(--text-primary, #c9d1d9); }
.mr-bb-tab.active {
  background: var(--bg-primary, #0d1117);
  color: var(--text-primary, #c9d1d9);
  border-color: var(--border, #30363d);
  font-weight: 600;
}
.mr-bb-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.mr-bb-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border, #30363d);
}
.mr-bb-time {
  color: var(--text-muted, #6b7280);
  font-size: 11px;
  margin-left: auto;
}
.mr-bb-markdown {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary, #c9d1d9);
}
.mr-bb-markdown h1, .mr-bb-markdown h2, .mr-bb-markdown h3 {
  color: var(--text-primary, #e5e7eb);
  margin: 16px 0 8px;
  border-bottom: 1px solid var(--border, #30363d);
  padding-bottom: 4px;
}
.mr-bb-markdown code {
  background: var(--bg-secondary, #161b22);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 13px;
}
.mr-bb-markdown pre {
  background: var(--bg-secondary, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
}
.mr-bb-markdown pre code { background: none; padding: 0; }
.mr-bb-markdown ul, .mr-bb-markdown ol { padding-left: 20px; }
.mr-bb-markdown li { margin: 4px 0; }
.mr-bb-markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
}
.mr-bb-markdown th, .mr-bb-markdown td {
  border: 1px solid var(--border, #30363d);
  padding: 6px 10px;
  text-align: left;
}
.mr-bb-markdown th { background: var(--bg-secondary, #161b22); font-weight: 600; }
.mr-bb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--text-secondary, #8b949e);
  font-size: 14px;
}
```

- [ ] **Step 4: Commit**

```bash
git add renderer/meeting-blackboard.js renderer/meeting-room.css
git commit -m "feat(meeting): redesign Blackboard as Markdown-rendered summary with tab switching"
```

- [ ] **Step 5: E2E 测试 — Blackboard Markdown 渲染**

启动隔离 Hub → 创建会议 + Gemini + Codex → 发消息 → 等待回复 → 切到 Blackboard → 截图验证:
- Tab 栏显示各 AI 名称
- 当前 tab 显示 Markdown 渲染的摘要（标题、列表、代码块正常显示）
- 切 tab 显示另一个 AI 的摘要
- 切回 Focus 终端仍然正常

---

### Task 5: 集成测试 + 持久化验证

**Files:**
- Test script (新建)

- [ ] **Step 1: E2E 完整流程测试**

启动隔离 Hub → 完整操作流程:
1. 创建会议室 → 默认 Focus，无 Split 按钮
2. 添加 Gemini + Codex
3. 广播 "hi" → 等待回复
4. 验证 tab 状态指示（streaming → new-output → 切 tab 后 idle）
5. 点 Focus toolbar 同步按钮 → 同步完成不切模式
6. 切 Blackboard → Markdown 渲染正常
7. 切回 Focus → 终端正常
8. 截图全流程

- [ ] **Step 2: 持久化 + 重启测试**

关闭 Hub → 重启 → 验证:
- 会议恢复为 Focus 模式
- 旧的 `layout: 'split'` 数据自动迁移为 `'focus'`
- 截图确认

- [ ] **Step 3: Commit 所有测试截图**

```bash
git add tests/e2e-proof-screenshots/
git commit -m "test: add meeting room v2 E2E proof screenshots"
```
