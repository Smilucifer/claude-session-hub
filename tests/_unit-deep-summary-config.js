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
