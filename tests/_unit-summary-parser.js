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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
