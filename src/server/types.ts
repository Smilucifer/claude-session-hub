export interface SessionInfo {
  id: string;
  title: string;
  status: 'running' | 'idle';
  lastActivityTime: number;
  lastOutputPreview: string;
  unreadCount: number;
  createdAt: number;
}

// WebSocket messages: server → client
export type ServerMessage =
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'session-created'; session: SessionInfo }
  | { type: 'session-closed'; sessionId: string }
  | { type: 'session-updated'; session: SessionInfo }
  | { type: 'terminal-data'; sessionId: string; data: string }
  | { type: 'error'; message: string };

// WebSocket messages: client → server
export type ClientMessage =
  | { type: 'create-session' }
  | { type: 'close-session'; sessionId: string }
  | { type: 'terminal-input'; sessionId: string; data: string }
  | { type: 'terminal-resize'; sessionId: string; cols: number; rows: number }
  | { type: 'focus-session'; sessionId: string }
  | { type: 'mark-read'; sessionId: string };
