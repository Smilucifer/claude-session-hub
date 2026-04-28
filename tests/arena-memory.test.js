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

  console.log('---all tests passed---');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
