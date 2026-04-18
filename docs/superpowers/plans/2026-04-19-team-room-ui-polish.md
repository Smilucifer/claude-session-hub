# Team Room UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 UI issues discovered during real E2E testing — tool_use visual distinction, Round separators, evolution summary, old message folding.

**Architecture:** Pure frontend changes. Two files: `renderer/team-room.js` (event handlers + DOM construction) and `renderer/team-room.css` (styles). No backend changes.

**Tech Stack:** Vanilla JS (Electron renderer), CSS, DOM API.

---

### Task 1: tool_use 独立样式 — CSS

**Files:**
- Modify: `renderer/team-room.css` (append after line 623)

- [ ] **Step 1: Add `.tr-tool-use` CSS classes**

Append these styles after the checkpoint section (after line 623 in team-room.css):

```css
/* --- Tool Use — code-style card for MCP tool invocations --- */
.tr-tool-use {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
  max-width: 720px;
  margin: 2px 0;
}

.tr-tool-use-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #3a3f4a;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
  margin-top: 2px;
}

.tr-tool-use-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.tr-tool-use-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  color: #8a93a6;
}

.tr-tool-use-name {
  font-weight: 600;
  color: #a7b0c2;
}

.tr-tool-use-tag {
  font-size: 10px;
  letter-spacing: 0.5px;
  color: #7c7;
  background: #1a2a1a;
  padding: 0 6px;
  border-radius: 8px;
}

.tr-tool-use-time {
  font-size: 10px;
  color: #6f7a8f;
  margin-left: auto;
}

.tr-tool-use-code {
  background: #1e2630;
  border-left: 2px solid #4a7a9a;
  border-radius: 4px;
  padding: 4px 10px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  color: #8ab;
  word-break: break-all;
  line-height: 1.4;
}
```

- [ ] **Step 2: Add evolution summary CSS**

Append after the tool-use styles:

```css
/* --- Evolution Summary — post-convergence learning stats --- */
.tr-evolution-summary {
  margin: 4px 24px 8px;
  padding: 6px 12px;
  background: #1a2520;
  border: 1px solid #2a4a3a;
  border-radius: 6px;
  font-size: 11px;
  color: #7a7;
  text-align: center;
}

.tr-evolution-summary strong {
  color: #8c8;
}

/* --- Collapsed Hint — click to load older messages --- */
.tr-collapsed-hint {
  text-align: center;
  padding: 8px;
  font-size: 12px;
  color: #6f7a8f;
  cursor: pointer;
  border-bottom: 1px dashed #333;
  margin-bottom: 8px;
}

.tr-collapsed-hint:hover {
  color: #a7b0c2;
  background: #1a1f2b;
}
```

- [ ] **Step 3: Commit CSS**

```bash
git add renderer/team-room.css
git commit -m "style(team): add tool_use, evolution summary, collapsed hint CSS"
```

---

### Task 2: tool_use 独立样式 — JS

**Files:**
- Modify: `renderer/team-room.js`

- [ ] **Step 1: Add `_formatToolCall` helper and `appendToolUse` function**

Insert after the `appendCheckpoint` function (after line 511 in team-room.js):

```javascript
  /** Format tool call input as readable function-call string. */
  function _formatToolCall(tool, input) {
    const name = tool || 'unknown';
    if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
      return `${name}()`;
    }
    const args = Object.entries(input)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    const full = `${name}(${args})`;
    return full.length > 120 ? full.slice(0, 117) + '...' : full;
  }

  /** Render a tool_use card — code-style, distinct from checkpoint. */
  function appendToolUse(container, { actor, name, tool, input, ts }) {
    const charId = actor || 'system';
    const ch = characters[charId];
    const cli = ch ? (ch.backing_cli || charId) : charId;
    const colorCls = avatarColor(cli);
    const displayName = name || charName(charId);
    const timeStr = formatTs(ts);
    const codeStr = _formatToolCall(tool, input);

    const el = document.createElement('div');
    el.className = `tr-tool-use ${colorCls}`;
    el.innerHTML = `
      <div class="tr-tool-use-avatar">\u{1F527}</div>
      <div class="tr-tool-use-body">
        <div class="tr-tool-use-meta">
          <span class="tr-tool-use-name">${esc(displayName)}</span>
          <span class="tr-tool-use-tag">\u8C03\u7528\u5DE5\u5177</span>
          <span class="tr-tool-use-time">${esc(timeStr)}</span>
        </div>
        <div class="tr-tool-use-code">${esc(codeStr)}</div>
      </div>
    `;
    container.appendChild(el);
  }
```

Note: `\u8C03\u7528\u5DE5\u5177` = "调用工具" (avoids emoji encoding issues on Chinese Windows).

- [ ] **Step 2: Update `handleStreamEvent` tool_use branch**

Replace lines 722-730:

```javascript
    else if (evtType === 'tool_use') {
      appendToolUse(threadEl, {
        actor: actorId,
        name,
        tool: evt.tool || '',
        input: evt.input || {},
        ts: evt.ts,
      });
      threadEl.scrollTop = threadEl.scrollHeight;
    }
```

- [ ] **Step 3: Update `refreshThread` tool_use branch**

In the `refreshThread` function, find the `tool_use` case (around line 429-433) and replace:

```javascript
      } else if (t === 'tool_use') {
        appendToolUse(threadEl, {
          actor: evt.actor, name: charName(evt.actor),
          tool: evt.tool || evt.content || 'tool',
          input: evt.input || {},
          ts: evt.ts,
        });
```

- [ ] **Step 4: Commit**

```bash
git add renderer/team-room.js
git commit -m "feat(team): tool_use renders as code-style card with appendToolUse"
```

---

### Task 3: Round 分隔线

**Files:**
- Modify: `renderer/team-room.js`

- [ ] **Step 1: Add round tracking state and helper**

In the state section near the top (after `let streamHandler = null;` around line 25), add:

```javascript
  let streamRound = 0;
  let streamRoundActors = new Set();
```

Add a helper function (near the other helpers, after `formatContent`):

```javascript
  /** Get label text for a round separator. */
  function _roundLabel(n) {
    if (n === 1) return 'ROUND 1 \u00B7 \u72EC\u7ACB\u601D\u8003';
    if (n === 2) return 'ROUND 2 \u00B7 \u4E92\u76F8\u8865\u5200';
    return `ROUND ${n} \u00B7 \u6DF1\u5165\u8BA8\u8BBA`;
  }

  /** Insert a round separator into the thread. */
  function _insertRoundSeparator(container, roundNum) {
    const label = document.createElement('div');
    label.className = 'tr-round-label';
    label.textContent = _roundLabel(roundNum);
    container.appendChild(label);
  }
```

Note: `\u72EC\u7ACB\u601D\u8003` = "独立思考", `\u4E92\u76F8\u8865\u5200` = "互相补刀", `\u6DF1\u5165\u8BA8\u8BBA` = "深入讨论".

- [ ] **Step 2: Insert round logic into `handleStreamEvent` thinking branch**

In the `thinking` handler (around line 682), add round detection BEFORE creating the thinking element:

```javascript
    if (evtType === 'thinking') {
      // Round detection: if this actor already spoke, it's a new round
      if (streamRound === 0) {
        streamRound = 1;
        _insertRoundSeparator(threadEl, 1);
      } else if (streamRoundActors.has(actorId)) {
        streamRound++;
        streamRoundActors.clear();
        _insertRoundSeparator(threadEl, streamRound);
      }

      const ch = characters[actorId];
      // ... rest of existing thinking handler unchanged
```

- [ ] **Step 3: Track actors in message handler**

In the `message` handler (around line 795), after the message is appended, add:

```javascript
      // Track which actors have spoken in this round
      streamRoundActors.add(actorId);
```

- [ ] **Step 4: Reset round state on convergence**

In the `converged` handler (around line 835), add after clearing thinking:

```javascript
      streamRound = 0;
      streamRoundActors.clear();
```

- [ ] **Step 5: Commit**

```bash
git add renderer/team-room.js
git commit -m "feat(team): auto-insert Round separators during streaming"
```

---

### Task 4: Evolution 摘要

**Files:**
- Modify: `renderer/team-room.js`

- [ ] **Step 1: Add pending stats state**

Near the other state variables (around line 25):

```javascript
  let pendingExtractionStats = null;
```

- [ ] **Step 2: Add evolution rendering helper**

After `_insertRoundSeparator`:

```javascript
  /** Render evolution summary bar after convergence. */
  function _appendEvolutionSummary(container, extraction, evolution) {
    const parts = [];
    if (extraction) {
      const p = extraction.personal || 0;
      if (p > 0) parts.push(`\u63D0\u53D6 <strong>${p}</strong> \u6761\u8BB0\u5FC6`);
    }
    if (evolution) {
      const l = evolution.lessons_saved || 0;
      const d = (evolution.wiki_distilled || 0) + (evolution.lessons_distilled || 0);
      if (l > 0) parts.push(`\u5B66\u5230 <strong>${l}</strong> \u6761\u7ECF\u9A8C`);
      if (d > 0) parts.push(`\u84B8\u998F <strong>${d}</strong> \u6761\u5171\u8BC6`);
    }
    if (parts.length === 0) return;
    const el = document.createElement('div');
    el.className = 'tr-evolution-summary';
    el.innerHTML = `\u{1F4DD} ${parts.join(' \u00B7 ')}`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }
```

Note: `\u63D0\u53D6` = "提取", `\u8BB0\u5FC6` = "记忆", `\u5B66\u5230` = "学到", `\u7ECF\u9A8C` = "经验", `\u84B8\u998F` = "蒸馏", `\u5171\u8BC6` = "共识", `\u{1F4DD}` = 📝.

- [ ] **Step 3: Handle extraction_done and evolution_done in handleStreamEvent**

Add before the `appendInspectorEvent` call at the end of `handleStreamEvent` (before line 852):

```javascript
    else if (evtType === 'extraction_done') {
      pendingExtractionStats = evt.stats || null;
    }

    else if (evtType === 'evolution_done') {
      _appendEvolutionSummary(threadEl, pendingExtractionStats, evt.stats || {});
      pendingExtractionStats = null;
    }
```

- [ ] **Step 4: Commit**

```bash
git add renderer/team-room.js
git commit -m "feat(team): show evolution summary after convergence"
```

---

### Task 5: 长对话折叠

**Files:**
- Modify: `renderer/team-room.js`

- [ ] **Step 1: Add trim constant and function**

Near the state section:

```javascript
  const MAX_VISIBLE_STREAM = 50;
```

Add the trim function (after evolution helpers):

```javascript
  /** Remove oldest elements when streaming thread exceeds MAX_VISIBLE_STREAM. */
  function _trimThread(threadEl) {
    const hintCls = 'tr-collapsed-hint';
    const children = threadEl.children;
    const hasHint = children.length > 0 && children[0].classList.contains(hintCls);
    const contentCount = hasHint ? children.length - 1 : children.length;

    if (contentCount <= MAX_VISIBLE_STREAM) return;

    const excess = contentCount - MAX_VISIBLE_STREAM;
    const startIdx = hasHint ? 1 : 0;
    for (let i = 0; i < excess; i++) {
      threadEl.removeChild(threadEl.children[startIdx]);
    }

    if (!hasHint) {
      const hint = document.createElement('div');
      hint.className = hintCls;
      hint.textContent = '\u22EF \u70B9\u51FB\u52A0\u8F7D\u66F4\u65E9\u7684\u6D88\u606F';
      hint.onclick = () => refreshThread();
      threadEl.insertBefore(hint, threadEl.firstChild);
    }
  }
```

Note: `\u22EF` = "⋯", text = "点击加载更早的消息".

- [ ] **Step 2: Call `_trimThread` at the end of `handleStreamEvent`**

Right before the `appendInspectorEvent(evt)` line (line 852), add:

```javascript
    _trimThread(threadEl);
```

- [ ] **Step 3: Commit**

```bash
git add renderer/team-room.js
git commit -m "feat(team): fold old messages when streaming exceeds 50 elements"
```

---

### Task 6: E2E 验证

**Files:**
- Create: `~/.ai-team/test_ui_polish.py` (test script, temporary)

- [ ] **Step 1: Create worktree + start test Hub**

```bash
cd ~/claude-session-hub && git worktree prune
rm -rf ~/ai-team-hub-test 2>/dev/null
git worktree add -b test/ui-polish ~/ai-team-hub-test HEAD
cd ~/ai-team-hub-test && ln -s ~/claude-session-hub/node_modules node_modules
~/claude-session-hub/node_modules/electron/dist/electron.exe . --remote-debugging-port=9555 &
```

Wait for "hook server listening" + CDP ready on port 9555.

- [ ] **Step 2: Write and run CDP verification script**

Create `~/.ai-team/test_ui_polish.py` that:
1. Opens team room via CDP
2. Injects event sequence: thinking×3 → tool_use×2 → checkpoint×1 → message×2 → thinking(repeat actor) → message → converged → extraction_done → evolution_done
3. Then injects 55 more messages to trigger folding
4. Checks:
   - `.tr-tool-use` count == 2
   - `.tr-checkpoint` count == 1
   - `.tr-round-label` count >= 3 (R1 + R2 + converged)
   - `.tr-evolution-summary` count == 1
   - `.tr-collapsed-hint` exists
   - Total children <= 52 (50 + hint + summary)
5. Takes screenshot

- [ ] **Step 3: Verify screenshot shows correct visual distinction**

Open screenshot, confirm:
- tool_use cards have code font + solid border + 🔧 avatar + green "调用工具" tag
- checkpoint cards have dashed border + "路过说一下" tag
- Round separators visible between R1 and R2
- Green evolution summary bar after convergence
- "⋯ 点击加载更早的消息" hint at top

- [ ] **Step 4: Run real CLI E2E**

```bash
cd ~/.ai-team && python integration_test.py "@team 兆易创新现在什么价位适合加仓？"
```

Open test Hub, verify real conversation renders with all 5 fixes.

- [ ] **Step 5: Clean up**

```bash
# Kill test Hub
netstat -ano | grep "3457.*LISTEN" | awk '{print $5}' | while read pid; do taskkill //F //T //PID $pid; done
# Remove worktree
cd ~/claude-session-hub && git worktree remove ~/ai-team-hub-test --force; git branch -D test/ui-polish; git worktree prune
# Remove temp test script
rm ~/.ai-team/test_ui_polish.py
```

- [ ] **Step 6: Final commit**

```bash
cd ~/claude-session-hub
git add renderer/team-room.js renderer/team-room.css
git commit -m "verified: team room UI polish — 5 fixes E2E tested"
```
