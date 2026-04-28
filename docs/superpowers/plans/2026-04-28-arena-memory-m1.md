# Arena Memory M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Hub 主驾模式加一层"会议室级共识快照"——`<projectCwd>/.arena/memory/shared/facts.md` + `episodes.jsonl`，由 MCP 工具 `arena_remember`（主驾）+ 副驾审查标记 `[fact]/[lesson]/[decision]`（解析剪贴）双通道写入，启动会议时自动注入回三家 prompt 文件。

**Architecture:** 极简单层——只造会议室共识层（项目级，跟 `<projectCwd>/.arena/` 走），不造个人记忆（CLI 自带 memory 已覆盖）。所有写盘动作由 Hub main.js 进程执行，副驾权限完全不变（依然只读，标记是文本输出）。

**Tech Stack:** Node 18+ 内置（`fs/path/crypto/http`），无新 npm 依赖；测试用 node + assert（仿 `tests/meeting-store.test.js` IIFE async runner 风格）。

**关键约束（铁律）：**
- 不引入新 npm 依赖（Hub `CLAUDE.md`）
- 副驾权限不变：`COPILOT_PROMPT_GEMINI/CODEX` 现有"不得修改任何文件 / 不得执行写命令"约束保留
- smoke test 必过：`timeout 6 ./node_modules/electron/dist/electron.exe . | head -20` 必看到 `[hub] hook server listening`
- 测试用 `CLAUDE_HUB_DATA_DIR` 隔离

**关键现有锚点（必读）：**
- `core/driver-mode.js:174-189` — `writeDriverPromptFile`/`writeCopilotPromptFile`
- `core/driver-mode.js:90-117` — `COPILOT_PROMPT_GEMINI`
- `core/driver-mode.js:122-149` — `COPILOT_PROMPT_CODEX`
- `core/driver-mcp-server.js:40-77` — TOOLS 数组
- `core/driver-mcp-server.js:80-100` — `postReview()` HTTP 模板
- `main.js:534-535` — `projectCwd = claudeSession.cwd`
- `main.js:627-637` — `executeReview` 写 reviews md 之处（marker 解析在这里插）

---

## File Structure

| 路径 | 责任 | Task |
|---|---|---|
| `core/arena-memory/store.js` | 单一存储模块：`appendFact` / `persistMarkers` / `appendEpisode` / `getMemoryDir` | T1, T2 |
| `core/arena-memory/marker-parser.js` | 纯函数：副驾文本 → `Marker[]`（正则匹配 `[fact]/[lesson]/[decision]`） | T3 |
| `core/arena-memory/injector.js` | `composeMemoryBlock` 读 facts.md → md 字符串；`appendMemoryToPromptFile` 用 sentinel 区块幂等写入 | T4 |
| `tests/arena-memory.test.js` | 全部单测（IIFE async runner 风格） | T1-T4 各加 |
| `core/driver-mcp-server.js` | TOOLS 数组追加 `arena_remember` + dispatch + `postRemember()` | T5 |
| `main.js` | hookServer `/api/driver/remember` handler；`add-meeting-sub`/`resume` 调注入器；`executeReview` 解析标记 | T6, T7, T8 |
| `core/driver-mode.js` | 扩展 `COPILOT_PROMPT_GEMINI/CODEX` MEMORY PROTOCOL 段；`DRIVER_RULES_TEMPLATE` 加 arena_remember 用法 | T9 |

---

### Task 1: store.js 基础——`getMemoryDir` + `appendEpisode`

**Files:**
- Create: `core/arena-memory/store.js`
- Test: `tests/arena-memory.test.js`

- [ ] **Step 1: 写失败测试 T1.1（`getMemoryDir` 解析）**

将以下内容写入 `tests/arena-memory.test.js`（首次创建）：

```js
// tests/arena-memory.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mem-'));

const store = require('../core/arena-memory/store');

(async () => {
  // T1.1: getMemoryDir returns <projectCwd>/.arena/memory
  const dir = store.getMemoryDir(TEMP_PROJECT);
  assert.strictEqual(dir, path.join(TEMP_PROJECT, '.arena', 'memory'));
  console.log('PASS T1.1 getMemoryDir resolves');

  console.log('---all tests passed---');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/arena-memory.test.js`
Expected: `Error: Cannot find module '../core/arena-memory/store'`

- [ ] **Step 3: 创建 store.js 最小实现**

写入 `core/arena-memory/store.js`：

```js
// core/arena-memory/store.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getMemoryDir(projectCwd) {
  return path.join(projectCwd, '.arena', 'memory');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = { getMemoryDir, ensureDir };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T1.1 getMemoryDir resolves` 和 `---all tests passed---`

- [ ] **Step 5: 加 T1.2（`appendEpisode` 写 jsonl）**

在 `tests/arena-memory.test.js` 的 `console.log('---all tests passed---');` 之前插入：

```js
  // T1.2: appendEpisode writes jsonl line
  await store.appendEpisode(TEMP_PROJECT, { type: 'remember', kind: 'fact', content: 'hello', source: 'manual' });
  const epPath = path.join(store.getMemoryDir(TEMP_PROJECT), 'episodes.jsonl');
  const lines = fs.readFileSync(epPath, 'utf-8').trim().split('\n');
  assert.strictEqual(lines.length, 1, 'one episode line');
  const ev = JSON.parse(lines[0]);
  assert.strictEqual(ev.v, 1, 'schema_version=1');
  assert.strictEqual(ev.type, 'remember');
  assert.strictEqual(ev.kind, 'fact');
  assert.strictEqual(ev.content, 'hello');
  assert.ok(typeof ev.ts === 'number' && ev.ts > 0, 'ts is unix ms');
  console.log('PASS T1.2 appendEpisode writes jsonl');
```

- [ ] **Step 6: 跑测试确认失败**

Run: `node tests/arena-memory.test.js`
Expected: `TypeError: store.appendEpisode is not a function`

- [ ] **Step 7: 实现 `appendEpisode`**

修改 `core/arena-memory/store.js`，追加：

```js
async function appendEpisode(projectCwd, event) {
  const dir = getMemoryDir(projectCwd);
  ensureDir(dir);
  const filePath = path.join(dir, 'episodes.jsonl');
  const line = JSON.stringify({ v: 1, ts: Date.now(), ...event }) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');
}

module.exports = { getMemoryDir, ensureDir, appendEpisode };
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T1.2 appendEpisode writes jsonl`

- [ ] **Step 9: Commit**

```bash
git add core/arena-memory/store.js tests/arena-memory.test.js
git commit -m "feat(arena-memory): add store.appendEpisode for jsonl event log"
```

---

### Task 2: store.js — `appendFact`（带 What 去重）

**Files:**
- Modify: `core/arena-memory/store.js`
- Modify: `tests/arena-memory.test.js`

- [ ] **Step 1: 加 T2.1（首次 appendFact 写新文件 + 三段式格式）**

在 `tests/arena-memory.test.js` 的 `console.log('---all tests passed---');` 之前插入：

```js
  // T2.1: appendFact creates shared/facts.md with What/Why/Status structure
  await store.appendFact(TEMP_PROJECT, {
    what: 'hookPort 默认 3456',
    why: 'MCP server 通过 ARENA_HUB_PORT 拿到端口',
    status: 'stable',
    source: 'manual',
  });
  const factsPath = path.join(store.getMemoryDir(TEMP_PROJECT), 'shared', 'facts.md');
  const content = fs.readFileSync(factsPath, 'utf-8');
  assert.ok(content.includes('## hookPort 默认 3456'), 'has What heading');
  assert.ok(content.includes('**What**: hookPort 默认 3456'), 'has What field');
  assert.ok(content.includes('**Why**: MCP server'), 'has Why field');
  assert.ok(content.includes('**Status**: stable'), 'has Status field');
  console.log('PASS T2.1 appendFact creates facts.md with three-section format');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/arena-memory.test.js`
Expected: `TypeError: store.appendFact is not a function`

- [ ] **Step 3: 实现 `appendFact`（首次创建 + 追加）**

修改 `core/arena-memory/store.js`，追加：

```js
function factEntry({ what, why, status, source }) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `## ${what}`,
    `**What**: ${what}`,
    `**Why**: ${why}`,
    `**Status**: ${status}`,
    `**Source**: ${source} / ${today}`,
    '',
  ].join('\n');
}

const FACTS_HEADER = `# Project Facts (.arena/memory/shared/facts.md)
> 由 Hub 主驾模式自动管理。What/Why/Status 三段式。Hub 内部代写，AI 不直接写。

`;

async function appendFact(projectCwd, { what, why, status, source }) {
  if (!what || !why || !status) throw new Error('appendFact requires what/why/status');
  const sharedDir = path.join(getMemoryDir(projectCwd), 'shared');
  ensureDir(sharedDir);
  const filePath = path.join(sharedDir, 'facts.md');
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : FACTS_HEADER;
  // 去重：以 "## <what>" 行为唯一键，存在则跳过
  const heading = `## ${what}`;
  if (content.split('\n').some((line) => line.trim() === heading)) {
    return { added: false, reason: 'duplicate' };
  }
  if (!content.endsWith('\n\n')) content += content.endsWith('\n') ? '\n' : '\n\n';
  content += factEntry({ what, why, status, source: source || 'manual' });
  content += '\n---\n\n';
  fs.writeFileSync(filePath + '.tmp', content, 'utf-8');
  fs.renameSync(filePath + '.tmp', filePath);
  return { added: true };
}

module.exports = { getMemoryDir, ensureDir, appendEpisode, appendFact };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T2.1 appendFact creates facts.md with three-section format`

- [ ] **Step 5: 加 T2.2（按 What 去重）**

在 T2.1 之后插入：

```js
  // T2.2: appendFact dedupes by What heading
  const r1 = await store.appendFact(TEMP_PROJECT, {
    what: 'hookPort 默认 3456',
    why: '不一样的 why',
    status: 'stable',
    source: 'manual',
  });
  assert.strictEqual(r1.added, false, 'duplicate skipped');
  const after = fs.readFileSync(factsPath, 'utf-8');
  const occurrences = (after.match(/## hookPort 默认 3456/g) || []).length;
  assert.strictEqual(occurrences, 1, 'only one entry');
  console.log('PASS T2.2 appendFact dedupes by What');
```

- [ ] **Step 6: 跑测试确认通过（已在 Step 3 实现去重逻辑）**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T2.2 appendFact dedupes by What`

- [ ] **Step 7: 加 T2.3（连续 append 多条不同 fact）**

```js
  // T2.3: appending different facts accumulates correctly
  await store.appendFact(TEMP_PROJECT, {
    what: '.arena/ 是项目级目录',
    why: 'Hub 重装、worktree、跨机同步都不丢',
    status: 'stable',
    source: 'design-decision',
  });
  const all = fs.readFileSync(factsPath, 'utf-8');
  assert.ok(all.includes('## hookPort 默认 3456'), 'old entry kept');
  assert.ok(all.includes('## .arena/ 是项目级目录'), 'new entry added');
  console.log('PASS T2.3 multiple distinct facts accumulate');
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T2.3 multiple distinct facts accumulate`

- [ ] **Step 9: Commit**

```bash
git add core/arena-memory/store.js tests/arena-memory.test.js
git commit -m "feat(arena-memory): add store.appendFact with What-line dedup"
```

---

### Task 3: marker-parser.js

**Files:**
- Create: `core/arena-memory/marker-parser.js`
- Modify: `tests/arena-memory.test.js`

- [ ] **Step 1: 加 T3.1（基础三种标记解析）**

在 `tests/arena-memory.test.js` 顶部 `const store = ...` 之后追加：

```js
const parser = require('../core/arena-memory/marker-parser');
```

在 T2.3 之后插入：

```js
  // T3.1: parseMarkers extracts [lesson]/[fact]/[decision] from copilot text
  const sample1 = `OK: 方案合理，但有几个隐患。

[lesson] PTY 输入空格触发 readline 回显，下次走 sendKeys
[fact] hookPort 默认 3456，碰撞向后 fallback
[decision]: 选 react-window，因为 immer 包大小翻倍 #frontend
`;
  const m1 = parser.parseMarkers(sample1, 'gemini');
  assert.strictEqual(m1.length, 3, 'three markers');
  assert.deepStrictEqual(m1.map((x) => x.kind), ['lesson', 'fact', 'decision']);
  assert.strictEqual(m1[0].who, 'gemini');
  assert.ok(m1[0].content.startsWith('PTY 输入空格'), 'lesson content trimmed');
  assert.ok(m1[2].tags.includes('frontend'), 'decision tag extracted');
  console.log('PASS T3.1 parseMarkers extracts three kinds');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/arena-memory.test.js`
Expected: `Cannot find module '../core/arena-memory/marker-parser'`

- [ ] **Step 3: 实现 `marker-parser.js`**

写入 `core/arena-memory/marker-parser.js`：

```js
// core/arena-memory/marker-parser.js
'use strict';

const MARKER_RE = /^\s*\[(lesson|decision|fact)\]\s*[:：\-]?\s*(.+?)(?=\n\s*\[(?:lesson|decision|fact)\]|\n\n|\Z)/gms;
const TAG_RE = /#([a-zA-Z][\w-]{1,30})/g;

function parseMarkers(text, copilotKind) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const markers = [];
  // split by lines so we can compute line numbers
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*\[(lesson|decision|fact)\]\s*[:：\-]?\s*(.+)$/);
    if (!m) continue;
    let content = m[2].trim();
    const tags = [];
    let tagMatch;
    const tagRe = /#([a-zA-Z][\w-]{1,30})/g;
    while ((tagMatch = tagRe.exec(content)) !== null) tags.push(tagMatch[1]);
    content = content.replace(tagRe, '').trim();
    markers.push({
      kind: m[1],
      who: copilotKind,
      content,
      tags,
      line: i,
    });
  }
  return markers;
}

module.exports = { parseMarkers };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T3.1 parseMarkers extracts three kinds`

- [ ] **Step 5: 加 T3.2（边界——空文本/无标记/中文冒号/markdown 噪声）**

```js
  // T3.2: edge cases
  assert.deepStrictEqual(parser.parseMarkers('', 'gemini'), []);
  assert.deepStrictEqual(parser.parseMarkers('OK: no markers here', 'codex'), []);

  // 中文冒号
  const sample2 = '[fact]：使用了中文冒号';
  const m2 = parser.parseMarkers(sample2, 'gemini');
  assert.strictEqual(m2.length, 1);
  assert.strictEqual(m2[0].content, '使用了中文冒号');

  // 不应误抓 markdown 内容（[lesson] 不在行首）
  const sample3 = 'See section [lesson] for details';
  assert.deepStrictEqual(parser.parseMarkers(sample3, 'codex'), []);

  console.log('PASS T3.2 parseMarkers handles edge cases');
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T3.2 parseMarkers handles edge cases`

- [ ] **Step 7: 加 T3.3（## 记忆 段内连续多条）**

```js
  // T3.3: ## 记忆 section with multiple markers
  const sample4 = `FLAG: 几处隐患。

详细分析：xxxxx

## 记忆
[lesson] PTY 写法注意
[fact] 端口 3456
[decision] 选 A 方案
`;
  const m4 = parser.parseMarkers(sample4, 'gemini');
  assert.strictEqual(m4.length, 3, 'three markers in 记忆 section');
  console.log('PASS T3.3 parseMarkers handles ## 记忆 section');
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T3.3 parseMarkers handles ## 记忆 section`

- [ ] **Step 9: Commit**

```bash
git add core/arena-memory/marker-parser.js tests/arena-memory.test.js
git commit -m "feat(arena-memory): add marker-parser for [lesson]/[fact]/[decision] tags"
```

---

### Task 4: store.persistMarkers + injector.js

**Files:**
- Modify: `core/arena-memory/store.js`
- Create: `core/arena-memory/injector.js`
- Modify: `tests/arena-memory.test.js`

- [ ] **Step 1: 加 T4.1（`persistMarkers` 把 fact 写进 facts.md，lesson/decision 进 episodes.jsonl）**

在 tests/arena-memory.test.js 之前合适位置（T3.3 后）插入：

```js
  // T4.1: persistMarkers routes fact→facts.md, lesson/decision→episodes.jsonl
  const fakeMarkers = [
    { kind: 'fact', who: 'gemini', content: 'review-only port: 3470', tags: [], line: 0 },
    { kind: 'lesson', who: 'gemini', content: 'check WAL before quit', tags: [], line: 1 },
    { kind: 'decision', who: 'gemini', content: '本会决议: 修 BUG-A', tags: [], line: 2 },
  ];
  const result = await store.persistMarkers(TEMP_PROJECT, fakeMarkers, { source: 'marker:test-review-1' });
  assert.strictEqual(result.factsAdded, 1, 'one fact written');
  assert.strictEqual(result.episodesAdded, 2, 'two non-fact markers in episodes');
  // 验证 fact 进了 facts.md
  const factsAfter = fs.readFileSync(path.join(store.getMemoryDir(TEMP_PROJECT), 'shared', 'facts.md'), 'utf-8');
  assert.ok(factsAfter.includes('## review-only port: 3470'));
  // 验证 lesson/decision 进了 episodes.jsonl
  const epAfter = fs.readFileSync(path.join(store.getMemoryDir(TEMP_PROJECT), 'episodes.jsonl'), 'utf-8');
  const epLines = epAfter.trim().split('\n').map(JSON.parse);
  const markerEvents = epLines.filter((e) => e.type === 'marker');
  assert.strictEqual(markerEvents.length, 2, 'two marker events');
  assert.ok(markerEvents.some((e) => e.kind === 'lesson'));
  assert.ok(markerEvents.some((e) => e.kind === 'decision'));
  console.log('PASS T4.1 persistMarkers routes correctly');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/arena-memory.test.js`
Expected: `TypeError: store.persistMarkers is not a function`

- [ ] **Step 3: 实现 `persistMarkers`**

修改 `core/arena-memory/store.js`，追加：

```js
async function persistMarkers(projectCwd, markers, opts) {
  const source = (opts && opts.source) || 'unknown';
  let factsAdded = 0;
  let episodesAdded = 0;
  for (const m of markers) {
    if (m.kind === 'fact') {
      const r = await appendFact(projectCwd, {
        what: m.content,
        why: `(${m.who} 在审查中提及; tags=${(m.tags || []).join(',') || 'none'})`,
        status: 'observed',
        source,
      });
      if (r.added) factsAdded++;
    } else {
      // lesson/decision 不入 facts.md，只记 episodes（让 CLI 自带 memory 来管个人成长）
      await appendEpisode(projectCwd, {
        type: 'marker',
        kind: m.kind,
        who: m.who,
        content: m.content,
        tags: m.tags || [],
        source,
      });
      episodesAdded++;
    }
  }
  return { factsAdded, episodesAdded };
}

module.exports = { getMemoryDir, ensureDir, appendEpisode, appendFact, persistMarkers };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T4.1 persistMarkers routes correctly`

- [ ] **Step 5: 加 T4.2（`injector.composeMemoryBlock` 空目录返回空字符串）**

在 tests 顶部加 require：

```js
const injector = require('../core/arena-memory/injector');
```

在 T4.1 之后插入：

```js
  // T4.2: injector.composeMemoryBlock returns '' for empty memory dir
  const EMPTY_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mem-empty-'));
  const blockEmpty = await injector.composeMemoryBlock({ projectCwd: EMPTY_PROJECT });
  assert.strictEqual(blockEmpty, '', 'empty when no facts.md');
  console.log('PASS T4.2 composeMemoryBlock returns empty string for empty dir');
```

- [ ] **Step 6: 跑测试确认失败**

Run: `node tests/arena-memory.test.js`
Expected: `Cannot find module '../core/arena-memory/injector'`

- [ ] **Step 7: 实现 `injector.composeMemoryBlock`**

写入 `core/arena-memory/injector.js`：

```js
// core/arena-memory/injector.js
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SENTINEL_BEGIN = '<!-- ARENA_MEMORY_BEGIN -->';
const SENTINEL_END = '<!-- ARENA_MEMORY_END -->';

async function composeMemoryBlock({ projectCwd, budgetTokens = 1500 }) {
  const factsPath = path.join(store.getMemoryDir(projectCwd), 'shared', 'facts.md');
  if (!fs.existsSync(factsPath)) return '';
  const content = fs.readFileSync(factsPath, 'utf-8').trim();
  if (!content) return '';
  // 简单 token 预算：1 token ≈ 0.5 中文字 / 0.75 英文字。1500 tok ≈ 6000 chars 上限
  const charBudget = budgetTokens * 4;
  const truncated = content.length > charBudget ? content.slice(0, charBudget) + '\n\n_[truncated due to budget]_' : content;
  return [
    '## 你已知的项目背景（来自 .arena/memory/shared/facts.md）',
    '',
    '> 这是本主驾会议室的共识快照，由 Hub 自动管理。',
    '',
    truncated,
  ].join('\n');
}

function appendMemoryToPromptFile(promptFilePath, memoryBlock) {
  if (!fs.existsSync(promptFilePath)) {
    throw new Error(`prompt file does not exist: ${promptFilePath}`);
  }
  let prompt = fs.readFileSync(promptFilePath, 'utf-8');
  // 幂等：先剥离旧的 sentinel 区块
  const beginIdx = prompt.indexOf(SENTINEL_BEGIN);
  const endIdx = prompt.indexOf(SENTINEL_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    prompt = prompt.slice(0, beginIdx).replace(/\n+$/, '') + prompt.slice(endIdx + SENTINEL_END.length);
  }
  // 空 memoryBlock → 不写 sentinel
  if (memoryBlock && memoryBlock.trim()) {
    prompt = prompt.replace(/\n+$/, '') + '\n\n' + SENTINEL_BEGIN + '\n' + memoryBlock + '\n' + SENTINEL_END + '\n';
  }
  fs.writeFileSync(promptFilePath, prompt, 'utf-8');
}

module.exports = { composeMemoryBlock, appendMemoryToPromptFile, SENTINEL_BEGIN, SENTINEL_END };
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T4.2 composeMemoryBlock returns empty string for empty dir`

- [ ] **Step 9: 加 T4.3（`composeMemoryBlock` 有 facts 时返回内容 + sentinel 幂等）**

```js
  // T4.3: composeMemoryBlock returns content when facts.md present
  const block = await injector.composeMemoryBlock({ projectCwd: TEMP_PROJECT });
  assert.ok(block.includes('## 你已知的项目背景'), 'has TLDR header');
  assert.ok(block.includes('hookPort 默认 3456'), 'includes fact');

  // T4.4: appendMemoryToPromptFile is idempotent
  const promptFile = path.join(TEMP_PROJECT, '_test-prompt.md');
  fs.writeFileSync(promptFile, '# Original prompt\n\nSome content.\n', 'utf-8');
  injector.appendMemoryToPromptFile(promptFile, block);
  const after1 = fs.readFileSync(promptFile, 'utf-8');
  assert.ok(after1.includes(injector.SENTINEL_BEGIN));
  assert.ok(after1.includes(injector.SENTINEL_END));
  assert.ok(after1.includes('hookPort 默认 3456'));

  // 重复注入：文件大小不应翻倍
  injector.appendMemoryToPromptFile(promptFile, block);
  const after2 = fs.readFileSync(promptFile, 'utf-8');
  assert.strictEqual(after1, after2, 'second injection produces identical content');
  // 注入空 block：sentinel 区块应被剥离
  injector.appendMemoryToPromptFile(promptFile, '');
  const after3 = fs.readFileSync(promptFile, 'utf-8');
  assert.ok(!after3.includes(injector.SENTINEL_BEGIN), 'empty block strips sentinel');
  assert.ok(after3.includes('# Original prompt'), 'original content preserved');
  console.log('PASS T4.3 composeMemoryBlock + appendMemoryToPromptFile idempotent');
```

- [ ] **Step 10: 跑测试确认通过**

Run: `node tests/arena-memory.test.js`
Expected: `PASS T4.3 composeMemoryBlock + appendMemoryToPromptFile idempotent`

- [ ] **Step 11: Commit**

```bash
git add core/arena-memory/store.js core/arena-memory/injector.js tests/arena-memory.test.js
git commit -m "feat(arena-memory): add persistMarkers + injector with sentinel idempotency"
```

---

### Task 5: driver-mcp-server.js — 注册 `arena_remember` 工具

**Files:**
- Modify: `core/driver-mcp-server.js`

- [ ] **Step 1: 在 `TOOLS` 数组追加 `arena_remember`**

读 `core/driver-mcp-server.js:40-77`，在 `request_danger_review` 工具定义之后（`];` 之前）追加新工具：

```js
  {
    name: 'arena_remember',
    description: '记录主驾会议室级关键决策/事实/教训供下次会议复用。'
               + '注意：工作偏好/技术习惯（如"我用 strict TS"）应走 ~/.claude/CLAUDE.md 或 Anthropic memory tool，'
               + '不要用此工具——这里只放本项目主驾会议室的特定共识。'
               + 'kind=fact 写到 .arena/memory/shared/facts.md（What/Why/Status 三段式），'
               + 'kind=lesson/decision 写到 .arena/memory/episodes.jsonl 事件流。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['fact', 'lesson', 'decision'],
          description: 'fact=项目级事实, lesson=审查中发现的隐患/教训, decision=方案选型决议' },
        what: { type: 'string', description: '当 kind=fact 时必填: 简短一句概括（用作去重 key）' },
        why: { type: 'string', description: '当 kind=fact 时必填: 为什么/原因' },
        status: { type: 'string', enum: ['stable', 'observed', 'deprecated'],
          description: '当 kind=fact 时必填: 状态。stable=稳定的事实, observed=新观察, deprecated=已废弃' },
        content: { type: 'string', description: '当 kind=lesson/decision 时必填: 一句话内容（<= 500 字）' },
      },
      required: ['kind'],
    },
  },
```

- [ ] **Step 2: 在 `tools/call` dispatch 加分支**

定位到 `:128-149` 的 `if (method === 'tools/call')` 块。在 `request_danger_review` 分支之后、`return replyError(id, -32601, 'unknown tool: ' + name);` 之前，追加：

```js
    if (name === 'arena_remember') {
      const kind = String(args.kind || '').trim();
      if (!['fact', 'lesson', 'decision'].includes(kind)) {
        return reply(id, { content: [{ type: 'text', text: '记忆失败：kind 必须是 fact/lesson/decision' }], isError: true });
      }
      const body = { token: HOOK_TOKEN, meetingId: MEETING_ID, kind };
      if (kind === 'fact') {
        const what = String(args.what || '').trim();
        const why = String(args.why || '').trim();
        const status = String(args.status || '').trim();
        if (!what || !why || !status) {
          return reply(id, { content: [{ type: 'text', text: '记忆失败：fact 需要 what/why/status' }], isError: true });
        }
        Object.assign(body, { what, why, status });
      } else {
        const content = String(args.content || '').trim();
        if (!content) {
          return reply(id, { content: [{ type: 'text', text: `记忆失败：${kind} 需要 content` }], isError: true });
        }
        body.content = content;
      }
      const r = await postRemember(body);
      const text = r.ok
        ? `已记忆 (${kind})。下次启动主驾会议会自动注入。`
        : `记忆失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
```

- [ ] **Step 3: 添加 `postRemember` 函数**

定位到 `:80-100` 的 `function postReview(body)` 之后，追加：

```js
function postRemember(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: '/api/driver/remember',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: chunks }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: 'request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.write(data);
    req.end();
  });
}
```

- [ ] **Step 4: smoke 验证 MCP server 能启动**

Run: `node core/driver-mcp-server.js < /dev/null 2>&1 | head -3` （Bash; Windows PowerShell 用 `cmd /c "type nul | node core/driver-mcp-server.js"` 也可）
Expected: 看到 `[arena-mcp] startup pid=...` stderr 输出，进程因 stdin 关闭迅速退出。**不应**有 `SyntaxError` 或 `ReferenceError`。

- [ ] **Step 5: Commit**

```bash
git add core/driver-mcp-server.js
git commit -m "feat(driver-mcp): register arena_remember tool"
```

---

### Task 6: main.js — `/api/driver/remember` HTTP handler

**Files:**
- Modify: `main.js`

- [ ] **Step 1: 找到 hookServer 注册其它路由的位置**

Run: `grep -n "/api/driver/request-review" main.js`
Expected: 输出形如 `1234:    if (req.url === '/api/driver/request-review' ...`

记下行号 N。

- [ ] **Step 2: 在 `/api/driver/request-review` handler 之后追加 `/api/driver/remember` handler**

在 N 附近找到该 if 块结束位置（`}` 行），追加（替换 `<HOOK_TOKEN_VAR>` 为该 handler 中实际使用的 hookToken 变量名，**复用**现有 token 校验逻辑）：

```js
    if (req.url === '/api/driver/remember' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (!data.token || data.token !== hookToken) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
            return;
          }
          const meetingId = String(data.meetingId || '');
          const meeting = meetingManager.getMeeting(meetingId);
          if (!meeting || !meeting.driverSessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'meeting or driver session not found' }));
            return;
          }
          const session = sessionManager.getSession(meeting.driverSessionId);
          const projectCwd = session && session.cwd;
          if (!projectCwd) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'no projectCwd' }));
            return;
          }
          const arenaStore = require('./core/arena-memory/store');
          if (data.kind === 'fact') {
            await arenaStore.appendFact(projectCwd, {
              what: data.what,
              why: data.why,
              status: data.status,
              source: 'mcp:arena_remember',
            });
            await arenaStore.appendEpisode(projectCwd, {
              type: 'remember',
              kind: 'fact',
              what: data.what,
              meetingId,
              source: 'mcp:arena_remember',
            });
          } else {
            await arenaStore.appendEpisode(projectCwd, {
              type: 'remember',
              kind: data.kind,
              content: data.content,
              meetingId,
              source: 'mcp:arena_remember',
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('[hub] /api/driver/remember error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
```

> **注意**：上面变量名（`hookToken` / `meetingManager` / `sessionManager`）要用 main.js 中实际存在的同名变量。先 `grep -n "hookToken " main.js` 和 `grep -n "meetingManager\|sessionManager" main.js` 确认实际名字，必要时调整。

- [ ] **Step 3: smoke 验证 Hub 能启动（不引入 require 错误）**

Run: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -25`
Expected: 看到 `[hub] hook server listening on 127.0.0.1:...`，**不要**有 `Cannot find module './core/arena-memory/store'` 或 `SyntaxError`。

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(main): register /api/driver/remember HTTP handler"
```

---

### Task 7: main.js — 启动会议挂注入器

**Files:**
- Modify: `main.js`

- [ ] **Step 1: 找到 add-meeting-sub IPC handler 中调用 writeDriverPromptFile 的位置**

Run: `grep -n "writeDriverPromptFile\|writeCopilotPromptFile" main.js`

记下两处文件返回路径赋值的行号。

- [ ] **Step 2: 在每处 prompt 文件写入后，调用注入器**

在 add-meeting-sub 处理 `kind === 'claude'` 分支中，`writeDriverPromptFile(...)` 返回 `promptFile` 变量后追加：

```js
    // arena-memory: 注入会议室共识到主驾 prompt 尾部
    try {
      const arenaInjector = require('./core/arena-memory/injector');
      const arenaStore = require('./core/arena-memory/store');
      const sess = sessionManager.getSession(meeting.driverSessionId || claudeSession.id) || claudeSession;
      const cwd = sess && sess.cwd;
      if (cwd) {
        const block = await arenaInjector.composeMemoryBlock({ projectCwd: cwd });
        arenaInjector.appendMemoryToPromptFile(promptFile, block);
        await arenaStore.appendEpisode(cwd, { type: 'injection', meetingId, audience: 'driver', tokens: block.length });
      }
    } catch (e) {
      console.error('[hub] arena-memory injection (driver) failed:', e.message);
    }
```

> 实际变量名以 main.js 实际为准——找 `claudeSession` 或同等代表当前 Claude session 对象的变量；`cwd` 字段可能叫别的。

- [ ] **Step 3: 同样改 Gemini/Codex 副驾分支**

在 add-meeting-sub 处理 `kind === 'gemini'` / `kind === 'codex'` 分支，`writeCopilotPromptFile(...)` 返回 `promptFile` 后追加（针对 gemini）：

```js
    try {
      const arenaInjector = require('./core/arena-memory/injector');
      const arenaStore = require('./core/arena-memory/store');
      const meet = meetingManager.getMeeting(meetingId);
      const driverSess = meet && meet.driverSessionId ? sessionManager.getSession(meet.driverSessionId) : null;
      const cwd = driverSess && driverSess.cwd;
      if (cwd) {
        const block = await arenaInjector.composeMemoryBlock({ projectCwd: cwd });
        arenaInjector.appendMemoryToPromptFile(promptFile, block);
        await arenaStore.appendEpisode(cwd, { type: 'injection', meetingId, audience: 'gemini', tokens: block.length });
      }
    } catch (e) {
      console.error('[hub] arena-memory injection (gemini) failed:', e.message);
    }
```

Codex 分支同样写法，`audience: 'codex'`。

- [ ] **Step 4: 同样改 resume IPC handler**

Run: `grep -n "ipcMain.handle.*resume\|'resume'" main.js`

定位 resume IPC handler，在它内部 `writeDriverPromptFile`/`writeCopilotPromptFile` 后追加同样三段（driver/gemini/codex），audience 对应 'driver'/'gemini'/'codex'，`audience` event 加字段 `via: 'resume'`。

- [ ] **Step 5: smoke 验证**

Run: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -25`
Expected: `[hub] hook server listening`，无 SyntaxError。

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(main): inject arena memory into prompt files on meeting start/resume"
```

---

### Task 8: main.js — `executeReview` 解析副驾 marker

**Files:**
- Modify: `main.js`

- [ ] **Step 1: 找到 executeReview 写 reviews md 的位置**

Run: `grep -n "reviews/.*.md\|fs.writeFileSync.*reviewId" main.js`
Expected: 定位 `:627-637` 附近的 `fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');`

- [ ] **Step 2: 在 reviews md 写入之后追加 marker 解析**

在 `fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');` 之后追加：

```js
      // arena-memory: 解析副驾 [lesson]/[fact]/[decision] 标记 → 持久化
      try {
        const parser = require('./core/arena-memory/marker-parser');
        const arenaStore = require('./core/arena-memory/store');
        let totalMarkers = { fact: 0, lesson: 0, decision: 0 };
        for (const r of results) {
          if (!r.text) continue;
          // r.label 形如 'Gemini' / 'Codex'，转小写匹配 copilotKind
          const copilotKind = String(r.label || '').toLowerCase();
          if (!['gemini', 'codex'].includes(copilotKind)) continue;
          const markers = parser.parseMarkers(r.text, copilotKind);
          if (markers.length) {
            const persistResult = await arenaStore.persistMarkers(projectCwd, markers, { source: `marker:${reviewId}` });
            for (const m of markers) totalMarkers[m.kind] = (totalMarkers[m.kind] || 0) + 1;
          }
        }
        await arenaStore.appendEpisode(projectCwd, {
          type: 'review_complete',
          reviewId,
          meetingId,
          markerCounts: totalMarkers,
        });
      } catch (e) {
        console.error('[hub] arena-memory marker parsing failed:', e.message);
      }
```

> 此处 `results` / `projectCwd` / `reviewId` / `meetingId` 都应是该函数本地已有的变量，无需新声明。

- [ ] **Step 3: smoke 验证**

Run: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -25`
Expected: 启动正常。

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(main): parse copilot markers in executeReview, persist to arena memory"
```

---

### Task 9: driver-mode.js — 副驾 + 主驾 prompt 模板扩展

**Files:**
- Modify: `core/driver-mode.js`

- [ ] **Step 1: 扩展 `COPILOT_PROMPT_GEMINI`**

打开 `core/driver-mode.js`，定位 `:90-117` 的 `COPILOT_PROMPT_GEMINI` 模板。在 `## 输出格式` 段后（template 字符串结尾的反引号 `\`` 之前）追加：

```
## MEMORY PROTOCOL（重要，区分两类记忆）

**A 类：你的个人工作偏好/技术习惯**（跨项目通用，跨 CLI 会话累积）
→ 直接调用 save_memory 工具（你自带的工具），写到你的 ~/.gemini/GEMINI.md
→ 例："I prefer functional programming"、"User prefers strict TypeScript"

**B 类：本主驾会议室的项目级关键共识**（仅本项目主驾会议复用）
→ 在你的审查回复末尾追加 ## 记忆 段，每条一行：
   ## 记忆
   [fact] hookPort 默认 3456，碰撞向后 fallback
   [lesson] PTY 输入空格触发 readline 回显，应走 sendKeys
   [decision] 选 react-window，因 immer 包大小翻倍

**判断准则**：
- 这条经验换个项目还成立？→ A 类（save_memory）
- 这条只对本项目主驾会议室有意义？→ B 类（标记）
- 不确定？→ B 类，不会污染其他项目
```

- [ ] **Step 2: 同样扩展 `COPILOT_PROMPT_CODEX`**

定位 `:122-149`。在 `## 输出格式` 段后追加同样段落，但把 A 类那一段改为：

```
**A 类：你的个人工作偏好/技术习惯**（跨项目通用，跨 CLI 会话累积）
→ Codex 已启用自动记忆系统（~/.codex/memories/），你的高质量经验会自动入库
→ 例："I prefer functional programming"、"User prefers strict TypeScript"
```

- [ ] **Step 3: 扩展 `DRIVER_RULES_TEMPLATE`**

定位 `:8-85` 的 `DRIVER_RULES_TEMPLATE`。在 `## 危险操作` 段之前（或在 `## 何时召唤副驾` 之后）追加：

```
## 工具：arena_remember（会议室共识记忆）

本工具只用于"本主驾会议室项目级关键决策/事实/教训"。**不要用 arena_remember 记你的个人工作偏好**——
那应该用 Anthropic memory tool 或写到 ~/.claude/CLAUDE.md。

适合场景（B 类，调用 arena_remember）：
- 项目特定决策（如"我们选了 react-window 而非 immer"）
- 跨副驾审查发现的项目级隐患（PTY/并发/Windows 路径等）
- 用户在本会议明确强调的项目事实

不适合场景（A 类，应走 ~/.claude/CLAUDE.md 或 memory tool）：
- 跨项目通用的工作偏好（"我喜欢函数式"）
- 你的代码风格习惯（"我用 strict TS"）

参数：kind=fact 时需 what/why/status；kind=lesson/decision 时需 content。
```

- [ ] **Step 4: smoke 验证**

Run: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -25`
Expected: 启动正常。

- [ ] **Step 5: Commit**

```bash
git add core/driver-mode.js
git commit -m "feat(driver-mode): teach copilots+driver MEMORY PROTOCOL (A/B class split)"
```

---

### Task 10: 全量 E2E 验证

**Files:** （只跑测试，不改代码）

- [ ] **Step 1: 跑全部单测**

Run: `node tests/arena-memory.test.js`
Expected: 看到 `PASS T1.1 ... T4.3` 全部，最后 `---all tests passed---`。

- [ ] **Step 2: 隔离启动 Hub 并冒烟**

Run（PowerShell）：
```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-arena-mem"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9221
```

Expected: Hub 弹窗启动，无错误日志。

- [ ] **Step 3: E2E 路径 1（主驾 MCP 写）**

在 Hub UI 新建主驾会议（toggle driver-mode），attach Claude。在 Claude 会话里输入：
> 调用 arena_remember 工具，kind=fact, what="hookPort 默认 3456", why="MCP server 通过 ARENA_HUB_PORT 拿到端口", status="stable"

Expected：
- Claude 工具调用成功，返回 "已记忆 (fact)"
- 项目根 `<projectCwd>/.arena/memory/shared/facts.md` 已创建并含此条
- `<projectCwd>/.arena/memory/episodes.jsonl` 多 1 行 `type:'remember'`

- [ ] **Step 4: E2E 路径 2（副驾标记自动写）**

attach Gemini + Codex。触发 `request_review`（提供 scope/open_risks）。在副驾回复后查看：

Expected：
- 如果副驾按 MEMORY PROTOCOL 输出了 `[fact]/[lesson]/[decision]` 标记，`shared/facts.md` 应有新 fact 条目（如有），`episodes.jsonl` 应有 `type:'marker'` 条目（lesson/decision），并有 `type:'review_complete'` 含 `markerCounts`

> 注：首次会话副驾可能不主动写标记。无标记时跳过此步。

- [ ] **Step 5: E2E 路径 3（回流注入）**

关闭主驾会议（关 meeting），同 projectCwd 重新开主驾会议，attach Claude。

Expected：
- 新 prompt 文件 `<hubData>/arena-prompts/<mid>-driver.md` 末尾含 `<!-- ARENA_MEMORY_BEGIN -->` 区块，区块内含 hookPort 那条 fact
- 在 Claude 会话里问"你知道这个项目什么"，应能引用 hookPort fact
- `episodes.jsonl` 多 1 行 `type:'injection'`

- [ ] **Step 6: 上线 gate（强制）**

Run: `timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -25`
Expected: `[hub] hook server listening on 127.0.0.1:...`，无 `Cannot find module`。

Run: `npm install --dry-run 2>&1 | grep -E "added|removed"`
Expected: 0 new packages（"added 0 packages" 或无相关输出）。

- [ ] **Step 7: 完工 commit**

```bash
git status
# 如有遗漏的 staged/unstaged 改动，按文件 add 后：
git commit -m "chore(arena-memory): M1 complete — verified e2e paths 1+2+3 & smoke gate"
```

---

## 自检清单（最后跑一次）

- [ ] 所有单测 PASS：`node tests/arena-memory.test.js`
- [ ] smoke test：Hub 启动正常，hook server listening 出现
- [ ] `npm install --dry-run` 0 新包
- [ ] 三个 E2E 路径（主驾 MCP 写 / 副驾标记 / 回流注入）至少 1+3 通过；2 因副驾自觉性可能不稳，标记空跑标记不算回归
- [ ] `<projectCwd>/.arena/memory/shared/facts.md` 内容用 What/Why/Status 三段式
- [ ] `<projectCwd>/.arena/memory/episodes.jsonl` 每行合法 JSON 含 `v:1, ts, type`
- [ ] 副驾 prompt 模板含 MEMORY PROTOCOL 段
- [ ] 主驾 DRIVER_RULES 含 arena_remember 工具用法

---

## 失败应对

| 现象 | 处置 |
|---|---|
| `node tests/arena-memory.test.js` 报 Cannot find module './core/arena-memory/store' | 该文件未建/被 .gitignore 忽略，确认 `core/arena-memory/` 目录存在 |
| Hub 启动报 `Cannot find module './core/arena-memory/store'` | main.js 的 `require('./core/arena-memory/store')` 路径错误，按 main.js 所在目录算 |
| MCP 工具调用失败 "记忆失败：fact 需要 what/why/status" | Claude 调用时少传字段，调整 DRIVER_RULES 用法说明使其更明确 |
| `executeReview` 解析没出 marker | 副驾未输出 `[xxx]` 标记，看副驾完整回复确认 prompt 是否生效 |
| Hub 启动报新依赖错误 | 不应该有，本方案 0 新依赖；检查是否误改 package.json |
| `appendMemoryToPromptFile` 越写越长 | sentinel 剥离逻辑有 bug，写测试覆盖 |

---

## 不做的事（再次确认 YAGNI）

- ❌ 不造 driver/gemini/codex 三家分目录（CLI 各自管个人成长）
- ❌ 不造 ~/.arena/memory/global/（CLI user-level memory 已是此层）
- ❌ 不写 LLM 反思 / Stop hook（CLI 自带替代 + 用户确认会议长期不结束）
- ❌ 不引入新 npm 依赖
- ❌ 不开放副驾写文件能力
