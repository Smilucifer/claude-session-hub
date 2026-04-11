import React, { useState, useRef, useEffect } from 'react';
import type { SessionInfo } from '../hooks/useSessions';
import { SessionItem } from './SessionItem';

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (kind: 'claude' | 'powershell') => void;
}

export const SessionList: React.FC<Props> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  const handleCreate = (kind: 'claude' | 'powershell') => {
    setShowMenu(false);
    onCreateSession(kind);
  };

  return (
    <div className="session-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span className="session-count">{sessions.length} open</span>
          <div className="new-session-wrapper" ref={menuRef}>
            <button
              className="btn-new-session"
              onClick={() => setShowMenu(v => !v)}
              title="New session"
            >
              +
            </button>
            {showMenu && (
              <div className="new-session-menu">
                <button
                  className="new-session-option"
                  onClick={() => handleCreate('claude')}
                >
                  Claude Code
                </button>
                <button
                  className="new-session-option"
                  onClick={() => handleCreate('powershell')}
                >
                  PowerShell
                </button>
              </div>
            )}
          </div>
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
