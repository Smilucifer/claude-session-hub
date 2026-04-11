import React, { useCallback, useRef } from 'react';
import { SessionList } from './components/SessionList';
import { TerminalPanel, writeToTerminal, disposeTerminal, extractPreviewFromBuffer } from './components/TerminalPanel';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';

export const App: React.FC = () => {
  const { sessions, activeSessionId, setActiveSessionId, handleServerMessage, updateLocalPreview } = useSessions();
  const sendRef = useRef<(msg: object) => void>(() => {});
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  const onMessage = useCallback((msg: any) => {
    handleServerMessage(msg);

    // Route terminal data to the right terminal instance
    if (msg.type === 'terminal-data') {
      writeToTerminal(msg.sessionId, msg.data);
    }

    // Clean up terminal when session is closed
    if (msg.type === 'session-closed') {
      disposeTerminal(msg.sessionId);
    }

    // When a BACKGROUND session becomes idle, extract preview from xterm.js buffer
    // Skip focused session — its terminal is visible, no need for preview update,
    // and resize reflow would cause preview to change incorrectly
    if (msg.type === 'session-updated' && msg.session.status === 'idle') {
      if (msg.session.id !== activeSessionIdRef.current) {
        const preview = extractPreviewFromBuffer(msg.session.id);
        if (preview) {
          updateLocalPreview(msg.session.id, preview);
          sendRef.current({ type: 'update-preview', sessionId: msg.session.id, preview });
        }
      }
    }
  }, [handleServerMessage, updateLocalPreview]);

  const { send } = useWebSocket(onMessage);
  sendRef.current = send;

  const handleCreateSession = useCallback(() => {
    send({ type: 'create-session' });
  }, [send]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    send({ type: 'focus-session', sessionId });
  }, [send, setActiveSessionId]);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    send({ type: 'terminal-input', sessionId, data });
  }, [send]);

  const handleTerminalResize = useCallback((sessionId: string, cols: number, rows: number) => {
    send({ type: 'terminal-resize', sessionId, cols, rows });
  }, [send]);

  const handleCloseSession = useCallback((sessionId: string) => {
    send({ type: 'close-session', sessionId });
  }, [send]);

  const activeSession = sessions.find(s => s.id === activeSessionId) || null;

  return (
    <div className="app-container">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
      />
      <TerminalPanel
        session={activeSession}
        onInput={handleTerminalInput}
        onResize={handleTerminalResize}
        onClose={handleCloseSession}
      />
    </div>
  );
};
