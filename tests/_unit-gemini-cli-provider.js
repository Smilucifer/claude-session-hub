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
