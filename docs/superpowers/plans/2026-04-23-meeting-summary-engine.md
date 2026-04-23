# Meeting Summary Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-tier summary engine and blackboard layout to the meeting room, enabling structured comparison and cross-AI collaboration injection.

**Architecture:** Three new files (`core/summary-engine.js`, `renderer/meeting-blackboard.js`, `config/summary-templates.json`) plus modifications to existing meeting room code. SummaryEngine handles L0 (programmatic) and L2 (LLM via Gemini CLI pipe) summaries. Blackboard is a third layout mode alongside Split/Focus.

**Tech Stack:** Electron, node-pty, xterm.js, Gemini CLI (`gemini -p` pipe mode)

**Spec:** `docs/superpowers/specs/2026-04-23-meeting-summary-engine-design.md`

---

### Task 1: Increase Ring Buffer + Add ANSI Strip Utility

**Files:**
- Modify: `core/session-manager.js:5` (RING_BUFFER_BYTES constant)
- Create: `core/ansi-utils.js`

- [ ] **Step 1: Create `core/ansi-utils.js` with strip and denoise functions**

```javascript
// core/ansi-utils.js

// Strip ANSI escape sequences (colors, cursor moves, etc.)
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')   // OSC sequences
            .replace(/\x1b[()][AB012]/g, '')        // charset switches
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // control chars (keep \n \r \t)
}

// Remove CLI prompt noise: spinners, progress bars, prompt symbols
function removePromptNoise(str) {
  return str
    .replace(/^[❯$>%#]\s*/gm, '')                   // prompt prefixes
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, '')     // spinner chars
    .replace(/\[=*>?\s*\]\s*\d+%/g, '')              // progress bars [===>] 45%
    .replace(/^\s*\n/gm, '\n')                       // collapse blank lines
    .replace(/\n{3,}/g, '\n\n')                      // max 2 consecutive newlines
    .replace(/\r/g, '')                               // carriage returns
    .trim();
}

// Extract the last AI response from cleaned terminal output.
// Heuristic: find the last prompt boundary and take everything after it.
function extractLastResponse(cleaned) {
  // Common boundaries: "❯ ", "$ ", "> ", or a blank line after a command
  const lines = cleaned.split('\n');
  let lastBoundary = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^(❯|[$>%#])\s/.test(line) || /^\s*$/.test(line) && i < lines.length - 2) {
      lastBoundary = i;
      break;
    }
  }

  if (lastBoundary >= 0 && lastBoundary < lines.length - 1) {
    return lines.slice(lastBoundary + 1).join('\n').trim();
  }
  return cleaned;
}

// Smart truncate at sentence boundary
function smartTruncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  // Try to cut at last sentence end
  const lastSentence = truncated.search(/[。.!！?\?\n][^。.!！?\?\n]*$/);
  if (lastSentence > maxLen * 0.5) {
    return truncated.slice(0, lastSentence + 1);
  }
  return truncated;
}

module.exports = { stripAnsi, removePromptNoise, extractLastResponse, smartTruncate };
```

- [ ] **Step 2: Increase RING_BUFFER_BYTES**

In `core/session-manager.js` line 5, change:
```javascript
// Before
const RING_BUFFER_BYTES = 8192;
// After
const RING_BUFFER_BYTES = 16384;
```

- [ ] **Step 3: Verify no regressions**

```bash
cd C:\Users\lintian\claude-session-hub
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: `[hub] hook server listening on 127.0.0.1:...` (no crash)

- [ ] **Step 4: Commit**

```bash
git add core/ansi-utils.js core/session-manager.js
git commit -m "feat(meeting): add ANSI utils and increase ring buffer to 16KB"
```

---

### Task 2: Create Summary Templates Config

**Files:**
- Create: `config/summary-templates.json`

- [ ] **Step 1: Create `config/summary-templates.json`**

```json
{
  "summaryModel": "gemini",
  "deep": {
    "system": "You are a collaboration summary assistant. Extract key information from an AI's response and output a concise structured summary. Always respond in the same language as the input content.",
    "promptTemplate": "以下是 {{agent_name}} 对问题「{{question}}」的回答：\n\n{{content}}\n\n{{instruction}}"
  },
  "scenes": {
    "free_discussion": {
      "label": "自由讨论",
      "instruction": "请提取关键信息，包括但不限于：\n- 核心观点\n- 支撑论据\n- 如果有权衡取舍，指出放弃了什么\n- 如果有未决问题，列出\n跳过不适用的项。200字以内。"
    },
    "code_review": {
      "label": "代码审查",
      "instruction": "从代码审查中提取：\n- 发现的问题列表（含文件名/行号/严重级别）\n- 修复建议\n- 代码优点（如果提到了）\n按严重级别排序，200字以内。"
    },
    "stock_analysis": {
      "label": "投研分析",
      "instruction": "从投研分析中提取：\n- 结论/评级/评分\n- 核心投资逻辑\n- 主要风险点\n- 催化剂/时间节点\n200字以内。"
    },
    "debug": {
      "label": "Debug",
      "instruction": "从调试分析中提取：\n- 根因定位（哪个模块/函数/行）\n- 修复方案\n- 验证步骤\n- 是否有副作用或关联问题\n200字以内。"
    },
    "knowledge_qa": {
      "label": "知识问答",
      "instruction": "用一两句话概括回答的核心要点。50字以内。"
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add config/summary-templates.json
git commit -m "feat(meeting): add summary prompt templates for 5 scenes"
```

---

### Task 3: Create SummaryEngine Core

**Files:**
- Create: `core/summary-engine.js`

- [ ] **Step 1: Create `core/summary-engine.js`**

```javascript
// core/summary-engine.js
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { stripAnsi, removePromptNoise, extractLastResponse, smartTruncate } = require('./ansi-utils');

const DEFAULT_TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'summary-templates.json');

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
      this._templates = { scenes: {}, deep: { system: '', promptTemplate: '{{content}}' } };
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

  // --- L0: Quick Summary (zero LLM cost) ---

  quickSummary(rawBuffer) {
    if (!rawBuffer) return '';
    let cleaned = stripAnsi(rawBuffer);
    cleaned = removePromptNoise(cleaned);
    cleaned = extractLastResponse(cleaned);
    return smartTruncate(cleaned, 2000);
  }

  // --- L2: Deep Summary (Gemini Flash via pipe) ---

  async deepSummary(rawBuffer, options = {}) {
    const { agentName = 'AI', question = '', scene = 'free_discussion' } = options;

    let cleaned = stripAnsi(rawBuffer);
    cleaned = removePromptNoise(cleaned);
    cleaned = extractLastResponse(cleaned);
    if (!cleaned) return '';

    const t = this._loadTemplates();
    const sceneConfig = (t.scenes || {})[scene] || (t.scenes || {}).free_discussion || {};
    const instruction = sceneConfig.instruction || '';
    const system = (t.deep || {}).system || '';
    const template = (t.deep || {}).promptTemplate || '{{content}}';

    const prompt = template
      .replace('{{agent_name}}', agentName)
      .replace('{{question}}', question)
      .replace('{{content}}', cleaned)
      .replace('{{instruction}}', instruction);

    try {
      const summary = await this._callGeminiPipe(system, prompt);
      return summary;
    } catch (err) {
      console.error('[summary-engine] Gemini pipe failed, falling back to L0:', err.message);
      return smartTruncate(cleaned, 2000);
    }
  }

  // --- Injection Payload ---

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

  // --- Private: call Gemini CLI in pipe mode ---

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

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

module.exports = { SummaryEngine };
```

- [ ] **Step 2: Verify module loads**

```bash
cd C:\Users\lintian\claude-session-hub
node -e "const { SummaryEngine } = require('./core/summary-engine'); const e = new SummaryEngine(); console.log('scenes:', e.getScenes()); console.log('L0 test:', e.quickSummary('\\x1b[32mHello\\x1b[0m world\\n❯ test')); console.log('OK')"
```

Expected: prints scenes list, L0 cleaned output, and "OK" without errors.

- [ ] **Step 3: Commit**

```bash
git add core/summary-engine.js
git commit -m "feat(meeting): add SummaryEngine with L0 quick and L2 deep modes"
```

---

### Task 4: Wire IPC Handlers in main.js

**Files:**
- Modify: `main.js:311-356` (Meeting Room IPC section)

- [ ] **Step 1: Add SummaryEngine instantiation near top of main.js**

Find the line where `MeetingRoomManager` is instantiated (search for `new MeetingRoomManager`), and add after it:

```javascript
const { SummaryEngine } = require('./core/summary-engine');
const summaryEngine = new SummaryEngine();
```

- [ ] **Step 2: Add IPC handlers after the existing `get-ring-buffer` handler (after line 351)**

Insert after `ipcMain.handle('get-ring-buffer', ...)`:

```javascript
ipcMain.handle('quick-summary', (_e, sessionId) => {
  const raw = sessionManager.getSessionBuffer(sessionId);
  return summaryEngine.quickSummary(raw || '');
});

ipcMain.handle('deep-summary', async (_e, { sessionId, scene, question, agentName }) => {
  const raw = sessionManager.getSessionBuffer(sessionId);
  if (!raw) return '';
  return await summaryEngine.deepSummary(raw, { agentName, question, scene });
});

ipcMain.handle('get-summary-scenes', () => {
  return summaryEngine.getScenes();
});

ipcMain.handle('build-injection', (_e, { summaries, userFollowUp }) => {
  return summaryEngine.buildInjection(summaries, userFollowUp);
});
```

- [ ] **Step 3: Smoke test**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: Normal startup, no crash.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(meeting): wire summary engine IPC handlers"
```

---

### Task 5: Add `lastScene` Field to Meeting Data Model

**Files:**
- Modify: `core/meeting-room.js:11-24` (createMeeting)
- Modify: `core/meeting-room.js:63` (updateMeeting allowed fields)

- [ ] **Step 1: Add `lastScene` to meeting object in `createMeeting()`**

In `core/meeting-room.js`, inside the `createMeeting()` method, add `lastScene` to the meeting object (after `status: 'idle'`):

```javascript
      status: 'idle',
      lastScene: 'free_discussion',
```

- [ ] **Step 2: Add `lastScene` to allowed update fields**

In `core/meeting-room.js` line 63, update the allowed array:

```javascript
// Before
const allowed = ['title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned', 'lastMessageTime', 'status'];
// After
const allowed = ['title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned', 'lastMessageTime', 'status', 'lastScene'];
```

- [ ] **Step 3: Commit**

```bash
git add core/meeting-room.js
git commit -m "feat(meeting): add lastScene field to meeting data model"
```

---

### Task 6: Create Blackboard UI Renderer

**Files:**
- Create: `renderer/meeting-blackboard.js`

- [ ] **Step 1: Create `renderer/meeting-blackboard.js`**

```javascript
// renderer/meeting-blackboard.js
// Blackboard layout: structured summary comparison + sync controls.
// Consumed by meeting-room.js when layout === 'blackboard'.

(function () {
  const { ipcRenderer } = require('electron');

  let _summaryCache = {};  // sessionId -> { quick: string, deep: string }
  let _expandedRaw = {};   // sessionId -> boolean
  let _syncing = false;

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Render blackboard columns for each sub-session
  async function renderBlackboard(meeting, container) {
    container.innerHTML = '';
    container.className = 'mr-terminals mr-blackboard';

    const subs = meeting.subSessions || [];
    if (subs.length === 0) {
      container.innerHTML = '<div class="mr-bb-empty">暂无子会话，请先添加 AI</div>';
      return;
    }

    // Generate L0 summaries for all sub-sessions
    for (const sid of subs) {
      if (!_summaryCache[sid]) {
        const quick = await ipcRenderer.invoke('quick-summary', sid);
        _summaryCache[sid] = { quick, deep: '' };
      }
    }

    // Create columns
    for (const sid of subs) {
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const label = session ? (session.title || session.kind || 'AI') : 'AI';
      const cache = _summaryCache[sid] || { quick: '', deep: '' };
      const displaySummary = cache.deep || cache.quick || '(暂无输出)';
      const isExpanded = !!_expandedRaw[sid];

      const col = document.createElement('div');
      col.className = 'mr-bb-column';
      col.dataset.sessionId = sid;

      col.innerHTML = `
        <div class="mr-bb-col-header">
          <span class="mr-bb-col-label">${escapeHtml(label)}</span>
          ${cache.deep ? '<span class="mr-bb-badge-deep">深度</span>' : ''}
        </div>
        <div class="mr-bb-summary">${escapeHtml(displaySummary)}</div>
        <button class="mr-bb-toggle-raw">${isExpanded ? '▼ 收起原文' : '▶ 展开原文'}</button>
        <div class="mr-bb-raw" style="display:${isExpanded ? 'block' : 'none'}">${escapeHtml(cache.quick || '')}</div>
      `;

      // Toggle raw expand
      col.querySelector('.mr-bb-toggle-raw').addEventListener('click', () => {
        _expandedRaw[sid] = !_expandedRaw[sid];
        renderBlackboard(meeting, container);
      });

      container.appendChild(col);
    }
  }

  // Render blackboard toolbar (replaces normal toolbar when in blackboard mode)
  function renderBlackboardToolbar(meeting, toolbarEl) {
    if (!toolbarEl) return;

    // Build target options
    let targetHtml = '<option value="all">全部</option>';
    for (const sid of meeting.subSessions) {
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const label = session ? (session.title || session.kind || sid) : sid;
      const sel = meeting.sendTarget === sid ? ' selected' : '';
      targetHtml += `<option value="${sid}"${sel}>${escapeHtml(label)}</option>`;
    }

    // Build scene options from templates
    const lastScene = meeting.lastScene || 'free_discussion';

    // We'll load scenes async on first render
    const sceneSelectId = 'mr-bb-scene-select';

    toolbarEl.innerHTML = `
      <label>发送到: <select class="mr-target-select" id="mr-bb-target">${targetHtml}</select></label>
      <label>场景: <select class="mr-target-select" id="${sceneSelectId}">
        <option value="free_discussion">自动</option>
      </select></label>
      <button class="mr-header-btn" id="mr-bb-quick-sync" ${_syncing ? 'disabled' : ''}>快速同步</button>
      <button class="mr-header-btn" id="mr-bb-deep-sync" style="background:var(--accent);color:#fff" ${_syncing ? 'disabled' : ''}>深度同步</button>
    `;

    // Load scenes into dropdown
    ipcRenderer.invoke('get-summary-scenes').then(scenes => {
      const select = document.getElementById(sceneSelectId);
      if (!select) return;
      select.innerHTML = '';
      for (const s of scenes) {
        const opt = document.createElement('option');
        opt.value = s.key;
        opt.textContent = s.label;
        if (s.key === lastScene) opt.selected = true;
        select.appendChild(opt);
      }
    });

    // Target change
    document.getElementById('mr-bb-target').addEventListener('change', (e) => {
      meeting.sendTarget = e.target.value;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: meeting.sendTarget } });
    });

    // Scene change — remember selection
    const sceneEl = document.getElementById(sceneSelectId);
    if (sceneEl) {
      sceneEl.addEventListener('change', (e) => {
        meeting.lastScene = e.target.value;
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastScene: meeting.lastScene } });
      });
    }

    // Quick sync button
    document.getElementById('mr-bb-quick-sync').addEventListener('click', () => {
      handleSync(meeting, 'quick');
    });

    // Deep sync button
    document.getElementById('mr-bb-deep-sync').addEventListener('click', () => {
      handleSync(meeting, 'deep');
    });
  }

  // Handle sync: generate summaries and inject into target(s)
  async function handleSync(meeting, mode) {
    if (_syncing) return;
    _syncing = true;

    try {
      const sceneEl = document.getElementById('mr-bb-scene-select');
      const scene = sceneEl ? sceneEl.value : 'free_discussion';
      const inputBox = document.getElementById('mr-input-box');
      const userFollowUp = inputBox ? inputBox.innerText.trim() : '';

      const targetIds = meeting.sendTarget === 'all'
        ? meeting.subSessions.filter(sid => {
            const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
            return s && s.status !== 'dormant';
          })
        : [meeting.sendTarget];

      // For each target, build summaries of all OTHER sub-sessions
      for (const targetId of targetIds) {
        const otherIds = meeting.subSessions.filter(id => id !== targetId);
        const summaries = [];

        for (const otherId of otherIds) {
          const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(otherId) : null;
          const label = session ? (session.title || session.kind || 'AI') : 'AI';
          let summary = '';

          if (mode === 'deep') {
            summary = await ipcRenderer.invoke('deep-summary', {
              sessionId: otherId,
              scene,
              question: userFollowUp || '',
              agentName: label,
            });
            if (summary) {
              if (!_summaryCache[otherId]) _summaryCache[otherId] = { quick: '', deep: '' };
              _summaryCache[otherId].deep = summary;
            }
          }

          if (!summary) {
            summary = await ipcRenderer.invoke('quick-summary', otherId);
          }

          if (summary) {
            summaries.push({ label, summary });
          }
        }

        if (summaries.length > 0) {
          const payload = await ipcRenderer.invoke('build-injection', { summaries, userFollowUp });
          if (payload) {
            ipcRenderer.send('terminal-input', { sessionId: targetId, data: payload });
            setTimeout(() => {
              ipcRenderer.send('terminal-input', { sessionId: targetId, data: '\r' });
            }, 80);
          }
        }
      }

      // Clear input box after send
      if (inputBox && userFollowUp) inputBox.textContent = '';

      // Refresh blackboard display with updated summaries
      const container = document.getElementById('mr-terminals');
      if (container) await renderBlackboard(meeting, container);

      // Switch back to previous terminal layout so user sees AI response
      const prevLayout = meeting.layout === 'blackboard'
        ? (meeting.subSessions.length > 1 ? 'split' : 'focus')
        : meeting.layout;
      if (typeof MeetingRoom !== 'undefined') {
        meeting.layout = prevLayout;
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { layout: prevLayout } });
        MeetingRoom.openMeeting(meeting.id, meeting);
      }
    } catch (err) {
      console.error('[blackboard] sync error:', err);
    } finally {
      _syncing = false;
    }
  }

  function clearCache(meetingId) {
    _summaryCache = {};
    _expandedRaw = {};
  }

  // Expose global
  window.MeetingBlackboard = {
    renderBlackboard,
    renderBlackboardToolbar,
    clearCache,
  };
})();
```

- [ ] **Step 2: Add script tag in `renderer/index.html`**

Find the line `<script src="meeting-room.js"></script>` and add after it:

```html
<script src="meeting-blackboard.js"></script>
```

- [ ] **Step 3: Commit**

```bash
git add renderer/meeting-blackboard.js renderer/index.html
git commit -m "feat(meeting): add blackboard UI renderer with sync controls"
```

---

### Task 7: Integrate Blackboard into Meeting Room

**Files:**
- Modify: `renderer/meeting-room.js`

- [ ] **Step 1: Add Blackboard button to header**

In `renderHeader()` (line 98-108), update the header-right div to include a Blackboard button. Replace the header-right innerHTML:

```javascript
      <div class="mr-header-right">
        <button class="mr-header-btn ${meeting.layout === 'split' ? 'active' : ''}" id="mr-btn-split">Split</button>
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>
        <button class="mr-header-btn ${meeting.layout === 'blackboard' ? 'active' : ''}" id="mr-btn-blackboard">Blackboard</button>
        <button class="mr-header-btn" id="mr-btn-add-sub" title="添加子会话">+ 添加</button>
      </div>
```

- [ ] **Step 2: Add Blackboard button event listener**

After the existing `mr-btn-focus` listener (line 111), add:

```javascript
    document.getElementById('mr-btn-blackboard').addEventListener('click', () => setLayout(meeting.id, 'blackboard'));
```

- [ ] **Step 3: Update `renderHeader()` tab visibility**

Change the tabs condition (line 88) from `if (!layoutSplit ...)` to also exclude blackboard:

```javascript
    if (meeting.layout === 'focus' && meeting.subSessions.length > 0) {
```

- [ ] **Step 4: Add blackboard branch to `renderTerminals()`**

At the beginning of `renderTerminals()` (line 213-248), add a blackboard branch before the existing focus check:

```javascript
  function renderTerminals(meeting) {
    const container = terminalsEl();
    if (!container) return;

    if (meeting.layout === 'blackboard') {
      container.innerHTML = '';
      container.className = 'mr-terminals mr-blackboard';
      subTerminals = {};
      if (typeof MeetingBlackboard !== 'undefined') {
        MeetingBlackboard.renderBlackboard(meeting, container);
      }
      return;
    }

    container.innerHTML = '';
    container.className = meeting.layout === 'focus' ? 'mr-terminals focus-mode' : 'mr-terminals';
    // ... rest of existing code
```

- [ ] **Step 5: Add blackboard branch to `renderToolbar()`**

At the beginning of `renderToolbar()` (line 374), add:

```javascript
  function renderToolbar(meeting) {
    const el = toolbarEl();
    if (!el) return;

    if (meeting.layout === 'blackboard') {
      if (typeof MeetingBlackboard !== 'undefined') {
        MeetingBlackboard.renderBlackboardToolbar(meeting, el);
      }
      return;
    }

    // ... rest of existing toolbar code
```

- [ ] **Step 6: Update `setLayout()` to support blackboard**

In `setLayout()` (line 360-370), the existing code already handles arbitrary layout values since it just sets `meeting.layout = layout`. No change needed — but verify the `renderHeader` active class logic from Step 1 covers `blackboard`.

- [ ] **Step 7: Smoke test**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

- [ ] **Step 8: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(meeting): integrate blackboard layout into meeting room"
```

---

### Task 8: Add Blackboard CSS Styles

**Files:**
- Modify: `renderer/meeting-room.css`

- [ ] **Step 1: Append blackboard styles to `meeting-room.css`**

Add at end of file:

```css
/* Blackboard Layout */
.mr-blackboard {
  display: grid;
  gap: 1px;
  background: var(--border, #30363d);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.mr-blackboard:has(.mr-bb-column:nth-child(2):last-child) {
  grid-template-columns: 1fr 1fr;
}

.mr-blackboard:has(.mr-bb-column:nth-child(3)) {
  grid-template-columns: 1fr 1fr 1fr;
}

.mr-bb-column {
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #0d1117);
  padding: 12px;
  min-width: 0;
  overflow-y: auto;
}

.mr-bb-col-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border, #30363d);
}

.mr-bb-col-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary, #c9d1d9);
}

.mr-bb-badge-deep {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--accent, #6366f1);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

.mr-bb-summary {
  font-size: 13px;
  color: var(--text-primary, #c9d1d9);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  flex: 1;
  min-height: 60px;
}

.mr-bb-toggle-raw {
  display: block;
  margin-top: 8px;
  padding: 4px 0;
  border: none;
  background: none;
  color: var(--text-secondary, #8b949e);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}

.mr-bb-toggle-raw:hover {
  color: var(--accent, #6366f1);
}

.mr-bb-raw {
  margin-top: 4px;
  padding: 8px;
  background: var(--bg-secondary, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  font-family: monospace;
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.mr-bb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--text-secondary, #8b949e);
  font-size: 14px;
  grid-column: 1 / -1;
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/meeting-room.css
git commit -m "feat(meeting): add blackboard layout CSS styles"
```

---

### Task 9: End-to-End Manual Test

**Files:** None (verification only)

- [ ] **Step 1: Start Hub in isolated test instance**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-summary-test"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9225
```

- [ ] **Step 2: Create a meeting room with 2 AI sessions**

1. Click "+" → "🏢 会议室"
2. Add 2 sub-sessions (e.g., Gemini + Codex, or Claude + Gemini — avoid Opus to save cost)

- [ ] **Step 3: Test broadcast and blackboard view**

1. Type a question in the input box (e.g., "什么是 TCP 三次握手？")
2. Wait for both AIs to respond
3. Click "Blackboard" button in header
4. Verify: two columns show L0 summaries
5. Click "▶ 展开原文" on one column — verify raw output appears
6. Click again to collapse

- [ ] **Step 4: Test Quick Sync**

1. In blackboard view, set "发送到" to one specific AI
2. Click "快速同步"
3. Verify: layout switches back to Split
4. Verify: the target AI receives injected context starting with `[会议室协作同步]`

- [ ] **Step 5: Test Deep Sync**

1. Switch back to Blackboard
2. Select a scene (e.g., "自由讨论")
3. Click "深度同步"
4. Verify: Gemini Flash is called (may take 1-2 seconds)
5. Verify: blackboard updates with structured summary + "深度" badge
6. Verify: layout switches back and target AI receives structured injection

- [ ] **Step 6: Test with 3 AIs**

1. Add a third sub-session
2. Repeat Steps 3-5 with 3 columns
3. Verify: when syncing to one AI, it receives summaries from the OTHER two

- [ ] **Step 7: Test persistence**

1. Close and reopen Hub
2. Verify: meeting room restores, `lastScene` is remembered

- [ ] **Step 8: Record results**

If all pass, commit any fix-ups from testing:

```bash
git add -A
git commit -m "fix(meeting): post-test adjustments for summary engine"
```
