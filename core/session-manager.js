const pty = require('node-pty');
const { v4: uuid } = require('uuid');

class SessionManager {
  sessions = new Map();
  focusedSessionId = null;
  claudeCounter = 0;
  psCounter = 0;

  // Callbacks
  onData = (sessionId, data) => {};
  onSessionClosed = (sessionId) => {};

  createSession(kind = 'powershell') {
    const id = uuid();
    const title = kind === 'claude'
      ? `Claude ${++this.claudeCounter}`
      : `PowerShell ${++this.psCounter}`;

    const sessionEnv = { ...process.env };

    if (kind === 'claude') {
      sessionEnv.ANTHROPIC_BASE_URL = '';
      sessionEnv.ANTHROPIC_AUTH_TOKEN = '';
      sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = '';
      // Inherit proxy from parent env; if set, also add NO_PROXY for localhost
      if (sessionEnv.HTTP_PROXY || sessionEnv.HTTPS_PROXY) {
        sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
      }
    }

    const shellArgs = kind === 'claude' ? ['-NoProfile', '-NoLogo'] : [];
    const ptyProcess = pty.spawn('powershell.exe', shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.env.USERPROFILE || process.env.HOME || '.',
      env: sessionEnv,
      useConpty: true,
      conptyInheritCursor: true,
    });

    const now = Date.now();
    const info = {
      id,
      kind,
      title,
      status: 'idle',
      lastMessageTime: now,
      lastOutputPreview: '',
      unreadCount: 0,
      createdAt: now,
    };

    const pendingTimers = [];
    this.sessions.set(id, { info, pty: ptyProcess, pendingTimers });

    ptyProcess.onData((data) => {
      this.onData(id, data);
    });

    ptyProcess.onExit(() => { this.sessions.delete(id); this.onSessionClosed(id); });

    if (kind === 'powershell') {
      ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle InlineView 2>$null; clear\r\n');
    }

    if (kind === 'claude') {
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(' claude\r\n');
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(' claude\r\n');
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    return { ...info };
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const t of session.pendingTimers) clearTimeout(t);
    session.pty.kill();
    this.sessions.delete(sessionId);
  }

  renameSession(sessionId, title) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.info.title = title;
    return { ...session.info };
  }

  writeToSession(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s) s.pty.write(data);
  }

  resizeSession(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s) s.pty.resize(cols, rows);
  }

  setFocusedSession(sessionId) {
    this.focusedSessionId = sessionId;
  }

  markRead(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.info.unreadCount = 0;
  }

  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info } : undefined;
  }

  getAllSessions() {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt);
  }

  dispose() {
    for (const s of this.sessions.values()) {
      for (const t of s.pendingTimers) clearTimeout(t);
      s.pty.kill();
    }
    this.sessions.clear();
  }
}

module.exports = { SessionManager };
