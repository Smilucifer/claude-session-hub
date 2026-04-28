# 会议室 v3 实施计划：协作增强 + 结果聚合 + 持久记忆

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决会议室三大短板——上下文注入粗糙、无结果聚合、无持久记忆

**Architecture:** 在现有 summary-engine + Gemini Flash 管道 + marker 协议基础上，新增三组能力：(1) 智能上下文注入替代 500 字符截断 + 可选分歧检测 (2) Blackboard 新增综合/对比标签页 (3) 新建 meeting-archive.js 实现自动存档 + 侧栏历史浏览 + 加载到新会议

**Tech Stack:** Electron (Node.js) + Gemini CLI pipe + marked + DOMPurify + uuid

**Spec:** `C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-04-24-meeting-room-v3-design.md`

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `C:\Users\lintian\claude-session-hub\core\summary-engine.js` | 新增 `compressContext()` / `detectDivergence()` / `aggregateReports()` / `extractTopics()` / `generateArchiveSummary()` | 修改 |
| `C:\Users\lintian\claude-session-hub\core\meeting-archive.js` | 存档管理：save/list/load/delete | 新建 |
| `C:\Users\lintian\claude-session-hub\core\meeting-room.js` | `createMeeting()` 新增 historyContext 参数，`updateMeeting` 允许新字段 | 修改 |
| `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` | `buildContextSummary()` 重写 + 分歧 UI + 历史注入 | 修改 |
| `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js` | 新增综合/对比标签页 + 综合按钮 | 修改 |
| `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css` | 分歧提示条 + 综合/对比样式 + 历史列表样式 | 修改 |
| `C:\Users\lintian\claude-session-hub\main.js` | 新增 9 个 IPC handler + before-quit 存档 | 修改 |
| `C:\Users\lintian\claude-session-hub\config\summary-templates.json` | 新增 compress/divergence/aggregation/topics/archive 模板 | 修改 |

---

## Task 1: summary-engine 新增 compressContext 方法

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\summary-engine.js:81-83`（quickSummary 之后）
- Modify: `C:\Users\lintian\claude-session-hub\main.js:387-389`（get-marker-instruction 之后）

- [ ] **Step 1: 在 SummaryEngine 中新增 compressContext 方法**

在 `C:\Users\lintian\claude-session-hub\core\summary-engine.js` 的 `quickSummary()` 方法之后（line 83）新增：

```javascript
  async compressContext(content, maxChars = 1000) {
    if (!content || content.length <= maxChars) return content;
    const system = '你是一个协作上下文压缩助手。将内容压缩到指定字符数以内，保留关键结论、数据点和具体建议，压缩论证过程和重复内容。';
    const prompt = `将以下 AI 回答压缩到 ${maxChars} 字符以内。\n要求：保留关键结论、数据点和具体建议，压缩论证过程和重复内容。\n\n原文：\n${content}`;
    try {
      const compressed = await this._callGeminiPipe(system, prompt);
      return compressed || content.slice(0, maxChars);
    } catch (err) {
      console.error('[summary-engine] compressContext failed:', err.message);
      return content.slice(0, maxChars);
    }
  }
```

- [ ] **Step 2: 在 main.js 注册 compress-context IPC handler**

在 `C:\Users\lintian\claude-session-hub\main.js` 的 `get-marker-instruction` handler 之后新增：

```javascript
ipcMain.handle('compress-context', async (_e, { content, maxChars }) => {
  return await summaryEngine.compressContext(content, maxChars || 1000);
});
```

- [ ] **Step 3: 手动验证**

启动 Hub 测试实例，在 DevTools Console 执行：

```javascript
// 短文本应直接返回原文
await window.require('electron').ipcRenderer.invoke('compress-context', { content: '短文本', maxChars: 1000 });

// 长文本应返回压缩后内容
await window.require('electron').ipcRenderer.invoke('compress-context', { content: 'A'.repeat(2000), maxChars: 1000 });
```

- [ ] **Step 4: Commit**

```bash
git add core/summary-engine.js main.js
git commit -m "feat(meeting-v3): add compressContext to summary-engine + IPC handler"
```

---

## Task 2: 重写 buildContextSummary — 智能上下文注入

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:580-597`（buildContextSummary 函数）

- [ ] **Step 1: 重写 buildContextSummary 函数**

将 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 中的 `buildContextSummary` 函数（lines 580-597）替换为：

```javascript
  const _contextCompressCache = new Map();

  async function buildContextSummary(meeting, excludeSessionId) {
    const others = meeting.subSessions.filter(id => id !== excludeSessionId);
    if (others.length === 0) return '';

    const lines = [];
    for (const id of others) {
      const session = sessions ? sessions.get(id) : null;
      const label = session ? (session.kind || 'session') : 'session';

      // 1. Try SM marker content first
      let content = await ipcRenderer.invoke('quick-summary', id);

      // 2. Fallback to ring buffer last 1000 chars
      if (!content) {
        const raw = await ipcRenderer.invoke('get-ring-buffer', id);
        if (raw) content = raw.length > 1000 ? raw.slice(-1000) : raw;
      }

      if (!content) continue;

      // 3. Threshold: ≤1000 use as-is, >1000 compress via Gemini Flash
      if (content.length > 1000) {
        const cacheKey = id + ':' + simpleHash(content);
        if (_contextCompressCache.has(cacheKey)) {
          content = _contextCompressCache.get(cacheKey);
        } else {
          const compressed = await ipcRenderer.invoke('compress-context', { content, maxChars: 1000 });
          _contextCompressCache.set(cacheKey, compressed);
          content = compressed;
        }
      }

      lines.push(`【${label}】${content}`);
    }

    if (lines.length === 0) return '';
    return `[会议室协作同步]\n${lines.join('\n')}\n---\n`;
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }
```

- [ ] **Step 2: 在 main.js 新增 get-ring-buffer IPC handler（如尚未存在）**

在 `C:\Users\lintian\claude-session-hub\main.js` 中检查是否已有 `get-ring-buffer` handler。如果没有，新增：

```javascript
ipcMain.handle('get-ring-buffer', (_e, sessionId) => {
  return sessionManager.getSessionBuffer(sessionId) || '';
});
```

- [ ] **Step 3: 在 handleMeetingSend 中发新消息时清除压缩缓存**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的 `handleMeetingSend` 函数末尾（line 577 `ipcRenderer.send('update-meeting'...)` 之后）新增：

```javascript
    _contextCompressCache.clear();
```

- [ ] **Step 4: 手动验证**

1. 创建会议室 + 2 个 AI 子会话
2. 开启自动同步
3. 向 Agent A 发问题，等待回答（SM 标记完成）
4. 向 Agent B 发问题 → 检查 Agent B 收到的上下文是否包含 Agent A 的 SM 内容
5. 短回答（<1000字符）→ 应该是原文
6. 长回答（>1000字符）→ 应该被压缩

- [ ] **Step 5: Commit**

```bash
git add renderer/meeting-room.js main.js
git commit -m "feat(meeting-v3): smart context injection with SM markers + compress threshold"
```

---

## Task 3: summary-engine 新增 detectDivergence 方法

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\summary-engine.js`（compressContext 之后）
- Modify: `C:\Users\lintian\claude-session-hub\main.js`（compress-context handler 之后）

- [ ] **Step 1: 在 SummaryEngine 中新增 detectDivergence 方法**

在 `C:\Users\lintian\claude-session-hub\core\summary-engine.js` 的 `compressContext()` 方法之后新增：

```javascript
  async detectDivergence(agentOutputs) {
    if (!agentOutputs || Object.keys(agentOutputs).length < 2) {
      return { consensus: [], divergence: [] };
    }
    const system = '你是一个多AI协作分析助手。分析多个AI的回答，识别共识和分歧。只输出JSON，不要其他内容。';
    let prompt = '分析以下多个 AI 对同一问题的回答，识别共识和分歧。\n\n';
    for (const [name, content] of Object.entries(agentOutputs)) {
      prompt += `【${name}】\n${content}\n\n`;
    }
    prompt += '请以 JSON 格式输出：\n{\n  "consensus": ["共识点1", "共识点2"],\n  "divergence": [\n    {\n      "topic": "分歧主题",\n      "positions": {"Agent1": "观点", "Agent2": "观点"},\n      "suggestedQuestion": "建议追问的问题"\n    }\n  ]\n}';

    try {
      const raw = await this._callGeminiPipe(system, prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { consensus: [], divergence: [] };
    } catch (err) {
      console.error('[summary-engine] detectDivergence failed:', err.message);
      return { consensus: [], divergence: [] };
    }
  }
```

- [ ] **Step 2: 在 main.js 注册 detect-divergence IPC handler**

在 `C:\Users\lintian\claude-session-hub\main.js` 的 `compress-context` handler 之后新增：

```javascript
ipcMain.handle('detect-divergence', async (_e, { meetingId }) => {
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return { consensus: [], divergence: [] };
  const agentOutputs = {};
  for (const sid of meeting.subSessions) {
    const raw = sessionManager.getSessionBuffer(sid);
    const content = summaryEngine.extractMarker(raw || '', sid);
    if (content) {
      const session = sessionManager.getSessionInfo(sid);
      const label = session ? (session.kind || 'AI') : 'AI';
      agentOutputs[label] = content;
    }
  }
  return await summaryEngine.detectDivergence(agentOutputs);
});
```

- [ ] **Step 3: 确认 sessionManager.getSessionInfo 存在**

检查 `C:\Users\lintian\claude-session-hub\core\session-manager.js` 是否有 `getSessionInfo(sessionId)` 方法。如果没有，使用已有的替代方式（如 `sessions.get(sid)`）。根据探索结果，session 对象存储在 `this.sessions` Map 中，存在 `getSessionBuffer` 但需确认是否有 `getSessionInfo`。如不存在则改用：

```javascript
const session = sessionManager.sessions ? sessionManager.sessions.get(sid) : null;
```

- [ ] **Step 4: 手动验证**

在 DevTools Console 执行：

```javascript
await window.require('electron').ipcRenderer.invoke('detect-divergence', { meetingId: '<active-meeting-id>' });
```

应返回 `{ consensus: [...], divergence: [...] }` 结构。

- [ ] **Step 5: Commit**

```bash
git add core/summary-engine.js main.js
git commit -m "feat(meeting-v3): add detectDivergence to summary-engine + IPC handler"
```

---

## Task 4: 分歧检测 UI — 开关 + 提示条 + 定向追问

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:458-487`（renderToolbar）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:296-311`（startMarkerPoll）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 1: 新增分歧状态变量**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的顶部变量区（line 13 的 `_tabTimers` 之后）新增：

```javascript
  let _divergenceEnabled = false;
  let _divergenceResult = null;
  let _divergenceHash = '';
```

- [ ] **Step 2: 在 renderToolbar 中新增分歧检测开关**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的 `renderToolbar()` 函数中，Focus 模式的 toolbar HTML（line 469-474）替换为：

```javascript
    el.innerHTML = `
      <button class="mr-header-btn" id="mr-sync-btn">⟳ 同步</button>
      <div class="mr-sync-toggle ${meeting.syncContext ? 'active' : ''}" id="mr-sync-toggle">
        <span>自动同步: ${meeting.syncContext ? '开' : '关'}</span>
      </div>
      <div class="mr-sync-toggle ${_divergenceEnabled ? 'active' : ''}" id="mr-divergence-toggle">
        <span>分歧检测: ${_divergenceEnabled ? '开' : '关'}</span>
      </div>
    `;
```

在同一函数中，`mr-sync-toggle` 的事件监听之后新增：

```javascript
    document.getElementById('mr-divergence-toggle').addEventListener('click', () => {
      _divergenceEnabled = !_divergenceEnabled;
      renderToolbar(meeting);
      if (_divergenceEnabled) checkDivergence(meeting);
    });
```

- [ ] **Step 3: 新增 checkDivergence 函数**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的 `buildContextSummary` 函数之后新增：

```javascript
  async function checkDivergence(meeting) {
    if (!_divergenceEnabled) return;
    // Check if at least 2 agents have marker done
    let doneCount = 0;
    for (const sid of meeting.subSessions) {
      if (_markerStatusCache[sid] === 'done') doneCount++;
    }
    if (doneCount < 2) {
      _divergenceResult = null;
      renderDivergenceBar(meeting);
      return;
    }

    // Build hash from SM contents to avoid repeat calls
    const hashes = [];
    for (const sid of meeting.subSessions) {
      const content = await ipcRenderer.invoke('quick-summary', sid);
      hashes.push(simpleHash(content || ''));
    }
    const hash = hashes.join('-');
    if (hash === _divergenceHash && _divergenceResult) {
      renderDivergenceBar(meeting);
      return;
    }

    _divergenceResult = await ipcRenderer.invoke('detect-divergence', { meetingId: meeting.id });
    _divergenceHash = hash;
    renderDivergenceBar(meeting);
  }

  function renderDivergenceBar(meeting) {
    let bar = document.getElementById('mr-divergence-bar');
    if (!_divergenceEnabled || !_divergenceResult) {
      if (bar) bar.remove();
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mr-divergence-bar';
      const container = terminalsEl();
      if (container) container.parentElement.insertBefore(bar, container);
    }

    const { consensus = [], divergence = [] } = _divergenceResult;
    let html = '';

    if (divergence.length > 0) {
      html += `<div class="mr-div-header mr-div-warn">⚠ ${divergence.length} 个分歧点</div>`;
      html += '<div class="mr-div-cards">';
      for (const d of divergence) {
        const positions = Object.entries(d.positions || {})
          .map(([k, v]) => `<span class="mr-div-pos"><b>${escapeHtml(k)}</b>: ${escapeHtml(v)}</span>`)
          .join('');
        html += `<div class="mr-div-card">
          <div class="mr-div-topic">${escapeHtml(d.topic)}</div>
          <div class="mr-div-positions">${positions}</div>
          <div class="mr-div-actions">
            <button class="mr-div-ask" data-q="${escapeHtml(d.suggestedQuestion || '')}" data-target="all">追问全部</button>
            ${meeting.subSessions.map(sid => {
              const s = sessions ? sessions.get(sid) : null;
              const label = s ? (s.kind || 'AI') : 'AI';
              return `<button class="mr-div-ask" data-q="${escapeHtml(d.suggestedQuestion || '')}" data-target="${sid}">问 ${escapeHtml(label)}</button>`;
            }).join('')}
          </div>
        </div>`;
      }
      html += '</div>';
    }

    if (consensus.length > 0) {
      html += `<div class="mr-div-header mr-div-ok">✓ ${consensus.length} 个共识点</div>`;
      html += '<div class="mr-div-consensus">' + consensus.map(c => `<span class="mr-div-consensus-item">${escapeHtml(c)}</span>`).join('') + '</div>';
    }

    bar.innerHTML = html;

    // Bind ask buttons
    bar.querySelectorAll('.mr-div-ask').forEach(btn => {
      btn.addEventListener('click', () => {
        const question = btn.dataset.q;
        const target = btn.dataset.target;
        const inputBox = document.getElementById('mr-input-box');
        if (inputBox && question) inputBox.textContent = question;
        if (target !== 'all') {
          meeting.sendTarget = target;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: target } });
        } else {
          meeting.sendTarget = 'all';
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: 'all' } });
        }
        const sel = document.getElementById('mr-input-target');
        if (sel) sel.value = target === 'all' ? 'all' : target;
        if (inputBox) inputBox.focus();
      });
    });
  }
```

- [ ] **Step 4: 在 marker 轮询中触发分歧检测**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的 `startMarkerPoll()` 函数中（line 310 `if (changed) updateMarkerBadges(meeting);` 之后）新增：

```javascript
      if (changed && _divergenceEnabled) checkDivergence(meeting);
```

- [ ] **Step 5: 发送新消息时清除分歧缓存**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的 `handleMeetingSend` 函数中已有的 `_contextCompressCache.clear()` 之后新增：

```javascript
    _divergenceResult = null;
    _divergenceHash = '';
    const bar = document.getElementById('mr-divergence-bar');
    if (bar) bar.remove();
```

- [ ] **Step 6: 新增分歧提示条 CSS**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css` 末尾新增：

```css
/* Divergence bar */
#mr-divergence-bar { padding: 8px 12px; border-bottom: 1px solid var(--border); max-height: 200px; overflow-y: auto; }
.mr-div-header { font-size: 12px; font-weight: 600; padding: 4px 0; }
.mr-div-warn { color: #eab308; }
.mr-div-ok { color: #22c55e; }
.mr-div-cards { display: flex; flex-direction: column; gap: 6px; }
.mr-div-card { background: rgba(234,179,8,0.08); border: 1px solid rgba(234,179,8,0.2); border-radius: 6px; padding: 8px; }
.mr-div-topic { font-weight: 600; font-size: 12px; margin-bottom: 4px; }
.mr-div-positions { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--text-secondary); }
.mr-div-pos b { color: var(--text-primary); }
.mr-div-actions { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.mr-div-ask { font-size: 10px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; }
.mr-div-ask:hover { background: var(--accent); color: #fff; }
.mr-div-consensus { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0; }
.mr-div-consensus-item { font-size: 11px; padding: 2px 8px; background: rgba(34,197,94,0.1); border-radius: 10px; color: var(--text-secondary); }
```

- [ ] **Step 7: 手动验证**

1. 创建会议室 + 2 AI
2. 向全部发送同一个问题，等待 SM 标记完成
3. 开启"分歧检测"开关 → 验证分歧提示条出现
4. 点击"追问全部" → 验证输入框填充 + sendTarget 切换
5. 发新消息 → 验证分歧提示条消失

- [ ] **Step 8: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(meeting-v3): divergence detection UI with toggle, bar, and quick-ask buttons"
```

---

## Task 5: summary-engine 新增 aggregateReports 和 extractTopics

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\summary-engine.js`（detectDivergence 之后）
- Modify: `C:\Users\lintian\claude-session-hub\main.js`（detect-divergence handler 之后）

- [ ] **Step 1: 在 SummaryEngine 中新增 aggregateReports 方法**

```javascript
  async aggregateReports(agentOutputs, divergenceCache = null) {
    if (!agentOutputs || Object.keys(agentOutputs).length < 2) return '';
    const system = '你是一个多AI协作会议的综合者。生成结构化的综合报告，使用 Markdown 格式。';
    let prompt = '以下是不同AI对同一问题的回答。请生成结构化的综合报告。\n\n';
    for (const [name, content] of Object.entries(agentOutputs)) {
      prompt += `【${name}】\n${content}\n\n`;
    }
    if (divergenceCache) {
      prompt += `\n已有分歧分析结果（请复用，不要重复分析）：\n${JSON.stringify(divergenceCache)}\n\n`;
    }
    prompt += '请按以下结构输出（Markdown 格式）：\n\n## 共识\n- 三方一致认为的要点\n\n## 分歧\n- 存在分歧的议题，列出各方立场和分歧原因\n\n## 各方独有洞察\n- 某方提到但其他方未涉及的有价值观点\n\n## 建议结论\n- 综合各方意见后的推荐结论';

    try {
      return await this._callGeminiPipe(system, prompt);
    } catch (err) {
      console.error('[summary-engine] aggregateReports failed:', err.message);
      return '';
    }
  }
```

- [ ] **Step 2: 在 SummaryEngine 中新增 extractTopics 方法**

```javascript
  async extractTopics(agentOutputs) {
    if (!agentOutputs || Object.keys(agentOutputs).length < 2) return { topics: [] };
    const system = '你是一个多AI回答对比分析助手。提取关键议题和各方立场。只输出JSON，不要其他内容。';
    let prompt = '分析以下多个 AI 的回答，提取所有讨论到的关键议题，并列出每个 AI 在每个议题上的立场/观点。\n\n';
    for (const [name, content] of Object.entries(agentOutputs)) {
      prompt += `【${name}】\n${content}\n\n`;
    }
    prompt += '请以 JSON 格式输出：\n{\n  "topics": [\n    {\n      "name": "议题名称",\n      "positions": {"Agent1": "观点摘要", "Agent2": "观点摘要"},\n      "agreement": true\n    }\n  ]\n}';

    try {
      const raw = await this._callGeminiPipe(system, prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { topics: [] };
    } catch (err) {
      console.error('[summary-engine] extractTopics failed:', err.message);
      return { topics: [] };
    }
  }
```

- [ ] **Step 3: 辅助函数 — 从会议中收集 agentOutputs**

在 `C:\Users\lintian\claude-session-hub\main.js` 中新增辅助函数（IPC handlers 区域上方）：

```javascript
function collectAgentOutputs(meetingId) {
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return null;
  const outputs = {};
  for (const sid of meeting.subSessions) {
    const raw = sessionManager.getSessionBuffer(sid);
    const content = summaryEngine.extractMarker(raw || '', sid);
    if (content) {
      const session = sessionManager.sessions.get(sid);
      const label = session ? (session.kind || 'AI') : 'AI';
      outputs[label] = content;
    }
  }
  return Object.keys(outputs).length >= 2 ? outputs : null;
}
```

- [ ] **Step 4: 注册 aggregate-reports 和 extract-topics IPC handlers**

```javascript
ipcMain.handle('aggregate-reports', async (_e, { meetingId, divergenceCache }) => {
  const outputs = collectAgentOutputs(meetingId);
  if (!outputs) return '';
  return await summaryEngine.aggregateReports(outputs, divergenceCache || null);
});

ipcMain.handle('extract-topics', async (_e, { meetingId }) => {
  const outputs = collectAgentOutputs(meetingId);
  if (!outputs) return { topics: [] };
  return await summaryEngine.extractTopics(outputs);
});
```

- [ ] **Step 5: 重构 detect-divergence handler 使用 collectAgentOutputs**

将 Task 3 中注册的 `detect-divergence` handler 简化为：

```javascript
ipcMain.handle('detect-divergence', async (_e, { meetingId }) => {
  const outputs = collectAgentOutputs(meetingId);
  if (!outputs) return { consensus: [], divergence: [] };
  return await summaryEngine.detectDivergence(outputs);
});
```

- [ ] **Step 6: Commit**

```bash
git add core/summary-engine.js main.js
git commit -m "feat(meeting-v3): add aggregateReports + extractTopics + collectAgentOutputs helper"
```

---

## Task 6: Blackboard 新增综合标签页 + 对比标签页

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js:27-106`（renderBlackboard）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js:108-153`（renderBlackboardToolbar）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 1: 新增缓存变量**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js` 顶部变量区（line 11 `_bbFocusedTab` 之后）新增：

```javascript
  let _aggregationCache = null;
  let _comparisonCache = null;
  let _aggregationTime = null;
```

- [ ] **Step 2: 重写 renderBlackboard — 新增综合和对比 tab**

将 `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js` 的 `renderBlackboard` 函数中的 tab 栏生成逻辑（lines 39-53）替换为：

```javascript
    // Agent tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'mr-bb-tabs';
    for (const sid of subs) {
      const label = getLabel(sid);
      const btn = document.createElement('button');
      btn.className = 'mr-bb-tab' + (sid === focused && !['aggregation', 'comparison'].includes(focused) ? ' active' : '');
      btn.dataset.sid = sid;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        _bbFocusedTab = sid;
        renderBlackboard(meeting, container);
      });
      tabBar.appendChild(btn);
    }
    // Aggregation tab
    const aggBtn = document.createElement('button');
    aggBtn.className = 'mr-bb-tab mr-bb-tab-special' + (focused === 'aggregation' ? ' active' : '');
    aggBtn.textContent = '📋 综合';
    aggBtn.addEventListener('click', () => {
      _bbFocusedTab = 'aggregation';
      renderBlackboard(meeting, container);
    });
    tabBar.appendChild(aggBtn);
    // Comparison tab
    const cmpBtn = document.createElement('button');
    cmpBtn.className = 'mr-bb-tab mr-bb-tab-special' + (focused === 'comparison' ? ' active' : '');
    cmpBtn.textContent = '⚖ 对比';
    cmpBtn.addEventListener('click', () => {
      _bbFocusedTab = 'comparison';
      renderBlackboard(meeting, container);
    });
    tabBar.appendChild(cmpBtn);
    container.appendChild(tabBar);
```

- [ ] **Step 3: 在 renderBlackboard 中处理 aggregation/comparison tab 内容**

在 content area 创建之后（`container.appendChild(contentEl)` 之后），将现有的 summary fetch + render 逻辑包在一个条件分支中：

```javascript
    if (focused === 'aggregation') {
      await renderAggregationTab(meeting, contentEl);
      return;
    }
    if (focused === 'comparison') {
      await renderComparisonTab(meeting, contentEl);
      return;
    }

    // ... existing summary fetch + render for agent tabs ...
```

- [ ] **Step 4: 新增 renderAggregationTab 函数**

```javascript
  async function renderAggregationTab(meeting, contentEl) {
    const { marked } = require('marked');
    const DOMPurify = require('dompurify');

    if (_aggregationCache) {
      const rendered = DOMPurify.sanitize(marked.parse(_aggregationCache));
      contentEl.innerHTML =
        `<div class="mr-bb-info"><span class="mr-bb-time">生成于 ${_aggregationTime || ''}</span> <button class="mr-header-btn mr-bb-regen" id="mr-agg-regen">重新生成</button></div>` +
        `<div class="mr-bb-markdown">${rendered}</div>`;
      document.getElementById('mr-agg-regen').addEventListener('click', async () => {
        _aggregationCache = null;
        renderBlackboard(meeting, contentEl.parentElement);
      });
      return;
    }

    contentEl.innerHTML = '<div class="mr-bb-summary" style="color:var(--text-secondary);font-style:italic">尚未生成综合报告。请在工具栏点击【综合】按钮。</div>';
  }
```

- [ ] **Step 5: 新增 renderComparisonTab 函数**

```javascript
  async function renderComparisonTab(meeting, contentEl) {
    if (_comparisonCache && _comparisonCache.topics) {
      renderTopicsMatrix(contentEl, _comparisonCache.topics);
      return;
    }

    contentEl.innerHTML = '<div class="mr-bb-summary" style="color:var(--text-secondary);font-style:italic">加载对比数据中…</div>';

    try {
      _comparisonCache = await ipcRenderer.invoke('extract-topics', { meetingId: meeting.id });
      if (_comparisonCache && _comparisonCache.topics && _comparisonCache.topics.length > 0) {
        renderTopicsMatrix(contentEl, _comparisonCache.topics);
      } else {
        contentEl.innerHTML = '<div class="mr-bb-summary" style="color:var(--text-secondary)">无法提取议题。请确认至少 2 个 AI 已完成回答。</div>';
      }
    } catch {
      contentEl.innerHTML = '<div class="mr-bb-summary" style="color:var(--text-secondary)">对比分析失败。</div>';
    }
  }

  function renderTopicsMatrix(contentEl, topics) {
    let html = '<div class="mr-bb-topics">';
    for (const topic of topics) {
      const agreeCls = topic.agreement ? 'mr-topic-agree' : 'mr-topic-diverge';
      const icon = topic.agreement ? '✓' : '⚠';
      html += `<details class="mr-topic ${agreeCls}">
        <summary><span class="mr-topic-icon">${icon}</span> ${escapeHtml(topic.name)}</summary>
        <div class="mr-topic-positions">`;
      for (const [agent, position] of Object.entries(topic.positions || {})) {
        if (position) {
          html += `<div class="mr-topic-pos"><b>${escapeHtml(agent)}</b>: ${escapeHtml(position)}</div>`;
        }
      }
      html += '</div></details>';
    }
    html += '</div>';
    contentEl.innerHTML = html;
  }
```

- [ ] **Step 6: 在 renderBlackboardToolbar 中新增综合按钮**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js` 的 `renderBlackboardToolbar` 函数中，现有 `toolbarEl.innerHTML = ...` 的模板字符串中新增综合按钮：

在 scene select 之后追加：

```javascript
      <button class="mr-header-btn" id="mr-agg-btn" title="生成综合报告">📋 综合</button>
```

在事件绑定区域新增：

```javascript
    document.getElementById('mr-agg-btn').addEventListener('click', async () => {
      const btn = document.getElementById('mr-agg-btn');
      btn.disabled = true;
      btn.textContent = '⏳ 生成中…';
      try {
        const meetingId = meeting.id;
        const divergenceCache = window.MeetingRoom && window.MeetingRoom._divergenceResult ? window.MeetingRoom._divergenceResult : null;
        _aggregationCache = await ipcRenderer.invoke('aggregate-reports', { meetingId, divergenceCache });
        _aggregationTime = new Date().toLocaleTimeString();
        _bbFocusedTab = 'aggregation';
        const container = document.querySelector('.mr-blackboard');
        if (container) renderBlackboard(meeting, container);
      } catch (err) {
        console.error('[blackboard] aggregation failed:', err);
      } finally {
        btn.disabled = false;
        btn.textContent = '📋 综合';
      }
    });
```

- [ ] **Step 7: 在 clearCache 中清除新增缓存**

将 `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js` 的 `clearCache` 函数更新为：

```javascript
  function clearCache() {
    _summaryCache = {};
    _expandedRaw = {};
    _aggregationCache = null;
    _comparisonCache = null;
    _aggregationTime = null;
  }
```

- [ ] **Step 8: 新增综合/对比标签页 CSS**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css` 末尾新增：

```css
/* Blackboard special tabs */
.mr-bb-tab-special { font-style: italic; }
.mr-bb-regen { font-size: 10px; padding: 2px 8px; margin-left: 8px; }
/* Topics matrix */
.mr-bb-topics { padding: 8px; }
.mr-topic { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
.mr-topic summary { padding: 8px 12px; cursor: pointer; font-size: 13px; font-weight: 500; }
.mr-topic-agree summary { background: rgba(34,197,94,0.06); }
.mr-topic-diverge summary { background: rgba(234,179,8,0.06); }
.mr-topic-icon { margin-right: 6px; }
.mr-topic-positions { padding: 8px 12px; border-top: 1px solid var(--border); }
.mr-topic-pos { font-size: 12px; padding: 4px 0; color: var(--text-secondary); }
.mr-topic-pos b { color: var(--text-primary); }
```

- [ ] **Step 9: 暴露 _divergenceResult 供 blackboard 访问**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的 `window.MeetingRoom` 导出对象中新增：

```javascript
    get _divergenceResult() { return _divergenceResult; },
```

- [ ] **Step 10: 手动验证**

1. 创建会议室 + 2 AI → 发问题 → 等待完成
2. 切到 Blackboard → 验证 tab 栏有"📋 综合"和"⚖ 对比"
3. 点击"综合"按钮 → 验证综合标签页渲染 Markdown 报告
4. 切到"对比"标签页 → 验证议题矩阵显示

- [ ] **Step 11: Commit**

```bash
git add renderer/meeting-blackboard.js renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(meeting-v3): aggregation and comparison tabs in Blackboard mode"
```

---

## Task 7: 新建 meeting-archive.js — 存档管理模块

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\meeting-archive.js`

- [ ] **Step 1: 创建 MeetingArchiveManager**

```javascript
// core/meeting-archive.js
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { getHubDataDir } = require('./data-dir');

class MeetingArchiveManager {
  constructor(summaryEngine) {
    this._summaryEngine = summaryEngine;
    this._filePath = null;
  }

  _getFilePath() {
    if (!this._filePath) {
      this._filePath = path.join(getHubDataDir(), 'meeting-archives.json');
    }
    return this._filePath;
  }

  _readAll() {
    const fp = this._getFilePath();
    try {
      if (!fs.existsSync(fp)) return { version: 1, archives: [] };
      const raw = fs.readFileSync(fp, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { version: 1, archives: [] };
    }
  }

  _writeAll(data) {
    const fp = this._getFilePath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
  }

  async save(meetingData, sessionManager, aggregation, divergence) {
    const agentOutputs = {};
    const agents = [];
    for (const sid of meetingData.subSessions || []) {
      const raw = sessionManager.getSessionBuffer(sid);
      const content = this._summaryEngine.extractMarker(raw || '', sid);
      const session = sessionManager.sessions.get(sid);
      const kind = session ? (session.kind || 'AI') : 'AI';
      const model = session && session.currentModel ? session.currentModel.id : null;
      agents.push({ sessionId: sid, kind, model });
      if (content) agentOutputs[kind] = content;
    }

    if (Object.keys(agentOutputs).length === 0) return null;

    let summary = '';
    try {
      const summaryPromise = this._generateSummary(agentOutputs);
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(''), 5000));
      summary = await Promise.race([summaryPromise, timeoutPromise]);
    } catch {
      summary = '';
    }

    const archive = {
      id: uuid(),
      meetingId: meetingData.id,
      title: meetingData.title || '会议室',
      agents,
      scene: meetingData.lastScene || 'free_discussion',
      createdAt: meetingData.createdAt ? new Date(meetingData.createdAt).toISOString() : new Date().toISOString(),
      closedAt: new Date().toISOString(),
      summary,
      agentOutputs,
      aggregation: aggregation || null,
      divergence: divergence || null,
    };

    const data = this._readAll();
    data.archives.push(archive);
    this._writeAll(data);
    return archive.id;
  }

  async _generateSummary(agentOutputs) {
    const system = '概括多AI协作会议的核心内容，500字符以内。包含：关键结论、未解决问题、有参考价值的信息。';
    let prompt = '';
    for (const [name, content] of Object.entries(agentOutputs)) {
      prompt += `【${name}】\n${content}\n\n`;
    }
    return await this._summaryEngine._callGeminiPipe(system, prompt);
  }

  list() {
    const data = this._readAll();
    return data.archives.map(a => ({
      id: a.id,
      title: a.title,
      agents: a.agents,
      scene: a.scene,
      createdAt: a.createdAt,
      closedAt: a.closedAt,
      summary: a.summary,
    })).reverse();
  }

  load(archiveId) {
    const data = this._readAll();
    return data.archives.find(a => a.id === archiveId) || null;
  }

  delete(archiveId) {
    const data = this._readAll();
    data.archives = data.archives.filter(a => a.id !== archiveId);
    this._writeAll(data);
  }
}

module.exports = { MeetingArchiveManager };
```

- [ ] **Step 2: Commit**

```bash
git add core/meeting-archive.js
git commit -m "feat(meeting-v3): create MeetingArchiveManager for persistent meeting archives"
```

---

## Task 8: 自动存档集成 — IPC + before-quit + close-meeting

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 1: 在 main.js 中初始化 MeetingArchiveManager**

在 `C:\Users\lintian\claude-session-hub\main.js` 的 `summaryEngine` 实例化之后新增：

```javascript
const { MeetingArchiveManager } = require('./core/meeting-archive');
const archiveManager = new MeetingArchiveManager(summaryEngine);
```

- [ ] **Step 2: 注册存档 IPC handlers**

```javascript
ipcMain.handle('save-meeting-archive', async (_e, { meetingId }) => {
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return null;
  const archiveId = await archiveManager.save(meeting, sessionManager, null, null);
  return { archiveId };
});

ipcMain.handle('list-meeting-archives', () => {
  return archiveManager.list();
});

ipcMain.handle('load-meeting-archive', (_e, { archiveId }) => {
  return archiveManager.load(archiveId);
});

ipcMain.handle('delete-meeting-archive', (_e, { archiveId }) => {
  archiveManager.delete(archiveId);
  return true;
});
```

- [ ] **Step 3: 修改 close-meeting handler 加入自动存档**

将 `C:\Users\lintian\claude-session-hub\main.js` 的 `close-meeting` IPC handler（lines 363-371）替换为：

```javascript
ipcMain.handle('close-meeting', async (_e, meetingId) => {
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return false;
  // Auto-archive before closing
  try {
    await archiveManager.save(meeting, sessionManager, null, null);
  } catch (err) {
    console.error('[main] auto-archive failed:', err.message);
  }
  const subIds = meetingManager.closeMeeting(meetingId);
  if (!subIds) return false;
  for (const sid of subIds) {
    sessionManager.closeSession(sid);
  }
  sendToRenderer('meeting-closed', { meetingId });
  return true;
});
```

- [ ] **Step 4: 修改 before-quit 加入自动存档**

将 `C:\Users\lintian\claude-session-hub\main.js` 的 `before-quit` handler（lines 1112-1117）替换为：

```javascript
app.on('before-quit', async () => {
  // Auto-archive all active meetings with SM content
  for (const meeting of meetingManager.getAllMeetings()) {
    if (meeting.status !== 'dormant') {
      try {
        await archiveManager.save(meeting, sessionManager, null, null);
      } catch (err) {
        console.error('[main] before-quit archive failed for', meeting.id, err.message);
      }
    }
  }
  stateStore.save({ version: 1, cleanShutdown: true, sessions: lastPersistedSessions, meetings: meetingManager.getAllMeetings() }, { sync: true });
  try { teamBridge.cleanup(); } catch(e) {}
  if (teamSessionManager) { try { teamSessionManager.closeAll(); } catch(e) {} }
  if (mobileSrv) { try { await mobileSrv.close(); } catch {} }
});
```

- [ ] **Step 5: 手动验证**

1. 创建会议室 + 2 AI → 发问题 → 等待 SM 完成
2. 关闭会议室 → 检查 `~/.claude-session-hub/meeting-archives.json` 是否生成
3. 验证存档内容包含 agentOutputs、summary

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(meeting-v3): auto-archive on meeting close and app quit + IPC handlers"
```

---

## Task 9: 侧栏历史浏览 + 加载到新会议

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`（window.MeetingRoom 导出区域）
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-room.js:9-27`（createMeeting）
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 1: 修改 createMeeting 支持 historyContext**

在 `C:\Users\lintian\claude-session-hub\core\meeting-room.js` 的 `createMeeting()` 方法签名改为 `createMeeting(options = {})`，meeting 对象新增字段：

```javascript
  createMeeting(options = {}) {
    const id = uuid();
    const meeting = {
      id,
      type: 'meeting',
      title: options.title || `会议室-${++this._counter}`,
      subSessions: [],
      layout: 'focus',
      focusedSub: null,
      syncContext: false,
      sendTarget: 'all',
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      pinned: false,
      status: 'idle',
      lastScene: 'free_discussion',
      historyContext: options.historyContext || null,
      historyInjected: false,
    };
    this.meetings.set(id, meeting);
    return { ...meeting };
  }
```

在 `updateMeeting` 的 allowed 数组中添加 `'historyContext'` 和 `'historyInjected'`。

- [ ] **Step 2: 注册 create-meeting-from-archive IPC handler**

在 `C:\Users\lintian\claude-session-hub\main.js` 中新增：

```javascript
ipcMain.handle('create-meeting-from-archive', (_e, { archiveId }) => {
  const archive = archiveManager.load(archiveId);
  if (!archive) return null;
  const historyContext = `[历史会议参考]（${archive.closedAt ? new Date(archive.closedAt).toLocaleDateString() : ''}的讨论）\n${archive.summary || '（无摘要）'}\n---\n`;
  const meeting = meetingManager.createMeeting({
    title: `续: ${archive.title}`,
    historyContext,
  });
  sendToRenderer('meeting-created', { meeting });
  return { meetingId: meeting.id };
});
```

- [ ] **Step 3: 在 handleMeetingSend 中注入历史上下文**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 的 `handleMeetingSend` 函数中，`let payload = text + markerInstruction;` 之后新增：

```javascript
      // Inject history context on first send
      if (meeting.historyContext && !meeting.historyInjected) {
        payload = meeting.historyContext + payload;
        meeting.historyInjected = true;
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { historyInjected: true } });
      }
```

- [ ] **Step 4: 新增侧栏历史区域渲染函数**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js` 中新增（在 `window.MeetingRoom` 定义之前）：

```javascript
  async function renderArchiveList(containerEl) {
    if (!containerEl) return;
    const archives = await ipcRenderer.invoke('list-meeting-archives');
    if (!archives || archives.length === 0) {
      containerEl.innerHTML = '<div class="mr-archive-empty">暂无历史会议</div>';
      return;
    }

    let html = '';
    for (const a of archives) {
      const agents = (a.agents || []).map(ag => ag.kind).join(', ');
      const time = a.closedAt ? new Date(a.closedAt).toLocaleString() : '';
      const summary = a.summary ? (a.summary.length > 60 ? a.summary.slice(0, 60) + '…' : a.summary) : '';
      html += `<div class="mr-archive-item" data-archive-id="${a.id}">
        <div class="mr-archive-title">${escapeHtml(a.title)}</div>
        <div class="mr-archive-meta">${time} · ${escapeHtml(agents)}</div>
        <div class="mr-archive-summary">${escapeHtml(summary)}</div>
        <div class="mr-archive-actions">
          <button class="mr-archive-btn mr-archive-view" data-id="${a.id}">查看</button>
          <button class="mr-archive-btn mr-archive-continue" data-id="${a.id}">继续讨论</button>
          <button class="mr-archive-btn mr-archive-delete" data-id="${a.id}">删除</button>
        </div>
      </div>`;
    }
    containerEl.innerHTML = html;

    containerEl.querySelectorAll('.mr-archive-view').forEach(btn => {
      btn.addEventListener('click', async () => {
        const archive = await ipcRenderer.invoke('load-meeting-archive', { archiveId: btn.dataset.id });
        if (archive) showArchiveReadonly(archive);
      });
    });

    containerEl.querySelectorAll('.mr-archive-continue').forEach(btn => {
      btn.addEventListener('click', async () => {
        const result = await ipcRenderer.invoke('create-meeting-from-archive', { archiveId: btn.dataset.id });
        if (result && result.meetingId) {
          const meeting = await ipcRenderer.invoke('get-meeting', result.meetingId);
          if (meeting) openMeeting(result.meetingId, meeting);
        }
      });
    });

    containerEl.querySelectorAll('.mr-archive-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        await ipcRenderer.invoke('delete-meeting-archive', { archiveId: btn.dataset.id });
        renderArchiveList(containerEl);
      });
    });
  }

  function showArchiveReadonly(archive) {
    const panel = panelEl();
    if (!panel) return;
    panel.style.display = 'flex';
    const container = terminalsEl();
    if (!container) return;
    container.className = 'mr-terminals mr-blackboard';
    container.innerHTML = '';

    const { marked } = require('marked');
    const DOMPurify = require('dompurify');

    // Tab bar: agent tabs + aggregation
    const tabBar = document.createElement('div');
    tabBar.className = 'mr-bb-tabs';
    const agentNames = Object.keys(archive.agentOutputs || {});
    let focusedTab = agentNames[0] || 'aggregation';

    function renderArchiveContent(tab) {
      const contentEl = container.querySelector('.mr-bb-content') || document.createElement('div');
      contentEl.className = 'mr-bb-content';
      if (!contentEl.parentElement) container.appendChild(contentEl);

      if (tab === 'aggregation' && archive.aggregation) {
        contentEl.innerHTML = `<div class="mr-bb-info"><span class="mr-bb-time">存档于 ${archive.closedAt || ''}</span></div><div class="mr-bb-markdown">${DOMPurify.sanitize(marked.parse(archive.aggregation))}</div>`;
      } else if (archive.agentOutputs && archive.agentOutputs[tab]) {
        contentEl.innerHTML = `<div class="mr-bb-info"><span class="mr-bb-time">存档于 ${archive.closedAt || ''}</span></div><div class="mr-bb-markdown">${DOMPurify.sanitize(marked.parse(archive.agentOutputs[tab]))}</div>`;
      } else {
        contentEl.innerHTML = '<div class="mr-bb-summary" style="color:var(--text-secondary)">无内容</div>';
      }

      tabBar.querySelectorAll('.mr-bb-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    }

    for (const name of agentNames) {
      const btn = document.createElement('button');
      btn.className = 'mr-bb-tab' + (name === focusedTab ? ' active' : '');
      btn.dataset.tab = name;
      btn.textContent = name;
      btn.addEventListener('click', () => renderArchiveContent(name));
      tabBar.appendChild(btn);
    }
    if (archive.aggregation) {
      const aggBtn = document.createElement('button');
      aggBtn.className = 'mr-bb-tab mr-bb-tab-special';
      aggBtn.dataset.tab = 'aggregation';
      aggBtn.textContent = '📋 综合';
      aggBtn.addEventListener('click', () => renderArchiveContent('aggregation'));
      tabBar.appendChild(aggBtn);
    }
    container.appendChild(tabBar);

    renderArchiveContent(focusedTab);

    // Header: readonly indicator + close
    const el = headerEl();
    if (el) {
      el.innerHTML = `
        <div class="mr-header-left"><span class="mr-header-title">📁 ${escapeHtml(archive.title)}（只读存档）</span></div>
        <div class="mr-header-right"><button class="btn-close-session" id="mr-btn-close-archive">✕</button></div>
      `;
      document.getElementById('mr-btn-close-archive').addEventListener('click', () => closeMeetingPanel());
    }
  }
```

- [ ] **Step 5: 导出 renderArchiveList**

在 `window.MeetingRoom` 对象中新增：

```javascript
    renderArchiveList,
```

- [ ] **Step 6: 新增 get-meeting IPC handler（如尚未存在）**

在 `C:\Users\lintian\claude-session-hub\main.js` 中确认是否有 `get-meeting` handler，如果没有新增：

```javascript
ipcMain.handle('get-meeting', (_e, meetingId) => {
  return meetingManager.getMeeting(meetingId);
});
```

- [ ] **Step 7: 新增历史列表 CSS**

在 `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css` 末尾新增：

```css
/* Archive list */
.mr-archive-empty { padding: 12px; color: var(--text-secondary); font-size: 12px; text-align: center; }
.mr-archive-item { padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: default; }
.mr-archive-item:hover { background: var(--bg-secondary); }
.mr-archive-title { font-size: 13px; font-weight: 500; }
.mr-archive-meta { font-size: 10px; color: var(--text-secondary); margin-top: 2px; }
.mr-archive-summary { font-size: 11px; color: var(--text-secondary); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mr-archive-actions { display: flex; gap: 4px; margin-top: 6px; }
.mr-archive-btn { font-size: 10px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; }
.mr-archive-btn:hover { background: var(--accent); color: #fff; }
.mr-archive-delete:hover { background: #ef4444; }
```

- [ ] **Step 8: 手动验证**

1. 创建会议室 + 2 AI → 发问题 → 等 SM 完成 → 关闭会议室
2. 检查 `~/.claude-session-hub/meeting-archives.json` 已写入
3. 调用 `MeetingRoom.renderArchiveList(someContainer)` 验证列表渲染
4. 点击"查看" → 验证只读 Blackboard 展示
5. 点击"继续讨论" → 验证新会议创建 + 第一次发消息包含历史注入 + 第二次不再注入
6. 点击"删除" → 验证存档移除

- [ ] **Step 9: Commit**

```bash
git add core/meeting-room.js core/meeting-archive.js renderer/meeting-room.js renderer/meeting-room.css main.js
git commit -m "feat(meeting-v3): archive browsing in sidebar + continue discussion from archive"
```

---

## Task 10: 集成侧栏入口 + 最终验证

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\renderer.js`（或侧栏渲染的入口文件）

- [ ] **Step 1: 在侧栏会议室区域下方添加"历史会议"折叠区域**

找到侧栏中渲染会议室列表的位置（可能在 `renderer.js` 中），在会议室列表下方新增：

```javascript
// After meeting list rendering
const archiveSection = document.createElement('details');
archiveSection.className = 'sidebar-section mr-archive-section';
archiveSection.innerHTML = '<summary class="sidebar-section-header">📁 历史会议</summary><div id="mr-archive-container"></div>';
// Insert after meeting list
meetingListParent.appendChild(archiveSection);

archiveSection.addEventListener('toggle', () => {
  if (archiveSection.open) {
    MeetingRoom.renderArchiveList(document.getElementById('mr-archive-container'));
  }
});
```

注意：这一步需要根据实际的侧栏 DOM 结构调整插入位置。实施时先 grep `会议室` 或 `create-meeting` 在 renderer.js 中找到会议室列表渲染代码。

- [ ] **Step 2: 全流程 E2E 验证**

完整流程测试：

1. 启动 Hub 测试实例（`CLAUDE_HUB_DATA_DIR` 隔离）
2. 创建会议室 → 添加 Claude + Gemini
3. 发问题（全部）→ 等 SM 完成
4. **Part 1 验证**: 开启自动同步 → 再发问题 → 检查注入格式为 `[会议室协作同步]\n【claude】...`
5. **Part 1 验证**: 开启分歧检测 → 验证提示条出现 → 点击追问
6. **Part 2 验证**: 切 Blackboard → 点击"综合"→ 验证综合标签页 → 切"对比"标签页
7. **Part 3 验证**: 关闭会议室 → 侧栏展开"历史会议"→ 验证存档条目
8. **Part 3 验证**: 点击"查看"→ 只读模式 → 关闭 → 点击"继续讨论"→ 发消息 → 验证历史注入
9. 验证 `CLAUDE_HUB_DATA_DIR` 隔离：存档文件应在隔离目录下

- [ ] **Step 3: Commit**

```bash
git add renderer/renderer.js renderer/meeting-room.css
git commit -m "feat(meeting-v3): sidebar archive section + final integration"
```
