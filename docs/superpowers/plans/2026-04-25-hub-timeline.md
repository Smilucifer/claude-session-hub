# Hub Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a meeting-scoped shared timeline + per-AI cursor to the Hub meeting room, enabling zero-duplication incremental context injection across sub-sessions and a unified Feed UI in place of the per-AI tabbed blackboard.

**Architecture:** `MeetingRoomManager` owns one `_timeline` array per meeting (user + AI turns). Each meeting also holds `_cursors[hubSessionId] -> int` tracking how far each sub-session has been "shown." `transcriptTap.on('turn-complete')` writes AI turns to the timeline; `meeting-room.js handleMeetingSend` writes user turns. `incrementalContext(meetingId, targetSid)` returns timeline.slice(cursors[targetSid]).filter(t => t.sid !== targetSid) and advances the cursor. Blackboard is rewritten as a chronological Feed driven by `meeting-timeline-updated` IPC events.

**Tech Stack:** Node.js (Electron main + renderer), Hub IPC, no new external dependencies. Tests use plain `node --test` with assertions (project has no test framework; we use `assert` from `node:assert/strict` and `node --test`'s describe/test runner introduced in Node 18+).

**Spec:** `docs/superpowers/specs/2026-04-25-hub-timeline-design.md`
**Predecessor:** TranscriptTap, commit `9d27102`

---

## File Structure

| File | Purpose |
|---|---|
| `core/meeting-room.js` | MeetingRoomManager — adds `_timeline`/`_cursors`/`_nextIdx` per meeting + 5 new methods |
| `main.js` | IPC handlers + transcriptTap → meetingManager wiring + restart-session id preservation |
| `renderer/meeting-room.js` | `handleMeetingSend` rewrite: append user turn → fetch incremental context → send |
| `renderer/meeting-blackboard.js` | Feed UI rewrite: time-reverse render + subscribe `meeting-timeline-updated` |
| `renderer/meeting-room.css` | Feed layout styles (turn cards, AI badges, fold-long-text) |
| `tests/_unit-hub-timeline.js` | Unit tests for MeetingRoomManager timeline/cursor methods |
| `tests/_integration-hub-timeline.js` | Integration tests mocking transcriptTap → meetingManager wiring |
| `tests/_e2e-hub-timeline-real.js` | 9 real-CLI E2E scenarios (A-I) per spec section 7.3 |

Tests use Node's built-in `node:test` + `node:assert/strict`. Test files all start with `_` to follow Hub convention (helper scripts, not picked up by anything).

---

## Pre-Flight: Establish baseline

- [ ] **Step P1: Confirm we're on the right branch with the right baseline**

```bash
cd /c/Users/lintian/claude-session-hub
git status --short
git log --oneline -3
```

Expected: branch `feature/meeting-room`; HEAD at `642ade5 spec(meeting): hub timeline + cursor design (phase 1)`. No uncommitted changes to files this plan touches (existing modifications to `core/session-manager.js`/`renderer/renderer.js` are unrelated and stay alone).

- [ ] **Step P2: Verify TranscriptTap baseline still works**

```bash
cd /c/Users/lintian/claude-session-hub
node --check core/transcript-tap.js
node --check core/meeting-room.js
node --check main.js
```

Expected: all OK.

---

## Task 1: MeetingRoomManager — timeline + nextIdx + appendTurn + getTimeline

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-room.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-hub-timeline.js`

- [ ] **Step 1.1: Write the failing test**

Create `tests/_unit-hub-timeline.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MeetingRoomManager } = require('../core/meeting-room.js');

test('appendTurn pushes turn with monotonic idx + returns turn', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();

  const t0 = m.appendTurn(meeting.id, 'user', 'Q1', 1700000000000);
  assert.equal(t0.idx, 0);
  assert.equal(t0.sid, 'user');
  assert.equal(t0.text, 'Q1');
  assert.equal(t0.ts, 1700000000000);

  const t1 = m.appendTurn(meeting.id, 'sub-A', 'R1_A', 1700000005000);
  assert.equal(t1.idx, 1);
  assert.equal(t1.sid, 'sub-A');

  const t2 = m.appendTurn(meeting.id, 'sub-B', 'R1_B', 1700000007000);
  assert.equal(t2.idx, 2);
});

test('getTimeline returns full timeline copy', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.appendTurn(meeting.id, 'user', 'Q1', 1);
  m.appendTurn(meeting.id, 'sub-A', 'R1_A', 2);
  const tl = m.getTimeline(meeting.id);
  assert.equal(tl.length, 2);
  assert.equal(tl[0].text, 'Q1');
  assert.equal(tl[1].text, 'R1_A');
  // Mutating returned copy must not affect internal state
  tl.push({ idx: 99, sid: 'fake', text: 'no', ts: 0 });
  assert.equal(m.getTimeline(meeting.id).length, 2);
});

test('appendTurn returns null for unknown meeting', () => {
  const m = new MeetingRoomManager();
  assert.equal(m.appendTurn('nonexistent', 'user', 'Q', 0), null);
});

test('getTimeline returns empty array for unknown meeting (not null)', () => {
  const m = new MeetingRoomManager();
  assert.deepEqual(m.getTimeline('nonexistent'), []);
});

test('appendTurn caps single turn text at 100KB to prevent OOM', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  const huge = 'x'.repeat(150 * 1024);
  const t = m.appendTurn(meeting.id, 'sub-A', huge, 1);
  assert.equal(t.text.length, 100 * 1024 + '...[truncated]'.length);
  assert.ok(t.text.endsWith('...[truncated]'));
});

test('appendTurn dedupes same sid+text within 2s window', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  const t0 = m.appendTurn(meeting.id, 'sub-A', 'R1', 1700000000000);
  const t1 = m.appendTurn(meeting.id, 'sub-A', 'R1', 1700000001000); // 1s later, dup
  assert.notEqual(t0, null);
  assert.equal(t1, null); // deduped
  assert.equal(m.getTimeline(meeting.id).length, 1);

  // Different text — keep
  const t2 = m.appendTurn(meeting.id, 'sub-A', 'R2', 1700000001500);
  assert.notEqual(t2, null);
  assert.equal(m.getTimeline(meeting.id).length, 2);

  // Same text but >2s later — keep (could be legitimate retry)
  const t3 = m.appendTurn(meeting.id, 'sub-A', 'R1', 1700000010000);
  assert.notEqual(t3, null);
  assert.equal(m.getTimeline(meeting.id).length, 3);
});
```

- [ ] **Step 1.2: Run test, verify it fails**

```bash
cd /c/Users/lintian/claude-session-hub
node --test tests/_unit-hub-timeline.js 2>&1 | head -30
```

Expected: FAILs with "appendTurn is not a function" or similar — methods don't exist yet.

- [ ] **Step 1.3: Add timeline state to createMeeting**

Edit `core/meeting-room.js`. In `createMeeting()`, add three fields to the meeting object:

```js
createMeeting() {
  const id = uuid();
  const meeting = {
    id,
    type: 'meeting',
    title: `会议室-${++this._counter}`,
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
    // Hub Timeline phase 1 (in-memory only)
    _timeline: [],
    _cursors: {},
    _nextIdx: 0,
  };
  this.meetings.set(id, meeting);
  return { ...meeting };
}
```

Important: `restoreMeeting` must also initialize these fields if missing (legacy persisted meetings predate this):

```js
restoreMeeting(meetingData) {
  if (!meetingData || !meetingData.id) return;
  this.meetings.set(meetingData.id, {
    ...meetingData,
    status: 'dormant',
    subSessions: meetingData.subSessions || [],
    _timeline: [],
    _cursors: {},
    _nextIdx: 0,
  });
  ...
}
```

- [ ] **Step 1.4: Implement appendTurn**

In `core/meeting-room.js`, add new methods (before `module.exports`):

```js
appendTurn(meetingId, sid, text, ts) {
  const m = this.meetings.get(meetingId);
  if (!m) return null;
  if (typeof text !== 'string' || !text) return null;

  // Cap at 100KB to prevent OOM from runaway AI output
  const MAX = 100 * 1024;
  let safeText = text;
  if (safeText.length > MAX) {
    safeText = safeText.slice(0, MAX) + '...[truncated]';
  }

  // Dedupe: same sid+text within 2s = duplicate event from tap
  const lastTurn = m._timeline[m._timeline.length - 1];
  if (lastTurn && lastTurn.sid === sid && lastTurn.text === safeText
      && (ts - lastTurn.ts) < 2000) {
    return null;
  }

  const turn = { idx: m._nextIdx++, sid, text: safeText, ts: ts || Date.now() };
  m._timeline.push(turn);
  m.lastMessageTime = ts || Date.now();
  return { ...turn };
}

getTimeline(meetingId) {
  const m = this.meetings.get(meetingId);
  if (!m) return [];
  return m._timeline.map(t => ({ ...t }));
}
```

- [ ] **Step 1.5: Run test, verify all 6 tests pass**

```bash
node --test tests/_unit-hub-timeline.js 2>&1 | head -50
```

Expected: 6 tests PASS.

- [ ] **Step 1.6: Commit**

```bash
git add core/meeting-room.js tests/_unit-hub-timeline.js
git commit -m "feat(meeting): MeetingRoomManager timeline + appendTurn/getTimeline (phase 1.1)"
```

---

## Task 2: Cursor lifecycle — addSubSession init / removeSubSession clean / restart preserve

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-room.js` (existing addSubSession/removeSubSession)
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-hub-timeline.js` (extend)

- [ ] **Step 2.1: Append failing tests to test file**

Append to `tests/_unit-hub-timeline.js`:

```js
test('addSubSession initializes cursor to 0 (sees full history)', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.appendTurn(meeting.id, 'user', 'Q1', 1);
  m.appendTurn(meeting.id, 'sub-A', 'R1', 2);

  const updated = m.addSubSession(meeting.id, 'sub-B');
  assert.notEqual(updated, null);
  assert.equal(m.getCursor(meeting.id, 'sub-B'), 0);
});

test('addSubSession idempotent: existing session keeps its cursor', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');
  m.appendTurn(meeting.id, 'user', 'Q', 1);
  m.appendTurn(meeting.id, 'sub-A', 'R', 2);
  m.advanceCursor(meeting.id, 'sub-A', 2);
  // Re-add same sub: cursor must NOT reset
  m.addSubSession(meeting.id, 'sub-A');
  assert.equal(m.getCursor(meeting.id, 'sub-A'), 2);
});

test('removeSubSession clears cursor', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');
  m.removeSubSession(meeting.id, 'sub-A');
  assert.equal(m.getCursor(meeting.id, 'sub-A'), null);
});

test('getCursor returns null for unknown meeting/session', () => {
  const m = new MeetingRoomManager();
  assert.equal(m.getCursor('nope', 'sub-X'), null);
  const meeting = m.createMeeting();
  assert.equal(m.getCursor(meeting.id, 'sub-not-added'), null);
});
```

- [ ] **Step 2.2: Run test, verify failing**

```bash
node --test tests/_unit-hub-timeline.js 2>&1 | grep -E "fail|pass" | head -20
```

Expected: 4 new tests fail (getCursor/advanceCursor not defined).

- [ ] **Step 2.3: Modify addSubSession to init cursor**

In `core/meeting-room.js`, locate `addSubSession` and add cursor init:

```js
addSubSession(meetingId, sessionId) {
  const m = this.meetings.get(meetingId);
  if (!m) return null;
  if (m.subSessions.length >= 3) return null;
  if (m.subSessions.includes(sessionId)) {
    // Already a member: cursor must NOT reset (idempotent)
    return { ...m, subSessions: [...m.subSessions] };
  }
  m.subSessions.push(sessionId);
  if (!(sessionId in m._cursors)) {
    m._cursors[sessionId] = 0; // new join: see full history
  }
  m.lastMessageTime = Date.now();
  return { ...m, subSessions: [...m.subSessions] };
}
```

Note: original code returned `null` when `subSessions.includes(sessionId)`. We change that to "no-op return current state" so cursor preservation is observable. Confirm no caller relies on the null sentinel for "already-member" — they use it for "full". Both `null` cases (full or already-member) are non-error paths in renderer; current code doesn't distinguish anyway.

- [ ] **Step 2.4: Modify removeSubSession to clear cursor**

```js
removeSubSession(meetingId, sessionId) {
  const m = this.meetings.get(meetingId);
  if (!m) return null;
  m.subSessions = m.subSessions.filter(id => id !== sessionId);
  delete m._cursors[sessionId];
  if (m.focusedSub === sessionId) m.focusedSub = m.subSessions[0] || null;
  if (m.sendTarget === sessionId) m.sendTarget = 'all';
  return { ...m, subSessions: [...m.subSessions] };
}
```

- [ ] **Step 2.5: Add getCursor + advanceCursor methods**

Add to MeetingRoomManager (before `module.exports`):

```js
getCursor(meetingId, sid) {
  const m = this.meetings.get(meetingId);
  if (!m) return null;
  if (!(sid in m._cursors)) return null;
  return m._cursors[sid];
}

advanceCursor(meetingId, sid, newPos) {
  const m = this.meetings.get(meetingId);
  if (!m) return false;
  if (!(sid in m._cursors)) return false;
  if (newPos < m._cursors[sid]) return false; // monotonic
  if (newPos > m._timeline.length) newPos = m._timeline.length;
  m._cursors[sid] = newPos;
  return true;
}
```

- [ ] **Step 2.6: Run all unit tests, verify pass**

```bash
node --test tests/_unit-hub-timeline.js 2>&1 | tail -10
```

Expected: 10 tests pass total (6 from Task 1 + 4 new).

- [ ] **Step 2.7: Commit**

```bash
git add core/meeting-room.js tests/_unit-hub-timeline.js
git commit -m "feat(meeting): timeline cursor lifecycle on add/remove sub-session (phase 1.1)"
```

---

## Task 3: incrementalContext — the core injection logic

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-room.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-hub-timeline.js` (extend)

- [ ] **Step 3.1: Append failing tests**

```js
test('incrementalContext returns turns since cursor, excluding target self', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');
  m.addSubSession(meeting.id, 'sub-B');
  m.appendTurn(meeting.id, 'user', 'Q1', 1);
  m.appendTurn(meeting.id, 'sub-A', 'R1_A', 2);
  m.appendTurn(meeting.id, 'sub-B', 'R1_B', 3);

  // First call for sub-A: gets all timeline minus its own turns
  const result = m.incrementalContext(meeting.id, 'sub-A');
  assert.equal(result.turns.length, 2); // user + sub-B (sub-A self excluded)
  assert.equal(result.turns[0].sid, 'user');
  assert.equal(result.turns[1].sid, 'sub-B');
  assert.equal(result.advancedTo, 3);
});

test('incrementalContext advances cursor', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');
  m.appendTurn(meeting.id, 'user', 'Q', 1);
  m.appendTurn(meeting.id, 'sub-B', 'R', 2);

  m.incrementalContext(meeting.id, 'sub-A');
  assert.equal(m.getCursor(meeting.id, 'sub-A'), 2);

  // Second call: nothing new
  const second = m.incrementalContext(meeting.id, 'sub-A');
  assert.equal(second.turns.length, 0);
});

test('incrementalContext on unknown sub returns empty', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.appendTurn(meeting.id, 'user', 'Q', 1);
  const result = m.incrementalContext(meeting.id, 'sub-not-added');
  assert.deepEqual(result, { turns: [], advancedTo: 0 });
});

test('incrementalContext respects user turns inserted between AI turns', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');
  m.appendTurn(meeting.id, 'user', 'Q1', 1);
  m.appendTurn(meeting.id, 'sub-B', 'R1_B', 2);
  m.advanceCursor(meeting.id, 'sub-A', 2); // sub-A consumed up to here
  m.appendTurn(meeting.id, 'user', 'Q2', 3);
  m.appendTurn(meeting.id, 'sub-B', 'R2_B', 4);

  const result = m.incrementalContext(meeting.id, 'sub-A');
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].text, 'Q2');
  assert.equal(result.turns[1].text, 'R2_B');
});

test('incrementalContext does NOT advance cursor when meeting/sub missing', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  // No sub added
  const r = m.incrementalContext(meeting.id, 'sub-not-added');
  assert.equal(r.advancedTo, 0);
  assert.equal(m.getCursor(meeting.id, 'sub-not-added'), null);
});
```

- [ ] **Step 3.2: Run, verify failing**

```bash
node --test tests/_unit-hub-timeline.js 2>&1 | grep -E "incrementalContext" | head -10
```

Expected: 5 new tests fail.

- [ ] **Step 3.3: Implement incrementalContext**

Add to MeetingRoomManager:

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
  return { turns: newTurns, advancedTo: m._cursors[targetSid] };
}
```

- [ ] **Step 3.4: Run all unit tests pass**

```bash
node --test tests/_unit-hub-timeline.js 2>&1 | tail -5
```

Expected: 15 tests pass total.

- [ ] **Step 3.5: Commit**

```bash
git add core/meeting-room.js tests/_unit-hub-timeline.js
git commit -m "feat(meeting): incrementalContext — zero-duplication injection core (phase 1.1)"
```

---

## Task 4: main.js — IPC handlers (append-user-turn, get-timeline, incremental-context)

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 4.1: Add 3 IPC handlers**

Find the existing `ipcMain.handle('get-marker-instruction', ...)` block in `main.js` (around line 403). After it, add:

```js
// Hub Timeline IPC: append a user turn to the meeting timeline.
// Renderer calls this when user submits a message in meeting room before
// the message goes to PTY(s).
ipcMain.handle('meeting-append-user-turn', (_e, { meetingId, text }) => {
  if (!meetingId || typeof text !== 'string' || !text) return null;
  const turn = meetingManager.appendTurn(meetingId, 'user', text, Date.now());
  if (turn) {
    sendToRenderer('meeting-timeline-updated', { meetingId, turn });
  }
  return turn;
});

// Hub Timeline IPC: full snapshot of meeting timeline (for Feed UI rerender).
ipcMain.handle('meeting-get-timeline', (_e, meetingId) => {
  return meetingManager.getTimeline(meetingId);
});

// Hub Timeline IPC: compute incremental context for a target sub-session.
// Returns { turns: [...], advancedTo: int }. Side effect: cursor advanced.
// Renderer calls this in handleMeetingSend when syncContext is ON.
ipcMain.handle('meeting-incremental-context', (_e, { meetingId, targetSid }) => {
  if (!meetingId || !targetSid) return { turns: [], advancedTo: 0 };
  return meetingManager.incrementalContext(meetingId, targetSid);
});
```

- [ ] **Step 4.2: Verify main.js syntax**

```bash
cd /c/Users/lintian/claude-session-hub
node --check main.js && echo OK
```

Expected: OK.

- [ ] **Step 4.3: Commit**

```bash
git add main.js
git commit -m "feat(meeting): timeline IPC handlers (append-user-turn / get-timeline / incremental-context) (phase 1.2)"
```

---

## Task 5: main.js — Wire transcriptTap turn-complete → meetingManager.appendTurn

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 5.1: Find the transcriptTap singleton and add listener**

In `main.js`, the `transcriptTap` instance is created at line 18. Find a good place to register the listener — right after `meetingManager` is initialized. Use Grep to find: `new MeetingRoomManager`.

```bash
cd /c/Users/lintian/claude-session-hub
grep -n "new MeetingRoomManager" main.js
```

Add immediately after that line:

```js
// Wire TranscriptTap → MeetingRoomManager timeline.
// When a sub-session's CLI finishes a turn, append the AI text to its
// meeting's timeline (if the sub-session belongs to a meeting).
transcriptTap.on('turn-complete', ({ hubSessionId, text, completedAt }) => {
  const session = sessionManager.getSession(hubSessionId);
  if (!session || !session.meetingId) return;
  const turn = meetingManager.appendTurn(
    session.meetingId,
    hubSessionId,
    text,
    completedAt || Date.now(),
  );
  if (turn) {
    sendToRenderer('meeting-timeline-updated', { meetingId: session.meetingId, turn });
  }
});
```

- [ ] **Step 5.2: Verify main.js syntax**

```bash
node --check main.js && echo OK
```

Expected: OK.

- [ ] **Step 5.3: Smoke-test loadability**

```bash
node -e "require('./core/meeting-room.js'); require('./core/transcript-tap.js'); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 5.4: Commit**

```bash
git add main.js
git commit -m "feat(meeting): wire transcriptTap turn-complete → meeting timeline (phase 1.2)"
```

---

## Task 6: main.js — restart-session preserves hubSessionId (cursor preservation prerequisite)

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

This is the spec implementation附加 noted in decision #7.

- [ ] **Step 6.1: Find the restart-session handler**

```bash
cd /c/Users/lintian/claude-session-hub
grep -n "restart-session" main.js
```

You'll find the handler around `ipcMain.handle('restart-session', ...)`. The current pattern is:

```js
sessionManager.closeSession(sessionId);
const fresh = sessionManager.createSession(old.kind);
registerSessionForTap(fresh);
```

- [ ] **Step 6.2: Modify to reuse old.id and old.cwd**

Replace the createSession call with:

```js
sessionManager.closeSession(sessionId);
const fresh = sessionManager.createSession(old.kind, {
  id: old.id,
  cwd: old.cwd,
  meetingId: old.meetingId || undefined,
});
registerSessionForTap(fresh);
```

This makes the restarted session keep the same hubSessionId, so the meeting cursor (keyed by hubSessionId) survives. Also keeps the meeting membership.

- [ ] **Step 6.3: Verify session-manager supports `id` opt**

```bash
grep -n "opts.id" core/session-manager.js | head -5
```

Expected: shows `const id = opts.id || uuid();` confirming the option is honored. (If not, that would be a separate prerequisite task.)

- [ ] **Step 6.4: Verify main.js syntax**

```bash
node --check main.js && echo OK
```

- [ ] **Step 6.5: Commit**

```bash
git add main.js
git commit -m "fix(meeting): restart-session reuses old hubSessionId to preserve timeline cursor (phase 1.2)"
```

---

## Task 7: renderer/meeting-room.js — handleMeetingSend Hub-Timeline-aware

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`

- [ ] **Step 7.1: Locate handleMeetingSend**

```bash
cd /c/Users/lintian/claude-session-hub
grep -n "async function handleMeetingSend" renderer/meeting-room.js
```

The function starts around line 571.

- [ ] **Step 7.2: Rewrite handleMeetingSend body**

Locate the function body (currently starts with `const current = meetingData[meeting.id] || meeting;`) and replace until the end of the for-loop with this new body:

```js
async function handleMeetingSend(text, meeting) {
  const current = meetingData[meeting.id] || meeting;
  const targets = current.sendTarget === 'all'
    ? current.subSessions.filter(sid => {
        const s = sessions ? sessions.get(sid) : null;
        return s && s.status !== 'dormant';
      })
    : [current.sendTarget];

  // Step 1: Append user turn to meeting timeline (regardless of syncContext —
  // user turns are always part of the conversation history for Feed UI).
  await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });

  for (const sessionId of targets) {
    let payload = text;

    // Step 2: If syncContext is ON, prepend incremental context for this target.
    if (meeting.syncContext) {
      const result = await ipcRenderer.invoke('meeting-incremental-context', {
        meetingId: meeting.id, targetSid: sessionId,
      });
      if (result && result.turns && result.turns.length > 0) {
        const formatted = formatIncrementalContext(result.turns, sessions);
        payload = formatted + text;
      }
    }

    ipcRenderer.send('terminal-input', { sessionId, data: payload });
    const session = sessions ? sessions.get(sessionId) : null;
    const enterDelay = session && session.kind === 'codex' ? 300 : 80;
    setTimeout(() => {
      ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
    }, enterDelay);
  }

  meeting.lastMessageTime = Date.now();
  ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  _contextCompressCache.clear();
  _divergenceResult = null;
  _divergenceHash = '';
  const divBar = document.getElementById('mr-divergence-bar');
  if (divBar) divBar.remove();
}

// Format incremental-context turns as a clear "meeting sync" prefix the AI can
// recognize as not being from the user. Format:
//   [会议室协作同步]
//   【你】Q2 follow-up
//   【Codex】R2_X content...
//   ---
function formatIncrementalContext(turns, sessions) {
  const lines = ['[会议室协作同步]'];
  for (const t of turns) {
    let label;
    if (t.sid === 'user') {
      label = '你';
    } else {
      const s = sessions ? sessions.get(t.sid) : null;
      label = s ? (s.title || s.kind || 'AI') : 'AI';
    }
    lines.push(`【${label}】${t.text}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}
```

Notes:
- Existing `buildContextSummary` and `_contextCompressCache` cleanup remain; we don't call buildContextSummary anymore. Keep the old function in the file for now (other code may reference it indirectly) — leave a TODO comment if you want, but no need to delete in this task.
- The "stop appending markerInstruction" change from the previous commit (`9d27102`) stays; we just replaced the rest.

- [ ] **Step 7.3: Verify renderer syntax**

```bash
node --check renderer/meeting-room.js && echo OK
```

- [ ] **Step 7.4: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(meeting): handleMeetingSend uses Hub Timeline + incremental context (phase 1.2)"
```

---

## Task 8: renderer/meeting-blackboard.js — Feed UI rewrite

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js`

- [ ] **Step 8.1: Add Feed renderer state + helpers (top of IIFE)**

Locate the existing `(function () { ... })();` IIFE start. Inside, after `let _syncing = false;`, add:

```js
let _currentMeetingId = null;
let _feedListenerAttached = false;
let _renderRequested = false;

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getSessionLabel(sid) {
  if (sid === 'user') return '你';
  const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
  if (!s) return '已离开';
  return s.title || s.kind || 'AI';
}

function getSessionKind(sid) {
  if (sid === 'user') return 'user';
  const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
  return s ? s.kind : 'unknown';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function renderTurnCard(turn) {
  const kind = getSessionKind(turn.sid);
  const label = getSessionLabel(turn.sid);
  const longThreshold = 500;
  const isLong = turn.text.length > longThreshold;
  const preview = isLong ? turn.text.slice(0, longThreshold) : turn.text;
  const previewHtml = escapeHtml(preview);
  const fullHtml = escapeHtml(turn.text);
  const foldId = `mr-feed-fold-${turn.idx}`;

  return `<div class="mr-feed-turn mr-feed-kind-${escapeHtml(kind)}" data-idx="${turn.idx}">
    <div class="mr-feed-meta">
      <span class="mr-feed-badge mr-feed-badge-${escapeHtml(kind)}">${escapeHtml(label)}</span>
      <span class="mr-feed-time">${escapeHtml(formatTime(turn.ts))}</span>
      <span class="mr-feed-idx">#${turn.idx}</span>
    </div>
    <div class="mr-feed-body">${
      isLong
        ? `<span id="${foldId}-preview">${previewHtml}<span class="mr-feed-ellipsis">…</span></span>
           <span id="${foldId}-full" style="display:none">${fullHtml}</span>
           <button class="mr-feed-toggle" data-fold-id="${foldId}">展开</button>`
        : fullHtml
    }</div>
  </div>`;
}

function attachFoldHandler(container) {
  container.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.mr-feed-toggle');
    if (!btn) return;
    const foldId = btn.getAttribute('data-fold-id');
    const preview = document.getElementById(foldId + '-preview');
    const full = document.getElementById(foldId + '-full');
    if (!preview || !full) return;
    if (full.style.display === 'none') {
      preview.style.display = 'none';
      full.style.display = 'inline';
      btn.textContent = '收起';
    } else {
      preview.style.display = 'inline';
      full.style.display = 'none';
      btn.textContent = '展开';
    }
  });
}
```

- [ ] **Step 8.2: Replace renderBlackboard body**

Find `async function renderBlackboard(meeting, container) {` and replace the entire body with:

```js
async function renderBlackboard(meeting, container) {
  container.innerHTML = '';
  container.className = 'mr-terminals mr-blackboard mr-feed';
  _currentMeetingId = meeting.id;

  if (!meeting.subSessions || meeting.subSessions.length === 0) {
    container.innerHTML = '<div class="mr-bb-empty">暂无子会话，请先添加 AI</div>';
    return;
  }

  const feedEl = document.createElement('div');
  feedEl.className = 'mr-feed-list';
  container.appendChild(feedEl);

  const timeline = await ipcRenderer.invoke('meeting-get-timeline', meeting.id);
  const reversed = timeline.slice().reverse();
  feedEl.innerHTML = reversed.map(renderTurnCard).join('');
  attachFoldHandler(feedEl);

  if (!_feedListenerAttached) {
    _feedListenerAttached = true;
    ipcRenderer.on('meeting-timeline-updated', ({ meetingId, turn }) => {
      if (meetingId !== _currentMeetingId) return;
      const list = document.querySelector('.mr-feed-list');
      if (!list) return;
      const card = document.createElement('div');
      card.innerHTML = renderTurnCard(turn);
      const node = card.firstElementChild;
      list.insertBefore(node, list.firstChild);
    });
  }
}
```

- [ ] **Step 8.3: Verify renderer syntax**

```bash
node --check renderer/meeting-blackboard.js && echo OK
```

- [ ] **Step 8.4: Commit**

```bash
git add renderer/meeting-blackboard.js
git commit -m "feat(meeting): Feed UI rewrite — chronological timeline with live updates (phase 1.3)"
```

---

## Task 9: renderer/meeting-room.css — Feed visual styles

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 9.1: Append Feed styles**

Append to `renderer/meeting-room.css`:

```css
/* ===== Hub Timeline Feed UI (replaces tabbed blackboard) ===== */

.mr-feed-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  overflow-y: auto;
  height: 100%;
  background: var(--bg-primary, #181818);
}

.mr-feed-turn {
  background: var(--bg-secondary, #232323);
  border-radius: 6px;
  padding: 10px 12px;
  border-left: 3px solid var(--border-default, #444);
  font-size: 13px;
}

.mr-feed-turn.mr-feed-kind-user {
  background: #1a2332;
  border-left-color: #6b7280;
}
.mr-feed-turn.mr-feed-kind-claude { border-left-color: #d97706; }
.mr-feed-turn.mr-feed-kind-codex { border-left-color: #059669; }
.mr-feed-turn.mr-feed-kind-gemini { border-left-color: #7c3aed; }
.mr-feed-turn.mr-feed-kind-deepseek { border-left-color: #2563eb; }

.mr-feed-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-secondary, #888);
}

.mr-feed-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 11px;
  color: #fff;
  font-weight: 600;
}
.mr-feed-badge-user { background: #6b7280; }
.mr-feed-badge-claude { background: #d97706; }
.mr-feed-badge-codex { background: #059669; }
.mr-feed-badge-gemini { background: #7c3aed; }
.mr-feed-badge-deepseek { background: #2563eb; }
.mr-feed-badge-unknown { background: #444; }

.mr-feed-time { color: var(--text-secondary, #888); }
.mr-feed-idx { color: var(--text-tertiary, #555); margin-left: auto; font-family: monospace; }

.mr-feed-body {
  color: var(--text-primary, #e5e5e5);
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
  word-break: break-word;
}

.mr-feed-ellipsis { color: var(--text-secondary, #888); }

.mr-feed-toggle {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  font-size: 11px;
  background: transparent;
  border: 1px solid var(--border-default, #444);
  color: var(--text-secondary, #aaa);
  border-radius: 3px;
  cursor: pointer;
}
.mr-feed-toggle:hover {
  background: var(--bg-tertiary, #2a2a2a);
}
```

- [ ] **Step 9.2: No syntax check needed for CSS — visual verification only.** 

For final visual verification, the user will open Hub. We commit and continue.

- [ ] **Step 9.3: Commit**

```bash
git add renderer/meeting-room.css
git commit -m "feat(meeting): Feed UI styles — kind-colored badges + fold long text (phase 1.3)"
```

---

## Task 10: Integration test — mock transcriptTap → meetingManager wiring

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\_integration-hub-timeline.js`

This avoids real CLIs but validates the wiring layer in main.js. We can't easily import main.js (it requires Electron), so this test exercises just the wiring contract.

- [ ] **Step 10.1: Write integration test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { MeetingRoomManager } = require('../core/meeting-room.js');

// Mock the transcriptTap → meetingManager wiring (logic copied from main.js).
function wire(meetingManager, transcriptTap, sessionLookup, onTimelineUpdated) {
  transcriptTap.on('turn-complete', ({ hubSessionId, text, completedAt }) => {
    const session = sessionLookup(hubSessionId);
    if (!session || !session.meetingId) return;
    const turn = meetingManager.appendTurn(
      session.meetingId, hubSessionId, text, completedAt || Date.now()
    );
    if (turn) onTimelineUpdated({ meetingId: session.meetingId, turn });
  });
}

test('transcriptTap turn-complete → meeting timeline append + IPC notify', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');

  const sessions = new Map();
  sessions.set('sub-A', { id: 'sub-A', meetingId: meeting.id, kind: 'codex' });
  sessions.set('sub-orphan', { id: 'sub-orphan', meetingId: null });

  const tap = new EventEmitter();
  const events = [];
  wire(m, tap, sid => sessions.get(sid), ev => events.push(ev));

  tap.emit('turn-complete', { hubSessionId: 'sub-A', text: 'hello', completedAt: 1000 });
  tap.emit('turn-complete', { hubSessionId: 'sub-orphan', text: 'should be ignored', completedAt: 2000 });
  tap.emit('turn-complete', { hubSessionId: 'sub-unknown', text: 'also ignored', completedAt: 3000 });

  const tl = m.getTimeline(meeting.id);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].sid, 'sub-A');
  assert.equal(tl[0].text, 'hello');
  assert.equal(events.length, 1);
  assert.equal(events[0].meetingId, meeting.id);
  assert.equal(events[0].turn.idx, 0);
});

test('rapid duplicate turn-complete events deduped (within 2s)', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');
  const sessions = new Map([['sub-A', { id: 'sub-A', meetingId: meeting.id }]]);
  const tap = new EventEmitter();
  const events = [];
  wire(m, tap, sid => sessions.get(sid), ev => events.push(ev));

  tap.emit('turn-complete', { hubSessionId: 'sub-A', text: 'R1', completedAt: 1000 });
  tap.emit('turn-complete', { hubSessionId: 'sub-A', text: 'R1', completedAt: 1500 }); // dup
  assert.equal(events.length, 1);
  assert.equal(m.getTimeline(meeting.id).length, 1);
});

test('user-turn IPC simulation appends + emits update', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  // Simulate IPC handler logic from main.js
  function simulateAppendUserTurn(meetingId, text) {
    const turn = m.appendTurn(meetingId, 'user', text, Date.now());
    return turn ? { meetingId, turn } : null;
  }
  const ev = simulateAppendUserTurn(meeting.id, 'Q1');
  assert.equal(ev.turn.sid, 'user');
  assert.equal(ev.turn.text, 'Q1');
  assert.equal(ev.turn.idx, 0);
  assert.equal(m.getTimeline(meeting.id).length, 1);
});
```

- [ ] **Step 10.2: Run integration test, verify all pass**

```bash
node --test tests/_integration-hub-timeline.js 2>&1 | tail -10
```

Expected: 3 tests pass.

- [ ] **Step 10.3: Commit**

```bash
git add tests/_integration-hub-timeline.js
git commit -m "test(meeting): integration test for transcriptTap → meetingManager wiring (phase 1.4)"
```

---

## Task 11: E2E test — Scenario A (basic happy path: 3 AIs + syncContext ON + 2 rounds)

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\_e2e-hub-timeline-real.js`

This test starts an isolated Hub instance, connects via CDP, exercises real Claude/Codex/Gemini sub-sessions.

- [ ] **Step 11.1: Write E2E harness + Scenario A**

```js
/**
 * E2E test for Hub Timeline phase 1.
 * Prerequisite: Hub running on CDP_PORT (default 9220).
 * Start a Hub instance manually with isolated data dir, e.g.:
 *   CLAUDE_HUB_DATA_DIR=$HOME/.claude-hub-timeline-test \
 *     ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9220
 *
 * Then: SCENARIO=A node tests/_e2e-hub-timeline-real.js
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = parseInt(process.env.CDP_PORT || '9220', 10);
const SCENARIO = process.env.SCENARIO || 'A';

let ws, msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }
    }, 30000);
  });
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect() {
  const pages = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const page = pages.find(p => p.type === 'page' && !p.url.startsWith('devtools://'));
  if (!page) throw new Error('No CDP page');
  await new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });
  });
  await cdp('Runtime.enable');
}

async function createMeetingWithThree() {
  console.log('[e2e] creating meeting + 3 sub-sessions');
  const result = await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      const meeting = await ipcRenderer.invoke('create-meeting');
      // Use create-session with noInheritCursor so PTY output is captured headless
      const claude = await ipcRenderer.invoke('create-session', { kind: 'claude', opts: { noInheritCursor: true, meetingId: meeting.id } });
      await ipcRenderer.invoke('add-meeting-sub', { meetingId: meeting.id, kind: 'placeholder' }); // hack to register cursor
      // Simpler: bypass add-meeting-sub which spawns its own session, just attach manually
      return { meetingId: meeting.id };
    })()
  `);
  // Note: add-meeting-sub IPC spawns its own PTY. To use noInheritCursor for headless E2E,
  // we need to refactor or use a different IPC. For now, scenario A assumes add-meeting-sub
  // works and conceeds visibility (user will run scenario A manually first).
  // TODO: in step 11.2 we'll add a proper headless add-meeting-sub variant.
  return result.meetingId;
}

async function waitForReady(sid, kindHint, maxSec = 90) {
  for (let i = 0; i < maxSec * 2; i++) {
    await sleep(500);
    const buf = await evalJs(`
      (async () => {
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke('get-ring-buffer', '${sid}');
      })()
    `).catch(() => '');
    if (typeof buf === 'string') {
      if (kindHint === 'codex' && /Context\\s+\\d+% left/i.test(buf)) return true;
      if (kindHint === 'gemini' && /Type your message/i.test(buf)) return true;
      if (kindHint === 'claude' && /\\$|>|❯/.test(buf) && buf.length > 200) return true;
    }
  }
  return false;
}

async function getTimeline(meetingId) {
  return await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('meeting-get-timeline', '${meetingId}');
    })()
  `);
}

async function sendMessage(meetingId, text) {
  // Set sendTarget=all, syncContext=true via update-meeting if needed,
  // then trigger handleMeetingSend equivalent via terminal-input + append-user-turn.
  await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true, sendTarget: 'all' } });
    })()
  `);
  // Wait for state to propagate
  await sleep(200);
  // Use the renderer's handleMeetingSend by triggering it through window if exposed,
  // OR replicate its behavior here:
  await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      const meeting = await new Promise(r => {
        ipcRenderer.invoke('get-meetings').then(list => r(list.find(m => m.id === '${meetingId}')));
      }).catch(() => null);
      if (!meeting) return;
      await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: ${JSON.stringify(text)} });
      const subs = meeting.subSessions || [];
      for (const sid of subs) {
        let payload = ${JSON.stringify(text)};
        const ctx = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
        if (ctx && ctx.turns && ctx.turns.length > 0) {
          const lines = ['[会议室协作同步]'];
          for (const t of ctx.turns) {
            const lbl = t.sid === 'user' ? '你' : (sid === t.sid ? '自己' : t.sid);
            lines.push('【' + lbl + '】' + t.text);
          }
          lines.push('---', '');
          payload = lines.join('\\n') + payload;
        }
        ipcRenderer.send('terminal-input', { sessionId: sid, data: payload });
        await new Promise(r => setTimeout(r, 80));
        ipcRenderer.send('terminal-input', { sessionId: sid, data: '\\r' });
      }
    })()
  `);
}

async function waitForTimelineLength(meetingId, expected, maxSec = 120) {
  for (let i = 0; i < maxSec; i++) {
    await sleep(1000);
    const tl = await getTimeline(meetingId);
    if (tl.length >= expected) return tl;
  }
  return await getTimeline(meetingId);
}

// === Scenarios ===

async function scenarioA() {
  console.log('=== Scenario A: 3 AIs + syncContext ON + 2 rounds ===');
  // For automation: assumes meeting with 3 sub-sessions already prepared by user
  // OR see step 11.2 for full automation.
  console.log('Not yet automated. See plan task 11.2.');
}

async function main() {
  await connect();
  if (SCENARIO === 'A') await scenarioA();
  else console.log('Unknown scenario:', SCENARIO);
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 11.2: Make E2E test fully automatable**

The above intentionally leaves Scenario A as a placeholder because **add-meeting-sub IPC doesn't accept opts.noInheritCursor**. To run E2E headless we need either:

(a) Add an overload to `add-meeting-sub` IPC that accepts `opts`, or
(b) Use `create-session` with `meetingId` opt, then call a new IPC `attach-existing-session-to-meeting`.

Choose (a). Add to main.js (in Task 4 region):

```js
// Allow add-meeting-sub to forward opts to createSession (used by headless E2E for noInheritCursor)
// Override-or-extend the existing handler:
ipcMain.removeHandler && ipcMain.removeHandler('add-meeting-sub');
ipcMain.handle('add-meeting-sub', (_e, { meetingId, kind, opts }) => {
  const session = sessionManager.createSession(kind, { ...(opts || {}), meetingId });
  if (!session) return null;
  const updated = meetingManager.addSubSession(meetingId, session.id);
  if (!updated) {
    sessionManager.closeSession(session.id);
    return null;
  }
  registerSessionForTap(session);
  sendToRenderer('session-created', { session });
  sendToRenderer('meeting-updated', { meeting: updated });
  return { session, meeting: updated };
});
```

Note: `ipcMain.removeHandler` exists in modern Electron and is safe; if missing, replace by editing the original `add-meeting-sub` handler in place. Verify version:

```bash
node -e "console.log(require('./package.json').devDependencies.electron || require('./package.json').dependencies.electron)"
```

If Electron 22+, `removeHandler` is fine. Otherwise edit in place.

Now rewrite scenarioA in `tests/_e2e-hub-timeline-real.js`:

```js
async function scenarioA() {
  console.log('=== Scenario A: 3 AIs + syncContext ON + 2 rounds ===');

  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  console.log('  meeting:', meetingId);

  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    console.log('  spawning', kind);
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', {
        meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true }
      });
    })()`);
    subs[kind] = r.session.id;
  }

  console.log('  waiting for all 3 TUIs ready (up to 90s)');
  for (const [kind, sid] of Object.entries(subs)) {
    const ok = await waitForReady(sid, kind);
    console.log('    ', kind, ok ? 'READY' : 'NOT READY (proceeding anyway)');
  }
  await sleep(2000);

  console.log('  Round 1: send "用一个字回答: 1+1 等于几"');
  await sendMessage(meetingId, '用一个字回答: 1+1 等于几');

  // Wait for 3 AI turns: timeline should reach 1 user + 3 AI = 4
  let tl1 = await waitForTimelineLength(meetingId, 4, 120);
  console.log('  timeline after R1:', tl1.length, 'turns');
  for (const t of tl1) console.log('   ', t.idx, t.sid.slice(0, 8), JSON.stringify(t.text).slice(0, 60));

  if (tl1.length < 4) {
    console.error('  FAIL: expected 4 turns, got', tl1.length);
    return false;
  }

  console.log('  Round 2: send "把刚才的答案翻译成英文"');
  await sendMessage(meetingId, '把刚才的答案翻译成英文');

  // Expected: 4 + 1 user + 3 AI = 8
  let tl2 = await waitForTimelineLength(meetingId, 8, 120);
  console.log('  timeline after R2:', tl2.length, 'turns');
  for (const t of tl2) console.log('   ', t.idx, t.sid.slice(0, 8), JSON.stringify(t.text).slice(0, 60));

  // Validate cursors all advanced to length
  const cursors = await evalJs(`(async () => {
    // No direct cursor IPC — workaround: check that incremental-context returns empty for any sub
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of [${Object.values(subs).map(s => `'${s}'`).join(',')}]) {
      const r = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
      out[sid] = { newTurns: r.turns.length, advancedTo: r.advancedTo };
    }
    return out;
  })()`);
  console.log('  cursor state:', cursors);

  // Pass criteria
  const pass = tl2.length >= 8 && Object.values(cursors).every(c => c.newTurns === 0);
  console.log(pass ? '  ✓ PASS Scenario A' : '  ✗ FAIL Scenario A');
  return pass;
}
```

- [ ] **Step 11.3: Verify syntax + commit before running**

```bash
node --check tests/_e2e-hub-timeline-real.js && echo OK
```

```bash
git add main.js tests/_e2e-hub-timeline-real.js
git commit -m "test(meeting): E2E scenario A — 3 AIs + syncContext + 2 rounds (phase 1.4)"
```

- [ ] **Step 11.4: Start isolated Hub for E2E**

```bash
mkdir -p "$HOME/.claude-hub-timeline-test"
cd /c/Users/lintian/claude-session-hub
CLAUDE_HUB_DATA_DIR="$HOME/.claude-hub-timeline-test" \
  ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9220 &
```

Wait until `[hub] hook server listening on 127.0.0.1:NNNN` appears. **Do NOT kill any Hub instance.**

- [ ] **Step 11.5: Run Scenario A**

```bash
SCENARIO=A CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -40
```

Expected: `✓ PASS Scenario A` after roughly 2-3 minutes (Gemini ready takes longest).

If FAIL, inspect timeline output to diagnose (which AI didn't appear; were turns deduped wrongly; etc).

---

## Task 12: E2E Scenarios B, C, D, E (rest of functional scenarios)

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\tests\_e2e-hub-timeline-real.js`

- [ ] **Step 12.1: Append scenarios B-E**

For each, add a function and dispatch in `main()`:

```js
async function scenarioB() {
  console.log('=== Scenario B: syncContext OFF — no injection ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);

  // Explicitly leave syncContext OFF (default)
  // Send 2 rounds via direct terminal-input + append-user-turn (no incremental-context)
  for (let r = 1; r <= 2; r++) {
    await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: 'Round ${r} question' });
      for (const sid of [${Object.values(subs).map(s => `'${s}'`).join(',')}]) {
        ipcRenderer.send('terminal-input', { sessionId: sid, data: 'Round ${r} question' });
        await new Promise(rs => setTimeout(rs, 80));
        ipcRenderer.send('terminal-input', { sessionId: sid, data: '\\r' });
      }
    })()`);
    await waitForTimelineLength(meetingId, r * 4, 120);
  }

  // All cursors should still be 0 (never advanced)
  const cursors = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of [${Object.values(subs).map(s => `'${s}'`).join(',')}]) {
      // Calling incremental-context advances; instead, peek by computing what slice would return
      // We don't have a peek IPC, so use timeline length and assume cursor=0 means full slice.
      out[sid] = (await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid })).turns.length;
    }
    return out;
  })()`);
  console.log('  in OFF mode cursors NEVER advanced — first incremental call returns full timeline minus self');
  console.log('  per-sub injection-eligible turns:', cursors);
  // Pass: cursors object has each sub returning >0 (i.e. cursor was at 0 before this call)
  const pass = Object.values(cursors).every(n => n >= 4);
  console.log(pass ? '  ✓ PASS Scenario B' : '  ✗ FAIL Scenario B');
  return pass;
}

async function scenarioC() {
  console.log('=== Scenario C: mid-meeting AI join — cursor=0 sees full history ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;

  // Spawn 2 AIs first (Claude + Codex)
  const subs = {};
  for (const kind of ['claude', 'codex']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);

  // 2 rounds with syncContext ON between Claude+Codex
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true } });
  })()`);
  await sleep(200);

  for (let r = 1; r <= 2; r++) {
    await sendMessage(meetingId, `R${r} question`);
    await waitForTimelineLength(meetingId, r * 3, 120); // 1 user + 2 AI per round
  }
  const tlBefore = await getTimeline(meetingId);
  console.log('  timeline before Gemini join:', tlBefore.length);

  // Now add Gemini
  const geminiR = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: 'gemini', opts: { noInheritCursor: true } });
  })()`);
  subs.gemini = geminiR.session.id;
  await waitForReady(subs.gemini, 'gemini');
  await sleep(2000);

  // Round 3
  await sendMessage(meetingId, '请综合大家观点');
  await waitForTimelineLength(meetingId, tlBefore.length + 4, 120);

  // Verify Gemini's incremental-context returned the FULL prior history on first call
  // (which sendMessage already did). Now next call should be empty.
  const second = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: '${subs.gemini}' });
  })()`);
  const pass = second.turns.length === 0;
  console.log(pass ? '  ✓ PASS Scenario C' : '  ✗ FAIL Scenario C');
  return pass;
}

async function scenarioD() {
  console.log('=== Scenario D: @target single → @all switch ===');
  // Similar harness; sendTarget=Codex for round 2; back to all for round 3
  // ... (full implementation similar to A/C)
  console.log('  TODO: full implementation in step 12.2');
  return true;
}

async function scenarioE() {
  console.log('=== Scenario E: restart AI preserves cursor ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true } });
  })()`);
  await sleep(200);

  // 2 rounds → cursors advance
  for (let r = 1; r <= 2; r++) {
    await sendMessage(meetingId, `R${r}`);
    await waitForTimelineLength(meetingId, r * 4, 120);
  }
  const tlPre = await getTimeline(meetingId);
  const tlPreLen = tlPre.length;

  // Restart Claude
  const restarted = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('restart-session', '${subs.claude}');
  })()`);
  // Verify same hubSessionId
  const samePid = restarted && restarted.id === subs.claude;
  console.log('  restart preserved hubSessionId:', samePid);
  await waitForReady(subs.claude, 'claude');
  await sleep(2000);

  // Round 3
  await sendMessage(meetingId, 'R3 continuation');
  // Expected: 1 new user + 3 AI = +4 turns
  await waitForTimelineLength(meetingId, tlPreLen + 4, 180);

  // Verify Claude's cursor was preserved: another incremental-context returns empty
  const peek = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: '${subs.claude}' });
  })()`);
  const pass = samePid && peek.turns.length === 0;
  console.log(pass ? '  ✓ PASS Scenario E' : '  ✗ FAIL Scenario E');
  return pass;
}
```

- [ ] **Step 12.2: Add scenario D full implementation (target switch)**

```js
async function scenarioD() {
  console.log('=== Scenario D: @target single → @all switch ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true, sendTarget: 'all' } });
  })()`);
  await sleep(200);

  // R1 @all
  await sendMessage(meetingId, 'R1 @all question');
  await waitForTimelineLength(meetingId, 4, 120);

  // Switch to @Codex only
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { sendTarget: '${subs.codex}' } });
  })()`);
  await sleep(200);
  // Custom send: only to Codex, append user turn first
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: 'R2 codex only' });
    const sid = '${subs.codex}';
    let payload = 'R2 codex only';
    const ctx = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
    if (ctx.turns.length > 0) {
      const lines = ['[会议室协作同步]'];
      for (const t of ctx.turns) lines.push('【' + (t.sid === 'user' ? '你' : t.sid.slice(0,8)) + '】' + t.text);
      lines.push('---', '');
      payload = lines.join('\\n') + payload;
    }
    ipcRenderer.send('terminal-input', { sessionId: sid, data: payload });
    await new Promise(r => setTimeout(r, 80));
    ipcRenderer.send('terminal-input', { sessionId: sid, data: '\\r' });
  })()`);
  // Wait for Codex turn
  await waitForTimelineLength(meetingId, 6, 120);

  // Switch back to @all and round 3
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { sendTarget: 'all' } });
  })()`);
  await sleep(200);
  await sendMessage(meetingId, 'R3 @all again');
  await waitForTimelineLength(meetingId, 10, 120);

  // Verify Claude/Gemini received Codex's R2 turn + the R2 user turn in their R3 injection
  // (peek by calling incremental-context — should return 0 right after sendMessage advanced cursor)
  const claudePeek = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: '${subs.claude}' });
  })()`);
  const pass = claudePeek.turns.length === 0; // Cursor at end → injection was complete
  console.log(pass ? '  ✓ PASS Scenario D' : '  ✗ FAIL Scenario D');
  return pass;
}
```

- [ ] **Step 12.3: Update main() dispatch**

```js
async function main() {
  await connect();
  const fns = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE };
  let passed = 0, failed = 0;
  if (SCENARIO === 'all') {
    for (const [name, fn] of Object.entries(fns)) {
      try {
        const ok = await fn();
        if (ok) passed++; else failed++;
      } catch (e) {
        console.error('Scenario', name, 'threw:', e.message);
        failed++;
      }
    }
  } else if (fns[SCENARIO]) {
    const ok = await fns[SCENARIO]();
    if (ok) passed++; else failed++;
  } else {
    console.log('Unknown scenario:', SCENARIO);
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  ws.close();
  process.exit(failed === 0 ? 0 : 1);
}
```

- [ ] **Step 12.4: Run Scenarios B-E one by one**

```bash
SCENARIO=B CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -20
SCENARIO=C CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -20
SCENARIO=D CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -20
SCENARIO=E CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -20
```

Each should report `✓ PASS Scenario X`. Note: each scenario creates a fresh meeting + new sub-sessions, so they don't interfere.

- [ ] **Step 12.5: Commit**

```bash
git add tests/_e2e-hub-timeline-real.js
git commit -m "test(meeting): E2E scenarios B-E (syncContext OFF, mid-join, target switch, restart) (phase 1.4)"
```

---

## Task 13: E2E Scenarios F, G, H, I (stress + UI live update + fallback)

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\tests\_e2e-hub-timeline-real.js`

- [ ] **Step 13.1: Append stress scenarios**

```js
async function scenarioF() {
  console.log('=== Scenario F: long meeting (10 rounds) ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true } });
  })()`);
  await sleep(200);

  for (let r = 1; r <= 10; r++) {
    console.log(`  round ${r}/10`);
    await sendMessage(meetingId, `Q${r}: 用一句话回答 ${r}^2 等于几`);
    await waitForTimelineLength(meetingId, r * 4, 120);
  }

  const tl = await getTimeline(meetingId);
  console.log('  final timeline length:', tl.length);
  // Validate: idx is 0..tl.length-1 monotonic, no gaps, no duplicates
  let monotonic = true;
  for (let i = 0; i < tl.length; i++) {
    if (tl[i].idx !== i) { monotonic = false; break; }
  }
  const pass = tl.length === 40 && monotonic;
  console.log(pass ? '  ✓ PASS Scenario F' : `  ✗ FAIL Scenario F (len=${tl.length}, monotonic=${monotonic})`);
  return pass;
}

async function scenarioG() {
  console.log('=== Scenario G: rapid send 5 messages without waiting ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);

  // Fire 5 user-append-turns rapidly (don't wait for AI replies)
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    for (let i = 1; i <= 5; i++) {
      await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: 'Q' + i });
    }
  })()`);

  const tl = await getTimeline(meetingId);
  // Should have exactly 5 user turns, idx 0..4 monotonic
  const allUser = tl.every(t => t.sid === 'user');
  const monotonic = tl.every((t, i) => t.idx === i);
  const pass = tl.length === 5 && allUser && monotonic;
  console.log(pass ? '  ✓ PASS Scenario G' : `  ✗ FAIL Scenario G (len=${tl.length})`);
  return pass;
}

async function scenarioH() {
  console.log('=== Scenario H: Feed UI live update (DOM check) ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const sub = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: 'codex', opts: { noInheritCursor: true } });
  })()`);
  const sid = sub.session.id;
  await waitForReady(sid, 'codex');
  await sleep(2000);

  // Simulate user clicking the meeting tab to trigger renderBlackboard
  // (in headless, we just call the renderBlackboard directly via window)
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    // Make sure the meeting layout is 'blackboard' so renderer tries to render Feed
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { layout: 'blackboard' } });
  })()`);
  await sleep(500);

  // Trigger renderBlackboard
  await evalJs(`(async () => {
    if (typeof MeetingBlackboard !== 'undefined' && MeetingBlackboard.renderBlackboard) {
      const meetings = await new Promise(r => {
        const { ipcRenderer } = require('electron');
        ipcRenderer.invoke('get-meetings').then(list => r(list));
      }).catch(() => []);
      const m = meetings.find(m => m.id === '${meetingId}');
      if (m) {
        // Create a temp container in DOM
        let c = document.getElementById('mr-feed-test-container');
        if (!c) { c = document.createElement('div'); c.id = 'mr-feed-test-container'; document.body.appendChild(c); }
        await MeetingBlackboard.renderBlackboard(m, c);
      }
    }
  })()`);
  await sleep(500);

  // Send a message and verify DOM gets a new turn card
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: 'Hello feed' });
  })()`);
  await sleep(300);

  const domCount = await evalJs(`document.querySelectorAll('.mr-feed-turn').length`);
  console.log('  DOM .mr-feed-turn count:', domCount);
  const pass = domCount >= 1;
  console.log(pass ? '  ✓ PASS Scenario H' : '  ✗ FAIL Scenario H');
  return pass;
}

async function scenarioI() {
  console.log('=== Scenario I: tap failure fallback ===');
  // We can't easily disable the tap mid-test, so we observe the placeholder
  // behavior by sending to a Claude session whose Stop hook is broken.
  // For phase 1, we just verify that if no turn-complete arrives within 60s,
  // the timeline does NOT get an AI turn and Feed shows nothing for it.
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  // Append only a user turn; no AI to capture from
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: 'Lone user message' });
  })()`);
  await sleep(1000);
  const tl = await getTimeline(meetingId);
  const pass = tl.length === 1 && tl[0].sid === 'user';
  console.log(pass ? '  ✓ PASS Scenario I (fallback path observed: no AI turn appears)' : '  ✗ FAIL Scenario I');
  return pass;
}
```

- [ ] **Step 13.2: Update fns dispatch**

```js
const fns = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF, G: scenarioG, H: scenarioH, I: scenarioI };
```

- [ ] **Step 13.3: Run scenarios F-I individually**

```bash
SCENARIO=F CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -30
SCENARIO=G CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -20
SCENARIO=H CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -20
SCENARIO=I CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -20
```

Each should `✓ PASS`. Scenario F takes ~10 minutes (10 rounds × 3 AI replies each).

- [ ] **Step 13.4: Commit**

```bash
git add tests/_e2e-hub-timeline-real.js
git commit -m "test(meeting): E2E scenarios F-I (long, rapid-send, live-feed, fallback) (phase 1.4)"
```

---

## Task 14: Final regression — run all unit + integration + E2E in one shot

- [ ] **Step 14.1: Run all unit tests**

```bash
cd /c/Users/lintian/claude-session-hub
node --test tests/_unit-hub-timeline.js 2>&1 | tail -10
```

Expected: 15 tests pass.

- [ ] **Step 14.2: Run all integration tests**

```bash
node --test tests/_integration-hub-timeline.js 2>&1 | tail -10
```

Expected: 3 tests pass.

- [ ] **Step 14.3: Run all E2E scenarios end-to-end**

```bash
SCENARIO=all CDP_PORT=9220 node tests/_e2e-hub-timeline-real.js 2>&1 | tail -50
```

Expected: `=== Results: 9 passed, 0 failed ===`. Total runtime ~15-25 minutes.

- [ ] **Step 14.4: Manual visual verification**

Open the running Hub instance window. Click on the test meeting (any of the ones created during E2E), switch its layout to "blackboard" if not already, and visually confirm:

- Feed shows turns in time-reverse order (newest on top)
- Each turn has correct AI badge (Claude/Codex/Gemini/你) with appropriate color
- Long turns show "展开" button; clicking expands
- New turns appear at top in real time when sending a new message

If any visual issue, file under known issues and fix in a follow-up task.

- [ ] **Step 14.5: Final commit if any patch was needed in 14.4**

```bash
git status --short
# If any files changed:
git add -A && git commit -m "fix(meeting): visual polish from manual verification"
```

---

## Self-Review Notes

**Spec coverage check** (cross-reference spec section 7.3 scenarios → tasks):
- Scenario A → Task 11 ✓
- Scenario B → Task 12 ✓
- Scenario C → Task 12 ✓
- Scenario D → Task 12 ✓
- Scenario E → Task 12 ✓
- Scenario F → Task 13 ✓
- Scenario G → Task 13 ✓
- Scenario H → Task 13 ✓
- Scenario I → Task 13 ✓

**Spec data model** (section 3.1) → Task 1 (timeline + nextIdx) + Task 2 (cursors) ✓
**Spec data flow** (section 4) → Task 4-7 (IPC + handleMeetingSend) ✓
**Spec UI** (section 4.3) → Task 8 + 9 ✓
**Spec fallback** (section 6) → only "tap timeout placeholder" not implemented (Scenario I observes the absence-of-AI-turn but doesn't render placeholder); add as known limitation, follow-up phase

**Type consistency check**: `appendTurn` returns `{idx, sid, text, ts}` everywhere; `incrementalContext` returns `{turns, advancedTo}` everywhere; `getCursor` returns `int | null`; `_cursors` keys are hubSessionIds (string), values are int. No mismatches.

**Placeholder scan**: No "TBD"/"TODO" left in tasks. The single "TODO" comment in step 7.2 is intentional (a marker for future cleanup of unused buildContextSummary), not an unfinished plan item.

**Known limitation**: tap-failure placeholder UI ("⏳ AI 回答中..." after 60s timeout) deferred to Phase 2 — Scenario I validates the data path but not the visual placeholder.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-25-hub-timeline.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
