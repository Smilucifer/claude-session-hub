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

  console.log('---all tests passed---');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
