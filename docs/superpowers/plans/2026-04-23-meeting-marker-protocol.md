# 会议室标记协议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将会议室 L0 摘要引擎从 40+ 正则去噪重构为 AI 自标记提取，同时增加基于标记的状态检测。

**Architecture:** 用户发送消息时追加标记指令，AI 在回答末尾输出 `<<<MEETING_SUMMARY>>>...<<<END_SUMMARY>>>` 包裹的自我摘要。L0 通过 `lastIndexOf` 提取标记间内容，无 fallback（返回空 + UI 提示）。标记的存在性用于推断 AI 输出状态（`—` / `⏳` / `✓`），展示在 tab 上。

**Tech Stack:** Electron (Node.js main + renderer), xterm.js, node-pty

---

## File Map

| 文件 | 操作 | 职责 |
|------|------|------|
| `core/ansi-utils.js` | 大幅删减 | 只保留 `stripAnsi()`，删除 `removePromptNoise` / `extractLastResponse` / `smartTruncate` / `TUI_LINE_PATTERNS` |
| `core/summary-engine.js` | 修改 | 新增标记常量 + `extractMarker()`，重写 `quickSummary()` 和 `deepSummary()` |
| `main.js` | 修改 | 新增 `marker-status` IPC handler |
| `renderer/meeting-room.js` | 修改 | `handleMeetingSend()` 追加标记指令，`renderHeader()` / `createSubSlot()` 增加状态指示器 |
| `renderer/meeting-blackboard.js` | 修改 | 无标记时显示 UI 提示 |
| `renderer/meeting-room.css` | 修改 | 状态指示器样式 |

---

### Task 1: 瘦身 ansi-utils.js — 删除正则去噪代码

**Files:**
- Modify: `core/ansi-utils.js` (全文重写，从 152 行 → ~15 行)
- Modify: `core/summary-engine.js:5` (更新 require 语句)

- [ ] **Step 1: 重写 ansi-utils.js，只保留 stripAnsi**

```js
// core/ansi-utils.js

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor, scroll)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (title, hyperlinks)
    .replace(/\x1b\][^\x07\x1b]*/g, '')        // unterminated OSC (ConPTY truncation)
    .replace(/\x1b[()][AB012]/g, '')            // charset switches
    .replace(/\x1b[=>Nc7-9]/g, '')              // misc escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // control chars (keep \n \r \t)
}

module.exports = { stripAnsi };
```

- [ ] **Step 2: 更新 summary-engine.js 的 require 语句**

`core/summary-engine.js:5` — 改为：

```js
const { stripAnsi } = require('./ansi-utils');
```

- [ ] **Step 3: 验证无其他文件引用被删函数**

Run: `grep -r "removePromptNoise\|extractLastResponse\|smartTruncate\|TUI_LINE_PATTERNS" --include="*.js" .`

Expected: 只剩 `summary-engine.js` 中的调用（将在下一个 Task 中修改）。如发现其他引用，需同步清理。

- [ ] **Step 4: Commit**

```bash
git add core/ansi-utils.js core/summary-engine.js
git commit -m "refactor: strip ansi-utils to only stripAnsi, remove 40+ regex patterns"
```

---

### Task 2: 重写 summary-engine.js — 标记提取逻辑

**Files:**
- Modify: `core/summary-engine.js` (重写 quickSummary / deepSummary，新增 extractMarker / markerStatus / MARKER_INSTRUCTION)

- [ ] **Step 1: 重写 summary-engine.js**

```js
// core/summary-engine.js
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { stripAnsi } = require('./ansi-utils');

const DEFAULT_TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'summary-templates.json');

const START_MARKER = '<<<MEETING_SUMMARY>>>';
const END_MARKER = '<<<END_SUMMARY>>>';
const MARKER_INSTRUCTION = '\n\n（请在回答的最末尾，用 <<<MEETING_SUMMARY>>> 和 <<<END_SUMMARY>>> 标记包裹核心摘要（100-300字），保留关键结论与依据。若内容复杂难以精简，可将完整分析写入 .md 文件，标记内只需注明文件路径。不要解释这些标记。）';

class SummaryEngine {
  constructor(config = {}) {
    this._templatesPath = config.templatesPath || DEFAULT_TEMPLATES_PATH;
    this._templates = null;
  }

  _loadTemplates() {
    if (this._templates) return this._templates;
    try {
      const raw = fs.readFileSync(this._templatesPath, 'utf-8');
      this._templates = JSON.parse(raw);
    } catch (e) {
      console.error('[summary-engine] Failed to load templates:', e.message);
      return { scenes: {}, deep: { system: '', promptTemplate: '{{content}}' } };
    }
    return this._templates;
  }

  reloadTemplates() {
    this._templates = null;
    return this._loadTemplates();
  }

  getScenes() {
    const t = this._loadTemplates();
    const result = [];
    for (const [key, val] of Object.entries(t.scenes || {})) {
      result.push({ key, label: val.label || key });
    }
    return result;
  }

  getMarkerInstruction() {
    return MARKER_INSTRUCTION;
  }

  extractMarker(rawBuffer) {
    if (!rawBuffer) return '';
    const cleaned = stripAnsi(rawBuffer);
    const startIdx = cleaned.lastIndexOf(START_MARKER);
    if (startIdx < 0) return '';
    const contentStart = startIdx + START_MARKER.length;
    const endIdx = cleaned.indexOf(END_MARKER, contentStart);
    if (endIdx < 0) {
      return cleaned.slice(contentStart).trim();
    }
    return cleaned.slice(contentStart, endIdx).trim();
  }

  markerStatus(rawBuffer) {
    if (!rawBuffer) return 'none';
    const cleaned = stripAnsi(rawBuffer);
    const hasStart = cleaned.lastIndexOf(START_MARKER) >= 0;
    const hasEnd = cleaned.lastIndexOf(END_MARKER) >= 0;
    if (hasStart && hasEnd) return 'done';
    if (hasStart) return 'streaming';
    return 'none';
  }

  quickSummary(rawBuffer) {
    return this.extractMarker(rawBuffer);
  }

  async deepSummary(rawBuffer, options = {}) {
    const { agentName = 'AI', question = '', scene = 'free_discussion' } = options;

    const content = this.extractMarker(rawBuffer);
    if (!content) return '';

    const t = this._loadTemplates();
    const sceneConfig = (t.scenes || {})[scene] || (t.scenes || {}).free_discussion || {};
    const instruction = sceneConfig.instruction || '';
    const system = (t.deep || {}).system || '';
    const template = (t.deep || {}).promptTemplate || '{{content}}';

    const prompt = template
      .replace('{{agent_name}}', agentName)
      .replace('{{question}}', question)
      .replace('{{content}}', content)
      .replace('{{instruction}}', instruction);

    try {
      const summary = await this._callGeminiPipe(system, prompt);
      return summary;
    } catch (err) {
      console.error('[summary-engine] Gemini pipe failed:', err.message);
      return '';
    }
  }

  buildInjection(otherSummaries, userFollowUp) {
    if (!otherSummaries || otherSummaries.length === 0) return userFollowUp || '';
    let payload = '[会议室协作同步]\n';
    for (const s of otherSummaries) {
      payload += `【${s.label}】${s.summary}\n`;
    }
    payload += '---\n';
    if (userFollowUp) payload += userFollowUp;
    return payload;
  }

  _callGeminiPipe(system, prompt) {
    return new Promise((resolve, reject) => {
      const args = ['-p'];
      if (system) {
        args.push('--system-prompt', system);
      }

      const child = execFile('gemini', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gemini -p failed: ${err.message} stderr: ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      });

      child.stdin.on('error', (e) => {
        if (e.code !== 'EPIPE') reject(e);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

module.exports = { SummaryEngine, START_MARKER, END_MARKER, MARKER_INSTRUCTION };
```

- [ ] **Step 2: Commit**

```bash
git add core/summary-engine.js
git commit -m "refactor: rewrite summary-engine with marker extraction, remove regex L0"
```

---

### Task 3: 新增 marker-status IPC handler

**Files:**
- Modify: `main.js:373-376` (在 `quick-summary` handler 附近新增)

- [ ] **Step 1: 在 main.js 的 quick-summary handler 之后新增 marker-status handler**

在 `main.js` 第 376 行（`quick-summary` handler 的 `});` 之后）插入：

```js
ipcMain.handle('marker-status', (_e, sessionId) => {
  const raw = sessionManager.getSessionBuffer(sessionId);
  return summaryEngine.markerStatus(raw || '');
});
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "feat: add marker-status IPC handler for AI output state detection"
```

---

### Task 4: 会议室发送时追加标记指令

**Files:**
- Modify: `renderer/meeting-room.js:461-484` (`handleMeetingSend` 函数)

- [ ] **Step 1: 修改 handleMeetingSend，在发送文本末尾追加标记指令**

将 `renderer/meeting-room.js` 中 `handleMeetingSend` 函数的 `let payload = text;` 部分修改为：

```js
  async function handleMeetingSend(text, meeting) {
    const current = meetingData[meeting.id] || meeting;
    const targets = current.sendTarget === 'all'
      ? current.subSessions.filter(sid => {
          const s = sessions ? sessions.get(sid) : null;
          return s && s.status !== 'dormant';
        })
      : [current.sendTarget];

    const markerInstruction = await ipcRenderer.invoke('get-marker-instruction');

    for (const sessionId of targets) {
      let payload = text + markerInstruction;
      if (meeting.syncContext) {
        const context = await buildContextSummary(meeting, sessionId);
        payload = context + payload;
      }
      ipcRenderer.send('terminal-input', { sessionId, data: payload });
      setTimeout(() => {
        ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
      }, 80);
    }

    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  }
```

- [ ] **Step 2: 在 main.js 中注册 get-marker-instruction IPC handler**

在 `main.js` 的 `marker-status` handler 之后新增：

```js
ipcMain.handle('get-marker-instruction', () => {
  return summaryEngine.getMarkerInstruction();
});
```

- [ ] **Step 3: Commit**

```bash
git add renderer/meeting-room.js main.js
git commit -m "feat: append marker instruction when sending messages in meeting room"
```

---

### Task 5: Tab 状态指示器 — CSS + 渲染逻辑

**Files:**
- Modify: `renderer/meeting-room.css` (新增状态指示器样式)
- Modify: `renderer/meeting-room.js` (`renderHeader` / `createSubSlot` / `status-event` listener)

- [ ] **Step 1: 在 meeting-room.css 末尾添加状态指示器样式**

```css
/* Marker status indicator */
.mr-marker-status {
  display: inline-block;
  font-size: 11px;
  margin-left: 4px;
  vertical-align: middle;
}

.mr-marker-status.done {
  color: #3fb950;
}

.mr-marker-status.streaming {
  color: #d29922;
  animation: pulse 1.2s ease-in-out infinite;
}

.mr-marker-status.none {
  color: var(--text-secondary, #8b949e);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

- [ ] **Step 2: 新增 markerStatusHtml 辅助函数**

在 `renderer/meeting-room.js` 的 `subCtxBadgeHtml` 函数之后添加：

```js
  function markerStatusHtml(sessionId) {
    const cache = _markerStatusCache[sessionId];
    if (!cache) return '<span class="mr-marker-status none">—</span>';
    if (cache === 'done') return '<span class="mr-marker-status done">✓</span>';
    if (cache === 'streaming') return '<span class="mr-marker-status streaming">⏳</span>';
    return '<span class="mr-marker-status none">—</span>';
  }
```

- [ ] **Step 3: 新增 _markerStatusCache 和定时刷新**

在 `renderer/meeting-room.js` 的 `let subTerminals = {};` 之后添加：

```js
  let _markerStatusCache = {};
  let _markerPollTimer = null;

  function startMarkerPoll() {
    if (_markerPollTimer) return;
    _markerPollTimer = setInterval(async () => {
      if (!activeMeetingId) return;
      const meeting = meetingData[activeMeetingId];
      if (!meeting) return;
      let changed = false;
      for (const sid of meeting.subSessions) {
        const status = await ipcRenderer.invoke('marker-status', sid);
        if (_markerStatusCache[sid] !== status) {
          _markerStatusCache[sid] = status;
          changed = true;
        }
      }
      if (changed) updateMarkerBadges(meeting);
    }, 2000);
  }

  function stopMarkerPoll() {
    if (_markerPollTimer) { clearInterval(_markerPollTimer); _markerPollTimer = null; }
  }

  function updateMarkerBadges(meeting) {
    for (const sid of meeting.subSessions) {
      const badge = markerStatusHtml(sid);
      // Update split-mode sub-slot
      const slot = document.querySelector(`.mr-sub-slot[data-session-id="${sid}"] .mr-marker-badge`);
      if (slot) slot.outerHTML = badge.replace('mr-marker-status', 'mr-marker-status mr-marker-badge');
      // Update focus-mode tab
      const tab = document.querySelector(`.mr-tab[data-sid="${sid}"] .mr-marker-badge`);
      if (tab) tab.outerHTML = badge.replace('mr-marker-status', 'mr-marker-status mr-marker-badge');
    }
  }
```

- [ ] **Step 4: 在 renderHeader 的 tab 按钮中加入状态指示器**

在 `renderHeader` 函数中，Focus 模式 tab 生成部分（当前约第 91 行），将 tab HTML 改为包含 marker badge：

```js
      const tabs = meeting.subSessions.map(sid => {
        const s = sessions ? sessions.get(sid) : null;
        const label = s ? (s.title || s.kind) : 'session';
        const badges = subModelBadgeHtml(s) + subCtxBadgeHtml(s);
        const markerBadge = `<span class="mr-marker-status mr-marker-badge ${_markerStatusCache[sid] || 'none'}">${
          _markerStatusCache[sid] === 'done' ? '✓' : _markerStatusCache[sid] === 'streaming' ? '⏳' : '—'
        }</span>`;
        const cls = sid === focused ? 'mr-tab active' : 'mr-tab';
        return `<button class="${cls}" data-sid="${sid}">${escapeHtml(label)}${badges ? ' ' + badges : ''} ${markerBadge}</button>`;
      }).join('');
```

- [ ] **Step 5: 在 createSubSlot 的 header 中加入状态指示器**

在 `createSubSlot` 函数中（当前约第 300 行），将 header innerHTML 中的 badgeHtml 后追加 marker badge：

```js
    const markerBadge = `<span class="mr-marker-status mr-marker-badge ${_markerStatusCache[sessionId] || 'none'}">${
      _markerStatusCache[sessionId] === 'done' ? '✓' : _markerStatusCache[sessionId] === 'streaming' ? '⏳' : '—'
    }</span>`;
    header.innerHTML = `
      <span class="mr-sub-label">${escapeHtml(slotTitle)}${badgeHtml ? ' ' + badgeHtml : ''} ${markerBadge}</span>
      <button class="mr-sub-close" title="关闭此会话">✕</button>
    `;
```

- [ ] **Step 6: 在 openMeeting 中启动轮询，在 closeMeetingPanel 中停止**

在 `openMeeting` 函数末尾（`setupInput(meeting);` 之后）添加：

```js
    startMarkerPoll();
```

在 `closeMeetingPanel` 函数中（`_inputBound = false;` 之后）添加：

```js
    stopMarkerPoll();
    _markerStatusCache = {};
```

- [ ] **Step 7: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat: add marker-based AI status indicators on meeting room tabs"
```

---

### Task 6: Blackboard 无标记 UI 提示

**Files:**
- Modify: `renderer/meeting-blackboard.js:46-74` (`renderBlackboard` 列渲染)

- [ ] **Step 1: 修改 renderBlackboard 中的列内容展示**

在 `renderBlackboard` 函数中，将列内容渲染部分（当前约第 51 行起）改为检测标记状态并显示提示：

```js
    for (const sid of currentSubs) {
      const label = getLabel(sid);
      const cache = _summaryCache[sid] || { quick: '', deep: '' };
      const displaySummary = cache.deep || cache.quick || '';
      const isExpanded = !!_expandedRaw[sid];

      const markerStatus = await ipcRenderer.invoke('marker-status', sid);
      let statusBadge = '';
      if (markerStatus === 'done') statusBadge = '<span class="mr-marker-status done">✓</span>';
      else if (markerStatus === 'streaming') statusBadge = '<span class="mr-marker-status streaming">⏳</span>';

      let summaryHtml;
      if (displaySummary) {
        summaryHtml = `<div class="mr-bb-summary">${escapeHtml(displaySummary)}</div>`;
      } else if (markerStatus === 'streaming') {
        summaryHtml = '<div class="mr-bb-summary" style="color:var(--text-secondary);font-style:italic">正在输出中…</div>';
      } else {
        summaryHtml = '<div class="mr-bb-summary" style="color:var(--text-secondary);font-style:italic">未检测到摘要标记。请确认 AI 已完成回答。</div>';
      }

      const col = document.createElement('div');
      col.className = 'mr-bb-column';
      col.dataset.sessionId = sid;

      col.innerHTML = `
        <div class="mr-bb-col-header">
          <span class="mr-bb-col-label">${escapeHtml(label)}</span>
          ${statusBadge}
          ${cache.deep ? '<span class="mr-bb-badge-deep">深度</span>' : ''}
        </div>
        ${summaryHtml}
        <button class="mr-bb-toggle-raw">${isExpanded ? '▼ 收起原文' : '▶ 展开原文'}</button>
        <div class="mr-bb-raw" style="display:${isExpanded ? 'block' : 'none'}">${escapeHtml(cache.quick || '')}</div>
      `;

      col.querySelector('.mr-bb-toggle-raw').addEventListener('click', () => {
        _expandedRaw[sid] = !_expandedRaw[sid];
        renderBlackboard(meeting, container);
      });

      container.appendChild(col);
    }
```

- [ ] **Step 2: Commit**

```bash
git add renderer/meeting-blackboard.js
git commit -m "feat: show marker status and no-marker hint in blackboard view"
```

---

### Task 7: 代码审查

**Files:**
- 所有改动文件：`core/ansi-utils.js`, `core/summary-engine.js`, `main.js`, `renderer/meeting-room.js`, `renderer/meeting-room.css`, `renderer/meeting-blackboard.js`

- [ ] **Step 1: 使用 enhanced-code-reviewer agent 审查所有改动**

运行 `git diff HEAD~6 --stat` 确认所有改动文件，然后对每个文件进行审查。重点检查：
- 被删函数无遗留引用（`grep -r "removePromptNoise\|extractLastResponse\|smartTruncate" --include="*.js" .`）
- `extractMarker` 边界情况（空 buffer、只有 START、标记被 ANSI 穿插）
- `innerHTML` 使用处已通过 `escapeHtml` 防 XSS
- `markerStatus` IPC 调用频率合理（每 2 秒轮询，不会造成性能问题）

- [ ] **Step 2: 修复审查发现的问题并 commit**

```bash
git add -A
git commit -m "fix: address code review findings for marker protocol"
```

---

### Task 8: E2E 真实测试 + 截图

**Files:**
- 无新代码，测试在隔离 Hub 实例中进行

- [ ] **Step 1: 启动隔离 Hub 实例**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-marker-test"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9222
```

- [ ] **Step 2: 标记注入验证**

在会议室中创建至少 2 个子会话（Gemini + Codex），发送一条消息。在终端中观察消息末尾是否追加了标记指令。**截图保存**。

- [ ] **Step 3: 标记提取验证**

等待至少一个 AI 回答完成，切换到 Blackboard 视图，确认摘要内容为标记提取的干净文本。**截图保存**。

- [ ] **Step 4: 状态指示器验证**

在 Focus 或 Split 模式下，观察 tab/header 上的状态指示器。确认：
- AI 回答前显示 `—`
- AI 输出中显示 `⏳`（闪烁动画）
- AI 回答完成显示 `✓`

**截图保存**。

- [ ] **Step 5: 无标记 fallback 验证**

对一个尚未收到消息的子会话，切换到 Blackboard 视图，确认显示"未检测到摘要标记"提示。**截图保存**。

- [ ] **Step 6: 关闭隔离 Hub，整理截图证据**

确认所有截图已保存到 `~/.claude-session-hub/images/` 或项目 `docs/` 目录。
