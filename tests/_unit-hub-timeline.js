'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MeetingRoomManager } = require('../core/meeting-room.js');

test('appendTurn pushes turn with monotonic idx + returns turn', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();

  const t0 = m.appendTurn(meeting.id, 'user', 'Q1', 1700000000000);
  assert.equal(t0.idx, 0);
  assert.equal(t0.sid, 'user');
  assert.equal(t0.text, 'Q1');
  assert.equal(t0.ts, 1700000000000);

  const t1 = m.appendTurn(meeting.id, 'sub-A', 'R1_A', 1700000005000);
  assert.equal(t1.idx, 1);
  assert.equal(t1.sid, 'sub-A');

  const t2 = m.appendTurn(meeting.id, 'sub-B', 'R1_B', 1700000007000);
  assert.equal(t2.idx, 2);
});

test('getTimeline returns full timeline copy', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.appendTurn(meeting.id, 'user', 'Q1', 1);
  m.appendTurn(meeting.id, 'sub-A', 'R1_A', 2);
  const tl = m.getTimeline(meeting.id);
  assert.equal(tl.length, 2);
  assert.equal(tl[0].text, 'Q1');
  assert.equal(tl[1].text, 'R1_A');
  // Mutating returned copy must not affect internal state
  tl.push({ idx: 99, sid: 'fake', text: 'no', ts: 0 });
  assert.equal(m.getTimeline(meeting.id).length, 2);
});

test('appendTurn returns null for unknown meeting', () => {
  const m = new MeetingRoomManager();
  assert.equal(m.appendTurn('nonexistent', 'user', 'Q', 0), null);
});

test('getTimeline returns empty array for unknown meeting (not null)', () => {
  const m = new MeetingRoomManager();
  assert.deepEqual(m.getTimeline('nonexistent'), []);
});

test('appendTurn caps single turn text at 100KB to prevent OOM', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  const huge = 'x'.repeat(150 * 1024);
  const t = m.appendTurn(meeting.id, 'sub-A', huge, 1);
  assert.equal(t.text.length, 100 * 1024 + '...[truncated]'.length);
  assert.ok(t.text.endsWith('...[truncated]'));
});

test('appendTurn dedupes same sid+text within 2s window', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  const t0 = m.appendTurn(meeting.id, 'sub-A', 'R1', 1700000000000);
  const t1 = m.appendTurn(meeting.id, 'sub-A', 'R1', 1700000001000); // 1s later, dup
  assert.notEqual(t0, null);
  assert.equal(t1, null); // deduped
  assert.equal(m.getTimeline(meeting.id).length, 1);

  // Different text — keep
  const t2 = m.appendTurn(meeting.id, 'sub-A', 'R2', 1700000001500);
  assert.notEqual(t2, null);
  assert.equal(m.getTimeline(meeting.id).length, 2);

  // Same text but >2s later — keep (could be legitimate retry)
  const t3 = m.appendTurn(meeting.id, 'sub-A', 'R1', 1700000010000);
  assert.notEqual(t3, null);
  assert.equal(m.getTimeline(meeting.id).length, 3);
});

test('getMeeting returns deep-copied _timeline + _cursors (no reference leak)', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.appendTurn(meeting.id, 'user', 'Q1', 1);

  const view = m.getMeeting(meeting.id);
  // Mutate the returned view; internal state must NOT change
  view._timeline.push({ idx: 999, sid: 'fake', text: 'no', ts: 0 });
  view._cursors.injected = 999;

  const fresh = m.getMeeting(meeting.id);
  assert.equal(fresh._timeline.length, 1, 'internal _timeline must not be polluted');
  assert.equal('injected' in fresh._cursors, false, 'internal _cursors must not be polluted');
});

test('getAllMeetings returns deep-copied _timeline + _cursors (no reference leak)', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.appendTurn(meeting.id, 'user', 'Q1', 1);

  const all = m.getAllMeetings();
  all[0]._timeline.push({ idx: 999, sid: 'fake', text: 'no', ts: 0 });
  all[0]._cursors.injected = 999;

  const fresh = m.getAllMeetings();
  assert.equal(fresh[0]._timeline.length, 1);
  assert.equal('injected' in fresh[0]._cursors, false);
});

test('appendTurn handles ts=0 (epoch) correctly, not substituted with Date.now()', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  const t = m.appendTurn(meeting.id, 'sub-A', 'R', 0);
  assert.equal(t.ts, 0, 'ts=0 must be preserved, not replaced by Date.now()');
});
