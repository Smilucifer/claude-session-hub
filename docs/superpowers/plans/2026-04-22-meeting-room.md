# Meeting Room (会议室) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Meeting Room" feature to Claude Session Hub — a lightweight multi-AI workspace where up to 3 CLI sessions (Claude/Gemini/Codex) run side-by-side with broadcast input, manual quoting, and optional auto-context sync.

**Architecture:** Independent module approach. New `core/meeting-room.js` manages meeting lifecycle (backend), `renderer/meeting-room.js` handles the parallel terminal UI (frontend), `renderer/meeting-room.css` provides styles. Meetings reuse `session-manager.createSession()` for PTY creation but own their UI panel (`meeting-room-panel`) which is mutually exclusive with `terminal-panel` and `team-room-panel`. Sub-sessions are standard sessions with an extra `meetingId` field linking them to their parent meeting.

**Tech Stack:** Electron IPC, node-pty (via existing SessionManager), xterm.js (existing terminal cache), vanilla JS/CSS (no build step)

**Spec:** `docs/superpowers/specs/2026-04-22-meeting-room-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|----------------|
| `core/meeting-room.js` | Meeting lifecycle: create/close meetings, add/remove sub-sessions, query state. Pure data — no PTY or IPC knowledge. |
| `renderer/meeting-room.js` | Meeting UI: split/focus layout, terminal mounting, input bar, broadcast, quoting, context sync. Exposes `MeetingRoom` global. |
| `renderer/meeting-room.css` | All meeting-room-specific styles |

### Modified Files

| File | Lines | Change |
|------|-------|--------|
| `renderer/index.html` | 20-26 | Add "会议室" option to `#new-session-menu`; add `<div class="meeting-room-panel">` panel; link new CSS/JS |
| `renderer/renderer.js` | 337-448 | `renderSessionList()` — render meeting items with 🏢 icon and `[N]` badge |
| `renderer/renderer.js` | 1039-1094 | `selectSession()` — detect meeting type, delegate to `MeetingRoom.openMeeting()` |
| `renderer/renderer.js` | 1105-1113 | Menu click handler — handle `data-kind="meeting"` |
| `renderer/renderer.js` | 2422-2443 | `schedulePersist()` — include meeting data |
| `renderer/renderer.js` | 2448-2463 | `resumeDormantSession()` — handle meeting dormant wake |
| `main.js` | 8-13 | Require `core/meeting-room.js` |
| `main.js` | 297-307 | After `create-session` handler — add meeting IPC handlers |
| `core/session-manager.js` | 108-119 | `createSession()` — write `meetingId` into session info |

---

## Task 1: Core Module — `core/meeting-room.js`

**Files:**
- Create: `core/meeting-room.js`

- [ ] **Step 1: Create the MeetingRoomManager class**

```javascript
// core/meeting-room.js
const { v4: uuid } = require('uuid');

class MeetingRoomManager {
  constructor() {
    this.meetings = new Map();
    this._counter = 0;
  }

  createMeeting() {
    const id = uuid();
    const meeting = {
      id,
      type: 'meeting',
      title: `会议室-${++this._counter}`,
      subSessions: [],
      layout: 'split',
      focusedSub: null,
      syncContext: false,
      sendTarget: 'all',
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      pinned: false,
      status: 'idle',
    };
    this.meetings.set(id, meeting);
    return { ...meeting };
  }

  getMeeting(id) {
    const m = this.meetings.get(id);
    return m ? { ...m, subSessions: [...m.subSessions] } : null;
  }

  getAllMeetings() {
    return Array.from(this.meetings.values()).map(m => ({
      ...m,
      subSessions: [...m.subSessions],
    }));
  }

  addSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (m.subSessions.length >= 3) return null;
    if (m.subSessions.includes(sessionId)) return null;
    m.subSessions.push(sessionId);
    m.lastMessageTime = Date.now();
    return { ...m, subSessions: [...m.subSessions] };
  }

  removeSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.subSessions = m.subSessions.filter(id => id !== sessionId);
    if (m.focusedSub === sessionId) m.focusedSub = m.subSessions[0] || null;
    if (m.sendTarget === sessionId) m.sendTarget = 'all';
    return { ...m, subSessions: [...m.subSessions] };
  }

  updateMeeting(meetingId, fields) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    const allowed = ['title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned', 'lastMessageTime', 'status'];
    for (const key of allowed) {
      if (key in fields) m[key] = fields[key];
    }
    return { ...m, subSessions: [...m.subSessions] };
  }

  closeMeeting(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    const subIds = [...m.subSessions];
    this.meetings.delete(meetingId);
    return subIds;
  }

  // Restore meetings from persisted state (app boot).
  restoreMeeting(meetingData) {
    if (!meetingData || !meetingData.id) return;
    this.meetings.set(meetingData.id, {
      ...meetingData,
      status: 'dormant',
      subSessions: meetingData.subSessions || [],
    });
    const num = parseInt((meetingData.title || '').replace(/\D/g, ''), 10);
    if (num && num >= this._counter) this._counter = num;
  }
}

module.exports = { MeetingRoomManager };
```

- [ ] **Step 2: Verify the module loads without errors**

Run: `node -e "const { MeetingRoomManager } = require('./core/meeting-room.js'); const m = new MeetingRoomManager(); const r = m.createMeeting(); console.log(r.type, r.title, r.subSessions.length); const r2 = m.addSubSession(r.id, 'fake-session-1'); console.log(r2.subSessions.length); const r3 = m.addSubSession(r.id, 'fake-2'); const r4 = m.addSubSession(r.id, 'fake-3'); const r5 = m.addSubSession(r.id, 'fake-4'); console.log('max3:', r5 === null); console.log('close:', m.closeMeeting(r.id));"`

Expected output:
```
meeting 会议室-1 0
1
max3: true
close: [ 'fake-session-1', 'fake-2', 'fake-3' ]
```

- [ ] **Step 3: Commit**

```bash
git add core/meeting-room.js
git commit -m "feat(meeting): add MeetingRoomManager core module"
```

---

## Task 2: Extend session-manager — `meetingId` field

**Files:**
- Modify: `core/session-manager.js:108-119` (session info construction)

- [ ] **Step 1: Add `meetingId` to session info**

In `core/session-manager.js`, inside `createSession()`, after the `info` object construction (line 119), add the `meetingId` field:

```javascript
// Find this block (line 108-119):
const info = {
  id,
  kind,
  title,
  status: 'idle',
  lastMessageTime: opts.lastMessageTime || now,
  lastOutputPreview: opts.lastOutputPreview || '',
  unreadCount: 0,
  createdAt: now,
  cwd: spawnCwd,
};

// Replace with:
const info = {
  id,
  kind,
  title,
  status: 'idle',
  lastMessageTime: opts.lastMessageTime || now,
  lastOutputPreview: opts.lastOutputPreview || '',
  unreadCount: 0,
  createdAt: now,
  cwd: spawnCwd,
  meetingId: opts.meetingId || null,
};
```

- [ ] **Step 2: Verify it doesn't break existing session creation**

Run: `node -e "const { SessionManager } = require('./core/session-manager.js'); console.log('loaded ok');"`

Expected: `loaded ok` (no crash — we're just importing; PTY spawn needs Electron)

- [ ] **Step 3: Commit**

```bash
git add core/session-manager.js
git commit -m "feat(meeting): add meetingId field to session info"
```

---

## Task 3: Main process IPC handlers

**Files:**
- Modify: `main.js` (add require + IPC handlers)

- [ ] **Step 1: Add require for MeetingRoomManager**

At `main.js` line 8, after the existing requires, add:

```javascript
const { MeetingRoomManager } = require('./core/meeting-room.js');
```

- [ ] **Step 2: Instantiate MeetingRoomManager**

After `const sessionManager = new SessionManager();` (find this line), add:

```javascript
const meetingManager = new MeetingRoomManager();
```

- [ ] **Step 3: Add IPC handlers after the existing `create-session` handler (after line 307)**

```javascript
// --- Meeting Room IPC ---

ipcMain.handle('create-meeting', () => {
  const meeting = meetingManager.createMeeting();
  sendToRenderer('meeting-created', { meeting });
  return meeting;
});

ipcMain.handle('add-meeting-sub', (_e, { meetingId, kind }) => {
  const session = sessionManager.createSession(kind, { meetingId });
  if (!session) return null;
  const updated = meetingManager.addSubSession(meetingId, session.id);
  if (!updated) {
    sessionManager.closeSession(session.id);
    return null;
  }
  sendToRenderer('session-created', { session });
  return { session, meeting: updated };
});

ipcMain.handle('remove-meeting-sub', (_e, { meetingId, sessionId }) => {
  sessionManager.closeSession(sessionId);
  const updated = meetingManager.removeSubSession(meetingId, sessionId);
  return updated;
});

ipcMain.handle('close-meeting', (_e, meetingId) => {
  const subIds = meetingManager.closeMeeting(meetingId);
  if (!subIds) return false;
  for (const sid of subIds) {
    sessionManager.closeSession(sid);
  }
  sendToRenderer('meeting-closed', { meetingId });
  return true;
});

ipcMain.handle('get-ring-buffer', (_e, sessionId) => {
  return sessionManager.getSessionBuffer(sessionId);
});

ipcMain.on('update-meeting', (_e, { meetingId, fields }) => {
  const updated = meetingManager.updateMeeting(meetingId, fields);
  if (updated) sendToRenderer('meeting-updated', { meeting: updated });
});

ipcMain.handle('get-meetings', () => {
  return meetingManager.getAllMeetings();
});
```

- [ ] **Step 4: Restore meetings from persisted state on boot**

Find the dormant session restore block (line 360-368). After `stateStore.save(...)` on line 368, add meeting restore logic:

```javascript
// Restore persisted meetings on boot
const bootMeetings = Array.isArray(bootState.meetings) ? bootState.meetings : [];
for (const m of bootMeetings) {
  meetingManager.restoreMeeting(m);
}

ipcMain.handle('get-dormant-meetings', () => meetingManager.getAllMeetings());
```

- [ ] **Step 5: Extend persist-sessions handler to include meetings**

Find `ipcMain.on('persist-sessions', ...)` (line 375). Extend it to also save meetings:

```javascript
ipcMain.on('persist-sessions', (_e, list) => {
  if (!Array.isArray(list)) return;
  lastPersistedSessions = list;
  stateStore.save({
    version: 1,
    cleanShutdown: false,
    sessions: list,
    meetings: meetingManager.getAllMeetings(),
  });
});
```

- [ ] **Step 6: Smoke test — launch Hub and verify no crash**

Run: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20`

Expected: Hub starts without errors. Look for `[hub] hook server listening` in output.

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat(meeting): add IPC handlers for meeting room lifecycle"
```

---

## Task 4: HTML structure

**Files:**
- Modify: `renderer/index.html`

- [ ] **Step 1: Add "会议室" to the new session menu**

Find the menu block (lines 20-26). After the Team Room button and before the closing `</div>`, add:

```html
<div class="new-session-divider"></div>
<button class="new-session-option" data-kind="meeting">🏢 会议室</button>
```

The full menu should now be:
```html
<div class="new-session-menu" id="new-session-menu" style="display:none">
  <button class="new-session-option" data-kind="claude">Claude Code</button>
  <button class="new-session-option" data-kind="claude-resume">Claude Resume</button>
  <button class="new-session-option" data-kind="powershell">PowerShell</button>
  <div class="new-session-divider"></div>
  <button class="new-session-option" data-kind="team-room">🏠 创建房间</button>
  <div class="new-session-divider"></div>
  <button class="new-session-option" data-kind="meeting">🏢 会议室</button>
</div>
```

- [ ] **Step 2: Add meeting room panel**

After the `team-room-panel` div (after line 75), add:

```html
<div class="meeting-room-panel" id="meeting-room-panel" style="display:none">
  <div class="mr-header" id="mr-header"></div>
  <div class="mr-terminals" id="mr-terminals"></div>
  <div class="mr-toolbar" id="mr-toolbar"></div>
  <div class="mr-input-row" id="mr-input-row">
    <div class="mr-input-box" id="mr-input-box" contenteditable="true" data-placeholder="输入消息..."></div>
    <button class="mr-send-btn" id="mr-send-btn" title="发送">▶</button>
  </div>
</div>
```

- [ ] **Step 3: Link new CSS and JS files**

At line 9, after the team-room.css link, add:

```html
<link rel="stylesheet" href="meeting-room.css">
```

At line 127, after the team-room.js script, add:

```html
<script src="meeting-room.js"></script>
```

- [ ] **Step 4: Commit**

```bash
git add renderer/index.html
git commit -m "feat(meeting): add HTML structure for meeting room panel"
```

---

## Task 5: CSS — `renderer/meeting-room.css`

**Files:**
- Create: `renderer/meeting-room.css`

- [ ] **Step 1: Create the stylesheet**

```css
/* Meeting Room Panel */
.meeting-room-panel {
  display: none;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--bg-primary, #0d1117);
  color: var(--text-primary, #c9d1d9);
}

/* Header */
.mr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--bg-secondary, #161b22);
  border-bottom: 1px solid var(--border, #30363d);
  min-height: 40px;
}

.mr-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mr-header-title {
  font-weight: 600;
  font-size: 14px;
  cursor: text;
}

.mr-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mr-header-btn {
  padding: 4px 10px;
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #8b949e);
  font-size: 12px;
  cursor: pointer;
}

.mr-header-btn:hover {
  background: var(--bg-hover, #1c2128);
  color: var(--text-primary, #c9d1d9);
}

.mr-header-btn.active {
  background: var(--accent, #6366f1);
  color: #fff;
  border-color: var(--accent, #6366f1);
}

/* Terminal Grid */
.mr-terminals {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 1px;
  background: var(--border, #30363d);
}

.mr-terminals.focus-mode {
  flex-direction: column;
}

/* Sub-session slot */
.mr-sub-slot {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--bg-primary, #0d1117);
}

.mr-sub-slot.selected {
  outline: 2px solid var(--accent, #6366f1);
  outline-offset: -2px;
}

.mr-sub-slot.dormant {
  opacity: 0.5;
}

.mr-sub-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--bg-secondary, #161b22);
  border-bottom: 1px solid var(--border, #30363d);
  cursor: pointer;
  user-select: none;
}

.mr-sub-header:hover {
  background: var(--bg-hover, #1c2128);
}

.mr-sub-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary, #8b949e);
}

.mr-sub-close {
  background: none;
  border: none;
  color: var(--text-secondary, #8b949e);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  line-height: 1;
}

.mr-sub-close:hover {
  color: #f85149;
}

.mr-sub-terminal {
  flex: 1;
  min-height: 0;
}

/* Empty slot */
.mr-empty-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 0;
  background: var(--bg-primary, #0d1117);
  cursor: pointer;
  gap: 8px;
}

.mr-empty-slot:hover {
  background: var(--bg-hover, #1c2128);
}

.mr-empty-slot-icon {
  font-size: 32px;
  color: var(--text-secondary, #8b949e);
  opacity: 0.5;
}

.mr-empty-slot-text {
  font-size: 13px;
  color: var(--text-secondary, #8b949e);
}

/* Focus mode preview bar */
.mr-preview-bar {
  display: flex;
  gap: 1px;
  background: var(--border, #30363d);
  max-height: 80px;
  min-height: 60px;
}

.mr-preview-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary, #161b22);
  cursor: pointer;
  padding: 4px 8px;
  overflow: hidden;
}

.mr-preview-item:hover {
  background: var(--bg-hover, #1c2128);
}

.mr-preview-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--accent, #6366f1);
  margin-bottom: 2px;
}

.mr-preview-text {
  font-size: 10px;
  color: var(--text-secondary, #8b949e);
  font-family: monospace;
  white-space: pre;
  overflow: hidden;
  line-height: 1.3;
}

/* Toolbar */
.mr-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: var(--bg-secondary, #161b22);
  border-top: 1px solid var(--border, #30363d);
  font-size: 12px;
}

.mr-toolbar label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary, #8b949e);
}

.mr-target-select {
  padding: 2px 6px;
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  background: var(--bg-primary, #0d1117);
  color: var(--text-primary, #c9d1d9);
  font-size: 12px;
}

.mr-sync-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: var(--text-secondary, #8b949e);
}

.mr-sync-toggle.active {
  color: var(--accent, #6366f1);
}

/* Input Row */
.mr-input-row {
  display: flex;
  align-items: flex-end;
  padding: 8px 12px;
  gap: 8px;
  background: var(--bg-secondary, #161b22);
  border-top: 1px solid var(--border, #30363d);
}

.mr-input-box {
  flex: 1;
  min-height: 36px;
  max-height: 120px;
  padding: 8px 12px;
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  background: var(--bg-primary, #0d1117);
  color: var(--text-primary, #c9d1d9);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  overflow-y: auto;
  word-break: break-word;
}

.mr-input-box:focus {
  border-color: var(--accent, #6366f1);
}

.mr-input-box:empty::before {
  content: attr(data-placeholder);
  color: var(--text-secondary, #8b949e);
}

.mr-send-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: var(--accent, #6366f1);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.mr-send-btn:hover {
  opacity: 0.9;
}

/* Right-click context menu for quoting */
.mr-quote-menu {
  position: fixed;
  background: var(--bg-secondary, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 160px;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.mr-quote-menu-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--text-primary, #c9d1d9);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.mr-quote-menu-item:hover {
  background: var(--bg-hover, #1c2128);
}

/* Sidebar meeting item badge */
.meeting-badge {
  display: inline-block;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent, #6366f1);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  margin-left: 4px;
  vertical-align: middle;
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/meeting-room.css
git commit -m "feat(meeting): add meeting room CSS styles"
```

---

## Task 6: Renderer — `renderer/meeting-room.js` (Split mode)

**Files:**
- Create: `renderer/meeting-room.js`

This is the largest task. We build the core UI engine: opening a meeting, rendering sub-sessions side-by-side in split mode, mounting xterm terminals.

- [ ] **Step 1: Create the MeetingRoom module scaffold**

```javascript
// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.

(function () {
  const { ipcRenderer } = require('electron');

  let activeMeetingId = null;
  let meetingData = {};       // { meetingId: { ...meetingObj } }
  let subTerminals = {};      // { sessionId: { terminal, fitAddon, container } }

  // Populated by renderer.js via MeetingRoom.setSessions()
  let sessionsRef = null;
  let getOrCreateTerminalFn = null;

  const panelEl = () => document.getElementById('meeting-room-panel');
  const headerEl = () => document.getElementById('mr-header');
  const terminalsEl = () => document.getElementById('mr-terminals');
  const toolbarEl = () => document.getElementById('mr-toolbar');
  const inputBoxEl = () => document.getElementById('mr-input-box');
  const sendBtnEl = () => document.getElementById('mr-send-btn');

  // --- Initialization ---

  function init(sessions, getOrCreateTerminal) {
    sessionsRef = sessions;
    getOrCreateTerminalFn = getOrCreateTerminal;
  }

  // --- Open a meeting ---

  function openMeeting(meetingId, meeting) {
    activeMeetingId = meetingId;
    meetingData[meetingId] = meeting;

    const panel = panelEl();
    panel.style.display = 'flex';

    renderHeader(meeting);
    renderTerminals(meeting);
    renderToolbar(meeting);
    setupInput(meeting);
  }

  function closeMeetingPanel() {
    activeMeetingId = null;
    const panel = panelEl();
    if (panel) panel.style.display = 'none';
    // Detach terminals from meeting panel (they stay in cache)
    const el = terminalsEl();
    if (el) el.innerHTML = '';
    subTerminals = {};
  }

  function getActiveMeetingId() {
    return activeMeetingId;
  }

  function getMeetingData(meetingId) {
    return meetingData[meetingId] || null;
  }

  function updateMeetingData(meetingId, updated) {
    meetingData[meetingId] = updated;
    if (activeMeetingId === meetingId) {
      renderHeader(updated);
      renderToolbar(updated);
    }
  }

  // --- Header ---

  function renderHeader(meeting) {
    const el = headerEl();
    if (!el) return;
    const layoutSplit = meeting.layout === 'split';
    el.innerHTML = `
      <div class="mr-header-left">
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>
      </div>
      <div class="mr-header-right">
        <button class="mr-header-btn ${layoutSplit ? 'active' : ''}" id="mr-btn-split">Split</button>
        <button class="mr-header-btn ${!layoutSplit ? 'active' : ''}" id="mr-btn-focus">Focus</button>
        <button class="mr-header-btn" id="mr-btn-add-sub" title="添加子会话">+ 添加</button>
      </div>
    `;

    document.getElementById('mr-btn-split').addEventListener('click', () => setLayout(meeting.id, 'split'));
    document.getElementById('mr-btn-focus').addEventListener('click', () => setLayout(meeting.id, 'focus'));
    document.getElementById('mr-btn-add-sub').addEventListener('click', () => showAddSubMenu(meeting.id));

    // Title rename on double-click
    const titleSpan = document.getElementById('mr-title');
    titleSpan.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = meeting.title;
      input.className = 'mr-header-title';
      input.style.cssText = 'border:1px solid var(--accent);border-radius:4px;padding:2px 6px;background:var(--bg-primary);color:var(--text-primary);font-size:14px;font-weight:600;outline:none;';
      titleSpan.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const trimmed = input.value.trim();
        if (trimmed && trimmed !== meeting.title) {
          meeting.title = trimmed;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { title: trimmed } });
        }
        const newSpan = document.createElement('span');
        newSpan.className = 'mr-header-title';
        newSpan.id = 'mr-title';
        newSpan.textContent = meeting.title;
        input.replaceWith(newSpan);
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = meeting.title; input.blur(); }
      });
    });
  }

  // --- Add Sub-Session Menu ---

  function showAddSubMenu(meetingId) {
    const meeting = meetingData[meetingId];
    if (!meeting || meeting.subSessions.length >= 3) return;

    const btn = document.getElementById('mr-btn-add-sub');
    const rect = btn.getBoundingClientRect();

    // Remove existing menu if any
    const old = document.getElementById('mr-add-sub-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'mr-add-sub-menu';
    menu.className = 'mr-quote-menu';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';

    const kinds = [
      { kind: 'claude', label: 'Claude Code' },
      { kind: 'gemini', label: 'Gemini CLI' },
      { kind: 'powershell', label: 'PowerShell' },
    ];

    for (const { kind, label } of kinds) {
      const item = document.createElement('button');
      item.className = 'mr-quote-menu-item';
      item.textContent = label;
      item.addEventListener('click', async () => {
        menu.remove();
        const result = await ipcRenderer.invoke('add-meeting-sub', { meetingId, kind });
        if (result && result.meeting) {
          meetingData[meetingId] = result.meeting;
          renderTerminals(result.meeting);
          renderToolbar(result.meeting);
        }
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // --- Terminal Rendering (Split Mode) ---

  function renderTerminals(meeting) {
    const container = terminalsEl();
    if (!container) return;
    container.innerHTML = '';
    container.className = meeting.layout === 'focus' ? 'mr-terminals focus-mode' : 'mr-terminals';

    subTerminals = {};

    if (meeting.layout === 'focus') {
      renderFocusMode(meeting, container);
      return;
    }

    // Split mode: equal-width slots for each sub-session + empty slots
    for (const sessionId of meeting.subSessions) {
      const slot = createSubSlot(meeting, sessionId);
      container.appendChild(slot);
    }

    // Empty slots
    for (let i = meeting.subSessions.length; i < 3; i++) {
      const empty = document.createElement('div');
      empty.className = 'mr-empty-slot';
      empty.innerHTML = '<div class="mr-empty-slot-icon">+</div><div class="mr-empty-slot-text">点击添加子会话</div>';
      empty.addEventListener('click', () => showAddSubMenu(meeting.id));
      container.appendChild(empty);
    }

    // Fit all terminals after layout settles
    requestAnimationFrame(() => {
      for (const sessionId of meeting.subSessions) {
        fitSubTerminal(sessionId);
      }
    });
  }

  function createSubSlot(meeting, sessionId) {
    const session = sessionsRef ? sessionsRef.get(sessionId) : null;
    const isDormant = session && session.status === 'dormant';
    const isSelected = meeting.sendTarget === sessionId;
    const kindLabel = session ? (session.kind || 'session') : 'session';

    const slot = document.createElement('div');
    slot.className = 'mr-sub-slot' + (isSelected ? ' selected' : '') + (isDormant ? ' dormant' : '');
    slot.dataset.sessionId = sessionId;

    // Sub-header
    const header = document.createElement('div');
    header.className = 'mr-sub-header';
    header.innerHTML = `
      <span class="mr-sub-label">${escapeHtml(kindLabel.charAt(0).toUpperCase() + kindLabel.slice(1))}</span>
      <button class="mr-sub-close" title="关闭此会话">✕</button>
    `;

    // Click header to select target
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('mr-sub-close')) return;
      const newTarget = meeting.sendTarget === sessionId ? 'all' : sessionId;
      meeting.sendTarget = newTarget;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: newTarget } });
      renderTerminals(meeting);
      renderToolbar(meeting);
    });

    // Close button
    header.querySelector('.mr-sub-close').addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('remove-meeting-sub', { meetingId: meeting.id, sessionId });
      if (result) {
        meetingData[meeting.id] = result;
        renderTerminals(result);
        renderToolbar(result);
      }
    });

    slot.appendChild(header);

    // Terminal container
    const termContainer = document.createElement('div');
    termContainer.className = 'mr-sub-terminal';
    slot.appendChild(termContainer);

    // Mount xterm if session is alive
    if (!isDormant && getOrCreateTerminalFn) {
      const cached = getOrCreateTerminalFn(sessionId);
      if (cached && cached.container) {
        cached.container.style.display = 'block';
        termContainer.appendChild(cached.container);
        subTerminals[sessionId] = cached;
      }
    }

    // Right-click for quoting
    slot.addEventListener('contextmenu', (e) => {
      handleQuoteContext(e, meeting, sessionId);
    });

    return slot;
  }

  function fitSubTerminal(sessionId) {
    const cached = subTerminals[sessionId];
    if (!cached || !cached.fitAddon) return;
    try {
      cached.fitAddon.fit();
      ipcRenderer.send('terminal-resize', {
        sessionId,
        cols: cached.terminal.cols,
        rows: cached.terminal.rows,
      });
    } catch (_) {}
  }

  // --- Focus Mode ---

  function renderFocusMode(meeting, container) {
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (!focused) return;

    // Main terminal (full width)
    const mainSlot = createSubSlot(meeting, focused);
    mainSlot.style.flex = '1';
    container.appendChild(mainSlot);

    // Preview bar for non-focused sessions
    const others = meeting.subSessions.filter(id => id !== focused);
    if (others.length > 0) {
      const bar = document.createElement('div');
      bar.className = 'mr-preview-bar';

      for (const otherId of others) {
        const session = sessionsRef ? sessionsRef.get(otherId) : null;
        const label = session ? session.kind : 'session';

        const item = document.createElement('div');
        item.className = 'mr-preview-item';
        item.innerHTML = `
          <span class="mr-preview-label">${escapeHtml(label)}</span>
          <div class="mr-preview-text" id="mr-preview-${otherId}">Loading...</div>
        `;

        item.addEventListener('click', () => {
          meeting.focusedSub = otherId;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { focusedSub: otherId } });
          renderTerminals(meeting);
        });

        bar.appendChild(item);

        // Load preview from ring buffer
        ipcRenderer.invoke('get-ring-buffer', otherId).then(buf => {
          const previewEl = document.getElementById(`mr-preview-${otherId}`);
          if (previewEl && buf) {
            const lines = buf.replace(/\r/g, '').split('\n');
            previewEl.textContent = lines.slice(-4).join('\n');
          } else if (previewEl) {
            previewEl.textContent = '(no output)';
          }
        });
      }

      container.appendChild(bar);
    }

    requestAnimationFrame(() => fitSubTerminal(focused));
  }

  // --- Layout Toggle ---

  function setLayout(meetingId, layout) {
    const meeting = meetingData[meetingId];
    if (!meeting) return;
    meeting.layout = layout;
    if (layout === 'focus' && !meeting.focusedSub) {
      meeting.focusedSub = meeting.subSessions[0] || null;
    }
    ipcRenderer.send('update-meeting', { meetingId, fields: { layout, focusedSub: meeting.focusedSub } });
    renderHeader(meeting);
    renderTerminals(meeting);
  }

  // --- Toolbar ---

  function renderToolbar(meeting) {
    const el = toolbarEl();
    if (!el) return;

    // Build target options
    let optionsHtml = '<option value="all">全部</option>';
    for (const sid of meeting.subSessions) {
      const session = sessionsRef ? sessionsRef.get(sid) : null;
      const label = session ? (session.kind || sid) : sid;
      const sel = meeting.sendTarget === sid ? ' selected' : '';
      optionsHtml += `<option value="${sid}"${sel}>${escapeHtml(label)}</option>`;
    }

    el.innerHTML = `
      <label>发送到: <select class="mr-target-select" id="mr-target-select">${optionsHtml}</select></label>
      <div class="mr-sync-toggle ${meeting.syncContext ? 'active' : ''}" id="mr-sync-toggle">
        <span>自动同步: ${meeting.syncContext ? '开' : '关'}</span>
      </div>
    `;

    document.getElementById('mr-target-select').addEventListener('change', (e) => {
      meeting.sendTarget = e.target.value;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: meeting.sendTarget } });
      renderTerminals(meeting);
    });

    document.getElementById('mr-sync-toggle').addEventListener('click', () => {
      meeting.syncContext = !meeting.syncContext;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { syncContext: meeting.syncContext } });
      renderToolbar(meeting);
    });
  }

  // --- Input & Broadcasting ---

  function setupInput(meeting) {
    const inputBox = inputBoxEl();
    const sendBtn = sendBtnEl();
    if (!inputBox || !sendBtn) return;

    inputBox.textContent = '';

    const doSend = () => {
      const text = inputBox.textContent.trim();
      if (!text) return;
      handleMeetingSend(text, meeting);
      inputBox.textContent = '';
    };

    // Remove old listeners by cloning
    const newSendBtn = sendBtn.cloneNode(true);
    sendBtn.replaceWith(newSendBtn);
    newSendBtn.addEventListener('click', doSend);

    const newInputBox = inputBox.cloneNode(true);
    inputBox.replaceWith(newInputBox);
    newInputBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = newInputBox.textContent.trim();
        if (!text) return;
        handleMeetingSend(text, meeting);
        newInputBox.textContent = '';
      }
    });
  }

  async function handleMeetingSend(text, meeting) {
    const targets = meeting.sendTarget === 'all'
      ? meeting.subSessions.filter(sid => {
          const s = sessionsRef ? sessionsRef.get(sid) : null;
          return s && s.status !== 'dormant';
        })
      : [meeting.sendTarget];

    for (const sessionId of targets) {
      let payload = text;
      if (meeting.syncContext) {
        const context = await buildContextSummary(meeting, sessionId);
        payload = context + payload;
      }
      ipcRenderer.send('terminal-input', { sessionId, data: payload + '\r' });
    }

    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  }

  async function buildContextSummary(meeting, excludeSessionId) {
    const others = meeting.subSessions.filter(id => id !== excludeSessionId);
    if (others.length === 0) return '';

    const lines = [];
    for (const id of others) {
      const session = sessionsRef ? sessionsRef.get(id) : null;
      const label = session ? (session.kind || 'session') : 'session';
      const buf = await ipcRenderer.invoke('get-ring-buffer', id);
      if (buf) {
        const truncated = buf.slice(-500).replace(/\r/g, '').trim();
        const summary = truncated.length > 200 ? truncated.slice(-200) : truncated;
        lines.push(`- ${label}: ${summary}`);
      }
    }

    if (lines.length === 0) return '';
    return `[会议室上下文] 其他参会者最近的发言：\n${lines.join('\n')}\n---\n`;
  }

  // --- Quote (Right-click) ---

  function handleQuoteContext(e, meeting, sourceSessionId) {
    const cached = subTerminals[sourceSessionId];
    if (!cached || !cached.terminal) return;

    const selection = cached.terminal.getSelection();
    if (!selection) return;

    e.preventDefault();

    // Remove old menu
    const old = document.getElementById('mr-quote-context-menu');
    if (old) old.remove();

    const others = meeting.subSessions.filter(id => id !== sourceSessionId);
    if (others.length === 0) return;

    const sourceSession = sessionsRef ? sessionsRef.get(sourceSessionId) : null;
    const sourceLabel = sourceSession ? sourceSession.kind : 'session';

    const menu = document.createElement('div');
    menu.id = 'mr-quote-context-menu';
    menu.className = 'mr-quote-menu';
    menu.style.top = e.clientY + 'px';
    menu.style.left = e.clientX + 'px';

    for (const targetId of others) {
      const targetSession = sessionsRef ? sessionsRef.get(targetId) : null;
      const targetLabel = targetSession ? targetSession.kind : 'session';
      const item = document.createElement('button');
      item.className = 'mr-quote-menu-item';
      item.textContent = `引用到 ${targetLabel}`;
      item.addEventListener('click', () => {
        menu.remove();
        const inputBox = document.getElementById('mr-input-box');
        if (inputBox) {
          inputBox.textContent = `> [来自 ${sourceLabel}] ${selection}\n`;
          // Place cursor at end
          const range = document.createRange();
          range.selectNodeContents(inputBox);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        // Switch send target
        meeting.sendTarget = targetId;
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: targetId } });
        renderToolbar(meeting);
        renderTerminals(meeting);
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // --- Helpers ---

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Expose global ---

  window.MeetingRoom = {
    init,
    openMeeting,
    closeMeetingPanel,
    getActiveMeetingId,
    getMeetingData,
    updateMeetingData,
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(meeting): add meeting room renderer — split/focus, broadcast, quoting"
```

---

## Task 7: Sidebar integration in `renderer/renderer.js`

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: Add meeting state variables**

Find `let activeTeamRoomId = null;` (around line 455). After it, add:

```javascript
let activeMeetingId = null;
let meetings = {};  // { meetingId: meetingObj }
```

- [ ] **Step 2: Initialize MeetingRoom module**

Find the area where `ipcRenderer.on('session-created', ...)` handlers are set up (around line 2356). Before the first `ipcRenderer.on(...)` call, add:

```javascript
// Initialize MeetingRoom module with shared references
if (typeof MeetingRoom !== 'undefined') {
  MeetingRoom.init(sessions, getOrCreateTerminal);
}
```

- [ ] **Step 3: Add meeting items to `renderSessionList()`**

In `renderSessionList()` (line 337), find `const all = regularSessions.concat(teamItems);` (line 364). Replace with:

```javascript
const meetingItems = Object.values(meetings).map(m => ({
  id: m.id,
  title: m.title,
  lastMessageTime: m.lastMessageTime,
  createdAt: m.createdAt,
  lastOutputPreview: `${m.subSessions.length} 个子会话`,
  status: m.status || 'idle',
  unreadCount: 0,
  pinned: m.pinned,
  _isMeeting: true,
  _meeting: m,
}));

const all = regularSessions.concat(teamItems).concat(meetingItems);
```

- [ ] **Step 4: Render meeting items in the session list loop**

In the `for (const s of visible)` loop (starting around line 393), after the team room rendering block (which ends with `continue;` at line 411), add the meeting rendering block:

```javascript
if (s._isMeeting) {
  const isActive = activeMeetingId === s.id;
  const div = document.createElement('div');
  div.className = 'session-item meeting' + (isActive ? ' selected' : '');
  div.innerHTML = `
    <div class="session-item-header">
      <span class="session-title">${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}<span class="session-status running"></span>🏢 ${escapeHtml(s.title)}<span class="meeting-badge">${s._meeting.subSessions.length}</span></span>
      <span class="session-header-right">
        <span class="session-time">${formatTime(s.lastMessageTime)}</span>
      </span>
    </div>
    <div class="session-preview">${escapeHtml(s.lastOutputPreview)}</div>
  `;
  div.addEventListener('click', () => selectMeeting(s.id));
  div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY, false, true); });
  sessionListEl.appendChild(div);
  continue;
}
```

- [ ] **Step 5: Add `selectMeeting()` function**

After `selectTeamRoom()` (around line 535), add:

```javascript
function selectMeeting(meetingId) {
  activeSessionId = null;
  activeTeamRoomId = null;
  activeMeetingId = meetingId;

  // Hide other panels
  if (terminalPanelEl) terminalPanelEl.style.display = 'none';
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  const trp = document.getElementById('team-room-panel');
  if (trp) trp.style.display = 'none';

  const meeting = meetings[meetingId];
  if (meeting && typeof MeetingRoom !== 'undefined') {
    // Wake dormant sub-sessions
    if (meeting.status === 'dormant') {
      meeting.status = 'idle';
      for (const sid of meeting.subSessions) {
        const s = sessions.get(sid);
        if (s && s.status === 'dormant') {
          resumeDormantSession(sid);
        }
      }
    }
    MeetingRoom.openMeeting(meetingId, meeting);
  }

  renderSessionList();
}
```

- [ ] **Step 6: Handle `selectSession()` — hide meeting panel**

In `selectSession()` (line 1039), find `const trp = document.getElementById('team-room-panel');` (line 1047). After `if (trp) trp.style.display = 'none';`, add:

```javascript
activeMeetingId = null;
const mrp = document.getElementById('meeting-room-panel');
if (mrp) mrp.style.display = 'none';
```

Also update `selectTeamRoom()` (line 521) similarly: after `activeSessionId = null;` add `activeMeetingId = null;` and hide the meeting panel.

- [ ] **Step 7: Handle "meeting" in the menu click handler**

Find the menu click handler (line 1105-1113). Replace:

```javascript
for (const btn of document.querySelectorAll('.new-session-option')) {
  btn.addEventListener('click', async () => {
    menuEl.style.display = 'none';
    if (btn.dataset.kind === 'team-room') {
      openCreateRoomModal();
      return;
    }
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}
```

With:

```javascript
for (const btn of document.querySelectorAll('.new-session-option')) {
  btn.addEventListener('click', async () => {
    menuEl.style.display = 'none';
    if (btn.dataset.kind === 'team-room') {
      openCreateRoomModal();
      return;
    }
    if (btn.dataset.kind === 'meeting') {
      const meeting = await ipcRenderer.invoke('create-meeting');
      if (meeting) {
        meetings[meeting.id] = meeting;
        selectMeeting(meeting.id);
        renderSessionList();
        schedulePersist();
      }
      return;
    }
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}
```

- [ ] **Step 8: Handle IPC events for meetings**

At the end of `renderer.js`, before the mobile pairing init, add:

```javascript
// --- Meeting Room IPC events ---
ipcRenderer.on('meeting-created', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  renderSessionList();
});

ipcRenderer.on('meeting-updated', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  if (typeof MeetingRoom !== 'undefined') {
    MeetingRoom.updateMeetingData(meeting.id, meeting);
  }
  renderSessionList();
});

ipcRenderer.on('meeting-closed', (_e, { meetingId }) => {
  delete meetings[meetingId];
  if (activeMeetingId === meetingId) {
    activeMeetingId = null;
    if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel();
    if (emptyStateEl) emptyStateEl.style.display = '';
  }
  renderSessionList();
});

// Load dormant meetings on boot
ipcRenderer.invoke('get-dormant-meetings').then((list) => {
  if (Array.isArray(list)) {
    for (const m of list) {
      meetings[m.id] = m;
    }
    renderSessionList();
  }
}).catch(() => {});
```

- [ ] **Step 9: Extend `schedulePersist()` to include meetings**

Find `schedulePersist()` (line 2422). After the `list.push({...})` loop (which pushes claude sessions), add meeting persistence:

Replace the `ipcRenderer.send('persist-sessions', list);` line with:

```javascript
// Also persist meeting data alongside sub-session references
const meetingList = Object.values(meetings).map(m => ({
  id: m.id,
  type: 'meeting',
  title: m.title,
  subSessions: m.subSessions,
  layout: m.layout,
  focusedSub: m.focusedSub,
  syncContext: m.syncContext,
  sendTarget: m.sendTarget,
  createdAt: m.createdAt,
  lastMessageTime: m.lastMessageTime,
  pinned: m.pinned || false,
}));
ipcRenderer.send('persist-sessions', list);
ipcRenderer.send('persist-meetings', meetingList);
```

- [ ] **Step 10: Add persist-meetings IPC handler in main.js**

In `main.js`, after the `persist-sessions` handler, add:

```javascript
ipcRenderer.on('persist-meetings', (_e, list) => {
  // Handled via persist-sessions's meetings field
});
```

Wait — actually this should be done in main.js. Let me revise: instead of a separate IPC, update the `persist-sessions` handler in main.js to also include meetings. Actually, we already did this in Task 3 Step 5. The `schedulePersist` just needs to include the meeting data in the persist-sessions payload.

Revised approach: Change `schedulePersist()` to send meetings alongside sessions:

```javascript
ipcRenderer.send('persist-sessions', list, Object.values(meetings).map(m => ({
  id: m.id, type: 'meeting', title: m.title, subSessions: m.subSessions,
  layout: m.layout, focusedSub: m.focusedSub, syncContext: m.syncContext,
  sendTarget: m.sendTarget, createdAt: m.createdAt, lastMessageTime: m.lastMessageTime,
  pinned: m.pinned || false,
})));
```

And update the `persist-sessions` handler in `main.js`:

```javascript
ipcMain.on('persist-sessions', (_e, list, meetingList) => {
  if (!Array.isArray(list)) return;
  lastPersistedSessions = list;
  stateStore.save({
    version: 1,
    cleanShutdown: false,
    sessions: list,
    meetings: Array.isArray(meetingList) ? meetingList : meetingManager.getAllMeetings(),
  });
});
```

- [ ] **Step 11: Also persist sub-sessions that belong to meetings in `schedulePersist()`**

Currently `schedulePersist()` skips non-Claude sessions. Sub-sessions can be gemini/powershell. Change the filter:

Find this line in `schedulePersist()`:
```javascript
if (s.kind !== 'claude' && s.kind !== 'claude-resume') continue;
```

Replace with:
```javascript
if (!s.meetingId && s.kind !== 'claude' && s.kind !== 'claude-resume') continue;
```

This ensures sub-sessions of any kind get persisted when they belong to a meeting.

- [ ] **Step 12: Extend context-menu handler for meetings**

Find the `openContextMenu` function. Add a meeting-aware branch: when the context menu is opened on a meeting item, the "Close" action should call `close-meeting` IPC.

In the context menu action handler, find `} else if (action === 'close') {` and add a meeting check:

```javascript
} else if (action === 'close') {
  if (meetings[sid]) {
    await ipcRenderer.invoke('close-meeting', sid);
    delete meetings[sid];
    if (activeMeetingId === sid) {
      activeMeetingId = null;
      if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel();
      if (emptyStateEl) emptyStateEl.style.display = '';
    }
    renderSessionList();
    schedulePersist();
  } else if (session.status === 'dormant') {
```

- [ ] **Step 13: Smoke test**

Run: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20`

Expected: Hub launches without JS errors. The "+" menu should now show "🏢 会议室".

- [ ] **Step 14: Commit**

```bash
git add renderer/renderer.js renderer/meeting-room.js
git commit -m "feat(meeting): integrate meeting room into sidebar, menu, and panel switching"
```

---

## Task 8: State store compatibility

**Files:**
- Modify: `core/state-store.js`

- [ ] **Step 1: Ensure `meetings` array survives save/load**

The current `state-store.js` is generic JSON — it saves whatever object it receives. The `load()` function only validates `sessions` array. Add meetings validation:

In `load()`, after `if (!Array.isArray(parsed.sessions)) parsed.sessions = [];`, add:

```javascript
if (!Array.isArray(parsed.meetings)) parsed.meetings = [];
```

In `defaultState()`, add meetings:

```javascript
function defaultState() {
  return { version: CURRENT_VERSION, cleanShutdown: true, sessions: [], meetings: [] };
}
```

- [ ] **Step 2: Commit**

```bash
git add core/state-store.js
git commit -m "feat(meeting): extend state store to persist meetings array"
```

---

## Task 9: End-to-end smoke test

**Files:** (no new files — manual verification)

- [ ] **Step 1: Launch Hub and create a meeting**

Start Hub: `./node_modules/electron/dist/electron.exe .`

1. Click "+" → "🏢 会议室"
2. Verify: meeting room panel appears with empty slots
3. Verify: sidebar shows "🏢 会议室-1 [0]"

- [ ] **Step 2: Add sub-sessions**

1. Click "+ 添加" → "Claude Code"
2. Verify: Claude session starts in the first slot
3. Click "+ 添加" → "PowerShell"
4. Verify: PowerShell appears in the second slot, side by side

- [ ] **Step 3: Test broadcast**

1. In the input box, type a message
2. With "发送到: 全部", press Enter
3. Verify: message appears in both terminals

- [ ] **Step 4: Test targeted send**

1. Click a sub-session header to select it
2. Verify: header gets highlighted, dropdown switches to that session
3. Type and send — verify only that session receives input

- [ ] **Step 5: Test Focus mode**

1. Click "Focus" button in header
2. Verify: one terminal goes full-width, others show as preview bar
3. Click a preview to switch focused terminal

- [ ] **Step 6: Test persistence**

1. Close Hub
2. Reopen Hub
3. Verify: meeting appears as dormant in sidebar
4. Click it — sub-sessions should resume

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix(meeting): smoke test fixes"
```

---

## Summary

| Task | What | Files | Estimated |
|------|------|-------|-----------|
| 1 | Core module | `core/meeting-room.js` (new) | 3 min |
| 2 | meetingId field | `core/session-manager.js` | 2 min |
| 3 | Main IPC handlers | `main.js` | 5 min |
| 4 | HTML structure | `renderer/index.html` | 3 min |
| 5 | CSS styles | `renderer/meeting-room.css` (new) | 3 min |
| 6 | Renderer UI engine | `renderer/meeting-room.js` (new) | 10 min |
| 7 | Sidebar integration | `renderer/renderer.js` | 10 min |
| 8 | State store compat | `core/state-store.js` | 2 min |
| 9 | E2E smoke test | manual | 5 min |
