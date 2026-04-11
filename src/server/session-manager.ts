import * as pty from 'node-pty';
import { v4 as uuid } from 'uuid';
import { SessionInfo } from './types.js';
import { SilenceDetector } from './silence-detector.js';

interface ManagedSession {
  info: SessionInfo;
  pty: pty.IPty;
  updateTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\r/g, '');
}

const UPDATE_THROTTLE_MS = 300;

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private silenceDetector: SilenceDetector;
  private focusedSessionId: string | null = null;
  private sessionCounter = 0;  // monotonic counter for unique titles

  // Callbacks
  onData: (sessionId: string, data: string) => void = () => {};
  onSessionUpdated: (session: SessionInfo) => void = () => {};
  onSessionClosed: (sessionId: string) => void = () => {};  // notify frontend on pty exit

  constructor() {
    this.silenceDetector = new SilenceDetector((sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      session.info.status = 'idle';

      if (sessionId !== this.focusedSessionId) {
        session.info.unreadCount++;
      }

      this.onSessionUpdated({ ...session.info });
    });
  }

  createSession(): SessionInfo {
    const id = uuid();
    this.sessionCounter++;
    const shell = 'powershell.exe';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.env.USERPROFILE || process.env.HOME || '.',
      env: process.env as Record<string, string>,
      useConpty: true,
      conptyInheritCursor: true,
    });

    const info: SessionInfo = {
      id,
      title: `PowerShell ${this.sessionCounter}`,
      status: 'idle',
      lastActivityTime: Date.now(),
      lastOutputPreview: '',
      unreadCount: 0,
      createdAt: Date.now(),
    };

    const managed: ManagedSession = {
      info,
      pty: ptyProcess,
      updateTimer: null,
      dirty: false,
    };

    this.sessions.set(id, managed);

    // Listen for pty output — must be registered BEFORE any writes
    ptyProcess.onData((data: string) => {
      this.handlePtyOutput(id, data);
    });

    ptyProcess.onExit(() => {
      this.handlePtyExit(id);
    });

    // Disable PSReadLine ListView prediction (after listeners are bound)
    ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle InlineView 2>$null\r\n');

    return { ...info };
  }

  private handlePtyOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.info.lastActivityTime = Date.now();
    session.info.status = 'running';

    const cleanData = stripAnsi(data);
    const lines = cleanData.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      session.info.lastOutputPreview = lines[lines.length - 1].trim().substring(0, 80);
    }

    this.silenceDetector.recordActivity(sessionId);

    // Forward terminal data immediately
    this.onData(sessionId, data);

    // Throttle session-updated broadcasts
    session.dirty = true;
    if (!session.updateTimer) {
      session.updateTimer = setTimeout(() => {
        session.updateTimer = null;
        if (session.dirty) {
          session.dirty = false;
          this.onSessionUpdated({ ...session.info });
        }
      }, UPDATE_THROTTLE_MS);
    }
  }

  private handlePtyExit(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.updateTimer) {
      clearTimeout(session.updateTimer);
    }
    this.silenceDetector.remove(sessionId);
    this.sessions.delete(sessionId);
    // Notify frontend that this session is gone
    this.onSessionClosed(sessionId);
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
    }
    this.silenceDetector.remove(sessionId);
    session.pty.kill();
    this.sessions.delete(sessionId);
  }

  writeToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.write(data);
    }
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  setFocusedSession(sessionId: string): void {
    this.focusedSessionId = sessionId;
  }

  markRead(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.unreadCount = 0;
      this.onSessionUpdated({ ...session.info });
    }
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort((a, b) => b.lastActivityTime - a.lastActivityTime);
  }

  dispose(): void {
    this.silenceDetector.dispose();
    for (const session of this.sessions.values()) {
      if (session.updateTimer) clearTimeout(session.updateTimer);
      session.pty.kill();
    }
    this.sessions.clear();
  }
}
