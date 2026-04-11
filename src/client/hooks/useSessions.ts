import { useState, useCallback, useRef } from 'react';

export interface SessionInfo {
  id: string;
  title: string;
  status: 'running' | 'idle';
  lastMessageTime: number;
  lastOutputPreview: string;
  unreadCount: number;
  createdAt: number;
}

function sortByMessageTime(sessions: Map<string, SessionInfo>): SessionInfo[] {
  return Array.from(sessions.values())
    .sort((a, b) => {
      const timeDiff = b.lastMessageTime - a.lastMessageTime;
      if (timeDiff !== 0) return timeDiff;
      return b.createdAt - a.createdAt;
    });
}

export function useSessions() {
  const sessionMapRef = useRef(new Map<string, SessionInfo>());
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const syncToState = useCallback(() => {
    setSessions(sortByMessageTime(sessionMapRef.current));
  }, []);

  const handleServerMessage = useCallback((msg: any) => {
    const map = sessionMapRef.current;

    switch (msg.type) {
      case 'sessions': {
        map.clear();
        for (const s of msg.sessions) map.set(s.id, s);
        syncToState();
        break;
      }
      case 'session-created': {
        map.set(msg.session.id, msg.session);
        syncToState();
        setActiveSessionId(msg.session.id);
        break;
      }
      case 'session-closed': {
        map.delete(msg.sessionId);
        syncToState();
        setActiveSessionId(prev => prev === msg.sessionId ? null : prev);
        break;
      }
      case 'session-updated': {
        if (!map.has(msg.session.id)) break;
        const prev = map.get(msg.session.id)!;
        map.set(msg.session.id, msg.session);
        // Re-sort if message time changed (hook fired = new message)
        if (prev.lastMessageTime !== msg.session.lastMessageTime) {
          syncToState();
        } else {
          // Update in place without re-sorting
          setSessions(prev2 => prev2.map(s =>
            s.id === msg.session.id ? msg.session : s
          ));
        }
        break;
      }
    }
  }, [syncToState]);

  return { sessions, activeSessionId, setActiveSessionId, handleServerMessage };
}
