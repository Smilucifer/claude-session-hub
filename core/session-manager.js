const pty = require('node-pty');
const { v4: uuid } = require('uuid');
const { EventEmitter } = require('events');

const RING_BUFFER_BYTES = 8192;

// Default proxy for Claude sessions. Change if your proxy differs.
const CLAUDE_PROXY = 'http://127.0.0.1:7890';

class SessionManager extends EventEmitter {
  sessions = new Map();
  focusedSessionId = null;
  claudeCounter = 0;
  resumeCounter = 0;
  psCounter = 0;
  _outputSeq = 0;

  // Injected by main: the chosen hook HTTP port + per-launch auth token.
  hookPort = null;
  hookToken = null;

  constructor() {
    super();
  }

  // Callbacks
  onData = (sessionId, data) => {};
  onSessionClosed = (sessionId) => {};

  // opts: { id?, title?, cwd?, resumeCCSessionId?, useContinue? }
  //   id:                 reuse a previous hub session id (dormant wake)
  //   title:              override default title (dormant wake preserves name)
  //   cwd:                launch cwd; defaults to user home
  //   resumeCCSessionId:  when set, runs `claude --resume <id>`
  //   useContinue:        when set and no resumeCCSessionId, runs `claude --continue`
  createSession(kind = 'powershell', opts = {}) {
    const id = opts.id || uuid();
    const isClaude = kind === 'claude' || kind === 'claude-resume';
    const isGemini = kind === 'gemini';
    const isCodex = kind === 'codex';
    const isAgent = isClaude || isGemini || isCodex;
    let title;
    if (opts.title) title = opts.title;
    else if (kind === 'claude') title = `Claude ${++this.claudeCounter}`;
    else if (kind === 'claude-resume') title = `Claude Resume ${++this.resumeCounter}`;
    else if (kind === 'gemini') { this.geminiCounter = (this.geminiCounter || 0) + 1; title = `Gemini ${this.geminiCounter}`; }
    else if (kind === 'codex') { this.codexCounter = (this.codexCounter || 0) + 1; title = `Codex ${this.codexCounter}`; }
    else title = `PowerShell ${++this.psCounter}`;

    const sessionEnv = { ...process.env };

    if (isClaude) {
      // Force subscription OAuth (Claude Max): strip custom-endpoint env vars
      // that would otherwise route Claude Code to cc-switch / CCR.
      delete sessionEnv.ANTHROPIC_BASE_URL;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      // Force Clash proxy — don't rely on how Electron was launched.
      // User's hard rule: all CLI calls must go through 127.0.0.1:7890.
      sessionEnv.HTTP_PROXY = CLAUDE_PROXY;
      sessionEnv.HTTPS_PROXY = CLAUDE_PROXY;
      sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
      // Attribution + auth for the Stop/UserPromptSubmit hook script
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      sessionEnv.CLAUDE_HUB_MOBILE_PORT = String((global.__mobileSrv && global.__mobileSrv.port) || 3470);
      // Propagate data-dir override so the statusline script writes its cache
      // into the isolated test dir instead of the production ~/.claude-session-hub.
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isGemini || isCodex) {
      sessionEnv.HTTP_PROXY = CLAUDE_PROXY;
      sessionEnv.HTTPS_PROXY = CLAUDE_PROXY;
      sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
    }

    // Merge extra env vars (used by TeamSessionManager for MCP config etc.)
    if (opts.extraEnv) {
      Object.assign(sessionEnv, opts.extraEnv);
    }

    const shellArgs = isAgent ? ['-NoProfile', '-NoLogo'] : [];
    // cwd fallback order: opts.cwd (if exists) -> user home. We stat-check to
    // avoid node-pty failing if the stored cwd was later deleted/moved.
    let spawnCwd = opts.cwd;
    if (spawnCwd) {
      try { require('fs').accessSync(spawnCwd); } catch { spawnCwd = null; }
    }
    if (!spawnCwd) spawnCwd = process.env.USERPROFILE || process.env.HOME || '.';

    const ptyProcess = pty.spawn('powershell.exe', shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spawnCwd,
      env: sessionEnv,
      useConpty: true,
      // conptyInheritCursor=true kills PTY output for headless sessions (no
      // renderer xterm attached). TeamSessionManager sets noInheritCursor for
      // background character sessions. Normal user sessions don't set it, so
      // the default stays true for backward compatibility.
      conptyInheritCursor: !opts.noInheritCursor,
    });

    const now = Date.now();
    const info = {
      id,
      kind,
      title,
      status: 'idle',
      lastMessageTime: opts.lastMessageTime || now,
      lastOutputPreview: opts.lastOutputPreview || '',
      unreadCount: 0,
      createdAt: now,
      cwd: spawnCwd,
      meetingId: opts.meetingId || null,
    };

    const pendingTimers = [];
    this.sessions.set(id, { info, pty: ptyProcess, pendingTimers, ringBuffer: '' });

    ptyProcess.onData((data) => {
      this._appendToRingBuffer(id, data);
      this.onData(id, data);
      this._outputSeq += 1;
      this.emit('output', { sessionId: id, seq: this._outputSeq, data });
    });

    ptyProcess.onExit(() => { this.sessions.delete(id); this.onSessionClosed(id); });

    if (kind === 'powershell') {
      ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle ListView 2>$null; clear\r\n');
    }

    if (isClaude) {
      let cmd;
      if (opts.resumeCCSessionId) {
        cmd = ` claude --resume ${opts.resumeCCSessionId}`;
      } else if (opts.useContinue) {
        cmd = ' claude --continue';
      } else if (kind === 'claude-resume') {
        cmd = ' claude --resume';
      } else {
        // Fresh Claude sessions default to Opus 4.6 1M (extended thinking).
        // Resume/continue inherit the transcript's model, so don't force --model there.
        cmd = ' claude --model claude-opus-4-6[1m]';
      }
      // Append system prompt file if provided (TeamSessionManager injects character prompt)
      if (opts.appendSystemPromptFile) {
        cmd += ` --append-system-prompt-file "${opts.appendSystemPromptFile.replace(/\\/g, '\\\\')}"`;
      }
      // Append MCP config file if provided (TeamSessionManager injects MCP server config)
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
      }
      cmd += '\r\n';
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

    if (isGemini) {
      let cmd = ' gemini --approval-mode yolo';
      cmd += ` --model ${opts.model || 'gemini-2.5-pro'}`;
      if (opts.useResume) cmd += ' --resume latest';
      cmd += '\r\n';
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

    if (isCodex) {
      let cmd = opts.useResume ? ' codex resume --last --full-auto' : ' codex --full-auto';
      cmd += '\r\n';
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
    if (s && s.pty) s.pty.write(data);
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
    if (session) {
      session.info.unreadCount = 0;
      this.emit('session-updated', this._toPublic(session.info));
    }
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

  // Returns the public shape used by mobile API and 'session-updated' events.
  _toPublic(info) {
    return {
      id: info.id,
      title: info.title,
      kind: info.kind,
      cwd: info.cwd,
      unreadCount: info.unreadCount,
      lastMessageTime: info.lastMessageTime,
      lastOutputPreview: info.lastOutputPreview,
      ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
      ...(info.ccSessionId !== undefined ? { ccSessionId: info.ccSessionId } : {}),
    };
  }

  // Returns array of public session objects for mobile API.
  listSessions() {
    return Array.from(this.sessions.values())
      .map(s => this._toPublic(s.info))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  }

  // Appends data to the session's ring buffer, capping at RING_BUFFER_BYTES (tail-slice).
  // After truncation, trims any lone low-surrogate left at the start of the buffer
  // that could result from cutting a UTF-16 surrogate pair at the boundary.
  // Extracted as a named method so tests can drive it without spawning a real PTY.
  _appendToRingBuffer(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    let rb = (s.ringBuffer || '') + data;
    if (rb.length > RING_BUFFER_BYTES) {
      rb = rb.slice(rb.length - RING_BUFFER_BYTES);
      // Trim leading lone low-surrogates (unpaired 0xDC00–0xDFFF) left by the cut.
      // A high surrogate (0xD800–0xDBFF) at position 0 is fine only if it's
      // immediately followed by a low surrogate; otherwise drop it too.
      let i = 0;
      while (i < rb.length && i < 4) {
        const cc = rb.charCodeAt(i);
        // Lone low-surrogate — definitely unpaired, drop it
        if (cc >= 0xDC00 && cc <= 0xDFFF) { i++; continue; }
        // High surrogate followed by something that is NOT a low surrogate — drop it
        if (cc >= 0xD800 && cc <= 0xDBFF) {
          const next = rb.charCodeAt(i + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) { i++; continue; }
        }
        break;
      }
      if (i > 0) rb = rb.slice(i);
    }
    s.ringBuffer = rb;
  }

  // Returns the ring-buffer string for a session, '' if exists but empty,
  // null if session not found.
  getSessionBuffer(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return s.ringBuffer || '';
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
