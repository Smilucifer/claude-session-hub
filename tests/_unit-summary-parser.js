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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
