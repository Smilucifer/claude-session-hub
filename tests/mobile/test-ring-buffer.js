const assert = require('assert');
const { SessionManager } = require('../../core/session-manager.js');

const sm = new SessionManager();

// Inject a fake session without spawning a real PTY
const id = 'test-sid';
sm.sessions.set(id, { info: { id, title: 'T' }, ringBuffer: '' });

// Simulate 10KB of data arriving (100 chunks x 100 bytes = 10000 bytes total)
for (let i = 0; i < 100; i++) {
  sm._appendToRingBuffer(id, 'x'.repeat(100));
}

const buf = sm.getSessionBuffer(id);
assert.ok(buf.length <= 8192, `buffer should be capped at 8KB, got ${buf.length}`);
assert.ok(buf.length >= 8000, `buffer should be near 8KB after 10KB input, got ${buf.length}`);
assert.ok(buf.endsWith('x'.repeat(100)), 'should retain most recent data');

// Verify getSessionBuffer returns null for unknown session
assert.strictEqual(sm.getSessionBuffer('no-such-id'), null, 'unknown session should return null');

// Verify ringBuffer is not exposed via listSessions / _toPublic
sm.sessions.get(id).info.id = id;
sm.sessions.get(id).info.title = 'T';
sm.sessions.get(id).info.kind = 'powershell';
sm.sessions.get(id).info.cwd = '/tmp';
sm.sessions.get(id).info.unreadCount = 0;
sm.sessions.get(id).info.lastMessageTime = Date.now();
sm.sessions.get(id).info.lastOutputPreview = '';
const pub = sm._toPublic(sm.sessions.get(id).info);
assert.ok(!('ringBuffer' in pub), 'ringBuffer must not appear in _toPublic output');

const list = sm.listSessions();
assert.ok(list.length === 1, 'listSessions should return 1 session');
assert.ok(!('ringBuffer' in list[0]), 'ringBuffer must not appear in listSessions output');

// 4. Surrogate pair integrity: emoji at the cut boundary shouldn't produce a lone surrogate
const RING_BUFFER_BYTES = 8192;
sm.sessions.set('surr-test', { info: {}, ringBuffer: '' });
// Fill to just under cap, then push an emoji (2 UTF-16 code units) that straddles
sm._appendToRingBuffer('surr-test', 'a'.repeat(RING_BUFFER_BYTES - 1));
sm._appendToRingBuffer('surr-test', '\uD83D\uDE00'); // U+1F600 GRINNING FACE (surrogate pair)
const buf2 = sm.getSessionBuffer('surr-test');
// Either the full emoji is present OR the buffer was trimmed — but NO lone low surrogate
const cc0 = buf2.charCodeAt(0);
assert.ok(!(cc0 >= 0xDC00 && cc0 <= 0xDFFF), 'must not start with a lone low surrogate');
// Also verify that if a lone high surrogate without a following low surrogate would be
// trimmed too (inject directly to test the guard)
sm.sessions.set('surr-test2', { info: {}, ringBuffer: '' });
// Manually set a buffer that starts with a lone high surrogate followed by regular text
sm.sessions.get('surr-test2').ringBuffer = '\uD83D' + 'hello'; // lone high surrogate
// Force truncation by appending enough to exceed cap
sm._appendToRingBuffer('surr-test2', 'x'.repeat(RING_BUFFER_BYTES));
const buf3 = sm.getSessionBuffer('surr-test2');
// The lone high surrogate should have been trimmed from the start
const cc3 = buf3.charCodeAt(0);
assert.ok(!(cc3 >= 0xD800 && cc3 <= 0xDBFF && !(buf3.charCodeAt(1) >= 0xDC00 && buf3.charCodeAt(1) <= 0xDFFF)),
  'must not start with a lone high surrogate');

console.log('OK test-ring-buffer');
