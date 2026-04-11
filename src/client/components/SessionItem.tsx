import React from 'react';
import type { SessionInfo } from '../hooks/useSessions';

interface Props {
  session: SessionInfo;
  isActive: boolean;
  onClick: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const SessionItem: React.FC<Props> = ({ session, isActive, onClick }) => {
  const className = [
    'session-item',
    isActive && 'selected',
    !isActive && session.unreadCount > 0 && 'has-unread',
  ].filter(Boolean).join(' ');

  return (
    <div className={className} onClick={onClick}>
      <div className="session-item-header">
        <span className="session-title">
          <span className={`session-status ${session.status}`} />
          {session.title}
        </span>
        {session.unreadCount > 0 && !isActive && (
          <span className="unread-badge">{session.unreadCount}</span>
        )}
      </div>
      <div className="session-preview">
        {session.lastOutputPreview || 'No output yet'}
      </div>
      <div className="session-time">
        {formatTime(session.lastActivityTime)}
        {session.status === 'running' && ' · running'}
      </div>
    </div>
  );
};
