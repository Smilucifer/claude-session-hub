const path = require('path');
const assert = require('assert');

const tapModule = require('../core/transcript-tap');

(async () => {
  // T5.1: extractCodexSidFromRolloutPath
  const fn = tapModule.extractCodexSidFromRolloutPath;
  assert.ok(typeof fn === 'function', 'extractCodexSidFromRolloutPath exported');

  const valid = fn('/foo/rollout-2026-04-25T00-39-46-019dc05c-9e35-7b73-a1c5-3a4cc9ad9c11.jsonl');
  assert.strictEqual(valid, '019dc05c-9e35-7b73-a1c5-3a4cc9ad9c11', 'extract valid sid');

  const tooShort = fn('/foo/rollout-x.jsonl');
  assert.strictEqual(tooShort, null, 'too short → null');

  const notUuid = fn('/foo/rollout-2026-04-25T00-39-46-XXXXXXXX-9e35-7b73-a1c5-3a4cc9ad9c11.jsonl');
  assert.strictEqual(notUuid, null, 'not uuid → null');

  console.log('PASS T5.1 extractCodexSidFromRolloutPath');

  // T6.1: extractGeminiChatIdFromSessionPath
  const gFn = tapModule.extractGeminiChatIdFromSessionPath;
  assert.ok(typeof gFn === 'function', 'extractGeminiChatIdFromSessionPath exported');

  assert.strictEqual(gFn('/x/y/session-2026-04-24T16-39-e6651237.jsonl'), 'e6651237');
  assert.strictEqual(gFn('/x/y/session-2026-04-24T16-39-e6651237.json'), 'e6651237');
  assert.strictEqual(gFn('/x/y/session-bad.jsonl'), null);
  assert.strictEqual(gFn('/x/y/notasession.jsonl'), null);
  console.log('PASS T6.1 extractGeminiChatIdFromSessionPath');

  // T6.2: extractGeminiProjectHashFromDir
  const pFn = tapModule.extractGeminiProjectHashFromDir;
  assert.ok(typeof pFn === 'function');
  assert.strictEqual(pFn('/home/u/.gemini/tmp/abc123def'), 'abc123def');
  assert.strictEqual(pFn(null), null);
  console.log('PASS T6.2 extractGeminiProjectHashFromDir');

  console.log('ALL transcript-tap-session-bound unit tests PASS');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
