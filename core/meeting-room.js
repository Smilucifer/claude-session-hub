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
    this.meetings.set(id, meeting);
    return { ...meeting };
  }

  getMeeting(id) {
    const m = this.meetings.get(id);
    return m ? { ...m, subSessions: [...m.subSessions] } : null;
  }

  getAllMeetings() {
    return Array.from(this.meetings.values()).map(m => ({
      ...m,
      subSessions: [...m.subSessions],
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
    });
    const num = parseInt((meetingData.title || '').replace(/\D/g, ''), 10);
    if (num && num >= this._counter) this._counter = num;
  }
}

module.exports = { MeetingRoomManager };
