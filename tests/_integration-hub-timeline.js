'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { MeetingRoomManager } = require('../core/meeting-room.js');

// Mock the transcriptTap → meetingManager wiring (logic copied from main.js).
function wire(meetingManager, transcriptTap, sessionLookup, onTimelineUpdated) {
  transcriptTap.on('turn-complete', ({ hubSessionId, text, completedAt }) => {
    const session = sessionLookup(hubSessionId);
    if (!session || !session.meetingId) return;
    const turn = meetingManager.appendTurn(
      session.meetingId, hubSessionId, text,
      completedAt != null ? completedAt : Date.now()
    );
    if (turn) onTimelineUpdated({ meetingId: session.meetingId, turn });
  });
}

test('transcriptTap turn-complete → meeting timeline append + IPC notify', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');

  const sessions = new Map();
  sessions.set('sub-A', { id: 'sub-A', meetingId: meeting.id, kind: 'codex' });
  sessions.set('sub-orphan', { id: 'sub-orphan', meetingId: null });

  const tap = new EventEmitter();
  const events = [];
  wire(m, tap, sid => sessions.get(sid), ev => events.push(ev));

  tap.emit('turn-complete', { hubSessionId: 'sub-A', text: 'hello', completedAt: 1000 });
  tap.emit('turn-complete', { hubSessionId: 'sub-orphan', text: 'should be ignored', completedAt: 2000 });
  tap.emit('turn-complete', { hubSessionId: 'sub-unknown', text: 'also ignored', completedAt: 3000 });

  const tl = m.getTimeline(meeting.id);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].sid, 'sub-A');
  assert.equal(tl[0].text, 'hello');
  assert.equal(events.length, 1);
  assert.equal(events[0].meetingId, meeting.id);
  assert.equal(events[0].turn.idx, 0);
});

test('rapid duplicate turn-complete events deduped (within 2s)', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  m.addSubSession(meeting.id, 'sub-A');
  const sessions = new Map([['sub-A', { id: 'sub-A', meetingId: meeting.id }]]);
  const tap = new EventEmitter();
  const events = [];
  wire(m, tap, sid => sessions.get(sid), ev => events.push(ev));

  tap.emit('turn-complete', { hubSessionId: 'sub-A', text: 'R1', completedAt: 1000 });
  tap.emit('turn-complete', { hubSessionId: 'sub-A', text: 'R1', completedAt: 1500 }); // dup
  assert.equal(events.length, 1);
  assert.equal(m.getTimeline(meeting.id).length, 1);
});

test('user-turn IPC simulation appends + emits update', () => {
  const m = new MeetingRoomManager();
  const meeting = m.createMeeting();
  // Simulate IPC handler logic from main.js
  function simulateAppendUserTurn(meetingId, text) {
    const turn = m.appendTurn(meetingId, 'user', text, Date.now());
    return turn ? { meetingId, turn } : null;
  }
  const ev = simulateAppendUserTurn(meeting.id, 'Q1');
  assert.equal(ev.turn.sid, 'user');
  assert.equal(ev.turn.text, 'Q1');
  assert.equal(ev.turn.idx, 0);
  assert.equal(m.getTimeline(meeting.id).length, 1);
});
