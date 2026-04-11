import * as pty from 'node-pty';
import { v4 as uuid } from 'uuid';
import { SessionInfo } from './types.js';
import { SilenceDetector } from './silence-detector.js';

interface ManagedSession {
  info: SessionInfo;
  pty: pty.IPty;
  updateTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;  // auto-idle after no output
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
const IDLE_TIMEOUT_MS = 10000;

// Backend noise patterns — output matching these is NOT meaningful activity
const BACKEND_NOISE_PATTERNS = [
  // Claude Code status bar & UI chrome
  /\[(Opus|Sonnet|Haiku|Claude)/,
  /Context\s/,
  /Usage\s/,
  /resets in \d/,
  /bypass permissions|allowed tools/i,
  /CLAUDE\.md|hooks/,
  /\d+ MCPs?\b/,
  /remote-control/,
  /Code in CLI or at/,
  /Accessing workspace/,
  /Claude Code\s+v\d/,
  /trust this folder|Security guide/i,
  /settings issue/,
  /doctor for details/,
  // Shell prompts & decorations
  /^\s*[>❯$]\s*$/,
  /^\s*PS [A-Z]:\\/,
  /\w+@[\w-]+.*[~$]/,
  /^\s*[━─═╭╮╰╯│]{3,}/,
  // Switched proxy/subscription lines
  /Switched to .*(Subscription|Proxy|API)/i,
];

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private silenceDetector: SilenceDetector;
  private focusedSessionId: string | null = null;
  private sessionCounter = 0;  // monotonic counter for unique titles
  // Brief grace period to skip resize noise on switch (1 second)
  private recentlyUnfocused = new Set<string>();
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static GRACE_MS = 1000;

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

      // Broadcast idle status — frontend will extract preview and update time
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

    const now = Date.now();
    const info: SessionInfo = {
      id,
      title: `PowerShell ${this.sessionCounter}`,
      status: 'idle',
      lastActivityTime: now,
      lastMessageTime: now,
      lastOutputPreview: '',
      unreadCount: 0,
      createdAt: now,
    };

    const managed: ManagedSession = {
      info,
      pty: ptyProcess,
      updateTimer: null,
      idleTimer: null,
      dirty: false,
    };

    this.sessions.set(id, managed);

    // Brief grace for startup noise
    this.recentlyUnfocused.add(id);
    this.graceTimers.set(id, setTimeout(() => {
      this.recentlyUnfocused.delete(id);
      this.graceTimers.delete(id);
    }, SessionManager.GRACE_MS));

    // Listen for pty output — must be registered BEFORE any writes
    ptyProcess.onData((data: string) => {
      this.handlePtyOutput(id, data);
    });

    ptyProcess.onExit(() => {
      this.handlePtyExit(id);
    });

    // Silent setup: disable PSReadLine ListView + add fast-claude alias, then clear
    ptyProcess.write([
      'Set-PSReadLineOption -PredictionViewStyle InlineView 2>$null',
      'clear',
    ].join('; ') + '\r\n');

    return { ...info };
  }

  private handlePtyOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Always forward terminal data to client (rendering must see everything)
    this.onData(sessionId, data);

    // Check if this output contains visible text (not just control sequences)
    const cleanData = stripAnsi(data);
    const visibleText = cleanData.replace(/[\s\r\n]/g, '');

    // Ignore pure control sequence output (cursor blink, PSReadLine refresh, etc.)
    if (visibleText.length === 0) return;

    // Check if visible text is just noise (status bar, prompt, config info)
    const trimmedLines = cleanData.split('\n').filter(l => l.trim().length > 0);
    const isNoise = trimmedLines.length > 0 && trimmedLines.every(line =>
      BACKEND_NOISE_PATTERNS.some(p => p.test(line.trim()))
    );

    // Noise output: don't count as activity, don't trigger idle timer reset
    if (isNoise) return;

    session.info.lastActivityTime = Date.now();
    session.info.status = 'running';

    // Reset idle timer — after IDLE_TIMEOUT_MS of no meaningful output, mark as idle
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      session.info.status = 'idle';
      // Don't update lastMessageTime here — it's updated via updatePreview
      // only when the actual preview content changes
      this.onSessionUpdated({ ...session.info });
    }, IDLE_TIMEOUT_MS);

    // Only track silence detection for background sessions (not focused, not in grace)
    const isFocused = sessionId === this.focusedSessionId;
    if (!isFocused && !this.recentlyUnfocused.has(sessionId)) {
      this.silenceDetector.recordActivity(sessionId);
    }

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
    if (session?.updateTimer) clearTimeout(session.updateTimer);
    if (session?.idleTimer) clearTimeout(session.idleTimer);
    this.silenceDetector.remove(sessionId);
    this.sessions.delete(sessionId);
    // Notify frontend that this session is gone
    this.onSessionClosed(sessionId);
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.updateTimer) clearTimeout(session.updateTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
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
    const oldFocused = this.focusedSessionId;

    // Cancel pending silence timers
    if (oldFocused) this.silenceDetector.remove(oldFocused);
    this.silenceDetector.remove(sessionId);

    // Brief grace for old focused session (skip resize noise)
    if (oldFocused && oldFocused !== sessionId) {
      const old = this.graceTimers.get(oldFocused);
      if (old) clearTimeout(old);
      this.recentlyUnfocused.add(oldFocused);
      this.graceTimers.set(oldFocused, setTimeout(() => {
        this.recentlyUnfocused.delete(oldFocused);
        this.graceTimers.delete(oldFocused);
      }, SessionManager.GRACE_MS));
    }

    // New focused session exits grace immediately
    if (this.recentlyUnfocused.has(sessionId)) {
      this.recentlyUnfocused.delete(sessionId);
      const t = this.graceTimers.get(sessionId);
      if (t) { clearTimeout(t); this.graceTimers.delete(sessionId); }
    }

    this.focusedSessionId = sessionId;
  }

  updatePreview(sessionId: string, preview: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Only store — NO broadcast. Frontend handles UI via updateLocalPreview.
    // This prevents cascade: updatePreview → broadcast → re-render → extract → updatePreview
    session.info.lastOutputPreview = preview;
  }

  markRead(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Only store — NO broadcast. Frontend already clears badge locally.
    session.info.unreadCount = 0;
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt);
  }

  dispose(): void {
    this.silenceDetector.dispose();
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    this.recentlyUnfocused.clear();
    for (const session of this.sessions.values()) {
      if (session.updateTimer) clearTimeout(session.updateTimer);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.pty.kill();
    }
    this.sessions.clear();
  }
}
