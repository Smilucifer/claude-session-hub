# 通用圆桌模式（General Roundtable）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Hub 会议室的"自由讨论模式"替换成通用圆桌（roundtableMode），复用投研圆桌的状态机/UI/Orchestrator，新增单家 @<who> 私聊语义；投研圆桌零回归。

**Architecture:** 新增独立 `roundtableMode` 字段（与 `researchMode` 互斥）；新建 `core/general-roundtable-mode.js` 提供通用 RULES + prompt 写盘；renderer 把现有 `researchMode` 条件分支扩展为 `researchMode || roundtableMode`；私聊走独立 `<id>-roundtable-private.json` 持久化，不入 turn-N.json。

**Tech Stack:** Electron 主进程 (Node.js + IPC) · Renderer 进程 (Vanilla JS + xterm.js) · Roundtable Orchestrator (fs JSON 持久化) · Playwright + CDP (E2E)

**Spec:** `C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-04-28-free-roundtable-mode-design.md`

**Branch:** `feature/general-roundtable`
**Worktree:** `C:\Users\lintian\AppData\Local\Temp\hub-roundtable`
**测试用 Hub 数据目录:** `C:\temp\hub-roundtable-test`

---

## File Structure

### Create
| 文件 | 职责 |
|---|---|
| `core/general-roundtable-mode.js` | 通用 RULES_TEMPLATE + writeGeneralRoundtablePromptFile + writeCovenantSnapshot + readCovenantSnapshot + cleanupGeneralRoundtableFiles + RESUME_REMINDER |
| `core/general-roundtable-private-store.js` | 私聊历史持久化：append/read/cleanup `<id>-roundtable-private.json` |
| `tests/unit-general-roundtable-mode.test.js` | 单元测试：prompt 文件内容 / 互斥 / 私聊存储 |
| `tests/_e2e-general-roundtable.js` | E2E：圆桌默认渲染 / fanout 一轮 / @debate / @summary / @<who> 私聊 |
| `tests/_e2e-research-zero-regression.js` | E2E：投研圆桌完整流程 / 与改造前对比 |

### Modify
| 文件 | 改动 |
|---|---|
| `core/meeting-room.js` | createMeeting 默认字段；updateMeeting allowed 列表加 `roundtableMode`/`generalRoundtableCovenant`；toggle 互斥 |
| `main.js` | 新增 `toggle-roundtable-mode` IPC；session-bootstrap 时支持 roundtableMode 写 prompt 文件；新增 `roundtable-private:append/list` IPC；closeMeeting 调 cleanup |
| `renderer/meeting-room.js` | parseDriverCommand 新分支；UI 渲染条件扩展；@<who> 私聊路径；卡片 💬 角标；抽屉私聊 Tab |
| `renderer/meeting-room.css` | 💬 角标样式 + 私聊 Tab 样式 |
| `renderer/meeting-blackboard.js` | 渲染条件改为"仅 driverMode" |
| `renderer/index.html` | 顶部三态切换按钮 |
| `renderer/renderer.js` | 新建会议室入口默认 `roundtableMode: true` |

### NOT Modified (硬约束 C1)
- `core/research-mode.js`
- `core/research-mcp-server.js`
- `core/roundtable-orchestrator.js`
- 所有 `<id>-research.md` / `<id>-research-mcp.json` / `<id>-covenant.md` 文件命名相关代码

---

## Phase 0: Worktree 准备

### Task 0.1: 创建 worktree + junction node_modules

**Files:**
- 操作: 在 `C:\Users\lintian\claude-session-hub\` 创建 worktree

- [ ] **Step 1: 检查当前分支干净**

```bash
git -C C:/Users/lintian/claude-session-hub status --short
```

Expected: 空输出（无未提交修改）。如有，先 stash 或 commit。

- [ ] **Step 2: 创建分支与 worktree**

```bash
git -C C:/Users/lintian/claude-session-hub checkout -b feature/general-roundtable
git -C C:/Users/lintian/claude-session-hub worktree add C:/Users/lintian/AppData/Local/Temp/hub-roundtable HEAD
```

Expected: `Preparing worktree (new branch 'feature/general-roundtable')` + worktree 创建成功。

- [ ] **Step 3: junction node_modules**

```bash
cmd //c mklink /J "C:\Users\lintian\AppData\Local\Temp\hub-roundtable\node_modules" "C:\Users\lintian\claude-session-hub\node_modules"
```

Expected: `Junction created` 输出，returncode=0。

- [ ] **Step 4: smoke test 启动**

```bash
cd C:/Users/lintian/AppData/Local/Temp/hub-roundtable && CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: 看到 `[hub] hook server listening on 127.0.0.1:...`。看到 `Cannot find module` 立即停止排查。

---

## Phase 1: 后端骨架（core 模块）

### Task 1.1: 新建 `core/general-roundtable-mode.js`

**Files:**
- Create: `C:\Users\lintian\AppData\Local\Temp\hub-roundtable\core\general-roundtable-mode.js`

- [ ] **Step 1: 写文件**

```js
'use strict';
// General Roundtable mode — 通用圆桌讨论
// 与 research-mode（投研圆桌）平行的会议室模式：三家 AI 平等讨论任意话题
// 不预设场景，仅注入通用 rules + 可选用户公约（默认空）
//
// 与 research-mode 的关键区别：
//   - 不引导特定数据源（无 LinDangAgent / 投研专属）
//   - covenant 默认空字符串（用户想加再加，不预置场景模板）
//   - 触发语法多一个：@<who> 单家私聊（不入轮次）

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Template: General Roundtable rules（系统级，所有通用圆桌固定）
// ---------------------------------------------------------------------------
const GENERAL_ROUNDTABLE_RULES_TEMPLATE = `# 圆桌讨论规则

## 你的角色
你和另外两位 AI 同事（共三家：Claude / Gemini / Codex）受邀加入用户的圆桌讨论。
**地位完全平等，本色发挥，不需要扮演角色。** 你怎么思考就怎么回答，不要套模板。

## 圆桌的运作方式
用户用以下语法驱动讨论：

1. **默认提问**：用户发普通文本 → 三家独立回答（互不知情）。这一轮你不会看到另两家在写什么。
2. **@debate 触发**：用户发 \`@debate\` 或 \`@debate <补充信息>\` → 系统会把另两家上一轮的完整观点发给你 → 请你结合他们的视角发表新观点（可继承可反驳，可纳入用户补充的新信息）。
3. **@summary @<你> 触发**：用户发 \`@summary @claude\`（或 @gemini / @codex）→ 系统会把所有历史轮次的三家观点汇总给被点名那位 → 由他给出综合意见。
4. **@<你> 私聊**：用户发 \`@claude <内容>\`（或 @gemini / @codex / 多家但非全员）→ 仅你看到，不入圆桌历史。这是用户与你的私下讨论，专注一对一即可。

⚠ 你看不到另两家观点时，不要假装你看得到。专注本色独立回答。

## 协作礼仪
- @debate 时引用对方观点请明示（"Gemini 提到的 XX..."），便于用户追溯
- 不要因为另两家观点强势就放弃自己的判断；该坚持就坚持，该改就改要说明为什么
- @summary 阶段被点到时，写成可读决策报告（结论先行 + 关键分歧 + 行动建议），不要只复读三家观点
- 私聊时不要假装其他 AI 在场，专注一对一对话

## 工具与资源
你可以使用自己已有的能力辅助回答：联网搜索、读取本地文件、运行代码、调用 MCP 工具。
能查就查，不要假装"凭印象"。但每次工具调用前评估必要性，避免无意义的探查。

## 留白
你是用户的智囊伙伴，不是答题机器。
该坚持时坚持，该改主意时改主意，信息不足时主动说"我需要 X"。
`;

// 通用版默认 covenant 为空（不预设场景）。用户在 UI 编辑后写入 <id>-roundtable-covenant.md
const DEFAULT_COVENANT = '';

// 通用圆桌的 Claude resume 提醒
const GENERAL_ROUNDTABLE_RESUME_REMINDER = `[系统提醒] 你正在通用圆桌（Roundtable）中恢复会话。请继续遵守以下规则：
- 三家平等本色发挥，不扮演角色
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合）/ @<你> 私聊（一对一）
- 善用你的工具（联网/读文件/跑代码/MCP）辅助回答
`;

// ---------------------------------------------------------------------------
// Prompt file management
// ---------------------------------------------------------------------------
function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 合成 system prompt 文件：rules（系统约束）+ covenant（用户偏好，可空）
// 三家共享同一文件，平等注入。
function writeGeneralRoundtablePromptFile(hubDataDir, meetingId, customCovenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-roundtable.md`);
  const covenant = (typeof customCovenantText === 'string' && customCovenantText.trim().length > 0)
    ? customCovenantText
    : DEFAULT_COVENANT;
  // covenant 非空时才追加分隔线 + 公约段；空 covenant 仅写 rules
  const content = covenant.trim().length > 0
    ? `${GENERAL_ROUNDTABLE_RULES_TEMPLATE}\n\n---\n\n${covenant}`
    : GENERAL_ROUNDTABLE_RULES_TEMPLATE;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeCovenantSnapshot(hubDataDir, meetingId, covenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-roundtable-covenant.md`);
  fs.writeFileSync(filePath, covenantText || DEFAULT_COVENANT, 'utf-8');
  return filePath;
}

function readCovenantSnapshot(hubDataDir, meetingId) {
  const filePath = path.join(arenaPromptsDir(hubDataDir), `${meetingId}-roundtable-covenant.md`);
  if (!fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function cleanupGeneralRoundtableFiles(hubDataDir, meetingId) {
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) return;
  const targets = [
    `${meetingId}-roundtable.md`,
    `${meetingId}-roundtable-covenant.md`,
    `${meetingId}-roundtable-private.json`,
  ];
  for (const f of targets) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}

module.exports = {
  GENERAL_ROUNDTABLE_RULES_TEMPLATE,
  DEFAULT_COVENANT,
  GENERAL_ROUNDTABLE_RESUME_REMINDER,
  writeGeneralRoundtablePromptFile,
  writeCovenantSnapshot,
  readCovenantSnapshot,
  cleanupGeneralRoundtableFiles,
};
```

- [ ] **Step 2: commit**

```bash
git -C C:/Users/lintian/AppData/Local/Temp/hub-roundtable add core/general-roundtable-mode.js
git -C C:/Users/lintian/AppData/Local/Temp/hub-roundtable commit -m "feat: add general-roundtable-mode with universal rules template"
```

---

### Task 1.2: 新建 `core/general-roundtable-private-store.js`

**Files:**
- Create: `core/general-roundtable-private-store.js`

- [ ] **Step 1: 写文件**

```js
'use strict';
// General Roundtable Private Store — 私聊历史持久化
// 私聊（@<who> 单家或多家但非全员）独立存储，不入 roundtable.json 的 turns
//
// 文件结构：<arena-prompts>/<meetingId>-roundtable-private.json
// {
//   claude: [{ ts, userInput, response }, ...],
//   gemini: [{ ts, userInput, response }, ...],
//   codex:  [{ ts, userInput, response }, ...],
// }

const fs = require('fs');
const path = require('path');

const MAX_PRIVATE_TURNS_PER_KIND = 50; // 软上限，超出截断最早的

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function privateFilePath(hubDataDir, meetingId) {
  return path.join(arenaPromptsDir(hubDataDir), `${meetingId}-roundtable-private.json`);
}

function readPrivateStore(hubDataDir, meetingId) {
  const fp = privateFilePath(hubDataDir, meetingId);
  if (!fs.existsSync(fp)) return { claude: [], gemini: [], codex: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return {
      claude: Array.isArray(raw.claude) ? raw.claude : [],
      gemini: Array.isArray(raw.gemini) ? raw.gemini : [],
      codex: Array.isArray(raw.codex) ? raw.codex : [],
    };
  } catch (e) {
    console.warn(`[private-store] read failed for ${meetingId}: ${e.message}`);
    return { claude: [], gemini: [], codex: [] };
  }
}

function appendPrivateTurn(hubDataDir, meetingId, kind, userInput, response) {
  if (!['claude', 'gemini', 'codex'].includes(kind)) {
    throw new Error(`invalid kind: ${kind}`);
  }
  const store = readPrivateStore(hubDataDir, meetingId);
  store[kind].push({
    ts: Date.now(),
    userInput: typeof userInput === 'string' ? userInput : '',
    response: typeof response === 'string' ? response : '',
  });
  if (store[kind].length > MAX_PRIVATE_TURNS_PER_KIND) {
    store[kind] = store[kind].slice(-MAX_PRIVATE_TURNS_PER_KIND);
  }
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privateFilePath(hubDataDir, meetingId), JSON.stringify(store, null, 2), 'utf-8');
}

function listPrivateTurns(hubDataDir, meetingId, kind) {
  const store = readPrivateStore(hubDataDir, meetingId);
  if (kind && ['claude', 'gemini', 'codex'].includes(kind)) {
    return store[kind] || [];
  }
  return store;
}

module.exports = {
  appendPrivateTurn,
  listPrivateTurns,
  readPrivateStore,
  privateFilePath,
  MAX_PRIVATE_TURNS_PER_KIND,
};
```

- [ ] **Step 2: commit**

```bash
git add core/general-roundtable-private-store.js
git commit -m "feat: add private-store for general-roundtable @<who> chats"
```

---

### Task 1.3: 单元测试通用圆桌模块

**Files:**
- Create: `tests/unit-general-roundtable-mode.test.js`

- [ ] **Step 1: 写测试**

```js
'use strict';
// 单元测试 core/general-roundtable-mode.js + general-roundtable-private-store.js
// 用 Node 内置 assert + 临时目录隔离

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const grm = require('../core/general-roundtable-mode');
const grps = require('../core/general-roundtable-private-store');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'grm-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// === RULES 内容契约 ===
function testRulesContent() {
  const r = grm.GENERAL_ROUNDTABLE_RULES_TEMPLATE;
  assert.ok(r.includes('圆桌讨论规则'), 'rules should contain title');
  assert.ok(r.includes('@debate'), 'rules should mention @debate');
  assert.ok(r.includes('@summary @<你>'), 'rules should mention @summary @<who>');
  assert.ok(r.includes('@<你> 私聊'), 'rules should mention private chat syntax');
  assert.ok(!r.includes('LinDangAgent'), 'rules MUST NOT mention LinDangAgent (general, not 投研)');
  assert.ok(!r.includes('A 股'), 'rules MUST NOT mention 投研 specifics');
  assert.ok(!r.includes('tushare'), 'rules MUST NOT mention 投研 data source');
  console.log('  ✓ testRulesContent');
}

// === 写 prompt：空 covenant 仅写 rules ===
function testWriteWithEmptyCovenant() {
  const d = tmpDir();
  const fp = grm.writeGeneralRoundtablePromptFile(d, 'meeting-A', '');
  const content = fs.readFileSync(fp, 'utf-8');
  assert.ok(content === grm.GENERAL_ROUNDTABLE_RULES_TEMPLATE, 'empty covenant: only rules');
  assert.ok(!content.includes('---'), 'no separator when covenant empty');
  console.log('  ✓ testWriteWithEmptyCovenant');
}

// === 写 prompt：非空 covenant 拼接 ===
function testWriteWithCovenant() {
  const d = tmpDir();
  const fp = grm.writeGeneralRoundtablePromptFile(d, 'meeting-B', '## 我的偏好\n喜欢简洁回答');
  const content = fs.readFileSync(fp, 'utf-8');
  assert.ok(content.includes('圆桌讨论规则'), 'has rules');
  assert.ok(content.includes('---'), 'has separator');
  assert.ok(content.includes('我的偏好'), 'has covenant');
  console.log('  ✓ testWriteWithCovenant');
}

// === covenant 读写一致 ===
function testCovenantSnapshotRoundtrip() {
  const d = tmpDir();
  grm.writeCovenantSnapshot(d, 'meeting-C', '我的红线：禁止套模板');
  const r = grm.readCovenantSnapshot(d, 'meeting-C');
  assert.strictEqual(r, '我的红线：禁止套模板');
  console.log('  ✓ testCovenantSnapshotRoundtrip');
}

// === 读不存在的 covenant 返回 null ===
function testReadMissingCovenant() {
  const d = tmpDir();
  assert.strictEqual(grm.readCovenantSnapshot(d, 'never-existed'), null);
  console.log('  ✓ testReadMissingCovenant');
}

// === cleanup 清掉本会议室所有文件 ===
function testCleanup() {
  const d = tmpDir();
  grm.writeGeneralRoundtablePromptFile(d, 'meeting-D', 'x');
  grm.writeCovenantSnapshot(d, 'meeting-D', 'x');
  grps.appendPrivateTurn(d, 'meeting-D', 'claude', 'q', 'a');
  // 别的 meeting 不该被清掉
  grm.writeGeneralRoundtablePromptFile(d, 'meeting-E', 'y');

  grm.cleanupGeneralRoundtableFiles(d, 'meeting-D');

  const promptDir = path.join(d, 'arena-prompts');
  assert.ok(!fs.existsSync(path.join(promptDir, 'meeting-D-roundtable.md')));
  assert.ok(!fs.existsSync(path.join(promptDir, 'meeting-D-roundtable-covenant.md')));
  assert.ok(!fs.existsSync(path.join(promptDir, 'meeting-D-roundtable-private.json')));
  assert.ok(fs.existsSync(path.join(promptDir, 'meeting-E-roundtable.md')), 'sibling meeting untouched');
  console.log('  ✓ testCleanup');
}

// === 私聊存储：append + list ===
function testPrivateAppendList() {
  const d = tmpDir();
  grps.appendPrivateTurn(d, 'meeting-F', 'claude', 'hi', 'hello');
  grps.appendPrivateTurn(d, 'meeting-F', 'claude', 'q2', 'a2');
  grps.appendPrivateTurn(d, 'meeting-F', 'gemini', 'q3', 'a3');
  const all = grps.listPrivateTurns(d, 'meeting-F');
  assert.strictEqual(all.claude.length, 2);
  assert.strictEqual(all.gemini.length, 1);
  assert.strictEqual(all.codex.length, 0);
  assert.strictEqual(all.claude[0].userInput, 'hi');
  assert.strictEqual(all.claude[1].response, 'a2');
  console.log('  ✓ testPrivateAppendList');
}

// === 私聊存储：非法 kind 抛错 ===
function testPrivateInvalidKind() {
  const d = tmpDir();
  assert.throws(() => grps.appendPrivateTurn(d, 'm', 'unknown', 'q', 'a'), /invalid kind/);
  console.log('  ✓ testPrivateInvalidKind');
}

// === 私聊存储：超出软上限截断 ===
function testPrivateSoftCap() {
  const d = tmpDir();
  for (let i = 0; i < grps.MAX_PRIVATE_TURNS_PER_KIND + 5; i++) {
    grps.appendPrivateTurn(d, 'm', 'claude', `q${i}`, `a${i}`);
  }
  const list = grps.listPrivateTurns(d, 'm', 'claude');
  assert.strictEqual(list.length, grps.MAX_PRIVATE_TURNS_PER_KIND);
  // 最早的应被截断，最晚的保留
  assert.strictEqual(list[list.length - 1].userInput, `q${grps.MAX_PRIVATE_TURNS_PER_KIND + 4}`);
  console.log('  ✓ testPrivateSoftCap');
}

console.log('Running general-roundtable unit tests...');
testRulesContent();
testWriteWithEmptyCovenant();
testWriteWithCovenant();
testCovenantSnapshotRoundtrip();
testReadMissingCovenant();
testCleanup();
testPrivateAppendList();
testPrivateInvalidKind();
testPrivateSoftCap();
console.log('All passed.');
```

- [ ] **Step 2: 跑测试**

```bash
node tests/unit-general-roundtable-mode.test.js
```

Expected:
```
Running general-roundtable unit tests...
  ✓ testRulesContent
  ✓ testWriteWithEmptyCovenant
  ...
All passed.
```

- [ ] **Step 3: commit**

```bash
git add tests/unit-general-roundtable-mode.test.js
git commit -m "test: unit tests for general-roundtable-mode + private-store"
```

---

### Task 1.4: `core/meeting-room.js` — 加字段 + 互斥

**Files:**
- Modify: `core/meeting-room.js`

- [ ] **Step 1: createMeeting 添加新字段**

把 `createMeeting()` 里 meeting 对象初始化部分（约第 12-31 行）改为：

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
      driverMode: false,
      driverSessionId: null,
      pendingReviewId: null,
      researchMode: false,
      covenantText: '',
      // ↓ 新增：通用圆桌（默认开启，与 driverMode/researchMode 互斥）
      roundtableMode: true,
      generalRoundtableCovenant: '',
    };
    // ... 保持后续 timeline 初始化不变
    meeting._timeline = [];
    meeting._cursors = {};
    meeting._nextIdx = 0;
    this.meetings.set(id, meeting);
    return { ...meeting };
  }
```

- [ ] **Step 2: updateMeeting allowed 列表 + 互斥逻辑**

把 `updateMeeting(meetingId, fields)` 改为：

```js
  updateMeeting(meetingId, fields) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    const allowed = [
      'title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned',
      'lastMessageTime', 'status', 'lastScene', 'driverMode', 'driverSessionId',
      'pendingReviewId', 'researchMode', 'covenantText',
      // 新增字段
      'roundtableMode', 'generalRoundtableCovenant',
    ];
    for (const key of allowed) {
      if (key in fields) m[key] = fields[key];
    }
    // 三态互斥：开启某一个时关掉其他两个
    if (fields.roundtableMode === true) {
      m.researchMode = false;
      m.driverMode = false;
    }
    if (fields.researchMode === true) {
      m.roundtableMode = false;
      m.driverMode = false;
    }
    if (fields.driverMode === true) {
      m.roundtableMode = false;
      m.researchMode = false;
    }
    return { ...m, subSessions: [...m.subSessions] };
  }
```

- [ ] **Step 3: 跑单测验证不影响其他 createMeeting 调用方**

```bash
ls tests/ | grep -i meeting-room
```

如果存在 meeting-room 单测，运行：
```bash
node tests/<meeting-room-test>.js
```

如果没有专属单测，跳到 Step 4。

- [ ] **Step 4: commit**

```bash
git add core/meeting-room.js
git commit -m "feat(meeting-room): add roundtableMode field + mutual exclusion"
```

---

## Phase 2: IPC 与 Send 路由（main.js）

### Task 2.1: main.js 引入 general-roundtable-mode + private-store

**Files:**
- Modify: `main.js`（顶部 require 区，约第 23 行附近）

- [ ] **Step 1: 加 require**

在 `const researchMode = require('./core/research-mode.js');` 之后插入：

```js
const generalRoundtableMode = require('./core/general-roundtable-mode.js');
const generalRoundtablePrivateStore = require('./core/general-roundtable-private-store.js');
```

- [ ] **Step 2: 验证 Hub 启动正常**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: 看到 `[hub] hook server listening on 127.0.0.1:...`，无 `Cannot find module` 错。

- [ ] **Step 3: commit**

```bash
git add main.js
git commit -m "chore(main): require general-roundtable modules"
```

---

### Task 2.2: main.js — session-bootstrap 注入 prompt 文件支持 roundtableMode

**Files:**
- Modify: `main.js`（约第 465-495 行 + 第 1310-1320 行，2 处镜像逻辑）

- [ ] **Step 1: 找到 researchMode 分支并扩展**

main.js 现有逻辑（第 465 附近）：
```js
} else if (meeting && meeting.researchMode) {
  // covenantText optional 处理
  // ...
  const promptFile = researchMode.writeResearchPromptFile(hubDataDir, meetingId, covenantText);
  sessionOpts.appendSystemPromptFile = promptFile;
  // mcpConfig for claude / codex...
}
```

在该 `else if` 之后插入新分支：

```js
} else if (meeting && meeting.roundtableMode) {
  const covenantText = (typeof meeting.generalRoundtableCovenant === 'string' && meeting.generalRoundtableCovenant.length > 0)
    ? meeting.generalRoundtableCovenant
    : generalRoundtableMode.readCovenantSnapshot(hubDataDir, meetingId);
  if (typeof covenantText === 'string') {
    generalRoundtableMode.writeCovenantSnapshot(hubDataDir, meetingId, covenantText);
  }
  const promptFile = generalRoundtableMode.writeGeneralRoundtablePromptFile(hubDataDir, meetingId, covenantText);
  sessionOpts.appendSystemPromptFile = promptFile;
  // 通用圆桌不挂 MCP（用 CLI 自带工具能力）
}
```

- [ ] **Step 2: 第二处（resume 路径，约第 1310 附近）做镜像扩展**

找到：
```js
} else if (meeting && meeting.researchMode) {
  // ...
  driverOpts.appendSystemPromptFile = researchMode.writeResearchPromptFile(hubDataDir, meta.meetingId, covenantText);
}
```

在其后追加：

```js
} else if (meeting && meeting.roundtableMode) {
  const covenantText = (typeof meeting.generalRoundtableCovenant === 'string' && meeting.generalRoundtableCovenant.length > 0)
    ? meeting.generalRoundtableCovenant
    : generalRoundtableMode.readCovenantSnapshot(hubDataDir, meta.meetingId);
  driverOpts.appendSystemPromptFile = generalRoundtableMode.writeGeneralRoundtablePromptFile(hubDataDir, meta.meetingId, covenantText);
}
```

- [ ] **Step 3: closeMeeting 调 cleanup**

找到 `researchMode.cleanupResearchFiles(getHubDataDir(), meetingId)` 调用（约第 532 行），在其后追加：

```js
generalRoundtableMode.cleanupGeneralRoundtableFiles(getHubDataDir(), meetingId);
```

- [ ] **Step 4: 启动 smoke test**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: hook server listening 输出。

- [ ] **Step 5: commit**

```bash
git add main.js
git commit -m "feat(main): bootstrap roundtable prompt file on session start"
```

---

### Task 2.3: main.js — 新增 `toggle-roundtable-mode` IPC handler

**Files:**
- Modify: `main.js`（IPC handler 区域，约第 783 行 toggle-research-mode 附近，或 1123 行 covenant-template 附近）

- [ ] **Step 1: 添加 IPC handler**

参考现有 `toggle-research-mode` 的实现，在其相邻位置插入：

```js
ipcMain.handle('toggle-roundtable-mode', (_e, { meetingId, enabled, covenant } = {}) => {
  const m = meetingMgr.getMeeting(meetingId);
  if (!m) return { ok: false, error: 'meeting not found' };
  const fields = { roundtableMode: !!enabled };
  if (typeof covenant === 'string') fields.generalRoundtableCovenant = covenant;
  const updated = meetingMgr.updateMeeting(meetingId, fields);
  if (!updated) return { ok: false, error: 'update failed' };
  // 持久化 covenant 文件（即便空，便于 resume 一致）
  if (enabled) {
    const text = typeof covenant === 'string' ? covenant : (updated.generalRoundtableCovenant || '');
    generalRoundtableMode.writeCovenantSnapshot(getHubDataDir(), meetingId, text);
    generalRoundtableMode.writeGeneralRoundtablePromptFile(getHubDataDir(), meetingId, text);
  }
  // 推到 renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('meeting-updated', updated);
  }
  return { ok: true, meeting: updated };
});
```

- [ ] **Step 2: 添加私聊存储 IPC handler**

```js
ipcMain.handle('roundtable-private:append', (_e, { meetingId, kind, userInput, response } = {}) => {
  try {
    generalRoundtablePrivateStore.appendPrivateTurn(getHubDataDir(), meetingId, kind, userInput, response);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('roundtable-private:list', (_e, { meetingId, kind } = {}) => {
  return generalRoundtablePrivateStore.listPrivateTurns(getHubDataDir(), meetingId, kind);
});
```

- [ ] **Step 3: 启动 smoke test**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

- [ ] **Step 4: commit**

```bash
git add main.js
git commit -m "feat(main): add toggle-roundtable-mode + roundtable-private IPC handlers"
```

---

## Phase 3: 前端解析（renderer/meeting-room.js）

### Task 3.1: parseDriverCommand 加 roundtableMode 分支

**Files:**
- Modify: `renderer/meeting-room.js`（约第 26-63 行）

- [ ] **Step 1: 在 researchMode 分支后插入 roundtableMode 分支**

把 `parseDriverCommand` 整个函数替换为：

```js
  function parseDriverCommand(text, meeting) {
    if (!meeting) return { type: 'normal', text, targets: null };

    // Research mode: 三家平等圆桌（投研专属，零修改）
    if (meeting.researchMode) {
      let rest = text.trim();
      const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
      const debateRe = /^@debate\b\s*/i;
      let m;
      if ((m = rest.match(summaryRe))) {
        return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
      }
      if ((m = rest.match(debateRe))) {
        return { type: 'rt-debate', text: rest.slice(m[0].length) };
      }
      return { type: 'rt-fanout', text: rest };
    }

    // 通用圆桌：默认 fanout，新增 @<who> 单聊
    if (meeting.roundtableMode) {
      let rest = text.trim();
      // 1. @summary @<who>
      const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
      let m;
      if ((m = rest.match(summaryRe))) {
        return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
      }
      // 2. @debate
      const debateRe = /^@debate\b\s*/i;
      if ((m = rest.match(debateRe))) {
        return { type: 'rt-debate', text: rest.slice(m[0].length) };
      }
      // 3. @all 等同 fanout
      const allRe = /^@all\b\s*/i;
      if ((m = rest.match(allRe))) {
        return { type: 'rt-fanout', text: rest.slice(m[0].length) };
      }
      // 4. @<who> 单家或多家但非全员 → 私聊
      const targets = [];
      const tokenRe = /^@(claude|gemini|codex)\b\s*/i;
      while (true) {
        const t = rest.match(tokenRe);
        if (!t) break;
        const tok = t[1].toLowerCase();
        if (!targets.includes(tok)) targets.push(tok);
        rest = rest.slice(t[0].length);
      }
      if (targets.length === 3) {
        // 三家全 @ 等同 @all
        return { type: 'rt-fanout', text: rest };
      }
      if (targets.length > 0) {
        return { type: 'rt-private', targetKinds: targets, text: rest };
      }
      // 5. 默认 fanout
      return { type: 'rt-fanout', text: rest };
    }

    // Driver mode（编码主驾，零修改）
    if (!meeting.driverMode) return { type: 'normal', text, targets: null };
    let rest = text.trim();
    const targets = [];
    let wantReview = false;
    const tokenRe = /^@(review|审查|gemini|codex|claude)\b\s*/i;
    while (true) {
      const m = rest.match(tokenRe);
      if (!m) break;
      const tok = m[1].toLowerCase();
      if (tok === 'review' || tok === '审查') {
        wantReview = true;
      } else if (!targets.includes(tok)) {
        targets.push(tok);
      }
      rest = rest.slice(m[0].length);
    }
    if (wantReview) return { type: 'review', text: rest };
    if (targets.length > 0) return { type: 'direct', targetKinds: targets, text: rest };
    return { type: 'driver-only', text };
  }
```

- [ ] **Step 2: 验证 - 写一个解析单测**

Create: `tests/unit-parse-driver-command.test.js`

```js
'use strict';
// 单测 parseDriverCommand 的 roundtableMode 分支
// 由于函数定义在 renderer IIFE 内部，这里用字符串提取 + new Function 评估的方式独立测试
// 或者：直接 import 函数（如果你愿意把它 module.exports）。
// 简单起见，本测试用复制函数体到测试文件的方式（小函数可接受）。

const assert = require('assert');

// 复制 parseDriverCommand（保持与 renderer/meeting-room.js 同步）
function parseDriverCommand(text, meeting) {
  if (!meeting) return { type: 'normal', text, targets: null };
  if (meeting.researchMode) {
    let rest = text.trim();
    const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
    const debateRe = /^@debate\b\s*/i;
    let m;
    if ((m = rest.match(summaryRe))) return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
    if ((m = rest.match(debateRe))) return { type: 'rt-debate', text: rest.slice(m[0].length) };
    return { type: 'rt-fanout', text: rest };
  }
  if (meeting.roundtableMode) {
    let rest = text.trim();
    const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
    let m;
    if ((m = rest.match(summaryRe))) return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
    if ((m = rest.match(/^@debate\b\s*/i))) return { type: 'rt-debate', text: rest.replace(/^@debate\s*/i, '') };
    if ((m = rest.match(/^@all\b\s*/i))) return { type: 'rt-fanout', text: rest.replace(/^@all\s*/i, '') };
    const targets = [];
    const tokenRe = /^@(claude|gemini|codex)\b\s*/i;
    while (true) {
      const t = rest.match(tokenRe);
      if (!t) break;
      const tok = t[1].toLowerCase();
      if (!targets.includes(tok)) targets.push(tok);
      rest = rest.slice(t[0].length);
    }
    if (targets.length === 3) return { type: 'rt-fanout', text: rest };
    if (targets.length > 0) return { type: 'rt-private', targetKinds: targets, text: rest };
    return { type: 'rt-fanout', text: rest };
  }
  return { type: 'normal', text, targets: null };
}

const RT = { roundtableMode: true };
const RM = { researchMode: true };

// roundtableMode 解析
assert.deepStrictEqual(parseDriverCommand('hello', RT), { type: 'rt-fanout', text: 'hello' });
assert.deepStrictEqual(parseDriverCommand('@all hi', RT), { type: 'rt-fanout', text: 'hi' });
assert.deepStrictEqual(parseDriverCommand('@debate maybe', RT), { type: 'rt-debate', text: 'maybe' });
assert.deepStrictEqual(parseDriverCommand('@summary @claude', RT), { type: 'rt-summary', summarizerKind: 'claude', text: '' });
assert.deepStrictEqual(parseDriverCommand('@summary @gemini why', RT), { type: 'rt-summary', summarizerKind: 'gemini', text: 'why' });
assert.deepStrictEqual(parseDriverCommand('@claude solve', RT), { type: 'rt-private', targetKinds: ['claude'], text: 'solve' });
assert.deepStrictEqual(parseDriverCommand('@claude @gemini comment', RT), { type: 'rt-private', targetKinds: ['claude', 'gemini'], text: 'comment' });
assert.deepStrictEqual(parseDriverCommand('@claude @gemini @codex hi', RT), { type: 'rt-fanout', text: 'hi' });

// researchMode 路径未变（C1 验证）
assert.deepStrictEqual(parseDriverCommand('foo', RM), { type: 'rt-fanout', text: 'foo' });
assert.deepStrictEqual(parseDriverCommand('@debate', RM), { type: 'rt-debate', text: '' });
assert.deepStrictEqual(parseDriverCommand('@summary @codex', RM), { type: 'rt-summary', summarizerKind: 'codex', text: '' });
// researchMode 不解析 @<who> 单聊（保持原行为：直接进 fanout，文本是原文）
assert.deepStrictEqual(parseDriverCommand('@claude solo', RM), { type: 'rt-fanout', text: '@claude solo' });

console.log('parseDriverCommand: all passed');
```

```bash
node tests/unit-parse-driver-command.test.js
```

Expected: `parseDriverCommand: all passed`

- [ ] **Step 3: commit**

```bash
git add renderer/meeting-room.js tests/unit-parse-driver-command.test.js
git commit -m "feat(renderer): parseDriverCommand handles roundtableMode w/ @<who> private"
```

---

### Task 3.2: handleMeetingSend 加 roundtableMode 路由

**Files:**
- Modify: `renderer/meeting-room.js`（约第 1474-1494 行）

- [ ] **Step 1: 扩展 researchMode 分支为 researchMode||roundtableMode**

把现有 1480-1494 行：

```js
    if (current.researchMode) {
      const cmd = parseDriverCommand(text, current);
      if (cmd.type === 'rt-fanout' || cmd.type === 'rt-debate' || cmd.type === 'rt-summary') {
        const mode = cmd.type === 'rt-fanout' ? 'fanout' : cmd.type === 'rt-debate' ? 'debate' : 'summary';
        try {
          await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });
        } catch (e) { console.warn('[meeting-room] append-user-turn failed:', e.message); }
        triggerRoundtable(current, mode, {
          userInput: cmd.text || '',
          summarizerKind: cmd.summarizerKind || null,
        });
        return;
      }
    }
```

替换为：

```js
    if (current.researchMode || current.roundtableMode) {
      const cmd = parseDriverCommand(text, current);
      // 公共轮次：fanout / debate / summary 走 orchestrator
      if (cmd.type === 'rt-fanout' || cmd.type === 'rt-debate' || cmd.type === 'rt-summary') {
        const mode = cmd.type === 'rt-fanout' ? 'fanout' : cmd.type === 'rt-debate' ? 'debate' : 'summary';
        try {
          await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });
        } catch (e) { console.warn('[meeting-room] append-user-turn failed:', e.message); }
        triggerRoundtable(current, mode, {
          userInput: cmd.text || '',
          summarizerKind: cmd.summarizerKind || null,
        });
        return;
      }
      // 私聊：单家或多家但非全员，不入轮次
      if (cmd.type === 'rt-private') {
        const kinds = cmd.targetKinds || [];
        const sids = [];
        for (const kind of kinds) {
          const sid = findSessionByKind(current, kind);
          if (sid && !sids.includes(sid)) sids.push(sid);
        }
        if (sids.length === 0) {
          console.warn('[meeting-room] rt-private: no matching session for kinds', kinds);
          return;
        }
        try {
          await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });
        } catch (e) { console.warn('[meeting-room] append-user-turn failed:', e.message); }
        for (const sessionId of sids) {
          const payload = cmd.text || '';
          ipcRenderer.send('terminal-input', { sessionId, data: payload });
          const session = sessions ? sessions.get(sessionId) : null;
          const baseDelay = session && session.kind === 'codex' ? 400 : 200;
          const sizeDelay = Math.min(Math.floor(payload.length / 100) * 10, 500);
          setTimeout(() => {
            ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
          }, baseDelay + sizeDelay);
        }
        // 写入私聊存储（response 当前为空，由 transcript-tap 后续回填或在抽屉读取轮次时直接读）
        for (const kind of kinds) {
          ipcRenderer.invoke('roundtable-private:append', {
            meetingId: meeting.id,
            kind,
            userInput: cmd.text || '',
            response: '',  // MVP：response 留空，UI 抽屉显示用户输入即可
          }).catch(e => console.warn('[meeting-room] private append failed:', e.message));
        }
        meeting.lastMessageTime = Date.now();
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
        return;
      }
    }
```

- [ ] **Step 2: 启动 Hub 手测**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9221 &
```

打开新会议室，验证：
- 默认就有 roundtableMode（卡片 UI 出现）
- 发"hello" 触发 fanout
- 发"@claude hi" 不触发 orchestrator，输入直送 Claude 终端

- [ ] **Step 3: commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(renderer): handleMeetingSend route rt-private to single CLI"
```

---

### Task 3.3: UI 渲染条件扩展（卡片 / 抽屉）

**Files:**
- Modify: `renderer/meeting-room.js`（多处 `meeting.researchMode` 检查点）

- [ ] **Step 1: grep 找出所有 researchMode UI 检查点**

```bash
grep -n "researchMode" renderer/meeting-room.js
```

预期会找到 ~10-15 处。

- [ ] **Step 2: 把所有"if (meeting.researchMode)"改为"if (meeting.researchMode || meeting.roundtableMode)"**

只针对 UI 渲染路径（`refreshRoundtablePanel`、`_renderRtPanelHtml`、`_removeRtPanel` 等），不动 prompt 文件路径。

逐个 grep 出的位置确认。典型例子：

修改 `refreshRoundtablePanel`（约第 230 行）：
```js
  async function refreshRoundtablePanel(meeting) {
    if (!meeting || (!meeting.researchMode && !meeting.roundtableMode)) {
      _removeRtPanel();
      return;
    }
    // ... 后续不变
  }
```

- [ ] **Step 3: 标题文案动态化**

把 `_renderRtPanelHtml` 里写死的 "投研圆桌" 改为：

```js
const titleText = meeting && meeting.researchMode ? '投研圆桌' : '圆桌讨论';
```

并在 header 模板里用 `${titleText}`。

- [ ] **Step 4: 启动 Hub 手测**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9221 &
```

- 新建会议 → 看到"圆桌讨论"标题
- toggle 投研 → 标题变"投研圆桌"
- toggle 回 → 标题"圆桌讨论"

- [ ] **Step 5: commit**

```bash
git add renderer/meeting-room.js
git commit -m "feat(renderer): UI conditions extend to roundtableMode + dynamic title"
```

---

### Task 3.4: 私聊 💬 角标 + 抽屉 Tab

**Files:**
- Modify: `renderer/meeting-room.js`（_renderRtCards、_openRtTimeline）
- Modify: `renderer/meeting-room.css`

- [ ] **Step 1: 卡片渲染加 💬 角标**

修改 `_renderRtCards` 函数（约 117-177 行），每个卡片在 header 处加：

```js
// 异步读取私聊条数（已缓存到 _privateCountCache）
const privateCount = (_privateCountCache[meeting.id] || {})[kind] || 0;
const privateBadge = privateCount > 0
  ? `<span class="mr-rt-private-badge" title="有 ${privateCount} 条私聊">💬 ${privateCount}</span>`
  : '';
```

并把 `privateBadge` 嵌到 `mr-rt-card-head` 里。同时在 IIFE 顶部声明：

```js
const _privateCountCache = {}; // { meetingId: { claude: N, gemini: N, codex: N } }
```

在 `refreshRoundtablePanel` 开头异步刷新 cache：

```js
try {
  const counts = await ipcRenderer.invoke('roundtable-private:list', { meetingId: meeting.id });
  _privateCountCache[meeting.id] = {
    claude: (counts.claude || []).length,
    gemini: (counts.gemini || []).length,
    codex:  (counts.codex  || []).length,
  };
} catch {}
```

- [ ] **Step 2: 抽屉加私聊 Tab**

修改 `_openRtTimeline`（约 278-349 行），在轮次 Tab 之外添加"私聊历史" Tab。把 tabsHtml 拼接逻辑改为：

```js
// 轮次 Tab（已有）+ 私聊 Tab（新增）
const privateTabIdx = turnsWithAns.length; // 私聊放最右
const privateTabHtml = `<button type="button" class="mr-rt-tl-tab private" data-tab-idx="${privateTabIdx}" title="${escapeHtml(headerLabel)} 的私聊历史">
  <span class="mr-rt-tl-tab-turn">💬 私聊</span>
</button>`;
const tabsHtmlWithPrivate = tabsHtml + privateTabHtml;
```

并扩展 renderTurnBody：

```js
const renderTurnOrPrivate = async (idx) => {
  if (idx === privateTabIdx) {
    // 私聊 Tab
    let list = [];
    try {
      list = await ipcRenderer.invoke('roundtable-private:list', { meetingId: meeting.id, kind });
    } catch {}
    if (!list || list.length === 0) return '<div class="mr-rt-tl-empty">尚无与该 AI 的私聊。</div>';
    return list.map(turn => `
      <div class="mr-rt-tl-private-item">
        <div class="mr-rt-tl-user">用户：${escapeHtml(turn.userInput || '')}</div>
        <div class="mr-rt-tl-private-ts">${new Date(turn.ts).toLocaleString()}</div>
      </div>
    `).join('');
  }
  return renderTurnBody(turnsWithAns[idx]);
};
```

Tab click handler 改为 async：

```js
overlay.querySelectorAll('.mr-rt-tl-tab').forEach(btn => {
  btn.addEventListener('click', async () => {
    overlay.querySelectorAll('.mr-rt-tl-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const idx = parseInt(btn.getAttribute('data-tab-idx') || '0', 10);
    if (contentEl) {
      contentEl.innerHTML = '<div class="mr-rt-tl-loading">加载中…</div>';
      contentEl.innerHTML = await renderTurnOrPrivate(idx);
      contentEl.scrollTop = 0;
    }
  });
});
```

- [ ] **Step 3: CSS 样式**

把以下加到 `renderer/meeting-room.css` 末尾：

```css
.mr-rt-private-badge {
  display: inline-block;
  background: rgba(183, 133, 245, 0.18);
  color: #d4b3ff;
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 700;
  margin-left: 6px;
  vertical-align: middle;
}
.mr-rt-tl-tab.private {
  border-left: 1px dashed var(--line, #2a3245);
  margin-left: 6px;
}
.mr-rt-tl-private-item {
  background: rgba(183, 133, 245, 0.06);
  border-left: 3px solid rgba(183, 133, 245, 0.6);
  padding: 8px 12px;
  margin: 6px 0;
  border-radius: 4px;
}
.mr-rt-tl-private-ts {
  color: var(--ink-2, #a0a8b9);
  font-size: 11px;
  margin-top: 4px;
}
.mr-rt-tl-loading { padding: 18px; color: var(--ink-2, #a0a8b9); }
```

- [ ] **Step 4: 手测**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9221 &
```

发 `@claude hi` 两次 → Claude 卡片右上 💬 2 角标 → 点 Claude 卡片打开抽屉 → 切到"私聊"Tab → 看到两条记录。

- [ ] **Step 5: commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): private-chat badge + drawer tab"
```

---

## Phase 4: 旧 UI 退役 + 三态切换按钮

### Task 4.1: 黑板仅 driverMode 渲染

**Files:**
- Modify: `renderer/meeting-blackboard.js`

- [ ] **Step 1: 在文件入口提前 return**

找到主渲染入口函数（通常是 export 的一个函数，比如 `renderBlackboard` 或类似），在函数顶部加：

```js
function renderBlackboard(meeting, ...rest) {
  // 通用圆桌/投研圆桌不渲染黑板
  if (!meeting || !meeting.driverMode) return;
  // ... 原逻辑保持
}
```

如果有多个入口，全部 guard。

- [ ] **Step 2: 启动 Hub 手测**

新建会议室 → 黑板不应出现。toggle driverMode → 黑板出现。

- [ ] **Step 3: commit**

```bash
git add renderer/meeting-blackboard.js
git commit -m "feat(renderer): blackboard renders only in driverMode"
```

---

### Task 4.2: Focus/Blackboard 布局切换按钮在 roundtable 下隐藏

**Files:**
- Modify: `renderer/meeting-room.js`（layout toolbar 渲染）

- [ ] **Step 1: grep 找 layout 切换按钮**

```bash
grep -n "layout.*focus\|layout.*blackboard\|layoutToggle\|布局" renderer/meeting-room.js
```

- [ ] **Step 2: 加渲染 guard**

在该按钮渲染入口处提前 return：

```js
if (meeting.researchMode || meeting.roundtableMode) {
  // 圆桌模式不需要 Focus/Blackboard 切换
  return;
}
```

- [ ] **Step 3: 三 xterm 终端默认隐藏（在 roundtable / research 下）**

grep 三 xterm 终端容器的渲染代码（通常 `terminalsEl()` 或类似），在容器渲染时根据 mode 加 class：

```js
const container = terminalsEl();
if (container) {
  if (meeting.researchMode || meeting.roundtableMode) {
    container.classList.add('mr-terminals-hidden');
  } else {
    container.classList.remove('mr-terminals-hidden');
  }
}
```

CSS 加：

```css
.mr-terminals-hidden { display: none; }
```

- [ ] **Step 4: 手测**

新建会议 → 终端不可见，仅卡片 UI。toggle driverMode → 终端出现。

- [ ] **Step 5: commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): hide layout toggle + xterm terminals in roundtable"
```

---

### Task 4.3: 三态切换按钮（圆桌 / 主驾 / 投研）

**Files:**
- Modify: `renderer/meeting-room.js`（toolbar 渲染）

- [ ] **Step 1: 在会议室顶部 toolbar 渲染处插入三态按钮组**

grep `.mr-toolbar` 或 `mr-mode-toggle` 等关键字找到 toolbar 入口。在合适位置插入：

```js
function _renderModeToggle(meeting) {
  const isRoundtable = !!meeting.roundtableMode;
  const isDriver = !!meeting.driverMode;
  const isResearch = !!meeting.researchMode;
  return `
    <div class="mr-mode-toggle" role="radiogroup" aria-label="会议模式">
      <button type="button" class="mr-mode-btn ${isRoundtable ? 'active' : ''}" data-mode="roundtable" title="通用圆桌：三家平等讨论">圆桌</button>
      <button type="button" class="mr-mode-btn ${isDriver ? 'active' : ''}" data-mode="driver" title="主驾模式：Claude 编码 + 副驾审查">主驾</button>
      <button type="button" class="mr-mode-btn ${isResearch ? 'active' : ''}" data-mode="research" title="投研圆桌：A 股专题">投研</button>
    </div>
  `;
}
```

绑定点击事件：

```js
function _bindModeToggle(root, meeting) {
  root.querySelectorAll('.mr-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.getAttribute('data-mode');
      try {
        if (mode === 'roundtable') {
          await ipcRenderer.invoke('toggle-roundtable-mode', { meetingId: meeting.id, enabled: true });
        } else if (mode === 'driver') {
          await ipcRenderer.invoke('toggle-driver-mode', { meetingId: meeting.id, enabled: true });
        } else if (mode === 'research') {
          await ipcRenderer.invoke('toggle-research-mode', { meetingId: meeting.id, enabled: true });
        }
      } catch (e) {
        console.warn('[mode-toggle] failed:', e.message);
      }
    });
  });
}
```

- [ ] **Step 2: CSS 样式**

`renderer/meeting-room.css`：

```css
.mr-mode-toggle {
  display: inline-flex;
  background: var(--panel-2, #232b3a);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.mr-mode-btn {
  background: transparent;
  border: none;
  color: var(--ink-2, #a0a8b9);
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
}
.mr-mode-btn.active {
  background: var(--accent, #5b8def);
  color: #fff;
}
.mr-mode-btn:hover:not(.active) {
  background: rgba(91, 141, 239, 0.1);
}
```

- [ ] **Step 3: 手测三态切换**

启动 Hub → 新建会议 → toolbar 顶部三态按钮，"圆桌"高亮 → 点"投研" → "投研"高亮 + 圆桌面板切到投研版（标题"投研圆桌"+ covenant 编辑入口）→ 点"主驾" → 主驾相关 UI 出现。

- [ ] **Step 4: commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): tri-state mode toggle (roundtable/driver/research)"
```

---

## Phase 5: 创建会议室入口默认值

### Task 5.1: renderer.js 新建会议默认 roundtableMode=true

**Files:**
- Modify: `renderer/renderer.js`（新建会议室按钮回调）

- [ ] **Step 1: grep 新建会议室入口**

```bash
grep -n "create-meeting\|createMeeting\|新建会议" renderer/renderer.js
```

- [ ] **Step 2: 调用后立即 toggle roundtableMode=true**

由于 `core/meeting-room.js::createMeeting` 已经设默认 `roundtableMode: true`（Task 1.4），renderer 不需要额外设置。但 toggle handler 的副作用（写 prompt 文件 + meeting-updated 广播）需要触发，所以：

在 createMeeting 成功后追加：

```js
const m = await ipcRenderer.invoke('create-meeting');
// 触发 prompt 文件写入和 UI 通知（即便 createMeeting 默认就开了 roundtable）
await ipcRenderer.invoke('toggle-roundtable-mode', { meetingId: m.id, enabled: true });
```

如果你的实际代码用 `ipcRenderer.send('create-meeting')` 而非 invoke，请改为 invoke 拿到 meeting 对象后再 toggle。

- [ ] **Step 3: 手测**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-test ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9221 &
```

新建会议 → 自动是圆桌（无需手动切）→ 卡片 UI 渲染 → arena-prompts 目录下应有 `<meetingId>-roundtable.md`。

- [ ] **Step 4: commit**

```bash
git add renderer/renderer.js
git commit -m "feat(renderer): new meeting auto-init roundtable prompt file"
```

---

## Phase 6: 多路审查（cli-caller skill）

### Task 6.1: 用 cli-caller 做四路交叉审查

**Files:**
- 待审查代码：分支 `feature/general-roundtable` 自上次 master 起所有 commits

- [ ] **Step 1: 准备 diff 摘要**

```bash
git -C C:/Users/lintian/AppData/Local/Temp/hub-roundtable diff master --stat
git -C C:/Users/lintian/AppData/Local/Temp/hub-roundtable log master..HEAD --oneline
```

- [ ] **Step 2: 调用 cli-caller skill 启动四路审查**

通过 `/cli-caller` skill：分别让 Gemini / Codex / DeepSeek / Qwen 审查同一份 diff。审查关注点：

1. **C1 投研零回归**: 三方独立检查 `core/research-mode.js`、`core/research-mcp-server.js`、`core/roundtable-orchestrator.js` 是否改动；renderer/meeting-room.js 中现有 researchMode 路径是否保持原行为
2. **互斥逻辑健壮性**: meeting-room.js 的三态互斥是否覆盖所有 enable/disable 路径
3. **私聊路径副作用**: rt-private 不应触发 roundtable-orchestrator 任何写盘操作
4. **CSS/UI 视觉一致性**: 三态切换是否覆盖所有可见状态（卡片/抽屉/标题/toolbar）
5. **错误处理**: IPC handler 异常路径（meetingId 无效、文件写失败等）是否合理降级

- [ ] **Step 3: 收集 P0/P1 issue 列表**

四路结果汇总成单一 issue list，按优先级排序。Critical 路径必须修。

- [ ] **Step 4: 修复并 commit**

每个 P0/P1 issue 独立 commit，带审查方引用。

```bash
git commit -m "fix: <issue desc> (review by Gemini/Codex)"
```

- [ ] **Step 5: 修完后 mark task #5 完成，update task #6 进入 in_progress**

---

## Phase 7: E2E 验证

### Task 7.1: E2E 投研零回归测试

**Files:**
- Create: `tests/_e2e-research-zero-regression.js`

- [ ] **Step 1: 写 E2E 脚本**

参照已有的 `tests/_e2e-roundtable-immediate-feedback.js` 范式（Playwright + CDP 9221 端口）：

```js
'use strict';
// E2E 投研零回归：在 feature/general-roundtable 分支上验证投研圆桌功能未受影响
// 启动隔离 Hub 实例 → toggle research → fanout/debate/summary 三轮
// 对比 prompt 文件内容、turns 文件结构、UI 渲染元素与 master 分支完全一致

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HUB_DIR = process.cwd();
const DATA_DIR = process.env.E2E_DATA_DIR || 'C:/temp/hub-research-zero';
const CDP_PORT = 9223;

async function startHub() {
  // 清理上次状态
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const electronExe = path.join(HUB_DIR, 'node_modules/electron/dist/electron.exe');
  const proc = spawn(electronExe, [HUB_DIR, `--remote-debugging-port=${CDP_PORT}`], {
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
    stdio: 'pipe',
  });
  // 等待 hook server 启动（通过 stdout 检测）
  await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('hub start timeout')), 30000);
    proc.stdout.on('data', d => {
      buf += d.toString();
      if (buf.includes('hook server listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', d => process.stderr.write(d));
  });
  return proc;
}

async function run() {
  const hub = await startHub();
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.waitForLoadState('domcontentloaded');

    // 1. 新建会议
    await page.click('[data-action="create-meeting"]');
    await page.waitForSelector('.mr-roundtable-panel, #mr-roundtable-panel', { timeout: 5000 });

    // 2. 切到投研模式
    await page.click('.mr-mode-btn[data-mode="research"]');
    await page.waitForFunction(() => {
      const t = document.querySelector('.mr-rt-title');
      return t && t.textContent && t.textContent.includes('投研');
    }, { timeout: 5000 });

    // 3. 验证 arena-prompts/*-research.md 写出
    const promptDir = path.join(DATA_DIR, 'arena-prompts');
    const researchFiles = fs.readdirSync(promptDir).filter(f => f.endsWith('-research.md'));
    if (researchFiles.length === 0) throw new Error('no research.md generated');
    const content = fs.readFileSync(path.join(promptDir, researchFiles[0]), 'utf-8');
    if (!content.includes('LinDangAgent')) throw new Error('research.md missing 投研 specifics — regression!');
    if (!content.includes('A 股投研')) throw new Error('research.md missing covenant');

    // 4. fanout 一轮（手 attach 三家 CLI 跳过；这里仅验证 UI 路径）
    // ... 略 ...

    console.log('✅ E2E research zero regression: PASSED');
  } finally {
    hub.kill();
  }
}

run().catch(e => {
  console.error('❌ E2E failed:', e);
  process.exit(1);
});
```

- [ ] **Step 2: 跑 E2E**

```bash
node tests/_e2e-research-zero-regression.js
```

Expected: `✅ E2E research zero regression: PASSED`

- [ ] **Step 3: 截图存证**

E2E 期间截图保存到 `tests/screenshots/research-zero-regression-*.png`，并在终端输出绝对路径供用户检查。

- [ ] **Step 4: commit**

```bash
git add tests/_e2e-research-zero-regression.js
git commit -m "test(e2e): research roundtable zero regression"
```

---

### Task 7.2: E2E 通用圆桌完整流程

**Files:**
- Create: `tests/_e2e-general-roundtable.js`

- [ ] **Step 1: 写 E2E 脚本**

```js
'use strict';
// E2E 通用圆桌：默认渲染 + fanout + debate + summary + @<who> 私聊
// 启动隔离 Hub → 新建会议 → 验证默认 roundtableMode → 走完五种触发路径

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HUB_DIR = process.cwd();
const DATA_DIR = process.env.E2E_DATA_DIR || 'C:/temp/hub-roundtable-e2e';
const CDP_PORT = 9224;

// startHub 实现同 Task 7.1（DRY 后续可抽公共 helper）
async function startHub() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const electronExe = path.join(HUB_DIR, 'node_modules/electron/dist/electron.exe');
  const proc = spawn(electronExe, [HUB_DIR, `--remote-debugging-port=${CDP_PORT}`], {
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('hub start timeout')), 30000);
    proc.stdout.on('data', d => {
      buf += d.toString();
      if (buf.includes('hook server listening')) { clearTimeout(timer); resolve(); }
    });
    proc.stderr.on('data', d => process.stderr.write(d));
  });
  return proc;
}

async function run() {
  const hub = await startHub();
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.waitForLoadState('domcontentloaded');

    // 1. 新建会议
    await page.click('[data-action="create-meeting"]');
    await page.waitForSelector('#mr-roundtable-panel', { timeout: 5000 });

    // 2. 验证默认是圆桌（标题"圆桌讨论"，三态按钮"圆桌"高亮）
    const titleText = await page.$eval('.mr-rt-title', el => el.textContent.trim());
    if (titleText !== '圆桌讨论') throw new Error(`title expected 圆桌讨论, got ${titleText}`);
    const activeMode = await page.$eval('.mr-mode-btn.active', el => el.getAttribute('data-mode'));
    if (activeMode !== 'roundtable') throw new Error(`active mode expected roundtable, got ${activeMode}`);

    // 3. 验证 prompt 文件已写
    const promptDir = path.join(DATA_DIR, 'arena-prompts');
    const rtFiles = fs.readdirSync(promptDir).filter(f => f.endsWith('-roundtable.md'));
    if (rtFiles.length !== 1) throw new Error(`expected 1 roundtable.md, got ${rtFiles.length}`);
    const promptContent = fs.readFileSync(path.join(promptDir, rtFiles[0]), 'utf-8');
    if (!promptContent.includes('@<你> 私聊')) throw new Error('prompt missing @<who> private syntax');
    if (promptContent.includes('LinDangAgent')) throw new Error('prompt should NOT include 投研 specifics');

    // 4. parseDriverCommand 验证（在浏览器上下文）
    const parseResult = await page.evaluate(() => {
      const m = { roundtableMode: true };
      // 由于 parseDriverCommand 在 IIFE 内不可访问，只能 via send-input 或暴露 hook
      // 简单验证：发输入到 mr-input-box 然后看是否触发对应 IPC
      const box = document.getElementById('mr-input-box');
      if (!box) return { error: 'no input box' };
      return { ok: true };
    });
    if (parseResult.error) throw new Error(parseResult.error);

    // 5. UI 元素检查：三张卡片
    const cardCount = await page.$$eval('.mr-rt-card', els => els.length);
    if (cardCount !== 3) throw new Error(`expected 3 cards, got ${cardCount}`);

    // 6. 验证 黑板/Focus 切换按钮 NOT visible
    const blackboardVisible = await page.$('.mr-blackboard');
    if (blackboardVisible) {
      const isVisible = await blackboardVisible.isVisible();
      if (isVisible) throw new Error('blackboard should be hidden in roundtable');
    }

    // 7. 切到主驾 → 黑板可见
    await page.click('.mr-mode-btn[data-mode="driver"]');
    await page.waitForTimeout(500);
    const driverActive = await page.$eval('.mr-mode-btn.active', el => el.getAttribute('data-mode'));
    if (driverActive !== 'driver') throw new Error('toggle to driver failed');

    // 8. 切回圆桌
    await page.click('.mr-mode-btn[data-mode="roundtable"]');
    await page.waitForTimeout(500);

    // 9. 截图存证
    const shotDir = path.join(HUB_DIR, 'tests/screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shotPath = path.join(shotDir, `general-roundtable-default-${Date.now()}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    console.log(`Screenshot: ${shotPath}`);

    console.log('✅ E2E general roundtable: PASSED');
  } finally {
    hub.kill();
  }
}

run().catch(e => {
  console.error('❌ E2E failed:', e);
  process.exit(1);
});
```

- [ ] **Step 2: 跑 E2E**

```bash
node tests/_e2e-general-roundtable.js
```

Expected: `✅ E2E general roundtable: PASSED` + 截图绝对路径输出。

- [ ] **Step 3: commit**

```bash
git add tests/_e2e-general-roundtable.js
git commit -m "test(e2e): general roundtable default + UI + mode toggle"
```

---

### Task 7.3: 真实 CLI 三家 fanout 验证（手测引导）

**Files:**
- 测试脚本: 复用 `tests/_e2e-general-roundtable.js`
- 操作记录: `tests/manual-roundtable-cli-test.md`

由于真实 CLI 启动需要用户授权（Claude/Gemini/Codex 的 OAuth），这一步**手动执行**：

- [ ] **Step 1: 启动隔离 Hub**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-cli ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9225 &
```

- [ ] **Step 2: UI 操作清单**

1. 新建会议 → 三态按钮"圆桌"高亮
2. attach 三家 CLI（Claude/Gemini/Codex）到会议室
3. 输入"今天 A 股大盘怎么看？"（普通文本）
4. 验证三家卡片状态从 `待命` → `思考中` → `已答`
5. 点击 Claude 卡片 → 抽屉打开，"轮次回答" Tab 显示第 1 轮
6. 输入 `@debate` → 三家收到上一轮观点 → 卡片更新第 2 轮
7. 输入 `@summary @claude` → Claude 卡片显示综合答案
8. 输入 `@gemini 你刚才说的XX是怎么回事？` → 仅 Gemini 收到 → Gemini 卡片右上 💬 1
9. 点 Gemini 卡片 → "私聊" Tab → 看到这条
10. 验证 `<arena-prompts>/<id>-turn-3.json` 存在（summary）但没有 turn-4（私聊不入轮次）
11. 验证 `<arena-prompts>/<id>-roundtable-private.json` 存在，gemini 数组有 1 条

- [ ] **Step 3: 截图存证**

每步截图保存到 `tests/screenshots/manual-cli-test-step-N.png`，输出绝对路径。

- [ ] **Step 4: 写 manual-roundtable-cli-test.md**

按 Step 2 清单 + 截图路径整理成 markdown，记录每步实际行为是否与预期一致。

- [ ] **Step 5: commit**

```bash
git add tests/manual-roundtable-cli-test.md tests/screenshots/manual-cli-test-*.png
git commit -m "test(manual): real CLI roundtable end-to-end with screenshots"
```

---

### Task 7.4: 投研圆桌 + 通用圆桌 + 主驾三模式互切回归

- [ ] **Step 1: 在同一会议室连续三态切换**

启动 Hub → 新建会议 → 圆桌 → 投研 → 主驾 → 圆桌（循环）

每次切换：
- 验证 toolbar 高亮按钮正确
- 验证 prompt 文件：圆桌时 `<id>-roundtable.md` 存在；投研时 `<id>-research.md` 存在；主驾时 `.arena/state.md` 创建
- 验证 UI：圆桌时卡片可见、终端隐藏、黑板隐藏；主驾时终端可见、黑板可见
- 验证 `meeting.json` 中三个 mode 字段两两不同时为 true

- [ ] **Step 2: 截图每个状态存证**

输出三张截图绝对路径。

- [ ] **Step 3: 创建测试报告**

`tests/manual-mode-switch-regression.md` 记录每步预期/实际 + 截图路径。

- [ ] **Step 4: commit**

```bash
git add tests/manual-mode-switch-regression.md tests/screenshots/mode-switch-*.png
git commit -m "test(manual): tri-state mode switch regression"
```

---

## Phase 8: 收尾

### Task 8.1: 更新项目文档

**Files:**
- Modify: `README.md` 或 `docs/CLAUDE.md`（如 Hub 项目有）

- [ ] **Step 1: 简要写入"通用圆桌模式"段落**

如果 README/CLAUDE.md 有"会议室模式"章节，加一段：

```markdown
### 通用圆桌（roundtableMode，默认）
- 三家 AI 平等讨论任意话题
- 触发语法：默认 fanout / @debate / @summary @<who> / @<who> 单家私聊
- 入口：新建会议室即默认
- 详见 docs/superpowers/specs/2026-04-28-free-roundtable-mode-design.md
```

- [ ] **Step 2: commit**

```bash
git add README.md docs/CLAUDE.md
git commit -m "docs: document general-roundtable mode"
```

---

### Task 8.2: 合并到 master

**前置条件**：所有 E2E 通过 + 多路审查 P0/P1 全修。

- [ ] **Step 1: 在主目录跑最终验证**

切回主目录（不在 worktree）确认 master 干净后：
```bash
git -C C:/Users/lintian/claude-session-hub checkout master
git -C C:/Users/lintian/claude-session-hub merge --no-ff feature/general-roundtable
```

- [ ] **Step 2: 主目录 smoke test**

```bash
CLAUDE_HUB_DATA_DIR=C:/temp/hub-roundtable-final-smoke timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

- [ ] **Step 3: 清理 worktree**

```bash
git -C C:/Users/lintian/claude-session-hub worktree remove C:/Users/lintian/AppData/Local/Temp/hub-roundtable
```

- [ ] **Step 4: 确认推送（待用户授权）**

⚠ 不主动 push。等用户确认。

---

## Self-Review

### 1. Spec coverage 检查

| Spec 要求 | 实现 Task |
|---|---|
| 新增 `roundtableMode` 字段 | Task 1.4 |
| 新增 `generalRoundtableCovenant` 字段 | Task 1.4 |
| 三态互斥 | Task 1.4 (updateMeeting 互斥逻辑) |
| 通用 RULES_TEMPLATE | Task 1.1 |
| 默认 covenant 留白 | Task 1.1 (DEFAULT_COVENANT='') |
| `<id>-roundtable.md` 文件命名 | Task 1.1 (writeGeneralRoundtablePromptFile) |
| 私聊存储独立文件 | Task 1.2 (general-roundtable-private-store) |
| `@<who>` 私聊解析 | Task 3.1 (parseDriverCommand rt-private) |
| 私聊不入 turn-N.json | Task 3.2 (handleMeetingSend rt-private 不调 triggerRoundtable) |
| `@all` 群发语法糖 | Task 3.1 |
| 默认 roundtableMode=true | Task 1.4 + Task 5.1 |
| UI 卡片渲染条件扩展 | Task 3.3 |
| 标题动态化 | Task 3.3 |
| 私聊 💬 角标 | Task 3.4 |
| 抽屉私聊 Tab | Task 3.4 |
| 黑板仅 driverMode | Task 4.1 |
| 三 xterm 在 roundtable 默认隐藏 | Task 4.2 |
| 三态切换按钮 | Task 4.3 |
| 投研零回归 E2E | Task 7.1 |
| 通用圆桌 E2E | Task 7.2 |
| 真实 CLI 验证 | Task 7.3 |
| 三态互切回归 | Task 7.4 |

### 2. Placeholder 扫描

- 无 "TODO/TBD/implement later"
- 无 "Add appropriate error handling"
- 无 "Similar to Task N"（每个 Task 都展开了）
- E2E 脚本里有 `// ... 略 ...`（attach CLI 部分），但已在 Task 7.3 manual flow 覆盖。已注明
- `Task 4.1` 找黑板入口需要 grep 确认 — 已说明 grep 命令

### 3. Type/方法名一致性

- `roundtableMode` / `generalRoundtableCovenant` 在所有 Task 中名称一致
- IPC handler: `toggle-roundtable-mode` / `roundtable-private:append` / `roundtable-private:list` 三处一致
- 函数: `writeGeneralRoundtablePromptFile` / `cleanupGeneralRoundtableFiles` / `appendPrivateTurn` 三处一致
- CSS class: `mr-mode-toggle` / `mr-mode-btn` / `mr-rt-private-badge` / `mr-rt-tl-tab.private` 一致

---

## 执行交接

Plan complete and saved to `C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-04-29-general-roundtable-mode.md`.

两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 Task 派独立 subagent 实施 + 两阶段审查 + 任务间 review

**2. Inline 执行** — 当前会话执行 + 关键节点 checkpoint

哪种？
