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
