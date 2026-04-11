import { useState, useCallback, useRef } from 'react';

export interface SessionInfo {
  id: string;
  title: string;
  status: 'running' | 'idle';
  lastActivityTime: number;
  lastOutputPreview: string;
  unreadCount: number;
  createdAt: number;
}

function sortByActivity(sessions: Map<string, SessionInfo>): SessionInfo[] {
  return Array.from(sessions.values())
    .sort((a, b) => b.lastActivityTime - a.lastActivityTime);
}

export function useSessions() {
  // Use Map internally to guarantee no duplicates
  const sessionMapRef = useRef(new Map<string, SessionInfo>());
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const syncToState = useCallback(() => {
    setSessions(sortByActivity(sessionMapRef.current));
  }, []);

  const handleServerMessage = useCallback((msg: any) => {
    const map = sessionMapRef.current;

    switch (msg.type) {
      case 'sessions': {
        // Full replace — server sends authoritative list on connect
        map.clear();
        for (const s of msg.sessions) {
          map.set(s.id, s);
        }
        syncToState();
        break;
      }

      case 'session-created': {
        // Upsert — safe against duplicates from reconnection/HMR
        map.set(msg.session.id, msg.session);
        syncToState();
        // Auto-focus new session
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
        // Only update if session exists (ignore stale updates)
        if (map.has(msg.session.id)) {
          map.set(msg.session.id, msg.session);
          syncToState();
        }
        break;
      }
    }
  }, [syncToState]);

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    handleServerMessage,
  };
}
