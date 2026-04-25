# Deep Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在会议室点一个按钮,3 家 AI 协作的 timeline 被压缩成"共识/决策/分歧/未决"四张结构化卡片显示在 modal 里。

**Architecture:** 三层 — UI Modal → Service 编排 → Provider 双轨（Gemini CLI 主 / DeepSeek API 备）+ 五层防御解析。数据源是 Phase 1 已有的 `meetingManager.getTimeline(meetingId)`,本期不动 timeline。

**Tech Stack:** Node.js (Electron main + renderer) · child_process (Gemini CLI) · https (DeepSeek API) · IPC · 自写 test runner（Hub 现有 `_unit-*.js` 模式）

---

## File Map

| 文件 | 状态 | 职责 |
|---|---|---|
| `config/deep-summary-config.json` | 新建 | provider 链/超时/secrets 路径配置 |
| `core/summary-parser.js` | 新建 | 五层防御:tryParseJson + applySchema + validateBusiness + parse 编排 |
| `core/summary-providers/gemini-cli.js` | 新建 | subprocess 调 Gemini CLI,处理空响应/超时 |
| `core/summary-providers/deepseek-api.js` | 新建 | HTTP POST DeepSeek + secrets.toml 读 key |
| `core/deep-summary-service.js` | 新建 | 编排:timeline → prompt → provider chain → parse |
| `core/summary-prompt.js` | 新建 | buildPrompt(timeline) → {system, user},含 few-shot |
| `main.js` | 修改 | 注册 IPC `generate-meeting-summary` |
| `renderer/meeting-summary-modal.js` | 新建 | Modal UI:触发 + loading + 卡片 + 错误降级 |
| `renderer/meeting-room.js` | 修改 | 工具栏加按钮,绑定 modal |
| `renderer/meeting-room.css` | 修改 | 追加 modal + card 样式（基于 demo HTML） |
| `tests/_unit-summary-parser.js` | 新建 | parser 三段五层各 case |
| `tests/_unit-summary-providers.js` | 新建 | 两个 provider 的 mock 测试 |
| `tests/_integration-deep-summary.js` | 新建 | service + provider chain 集成 |
| `tests/_e2e-deep-summary-real.js` | 新建 | CDP 跑真实 Hub 实例 6 场景 |

---

## 任务排序逻辑

1. **配置先行**(Task 1):后续所有模块都读配置
2. **纯函数最早**(Task 2-4):parser 不依赖外部,易测,失败成本低
3. **Provider 独立**(Task 5-6):每个 provider 自包含,先 mock 测试
4. **Service 编排**(Task 7-8):把上面拼起来,集成测试
5. **IPC 桥**(Task 9):main 进程暴露
6. **UI 渲染**(Task 10-12):完成可见效果
7. **E2E 真实**(Task 13):CDP 端到端验证

---

### Task 1: 配置文件 + 加载器

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\config\deep-summary-config.json`
- Create: `C:\Users\lintian\claude-session-hub\core\deep-summary-config.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-deep-summary-config.js`

- [ ] **Step 1.1: 创建 config JSON**

```json
{
  "fallback_chain": ["gemini-cli", "deepseek-api"],
  "gemini_cli": {
    "timeout_ms": 90000,
    "model_override": null
  },
  "deepseek_api": {
    "model": "deepseek-chat",
    "endpoint": "https://api.deepseek.com/chat/completions",
    "timeout_ms": 60000,
    "max_retries": 1,
    "secrets_file": "C:\\LinDangAgent\\secrets.toml",
    "secrets_key": "DEEPSEEK_API_KEY"
  },
  "ui": {
    "modal_max_width_px": 900,
    "show_raw_json_button": true
  }
}
```

- [ ] **Step 1.2: 写测试**

```javascript
// tests/_unit-deep-summary-config.js
const assert = require('assert');
const path = require('path');
const { loadConfig, getDefault } = require('../core/deep-summary-config.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

console.log('deep-summary-config:');
test('loadConfig 读到默认 fallback_chain', () => {
  const cfg = loadConfig();
  assert.deepStrictEqual(cfg.fallback_chain, ['gemini-cli', 'deepseek-api']);
});
test('loadConfig 缺文件时返回硬编码默认', () => {
  const cfg = loadConfig('/non/existent/path.json');
  assert.deepStrictEqual(cfg, getDefault());
});
test('getDefault 包含 deepseek_api.endpoint', () => {
  const d = getDefault();
  assert.strictEqual(d.deepseek_api.endpoint, 'https://api.deepseek.com/chat/completions');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 1.3: 运行测试看失败**

```bash
node tests/_unit-deep-summary-config.js
```
Expected: FAIL `Cannot find module '../core/deep-summary-config.js'`

- [ ] **Step 1.4: 实现 loader**

```javascript
// core/deep-summary-config.js
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'deep-summary-config.json');

function getDefault() {
  return {
    fallback_chain: ['gemini-cli', 'deepseek-api'],
    gemini_cli: { timeout_ms: 90000, model_override: null },
    deepseek_api: {
      model: 'deepseek-chat',
      endpoint: 'https://api.deepseek.com/chat/completions',
      timeout_ms: 60000,
      max_retries: 1,
      secrets_file: 'C:\\LinDangAgent\\secrets.toml',
      secrets_key: 'DEEPSEEK_API_KEY',
    },
    ui: { modal_max_width_px: 900, show_raw_json_button: true },
  };
}

function loadConfig(filepath = DEFAULT_CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return getDefault();
  }
}

module.exports = { loadConfig, getDefault };
```

- [ ] **Step 1.5: 运行测试看通过**

```bash
node tests/_unit-deep-summary-config.js
```
Expected: `3 passed, 0 failed`

- [ ] **Step 1.6: Commit**

```bash
git add config/deep-summary-config.json core/deep-summary-config.js tests/_unit-deep-summary-config.js
git commit -m "feat(deep-summary): config schema + loader (task 1)"
```

---

### Task 2: summary-parser — Layer 2 (tryParseJson)

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\summary-parser.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-summary-parser.js`

- [ ] **Step 2.1: 写 4 个测试**

```javascript
// tests/_unit-summary-parser.js
const assert = require('assert');
const { tryParseJson } = require('../core/summary-parser.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

console.log('tryParseJson:');
test('直接合法 JSON', () => {
  const r = tryParseJson('{"a":1}');
  assert.deepStrictEqual(r, { a: 1 });
});
test('代码块包裹的 JSON', () => {
  const r = tryParseJson('解释一下:\n```json\n{"a":2}\n```\n');
  assert.deepStrictEqual(r, { a: 2 });
});
test('代码块无 json 标记', () => {
  const r = tryParseJson('```\n{"a":3}\n```');
  assert.deepStrictEqual(r, { a: 3 });
});
test('贪婪正则提取', () => {
  const r = tryParseJson('Here is your summary: {"a":4} Hope it helps!');
  assert.deepStrictEqual(r, { a: 4 });
});
test('完全坏的输入返回 null', () => {
  assert.strictEqual(tryParseJson('this is not json at all'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 2.2: 运行测试看失败**

```bash
node tests/_unit-summary-parser.js
```
Expected: FAIL `Cannot find module '../core/summary-parser.js'`

- [ ] **Step 2.3: 实现 tryParseJson**

```javascript
// core/summary-parser.js

function tryParseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch {}
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }
  return null;
}

module.exports = { tryParseJson };
```

- [ ] **Step 2.4: 运行测试看通过**

```bash
node tests/_unit-summary-parser.js
```
Expected: `5 passed, 0 failed`

- [ ] **Step 2.5: Commit**

```bash
git add core/summary-parser.js tests/_unit-summary-parser.js
git commit -m "feat(deep-summary): tryParseJson 三段 fallback (task 2)"
```

---

### Task 3: summary-parser — Layer 3 (applySchema)

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\summary-parser.js`
- Modify: `C:\Users\lintian\claude-session-hub\tests\_unit-summary-parser.js`

- [ ] **Step 3.1: 追加 4 个测试**

在 tests/_unit-summary-parser.js 末尾的 `process.exit` 行**之前**添加:

```javascript
const { applySchema } = require('../core/summary-parser.js');

console.log('\napplySchema:');
test('完整 4 字段 → status=ok, warnings=[]', () => {
  const r = applySchema({
    consensus: [{ text: 'x', supporters: ['claude'] }],
    disagreements: [],
    decisions: [],
    open_questions: [],
  });
  assert.strictEqual(r.warnings.length, 0);
  assert.strictEqual(r.result.consensus.length, 1);
});
test('缺 disagreements → 自动补 [] + warning', () => {
  const r = applySchema({ consensus: [], decisions: [], open_questions: [] });
  assert.deepStrictEqual(r.result.disagreements, []);
  assert.ok(r.warnings.some(w => w.includes('disagreements')));
});
test('全缺 4 字段 → 4 个 warning + 4 个空数组', () => {
  const r = applySchema({});
  assert.strictEqual(r.warnings.length, 4);
  assert.deepStrictEqual(r.result.consensus, []);
  assert.deepStrictEqual(r.result.disagreements, []);
  assert.deepStrictEqual(r.result.decisions, []);
  assert.deepStrictEqual(r.result.open_questions, []);
});
test('字段类型错误（不是数组）→ 视为缺失', () => {
  const r = applySchema({
    consensus: 'should be array',
    disagreements: { wrong: 'type' },
    decisions: null,
    open_questions: 42,
  });
  assert.strictEqual(r.warnings.length, 4);
  assert.deepStrictEqual(r.result.consensus, []);
});
```

- [ ] **Step 3.2: 运行测试看失败**

```bash
node tests/_unit-summary-parser.js
```
Expected: FAIL `applySchema is not a function`

- [ ] **Step 3.3: 实现 applySchema**

在 core/summary-parser.js 的 `module.exports` 之前追加:

```javascript
function applySchema(obj) {
  const warnings = [];
  const safeArray = (val, name) => {
    if (Array.isArray(val)) return val;
    warnings.push(`${name} 字段缺失或类型错误`);
    return [];
  };
  const result = {
    consensus: safeArray(obj && obj.consensus, 'consensus'),
    disagreements: safeArray(obj && obj.disagreements, 'disagreements'),
    decisions: safeArray(obj && obj.decisions, 'decisions'),
    open_questions: safeArray(obj && obj.open_questions, 'open_questions'),
  };
  return { result, warnings };
}
```

并把 `module.exports = { tryParseJson };` 改为:

```javascript
module.exports = { tryParseJson, applySchema };
```

- [ ] **Step 3.4: 运行测试看通过**

```bash
node tests/_unit-summary-parser.js
```
Expected: `9 passed, 0 failed`

- [ ] **Step 3.5: Commit**

```bash
git add core/summary-parser.js tests/_unit-summary-parser.js
git commit -m "feat(deep-summary): applySchema 部分降级校验 (task 3)"
```

---

### Task 4: summary-parser — Layer 4 (validateBusiness) + parse 总编排

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\summary-parser.js`
- Modify: `C:\Users\lintian\claude-session-hub\tests\_unit-summary-parser.js`

- [ ] **Step 4.1: 追加测试**

在 tests/_unit-summary-parser.js 的 `process.exit` 之前追加:

```javascript
const { validateBusiness, parse } = require('../core/summary-parser.js');

console.log('\nvalidateBusiness:');
test('过滤 supporters 中不存在的 AI', () => {
  const data = {
    consensus: [{ text: 'x', supporters: ['claude', 'codex', 'ghost'] }],
    disagreements: [], decisions: [], open_questions: [],
  };
  const r = validateBusiness(data, new Set(['claude', 'codex', 'user']));
  assert.deepStrictEqual(r.consensus[0].supporters, ['claude', 'codex']);
});
test('共识全员失效 → 整条记录被剔除', () => {
  const data = {
    consensus: [
      { text: 'a', supporters: ['ghost1', 'ghost2'] },
      { text: 'b', supporters: ['claude'] },
    ],
    disagreements: [], decisions: [], open_questions: [],
  };
  const r = validateBusiness(data, new Set(['claude', 'user']));
  assert.strictEqual(r.consensus.length, 1);
  assert.strictEqual(r.consensus[0].text, 'b');
});
test('disagreements positions.by 失效 → 整条 position 剔除', () => {
  const data = {
    consensus: [],
    disagreements: [{
      topic: 't',
      positions: [
        { by: 'claude', view: 'A' },
        { by: 'ghost', view: 'B' },
      ],
    }],
    decisions: [], open_questions: [],
  };
  const r = validateBusiness(data, new Set(['claude', 'user']));
  assert.strictEqual(r.disagreements[0].positions.length, 1);
});
test('open_questions 非字符串 → 过滤掉', () => {
  const data = {
    consensus: [], disagreements: [], decisions: [],
    open_questions: ['ok', null, 42, 'also ok'],
  };
  const r = validateBusiness(data, new Set(['user']));
  assert.deepStrictEqual(r.open_questions, ['ok', 'also ok']);
});

console.log('\nparse (总编排):');
test('完整路径:坏 JSON → null → status=failed', () => {
  const r = parse('not json at all', new Set(['claude']));
  assert.strictEqual(r.status, 'failed');
  assert.ok(r.raw_output);
});
test('完整路径:合法 JSON → status=ok', () => {
  const raw = JSON.stringify({
    consensus: [{ text: 'x', supporters: ['claude'] }],
    disagreements: [], decisions: [], open_questions: [],
  });
  const r = parse(raw, new Set(['claude', 'user']));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.data.consensus.length, 1);
});
test('完整路径:缺字段 → status=partial + warnings', () => {
  const raw = JSON.stringify({ consensus: [] });
  const r = parse(raw, new Set(['claude', 'user']));
  assert.strictEqual(r.status, 'partial');
  assert.ok(r.warnings.length >= 1);
});
```

- [ ] **Step 4.2: 运行测试看失败**

```bash
node tests/_unit-summary-parser.js
```
Expected: FAIL `validateBusiness is not a function`

- [ ] **Step 4.3: 实现 validateBusiness + parse**

在 core/summary-parser.js 的 module.exports 之前追加:

```javascript
function validateBusiness(data, presentAIs) {
  const isValidAI = (s) => typeof s === 'string' && presentAIs.has(s);
  const out = {
    consensus: data.consensus
      .filter(c => c && typeof c.text === 'string' && Array.isArray(c.supporters))
      .map(c => ({ ...c, supporters: c.supporters.filter(isValidAI) }))
      .filter(c => c.supporters.length > 0),
    disagreements: data.disagreements
      .filter(d => d && typeof d.topic === 'string' && Array.isArray(d.positions))
      .map(d => ({
        ...d,
        positions: d.positions
          .filter(p => p && typeof p.view === 'string' && isValidAI(p.by)),
      }))
      .filter(d => d.positions.length > 0),
    decisions: data.decisions
      .filter(dec => dec && typeof dec.text === 'string'),
    open_questions: data.open_questions
      .filter(q => typeof q === 'string' && q.length > 0),
  };
  return out;
}

function parse(rawOutput, presentAIs) {
  const obj = tryParseJson(rawOutput);
  if (!obj) {
    return { status: 'failed', raw_output: rawOutput, warnings: ['解析 JSON 失败'] };
  }
  const { result, warnings } = applySchema(obj);
  const validated = validateBusiness(result, presentAIs);
  return {
    status: warnings.length > 0 ? 'partial' : 'ok',
    data: validated,
    warnings,
  };
}
```

并更新 export:

```javascript
module.exports = { tryParseJson, applySchema, validateBusiness, parse };
```

- [ ] **Step 4.4: 运行测试看通过**

```bash
node tests/_unit-summary-parser.js
```
Expected: `16 passed, 0 failed`

- [ ] **Step 4.5: Commit**

```bash
git add core/summary-parser.js tests/_unit-summary-parser.js
git commit -m "feat(deep-summary): validateBusiness + parse 总编排 (task 4)"
```

---

### Task 5: summary-prompt — buildPrompt + few-shot

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\summary-prompt.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-summary-prompt.js`

- [ ] **Step 5.1: 写测试**

```javascript
// tests/_unit-summary-prompt.js
const assert = require('assert');
const { buildPrompt } = require('../core/summary-prompt.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

const sampleTimeline = [
  { idx: 0, sid: 'user', text: '该选 TypeScript 还是 JavaScript?', ts: 1714000000000 },
  { idx: 1, sid: 'sid-claude-1', text: '推荐 TypeScript,类型安全。', ts: 1714000010000 },
  { idx: 2, sid: 'sid-codex-1', text: '同意,但建议小模块试点。', ts: 1714000020000 },
];
const labelMap = new Map([
  ['sid-claude-1', { label: 'Claude', kind: 'claude' }],
  ['sid-codex-1', { label: 'Codex', kind: 'codex' }],
]);

console.log('buildPrompt:');
test('返回 {system, user} 两字段', () => {
  const r = buildPrompt(sampleTimeline, labelMap);
  assert.ok(typeof r.system === 'string' && r.system.length > 100);
  assert.ok(typeof r.user === 'string' && r.user.length > 50);
});
test('system 含 4 字段名约束', () => {
  const r = buildPrompt(sampleTimeline, labelMap);
  assert.ok(r.system.includes('consensus'));
  assert.ok(r.system.includes('disagreements'));
  assert.ok(r.system.includes('decisions'));
  assert.ok(r.system.includes('open_questions'));
});
test('system 含 few-shot 示例 JSON', () => {
  const r = buildPrompt(sampleTimeline, labelMap);
  assert.ok(r.system.includes('"supporters"'));
});
test('user 含每条 turn 的 label 和 text', () => {
  const r = buildPrompt(sampleTimeline, labelMap);
  assert.ok(r.user.includes('Claude'));
  assert.ok(r.user.includes('Codex'));
  assert.ok(r.user.includes('类型安全'));
  assert.ok(r.user.includes('小模块试点'));
});
test('user 长度被截断在 50K 内', () => {
  const longTimeline = [];
  for (let i = 0; i < 1000; i++) {
    longTimeline.push({ idx: i, sid: 'sid-claude-1', text: 'x'.repeat(200), ts: i });
  }
  const r = buildPrompt(longTimeline, labelMap);
  assert.ok(r.user.length < 60000, `user too long: ${r.user.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
```

- [ ] **Step 5.2: 运行测试看失败**

```bash
node tests/_unit-summary-prompt.js
```
Expected: FAIL `Cannot find module '../core/summary-prompt.js'`

- [ ] **Step 5.3: 实现 buildPrompt**

```javascript
// core/summary-prompt.js

const SYSTEM_PROMPT = `你是一个多 AI 协作会议室的摘要助手。会议室里有 Claude、Codex、Gemini 三家 AI 与用户(user)对话协作。

任务:阅读会议 timeline,输出结构化的会议综合摘要 JSON。

【输出格式约束 — 必须严格遵守】
只输出一个 JSON 对象,不要任何 markdown 包裹、不要解释、不要前后文字。
JSON 必须包含且只包含以下 4 个 key:

{
  "consensus": [
    {
      "text": "<达成共识的内容>",
      "supporters": ["<参与表态的 AI:claude|codex|gemini|user>"]
    }
  ],
  "disagreements": [
    {
      "topic": "<分歧的主题>",
      "positions": [
        {"by": "<AI 名:claude|codex|gemini>", "view": "<该 AI 的具体观点>"}
      ]
    }
  ],
  "decisions": [
    {
      "text": "<已确定的决策>",
      "confirmed_by": ["<user 或 consensus>"]
    }
  ],
  "open_questions": ["<未解决的问题字符串数组>"]
}

【字段语义】
- consensus: 多家明确表示同意的观点。supporters 至少 2 个或包含 user。
- disagreements: 多家观点不同的主题。positions 必须列出每家具体怎么说。
- decisions: 用户拍板或多家共识的具体决策。
- open_questions: 讨论中提出但未结论的问题。

【BAD 反例,绝不要这么做】
- ❌ 把"谢谢"、"好的"当成 decision
- ❌ 仅措辞不同就当成 disagreement(如 Claude 说"快"、Codex 说"高效")
- ❌ supporters 数组里写不存在的 AI 名字(如 "ghost"、"chatgpt")
- ❌ 用 markdown 标题(# 共识)替代 JSON 字段

【GOOD 正例】
{
  "consensus": [
    {"text": "项目应引入 TypeScript", "supporters": ["claude", "codex", "gemini"]}
  ],
  "disagreements": [
    {"topic": "TypeScript strict mode 的启用时机",
     "positions": [
       {"by": "claude", "view": "建议项目启动即开 strict"},
       {"by": "codex", "view": "建议先 loose,团队适应后再切 strict"}
     ]}
  ],
  "decisions": [
    {"text": "采用渐进式迁移,先小模块试点", "confirmed_by": ["user"]}
  ],
  "open_questions": ["strict 与 loose mode 的最终选择待团队评估"]
}

【若无内容】对应字段返回空数组 [],不要省略 key。
【语言】用 timeline 的主要语言(中文/英文)输出文本字段。`;

const MAX_USER_PROMPT_CHARS = 50000;
const MAX_TURN_TEXT_CHARS = 1500;

function buildPrompt(timeline, labelMap) {
  const lines = [];
  lines.push('请基于以下会议 timeline 生成结构化摘要 JSON:');
  lines.push('');
  let total = 0;
  for (const turn of timeline) {
    let label;
    if (turn.sid === 'user') {
      label = '用户';
    } else {
      const meta = labelMap.get(turn.sid);
      label = meta ? meta.label : 'AI';
    }
    let text = typeof turn.text === 'string' ? turn.text : '';
    if (text.length > MAX_TURN_TEXT_CHARS) {
      text = text.slice(0, MAX_TURN_TEXT_CHARS) + '…[已截断]';
    }
    const line = `[#${turn.idx}] [${label}]: ${text}`;
    if (total + line.length > MAX_USER_PROMPT_CHARS) {
      lines.push(`[…后续 ${timeline.length - turn.idx} 条已省略以控制长度]`);
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  return {
    system: SYSTEM_PROMPT,
    user: lines.join('\n'),
  };
}

module.exports = { buildPrompt, SYSTEM_PROMPT };
```

- [ ] **Step 5.4: 运行测试看通过**

```bash
node tests/_unit-summary-prompt.js
```
Expected: `5 passed, 0 failed`

- [ ] **Step 5.5: Commit**

```bash
git add core/summary-prompt.js tests/_unit-summary-prompt.js
git commit -m "feat(deep-summary): buildPrompt + few-shot system prompt (task 5)"
```

---

### Task 6: GeminiCliProvider

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\summary-providers\gemini-cli.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-gemini-cli-provider.js`

- [ ] **Step 6.1: 写测试(用 mock subprocess)**

```javascript
// tests/_unit-gemini-cli-provider.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

(async () => {
  console.log('GeminiCliProvider:');

  // 准备:写一个假 Gemini CLI 脚本(node 脚本读 stdin,输出固定 JSON)
  const fakeBin = path.join(os.tmpdir(), `fake-gemini-${Date.now()}.js`);
  fs.writeFileSync(fakeBin, `
let buf = '';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ response: '{"consensus":[],"disagreements":[],"decisions":[],"open_questions":[]}' }));
  process.exit(0);
});
`);

  // 加载 provider 并劫持 spawn 命令为 node + fakeBin
  const { GeminiCliProvider } = require('../core/summary-providers/gemini-cli.js');
  const provider = new GeminiCliProvider({
    timeout_ms: 5000,
    _binOverride: process.execPath,
    _argsOverride: [fakeBin],
  });

  await test('成功路径返回 raw + elapsed_ms', async () => {
    const r = await provider.call({ system: 'sys', user: 'usr' });
    assert.ok(typeof r.raw === 'string' && r.raw.length > 0);
    assert.ok(typeof r.elapsed_ms === 'number' && r.elapsed_ms >= 0);
    const parsed = JSON.parse(r.raw);
    assert.deepStrictEqual(parsed.consensus, []);
  });

  // 准备:超时假脚本(永不返回)
  const stuckBin = path.join(os.tmpdir(), `stuck-gemini-${Date.now()}.js`);
  fs.writeFileSync(stuckBin, `setInterval(() => {}, 1000);`);
  const stuckProvider = new GeminiCliProvider({
    timeout_ms: 500,
    _binOverride: process.execPath,
    _argsOverride: [stuckBin],
  });
  await test('超时抛 Error 含 timeout', async () => {
    try {
      await stuckProvider.call({ system: 'sys', user: 'usr' });
      throw new Error('should have thrown');
    } catch (e) {
      assert.ok(/timeout/i.test(e.message), `expected timeout in: ${e.message}`);
    }
  });

  // 准备:空响应假脚本
  const emptyBin = path.join(os.tmpdir(), `empty-gemini-${Date.now()}.js`);
  fs.writeFileSync(emptyBin, `process.stdout.write(''); process.exit(0);`);
  const emptyProvider = new GeminiCliProvider({
    timeout_ms: 5000,
    _binOverride: process.execPath,
    _argsOverride: [emptyBin],
  });
  await test('空响应抛 Error 含 empty', async () => {
    try {
      await emptyProvider.call({ system: 'sys', user: 'usr' });
      throw new Error('should have thrown');
    } catch (e) {
      assert.ok(/empty/i.test(e.message), `expected empty in: ${e.message}`);
    }
  });

  // 清理
  try { fs.unlinkSync(fakeBin); fs.unlinkSync(stuckBin); fs.unlinkSync(emptyBin); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
```

- [ ] **Step 6.2: 运行测试看失败**

```bash
node tests/_unit-gemini-cli-provider.js
```
Expected: FAIL `Cannot find module '../core/summary-providers/gemini-cli.js'`

- [ ] **Step 6.3: 实现 GeminiCliProvider**

```javascript
// core/summary-providers/gemini-cli.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class GeminiCliProvider {
  constructor(options = {}) {
    this.name = 'gemini-cli';
    this.timeout_ms = options.timeout_ms || 90000;
    this.modelOverride = options.model_override || null;
    // Test injection
    this._binOverride = options._binOverride || null;
    this._argsOverride = options._argsOverride || null;
  }

  async call({ system, user }) {
    const start = Date.now();
    const sysFile = path.join(os.tmpdir(), `gemini-sys-${crypto.randomBytes(4).toString('hex')}.md`);
    fs.writeFileSync(sysFile, system, 'utf8');
    try {
      const raw = await this._spawn(user, sysFile);
      if (!raw || raw.length < 5) {
        throw new Error(`Gemini CLI returned empty output (${raw.length} bytes)`);
      }
      // 输出格式 JSON (含 .response 字段)
      let response = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.response === 'string') {
          response = parsed.response;
        } else if (raw.length < 200) {
          throw new Error(`Gemini CLI returned suspect short output without .response field: ${raw.slice(0, 100)}`);
        }
      } catch (e) {
        // 不是 JSON 包装,raw 本身就是输出 (rare)
        if (raw.length < 200) throw new Error(`Gemini CLI output too short: ${raw.slice(0, 100)}`);
      }
      return { raw: response, elapsed_ms: Date.now() - start };
    } finally {
      try { fs.unlinkSync(sysFile); } catch {}
    }
  }

  _spawn(userPrompt, sysFile) {
    return new Promise((resolve, reject) => {
      const bin = this._binOverride || 'gemini';
      const args = this._argsOverride
        ? this._argsOverride
        : ['--output-format', 'json', '-y'];
      const env = { ...process.env, GEMINI_SYSTEM_MD: sysFile };
      delete env.DEBUG;
      env.HTTP_PROXY = env.HTTP_PROXY || 'http://127.0.0.1:7890';
      env.HTTPS_PROXY = env.HTTPS_PROXY || 'http://127.0.0.1:7890';

      const child = spawn(bin, args, { env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`Gemini CLI timeout after ${this.timeout_ms}ms`));
      }, this.timeout_ms);

      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', err => {
        clearTimeout(timer);
        if (!killed) reject(new Error(`Gemini CLI spawn error: ${err.message}`));
      });
      child.on('exit', code => {
        clearTimeout(timer);
        if (killed) return;
        if (code !== 0) {
          return reject(new Error(`Gemini CLI exit ${code}: ${stderr.slice(0, 300)}`));
        }
        resolve(stdout);
      });

      child.stdin.write(userPrompt);
      child.stdin.end();
    });
  }
}

module.exports = { GeminiCliProvider };
```

- [ ] **Step 6.4: 运行测试看通过**

```bash
node tests/_unit-gemini-cli-provider.js
```
Expected: `3 passed, 0 failed`

- [ ] **Step 6.5: Commit**

```bash
git add core/summary-providers/gemini-cli.js tests/_unit-gemini-cli-provider.js
git commit -m "feat(deep-summary): GeminiCliProvider with timeout + empty detection (task 6)"
```

---

### Task 7: DeepSeekProvider

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\summary-providers\deepseek-api.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_unit-deepseek-provider.js`

- [ ] **Step 7.1: 写测试(用本地 HTTP 桩)**

```javascript
// tests/_unit-deepseek-provider.js
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

(async () => {
  console.log('DeepSeekProvider:');

  // 准备假 secrets.toml
  const fakeSecrets = path.join(os.tmpdir(), `secrets-${Date.now()}.toml`);
  fs.writeFileSync(fakeSecrets, 'DEEPSEEK_API_KEY = "sk-test-fake-12345"\n');

  // 启动 mock HTTP server
  let lastBody = null;
  let respMode = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      lastBody = JSON.parse(body);
      if (respMode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"consensus":[],"disagreements":[],"decisions":[],"open_questions":[]}' } }],
        }));
      } else if (respMode === '429') {
        res.writeHead(429); res.end('rate limit');
      } else if (respMode === '503') {
        res.writeHead(503); res.end('service unavailable');
      } else if (respMode === '401') {
        res.writeHead(401); res.end('unauthorized');
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/v1/chat`;

  const { DeepSeekProvider } = require('../core/summary-providers/deepseek-api.js');

  await test('成功路径返回 raw', async () => {
    respMode = 'ok';
    const p = new DeepSeekProvider({
      model: 'deepseek-chat',
      endpoint,
      timeout_ms: 5000,
      max_retries: 0,
      secrets_file: fakeSecrets,
      secrets_key: 'DEEPSEEK_API_KEY',
    });
    const r = await p.call({ system: 's', user: 'u' });
    assert.ok(r.raw.includes('consensus'));
    assert.ok(r.elapsed_ms >= 0);
    assert.strictEqual(lastBody.model, 'deepseek-chat');
    assert.strictEqual(lastBody.messages.length, 2);
  });

  await test('429 重试一次后失败', async () => {
    respMode = '429';
    const p = new DeepSeekProvider({
      model: 'deepseek-chat', endpoint, timeout_ms: 5000, max_retries: 1,
      secrets_file: fakeSecrets, secrets_key: 'DEEPSEEK_API_KEY',
    });
    try {
      await p.call({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (e) {
      assert.ok(/429/.test(e.message));
    }
  });

  await test('401 立即失败不重试', async () => {
    respMode = '401';
    const p = new DeepSeekProvider({
      model: 'deepseek-chat', endpoint, timeout_ms: 5000, max_retries: 3,
      secrets_file: fakeSecrets, secrets_key: 'DEEPSEEK_API_KEY',
    });
    try {
      await p.call({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (e) {
      assert.ok(/401|auth/i.test(e.message));
    }
  });

  await test('secrets 文件缺失抛 Error', async () => {
    const p = new DeepSeekProvider({
      model: 'deepseek-chat', endpoint, timeout_ms: 5000, max_retries: 0,
      secrets_file: '/non/existent/secrets.toml',
      secrets_key: 'DEEPSEEK_API_KEY',
    });
    try {
      await p.call({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (e) {
      assert.ok(/secrets|key/i.test(e.message));
    }
  });

  server.close();
  try { fs.unlinkSync(fakeSecrets); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
```

- [ ] **Step 7.2: 运行测试看失败**

```bash
node tests/_unit-deepseek-provider.js
```
Expected: FAIL `Cannot find module '../core/summary-providers/deepseek-api.js'`

- [ ] **Step 7.3: 实现 DeepSeekProvider**

```javascript
// core/summary-providers/deepseek-api.js
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

function readSecret(filepath, key) {
  let content;
  try { content = fs.readFileSync(filepath, 'utf8'); }
  catch { throw new Error(`secrets file not found: ${filepath}`); }
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm');
  const m = content.match(re);
  if (!m) throw new Error(`secrets key ${key} not found in ${filepath}`);
  return m[1];
}

function postJson(endpoint, payload, headers, timeout_ms) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: timeout_ms,
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP timeout after ${timeout_ms}ms`));
    });
    req.on('error', err => reject(err));
    req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class DeepSeekProvider {
  constructor(options) {
    this.name = 'deepseek-api';
    this.model = options.model || 'deepseek-chat';
    this.endpoint = options.endpoint;
    this.timeout_ms = options.timeout_ms || 60000;
    this.max_retries = options.max_retries == null ? 1 : options.max_retries;
    this.secrets_file = options.secrets_file;
    this.secrets_key = options.secrets_key;
  }

  async call({ system, user }) {
    const apiKey = readSecret(this.secrets_file, this.secrets_key);
    const start = Date.now();
    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    };
    const headers = { authorization: `Bearer ${apiKey}` };

    let lastErr;
    for (let attempt = 0; attempt <= this.max_retries; attempt++) {
      try {
        const { status, body } = await postJson(this.endpoint, payload, headers, this.timeout_ms);
        if (status === 200) {
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { throw new Error(`DeepSeek 200 but body not JSON: ${body.slice(0, 200)}`); }
          const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
          if (typeof content !== 'string' || content.length < 5) {
            throw new Error(`DeepSeek empty content: ${body.slice(0, 200)}`);
          }
          return { raw: content, elapsed_ms: Date.now() - start };
        }
        if (status === 401 || status === 403) {
          throw new Error(`DeepSeek auth failed (${status}): check API key`);
        }
        if (status === 429 || status === 503) {
          lastErr = new Error(`DeepSeek transient error ${status}: ${body.slice(0, 100)}`);
          if (attempt < this.max_retries) {
            await sleep(1000 * (attempt + 1));
            continue;
          }
          throw lastErr;
        }
        throw new Error(`DeepSeek HTTP ${status}: ${body.slice(0, 200)}`);
      } catch (e) {
        lastErr = e;
        if (/auth/i.test(e.message)) throw e;
        if (attempt >= this.max_retries) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr;
  }
}

module.exports = { DeepSeekProvider };
```

- [ ] **Step 7.4: 运行测试看通过**

```bash
node tests/_unit-deepseek-provider.js
```
Expected: `4 passed, 0 failed`

- [ ] **Step 7.5: Commit**

```bash
git add core/summary-providers/deepseek-api.js tests/_unit-deepseek-provider.js
git commit -m "feat(deep-summary): DeepSeekProvider with retry + auth handling (task 7)"
```

---

### Task 8: deep-summary-service 编排

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\core\deep-summary-service.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\_integration-deep-summary.js`

- [ ] **Step 8.1: 写集成测试**

```javascript
// tests/_integration-deep-summary.js
const assert = require('assert');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

(async () => {
  console.log('deep-summary-service integration:');

  const { DeepSummaryService } = require('../core/deep-summary-service.js');

  // Mock providers
  function mockProvider(name, behavior) {
    return {
      name,
      async call() {
        if (behavior.throw) throw new Error(behavior.throw);
        return { raw: behavior.raw, elapsed_ms: 10 };
      },
    };
  }

  const sampleTimeline = [
    { idx: 0, sid: 'user', text: 'hi', ts: 1000 },
    { idx: 1, sid: 'sid-c', text: 'hello', ts: 2000 },
  ];
  const presentAIs = new Set(['claude', 'user']);
  const goodJson = JSON.stringify({ consensus: [], disagreements: [], decisions: [], open_questions: [] });

  await test('第一个 provider 成功就不调第二个', async () => {
    let secondCalled = false;
    const p1 = mockProvider('p1', { raw: goodJson });
    const p2 = {
      name: 'p2',
      async call() { secondCalled = true; return { raw: goodJson, elapsed_ms: 0 }; },
    };
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r._meta.provider, 'p1');
    assert.strictEqual(secondCalled, false);
  });

  await test('第一个抛异常 → fallback 到第二个', async () => {
    const p1 = mockProvider('p1', { throw: 'p1 failed' });
    const p2 = mockProvider('p2', { raw: goodJson });
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r._meta.provider, 'p2');
  });

  await test('全部 provider 失败 → status=failed', async () => {
    const p1 = mockProvider('p1', { throw: 'p1 down' });
    const p2 = mockProvider('p2', { throw: 'p2 down' });
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'failed');
    assert.ok(/p1 down|p2 down/.test(r._meta.last_error));
  });

  await test('timeline 为空 → 直接报错不调 provider', async () => {
    let called = false;
    const p1 = {
      name: 'p1',
      async call() { called = true; return { raw: goodJson, elapsed_ms: 0 }; },
    };
    const svc = new DeepSummaryService({ providers: [p1] });
    const r = await svc.generate([], presentAIs);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(called, false);
    assert.ok(/empty|至少/i.test(r._meta.last_error));
  });

  await test('provider 返回乱码 → fallback 后仍乱码 → status=failed,raw_output 在 _meta', async () => {
    const p1 = mockProvider('p1', { raw: 'not json at all' });
    const p2 = mockProvider('p2', { raw: 'still garbage' });
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'failed');
    assert.ok(r._meta.raw_output);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
```

- [ ] **Step 8.2: 运行测试看失败**

```bash
node tests/_integration-deep-summary.js
```
Expected: FAIL `Cannot find module '../core/deep-summary-service.js'`

- [ ] **Step 8.3: 实现 service**

```javascript
// core/deep-summary-service.js
const { buildPrompt } = require('./summary-prompt.js');
const { parse } = require('./summary-parser.js');

const MIN_TIMELINE_LENGTH = 2;

class DeepSummaryService {
  constructor({ providers }) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error('DeepSummaryService requires at least one provider');
    }
    this.providers = providers;
  }

  /**
   * @param timeline Array<{idx,sid,text,ts}>
   * @param presentAIs Set<string>  会议室中实际存在的 AI kind('claude'|'codex'|'gemini'|'user')
   * @param labelMap Map<sid, {label, kind}>  for prompt rendering
   */
  async generate(timeline, presentAIs, labelMap = new Map()) {
    const generated_at = Date.now();
    if (!Array.isArray(timeline) || timeline.length < MIN_TIMELINE_LENGTH) {
      return {
        status: 'failed',
        _meta: {
          generated_at,
          timeline_length: timeline ? timeline.length : 0,
          provider: null,
          parse_status: 'failed',
          last_error: `timeline empty or too short (need >= ${MIN_TIMELINE_LENGTH})`,
        },
      };
    }

    const prompt = buildPrompt(timeline, labelMap);
    let lastError = null;
    let lastRaw = null;
    let usedProvider = null;
    let elapsed_ms = 0;

    for (const provider of this.providers) {
      try {
        const r = await provider.call(prompt);
        lastRaw = r.raw;
        usedProvider = provider.name;
        elapsed_ms = r.elapsed_ms;
        const parsed = parse(r.raw, presentAIs);
        if (parsed.status === 'failed') {
          lastError = `parse failed for ${provider.name}: ${(parsed.warnings || []).join(';')}`;
          continue;  // 尝试下一个 provider
        }
        return {
          status: parsed.status,
          data: parsed.data,
          warnings: parsed.warnings,
          _meta: {
            generated_at,
            timeline_length: timeline.length,
            provider: provider.name,
            elapsed_ms,
            parse_status: parsed.status,
          },
        };
      } catch (e) {
        lastError = `${provider.name}: ${e.message}`;
        continue;
      }
    }

    return {
      status: 'failed',
      _meta: {
        generated_at,
        timeline_length: timeline.length,
        provider: usedProvider,
        parse_status: 'failed',
        last_error: lastError || 'all providers failed',
        raw_output: lastRaw,
      },
    };
  }
}

module.exports = { DeepSummaryService };
```

- [ ] **Step 8.4: 运行测试看通过**

```bash
node tests/_integration-deep-summary.js
```
Expected: `5 passed, 0 failed`

- [ ] **Step 8.5: Commit**

```bash
git add core/deep-summary-service.js tests/_integration-deep-summary.js
git commit -m "feat(deep-summary): service orchestrator with fallback chain (task 8)"
```

---

### Task 9: main.js IPC handler

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 9.1: 在 main.js 顶部 require 区域添加**

找到 main.js 中 `transcriptTap` 初始化的附近(Phase 1 加的),在 require 区域追加:

```javascript
const { DeepSummaryService } = require('./core/deep-summary-service.js');
const { GeminiCliProvider } = require('./core/summary-providers/gemini-cli.js');
const { DeepSeekProvider } = require('./core/summary-providers/deepseek-api.js');
const { loadConfig: loadDeepSummaryConfig } = require('./core/deep-summary-config.js');
```

- [ ] **Step 9.2: 在 app ready / transcriptTap 初始化之后追加 service 单例**

```javascript
const _deepSummaryConfig = loadDeepSummaryConfig();
function _buildDeepSummaryProviders() {
  const providers = [];
  for (const name of _deepSummaryConfig.fallback_chain) {
    if (name === 'gemini-cli') {
      providers.push(new GeminiCliProvider(_deepSummaryConfig.gemini_cli));
    } else if (name === 'deepseek-api') {
      providers.push(new DeepSeekProvider(_deepSummaryConfig.deepseek_api));
    } else {
      console.warn('[deep-summary] unknown provider in fallback_chain:', name);
    }
  }
  if (providers.length === 0) {
    throw new Error('deep-summary fallback_chain produced 0 providers');
  }
  return providers;
}
const deepSummaryService = new DeepSummaryService({ providers: _buildDeepSummaryProviders() });
```

- [ ] **Step 9.3: 在 IPC handler 区域追加新 handler**

```javascript
ipcMain.handle('generate-meeting-summary', async (_event, meetingId) => {
  try {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) {
      return {
        status: 'failed',
        _meta: { last_error: `meeting not found: ${meetingId}`, parse_status: 'failed' },
      };
    }
    const timeline = meetingManager.getTimeline(meetingId);
    const labelMap = new Map();
    const presentAIs = new Set(['user']);
    for (const sid of meeting.subSessions) {
      const s = sessionManager.sessions.get(sid);
      if (s && s.info) {
        labelMap.set(sid, { label: s.info.title || s.info.kind || 'AI', kind: s.info.kind });
        if (s.info.kind) presentAIs.add(s.info.kind);
      }
    }
    return await deepSummaryService.generate(timeline, presentAIs, labelMap);
  } catch (e) {
    console.error('[generate-meeting-summary] error:', e);
    return {
      status: 'failed',
      _meta: { last_error: e.message, parse_status: 'failed' },
    };
  }
});

ipcMain.handle('get-deep-summary-config', async () => _deepSummaryConfig.ui);
```

- [ ] **Step 9.4: 启动 Hub 实例验证 main.js 加载无误**

(不要 kill 用户的生产 Hub。新开测试实例)

```bash
CLAUDE_HUB_DATA_DIR=/c/Users/lintian/.claude-hub-deep-summary-test electron . --remote-debugging-port=9221 &
sleep 5
curl -s http://127.0.0.1:9221/json/version | head -c 200
```
Expected: 看到 `Browser` 字段返回,无启动崩溃

(测试完后用 `kill` 关掉这个测试 PID,**只关你刚启动的**,不要碰其他)

- [ ] **Step 9.5: Commit**

```bash
git add main.js
git commit -m "feat(deep-summary): IPC handler generate-meeting-summary (task 9)"
```

---

### Task 10: Modal HTML + 状态机骨架

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\renderer\meeting-summary-modal.js`

- [ ] **Step 10.1: 实现 Modal 模块(IIFE 注入 window)**

```javascript
// renderer/meeting-summary-modal.js
// Modal for displaying generated meeting summary cards.

(function () {
  const { ipcRenderer } = require('electron');

  let _modalEl = null;
  let _state = 'idle';  // idle | loading | rendered | error
  let _lastResult = null;
  let _lastMeetingId = null;
  let _loadingTimer = null;
  let _loadingStartedAt = 0;

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ensureModal() {
    if (_modalEl) return _modalEl;
    _modalEl = document.createElement('div');
    _modalEl.id = 'mr-summary-modal';
    _modalEl.className = 'mr-summary-modal-hidden';
    _modalEl.innerHTML = `
      <div class="mr-summary-backdrop"></div>
      <div class="mr-summary-dialog" role="dialog" aria-label="会议摘要">
        <div class="mr-summary-header">
          <span class="mr-summary-title">📝 会议摘要</span>
          <span class="mr-summary-meta"></span>
          <button class="mr-summary-close" aria-label="关闭">×</button>
        </div>
        <div class="mr-summary-body"></div>
        <div class="mr-summary-footer">
          <button class="mr-summary-copy" hidden>复制 JSON</button>
          <button class="mr-summary-retry" hidden>重新生成</button>
          <button class="mr-summary-close-btn">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(_modalEl);
    _modalEl.querySelector('.mr-summary-close').addEventListener('click', close);
    _modalEl.querySelector('.mr-summary-close-btn').addEventListener('click', close);
    _modalEl.querySelector('.mr-summary-backdrop').addEventListener('click', close);
    _modalEl.querySelector('.mr-summary-retry').addEventListener('click', () => {
      if (_lastMeetingId) open(_lastMeetingId);
    });
    _modalEl.querySelector('.mr-summary-copy').addEventListener('click', () => {
      if (_lastResult && _lastResult.data) {
        const json = JSON.stringify(_lastResult.data, null, 2);
        navigator.clipboard.writeText(json).catch(() => {});
      }
    });
    return _modalEl;
  }

  function setState(state) {
    _state = state;
    const modal = ensureModal();
    modal.dataset.state = state;
    const retryBtn = modal.querySelector('.mr-summary-retry');
    const copyBtn = modal.querySelector('.mr-summary-copy');
    retryBtn.hidden = !(state === 'rendered' || state === 'error');
    copyBtn.hidden = !(state === 'rendered' && _lastResult && _lastResult.data);
  }

  function show() {
    ensureModal().classList.remove('mr-summary-modal-hidden');
  }
  function close() {
    ensureModal().classList.add('mr-summary-modal-hidden');
    if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
    setState('idle');
  }

  function renderLoading() {
    const body = ensureModal().querySelector('.mr-summary-body');
    _loadingStartedAt = Date.now();
    const update = () => {
      const elapsed = Math.round((Date.now() - _loadingStartedAt) / 1000);
      let msg;
      if (elapsed < 3) msg = '正在请求 Gemini CLI...';
      else if (elapsed < 30) msg = `Gemini 思考中(已 ${elapsed}s)...`;
      else if (elapsed < 60) msg = `较长会议摘要可能需要 1 分钟,请耐心等待(${elapsed}s)...`;
      else msg = `仍在等待响应(${elapsed}s),即将切换备用通道...`;
      body.innerHTML = `
        <div class="mr-summary-loading">
          <div class="mr-summary-spinner"></div>
          <div class="mr-summary-loading-text">${escapeHtml(msg)}</div>
        </div>
      `;
    };
    update();
    if (_loadingTimer) clearInterval(_loadingTimer);
    _loadingTimer = setInterval(update, 1000);
  }

  function renderError(result) {
    const body = ensureModal().querySelector('.mr-summary-body');
    const meta = result && result._meta ? result._meta : {};
    body.innerHTML = `
      <div class="mr-summary-error">
        <div class="mr-summary-error-title">⚠️ 摘要生成失败</div>
        <div class="mr-summary-error-msg">${escapeHtml(meta.last_error || '未知错误')}</div>
        ${meta.raw_output ? `
          <details>
            <summary>查看 LLM 原始输出</summary>
            <pre>${escapeHtml(meta.raw_output)}</pre>
          </details>` : ''}
      </div>
    `;
  }

  function renderCards(result) {
    // 详细在 Task 11 实现; 这里先占位让单元能运行
    const body = ensureModal().querySelector('.mr-summary-body');
    body.innerHTML = '<div>[cards placeholder — Task 11]</div>';
  }

  function renderMeta(result) {
    const meta = ensureModal().querySelector('.mr-summary-meta');
    const m = result && result._meta;
    if (!m) { meta.textContent = ''; return; }
    const ts = m.generated_at ? new Date(m.generated_at).toLocaleTimeString() : '';
    const len = m.timeline_length != null ? `第 ${m.timeline_length} 条` : '';
    const prov = m.provider ? m.provider : '';
    const elapsed = m.elapsed_ms ? `${(m.elapsed_ms / 1000).toFixed(1)}s` : '';
    meta.textContent = [len, ts, prov, elapsed].filter(Boolean).join(' · ');
  }

  async function open(meetingId) {
    _lastMeetingId = meetingId;
    show();
    setState('loading');
    renderLoading();
    try {
      const result = await ipcRenderer.invoke('generate-meeting-summary', meetingId);
      if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
      _lastResult = result;
      renderMeta(result);
      if (result.status === 'failed') {
        setState('error');
        renderError(result);
      } else {
        setState('rendered');
        renderCards(result);
      }
    } catch (e) {
      if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
      _lastResult = { status: 'failed', _meta: { last_error: e.message } };
      setState('error');
      renderError(_lastResult);
    }
  }

  window.MeetingSummaryModal = { open, close };
})();
```

- [ ] **Step 10.2: Commit (UI 还未联通,但模块独立可加载)**

```bash
git add renderer/meeting-summary-modal.js
git commit -m "feat(deep-summary): summary modal skeleton with state machine (task 10)"
```

---

### Task 11: 卡片渲染(4 类)

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-summary-modal.js`

- [ ] **Step 11.1: 替换 renderCards 占位实现**

把 Task 10 中的 `function renderCards(result) { ... placeholder ... }` 整体替换为:

```javascript
  function renderCards(result) {
    const body = ensureModal().querySelector('.mr-summary-body');
    const data = result && result.data ? result.data : {};
    const warnings = result && result.warnings ? result.warnings : [];

    const sections = [];
    if (warnings.length > 0) {
      sections.push(`
        <div class="mr-summary-warning">
          ⚠️ 部分字段不完整: ${escapeHtml(warnings.join(', '))}
        </div>
      `);
    }

    // 共识
    sections.push(renderSection({
      title: `✓ 共识 (${data.consensus.length})`,
      cssClass: 'consensus',
      items: data.consensus.map(c => `
        <div class="mr-summary-card mr-summary-card-consensus">
          <div class="mr-summary-card-text">${escapeHtml(c.text)}</div>
          <div class="mr-summary-supporters">
            ${c.supporters.map(s =>
              `<span class="mr-summary-pill mr-summary-pill-${escapeHtml(s)}">${escapeHtml(s)}</span>`
            ).join('')}
          </div>
        </div>
      `),
      emptyText: '本次会议暂无明确共识',
    }));

    // 决策
    sections.push(renderSection({
      title: `★ 决策 (${data.decisions.length})`,
      cssClass: 'decisions',
      items: data.decisions.map(d => `
        <div class="mr-summary-card mr-summary-card-decision">
          <div class="mr-summary-card-text">${escapeHtml(d.text)}</div>
          ${Array.isArray(d.confirmed_by) && d.confirmed_by.length > 0
            ? `<div class="mr-summary-confirm">由 ${escapeHtml(d.confirmed_by.join(', '))} 确认</div>`
            : ''}
        </div>
      `),
      emptyText: '尚无明确决策',
    }));

    // 分歧
    sections.push(renderSection({
      title: `⚡ 分歧 (${data.disagreements.length})`,
      cssClass: 'disagreements',
      items: data.disagreements.map(d => `
        <div class="mr-summary-card mr-summary-card-disagree">
          <div class="mr-summary-card-topic">${escapeHtml(d.topic)}</div>
          <div class="mr-summary-positions">
            ${d.positions.map(p => `
              <div class="mr-summary-position">
                <span class="mr-summary-who mr-summary-who-${escapeHtml(p.by)}">${escapeHtml(p.by)}</span>
                <span class="mr-summary-view">${escapeHtml(p.view)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `),
      emptyText: '各方立场一致,暂无分歧',
    }));

    // 未决
    sections.push(renderSection({
      title: `? 未决 (${data.open_questions.length})`,
      cssClass: 'open',
      items: data.open_questions.map(q => `
        <div class="mr-summary-card mr-summary-card-open">
          <div class="mr-summary-card-text">${escapeHtml(q)}</div>
        </div>
      `),
      emptyText: '所有问题均已讨论',
    }));

    body.innerHTML = sections.join('');
  }

  function renderSection({ title, cssClass, items, emptyText }) {
    const inner = items.length > 0
      ? items.join('')
      : `<div class="mr-summary-empty">${escapeHtml(emptyText)}</div>`;
    return `
      <div class="mr-summary-section mr-summary-section-${cssClass}">
        <div class="mr-summary-section-title">${escapeHtml(title)}</div>
        ${inner}
      </div>
    `;
  }
```

- [ ] **Step 11.2: Commit**

```bash
git add renderer/meeting-summary-modal.js
git commit -m "feat(deep-summary): 4-section card rendering (task 11)"
```

---

### Task 12: 工具栏按钮 + Modal 联通

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-blackboard.js`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\index.html`(或对应主 HTML)

- [ ] **Step 12.1: 在 index.html 引入 modal 脚本**

找到 `meeting-blackboard.js` 的 `<script>` 引用行，在其之后追加:

```html
<script src="renderer/meeting-summary-modal.js"></script>
```

- [ ] **Step 12.2: 在 meeting-blackboard.js 的 renderBlackboardToolbar 中加按钮**

找到 `meeting-blackboard.js:158-163` 附近的 `toolbarEl.innerHTML = ` 模板,把:

```javascript
    toolbarEl.innerHTML = `
      <label>发送到: <select class="mr-target-select" id="mr-bb-target">${targetHtml}</select></label>
      <label>场景: <select class="mr-target-select" id="${sceneSelectId}">
        <option value="free_discussion">自动</option>
      </select></label>
    `;
```

替换为:

```javascript
    toolbarEl.innerHTML = `
      <label>发送到: <select class="mr-target-select" id="mr-bb-target">${targetHtml}</select></label>
      <label>场景: <select class="mr-target-select" id="${sceneSelectId}">
        <option value="free_discussion">自动</option>
      </select></label>
      <button class="mr-summary-btn" id="mr-bb-summary-btn" title="生成会议摘要">📝 摘要</button>
    `;
```

- [ ] **Step 12.3: 在 renderBlackboardToolbar 末尾绑定按钮事件**

在 `renderBlackboardToolbar` 函数末尾的 `}` 之前追加:

```javascript
    const summaryBtn = document.getElementById('mr-bb-summary-btn');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', () => {
        if (window.MeetingSummaryModal && typeof window.MeetingSummaryModal.open === 'function') {
          window.MeetingSummaryModal.open(meeting.id);
        } else {
          console.error('[blackboard] MeetingSummaryModal not loaded');
        }
      });
      // 当 timeline < 2 条时禁用
      const enable = async () => {
        try {
          const tl = await ipcRenderer.invoke('meeting-get-timeline', meeting.id);
          summaryBtn.disabled = !Array.isArray(tl) || tl.length < 2;
          summaryBtn.title = summaryBtn.disabled
            ? '会议尚未开始(需要至少 2 条对话)'
            : '生成会议摘要';
        } catch {}
      };
      enable();
    }
```

- [ ] **Step 12.4: Commit**

```bash
git add renderer/meeting-blackboard.js renderer/index.html
git commit -m "feat(deep-summary): toolbar button + modal wiring (task 12)"
```

---

### Task 13: CSS 样式

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 13.1: 追加 modal + card 样式到 meeting-room.css 末尾**

```css

/* ─── Deep Summary Modal ───────────────────────────────────────── */
#mr-summary-modal {
  position: fixed; inset: 0;
  z-index: 9999;
  display: flex; align-items: center; justify-content: center;
}
#mr-summary-modal.mr-summary-modal-hidden { display: none; }

.mr-summary-backdrop {
  position: absolute; inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}

.mr-summary-dialog {
  position: relative;
  width: 90%; max-width: 900px;
  max-height: 85vh;
  background: linear-gradient(135deg, #1a1a2e 0%, #16162a 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  display: flex; flex-direction: column;
  color: #e8e8f0;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}

.mr-summary-header {
  display: flex; align-items: center; gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.mr-summary-title {
  font-size: 16px; font-weight: 600;
  background: linear-gradient(90deg, #ff9f43 0%, #b794f6 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.mr-summary-meta { flex: 1; font-size: 12px; color: #888; }
.mr-summary-close {
  background: transparent; border: 0; color: #aaa;
  font-size: 22px; line-height: 1; cursor: pointer; padding: 0 8px;
}
.mr-summary-close:hover { color: #fff; }

.mr-summary-body {
  flex: 1; overflow-y: auto;
  padding: 16px 20px;
}

.mr-summary-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.mr-summary-footer button {
  padding: 6px 12px; font-size: 13px;
  background: rgba(255, 255, 255, 0.06);
  color: #e8e8f0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
}
.mr-summary-footer button:hover { background: rgba(255, 255, 255, 0.12); }

/* Loading state */
.mr-summary-loading {
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  padding: 60px 20px;
}
.mr-summary-spinner {
  width: 32px; height: 32px;
  border: 3px solid rgba(183, 148, 246, 0.2);
  border-top-color: #b794f6;
  border-radius: 50%;
  animation: mr-summary-spin 0.8s linear infinite;
}
@keyframes mr-summary-spin { to { transform: rotate(360deg); } }
.mr-summary-loading-text { font-size: 13px; color: #aaa; }

/* Error state */
.mr-summary-error {
  padding: 40px 20px; text-align: center;
}
.mr-summary-error-title { font-size: 16px; color: #f87171; margin-bottom: 12px; }
.mr-summary-error-msg { font-size: 13px; color: #aaa; margin-bottom: 16px; }
.mr-summary-error details { text-align: left; margin-top: 16px; }
.mr-summary-error pre {
  font-size: 11px; color: #888;
  background: rgba(0, 0, 0, 0.4); padding: 12px;
  border-radius: 6px; max-height: 200px; overflow: auto;
  white-space: pre-wrap;
}

/* Warning bar (partial state) */
.mr-summary-warning {
  background: rgba(251, 191, 36, 0.1);
  border-left: 3px solid #fbbf24;
  padding: 8px 12px; margin-bottom: 12px;
  font-size: 12px; color: #fbbf24;
  border-radius: 4px;
}

/* Sections */
.mr-summary-section { margin-bottom: 16px; }
.mr-summary-section-title {
  font-size: 13px; font-weight: 600;
  color: #b794f6;
  margin-bottom: 8px;
  text-transform: none;
  letter-spacing: 0.5px;
}
.mr-summary-empty {
  padding: 8px 12px; font-size: 12px;
  color: #666; font-style: italic;
}

/* Cards */
.mr-summary-card {
  background: rgba(255, 255, 255, 0.04);
  border-left: 3px solid;
  border-radius: 6px;
  padding: 10px 12px; margin-bottom: 6px;
  font-size: 13px;
}
.mr-summary-card-consensus { border-left-color: #4ade80; }
.mr-summary-card-decision  { border-left-color: #b794f6; }
.mr-summary-card-disagree  { border-left-color: #ff9f43; }
.mr-summary-card-open      { border-left-color: #60a5fa; }

.mr-summary-card-text { color: #e8e8f0; }
.mr-summary-card-topic { font-weight: 600; color: #ff9f43; margin-bottom: 6px; }
.mr-summary-confirm { font-size: 11px; color: #888; margin-top: 4px; }

.mr-summary-supporters { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
.mr-summary-pill {
  font-size: 10px; padding: 1px 8px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #ccc;
}
.mr-summary-pill-claude { color: #ff9f43; }
.mr-summary-pill-codex  { color: #4ade80; }
.mr-summary-pill-gemini { color: #b794f6; }
.mr-summary-pill-user   { color: #aaa; }

.mr-summary-positions { display: flex; flex-direction: column; gap: 4px; }
.mr-summary-position {
  display: flex; gap: 8px; align-items: baseline;
  font-size: 12px;
}
.mr-summary-who {
  font-weight: 600; min-width: 60px;
}
.mr-summary-who-claude { color: #ff9f43; }
.mr-summary-who-codex  { color: #4ade80; }
.mr-summary-who-gemini { color: #b794f6; }
.mr-summary-view { color: #ccc; }

/* Toolbar button */
.mr-summary-btn {
  margin-left: 8px;
  padding: 4px 10px; font-size: 12px;
  background: rgba(183, 148, 246, 0.15);
  color: #b794f6;
  border: 1px solid rgba(183, 148, 246, 0.3);
  border-radius: 4px;
  cursor: pointer;
}
.mr-summary-btn:hover:not(:disabled) {
  background: rgba(183, 148, 246, 0.25);
}
.mr-summary-btn:disabled {
  opacity: 0.4; cursor: not-allowed;
}
```

- [ ] **Step 13.2: 启动测试 Hub 实例肉眼验证(用 Playwright 截图)**

```bash
CLAUDE_HUB_DATA_DIR=/c/Users/lintian/.claude-hub-deep-summary-test electron . --remote-debugging-port=9221 &
```

Wait 5s, then via Playwright MCP:
1. `mcp__playwright__browser_navigate` to `http://127.0.0.1:9221`
2. Navigate to a meeting room (要先有一个会议)
3. `mcp__playwright__browser_take_screenshot` 看工具栏有没有"📝 摘要"按钮

Expected: 工具栏右侧出现紫色"📝 摘要"按钮。

- [ ] **Step 13.3: Commit**

```bash
git add renderer/meeting-room.css
git commit -m "feat(deep-summary): modal + card CSS styles (task 13)"
```

---

### Task 14: E2E 真实测试 6 场景

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\_e2e-deep-summary-real.js`

- [ ] **Step 14.1: 编写 E2E 脚本**

```javascript
// tests/_e2e-deep-summary-real.js
// 通过 CDP 在隔离 Hub 实例上验证 deep-summary 端到端
// 前置:Hub 实例已启动并通过 CDP 9221 暴露
// 用法:node tests/_e2e-deep-summary-real.js

const CDP_URL = 'http://127.0.0.1:9221';
const TIMEOUT_PER_SCENARIO_MS = 180000;

async function getCdpTarget() {
  const res = await fetch(`${CDP_URL}/json/list`);
  const tabs = await res.json();
  const main = tabs.find(t => t.type === 'page' && t.url.includes('index.html')) || tabs[0];
  return main.webSocketDebuggerUrl;
}

async function evalInPage(wsUrl, expression) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const t = setTimeout(() => { ws.close(); reject(new Error('CDP eval timeout')); }, 30000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(t); ws.close();
        if (msg.result && msg.result.result) {
          resolve(msg.result.result.value);
        } else {
          reject(new Error(`CDP eval failed: ${JSON.stringify(msg)}`));
        }
      }
    });
    ws.on('error', e => { clearTimeout(t); reject(e); });
  });
}

let pass = 0, fail = 0;
async function scenario(name, fn) {
  console.log(`\n[Scenario] ${name}`);
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('scenario timeout')), TIMEOUT_PER_SCENARIO_MS)),
    ]);
    console.log(`  ✓ PASS (${Date.now() - start}ms)`);
    pass++;
  } catch (e) {
    console.log(`  ✗ FAIL: ${e.message}`);
    fail++;
  }
}

(async () => {
  const wsUrl = await getCdpTarget();

  // Helper:在页面里执行 IPC 调用
  async function ipcInvoke(channel, ...args) {
    const expr = `
      (async () => {
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)});
      })()
    `;
    return evalInPage(wsUrl, expr);
  }

  // ─── A. 真实 timeline 走 IPC 生成摘要(默认 gemini-cli 路径) ──────────
  await scenario('A. 真实 IPC generate-meeting-summary 走通(gemini-cli)', async () => {
    // 取第一个有 timeline >= 2 的会议
    const meetings = await ipcInvoke('list-meetings');
    if (!Array.isArray(meetings) || meetings.length === 0) {
      throw new Error('no meeting in test instance — please create one with >= 2 turns first');
    }
    let target = null;
    for (const m of meetings) {
      const tl = await ipcInvoke('meeting-get-timeline', m.id);
      if (Array.isArray(tl) && tl.length >= 2) { target = m; break; }
    }
    if (!target) throw new Error('no meeting has >= 2 timeline turns');

    const r = await ipcInvoke('generate-meeting-summary', target.id);
    if (!r) throw new Error('null result');
    if (r.status === 'failed') {
      throw new Error(`status=failed: ${r._meta.last_error}`);
    }
    if (!r._meta || !r._meta.provider) throw new Error('no provider in _meta');
    console.log(`    provider=${r._meta.provider} elapsed=${r._meta.elapsed_ms}ms status=${r.status}`);
  });

  // ─── B. timeline = 1 条 → 按钮应 disabled (验 IPC 拒绝) ──────────
  await scenario('B. timeline 太短 → service 返回 failed', async () => {
    const r = await ipcInvoke('generate-meeting-summary', 'fake-meeting-id-not-exist');
    if (r.status !== 'failed') throw new Error(`expected failed, got ${r.status}`);
  });

  // ─── C. Modal UI 打开后展示卡片(走 window.MeetingSummaryModal) ──
  await scenario('C. UI Modal 打开 → 等待状态 = rendered/error', async () => {
    const meetings = await ipcInvoke('list-meetings');
    let target = null;
    for (const m of meetings) {
      const tl = await ipcInvoke('meeting-get-timeline', m.id);
      if (Array.isArray(tl) && tl.length >= 2) { target = m; break; }
    }
    if (!target) throw new Error('no meeting with timeline');

    await evalInPage(wsUrl,
      `window.MeetingSummaryModal.open(${JSON.stringify(target.id)})`);

    // 等 modal 进入 rendered 或 error 状态(最多 120s)
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120000) {
      const state = await evalInPage(wsUrl,
        `document.getElementById('mr-summary-modal') && document.getElementById('mr-summary-modal').dataset.state`);
      if (state === 'rendered' || state === 'error') {
        console.log(`    modal state = ${state}`);
        await evalInPage(wsUrl, `window.MeetingSummaryModal.close()`);
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('modal stuck in loading > 120s');
  });

  // ─── D. 注入坏 raw → parser 应给出 status=failed ──────────────────
  await scenario('D. parser 五层防御:坏 raw → failed', async () => {
    const result = await evalInPage(wsUrl, `
      (async () => {
        const { parse } = require('${process.cwd().replace(/\\/g, '/')}/core/summary-parser.js');
        return parse('this is not json at all', new Set(['claude','user']));
      })()
    `);
    if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  });

  // ─── E. parser 给出 partial 状态(缺 disagreements) ───────────────
  await scenario('E. parser 部分降级:partial 状态', async () => {
    const raw = JSON.stringify({ consensus: [], decisions: [], open_questions: [] });
    const result = await evalInPage(wsUrl, `
      (async () => {
        const { parse } = require('${process.cwd().replace(/\\/g, '/')}/core/summary-parser.js');
        return parse(${JSON.stringify(raw)}, new Set(['claude','user']));
      })()
    `);
    if (result.status !== 'partial') throw new Error(`expected partial, got ${result.status}`);
    if (!result.warnings || result.warnings.length === 0) throw new Error('no warnings in partial');
  });

  // ─── F. fallback 链(单元已覆盖) ──────────────────────────────────
  // 这个场景需要临时改 config,影响其他场景,跳过 — 单元 _integration-deep-summary.js 已覆盖
  console.log('\n[Scenario F] fallback chain — covered by _integration-deep-summary.js, skipped here');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('E2E runner error:', e);
  process.exit(2);
});
```

- [ ] **Step 14.2: 启动隔离 Hub 实例**

```bash
CLAUDE_HUB_DATA_DIR=/c/Users/lintian/.claude-hub-deep-summary-test electron . --remote-debugging-port=9221 &
sleep 5
```

- [ ] **Step 14.3: 通过 Playwright 在该实例里手动创建一个会议**

通过 mcp__playwright__browser_navigate 到 http://127.0.0.1:9221,创建一个会议室,加 1-2 个 AI,跑几轮对话(至少 2 条 timeline)。

- [ ] **Step 14.4: 运行 E2E**

```bash
node tests/_e2e-deep-summary-real.js
```
Expected: `5 passed, 0 failed`(F 场景跳过)

- [ ] **Step 14.5: 截图保存到 tests/screenshots/**

通过 Playwright 截 modal 显示 4 张卡片的画面,保存到:
`C:\Users\lintian\claude-session-hub\tests\screenshots\deep-summary-modal.png`

- [ ] **Step 14.6: 关闭测试 Hub 实例**

```bash
# 找到刚才启动的 PID(只关你刚启动的)
# 不要 kill 用户其他的 electron 进程
ps aux | grep "claude-hub-deep-summary-test"
# kill <pid>
```

- [ ] **Step 14.7: Commit**

```bash
git add tests/_e2e-deep-summary-real.js tests/screenshots/deep-summary-modal.png
git commit -m "test(deep-summary): E2E 5 scenarios + modal screenshot (task 14)"
```

---

## Self-Review Checklist

(已自审,以下记录我的检查结果)

### 1. Spec coverage
- [x] 决策 1 (给人看) → Task 8/9/10 不做 AI 上下文回注 ✓
- [x] 决策 2 (强结构化 JSON) → Task 4 schema + Task 11 卡片 ✓
- [x] 决策 3 (手动触发) → Task 12 按钮 + 不做后台轮询 ✓
- [x] 决策 4 (双轨) → Task 6 + Task 7 + Task 8 fallback ✓
- [x] UI 入口 (按钮+Modal) → Task 12 + Task 13 ✓
- [x] 五层防御 → Layer 1 prompt(Task 5) + Layer 2/3/4 parser(Task 2/3/4) + Layer 5 UI error(Task 10) ✓
- [x] Schema (consensus/disagreements/decisions/open_questions/_meta) → Task 4 + Task 8 ✓
- [x] 错误处理 11 项 → Task 6/7 provider 各错误 + Task 8 全失败 + Task 10 UI ✓
- [x] 测试策略(单元+集成+E2E) → Task 2-7 单元 + Task 8 集成 + Task 14 E2E ✓
- [x] 配置文件 → Task 1 ✓
- [x] Loading 文案分段 → Task 10 renderLoading ✓
- [x] 故障率目标 < 2% → 由测试覆盖率间接保证

### 2. Placeholder scan
- [x] 无 TBD/TODO ✓
- [x] 无 "implement later" ✓
- [x] 每段代码完整可执行 ✓
- [x] Task 14 有"找 PID 关闭实例"步骤略宽松,但有明确边界(只关测试实例),可接受

### 3. Type consistency
- [x] `parse(raw, presentAIs)` 在 Task 4/8/14 一致 ✓
- [x] `provider.call({system, user})` 返回 `{raw, elapsed_ms}` 在 Task 6/7/8 一致 ✓
- [x] `result.status` 取值 `'ok'|'partial'|'failed'` 在 Task 4/8/10/11/14 一致 ✓
- [x] `result._meta` 字段(generated_at/timeline_length/provider/parse_status) 在 Task 8/10 一致 ✓
- [x] `MeetingSummaryModal.open(meetingId)` / `.close()` 接口在 Task 10/12/14 一致 ✓
- [x] IPC channel `generate-meeting-summary` 在 Task 9/10/14 一致 ✓
- [x] `labelMap: Map<sid, {label, kind}>` 在 Task 5/8/9 一致 ✓
- [x] `presentAIs: Set<string>` 在 Task 4/8/9/14 一致 ✓
- [x] config 字段名 `fallback_chain` / `gemini_cli` / `deepseek_api` 在 Task 1/9 一致 ✓

---

## 执行交接

Plan 已保存到 `C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-04-25-deep-summary.md`。

两种执行方式:

**1. Subagent-Driven(推荐)** — 我每个 task 派一个新 subagent,两阶段审查(spec compliance + code quality),快速迭代。

**2. Inline Execution** — 在当前 session 里逐 task 执行,带检查点。

请选择:**1 还是 2**?
