import { useState, useCallback, useRef } from 'react';

export interface SessionInfo {
  id: string;
  title: string;
  status: 'running' | 'idle';
  lastActivityTime: number;
  lastMessageTime: number;
  lastOutputPreview: string;
  unreadCount: number;
  createdAt: number;
}

function sortByActivity(sessions: Map<string, SessionInfo>): SessionInfo[] {
  return Array.from(sessions.values())
    .sort((a, b) => {
      // Primary: last message completion time (most recent first)
      const timeDiff = b.lastMessageTime - a.lastMessageTime;
      if (timeDiff !== 0) return timeDiff;
      // Secondary: creation time (stable tiebreaker)
      return b.createdAt - a.createdAt;
    });
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
        if (!map.has(msg.session.id)) break;
        const prev = map.get(msg.session.id)!;
        map.set(msg.session.id, msg.session);
        // Only re-sort if message time changed (silence detected = message complete)
        if (prev.lastMessageTime !== msg.session.lastMessageTime) {
          syncToState();
        } else {
          // Update data in place, preserve current sort order
          setSessions(prev2 => prev2.map(s =>
            s.id === msg.session.id ? msg.session : s
          ));
        }
        break;
      }
    }
  }, [syncToState]);

  // Update preview locally — also updates time and triggers re-sort if content changed
  const updateLocalPreview = useCallback((sessionId: string, preview: string) => {
    const map = sessionMapRef.current;
    const s = map.get(sessionId);
    if (!s) return;

    // Only act if preview content actually changed
    if (preview === s.lastOutputPreview) return;

    s.lastOutputPreview = preview;
    s.lastMessageTime = Date.now();
    // Re-sort since lastMessageTime changed
    setSessions(sortByActivity(map));
  }, []);

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    handleServerMessage,
    updateLocalPreview,
  };
}
