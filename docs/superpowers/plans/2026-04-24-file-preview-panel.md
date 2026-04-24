# File Preview Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed HTML/Markdown/image file preview inside Claude Session Hub via Ctrl+Click on terminal file paths, rendered in a dedicated panel tab.

**Architecture:** Modify the existing `registerLocalPathLinks` activate callback to route previewable files (html/md/images) to a new preview-panel instead of `shell.openPath`. The preview-panel sits alongside terminal-panel/team-room-panel/meeting-room-panel as a peer in the mutual-exclusion panel system. HTML files render via `<webview>`, Markdown via `marked` + `DOMPurify` (already dependencies), images via `<img>`.

**Tech Stack:** Electron webview, marked, DOMPurify (all existing deps), vanilla DOM

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `main.js:279-290` | Modify | Add `webviewTag: true` to `webPreferences` |
| `main.js:611-618` | After | Add `read-file` IPC handler |
| `renderer/index.html:57-58` | Insert | Add preview-panel DOM between terminal-panel and memo-panel |
| `renderer/renderer.js:116-118` | After | Add `PREVIEW_PATH_RE` regex |
| `renderer/renderer.js:1628-1656` | Modify | Change `activate` callback to route previewable files |
| `renderer/renderer.js` (end) | Append | Add `openPreviewPanel`, `closePreviewPanel`, Esc handler, button wiring |
| `renderer/styles.css` (end) | Append | Add `.preview-panel`, `.preview-header`, `.preview-body`, `.preview-markdown`, `.preview-image` styles |

---

### Task 1: Add `read-file` IPC handler in main.js

**Files:**
- Modify: `main.js:611-618` (insert after `open-path` handler)

- [ ] **Step 1: Add the `read-file` IPC handler after the `open-path` handler**

In `main.js`, insert after line 618 (the closing `});` of the `open-path` handler):

```js
ipcMain.handle('read-file', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { error: 'invalid path' };
  const ext = path.extname(filePath).toLowerCase();
  if (!['.md', '.markdown'].includes(ext)) return { error: 'unsupported extension' };
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) return { error: 'file too large (>5MB)' };
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { content };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
```

- [ ] **Step 2: Enable `webviewTag` in BrowserWindow webPreferences**

In `main.js` line 286-290, add `webviewTag: true`:

```js
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
```

- [ ] **Step 3: Smoke test — Hub starts without error**

Run:
```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```
Expected: `[hub] hook server listening on 127.0.0.1:...` — no `Cannot find module` or crash.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(preview): add read-file IPC and enable webviewTag"
```

---

### Task 2: Add preview-panel DOM to index.html

**Files:**
- Modify: `renderer/index.html:57` (insert after terminal-panel closing `</div>`, before memo-panel)

- [ ] **Step 1: Insert preview-panel HTML**

In `renderer/index.html`, between the terminal-panel closing `</div>` (line 57) and the memo-panel `<div>` (line 58), insert:

```html
    <div class="preview-panel" id="preview-panel" style="display:none">
      <div class="preview-header">
        <span class="preview-title" id="preview-title">Preview</span>
        <div class="preview-header-actions">
          <button class="preview-action-btn" id="preview-open-external" title="在外部打开">↗</button>
          <button class="preview-action-btn" id="preview-close" title="关闭预览 (Esc)">✕</button>
        </div>
      </div>
      <div class="preview-body" id="preview-body"></div>
    </div>
```

- [ ] **Step 2: Verify HTML structure**

Open `renderer/index.html` and confirm:
- `preview-panel` sits between `terminal-panel` and `memo-panel`
- IDs are unique: `preview-panel`, `preview-title`, `preview-open-external`, `preview-close`, `preview-body`

- [ ] **Step 3: Commit**

```bash
git add renderer/index.html
git commit -m "feat(preview): add preview-panel DOM structure"
```

---

### Task 3: Add preview-panel styles to styles.css

**Files:**
- Modify: `renderer/styles.css` (append at end)

- [ ] **Step 1: Append preview-panel styles**

Add to the end of `renderer/styles.css`:

```css
/* ── Preview Panel ─────────────────────────────────────── */

.preview-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  min-width: 0;
}

.preview-header {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-secondary);
  min-height: 40px;
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.preview-action-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 14px;
  transition: color 0.15s, border-color 0.15s;
}

.preview-action-btn:hover {
  color: var(--text-primary);
  border-color: var(--text-secondary);
}

.preview-body {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
}

.preview-body webview {
  width: 100%;
  height: 100%;
  border: none;
}

.preview-markdown {
  padding: 24px 32px;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
  align-self: flex-start;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.7;
}

.preview-markdown h1,
.preview-markdown h2,
.preview-markdown h3,
.preview-markdown h4 {
  color: var(--text-primary);
  margin: 1.2em 0 0.6em;
}

.preview-markdown h1 { font-size: 1.6em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.preview-markdown h2 { font-size: 1.3em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.preview-markdown h3 { font-size: 1.1em; }

.preview-markdown p { margin: 0 0 0.8em; }
.preview-markdown strong { color: #f5f7fb; font-weight: 600; }
.preview-markdown a { color: var(--accent-blue, #58a6ff); text-decoration: none; }
.preview-markdown a:hover { text-decoration: underline; }

.preview-markdown ul,
.preview-markdown ol { padding-left: 1.5em; margin: 0 0 0.8em; }
.preview-markdown li { margin: 0.2em 0; }

.preview-markdown code {
  color: #ffd966;
  background: #1a2337;
  border: 1px solid #262c3a;
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 0.9em;
}

.preview-markdown pre {
  background: #0d1018;
  border: 1px solid #262c3a;
  border-radius: 6px;
  padding: 12px 16px;
  margin: 6px 0;
  overflow-x: auto;
  white-space: pre;
}

.preview-markdown pre code {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 12.5px;
  color: #d8dee9;
  white-space: pre;
}

.preview-markdown blockquote {
  margin: 4px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--accent-blue, #58a6ff);
  color: var(--text-secondary);
}

.preview-markdown table {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
}

.preview-markdown th,
.preview-markdown td {
  border: 1px solid var(--border);
  padding: 6px 12px;
  text-align: left;
}

.preview-markdown th {
  background: var(--bg-secondary);
  font-weight: 600;
}

.preview-markdown img {
  max-width: 100%;
  border-radius: 4px;
}

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/styles.css
git commit -m "feat(preview): add preview-panel CSS styles"
```

---

### Task 4: Add preview logic and panel switching to renderer.js

**Files:**
- Modify: `renderer/renderer.js:116-118` (add regex after IMAGE_PATH_RE)
- Modify: `renderer/renderer.js:1628-1656` (change `activate` callback)
- Modify: `renderer/renderer.js` (append preview functions + Esc handler + button wiring)

- [ ] **Step 1: Add `PREVIEW_PATH_RE` regex**

In `renderer/renderer.js`, after line 118 (the `IMAGE_PATH_RE` line), insert:

```js
const PREVIEW_PATH_RE = /\.(?:html?|md|markdown|png|jpe?g|gif|webp|bmp)$/i;
```

Note: this is a simpler extension-only regex — we already have the full path from `ABS_PATH_RE` matching in `registerLocalPathLinks`. We only need to test the extension of the matched path.

- [ ] **Step 2: Modify `registerLocalPathLinks` activate callback**

In `renderer/renderer.js`, replace the `activate` callback inside `registerLocalPathLinks` (lines 1647-1649):

Old code:
```js
          activate: async (_event, uri) => {
            const err = await ipcRenderer.invoke('open-path', uri);
            if (err) console.warn('[hub] open-path failed:', uri, '→', err);
          },
```

New code:
```js
          activate: async (_event, uri) => {
            if (PREVIEW_PATH_RE.test(uri)) {
              openPreviewPanel(uri);
            } else {
              const err = await ipcRenderer.invoke('open-path', uri);
              if (err) console.warn('[hub] open-path failed:', uri, '→', err);
            }
          },
```

- [ ] **Step 3: Add preview panel state variables and DOM refs**

Append to `renderer/renderer.js` (before the closing of the file — after the `registerLocalPathLinks` function and the `buildPreviewFromUserMessage` function, around line 1669):

```js
// --- File Preview Panel ---
const previewPanelEl = document.getElementById('preview-panel');
const previewTitleEl = document.getElementById('preview-title');
const previewBodyEl = document.getElementById('preview-body');
let previewSourcePanel = null;
let currentPreviewPath = null;
```

- [ ] **Step 4: Add `openPreviewPanel` function**

Append right after the state variables:

```js
async function openPreviewPanel(filePath) {
  currentPreviewPath = filePath;
  const fileName = filePath.replace(/^.*[\\/]/, '');
  previewTitleEl.textContent = fileName;
  previewTitleEl.title = filePath;

  if (!previewSourcePanel) {
    if (document.getElementById('meeting-room-panel').style.display !== 'none'
        && document.getElementById('meeting-room-panel').style.display !== '') {
      previewSourcePanel = 'meeting-room-panel';
    } else if (document.getElementById('team-room-panel').style.display !== 'none'
        && document.getElementById('team-room-panel').style.display !== '') {
      previewSourcePanel = 'team-room-panel';
    } else {
      previewSourcePanel = 'terminal-panel';
    }
  }

  const src = document.getElementById(previewSourcePanel);
  if (src) src.style.display = 'none';
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.style.display = 'none';
  previewPanelEl.style.display = 'flex';

  previewBodyEl.innerHTML = '';

  const ext = filePath.replace(/^.*\./, '.').toLowerCase();

  if (ext === '.html' || ext === '.htm') {
    const wv = document.createElement('webview');
    wv.src = 'file:///' + filePath.replace(/\\/g, '/');
    wv.style.cssText = 'width:100%;height:100%;border:none;';
    previewBodyEl.style.alignItems = 'stretch';
    previewBodyEl.style.justifyContent = 'stretch';
    previewBodyEl.appendChild(wv);
  } else if (ext === '.md' || ext === '.markdown') {
    const { marked } = require('marked');
    const DOMPurify = require('dompurify');
    const result = await ipcRenderer.invoke('read-file', filePath);
    if (result.error) {
      previewBodyEl.innerHTML = `<div class="preview-markdown" style="color:var(--text-secondary)">Failed to load: ${result.error}</div>`;
      return;
    }
    const html = DOMPurify.sanitize(marked.parse(result.content));
    previewBodyEl.style.alignItems = 'flex-start';
    previewBodyEl.style.justifyContent = 'flex-start';
    previewBodyEl.innerHTML = `<div class="preview-markdown">${html}</div>`;
  } else {
    const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    previewBodyEl.style.alignItems = 'center';
    previewBodyEl.style.justifyContent = 'center';
    previewBodyEl.innerHTML = `<img src="${fileUrl}" class="preview-image">`;
  }
}
```

- [ ] **Step 5: Add `closePreviewPanel` function**

Append right after `openPreviewPanel`:

```js
function closePreviewPanel() {
  previewPanelEl.style.display = 'none';
  currentPreviewPath = null;

  if (previewSourcePanel) {
    const src = document.getElementById(previewSourcePanel);
    if (src) src.style.display = previewSourcePanel === 'terminal-panel' ? '' : 'flex';
    previewSourcePanel = null;
  }
}
```

- [ ] **Step 6: Wire up buttons and Esc key**

Append right after `closePreviewPanel`:

```js
document.getElementById('preview-close').addEventListener('click', closePreviewPanel);
document.getElementById('preview-open-external').addEventListener('click', async () => {
  if (currentPreviewPath) {
    const err = await ipcRenderer.invoke('open-path', currentPreviewPath);
    if (err) console.warn('[hub] open-path for preview failed:', currentPreviewPath, '→', err);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewPanelEl.style.display === 'flex') {
    e.preventDefault();
    closePreviewPanel();
  }
});
```

- [ ] **Step 7: Hide preview-panel in existing panel-switch functions**

In `selectSession` function (line 1257), add after the meeting-room-panel hide (line 1269):

```js
  const pp = document.getElementById('preview-panel');
  if (pp) { pp.style.display = 'none'; previewSourcePanel = null; currentPreviewPath = null; }
```

In `selectTeamRoom` function (line 702), add after the meeting-room-panel hide (line 706):

```js
  const pp = document.getElementById('preview-panel');
  if (pp) { pp.style.display = 'none'; previewSourcePanel = null; currentPreviewPath = null; }
```

In `selectMeeting` function (line 722), add after the team-room-panel hide (line 730):

```js
  const pp = document.getElementById('preview-panel');
  if (pp) { pp.style.display = 'none'; previewSourcePanel = null; currentPreviewPath = null; }
```

- [ ] **Step 8: Smoke test — Hub starts without error**

Run:
```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```
Expected: `[hub] hook server listening on 127.0.0.1:...` — no JS errors.

- [ ] **Step 9: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(preview): implement preview panel logic with panel switching"
```

---

### Task 5: Manual integration test

**Files:** None (testing only)

- [ ] **Step 1: Start a Hub test instance**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-preview-test"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9221
```

- [ ] **Step 2: Test HTML preview**

In any session, make the AI output a path to an HTML file (e.g. the design spec — create a test.html). Ctrl+Click the path. Verify:
- Preview panel appears with file name in header
- HTML renders correctly in webview
- "↗" button opens in external browser
- "✕" button closes preview, returns to terminal
- Esc key also closes preview

- [ ] **Step 3: Test Markdown preview**

Create or locate a `.md` file path in terminal output. Ctrl+Click it. Verify:
- Markdown renders with proper formatting (headings, code blocks, tables)
- Styling matches the dark theme

- [ ] **Step 4: Test image preview**

Get an image path in terminal output. Ctrl+Click it. Verify:
- Image displays centered, scaled to fit
- Previous hover-preview tooltip still works independently

- [ ] **Step 5: Test non-previewable files**

Ctrl+Click a `.js` or `.py` file path. Verify:
- Opens with OS default handler (original behavior)
- Preview panel does NOT appear

- [ ] **Step 6: Test panel switching**

While preview is open:
- Click a session in sidebar → preview closes, terminal shows
- Click a team room → preview closes, team room shows
- Re-trigger Ctrl+Click from terminal → preview re-opens

- [ ] **Step 7: Close test instance and clean up**

Close the test Hub instance. Remove `C:\temp\hub-preview-test` directory.

- [ ] **Step 8: Final commit (if any fixes needed)**

If integration testing revealed issues, fix them and commit:
```bash
git add -A
git commit -m "fix(preview): integration test fixes"
```
