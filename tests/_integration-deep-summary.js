// tests/_integration-deep-summary.js
const assert = require('assert');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

(async () => {
  console.log('deep-summary-service integration:');

  const { DeepSummaryService } = require('../core/deep-summary-service.js');

  // Mock providers
  function mockProvider(name, behavior) {
    return {
      name,
      async call() {
        if (behavior.throw) throw new Error(behavior.throw);
        return { raw: behavior.raw, elapsed_ms: 10 };
      },
    };
  }

  const sampleTimeline = [
    { idx: 0, sid: 'user', text: 'hi', ts: 1000 },
    { idx: 1, sid: 'sid-c', text: 'hello', ts: 2000 },
  ];
  const presentAIs = new Set(['claude', 'user']);
  const goodJson = JSON.stringify({ consensus: [], disagreements: [], decisions: [], open_questions: [] });

  await test('第一个 provider 成功就不调第二个', async () => {
    let secondCalled = false;
    const p1 = mockProvider('p1', { raw: goodJson });
    const p2 = {
      name: 'p2',
      async call() { secondCalled = true; return { raw: goodJson, elapsed_ms: 0 }; },
    };
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r._meta.provider, 'p1');
    assert.strictEqual(secondCalled, false);
  });

  await test('第一个抛异常 → fallback 到第二个', async () => {
    const p1 = mockProvider('p1', { throw: 'p1 failed' });
    const p2 = mockProvider('p2', { raw: goodJson });
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r._meta.provider, 'p2');
  });

  await test('全部 provider 失败 → status=failed', async () => {
    const p1 = mockProvider('p1', { throw: 'p1 down' });
    const p2 = mockProvider('p2', { throw: 'p2 down' });
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'failed');
    assert.ok(/p1 down|p2 down/.test(r._meta.last_error));
  });

  await test('timeline 为空 → 直接报错不调 provider', async () => {
    let called = false;
    const p1 = {
      name: 'p1',
      async call() { called = true; return { raw: goodJson, elapsed_ms: 0 }; },
    };
    const svc = new DeepSummaryService({ providers: [p1] });
    const r = await svc.generate([], presentAIs);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(called, false);
    assert.ok(/empty|至少/i.test(r._meta.last_error));
  });

  await test('provider 返回乱码 → fallback 后仍乱码 → status=failed,raw_output 在 _meta', async () => {
    const p1 = mockProvider('p1', { raw: 'not json at all' });
    const p2 = mockProvider('p2', { raw: 'still garbage' });
    const svc = new DeepSummaryService({ providers: [p1, p2] });
    const r = await svc.generate(sampleTimeline, presentAIs);
    assert.strictEqual(r.status, 'failed');
    assert.ok(r._meta.raw_output);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
