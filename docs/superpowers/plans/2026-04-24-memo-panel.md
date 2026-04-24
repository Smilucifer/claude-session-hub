# Memo Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global memo panel (right-side drawer) to Claude Session Hub so users can jot down ideas while Claude is busy, then copy them into the terminal later.

**Architecture:** Pure renderer-side feature. A toggle button is added to both the regular session header and meeting-room header (before the A- button). The memo panel is a fixed-width div appended to `.app-container` in `index.html`, shown/hidden via CSS. Data persists in localStorage as a JSON array of `{id, text, ts}` objects.

**Tech Stack:** Vanilla JS (Electron renderer), CSS variables, localStorage API, Clipboard API.

---

## File Structure

| File | Role |
|------|------|
| `renderer/index.html` | Add `#memo-panel` container div after `#terminal-panel` (and after meeting/team panels) |
| `renderer/styles.css` | All memo panel styles: panel layout, item list, buttons, toggle active state |
| `renderer/renderer.js` | Memo data model (load/save/add/delete/clear), panel rendering, toggle button in session header |
| `renderer/meeting-room.js` | Memo toggle button in meeting-room header (calls shared toggle function from renderer.js) |

---

### Task 1: Add memo panel HTML container

**Files:**
- Modify: `renderer/index.html:50-56` (after terminal-panel, before team-room-panel)

- [ ] **Step 1: Add the `#memo-panel` div to index.html**

Insert a new div right after the `#terminal-panel` closing `</div>` (line 56) and before `<div class="team-room-panel"` (line 57). The panel sits as a direct child of `.app-container` so flexbox places it to the right of whichever panel is active.

```html
    <div class="memo-panel" id="memo-panel" style="display:none">
      <div class="memo-header">
        <span class="memo-title">备忘录</span>
        <button class="memo-clear-btn" id="memo-clear-btn" title="清空全部">清空</button>
      </div>
      <div class="memo-input-row">
        <input type="text" class="memo-input" id="memo-input" placeholder="输入想法...">
        <button class="memo-add-btn" id="memo-add-btn" title="添加">+</button>
      </div>
      <div class="memo-list" id="memo-list"></div>
    </div>
```

- [ ] **Step 2: Verify HTML is valid**

Open DevTools in Hub (Ctrl+Shift+I), check Elements panel — `#memo-panel` should exist as a child of `#app-container`, with `display:none`.

- [ ] **Step 3: Commit**

```bash
git add renderer/index.html
git commit -m "feat(memo): add memo panel HTML container"
```

---

### Task 2: Add memo panel CSS

**Files:**
- Modify: `renderer/styles.css` (append at end of file)

- [ ] **Step 1: Add all memo panel styles to styles.css**

Append the following block at the end of `styles.css`:

```css
/* ── Memo Panel ─────────────────────────────────────────── */

.memo-panel {
  width: 280px;
  min-width: 280px;
  max-width: 280px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border);
}

.memo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.memo-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.memo-clear-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}

.memo-clear-btn:hover {
  color: var(--accent-red);
  background: rgba(231, 76, 60, 0.12);
}

.memo-input-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.memo-input {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  font-family: inherit;
}

.memo-input:focus {
  border-color: var(--accent-blue);
}

.memo-add-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
  width: 26px;
  height: 26px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
}

.memo-add-btn:hover {
  color: var(--text-primary);
  border-color: var(--text-secondary);
}

.memo-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.memo-item {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}

.memo-item:hover {
  background: var(--bg-tertiary);
}

.memo-item-time {
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 2px;
}

.memo-item-body {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}

.memo-item-text {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-word;
  line-height: 1.4;
}

.memo-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.memo-item:hover .memo-item-actions {
  opacity: 1;
}

.memo-item-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
}

.memo-item-btn:hover {
  color: var(--text-primary);
  background: var(--bg-primary);
}

.memo-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  padding: 24px 12px;
}

/* Memo toggle button — active state */
.btn-memo-toggle.active {
  background: var(--accent-blue);
  color: #fff;
  border-color: var(--accent-blue);
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/styles.css
git commit -m "feat(memo): add memo panel CSS styles"
```

---

### Task 3: Implement memo data model and panel logic in renderer.js

**Files:**
- Modify: `renderer/renderer.js` (add memo section after the zoom section, ~line 320)

- [ ] **Step 1: Add memo data model and rendering functions**

Insert the following block after line 320 (`applyZoom(currentZoom);`) in `renderer.js`:

```javascript
// --- Global Memo Panel ---
const MEMO_KEY = 'claude-hub-memo-items';
const MEMO_OPEN_KEY = 'claude-hub-memo-open';

function loadMemoItems() {
  try { return JSON.parse(localStorage.getItem(MEMO_KEY)) || []; }
  catch { return []; }
}
function saveMemoItems(items) {
  localStorage.setItem(MEMO_KEY, JSON.stringify(items));
}

function formatMemoTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderMemoList() {
  const listEl = document.getElementById('memo-list');
  if (!listEl) return;
  const items = loadMemoItems();
  if (items.length === 0) {
    listEl.innerHTML = '<div class="memo-empty">暂无备忘</div>';
    return;
  }
  listEl.innerHTML = items.map(item => `
    <div class="memo-item" data-id="${item.id}">
      <div class="memo-item-time">${formatMemoTime(item.ts)}</div>
      <div class="memo-item-body">
        <span class="memo-item-text">${escapeHtml(item.text)}</span>
        <span class="memo-item-actions">
          <button class="memo-item-btn memo-copy-btn" title="复制">📋</button>
          <button class="memo-item-btn memo-del-btn" title="删除">🗑</button>
        </span>
      </div>
    </div>
  `).join('');
}

function addMemoItem(text) {
  if (!text.trim()) return;
  const items = loadMemoItems();
  items.unshift({ id: 'm_' + Date.now(), text: text.trim(), ts: Date.now() });
  saveMemoItems(items);
  renderMemoList();
}

function deleteMemoItem(id) {
  const items = loadMemoItems().filter(i => i.id !== id);
  saveMemoItems(items);
  renderMemoList();
}

function clearAllMemo() {
  saveMemoItems([]);
  renderMemoList();
}

function toggleMemoPanel() {
  const panel = document.getElementById('memo-panel');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  localStorage.setItem(MEMO_OPEN_KEY, String(!isOpen));
  document.querySelectorAll('.btn-memo-toggle').forEach(btn => {
    btn.classList.toggle('active', !isOpen);
  });
  if (!isOpen) renderMemoList();
  // Re-fit active terminal after layout change
  const active = activeSessionId && terminalCache.get(activeSessionId);
  if (active && active.opened) {
    setTimeout(() => { try { active.fitAddon.fit(); } catch {} }, 50);
  }
}

// Memo panel event delegation (runs once on DOMContentLoaded)
function initMemoPanel() {
  const addBtn = document.getElementById('memo-add-btn');
  const input = document.getElementById('memo-input');
  const clearBtn = document.getElementById('memo-clear-btn');
  const listEl = document.getElementById('memo-list');
  if (!addBtn || !input) return;

  // Prevent keyboard events from reaching xterm
  input.addEventListener('keydown', e => e.stopPropagation());
  input.addEventListener('keypress', e => e.stopPropagation());
  input.addEventListener('keyup', e => e.stopPropagation());

  addBtn.addEventListener('click', () => {
    addMemoItem(input.value);
    input.value = '';
    input.focus();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addMemoItem(input.value);
      input.value = '';
    }
  });

  clearBtn.addEventListener('click', () => clearAllMemo());

  listEl.addEventListener('click', e => {
    const copyBtn = e.target.closest('.memo-copy-btn');
    if (copyBtn) {
      const item = copyBtn.closest('.memo-item');
      const text = item.querySelector('.memo-item-text').textContent;
      clipboard.writeText(text);
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
      return;
    }
    const delBtn = e.target.closest('.memo-del-btn');
    if (delBtn) {
      const item = delBtn.closest('.memo-item');
      deleteMemoItem(item.dataset.id);
    }
  });

  // Restore open state
  if (localStorage.getItem(MEMO_OPEN_KEY) === 'true') {
    const panel = document.getElementById('memo-panel');
    if (panel) {
      panel.style.display = 'flex';
      renderMemoList();
      document.querySelectorAll('.btn-memo-toggle').forEach(btn => btn.classList.add('active'));
    }
  }
}

initMemoPanel();
```

- [ ] **Step 2: Verify the functions exist**

Open DevTools console, type `toggleMemoPanel` — should print the function. Type `loadMemoItems()` — should return `[]`.

- [ ] **Step 3: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(memo): add memo data model and panel logic"
```

---

### Task 4: Add memo toggle button to regular session header

**Files:**
- Modify: `renderer/renderer.js:855-857` (the `headerActions.append(...)` line in `showTerminal`)

- [ ] **Step 1: Create memo toggle button and insert before zoom buttons**

Find the block in `showTerminal()` (around line 855):

```javascript
  const headerActions = document.createElement('div');
  headerActions.className = 'terminal-header-actions';
  headerActions.append(zoomOutBtn, zoomInBtn, closeBtn);
```

Replace the `headerActions.append(...)` line with:

```javascript
  const memoBtn = document.createElement('button');
  memoBtn.className = 'btn-zoom btn-memo-toggle';
  memoBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
  memoBtn.title = 'Toggle memo panel';
  if (localStorage.getItem(MEMO_OPEN_KEY) === 'true') memoBtn.classList.add('active');
  memoBtn.addEventListener('click', () => toggleMemoPanel());

  headerActions.append(memoBtn, zoomOutBtn, zoomInBtn, closeBtn);
```

- [ ] **Step 2: Test in Hub**

Click the memo button in a session header. Panel should appear on the right. Click again, panel hides. Terminal should re-fit after toggle.

- [ ] **Step 3: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(memo): add toggle button to session header"
```

---

### Task 5: Add memo toggle button to meeting-room header

**Files:**
- Modify: `renderer/meeting-room.js:117-123` (the `mr-header-right` innerHTML block)

- [ ] **Step 1: Insert memo button before zoom buttons in meeting-room header**

Find the `mr-header-right` section in the `renderHeader` function (line 117-124):

```html
      <div class="mr-header-right">
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>
        <button class="mr-header-btn ${meeting.layout === 'blackboard' ? 'active' : ''}" id="mr-btn-blackboard">Blackboard</button>
        <button class="mr-header-btn" id="mr-btn-add-sub" title="添加子会话">+ 添加</button>
        <button class="btn-zoom" id="mr-btn-zoom-out" title="Shrink UI">A−</button>
```

Insert the memo button line right after the `+ 添加` button and before `mr-btn-zoom-out`:

```html
        <button class="btn-zoom btn-memo-toggle ${typeof localStorage !== 'undefined' && localStorage.getItem('claude-hub-memo-open') === 'true' ? 'active' : ''}" id="mr-btn-memo" title="Toggle memo panel"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg></button>
```

- [ ] **Step 2: Add click event listener for the memo button**

Find the event listener block (after line 131), right after the `mr-btn-zoom-in` listener. Add:

```javascript
    document.getElementById('mr-btn-memo').addEventListener('click', () => { if (typeof toggleMemoPanel === 'function') toggleMemoPanel(); });
```

- [ ] **Step 3: Test in a meeting room**

Open a meeting room, verify the memo button appears between `+ 添加` and `A−`. Click it — the same global memo panel should toggle.

- [ ] **Step 4: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(memo): add toggle button to meeting-room header"
```

---

### Task 6: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Test full flow — regular session**

1. Open Hub, select a session
2. Verify button order: `[memo] [A−] [A+] [X]`
3. Click memo button — panel opens on right, terminal shrinks
4. Type "test memo 1" in input, press Enter — item appears with timestamp
5. Type "test memo 2", click `+` — second item at top
6. Click 📋 on an item — shows ✓, paste into notepad to verify
7. Click 🗑 on an item — item removed
8. Click 清空 — all items gone, shows "暂无备忘"
9. Close memo panel, reopen — items persist
10. Close and restart Hub — items and panel state persist

- [ ] **Step 2: Test full flow — meeting room**

1. Open a meeting room
2. Verify memo button in header
3. Toggle panel — same memo list shared with session view

- [ ] **Step 3: Test input isolation**

1. Open memo panel while a session terminal is active
2. Click into memo input field
3. Type characters — they should NOT appear in the terminal
4. Press Enter — adds memo item, NOT sent to terminal

- [ ] **Step 4: Test zoom interaction**

1. Open memo panel
2. Click A+ and A- — both panel and terminal zoom together (webFrame zoom)
3. Terminal should re-fit properly with panel open
