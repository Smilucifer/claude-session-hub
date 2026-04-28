// tests/arena-memory.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mem-'));

const store = require('../core/arena-memory/store');
const parser = require('../core/arena-memory/marker-parser');
const injector = require('../core/arena-memory/injector');

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

  // T3.4: CRLF tolerance + content guards (post-review fix)
  const sample5 = '[fact] hookPort 默认 3456\r\n[lesson] PTY 注意 #pty\r\n';
  const m5 = parser.parseMarkers(sample5, 'gemini');
  assert.strictEqual(m5.length, 2, 'CRLF tolerated, both markers parsed');
  assert.strictEqual(m5[0].kind, 'fact');
  assert.strictEqual(m5[1].kind, 'lesson');
  assert.deepStrictEqual(m5[1].tags, ['pty'], 'tag stripped after CRLF');

  // colon-only rejected
  assert.deepStrictEqual(parser.parseMarkers('[lesson]:', 'gemini'), []);

  // all-tags-no-content rejected
  assert.deepStrictEqual(parser.parseMarkers('[fact] #aa #bb', 'gemini'), []);

  console.log('PASS T3.4 CRLF + content guards');

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

  // T4.2: injector.composeMemoryBlock returns '' for empty memory dir
  const EMPTY_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mem-empty-'));
  const blockEmpty = await injector.composeMemoryBlock({ projectCwd: EMPTY_PROJECT });
  assert.strictEqual(blockEmpty, '', 'empty when no facts.md');
  console.log('PASS T4.2 composeMemoryBlock returns empty string for empty dir');

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

  // T4.4: appendMemoryToPromptFile uses lastIndexOf so it doesn't swallow user content
  // containing literal sentinel strings (post-review fix for I-1)
  const promptWithLiteralSentinel = path.join(TEMP_PROJECT, '_test-prompt-literal.md');
  fs.writeFileSync(promptWithLiteralSentinel,
    '# Discussion\n\nIn a previous chat we discussed <!-- ARENA_MEMORY_BEGIN --> and how it works.\n\n' +
    'Some user content here.\n\n' +
    '<!-- ARENA_MEMORY_END --> end of discussion.\n\n' +
    'More user content.\n', 'utf-8');
  injector.appendMemoryToPromptFile(promptWithLiteralSentinel, block);
  const literalAfter = fs.readFileSync(promptWithLiteralSentinel, 'utf-8');
  // 关键：用户内容必须保留（"Some user content here." 和 "More user content." 不能被剥掉）
  assert.ok(literalAfter.includes('Some user content here.'),
    'user content between literal sentinels preserved (lastIndexOf prevents accidental swallowing)');
  assert.ok(literalAfter.includes('More user content.'),
    'user content after literal sentinels preserved');
  // 我们的注入区块在末尾
  assert.ok(literalAfter.endsWith(injector.SENTINEL_END + '\n'),
    'injection appended at file end');
  console.log('PASS T4.4 appendMemoryToPromptFile preserves user content with literal sentinels');

  console.log('---all tests passed---');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
