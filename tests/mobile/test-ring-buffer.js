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

console.log('OK test-ring-buffer');
