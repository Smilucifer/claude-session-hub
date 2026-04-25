const { v4: uuid } = require('uuid');

class MeetingRoomManager {
  constructor() {
    this.meetings = new Map();
    this._counter = 0;
  }

  createMeeting() {
    const id = uuid();
    const meeting = {
      id,
      type: 'meeting',
      title: `会议室-${++this._counter}`,
      subSessions: [],
      layout: 'focus',
      focusedSub: null,
      syncContext: false,
      sendTarget: 'all',
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      pinned: false,
      status: 'idle',
      lastScene: 'free_discussion',
    };
    // Hub Timeline phase 1 (in-memory only)
    meeting._timeline = [];
    meeting._cursors = {};
    meeting._nextIdx = 0;
    this.meetings.set(id, meeting);
    return { ...meeting };
  }

  getMeeting(id) {
    const m = this.meetings.get(id);
    return m ? {
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
    } : null;
  }

  getAllMeetings() {
    return Array.from(this.meetings.values()).map(m => ({
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
    }));
  }

  addSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (m.subSessions.length >= 3) return null;
    if (m.subSessions.includes(sessionId)) return null;
    m.subSessions.push(sessionId);
    m.lastMessageTime = Date.now();
    return { ...m, subSessions: [...m.subSessions] };
  }

  removeSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.subSessions = m.subSessions.filter(id => id !== sessionId);
    if (m.focusedSub === sessionId) m.focusedSub = m.subSessions[0] || null;
    if (m.sendTarget === sessionId) m.sendTarget = 'all';
    return { ...m, subSessions: [...m.subSessions] };
  }

  updateMeeting(meetingId, fields) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    const allowed = ['title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned', 'lastMessageTime', 'status', 'lastScene'];
    for (const key of allowed) {
      if (key in fields) m[key] = fields[key];
    }
    return { ...m, subSessions: [...m.subSessions] };
  }

  closeMeeting(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    const subIds = [...m.subSessions];
    this.meetings.delete(meetingId);
    return subIds;
  }

  restoreMeeting(meetingData) {
    if (!meetingData || !meetingData.id) return;
    this.meetings.set(meetingData.id, {
      ...meetingData,
      status: 'dormant',
      subSessions: meetingData.subSessions || [],
      _timeline: [],
      _cursors: {},
      _nextIdx: 0,
    });
    const num = parseInt((meetingData.title || '').replace(/\D/g, ''), 10);
    if (num && num >= this._counter) this._counter = num;
  }
  appendTurn(meetingId, sid, text, ts) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (typeof text !== 'string' || !text) return null;

    // Cap at 100KB to prevent OOM from runaway AI output
    const MAX = 100 * 1024;
    let safeText = text;
    if (safeText.length > MAX) {
      safeText = safeText.slice(0, MAX) + '...[truncated]';
    }

    // Dedupe: same sid+text within 2s = duplicate event from tap
    const lastTurn = m._timeline[m._timeline.length - 1];
    if (lastTurn && lastTurn.sid === sid && lastTurn.text === safeText
        && (ts - lastTurn.ts) < 2000) {
      return null;
    }

    const resolvedTs = ts != null ? ts : Date.now();
    const turn = { idx: m._nextIdx++, sid, text: safeText, ts: resolvedTs };
    m._timeline.push(turn);
    m.lastMessageTime = resolvedTs;
    return { ...turn };
  }

  getTimeline(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return [];
    return m._timeline.map(t => ({ ...t }));
  }
}

module.exports = { MeetingRoomManager };
