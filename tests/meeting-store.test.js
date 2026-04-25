// tests/meeting-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mstore-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const { saveMeetingFile, loadMeetingFile, markDirty, flushAll, listMeetingFiles, deleteMeetingFile } = require('../core/meeting-store');

(async () => {
  // T1.1: save + load round-trip
  const data = { id: 'm1', _timeline: [{ idx: 0, sid: 'user', text: 'hi', ts: 1 }], _cursors: { 'a': 0 }, _nextIdx: 1 };
  saveMeetingFile('m1', data);
  const loaded = loadMeetingFile('m1');
  assert.deepStrictEqual(loaded._timeline, data._timeline, 'timeline round-trip');
  assert.deepStrictEqual(loaded._cursors, data._cursors, 'cursors round-trip');
  assert.strictEqual(loaded._nextIdx, 1, 'nextIdx round-trip');
  assert.strictEqual(loaded.schemaVersion, 1, 'schemaVersion present');
  console.log('PASS T1.1 save+load round-trip');

  // T1.2: missing file returns null
  assert.strictEqual(loadMeetingFile('nonexistent'), null);
  console.log('PASS T1.2 missing file → null');

  // T1.3: list files
  saveMeetingFile('m2', { id: 'm2', _timeline: [], _cursors: {}, _nextIdx: 0 });
  const ids = listMeetingFiles().sort();
  assert.deepStrictEqual(ids, ['m1', 'm2']);
  console.log('PASS T1.3 list files');

  // T1.4: delete
  deleteMeetingFile('m1');
  assert.strictEqual(loadMeetingFile('m1'), null);
  console.log('PASS T1.4 delete');

  // T1.5: markDirty + flushAll
  markDirty('m2', { id: 'm2', _timeline: [{ idx: 0, sid: 'a', text: 'x', ts: 2 }], _cursors: {}, _nextIdx: 1 });
  await flushAll();
  const after = loadMeetingFile('m2');
  assert.strictEqual(after._timeline.length, 1, 'flushAll wrote pending dirty');
  console.log('PASS T1.5 markDirty + flushAll');

  console.log('ALL meeting-store tests PASS');
  // cleanup
  fs.rmSync(TEMP, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
