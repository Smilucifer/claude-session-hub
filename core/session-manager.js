const pty = require('node-pty');
const { v4: uuid } = require('uuid');

class SessionManager {
  sessions = new Map();
  focusedSessionId = null;
  claudeCounter = 0;
  resumeCounter = 0;
  psCounter = 0;

  // Injected by main: the chosen hook HTTP port + per-launch auth token.
  hookPort = null;
  hookToken = null;

  // Callbacks
  onData = (sessionId, data) => {};
  onSessionClosed = (sessionId) => {};

  createSession(kind = 'powershell') {
    const id = uuid();
    const isClaude = kind === 'claude' || kind === 'claude-resume';
    let title;
    if (kind === 'claude') title = `Claude ${++this.claudeCounter}`;
    else if (kind === 'claude-resume') title = `Claude Resume ${++this.resumeCounter}`;
    else title = `PowerShell ${++this.psCounter}`;

    const sessionEnv = { ...process.env };

    if (isClaude) {
      // Force subscription OAuth (Claude Max): strip custom-endpoint env vars
      // that would otherwise route Claude Code to cc-switch / CCR. Without
      // these deletions the user's system-wide ANTHROPIC_AUTH_TOKEN (set by
      // cc-switch) would hijack auth and bypass the subscription.
      delete sessionEnv.ANTHROPIC_BASE_URL;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      // Inherit proxy from parent env; if set, also add NO_PROXY for localhost
      if (sessionEnv.HTTP_PROXY || sessionEnv.HTTPS_PROXY) {
        sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
      }
      // Attribution + auth for the Stop/UserPromptSubmit hook script
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
    }

    const shellArgs = isClaude ? ['-NoProfile', '-NoLogo'] : [];
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

    if (isClaude) {
      const cmd = kind === 'claude-resume' ? ' claude --resume\r\n' : ' claude\r\n';
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
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
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
