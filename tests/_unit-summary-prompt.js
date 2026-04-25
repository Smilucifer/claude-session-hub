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
