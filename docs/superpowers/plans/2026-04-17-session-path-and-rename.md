# Session Path And Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-configured default working directory, editable per-session cwd in the header, and GUI-based session renaming via context menu plus double-click inline editing.

**Architecture:** Keep the current Electron main/renderer/session-manager split. Add one small config module for the JSON-backed default path, extend `SessionManager` with explicit cwd mutation, and reuse existing IPC/update flows so renderer state stays synchronized through `session-updated` rather than ad hoc local patches.

**Tech Stack:** Electron, Node.js, `node-pty`, plain renderer DOM logic, existing `assert`-based Node tests.

---

## File Map

**Create:**
- `config/session-hub.json` — project-local default working directory config file.
- `core/app-config.js` — loads and validates `config/session-hub.json`.
- `tests/test-app-config.js` — verifies config loading and fallback behavior.
- `tests/test-session-cwd.js` — verifies `SessionManager.changeSessionCwd()` semantics.

**Modify:**
- `main.js` — load app config, pass default cwd into session creation, add `set-session-cwd` IPC.
- `core/session-manager.js` — support injected default cwd provider and per-session cwd mutation.
- `renderer/index.html` — add `Rename session` item to the context menu.
- `renderer/renderer.js` — add editable cwd UI, context-menu rename entry, and shared rename/cwd edit helpers.
- `renderer/styles.css` — style cwd editor and sidebar inline rename affordances.
- `test-e2e.js` — add one high-level smoke assertion for the new context menu rename label if practical with existing harness.

**Existing tests to follow as examples:**
- `tests/mobile/test-ring-buffer.js`
- `tests/mobile/test-rest.js`
- `tests/mobile/test-ws.js`

---

### Task 1: Add JSON-backed app config loader

**Files:**
- Create: `config/session-hub.json`
- Create: `core/app-config.js`
- Create: `tests/test-app-config.js`
- Modify: `package.json`

- [ ] **Step 1: Create the default config file**

```json
{
  "defaultWorkingDirectory": "D:\\ClaudeWorkspace"
}
```

Write it to `config/session-hub.json`.

- [ ] **Step 2: Write the failing config-loader test**

Create `tests/test-app-config.js` with:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadAppConfig, getDefaultWorkingDirectory } = require('../core/app-config.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-'));
const goodDir = path.join(tempRoot, 'workspace');
fs.mkdirSync(goodDir, { recursive: true });

const goodConfigPath = path.join(tempRoot, 'session-hub.json');
fs.writeFileSync(goodConfigPath, JSON.stringify({ defaultWorkingDirectory: goodDir }, null, 2));

const loaded = loadAppConfig({ configPath: goodConfigPath, fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(loaded.defaultWorkingDirectory, goodDir, 'should use configured existing directory');

const missing = loadAppConfig({ configPath: path.join(tempRoot, 'missing.json'), fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(missing.defaultWorkingDirectory, 'C:\\fallback', 'should fall back when config file is missing');

const badConfigPath = path.join(tempRoot, 'bad.json');
fs.writeFileSync(badConfigPath, '{bad json');
const bad = loadAppConfig({ configPath: badConfigPath, fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(bad.defaultWorkingDirectory, 'C:\\fallback', 'should fall back when JSON is invalid');

const nonexistentConfigPath = path.join(tempRoot, 'nonexistent.json');
fs.writeFileSync(nonexistentConfigPath, JSON.stringify({ defaultWorkingDirectory: 'Z:\\definitely-missing' }, null, 2));
const nonexistent = getDefaultWorkingDirectory({ configPath: nonexistentConfigPath, fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(nonexistent, 'C:\\fallback', 'should fall back when configured directory does not exist');

console.log('OK test-app-config');
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
node tests/test-app-config.js
```

Expected: FAIL with `Cannot find module '../core/app-config.js'`.

- [ ] **Step 4: Write the minimal config loader**

Create `core/app-config.js` with:

```js
const fs = require('fs');
const path = require('path');

function directoryExists(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function loadAppConfig({
  configPath = path.join(__dirname, '..', 'config', 'session-hub.json'),
  fallbackDirectory = process.env.USERPROFILE || process.env.HOME || '.',
} = {}) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    parsed = {};
  }

  const configured = parsed && typeof parsed.defaultWorkingDirectory === 'string'
    ? parsed.defaultWorkingDirectory.trim()
    : '';

  return {
    defaultWorkingDirectory: directoryExists(configured) ? configured : fallbackDirectory,
  };
}

function getDefaultWorkingDirectory(opts = {}) {
  return loadAppConfig(opts).defaultWorkingDirectory;
}

module.exports = {
  loadAppConfig,
  getDefaultWorkingDirectory,
  directoryExists,
};
```

- [ ] **Step 5: Run the config test to verify it passes**

Run:

```bash
node tests/test-app-config.js
```

Expected: PASS and print `OK test-app-config`.

- [ ] **Step 6: Add the new test script entry**

In `package.json`, update the scripts block from:

```json
"scripts": {
  "start": "electron .",
  "test": "node test-e2e.js",
```

to:

```json
"scripts": {
  "start": "electron .",
  "test": "node test-e2e.js",
  "test:config": "node tests/test-app-config.js",
  "test:session-cwd": "node tests/test-session-cwd.js",
```

- [ ] **Step 7: Commit**

```bash
git add config/session-hub.json core/app-config.js tests/test-app-config.js package.json
git commit -m "feat: load default session cwd from project config"
```

---

### Task 2: Add session cwd mutation in SessionManager

**Files:**
- Modify: `core/session-manager.js`
- Create: `tests/test-session-cwd.js`

- [ ] **Step 1: Write the failing session cwd test**

Create `tests/test-session-cwd.js` with:

```js
const assert = require('assert');
const { SessionManager } = require('../core/session-manager.js');

const writes = [];
const sm = new SessionManager({ getDefaultCwd: () => 'D:\\ClaudeWorkspace' });

sm.sessions.set('ps', {
  info: {
    id: 'ps',
    title: 'PowerShell 1',
    kind: 'powershell',
    cwd: 'C:\\Users\\InBlu',
    unreadCount: 0,
    lastMessageTime: Date.now(),
    lastOutputPreview: '',
  },
  pty: { write: (data) => writes.push(data), resize() {}, kill() {} },
  pendingTimers: [],
  ringBuffer: '',
});

sm.sessions.set('claude', {
  info: {
    id: 'claude',
    title: 'Claude 1',
    kind: 'claude',
    cwd: 'C:\\Users\\InBlu',
    unreadCount: 0,
    lastMessageTime: Date.now(),
    lastOutputPreview: '',
  },
  pty: { write: () => { throw new Error('claude PTY should not receive cwd command'); }, resize() {}, kill() {} },
  pendingTimers: [],
  ringBuffer: '',
});

const psUpdated = sm.changeSessionCwd('ps', 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(psUpdated.cwd, 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(writes.length, 1, 'powershell session should receive exactly one cwd command');
assert.strictEqual(writes[0], "Set-Location -LiteralPath 'D:\\ClaudeWorkspace\\Code'\r\n");

const claudeUpdated = sm.changeSessionCwd('claude', 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(claudeUpdated.cwd, 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(writes.length, 1, 'claude session should not write to PTY');

const created = sm.createSession('powershell');
assert.strictEqual(created.cwd, 'D:\\ClaudeWorkspace', 'createSession should use injected default cwd');

console.log('OK test-session-cwd');
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node tests/test-session-cwd.js
```

Expected: FAIL with `sm.changeSessionCwd is not a function` or constructor mismatch.

- [ ] **Step 3: Extend SessionManager constructor and createSession**

In `core/session-manager.js`, replace the constructor with:

```js
  constructor({ getDefaultCwd } = {}) {
    super();
    this.getDefaultCwd = typeof getDefaultCwd === 'function'
      ? getDefaultCwd
      : () => (process.env.USERPROFILE || process.env.HOME || '.');
  }
```

Then replace the cwd fallback block inside `createSession()`:

```js
    let spawnCwd = opts.cwd;
    if (spawnCwd) {
      try { require('fs').accessSync(spawnCwd); } catch { spawnCwd = null; }
    }
    if (!spawnCwd) spawnCwd = process.env.USERPROFILE || process.env.HOME || '.';
```

with:

```js
    let spawnCwd = opts.cwd;
    if (spawnCwd) {
      try { require('fs').accessSync(spawnCwd); } catch { spawnCwd = null; }
    }
    if (!spawnCwd) {
      const configured = this.getDefaultCwd();
      try {
        require('fs').accessSync(configured);
        spawnCwd = configured;
      } catch {
        spawnCwd = process.env.USERPROFILE || process.env.HOME || '.';
      }
    }
```

- [ ] **Step 4: Add `changeSessionCwd()` minimal implementation**

Insert this method before `dispose()` in `core/session-manager.js`:

```js
  changeSessionCwd(sessionId, cwd) {
    const session = this.sessions.get(sessionId);
    if (!session || !cwd) return undefined;

    session.info.cwd = cwd;

    if (session.info.kind === 'powershell' && session.pty) {
      const escaped = cwd.replace(/'/g, "''");
      session.pty.write(`Set-Location -LiteralPath '${escaped}'\r\n`);
    }

    const publicInfo = this._toPublic(session.info);
    this.emit('session-updated', publicInfo);
    return publicInfo;
  }
```

- [ ] **Step 5: Run the session cwd test to verify it passes**

Run:

```bash
node tests/test-session-cwd.js
```

Expected: PASS and print `OK test-session-cwd`.

- [ ] **Step 6: Run the existing ring buffer test for regression coverage**

Run:

```bash
node tests/mobile/test-ring-buffer.js
```

Expected: PASS and print `OK test-ring-buffer`.

- [ ] **Step 7: Commit**

```bash
git add core/session-manager.js tests/test-session-cwd.js package.json
git commit -m "feat: support configurable session cwd behavior"
```

---

### Task 3: Wire config and cwd editing through the main process

**Files:**
- Modify: `main.js`
- Test: `tests/test-app-config.js`
- Test: `tests/test-session-cwd.js`

- [ ] **Step 1: Add the failing integration assertion by exercising the IPC target indirectly**

Append this block to `tests/test-session-cwd.js` after the existing assertions:

```js
let emitted = null;
sm.on('session-updated', (payload) => { emitted = payload; });
sm.changeSessionCwd('ps', 'D:\\ClaudeWorkspace\\Documents');
assert.ok(emitted, 'changeSessionCwd should emit session-updated');
assert.strictEqual(emitted.cwd, 'D:\\ClaudeWorkspace\\Documents');
```

- [ ] **Step 2: Run the session cwd test to verify the new assertion fails or is unproven**

Run:

```bash
node tests/test-session-cwd.js
```

Expected: FAIL if the event payload is missing or no emission occurs.

- [ ] **Step 3: Load app config in `main.js` and inject default cwd provider**

At the import section in `main.js`, add:

```js
const appConfig = require('./core/app-config.js');
```

Then replace:

```js
const sessionManager = new SessionManager();
```

with:

```js
const sessionManager = new SessionManager({
  getDefaultCwd: () => appConfig.getDefaultWorkingDirectory(),
});
```

- [ ] **Step 4: Add `set-session-cwd` IPC handler**

In `main.js`, after the existing `rename-session` handler, add:

```js
ipcMain.handle('set-session-cwd', (_e, { sessionId, cwd }) => {
  const nextCwd = typeof cwd === 'string' ? cwd.trim() : '';
  if (!nextCwd) return { error: 'empty cwd' };
  try {
    const st = fs.statSync(nextCwd);
    if (!st.isDirectory()) return { error: 'cwd is not a directory' };
  } catch {
    return { error: 'cwd does not exist' };
  }

  const session = sessionManager.changeSessionCwd(sessionId, nextCwd);
  if (session) sendToRenderer('session-updated', { session });
  return session || { error: 'session not found' };
});
```

- [ ] **Step 5: Run targeted tests to verify wiring still passes**

Run:

```bash
node tests/test-app-config.js && node tests/test-session-cwd.js
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add main.js tests/test-session-cwd.js
git commit -m "feat: wire cwd config and session cwd IPC"
```

---

### Task 4: Add GUI rename entry to the context menu

**Files:**
- Modify: `renderer/index.html`
- Modify: `renderer/renderer.js`
- Modify: `renderer/styles.css`
- Test: `test-e2e.js`

- [ ] **Step 1: Add the rename action to the sidebar context menu markup**

In `renderer/index.html`, replace:

```html
<div class="context-menu" id="context-menu" style="display:none">
  <button class="context-menu-item" data-action="pin">Pin to top</button>
  <button class="context-menu-item" data-action="restart">Restart session</button>
  <button class="context-menu-item danger" data-action="close">Close</button>
</div>
```

with:

```html
<div class="context-menu" id="context-menu" style="display:none">
  <button class="context-menu-item" data-action="pin">Pin to top</button>
  <button class="context-menu-item" data-action="rename">Rename session</button>
  <button class="context-menu-item" data-action="restart">Restart session</button>
  <button class="context-menu-item danger" data-action="close">Close</button>
</div>
```

- [ ] **Step 2: Add a failing E2E smoke check for the menu label**

In `test-e2e.js`, add one assertion that the renderer HTML contains `data-action="rename"` or `Rename session`, following the file's existing style. Use:

```js
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname, 'renderer', 'index.html'), 'utf8');
if (!html.includes('data-action="rename"')) {
  throw new Error('missing Rename session context menu item');
}
```

Place it near other static smoke checks rather than inventing a new test harness.

- [ ] **Step 3: Run the E2E smoke test to verify it fails before logic is complete**

Run:

```bash
node test-e2e.js
```

Expected: FAIL with `missing Rename session context menu item`.

- [ ] **Step 4: Route the new menu action through existing rename logic**

In `renderer/renderer.js`, inside the context-menu action handler block around `for (const btn of contextMenuEl.querySelectorAll('.context-menu-item'))`, add a `rename` case:

```js
    if (action === 'rename') {
      const row = sessionListEl.querySelector(`.session-item[data-id="${sid}"] .session-title`);
      hideContextMenu();
      if (row) startRename(sid, row);
      return;
    }
```

Keep the existing `pin`, `restart`, and `close` behavior unchanged.

- [ ] **Step 5: Add a minor style hook if needed for active inline title editing**

In `renderer/styles.css`, add a focused input style for the existing `terminal-title-input` class if none exists, e.g.:

```css
.terminal-title-input {
  background: #161b22;
  color: #f0f6fc;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 2px 8px;
}

.terminal-title-input:focus {
  outline: none;
  border-color: #58a6ff;
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
}
```

- [ ] **Step 6: Run the smoke test to verify it passes**

Run:

```bash
node test-e2e.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add renderer/index.html renderer/renderer.js renderer/styles.css test-e2e.js
git commit -m "feat: add context menu rename action"
```

---

### Task 5: Make sidebar titles support shared inline rename flow

**Files:**
- Modify: `renderer/renderer.js`
- Modify: `renderer/styles.css`

- [ ] **Step 1: Write the failing renderer behavior change by identifying the current mismatch**

In `renderer/renderer.js`, note that `startRename(sessionId, titleSpan)` currently assumes the title is in the terminal header and uses `terminal-title-input`. Add a commentless failing manual checkpoint by trying the app after the next code step; the current sidebar double-click path does not exist, so the UI behavior is absent.

- [ ] **Step 2: Refactor `startRename()` into a shared helper that accepts a class name**

Replace the current function:

```js
function startRename(sessionId, titleSpan) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const input = document.createElement('input');
  input.className = 'terminal-title-input';
```

with:

```js
function beginRenameSession(sessionId, titleSpan, inputClass = 'terminal-title-input') {
  const session = sessions.get(sessionId);
  if (!session || !titleSpan) return;

  const input = document.createElement('input');
  input.className = inputClass;
  input.value = session.title;

  const finish = async () => {
    const trimmed = input.value.trim().slice(0, 80);
    if (trimmed && trimmed !== session.title) {
      session.userRenamed = true;
      if (session.status === 'dormant') {
        session.title = trimmed;
        renderSessionList();
        schedulePersist();
      } else {
        await ipcRenderer.invoke('rename-session', { sessionId, title: trimmed });
        if (session.kind === 'claude' || session.kind === 'claude-resume') {
          syncRenameToClaude(sessionId, trimmed);
        }
      }
    }
    input.replaceWith(titleSpan);
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = session.title;
      input.blur();
    }
  });

  titleSpan.replaceWith(input);
  input.focus();
  input.select();
}
```

Then update the terminal-header click binding from:

```js
titleSpan.addEventListener('click', () => startRename(sessionId, titleSpan));
```

to:

```js
titleSpan.addEventListener('click', () => beginRenameSession(sessionId, titleSpan, 'terminal-title-input'));
```

- [ ] **Step 3: Add sidebar double-click support in the session list render path**

In the session list item creation block (the one that binds `contextmenu` around line 390), make the title span render as a real element and attach:

```js
titleEl.addEventListener('dblclick', (e) => {
  e.stopPropagation();
  beginRenameSession(s.id, titleEl, 'session-title-input');
});
```

Use the existing `s.id` from that render loop. Do not invent a second rename flow.

- [ ] **Step 4: Add sidebar input styles**

In `renderer/styles.css`, add:

```css
.session-title-input {
  width: 100%;
  min-width: 0;
  background: #161b22;
  color: #f0f6fc;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 2px 6px;
  font: inherit;
}

.session-title-input:focus {
  outline: none;
  border-color: #58a6ff;
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.18);
}
```

- [ ] **Step 5: Run the app and verify rename behavior manually**

Run:

```bash
npm start
```

Manual expected result:
- Double-clicking a sidebar title opens an inline input.
- Pressing `Enter` saves.
- Pressing `Esc` cancels.
- Right-click → `Rename session` reuses the same input behavior.

- [ ] **Step 6: Commit**

```bash
git add renderer/renderer.js renderer/styles.css
git commit -m "feat: support inline sidebar session rename"
```

---

### Task 6: Make the header cwd editable and wire it to `set-session-cwd`

**Files:**
- Modify: `renderer/renderer.js`
- Modify: `renderer/styles.css`
- Modify: `main.js`

- [ ] **Step 1: Replace click-to-copy cwd with editable UI trigger**

In `renderer/renderer.js`, replace the cwd fragment inside `renderMetricsRow()`:

```js
  if (session.cwd) {
    const a = document.createElement('span');
    a.className = 'metric-cwd';
    a.textContent = '📁 ' + session.cwd;
    a.title = 'Click to copy · ' + session.cwd;
    a.addEventListener('click', () => {
      try { clipboard.writeText(session.cwd); } catch {}
    });
    frags.push(a);
  }
```

with:

```js
  if (session.cwd) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'metric-cwd';
    a.textContent = '📁 ' + session.cwd;
    a.title = 'Click to edit working directory';
    a.addEventListener('click', () => beginEditSessionCwd(session.id, a));
    frags.push(a);
  }
```

- [ ] **Step 2: Add the shared cwd editor helper**

In `renderer/renderer.js`, near the rename helper, add:

```js
async function beginEditSessionCwd(sessionId, cwdEl) {
  const session = sessions.get(sessionId);
  if (!session || !cwdEl) return;

  const input = document.createElement('input');
  input.className = 'metric-cwd-input';
  input.value = session.cwd || '';

  const finish = async (commit) => {
    const next = input.value.trim();
    if (commit && next && next !== session.cwd) {
      const updated = await ipcRenderer.invoke('set-session-cwd', { sessionId, cwd: next });
      if (updated && !updated.error) {
        Object.assign(session, updated);
        renderSessionList();
        updateActiveMetricsRow();
        schedulePersist();
      } else {
        input.value = session.cwd || '';
      }
    }
    input.replaceWith(cwdEl);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));

  cwdEl.replaceWith(input);
  input.focus();
  input.select();
}
```

- [ ] **Step 3: Ensure session update events refresh the active header row**

In the `ipcRenderer.on('session-updated', ...)` block, make sure the updated session object is merged and both list and active header metrics are refreshed. If the handler currently only updates the list, add:

```js
  updateActiveMetricsRow();
```

after the session merge/render path.

- [ ] **Step 4: Style the cwd editor**

In `renderer/styles.css`, add:

```css
.metric-cwd {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font: inherit;
}

.metric-cwd-input {
  min-width: 280px;
  max-width: min(60vw, 720px);
  background: #161b22;
  color: #f0f6fc;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 2px 8px;
  font: inherit;
}

.metric-cwd-input:focus {
  outline: none;
  border-color: #58a6ff;
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.18);
}
```

- [ ] **Step 5: Run the app and verify cwd editing manually**

Run:

```bash
npm start
```

Manual expected result:
- Clicking the cwd in the terminal header turns it into an input.
- Editing a PowerShell session cwd and pressing `Enter` updates the header and actually changes directories.
- Editing a Claude session cwd updates the header and persists metadata, but does not inject a visible `cd` command into the running Claude prompt.

- [ ] **Step 6: Commit**

```bash
git add renderer/renderer.js renderer/styles.css main.js
git commit -m "feat: add editable session working directory"
```

---

### Task 7: Preserve cwd across restart/resume flows and run the focused test suite

**Files:**
- Modify: `main.js`
- Modify: `renderer/renderer.js`
- Test: `tests/test-app-config.js`
- Test: `tests/test-session-cwd.js`
- Test: `tests/mobile/test-ring-buffer.js`
- Test: `test-e2e.js`

- [ ] **Step 1: Make restart reuse the current session cwd**

In `main.js`, replace:

```js
  const fresh = sessionManager.createSession(old.kind);
```

with:

```js
  const fresh = sessionManager.createSession(old.kind, {
    cwd: old.cwd,
  });
```

- [ ] **Step 2: Ensure renderer persistence keeps updated cwd/title values**

In the persist payload mapping inside `renderer/renderer.js`, verify the serialized list already includes:

```js
cwd: s.cwd || null,
title: s.title,
```

If either is missing, add it explicitly in the object returned for `persist-sessions`.

- [ ] **Step 3: Run the focused automated tests**

Run:

```bash
node tests/test-app-config.js && node tests/test-session-cwd.js && node tests/mobile/test-ring-buffer.js && node test-e2e.js
```

Expected: all PASS.

- [ ] **Step 4: Run the full existing mobile test suite as regression coverage**

Run:

```bash
npm run test:mobile
```

Expected: PASS.

- [ ] **Step 5: Manual regression pass in the app**

Run:

```bash
npm start
```

Manual expected result:
- New PowerShell sessions start in `config/session-hub.json`'s directory.
- Right-click menu shows `Rename session`.
- Double-click title rename works.
- Edited PowerShell cwd survives restart.
- Edited dormant/Claude session title survives UI refresh.

- [ ] **Step 6: Commit**

```bash
git add main.js renderer/renderer.js
git commit -m "fix: preserve edited session metadata across lifecycle events"
```

---

## Self-Review

**Spec coverage:**
- Default cwd from project JSON: covered in Tasks 1, 3, and 7.
- Editable header cwd: covered in Task 6.
- PowerShell immediate cwd switch vs Claude deferred-only metadata update: covered in Tasks 2 and 6.
- GUI rename via context menu and double-click: covered in Tasks 4 and 5.
- Reuse existing rename flow and keep `/rename`: Task 5 preserves `syncRenameToClaude()` and existing rename IPC path.

**Placeholder scan:**
- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Each code-changing step includes concrete code.
- Each verification step includes an exact command and expected result.

**Type consistency:**
- Config field is consistently `defaultWorkingDirectory`.
- New IPC is consistently `set-session-cwd`.
- Shared renderer helpers are `beginRenameSession()` and `beginEditSessionCwd()`.
- Session manager method is consistently `changeSessionCwd()`.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-17-session-path-and-rename.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
