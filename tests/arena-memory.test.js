// tests/arena-memory.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mem-'));

const store = require('../core/arena-memory/store');
const parser = require('../core/arena-memory/marker-parser');

(async () => {
  // T1.1: getMemoryDir returns <projectCwd>/.arena/memory
  const dir = store.getMemoryDir(TEMP_PROJECT);
  assert.strictEqual(dir, path.join(TEMP_PROJECT, '.arena', 'memory'));
  console.log('PASS T1.1 getMemoryDir resolves');

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

  console.log('---all tests passed---');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
