import React from 'react';
import type { SessionInfo } from '../hooks/useSessions';
import { SessionItem } from './SessionItem';

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
}

export const SessionList: React.FC<Props> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
}) => {
  return (
    <div className="session-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span className="session-count">{sessions.length} open</span>
          <button className="btn-new-session" onClick={onCreateSession} title="New session">
            +
          </button>
        </div>
      </div>
      <div className="session-list">
        {sessions.map(session => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => onSelectSession(session.id)}
          />
        ))}
      </div>
    </div>
  );
};
