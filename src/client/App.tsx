import React, { useCallback } from 'react';
import { SessionList } from './components/SessionList';
import { TerminalPanel, writeToTerminal, disposeTerminal } from './components/TerminalPanel';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';

export const App: React.FC = () => {
  const { sessions, activeSessionId, setActiveSessionId, handleServerMessage } = useSessions();

  const sendRef = React.useRef<(msg: object) => void>(() => {});

  const onMessage = useCallback((msg: any) => {
    handleServerMessage(msg);
    if (msg.type === 'terminal-data') writeToTerminal(msg.sessionId, msg.data);
    if (msg.type === 'session-closed') disposeTerminal(msg.sessionId);
    // Auto-focus newly created session on the server side
    if (msg.type === 'session-created') {
      sendRef.current({ type: 'focus-session', sessionId: msg.session.id });
    }
  }, [handleServerMessage]);

  const { send } = useWebSocket(onMessage);
  sendRef.current = send;

  return (
    <div className="app-container">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={useCallback((id: string) => {
          setActiveSessionId(id);
          send({ type: 'focus-session', sessionId: id });
        }, [send, setActiveSessionId])}
        onCreateSession={useCallback(() => send({ type: 'create-session' }), [send])}
      />
      <TerminalPanel
        session={sessions.find(s => s.id === activeSessionId) || null}
        onInput={useCallback((id: string, data: string) => send({ type: 'terminal-input', sessionId: id, data }), [send])}
        onResize={useCallback((id: string, cols: number, rows: number) => send({ type: 'terminal-resize', sessionId: id, cols, rows }), [send])}
        onClose={useCallback((id: string) => send({ type: 'close-session', sessionId: id }), [send])}
      />
    </div>
  );
};
