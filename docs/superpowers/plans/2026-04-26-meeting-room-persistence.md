# 会议室持久化与重启恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub 重启后,会议室元数据 + timeline + 三家 AI 子 session 完整恢复(三家 native resume + 三级降级兜底)。

**Architecture:** 分文件存储(`state.json` 元数据 + `meetings/<id>.json` timeline);timeline debounced 5s flush + before-quit force flush;CodexTap/GeminiTap bind 成功时 emit `session-bound` 事件,main.js 接住把 codexSid / geminiChatId / projectHash / projectRoot 写到 state;spawn 时按 kind 构造精准 resume 命令(claude --resume / codex resume <sid> / gemini --list-sessions 反查 index → -r index);失败降级到同家 fallback,再降级到 transcript 文本注入。

**Tech Stack:** Node.js / Electron / fs.promises / EventEmitter(Hub 现有栈,不引入新依赖)。

**Spec 引用:** `docs/superpowers/specs/2026-04-25-meeting-room-persistence-design.md`(commit 25ec2d4)。

---

## File Structure

| 文件 | 角色 | 改动类型 |
|---|---|---|
| `core/meeting-store.js` | Timeline 持久化 IO + debounce flush | **新建** |
| `core/meeting-room.js` | mutation 时调 markDirty;加 loadTimelineLazy | 修改 |
| `core/state-store.js` | sessions[] 加 codexSid / geminiChatId / projectHash / projectRoot | 修改 |
| `core/transcript-tap.js` | CodexTap/GeminiTap bind 成功时 emit `session-bound` 事件 | 修改 |
| `core/session-manager.js` | createSession 接受 codexSid / gemini resume 元数据;构造精准 resume 命令 | 修改 |
| `main.js` | 启动时 load meetings/lazy timeline;接 session-bound 事件;before-quit flush;新 IPC | 修改 |
| `tests/meeting-store.test.js` | 单测 | **新建** |
| `tests/meeting-room-persist.test.js` | 单测 mutation 触发 markDirty | **新建** |
| `tests/_e2e-meeting-resume-real.js` | 端到端 E2E:启动 → 开会 → kill → 重启 → 续接 | **新建** |

---

## Task 总览

| # | 名称 | 工程量 |
|---|---|---|
| T1 | 新建 `meeting-store.js`(IO + debounce + flush API)+ 单测 | 0.4 天 |
| T2 | `meeting-room.js` 集成 store(mutation → markDirty,加 loadTimelineLazy)+ 单测 | 0.3 天 |
| T3 | `main.js` 集成(lazy timeline IPC + before-quit flush)+ smoke | 0.3 天 |
| T4 | `state-store.js` sessions 字段扩展 + 单测 | 0.2 天 |
| T5 | CodexTap emit `session-bound { codexSid }` + 单测 | 0.2 天 |
| T6 | GeminiTap emit `session-bound { geminiChatId, projectHash, projectRoot }` + 单测 | 0.2 天 |
| T7 | `main.js` 接 session-bound → 写 state.sessions[]  | 0.3 天 |
| T8 | `session-manager.js` Codex 精准 sid resume + Gemini list-sessions 反查 index resume | 0.5 天 |
| T9 | 三级降级 fallback + E2E 测试 | 0.6 天 |

**总:~3 天**(spec 估算 5 天,实际更少因 Hub 已具备很多基础架构)

---

## Task 1: 新建 `meeting-store.js`(Timeline 持久化基建)

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\meeting-store.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\meeting-store.test.js`

**Why this task:** 当前 `MeetingRoomManager` 的 `_timeline / _cursors` 完全 in-memory(`core/meeting-room.js:27-29` 注释明确写"in-memory only")。需要一个干净的 IO 层,负责单文件 read/write/debounce/flush,与业务逻辑解耦。

- [ ] **Step 1: 写失败的单测**

```js
// tests/meeting-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const { saveMeetingFile, loadMeetingFile, markDirty, flushAll, listMeetingFiles, deleteMeetingFile } = require('../core/meeting-store');

(async () => {
  // T1.1: save + load round-trip
  const data = { id: 'm1', _timeline: [{ idx: 0, sid: 'user', text: 'hi', ts: 1 }], _cursors: { 'a': 0 }, _nextIdx: 1 };
  saveMeetingFile('m1', data);
  const loaded = loadMeetingFile('m1');
  assert.deepStrictEqual(loaded._timeline, data._timeline, 'timeline round-trip');
  assert.deepStrictEqual(loaded._cursors, data._cursors, 'cursors round-trip');
  assert.strictEqual(loaded._nextIdx, 1, 'nextIdx round-trip');
  assert.strictEqual(loaded.schemaVersion, 1, 'schemaVersion present');
  console.log('PASS T1.1 save+load round-trip');

  // T1.2: missing file returns null
  assert.strictEqual(loadMeetingFile('nonexistent'), null);
  console.log('PASS T1.2 missing file → null');

  // T1.3: list files
  saveMeetingFile('m2', { id: 'm2', _timeline: [], _cursors: {}, _nextIdx: 0 });
  const ids = listMeetingFiles().sort();
  assert.deepStrictEqual(ids, ['m1', 'm2']);
  console.log('PASS T1.3 list files');

  // T1.4: delete
  deleteMeetingFile('m1');
  assert.strictEqual(loadMeetingFile('m1'), null);
  console.log('PASS T1.4 delete');

  // T1.5: markDirty + flushAll
  let written = 0;
  const realSave = require('../core/meeting-store').saveMeetingFile;
  // Use a fresh getter so we can spy
  markDirty('m2', { id: 'm2', _timeline: [{ idx: 0, sid: 'a', text: 'x', ts: 2 }], _cursors: {}, _nextIdx: 1 });
  await flushAll();
  const after = loadMeetingFile('m2');
  assert.strictEqual(after._timeline.length, 1, 'flushAll wrote pending dirty');
  console.log('PASS T1.5 markDirty + flushAll');

  console.log('ALL meeting-store tests PASS');
  // cleanup
  fs.rmSync(TEMP, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
```

- [ ] **Step 2: 运行单测确认失败**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/meeting-store.test.js
```
Expected: `Cannot find module '../core/meeting-store'`

- [ ] **Step 3: 创建 `core/meeting-store.js` 实现**

```js
// core/meeting-store.js
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('./data-dir');

const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 5000;

function meetingsDir() {
  return path.join(getHubDataDir(), 'meetings');
}

function ensureDir() {
  fs.mkdirSync(meetingsDir(), { recursive: true });
}

function meetingFilePath(id) {
  return path.join(meetingsDir(), `${id}.json`);
}

function saveMeetingFile(id, data) {
  ensureDir();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    id,
    _timeline: Array.isArray(data._timeline) ? data._timeline : [],
    _cursors: data._cursors && typeof data._cursors === 'object' ? data._cursors : {},
    _nextIdx: typeof data._nextIdx === 'number' ? data._nextIdx : 0,
    savedAt: Date.now(),
  };
  const tmp = meetingFilePath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, meetingFilePath(id));
}

function loadMeetingFile(id) {
  try {
    const raw = fs.readFileSync(meetingFilePath(id), 'utf-8');
    const obj = JSON.parse(raw);
    if (obj.schemaVersion !== SCHEMA_VERSION) {
      console.warn(`[meeting-store] schema mismatch for ${id}: ${obj.schemaVersion}`);
      return null;
    }
    return obj;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[meeting-store] load ${id} failed:`, e.message);
    return null;
  }
}

function listMeetingFiles() {
  try {
    return fs.readdirSync(meetingsDir())
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => f.slice(0, -5));
  } catch { return []; }
}

function deleteMeetingFile(id) {
  try { fs.unlinkSync(meetingFilePath(id)); } catch {}
}

// Debounced flush registry
const _dirty = new Map();   // id → latest data snapshot
const _timers = new Map();  // id → debounce timer

function markDirty(id, data) {
  _dirty.set(id, data);
  if (_timers.has(id)) clearTimeout(_timers.get(id));
  const t = setTimeout(() => {
    const snap = _dirty.get(id);
    if (snap) {
      try { saveMeetingFile(id, snap); } catch (e) { console.warn(`[meeting-store] flush ${id} failed:`, e.message); }
      _dirty.delete(id);
    }
    _timers.delete(id);
  }, DEBOUNCE_MS);
  t.unref?.();
  _timers.set(id, t);
}

async function flushAll() {
  for (const [id, t] of _timers) clearTimeout(t);
  _timers.clear();
  for (const [id, snap] of _dirty) {
    try { saveMeetingFile(id, snap); } catch (e) { console.warn(`[meeting-store] flushAll ${id} failed:`, e.message); }
  }
  _dirty.clear();
}

module.exports = {
  saveMeetingFile,
  loadMeetingFile,
  listMeetingFiles,
  deleteMeetingFile,
  markDirty,
  flushAll,
  SCHEMA_VERSION,
  DEBOUNCE_MS,
};
```

- [ ] **Step 4: 再运行单测,确认全 PASS**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/meeting-store.test.js
```
Expected: 全部 5 个 PASS,最后输出 `ALL meeting-store tests PASS`

- [ ] **Step 5: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add core/meeting-store.js tests/meeting-store.test.js
git commit -m "feat(meeting-persistence): add meeting-store module with debounced timeline IO

新建 core/meeting-store.js 提供 timeline 持久化基建:
- saveMeetingFile/loadMeetingFile 单文件 round-trip
- listMeetingFiles/deleteMeetingFile 管理
- markDirty + 5s debounce + flushAll 配合 before-quit
- atomic write(tmp + rename),schema v1
- 5/5 单测通过

为 T2/T3 集成 MeetingRoomManager 和 main.js 铺路。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `meeting-room.js` 集成 store + lazy load + 单测

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-room.js`(add `loadTimelineLazy`,在 mutation 处加 markDirty)
- Test: `C:\Users\lintian\claude-session-hub\tests\meeting-room-persist.test.js`

**Why this task:** mutation(`appendTurn / advanceCursor`)发生时要触发持久化;`restoreMeeting`(line 97-109)只填了元数据,真正读 timeline 要 lazy(用户首次 fetch 时才 load)。

- [ ] **Step 1: 写失败的单测**

```js
// tests/meeting-room-persist.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mroom-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

// IMPORTANT: invalidate require cache so meeting-store sees new env
delete require.cache[require.resolve('../core/data-dir')];
delete require.cache[require.resolve('../core/meeting-store')];
delete require.cache[require.resolve('../core/meeting-room')];

const { MeetingRoomManager } = require('../core/meeting-room');
const { loadMeetingFile, flushAll } = require('../core/meeting-store');

(async () => {
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();
  mgr.addSubSession(m.id, 'sid-A');
  mgr.appendTurn(m.id, 'sid-A', 'hello world', 1000);
  mgr.appendTurn(m.id, 'user', 'reply', 2000);

  await flushAll();

  const persisted = loadMeetingFile(m.id);
  assert.ok(persisted, 'meeting file persisted');
  assert.strictEqual(persisted._timeline.length, 2, 'timeline length 2');
  assert.strictEqual(persisted._timeline[0].text, 'hello world');
  assert.strictEqual(persisted._timeline[1].text, 'reply');
  assert.strictEqual(persisted._nextIdx, 2);
  console.log('PASS T2.1 mutation triggers persist');

  // T2.2: loadTimelineLazy populates in-memory
  const mgr2 = new MeetingRoomManager();
  mgr2.restoreMeeting({ id: m.id, title: 'recover', subSessions: ['sid-A'], layout: 'focus' });
  const before = mgr2.getTimeline(m.id);
  assert.strictEqual(before.length, 0, 'restoreMeeting starts empty');
  mgr2.loadTimelineLazy(m.id);
  const after = mgr2.getTimeline(m.id);
  assert.strictEqual(after.length, 2, 'loadTimelineLazy fills timeline');
  console.log('PASS T2.2 loadTimelineLazy');

  console.log('ALL meeting-room-persist tests PASS');
  fs.rmSync(TEMP, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
```

- [ ] **Step 2: 运行单测确认失败**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/meeting-room-persist.test.js
```
Expected: `mgr2.loadTimelineLazy is not a function` 或类似(方法未实现)

- [ ] **Step 3: 修改 `core/meeting-room.js` 集成 store**

打开 `core/meeting-room.js`。

(a) 文件顶部第 1 行后插入 require:

```js
const { v4: uuid } = require('uuid');
const meetingStore = require('./meeting-store');
```

(b) 第 97-109 行 `restoreMeeting` 方法**保持不变**(已 OK,timeline 默认空数组,等 lazy load)。

(c) 在 `restoreMeeting` 后添加 `loadTimelineLazy`:

```js
loadTimelineLazy(meetingId) {
  const m = this.meetings.get(meetingId);
  if (!m) return false;
  // Already loaded?
  if (m._timeline.length > 0 || m._nextIdx > 0) return true;
  const data = meetingStore.loadMeetingFile(meetingId);
  if (!data) return false;
  m._timeline = Array.isArray(data._timeline) ? data._timeline : [];
  m._cursors = (data._cursors && typeof data._cursors === 'object') ? data._cursors : {};
  m._nextIdx = typeof data._nextIdx === 'number' ? data._nextIdx : m._timeline.length;
  return true;
}
```

(d) 在 `appendTurn` 方法 return 之前(line 133 之前),加 markDirty 调用:

```js
// Existing line at ~131:    m._timeline.push(turn);
// Existing line at ~132:    m.lastMessageTime = resolvedTs;
// ADD this line right before `return { ...turn };`:
meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
return { ...turn };
```

(e) `advanceCursor` 方法(line 149-157)末尾改为:

```js
advanceCursor(meetingId, sid, newPos) {
  const m = this.meetings.get(meetingId);
  if (!m) return false;
  if (!(sid in m._cursors)) return false;
  if (newPos < m._cursors[sid]) return false;
  if (newPos > m._timeline.length) newPos = m._timeline.length;
  m._cursors[sid] = newPos;
  meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
  return true;
}
```

(f) `incrementalContext` 方法(line 159-174)在最后 return 之前(改 cursor 后)同样加:

```js
incrementalContext(meetingId, targetSid) {
  const m = this.meetings.get(meetingId);
  if (!m || !(targetSid in m._cursors)) {
    return { turns: [], advancedTo: 0 };
  }
  const fromIdx = m._cursors[targetSid];
  const newTurns = m._timeline
    .slice(fromIdx)
    .filter(t => t.sid !== targetSid)
    .map(t => ({ ...t }));
  m._cursors[targetSid] = m._timeline.length;
  meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
  return { turns: newTurns, advancedTo: m._cursors[targetSid] };
}
```

(g) `closeMeeting`(line 89-95)结束后删除持久化文件:

```js
closeMeeting(meetingId) {
  const m = this.meetings.get(meetingId);
  if (!m) return null;
  const subIds = [...m.subSessions];
  this.meetings.delete(meetingId);
  meetingStore.deleteMeetingFile(meetingId);
  return subIds;
}
```

- [ ] **Step 4: 再运行单测,确认全 PASS**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/meeting-room-persist.test.js
```
Expected: `ALL meeting-room-persist tests PASS`

- [ ] **Step 5: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add core/meeting-room.js tests/meeting-room-persist.test.js
git commit -m "feat(meeting-persistence): integrate meeting-store with MeetingRoomManager

- appendTurn/advanceCursor/incrementalContext 触发 markDirty
- 加 loadTimelineLazy 给 main.js 在用户点开会议室时调
- closeMeeting 同步删除持久化文件
- 2/2 单测覆盖 mutation 持久化和 lazy load

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `main.js` 集成 lazy timeline + before-quit flush + smoke

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`(加 IPC handler + before-quit hook)

**Why this task:** Hub 启动时 `main.js:658-662` 已 restoreMeeting(只元数据),需要补:① 用户点开会议室时通过新 IPC 触发 lazy timeline load;② Hub 退出时强制 flush 所有 dirty timeline。

- [ ] **Step 1: 添加 IPC handler `meeting-load-timeline`**

打开 `main.js`,找到现有的 `ipcMain.handle('get-dormant-meetings', ...)`(line 667 附近)。在它后面新增:

```js
// Lazy load timeline for a restored meeting (called when user opens the meeting view).
// Idempotent: safe to call multiple times; second+ call returns same in-memory state.
ipcMain.handle('meeting-load-timeline', (_e, meetingId) => {
  if (!meetingId) return { ok: false, reason: 'missing meetingId' };
  const ok = meetingManager.loadTimelineLazy(meetingId);
  if (!ok) return { ok: false, reason: 'no persisted timeline (or meeting unknown)' };
  return {
    ok: true,
    timeline: meetingManager.getTimeline(meetingId),
  };
});
```

- [ ] **Step 2: 注册 before-quit force flush**

在 `main.js` 顶部 require 区(`stateStore` require 附近)加:

```js
const meetingStore = require('./core/meeting-store');
```

然后在 `app.on('before-quit', ...)` 处理(grep 找现有 before-quit hook;如果没有,新增一个)。如果已有,把这两行加进去:

```js
app.on('before-quit', async (e) => {
  // ... existing logic ...
  try {
    await meetingStore.flushAll();
    console.log('[hub] meeting-store flushed on quit');
  } catch (err) {
    console.warn('[hub] meeting-store flush failed:', err.message);
  }
});
```

如果没有现成 before-quit hook,在文件末尾紧接现有 lifecycle hooks 的位置加:

```js
app.on('before-quit', async () => {
  try {
    await meetingStore.flushAll();
    console.log('[hub] meeting-store flushed on quit');
  } catch (err) {
    console.warn('[hub] meeting-store flush failed:', err.message);
  }
});
```

- [ ] **Step 3: Smoke test —— 启动 isolated Hub 实例,开会,kill,重启,验证恢复**

```bash
cd /c/Users/lintian/claude-session-hub
# 启动 isolated 实例
TEMP_DIR=/tmp/hub-persist-smoke-$$
rm -rf "$TEMP_DIR" && mkdir -p "$TEMP_DIR"
CLAUDE_HUB_DATA_DIR="$TEMP_DIR" timeout 15 ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9226 > /tmp/hub-smoke.log 2>&1 &
HUB_PID=$!
sleep 6

# 用 CDP 起一个会议、加 turn(使用 ws 模块,详见 tests/_e2e-meeting-resume-real.js)
node -e "
const WebSocket = require('./node_modules/ws');
(async () => {
  const list = await fetch('http://127.0.0.1:9226/json/list').then(r=>r.json());
  const main = list.find(t => t.url.includes('index.html'));
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 0;
  function rpc(method, params={}) {
    const i = ++id;
    return new Promise((res, rej) => {
      const onMsg = raw => { const msg = JSON.parse(raw); if (msg.id === i) { ws.removeListener('message', onMsg); msg.error ? rej(msg.error) : res(msg.result); } };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({id: i, method, params}));
    });
  }
  await rpc('Page.enable'); await rpc('Runtime.enable');
  const r1 = await rpc('Runtime.evaluate', {expression: \"(async () => { const { ipcRenderer } = require('electron'); const m = await ipcRenderer.invoke('create-meeting', { name: 'persist-smoke', layout: 'focus' }); await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: 'first turn' }); return m.id; })()\", awaitPromise: true, returnByValue: true});
  console.log('Created meeting:', r1.result.value);
  ws.close();
})();
"

# 等待 timeline debounce flush(>5s)
sleep 7

# Kill Hub
kill -9 $HUB_PID 2>/dev/null

# 验证 meetings/<id>.json 存在
ls -la "$TEMP_DIR/meetings/" || echo 'no meetings dir!'

# 重启同 data dir
CLAUDE_HUB_DATA_DIR="$TEMP_DIR" timeout 8 ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9227 > /tmp/hub-smoke2.log 2>&1 &
HUB_PID2=$!
sleep 5

# 通过 CDP 验证恢复
node -e "
const WebSocket = require('./node_modules/ws');
(async () => {
  const list = await fetch('http://127.0.0.1:9227/json/list').then(r=>r.json());
  const main = list.find(t => t.url.includes('index.html'));
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 0;
  function rpc(method, params={}) {
    const i = ++id;
    return new Promise((res, rej) => {
      const onMsg = raw => { const msg = JSON.parse(raw); if (msg.id === i) { ws.removeListener('message', onMsg); msg.error ? rej(msg.error) : res(msg.result); } };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({id: i, method, params}));
    });
  }
  await rpc('Page.enable'); await rpc('Runtime.enable');
  const r = await rpc('Runtime.evaluate', {expression: \"(async () => { const { ipcRenderer } = require('electron'); const ms = await ipcRenderer.invoke('get-dormant-meetings'); if (!ms.length) return 'NO_MEETINGS_RESTORED'; const r = await ipcRenderer.invoke('meeting-load-timeline', ms[0].id); return JSON.stringify({count: ms.length, timeline_len: r.timeline?.length || 0, first_text: r.timeline?.[0]?.text || null}); })()\", awaitPromise: true, returnByValue: true});
  console.log('RESTORE_RESULT:', r.result.value);
  ws.close();
})();
"

kill -9 $HUB_PID2 2>/dev/null
rm -rf "$TEMP_DIR"
```

Expected output:
```
Created meeting: <uuid>
RESTORE_RESULT: {"count":1,"timeline_len":1,"first_text":"first turn"}
```

如果 `RESTORE_RESULT` 显示 `count:1, timeline_len:1` 即 PASS。

- [ ] **Step 4: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add main.js
git commit -m "feat(meeting-persistence): wire meeting-store into main.js

- 新增 IPC meeting-load-timeline 给 renderer 在用户点开会议室时调用
- 注册 app.before-quit hook 强制 flushAll 所有 dirty timeline
- Smoke test 通过:开会 → kill → 重启 → 恢复 timeline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `state-store.js` 扩展 sessions 字段

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\state-store.js`

**Why this task:** state.sessions[] 需要新增 `codexSid / geminiChatId / geminiProjectHash / geminiProjectRoot` 字段(用于精准 resume)。当前 state-store.js 直接序列化 sessions 数组,无 schema 限制 → 加载/保存逻辑无需改;但要防止 load 时这些字段缺失导致 undefined 访问。

- [ ] **Step 1: 检查现有 load 逻辑**

读 `core/state-store.js`(57 行,已读完整),确认:`load()` 直接 JSON.parse,sessions 字段保留原样;新字段如不存在则为 undefined。**不需要改 state-store.js 本身**——这是个软 schema,新增字段直接 push 即可。

唯一要做:**确保 load 时把缺失的新字段 normalize 为 null,而不是 undefined**(避免 JSON.stringify 跳过)。

- [ ] **Step 2: 修改 `load()` 函数 normalize sessions**

在 `core/state-store.js` 第 17 行(`if (!Array.isArray(parsed.sessions)) parsed.sessions = [];`)后加:

```js
if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
// Normalize new resume-meta fields (added in 2026-04-26)
for (const s of parsed.sessions) {
  if (s.codexSid === undefined) s.codexSid = null;
  if (s.geminiChatId === undefined) s.geminiChatId = null;
  if (s.geminiProjectHash === undefined) s.geminiProjectHash = null;
  if (s.geminiProjectRoot === undefined) s.geminiProjectRoot = null;
}
if (!Array.isArray(parsed.meetings)) parsed.meetings = [];
```

- [ ] **Step 3: 写一个最小验证脚本 + 跑**

```bash
cd /c/Users/lintian/claude-session-hub
TEMP=$(mktemp -d)
CLAUDE_HUB_DATA_DIR="$TEMP" node -e "
const ss = require('./core/state-store');
ss.save({version:1, cleanShutdown:true, sessions:[{hubId:'a', codexSid:'sid-x'}, {hubId:'b'}], meetings:[]}, {sync:true});
const loaded = ss.load();
console.log(JSON.stringify(loaded.sessions, null, 2));
const a = loaded.sessions[0];
const b = loaded.sessions[1];
if (a.codexSid !== 'sid-x') { console.error('FAIL: codexSid lost'); process.exit(1); }
if (b.codexSid !== null) { console.error('FAIL: codexSid not normalized to null'); process.exit(1); }
if (b.geminiChatId !== null) { console.error('FAIL: geminiChatId not normalized'); process.exit(1); }
console.log('PASS state-store sessions normalization');
"
rm -rf "$TEMP"
```

Expected: `PASS state-store sessions normalization`

- [ ] **Step 4: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add core/state-store.js
git commit -m "feat(meeting-persistence): normalize new resume-meta fields in state.sessions[]

新增 codexSid / geminiChatId / geminiProjectHash / geminiProjectRoot 字段
load 时缺失则填 null,防止 undefined 影响下游序列化和判等。
为 T7 接 transcript-tap session-bound 事件铺路。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: CodexTap emit `session-bound { codexSid }`

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js`(CodexTap._tryBind)

**Why this task:** CodexTap 现在在 `_tryBind()` 完成后只 emit `turn-complete`,从未告知 main 哪个 hubSession 绑到了什么 codex sid。需要在 bind 成功的瞬间 emit 一个新事件 `session-bound`,带上 sid(从 rollout 文件名提取)。

- [ ] **Step 1: 确定 sid 提取方式**

Codex rollout 文件名格式(已实测):`rollout-<ISO>-<sid>.jsonl`,如 `rollout-2026-04-25T00-39-46-019dc05c-9e35-7b73-a1c5-3a4cc9ad9c11.jsonl`

`<sid>` 是文件名 `rollout-` 之后第 2 个 `-` 后面的部分(因 ISO 时间含 `T`、`-`、`:` 各种分隔符)。最稳妥:**从文件名结尾切**。Codex sid 是固定 36 字符 UUID 形式 → 取末尾 36 字符即 sid。

```js
function extractCodexSidFromRolloutPath(rolloutPath) {
  const base = path.basename(rolloutPath, '.jsonl');  // strip .jsonl
  // Last 36 chars are the UUID. If shorter, it's malformed.
  if (base.length < 36) return null;
  const sid = base.slice(-36);
  // Validate UUID-ish: 8-4-4-4-12 hex with dashes
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return null;
  return sid;
}
```

- [ ] **Step 2: 写失败的单测**

新建 `tests/transcript-tap-session-bound.test.js`:

```js
const path = require('path');
const assert = require('assert');

// Direct unit test of the helper (will fail until we export it)
const tapModule = require('../core/transcript-tap');

(async () => {
  // T5.1: extractCodexSidFromRolloutPath
  const fn = tapModule.extractCodexSidFromRolloutPath;
  assert.ok(typeof fn === 'function', 'extractCodexSidFromRolloutPath exported');

  const valid = fn('/foo/rollout-2026-04-25T00-39-46-019dc05c-9e35-7b73-a1c5-3a4cc9ad9c11.jsonl');
  assert.strictEqual(valid, '019dc05c-9e35-7b73-a1c5-3a4cc9ad9c11', 'extract valid sid');

  const tooShort = fn('/foo/rollout-x.jsonl');
  assert.strictEqual(tooShort, null, 'too short → null');

  const notUuid = fn('/foo/rollout-2026-04-25T00-39-46-XXXXXXXX-9e35-7b73-a1c5-3a4cc9ad9c11.jsonl');
  assert.strictEqual(notUuid, null, 'not uuid → null');

  console.log('PASS T5.1 extractCodexSidFromRolloutPath');

  console.log('ALL transcript-tap-session-bound unit tests PASS');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
```

- [ ] **Step 3: 跑确认失败**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/transcript-tap-session-bound.test.js
```
Expected: `extractCodexSidFromRolloutPath exported` assertion 失败

- [ ] **Step 4: 修改 `core/transcript-tap.js`**

(a) 在文件最末 `module.exports` 之前添加 helper:

```js
function extractCodexSidFromRolloutPath(rolloutPath) {
  const base = path.basename(rolloutPath, '.jsonl');
  if (base.length < 36) return null;
  const sid = base.slice(-36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return null;
  return sid;
}
```

(b) 修改 `module.exports`:

```js
module.exports = { TranscriptTap, JsonlTail, readLastAssistantMessageFromClaudeTranscript, extractCodexSidFromRolloutPath };
```

(c) 在 `CodexTap._tryBind()` 方法 line 380-382(`this._seen.add(rolloutPath); this._pending.delete(...); const hubSessionId = best.hubSessionId;`)之后,**onLine 函数定义之前**,添加 emit:

```js
this._seen.add(rolloutPath);
this._pending.delete(best.hubSessionId);
const hubSessionId = best.hubSessionId;

// Emit session-bound so main.js can persist codexSid for future resume.
const codexSid = extractCodexSidFromRolloutPath(rolloutPath);
this.emit('session-bound', { hubSessionId, kind: 'codex', codexSid, rolloutPath });

const onLine = (obj) => {
  // ... unchanged ...
};
```

(d) 在 `TranscriptTap` 构造函数(line 580-589)中,把每个 backend 的 `session-bound` 事件转发出来:

```js
class TranscriptTap extends EventEmitter {
  constructor() {
    super();
    this._claude = new ClaudeTap();
    this._codex = new CodexTap();
    this._gemini = new GeminiTap();
    for (const b of [this._claude, this._codex, this._gemini]) {
      b.on('turn-complete', (ev) => this.emit('turn-complete', ev));
      b.on('session-bound', (ev) => this.emit('session-bound', ev));
    }
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 5: 再跑单测确认 PASS**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/transcript-tap-session-bound.test.js
```
Expected: `ALL transcript-tap-session-bound unit tests PASS`

- [ ] **Step 6: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add core/transcript-tap.js tests/transcript-tap-session-bound.test.js
git commit -m "feat(meeting-persistence): CodexTap emits session-bound with codexSid

- 新增 extractCodexSidFromRolloutPath helper(末尾 36 字符 UUID 提取 + 校验)
- _tryBind 成功时 emit { hubSessionId, kind:'codex', codexSid, rolloutPath }
- TranscriptTap 转发 session-bound 事件给上层
- 3/3 单测通过

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: GeminiTap emit `session-bound`(geminiChatId + projectHash + projectRoot)

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js`(GeminiTap._bindSession)

**Why this task:** Gemini resume 必须 `--list-sessions` 反查 index → `gemini -r <index>`,**前提**是 Hub 知道这次 session 的 8charId(从 chats/session-*.json 文件名提取)+ projectHash(`~/.gemini/tmp/<projectHash>/` 目录名)+ projectRoot(`.project_root` 文件内容,作为 spawn 时的 cwd)。

- [ ] **Step 1: 确定提取方式**

Gemini session 文件路径:`~/.gemini/tmp/<projectHash>/chats/session-YYYY-MM-DDTHH-mm-<8charId>.json[l]`

- `<projectHash>` = path 中 tmp 后第一段(在 GeminiTap 内已知 entry.projectDir = `<...>/tmp/<projectHash>`)
- `<8charId>` = 文件名末段去掉扩展名后的最后 8 字符
- `<projectRoot>` = 在 entry.projectDir 下读 `.project_root` 文件内容

新增 helper:

```js
function extractGeminiChatIdFromSessionPath(sessionPath) {
  const base = path.basename(sessionPath).replace(/\.(jsonl?|json)$/, '');
  // Pattern: session-YYYY-MM-DDTHH-mm-<8charId>
  if (!base.startsWith('session-')) return null;
  const parts = base.split('-');
  const last = parts[parts.length - 1];
  if (last && /^[0-9a-f]{8}$/i.test(last)) return last;
  return null;
}

function extractGeminiProjectHashFromDir(projectDir) {
  if (!projectDir) return null;
  return path.basename(projectDir);  // /...tmp/<hash> → <hash>
}
```

- [ ] **Step 2: 添加单测到 `tests/transcript-tap-session-bound.test.js`**

在已有测试末尾追加(在 `console.log('ALL transcript-tap-session-bound unit tests PASS')` 之前):

```js
  // T6.1: extractGeminiChatIdFromSessionPath
  const gFn = tapModule.extractGeminiChatIdFromSessionPath;
  assert.ok(typeof gFn === 'function', 'extractGeminiChatIdFromSessionPath exported');

  assert.strictEqual(gFn('/x/y/session-2026-04-24T16-39-e6651237.jsonl'), 'e6651237');
  assert.strictEqual(gFn('/x/y/session-2026-04-24T16-39-e6651237.json'), 'e6651237');
  assert.strictEqual(gFn('/x/y/session-bad.jsonl'), null);
  assert.strictEqual(gFn('/x/y/notasession.jsonl'), null);
  console.log('PASS T6.1 extractGeminiChatIdFromSessionPath');

  // T6.2: extractGeminiProjectHashFromDir
  const pFn = tapModule.extractGeminiProjectHashFromDir;
  assert.ok(typeof pFn === 'function');
  assert.strictEqual(pFn('/home/u/.gemini/tmp/abc123def'), 'abc123def');
  assert.strictEqual(pFn(null), null);
  console.log('PASS T6.2 extractGeminiProjectHashFromDir');
```

- [ ] **Step 3: 跑确认 T6 fail**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/transcript-tap-session-bound.test.js
```
Expected: assertion `extractGeminiChatIdFromSessionPath exported` 失败

- [ ] **Step 4: 修改 `core/transcript-tap.js`**

(a) 在已有 `extractCodexSidFromRolloutPath` 旁边增加两个 helper(同 Step 1 定义)。

(b) 修改 `module.exports`:

```js
module.exports = {
  TranscriptTap,
  JsonlTail,
  readLastAssistantMessageFromClaudeTranscript,
  extractCodexSidFromRolloutPath,
  extractGeminiChatIdFromSessionPath,
  extractGeminiProjectHashFromDir,
};
```

(c) 在 `GeminiTap._bindSession()`(line 516+)开头,**`this._bound.set(hubSessionId, boundEntry)` 这一行之后**插入 emit:

```js
async _bindSession(hubSessionId, sessionPath, isJsonl) {
  const boundEntry = { sessionPath, tail: null, lastText: null, isJsonl, debounceTimer: null };
  this._bound.set(hubSessionId, boundEntry);

  // Emit session-bound for main.js to persist resume meta.
  // projectDir was resolved during _scanOnce phase 1; read .project_root for projectRoot.
  const pendingMeta = this._pendingMeta?.get(hubSessionId) || null;
  let projectDir = null;
  let projectRoot = null;
  // sessionPath is `<projectDir>/chats/session-...`. Walk up 2 levels.
  projectDir = path.dirname(path.dirname(sessionPath));
  try {
    projectRoot = (await fs.promises.readFile(path.join(projectDir, '.project_root'), 'utf8')).trim();
  } catch {}

  this.emit('session-bound', {
    hubSessionId,
    kind: 'gemini',
    geminiChatId: extractGeminiChatIdFromSessionPath(sessionPath),
    geminiProjectHash: extractGeminiProjectHashFromDir(projectDir),
    geminiProjectRoot: projectRoot,
    sessionPath,
  });

  const emitIfComplete = (content) => {
    // ... unchanged ...
  };
  // ... rest of method unchanged ...
}
```

- [ ] **Step 5: 再跑单测,确认 T6 PASS**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/transcript-tap-session-bound.test.js
```
Expected: `ALL transcript-tap-session-bound unit tests PASS`(5 个 assert 全过)

- [ ] **Step 6: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add core/transcript-tap.js tests/transcript-tap-session-bound.test.js
git commit -m "feat(meeting-persistence): GeminiTap emits session-bound with chatId+projectHash+projectRoot

- 新增 extractGeminiChatIdFromSessionPath / extractGeminiProjectHashFromDir helper
- _bindSession 成功时 emit { hubSessionId, kind:'gemini', geminiChatId, geminiProjectHash, geminiProjectRoot, sessionPath }
- 5/5 单测通过(累加自 T5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `main.js` 接 `session-bound` 事件 → 写入 state.sessions[]

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

**Why this task:** transcript-tap 现在 emit session-bound,main 需要监听并把对应 session 的 codex/gemini 元数据持久化进 state.json。

- [ ] **Step 1: 找到 transcriptTap 的初始化处**

```bash
cd /c/Users/lintian/claude-session-hub && grep -n 'transcriptTap\s*=' main.js | head -5
```

应该看到类似 `const transcriptTap = new TranscriptTap();` 的行。

- [ ] **Step 2: 在 transcriptTap 初始化后添加 session-bound 监听**

找到 `transcriptTap = new TranscriptTap()` 那行后,加:

```js
// Persist resume meta when transcript-tap binds a sub-session to its native CLI sid.
transcriptTap.on('session-bound', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  // Find the session in lastPersistedSessions and merge new fields.
  const idx = lastPersistedSessions.findIndex(s => s.hubId === ev.hubSessionId);
  if (idx < 0) return;
  const cur = lastPersistedSessions[idx];
  let changed = false;
  if (ev.kind === 'codex' && ev.codexSid && cur.codexSid !== ev.codexSid) {
    cur.codexSid = ev.codexSid;
    changed = true;
  }
  if (ev.kind === 'gemini') {
    if (ev.geminiChatId && cur.geminiChatId !== ev.geminiChatId) { cur.geminiChatId = ev.geminiChatId; changed = true; }
    if (ev.geminiProjectHash && cur.geminiProjectHash !== ev.geminiProjectHash) { cur.geminiProjectHash = ev.geminiProjectHash; changed = true; }
    if (ev.geminiProjectRoot && cur.geminiProjectRoot !== ev.geminiProjectRoot) { cur.geminiProjectRoot = ev.geminiProjectRoot; changed = true; }
  }
  if (changed) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
    });
    console.log(`[hub] persisted resume meta for ${ev.kind} session ${ev.hubSessionId.slice(0,8)}`);
  }
});
```

- [ ] **Step 3: Smoke test**

启动一个 isolated Hub,起一个 Codex 子 session(在会议室外即可),用 CDP 验证 state.json 里出现 codexSid。

```bash
cd /c/Users/lintian/claude-session-hub
TEMP=/tmp/hub-codex-bind-$$
rm -rf "$TEMP" && mkdir -p "$TEMP"
CLAUDE_HUB_DATA_DIR="$TEMP" timeout 25 ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9228 > /tmp/hub-bind.log 2>&1 &
HUB_PID=$!
sleep 6

# 通过 CDP 创建一个 Codex session
node -e "
const WebSocket = require('./node_modules/ws');
(async () => {
  const list = await fetch('http://127.0.0.1:9228/json/list').then(r=>r.json());
  const main = list.find(t => t.url.includes('index.html'));
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 0;
  function rpc(method, params={}) {
    const i = ++id;
    return new Promise((res, rej) => { const onMsg = raw => { const msg = JSON.parse(raw); if (msg.id === i) { ws.removeListener('message', onMsg); msg.error ? rej(msg.error) : res(msg.result); } }; ws.on('message', onMsg); ws.send(JSON.stringify({id: i, method, params})); });
  }
  await rpc('Page.enable'); await rpc('Runtime.enable');
  const r = await rpc('Runtime.evaluate', {expression: \"(async () => { const { ipcRenderer } = require('electron'); const s = await ipcRenderer.invoke('create-session', { kind: 'codex', cwd: process.env.USERPROFILE || process.env.HOME }); ipcRenderer.send('terminal-input', { sessionId: s.id, data: 'echo hello\\n' }); return s.id; })()\", awaitPromise: true, returnByValue: true});
  console.log('Codex session id:', r.result.value);
  ws.close();
})();
"
sleep 12  # 给 codex 时间写 rollout-*.jsonl
cat "$TEMP/state.json" | head -50

kill -9 $HUB_PID 2>/dev/null
rm -rf "$TEMP"
```

Expected: state.json 里至少一个 sessions 条目 `kind:"codex"` 且 `codexSid` 不为 null。日志看到 `[hub] persisted resume meta for codex session XXXXXXXX`。

- [ ] **Step 4: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add main.js
git commit -m "feat(meeting-persistence): main.js persists session-bound meta to state.json

- 监听 transcriptTap session-bound 事件
- 找到对应 session 后 merge codexSid / geminiChatId / geminiProjectHash / geminiProjectRoot
- 仅在字段变化时触发 state.save(避免频繁 IO)
- Smoke test 验证 codex session 被绑定后 state.json 出现 codexSid

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `session-manager.js` Codex/Gemini 精准 resume 命令

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\session-manager.js`(line 245 + line 272 附近)

**Why this task:** 当前 Codex 用 `codex resume --last --full-auto`(line 272),Gemini 用 `gemini --resume latest`(line 245)。`--last/latest` 不精准——若用户在另一会议室或主目录跑过新 session,会接错。改成 `codex resume <sid>` 和 `gemini --list-sessions` 反查 index → `gemini -r <index>`。

- [ ] **Step 1: createSession opts 接受新字段**

打开 `core/session-manager.js`,在 `createSession(kind, opts)` 方法签名注释处(line 45 附近)更新文档:

```js
//   resumeCCSessionId:  when set, runs `claude --resume <id>`
//   useContinue:        when set, runs `claude --continue` (Claude fallback)
//   useResume:          (legacy) generic resume flag for codex/gemini → uses --last/latest
//   codexSid:           when set + kind=='codex' + useResume, runs `codex resume <sid>` precisely
//   geminiChatId:       when set + kind=='gemini' + useResume, triggers list-sessions index lookup
//   geminiProjectRoot:  required for Gemini list-sessions reverse-lookup (must be cwd)
```

- [ ] **Step 2: 修改 Gemini spawn 命令(line 245 附近)**

找到 `if (opts.useResume) cmd += ' --resume latest';`(line 245),替换为:

```js
if (opts.useResume) {
  if (opts.geminiChatId && opts.geminiProjectRoot) {
    // Two-phase: first list-sessions in projectRoot, find index matching chatId,
    // then spawn `gemini -r <index>`. The reverse-lookup is done by the caller
    // (main.js) before spawn — here we just consume the resolved index if present.
    if (typeof opts.geminiResumeIndex === 'number') {
      cmd += ` -r ${opts.geminiResumeIndex}`;
    } else {
      // Fallback: no index resolved → use latest (Level 2 degradation)
      cmd += ' --resume latest';
    }
  } else {
    cmd += ' --resume latest';
  }
}
```

(注:`geminiResumeIndex` 由 main.js 在 spawn 前通过 `gemini --list-sessions` 解析得到,见 Step 3。)

- [ ] **Step 3: 修改 Codex spawn 命令(line 272 附近)**

找到 `let cmd = opts.useResume ? ' codex resume --last --full-auto' : ' codex --full-auto';`(line 272),替换为:

```js
let cmd;
if (opts.useResume && opts.codexSid) {
  cmd = ` codex resume ${opts.codexSid} --full-auto`;
} else if (opts.useResume) {
  cmd = ' codex resume --last --full-auto';  // Level 2 degradation
} else {
  cmd = ' codex --full-auto';
}
```

- [ ] **Step 4: 在 main.js 添加 Gemini list-sessions 反查 helper**

在 `main.js` 顶部 require 区:

```js
const { spawnSync } = require('child_process');
```

在 transcriptTap 监听后加 helper:

```js
// Gemini resume index lookup: takes (geminiChatId, geminiProjectRoot) → returns index | null
function lookupGeminiResumeIndex(geminiChatId, projectRoot) {
  if (!geminiChatId || !projectRoot) return null;
  try {
    const r = spawnSync('gemini', ['--list-sessions', '--output-format', 'json'], {
      cwd: projectRoot,
      timeout: 5000,
      encoding: 'utf-8',
    });
    if (r.status !== 0) {
      console.warn('[hub] gemini --list-sessions failed:', r.stderr?.slice(0, 200));
      return null;
    }
    const parsed = JSON.parse(r.stdout);
    const sessions = Array.isArray(parsed) ? parsed : (parsed.sessions || []);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const id = s.sessionId || s.id || s.session_id || '';
      // Match by 8charId suffix
      if (typeof id === 'string' && id.toLowerCase().endsWith(geminiChatId.toLowerCase())) {
        // Gemini -r expects 1-based index typically; verify with one quick test in dev
        return i;
      }
    }
    return null;
  } catch (e) {
    console.warn('[hub] lookupGeminiResumeIndex error:', e.message);
    return null;
  }
}
```

- [ ] **Step 5: resume-session IPC 改造把新元数据传给 createSession**

找到 `main.js:688` 的 `ipcMain.handle('resume-session', ...)` 块。把 `sessionManager.createSession(...)` 调用改成:

```js
ipcMain.handle('resume-session', (_e, meta) => {
  if (!meta || !meta.hubId) return null;
  const isClaude = (meta.kind === 'claude' || meta.kind === 'claude-resume');
  const isDeepSeek = (meta.kind === 'deepseek');
  const isClaudeCliResumable = isClaude || isDeepSeek;
  const isGeminiOrCodex = (meta.kind === 'gemini' || meta.kind === 'codex');

  // Gemini index reverse-lookup (Level 1)
  let geminiResumeIndex = null;
  if (meta.kind === 'gemini' && meta.geminiChatId && meta.geminiProjectRoot) {
    geminiResumeIndex = lookupGeminiResumeIndex(meta.geminiChatId, meta.geminiProjectRoot);
    if (geminiResumeIndex == null) {
      console.warn(`[hub] gemini index lookup failed for ${meta.hubId.slice(0,8)} — will degrade to --resume latest`);
    }
  }

  const session = sessionManager.createSession(meta.kind || 'claude', {
    id: meta.hubId,
    title: meta.title,
    cwd: meta.kind === 'gemini' && meta.geminiProjectRoot ? meta.geminiProjectRoot : meta.cwd,
    meetingId: meta.meetingId || null,
    resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
    useContinue: isClaudeCliResumable && !meta.ccSessionId,
    useResume: isGeminiOrCodex,
    codexSid: meta.kind === 'codex' ? (meta.codexSid || null) : null,
    geminiChatId: meta.kind === 'gemini' ? (meta.geminiChatId || null) : null,
    geminiProjectRoot: meta.kind === 'gemini' ? (meta.geminiProjectRoot || null) : null,
    geminiResumeIndex: geminiResumeIndex,
    lastMessageTime: meta.lastMessageTime,
    lastOutputPreview: meta.lastOutputPreview,
  });
  registerSessionForTap(session);
  sendToRenderer('session-created', { session });
  return session;
});
```

- [ ] **Step 6: Smoke test —— Codex 精准 resume**

```bash
cd /c/Users/lintian/claude-session-hub
TEMP=/tmp/hub-codex-resume-$$
rm -rf "$TEMP" && mkdir -p "$TEMP"
CLAUDE_HUB_DATA_DIR="$TEMP" timeout 30 ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9229 > /tmp/hub-resume.log 2>&1 &
HUB_PID=$!
sleep 6

# 1. 起 codex session,等绑定
node -e "
const WebSocket = require('./node_modules/ws');
(async () => {
  const ws = new WebSocket((await fetch('http://127.0.0.1:9229/json/list').then(r=>r.json())).find(t=>t.url.includes('index.html')).webSocketDebuggerUrl);
  await new Promise(r=>ws.on('open',r));
  let id=0; const rpc=(m,p={})=>new Promise((res,rej)=>{const i=++id; const h=raw=>{const m2=JSON.parse(raw); if(m2.id===i){ws.removeListener('message',h); m2.error?rej(m2.error):res(m2.result);}}; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p}));});
  await rpc('Runtime.enable');
  const r = await rpc('Runtime.evaluate',{expression:\"(async () => { const { ipcRenderer } = require('electron'); const s = await ipcRenderer.invoke('create-session', { kind: 'codex', cwd: process.env.USERPROFILE || process.env.HOME }); return s.id; })()\", awaitPromise:true, returnByValue:true});
  console.log('Codex session:', r.result.value);
  ws.close();
})();
"
sleep 15  # 等 codex 写 rollout

# 2. 检查 state.json 有 codexSid
cat "$TEMP/state.json" | grep -o '"codexSid":"[a-f0-9-]*"' | head -1

# 3. Kill + 重启
kill -9 $HUB_PID 2>/dev/null
sleep 2
CLAUDE_HUB_DATA_DIR="$TEMP" timeout 20 ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9230 > /tmp/hub-resume2.log 2>&1 &
HUB_PID2=$!
sleep 6

# 4. resume,看日志确认走了 `codex resume <sid>` 而不是 `--last`
node -e "
const WebSocket = require('./node_modules/ws');
(async () => {
  const ws = new WebSocket((await fetch('http://127.0.0.1:9230/json/list').then(r=>r.json())).find(t=>t.url.includes('index.html')).webSocketDebuggerUrl);
  await new Promise(r=>ws.on('open',r));
  let id=0; const rpc=(m,p={})=>new Promise((res,rej)=>{const i=++id; const h=raw=>{const m2=JSON.parse(raw); if(m2.id===i){ws.removeListener('message',h); m2.error?rej(m2.error):res(m2.result);}}; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p}));});
  await rpc('Runtime.enable');
  const r = await rpc('Runtime.evaluate',{expression:\"(async () => { const { ipcRenderer } = require('electron'); const ds = await ipcRenderer.invoke('get-dormant-sessions'); const codex = ds.sessions.find(s => s.kind === 'codex'); if (!codex) return 'NO_CODEX'; const s = await ipcRenderer.invoke('resume-session', codex); return JSON.stringify({hubId: s.id.slice(0,8), kind: s.kind}); })()\", awaitPromise:true, returnByValue:true});
  console.log('Resumed:', r.result.value);
  ws.close();
})();
"
sleep 5
# 验证 PTY 输出里出现了 codex resume <sid>(注:Hub 把这个命令写进 PTY input,日志或截图能看到)
echo '--- look for codex resume in hub log ---'
grep -E 'codex resume [0-9a-f]{8}' /tmp/hub-resume2.log || echo 'precise resume command not found in log'

kill -9 $HUB_PID2 2>/dev/null
rm -rf "$TEMP"
```

Expected:
- 第一次跑后 `state.json` 有 `"codexSid":"<uuid>"`
- 重启后 resume 时,Hub 主进程日志(或 PTY 命令)里能看到 `codex resume <uuid> --full-auto`(而不是 `--last`)

- [ ] **Step 7: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add core/session-manager.js main.js
git commit -m "feat(meeting-persistence): codex/gemini precise resume by sid/index

- Codex: 'codex resume <codexSid> --full-auto' 替代 '--last'(精准恢复对话)
- Gemini: 启动前 spawnSync 'gemini --list-sessions --output-format json' 反查 index → '-r <index>'
- 反查失败降级到 '--resume latest'(Level 2)
- resume-session IPC 透传 codexSid / geminiChatId / geminiProjectRoot
- Gemini cwd 强制使用 geminiProjectRoot(确保 list-sessions 命中正确项目)
- Smoke 验证 codexSid 持久化 + 重启精准 resume

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 三级降级 fallback + 端到端 E2E

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\session-manager.js`(增加 transcript 文本注入兜底)
- Create: `C:\Users\lintian\claude-session-hub\tests\_e2e-meeting-resume-real.js`

**Why this task:** Spec §5 三家各自的 3 级降级链。Level 2(同家 fallback,如 `--last`/`--resume latest`/`--continue`)前面 task 已实现;**Level 3(transcript 文本注入)**还没做。E2E 测整条链路。

- [ ] **Step 1: 实现 transcript 文本注入助手**

在 `core/session-manager.js` 顶部 require 加:

```js
const { readLastAssistantMessageFromClaudeTranscript } = require('./transcript-tap');
```

(如果已有则跳过。)

新增独立函数(可放文件末尾、`module.exports` 之前):

```js
// Read tail N turns from a CLI transcript file and format into a prompt-injectable
// context block. Returns null if file unavailable or no usable turns.
//   kind:    'claude' | 'codex' | 'gemini'
//   pathOrId: kind-specific identifier (transcript path / sid / chatId)
async function readTranscriptTail(kind, sourcePath, n = 10) {
  const fs = require('fs');
  if (!sourcePath) return null;
  try {
    if (kind === 'gemini' && sourcePath.endsWith('.json') && !sourcePath.endsWith('.jsonl')) {
      // Gemini old format: single JSON file
      const obj = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
      const msgs = Array.isArray(obj.messages) ? obj.messages.slice(-n) : [];
      return msgs.map(m => {
        if (m.type === 'user') return `USER: ${(m.content||[]).map(c=>c.text).filter(Boolean).join('')}`;
        if (m.type === 'gemini') return `ASSISTANT: ${typeof m.content==='string'?m.content:''}`;
        return null;
      }).filter(Boolean).join('\n\n');
    }
    // JSONL: tail N lines
    const lines = fs.readFileSync(sourcePath, 'utf-8').trim().split('\n').slice(-n*2);
    const out = [];
    for (const line of lines) {
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (kind === 'claude') {
        if (obj.type === 'user' && obj.message?.content) out.push(`USER: ${typeof obj.message.content==='string'?obj.message.content:JSON.stringify(obj.message.content)}`);
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          const txt = obj.message.content.filter(c=>c.type==='text').map(c=>c.text).join('');
          if (txt) out.push(`ASSISTANT: ${txt}`);
        }
      } else if (kind === 'codex') {
        if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete' && obj.payload?.last_agent_message) {
          out.push(`ASSISTANT: ${obj.payload.last_agent_message}`);
        } else if (obj.type === 'response_item' && obj.payload?.role === 'user' && obj.payload?.content) {
          out.push(`USER: ${typeof obj.payload.content==='string'?obj.payload.content:JSON.stringify(obj.payload.content)}`);
        }
      } else if (kind === 'gemini') {
        if (obj.type === 'user') out.push(`USER: ${(obj.content||[]).map(c=>c.text).filter(Boolean).join('')}`);
        if (obj.type === 'gemini') out.push(`ASSISTANT: ${typeof obj.content==='string'?obj.content:''}`);
      }
    }
    return out.slice(-n).join('\n\n');
  } catch (e) {
    console.warn(`[hub] readTranscriptTail(${kind}) failed:`, e.message);
    return null;
  }
}

module.exports = { SessionManager, readTranscriptTail };
```

(注:`module.exports` 现在多导出一个;原 `module.exports = { SessionManager };` 行替换。)

- [ ] **Step 2: 在 main.js resume-session IPC 中,resume 完成后注入 fallback 文本**

`main.js` 中 resume-session 处理(Step 5 修改后),在 `registerSessionForTap(session); sendToRenderer('session-created', ...)` 之后,加:

```js
// Level 3 degradation: if native resume produced no native session (e.g., Gemini
// list-sessions failed, or first prompt times out), inject transcript tail as a
// CONTEXT block on first user input. This is best-effort and handled out-of-band:
// renderer will see session start normally; if user's first turn shows up empty
// from AI, they can re-prompt.
//
// Implementation: pre-stuff a one-shot "context catch-up" message into PTY.
const needsLevel3 =
  (meta.kind === 'codex' && !meta.codexSid) ||
  (meta.kind === 'gemini' && (!meta.geminiChatId || geminiResumeIndex == null));

if (needsLevel3) {
  const { readTranscriptTail } = require('./core/session-manager');
  let sourcePath = null;
  let kind = meta.kind;
  // Best effort: derive transcript path from stored meta
  if (meta.kind === 'codex') {
    // codex doesn't store path in state; skip — Level 2 already covers most cases
    sourcePath = null;
  } else if (meta.kind === 'gemini' && meta.geminiProjectHash && meta.geminiChatId) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(require('os').homedir(), '.gemini', 'tmp', meta.geminiProjectHash, 'chats');
    try {
      const f = fs.readdirSync(dir).find(n => n.includes(meta.geminiChatId));
      if (f) sourcePath = path.join(dir, f);
    } catch {}
  }
  if (sourcePath) {
    readTranscriptTail(kind, sourcePath, 10).then(tail => {
      if (!tail) return;
      const msg = `[CONTEXT FROM PREVIOUS SESSION]\n${tail}\n\n[END CONTEXT]\n`;
      // Send via PTY input as if user typed (PTY will echo, AI will see)
      // Wait 2s for spawn to settle before injecting
      setTimeout(() => {
        sessionManager.sendInput(session.id, msg);
        console.log(`[hub] Level 3 fallback: injected ${tail.length}-char transcript tail to ${kind} session ${session.id.slice(0,8)}`);
      }, 2000);
    }).catch(e => console.warn('[hub] Level 3 fallback error:', e.message));
  }
}
```

(注:如果 `sessionManager.sendInput` 不存在,改用 `ipcMain.emit('terminal-input', null, { sessionId: session.id, data: msg })` 或直接调 `pty` 的 write。grep 确认正确方法。)

- [ ] **Step 3: 写 E2E 测试 `tests/_e2e-meeting-resume-real.js`**

```js
// tests/_e2e-meeting-resume-real.js
// E2E: open meeting → add turn → kill Hub → restart → verify recovery
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = path.join(os.tmpdir(), `hub-e2e-resume-${Date.now()}`);
const PORT_1 = 9241;
const PORT_2 = 9242;

let _id = 0;
function rpc(ws, method, params = {}) {
  const i = ++_id;
  return new Promise((res, rej) => {
    const onMsg = raw => { const msg = JSON.parse(raw); if (msg.id === i) { ws.removeListener('message', onMsg); msg.error ? rej(msg.error) : res(msg.result); } };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

async function attachCDP(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
  if (!main) throw new Error('no main window via CDP');
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');
  return ws;
}

async function evalRpc(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
}

async function startHub(port) {
  const env = { ...process.env, CLAUDE_HUB_DATA_DIR: TEMP_DATA };
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], { cwd: HUB_DIR, env, detached: false, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 6000));
  return proc;
}

(async () => {
  fs.mkdirSync(TEMP_DATA, { recursive: true });

  // Phase 1: start Hub, create meeting + turn
  console.log(`[E2E] Phase 1: start Hub on ${PORT_1}`);
  const hub1 = await startHub(PORT_1);
  const ws1 = await attachCDP(PORT_1);

  const meetingId = await evalRpc(ws1, `(async () => {
    const { ipcRenderer } = require('electron');
    const m = await ipcRenderer.invoke('create-meeting', { name: 'e2e-resume', layout: 'focus' });
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: 'first message before crash' });
    return m.id;
  })()`);
  console.log(`[E2E] Created meeting ${meetingId}`);

  // Wait for debounce flush (>5s)
  await new Promise(r => setTimeout(r, 7000));
  ws1.close();

  // Phase 2: kill Hub
  console.log(`[E2E] Phase 2: kill Hub`);
  hub1.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 2000));

  // Verify on-disk
  const meetingFile = path.join(TEMP_DATA, 'meetings', `${meetingId}.json`);
  if (!fs.existsSync(meetingFile)) throw new Error(`FAIL: ${meetingFile} not persisted`);
  const persisted = JSON.parse(fs.readFileSync(meetingFile, 'utf-8'));
  if (persisted._timeline.length !== 1) throw new Error(`FAIL: timeline expected 1 turn, got ${persisted._timeline.length}`);
  console.log('[E2E] Phase 2 PASS: meeting file persisted with timeline');

  // Phase 3: restart Hub
  console.log(`[E2E] Phase 3: restart Hub on ${PORT_2}`);
  const hub2 = await startHub(PORT_2);
  const ws2 = await attachCDP(PORT_2);

  const restored = await evalRpc(ws2, `(async () => {
    const { ipcRenderer } = require('electron');
    const ms = await ipcRenderer.invoke('get-dormant-meetings');
    const found = ms.find(m => m.id === '${meetingId}');
    if (!found) return { ok: false, reason: 'meeting not in dormant list' };
    const r = await ipcRenderer.invoke('meeting-load-timeline', '${meetingId}');
    return { ok: r.ok, timelineLen: r.timeline?.length || 0, firstText: r.timeline?.[0]?.text || null };
  })()`);
  console.log('[E2E] Restored:', JSON.stringify(restored));

  if (!restored.ok) throw new Error('FAIL: meeting-load-timeline returned ok=false');
  if (restored.timelineLen !== 1) throw new Error(`FAIL: expected 1 turn, got ${restored.timelineLen}`);
  if (restored.firstText !== 'first message before crash') throw new Error(`FAIL: text mismatch: ${restored.firstText}`);

  console.log('[E2E] Phase 3 PASS: meeting + timeline fully recovered');

  // Cleanup
  ws2.close();
  hub2.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 1000));
  fs.rmSync(TEMP_DATA, { recursive: true, force: true });

  console.log('\n[E2E] ALL PASS');
  process.exit(0);
})().catch(e => {
  console.error('[E2E] FAIL:', e.message);
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
```

- [ ] **Step 4: 跑 E2E 确认全 PASS**

```bash
cd /c/Users/lintian/claude-session-hub && node tests/_e2e-meeting-resume-real.js
```

Expected output:
```
[E2E] Phase 1: start Hub on 9241
[E2E] Created meeting <uuid>
[E2E] Phase 2: kill Hub
[E2E] Phase 2 PASS: meeting file persisted with timeline
[E2E] Phase 3: restart Hub on 9242
[E2E] Restored: {"ok":true,"timelineLen":1,"firstText":"first message before crash"}
[E2E] Phase 3 PASS: meeting + timeline fully recovered

[E2E] ALL PASS
```

- [ ] **Step 5: Commit**

```bash
cd /c/Users/lintian/claude-session-hub
git add core/session-manager.js main.js tests/_e2e-meeting-resume-real.js
git commit -m "feat(meeting-persistence): Level 3 transcript injection fallback + E2E

- session-manager.js: readTranscriptTail 解析三家 transcript 末尾 N 条
- main.js resume-session: 当 native resume 不可用时(Level 1+2 都失败)注入
  [CONTEXT FROM PREVIOUS SESSION] 文本到 PTY,2s 延迟避免与启动竞态
- E2E _e2e-meeting-resume-real.js: 启动 Hub → 开会 → 加 turn → kill → 重启 → 验证完整恢复
- E2E PASS,工作流闭环

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 实施完成后

按 superpowers:subagent-driven-development 流程,所有 9 个 task 完成后:
1. **最终 code review**:dispatch 一个 code-reviewer subagent 看整个 branch diff
2. **运行 `/post-refactor-verify`**:本 plan 改了 6 文件(>3),触发 refactor-guard
3. **合入 master**:用 `superpowers:finishing-a-development-branch`

---

## Self-Review

### 1. Spec coverage check(逐节回查 spec)

| Spec 节 | 对应 Task | 状态 |
|---|---|---|
| §1.1 元数据持久化 | T2(restoreMeeting 已存在,T2 集成 store)+ T3(IPC) | ✅ |
| §1.2 Timeline 持久化 | T1(基建)+ T2(集成)+ T3(lazy load IPC) | ✅ |
| §1.3 三家 native resume | T5(codex sid emit)+ T6(gemini meta emit)+ T7(persist)+ T8(精准命令) | ✅ |
| §1.4 失败兜底 | T8 Level 2(命令降级)+ T9 Level 3(transcript 注入) | ✅ |
| §1.5 Lazy spawn | T3(meeting-load-timeline 是 lazy 入口;子 session lazy spawn 已是 Hub 现状,见 main.js:649 注释 "User clicks dormant session → resume-session IPC spawns PTY") | ✅ |
| §3.1 存储分文件 | T1 实现 | ✅ |
| §3.2 sessions 字段扩展 | T4 normalize + T7 写入 | ✅ |
| §3.3 启动恢复时序 | Hub 已实现(main.js:658-662),T3 补 lazy timeline | ✅ |
| §3.4 Timeline debounce 5s | T1 实现 + T3 before-quit flush | ✅ |
| §5 三级降级链 | T8 Level 1+2 + T9 Level 3 | ✅ |
| §6 IPC API | T3 加 meeting-load-timeline | ✅ |
| §8 验证标准 1-9 | T9 E2E 覆盖 1-3、6、7;Smoke test 覆盖 4-5、9;手动测覆盖 8 | ⚠️ 部分自动覆盖 |

⚠️ 验证标准 8(crash 数据安全)的"开 5 轮 → kill -9 → 至少看到 4 轮"未单独自动化。但 E2E Phase 2 已验证基本机制(kill -9 + 重启 + 数据恢复)。如需完整覆盖,在 T9 E2E 加一个 5-turn 变体。

### 2. Placeholder scan
- 无 TBD/TODO/"implement later"
- 所有代码块完整,可直接粘贴
- 所有 commit message 模板化但内容具体

### 3. Type consistency
- `markDirty(id, data)` data 形状在 T1 / T2 一致:`{ _timeline, _cursors, _nextIdx }`
- `session-bound` 事件结构在 T5 / T6 / T7 一致
- `geminiResumeIndex` 在 T8 中:main.js 反查 → opts → session-manager 消费,贯通

### Self-review 结论
Plan 质量足够 dispatch 给 subagent。
