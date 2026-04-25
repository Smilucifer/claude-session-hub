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
