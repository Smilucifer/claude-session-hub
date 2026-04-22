'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { StringDecoder } = require('string_decoder');
const { AcpClient } = require('./acp-client');

const AI_TEAM_DIR = path.join(os.homedir(), '.ai-team');
const MCP_CONFIG_DIR = path.join(AI_TEAM_DIR, '.mcp-configs');
const PROMPT_DIR = path.join(AI_TEAM_DIR, '.prompts');
const CODEX_PERSONAS_DIR = path.join(AI_TEAM_DIR, '.codex-personas');
const TEAM_DB_PATH = path.join(AI_TEAM_DIR, 'team.db');

// Default proxy for CLI sessions
const CLI_PROXY = 'http://127.0.0.1:7890';

// Locate the Gemini CLI entry script. Node 24 refuses to spawn .cmd/.bat
// (CVE-2024-27980), so we call `node <bundle/gemini.js>` directly. Honor an
// explicit override via env so other platforms / custom installs still work.
function findGeminiEntry() {
  const override = process.env.HUB_GEMINI_ENTRY;
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'),
    '/usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js',
    '/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Manages persistent PTY sessions for AI Team characters, one per (room, character).
 * Replaces PTY screen-scraping with MCP callback-based response capture:
 *   1. Hub writes message to CLI stdin
 *   2. CLI processes and calls `team_respond` MCP tool
 *   3. MCP tool POSTs to Hub's /api/team/response endpoint
 *   4. Hub resolves the pending Promise with structured content
 */
class TeamSessionManager {
  /**
   * @param {import('./session-manager').SessionManager} sessionManager
   * @param {number} hookPort — the actual hook server port (3456-3460)
   */
  constructor(sessionManager, hookPort) {
    this._sessionManager = sessionManager;
    this._hookPort = hookPort;
    // Map<string, hubSessionId> keyed by "roomId:characterId" (Claude/Codex PTY)
    this._sessions = new Map();
    // Map<string, { resolve, reject, timer }> keyed by "roomId:characterId"
    this._pending = new Map();
    // Map<string, character> cached between ensureSession and sendMessage
    // for deferred (one-shot) flows (Codex).
    this._characters = new Map();
    // Codex path: Map<"roomId:charId", session_id> retained across messages so
    // `codex exec resume <sid>` on subsequent sends preserves full conversation
    // state (same mechanism as native `codex resume --last`).
    this._codexSessions = new Map();
    // Codex path: Map<"roomId:charId", ChildProcess> for in-flight exec procs
    // so we can SIGKILL on timeout / room close.
    this._codexProcs = new Map();
    // Gemini ACP: Map<string, { client: AcpClient, sessionId: string }> keyed
    // by "roomId:characterId". Gemini uses ACP (JSON-RPC over pipe stdio)
    // instead of PTY — see core/acp-client.js for why.
    this._acp = new Map();
    // In-flight ensureSession guards — concurrent calls for same key share
    // the same Promise instead of double-spawning ACP processes.
    this._acpPending = new Map();
    // Reverse map hubSessionId → "roomId:charId" for statusline token bridging
    this._hubToTeamKey = new Map();
    // Latest context stats per team key, updated via statusline /api/status
    this._tokenCache = new Map();
    // Room → projectDir for Codex exec cwd (set in ensureSession, read in _sendMessageCodex)
    this._roomProjectDirs = new Map();
    this._loadPersistedSessions();
  }

  _loadPersistedSessions() {
    try {
      const db = new DatabaseSync(TEAM_DB_PATH);
      try {
        const rows = db.prepare(
          'SELECT room_id, character_id, backing_cli, session_id FROM cli_sessions WHERE session_id IS NOT NULL'
        ).all();
        for (const r of rows) {
          const key = `${r.room_id}:${r.character_id}`;
          if (r.backing_cli === 'codex' && r.session_id) {
            this._codexSessions.set(key, r.session_id);
          }
        }
        if (rows.length) console.log(`[team-tsm] restored ${rows.length} persisted sessions`);
      } finally { db.close(); }
    } catch (e) {
      console.warn(`[team-tsm] session load failed: ${e.message}`);
    }
  }

  _persistSession(roomId, characterId, backingCli, sessionId) {
    try {
      const db = new DatabaseSync(TEAM_DB_PATH);
      try {
        db.prepare(
          `INSERT OR REPLACE INTO cli_sessions (room_id, character_id, backing_cli, session_id, updated_ts)
           VALUES (?, ?, ?, ?, ?)`
        ).run(roomId, characterId, backingCli, sessionId, Math.floor(Date.now() / 1000));
      } finally { db.close(); }
    } catch (e) {
      console.warn(`[team-tsm] session persist failed: ${e.message}`);
    }
  }

  /**
   * Called by main.js when /api/team/response callback arrives.
   * Resolves the pending sendMessage Promise.
   */
  onResponse(roomId, characterId, content, eventId) {
    const key = `${roomId}:${characterId}`;
    const pending = this._pending.get(key);
    if (!pending) {
      console.warn(`[team-tsm] onResponse for unknown pending: ${key}`);
      return;
    }
    clearTimeout(pending.timer);
    this._pending.delete(key);
    const tokenCount = this._tokenCache.get(key) || null;
    pending.resolve({ content, eventId, tokenCount });
  }

  updateStatusForSession(hubSessionId, data) {
    const key = this._hubToTeamKey.get(hubSessionId);
    if (!key) return;
    const pct = typeof data.contextPct === 'number' ? data.contextPct : null;
    this._tokenCache.set(key, {
      input: data.contextUsed || 0,
      output: 0,
      contextPct: pct,
      contextMax: data.contextMax,
    });
    // Auto-compact: inject /compact when context fills past 85%
    if (pct > 85 && !this._compactCooldown?.has(key)) {
      const session = this._sessionManager.sessions.get(hubSessionId);
      if (session?.pty) {
        console.warn(`[team-tsm] auto-compact triggered for ${key} at ${pct}%`);
        session.pty.write('/compact\r');
        if (!this._compactCooldown) this._compactCooldown = new Map();
        this._compactCooldown.set(key, Date.now());
        setTimeout(() => this._compactCooldown?.delete(key), 60000);
      }
    }
  }

  /**
   * Ensure a PTY session exists for (roomId, character).
   * Creates one via sessionManager if needed, with MCP config injected.
   * @param {string} roomId
   * @param {object} character — { id, display_name, backing_cli, model, personality, ... }
   * @param {string} [projectDir] — optional project cwd (loads that project's CLAUDE.md/AGENTS.md)
   * @returns {Promise<string>} hubSessionId
   */
  async ensureSession(roomId, character, projectDir) {
    const key = `${roomId}:${character.id}`;

    // Gemini: use ACP (JSON-RPC over piped stdio) instead of PTY. The TUI that
    // node-pty triggers hangs on "Waiting for authentication..." in ConPTY
    // even when OAuth is cached; ACP is Gemini's official IDE integration
    // path and is immune to that stall. See core/acp-client.js.
    if (projectDir) this._roomProjectDirs.set(roomId, projectDir);

    if (this._cliKind(character.backing_cli) === 'gemini') {
      return this._ensureGeminiAcpSession(roomId, character);
    }

    // Always refresh prompt/persona so template changes take effect immediately.
    const cli = this._cliKind(character.backing_cli);
    if (cli === 'codex') this._writeCodexPersona(roomId, character);
    else if (cli !== 'gemini') this._writePromptFile(roomId, character, cli);

    const existing = this._sessions.get(key);
    if (existing) {
      const session = this._sessionManager.getSession(existing);
      if (session) return existing;
      // Dead session — clean up and recreate
      this._sessions.delete(key);
    }

    // Write MCP config (format depends on CLI) and system prompt
    const mcpConfigPath = this._writeMcpConfig(roomId, character);
    const promptFile = this._writePromptFile(roomId, character);
    const cliKind = this._cliKind(character.backing_cli);

    // Gemini reads .gemini/settings.json from cwd, so it must use mcpConfigPath.
    // Claude/Codex: use projectDir (loads that project's CLAUDE.md/AGENTS.md)
    // or fall back to homedir (loads ~/CLAUDE.md via parent traversal).
    const sessionCwd = cliKind === 'gemini' ? mcpConfigPath : (projectDir || os.homedir());
    const createOpts = {
      title: `Team: ${character.display_name}`,
      cwd: sessionCwd,
      noInheritCursor: true,
      appendSystemPromptFile: promptFile,
      extraEnv: {
        AI_TEAM_ROOM_ID: roomId,
        AI_TEAM_CHARACTER_ID: character.id,
        AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
      },
    };
    if (cliKind === 'claude' || cliKind === 'claude-resume') {
      createOpts.mcpConfigFile = mcpConfigPath;
    } else if (cliKind === 'codex') {
      // Codex path is DEFERRED: ensureSession only writes the persona file
      // (used via `-c model_instructions_file=<path>`). Actual codex exec
      // spawn happens per message in _sendMessageCodex.
      // First msg: fresh `codex exec --json ...`; subsequent msgs: `codex exec
      // resume <prior_sid> --json ...` for full conversation state preservation.
      this._writeCodexPersona(roomId, character);
      this._characters.set(key, character);
      this._sessions.set(key, 'codex-deferred');
      return 'codex-deferred';
    }

    const session = this._sessionManager.createSession(cliKind, createOpts);

    this._sessions.set(key, session.id);
    this._hubToTeamKey.set(session.id, key);

    // Wait for CLI to be ready
    const ptyEntry = this._sessionManager.sessions.get(session.id);
    if (ptyEntry) {
      await this._waitForReady(ptyEntry.pty, cliKind, character, 60000);
    }

    return session.id;
  }

  /**
   * Send a message to a character's PTY session and wait for MCP callback.
   * @param {string} roomId
   * @param {string} characterId
   * @param {string} text — the message to inject into PTY stdin
   * @param {number} timeout — ms to wait for callback (default 5 min)
   * @returns {Promise<{ content: string, eventId?: string }>}
   */
  sendMessage(roomId, characterId, text, timeout = 300000, onEvent = null) {
    const key = `${roomId}:${characterId}`;

    // Gemini (ACP): the prompt() call itself returns the final text synchronously
    // (to a Promise), so we skip the PTY + MCP-callback dance entirely.
    // onEvent (if provided) is used to stream Gemini's agent_thought_chunk out
    // as thinking_delta events — the renderer already has a handler for those.
    if (this._acp.has(key)) {
      return this._sendGeminiAcpMessage(key, text, timeout, onEvent, characterId);
    }

    const hubSessionId = this._sessions.get(key);
    if (!hubSessionId) {
      return Promise.reject(new Error(`No session for ${key}`));
    }

    // Codex: fresh `codex exec` per message, chained via `exec resume <sid>`.
    if (hubSessionId === 'codex-deferred') {
      return this._sendMessageCodex(roomId, characterId, text, timeout, onEvent);
    }

    // Reject if there's already a pending request for this key
    if (this._pending.has(key)) {
      return Promise.reject(new Error(`Already waiting for response from ${key}`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(key);
        reject(new Error(`team_respond timeout after ${timeout}ms for ${key}`));
      }, timeout);

      this._pending.set(key, { resolve, reject, timer });

      // Write to PTY stdin using bracketed-paste mode. Without paste markers,
      // Claude Code TUI silently ignores programmatic bulk writes. With them,
      // the TUI treats the content as a pasted block and then \r submits it.
      const pasteStart = '\x1b[200~';
      const pasteEnd = '\x1b[201~';
      this._sessionManager.writeToSession(hubSessionId, pasteStart + text + pasteEnd);
      setTimeout(() => {
        this._sessionManager.writeToSession(hubSessionId, '\r');
      }, 200);
    });
  }

  /**
   * Close all sessions for a room.
   */
  closeRoom(roomId) {
    for (const [key, hubSessionId] of this._sessions.entries()) {
      if (key.startsWith(roomId + ':')) {
        // Kill any in-flight Codex exec process for this key.
        const proc = this._codexProcs.get(key);
        if (proc) { try { proc.kill('SIGKILL'); } catch {} this._codexProcs.delete(key); }
        // Only invoke sessionManager.closeSession for real PTY session ids
        // (not deferred sentinels like 'gemini-deferred' / 'codex-deferred').
        if (hubSessionId && hubSessionId !== 'gemini-deferred' && hubSessionId !== 'codex-deferred') {
          this._sessionManager.closeSession(hubSessionId);
        }
        this._sessions.delete(key);
        // Clean up any pending promises
        const pending = this._pending.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Room closed'));
          this._pending.delete(key);
        }
        // Retain this._codexSessions sid — native `codex resume --last`
        // semantics: closing terminal does not delete session state.
      }
    }
    // Close any ACP (Gemini) sessions for this room.
    for (const [key, slot] of this._acp.entries()) {
      if (key.startsWith(roomId + ':')) {
        slot.client.close().catch(() => {});
        this._acp.delete(key);
      }
    }
  }

  /**
   * Close all team sessions.
   */
  closeAll() {
    for (const [key, hubSessionId] of this._sessions.entries()) {
      const proc = this._codexProcs.get(key);
      if (proc) { try { proc.kill('SIGKILL'); } catch {} }
      if (hubSessionId && hubSessionId !== 'gemini-deferred' && hubSessionId !== 'codex-deferred') {
        this._sessionManager.closeSession(hubSessionId);
      }
      const pending = this._pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('All sessions closed'));
      }
    }
    this._sessions.clear();
    this._pending.clear();
    this._codexProcs.clear();
    this._characters.clear();   // symmetric with _sessions; prevents stale character obj reuse
    // Retain this._codexSessions across closeAll — persistent session state.
    for (const [, slot] of this._acp.entries()) {
      slot.client.close().catch(() => {});
    }
    this._acp.clear();
  }

  /**
   * List active session keys for a room.
   * @returns {string[]} characterIds with active sessions
   */
  getRoomSessions(roomId) {
    const result = [];
    for (const key of this._sessions.keys()) {
      if (key.startsWith(roomId + ':')) {
        result.push(key.split(':')[1]);
      }
    }
    for (const key of this._acp.keys()) {
      if (key.startsWith(roomId + ':')) {
        result.push(key.split(':')[1]);
      }
    }
    return result;
  }

  /**
   * Codex path: fresh `codex exec --json` per message, chained via
   * `codex exec resume <prior_sid>` to preserve full conversation state.
   *
   * Why this mechanism:
   * - Codex 0.121.0 has no persistent PTY-friendly interactive stdin (same
   *   Gemini-style blockers would apply).
   * - Official `codex exec resume` reads the rollout JSONL file written by the
   *   prior exec (~/.codex/sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl) and
   *   fully restores system messages, tool calls, reasoning — equivalent to
   *   native `codex resume --last`.
   * - JSONL stdout (`thread.started` + `item.completed` w/ agent_message)
   *   parses upstream, avoiding TUI scraping.
   *
   * @returns {Promise<{ content: string, eventId?: string }>}
   */
  _sendMessageCodex(roomId, characterId, text, timeout, onEvent = null) {
    const key = `${roomId}:${characterId}`;
    const character = this._characters.get(key);
    if (!character) return Promise.reject(new Error(`No cached character for ${key}`));

    if (this._pending.has(key)) {
      return Promise.reject(new Error(`Already waiting for response from ${key}`));
    }

    const personaFile = path.join(CODEX_PERSONAS_DIR, `${roomId}-${characterId}.md`);
    // Path safety: shell:true (Windows .cmd shim) means unsafe chars in
    // personaFile could be interpreted by cmd.exe. Whitelist alnum / dot /
    // slash / dash / underscore / colon. Any other char = reject.
    if (/[^\w.:/\\\-]/.test(personaFile)) {
      return Promise.reject(new Error(
        `codex persona path contains unsafe shell chars: ${personaFile}`));
    }
    const priorSid = this._codexSessions.get(key);

    const args = ['exec'];
    if (priorSid) args.push('resume', priorSid);
    args.push(
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '-c', `model_instructions_file=${personaFile}`,
      '-'   // prompt via stdin to avoid Windows shell-quoting surprises
    );

    const env = this._buildCodexEnv(roomId, characterId);

    console.warn(`[team-tsm] codex spawn key=${key} resume=${priorSid || '(first)'} promptLen=${text.length}`);
    const proc = spawn('codex', args, {
      cwd: this._roomProjectDirs.get(roomId) || os.homedir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32', // codex on Windows is a .cmd shim
    });
    this._codexProcs.set(key, proc);
    proc.stdin.write(text);
    proc.stdin.end();

    return new Promise((resolve, reject) => {
      // StringDecoder handles multi-byte UTF-8 chunk boundaries correctly
      // (Chinese personas/responses would otherwise get U+FFFD replacement).
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let stdoutRemainder = '';
      let stderrBuf = '';
      let finalText = '';
      let capturedSid = null;
      let tokenCount = null;

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        this._codexProcs.delete(key);
        this._pending.delete(key);
        console.warn(`[team-tsm] codex TIMEOUT key=${key} after ${timeout}ms stderr.tail=${JSON.stringify(stderrBuf.slice(-400))}`);
        reject(new Error(`codex exec timeout after ${timeout}ms for ${key}`));
      }, timeout);

      // Guard against re-entry; resolve/reject happen locally (no MCP callback).
      this._pending.set(key, { resolve: () => {}, reject: () => {}, timer });

      proc.stdout.on('data', (chunk) => {
        stdoutRemainder += stdoutDecoder.write(chunk);
        let nl;
        while ((nl = stdoutRemainder.indexOf('\n')) >= 0) {
          const line = stdoutRemainder.slice(0, nl).trim();
          stdoutRemainder = stdoutRemainder.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          // session_id: `thread.started` event carries `thread_id` (verified POC-3).
          // On `codex exec resume <sid>` the emitted thread_id equals priorSid,
          // so overwriting is safe and future-proofs against codex versions
          // that might mint new thread_ids per resume.
          if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
            capturedSid = ev.thread_id;
          }
          if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
            finalText = ev.item.text;
          }
          if (ev.type === 'turn.completed' && ev.usage) {
            tokenCount = {
              input: ev.usage.input_tokens ?? 0,
              output: ev.usage.output_tokens ?? 0,
              cached: ev.usage.cached_input_tokens ?? 0,
            };
          }
        }
      });

      proc.stderr.on('data', (c) => { stderrBuf += stderrDecoder.write(c); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this._codexProcs.delete(key);
        this._pending.delete(key);

        // Flush StringDecoder to catch any trailing bytes as final chars.
        const tail = stdoutDecoder.end();
        if (tail) stdoutRemainder += tail;
        // Any complete JSON line in stdoutRemainder after flush?
        if (stdoutRemainder) {
          const finalLine = stdoutRemainder.trim();
          if (finalLine) {
            try {
              const ev = JSON.parse(finalLine);
              if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') capturedSid = ev.thread_id;
              if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') finalText = ev.item.text;
            } catch {}
          }
        }
        stderrBuf += stderrDecoder.end();

        if (code !== 0 || !finalText) {
          // Detect resume failure: stderr hints session missing / bad sid.
          if (priorSid && /session not found|cannot resume|no such session/i.test(stderrBuf)) {
            this._codexSessions.delete(key);
            console.warn(`[team-tsm] codex resume failed for ${key}, sid cleared for next send`);
          }
          console.warn(`[team-tsm] codex exit=${code} finalText.len=${finalText.length} stderr.tail=${JSON.stringify(stderrBuf.slice(-400))}`);
          reject(new Error(`codex exec exited code=${code} finalText.len=${finalText.length}`));
          return;
        }

        // Always record the latest sid (defensive — current codex 0.121.0
        // keeps the same thread_id across resume, but future versions may
        // mint new IDs and we must follow the chain).
        if (capturedSid) {
          if (capturedSid !== priorSid) {
            console.warn(`[team-tsm] codex sid update key=${key} ${priorSid || '(first)'} -> ${capturedSid}`);
          }
          this._codexSessions.set(key, capturedSid);
          this._persistSession(roomId, characterId, 'codex', capturedSid);
        }

        // Persist event + notify Hub (mirrors what Claude's team_respond MCP
        // tool + Gemini's AfterAgent hook do; codex has no hook so we do it).
        try { this._writeTeamDbEvent(roomId, characterId, finalText); }
        catch (e) { console.warn(`[team-tsm] codex team.db write failed key=${key}: ${e.message}`); }
        this._postHubCallback(roomId, characterId, finalText);

        resolve({ content: finalText, tokenCount });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this._codexProcs.delete(key);
        this._pending.delete(key);
        reject(err);
      });
    });
  }

  /**
   * Write persona file for codex `-c model_instructions_file=<path>`.
   * Same template shape as _writePromptFile for consistency.
   */
  _writeCodexPersona(roomId, character) {
    fs.mkdirSync(CODEX_PERSONAS_DIR, { recursive: true });
    const filePath = path.join(CODEX_PERSONAS_DIR, `${roomId}-${character.id}.md`);
    const displayName = character.display_name || character.id;
    const content = `你是${displayName}，团队中的Codex。可用 MCP 工具查阅记忆（recall_facts）、记录发现（write_fact）。直接输出文本回复，不需要调用 team_respond。以原生Codex的专业风格回复，不要角色扮演。`;
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Build a whitelist env for codex exec — no wholesale os.environ inheritance.
   */
  _buildCodexEnv(roomId, characterId) {
    const out = {
      PATH:         process.env.PATH,
      USERPROFILE:  process.env.USERPROFILE,
      HOMEDRIVE:    process.env.HOMEDRIVE,
      HOMEPATH:     process.env.HOMEPATH,
      TEMP:         process.env.TEMP,
      TMP:          process.env.TMP,
      SystemRoot:   process.env.SystemRoot,
      APPDATA:      process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      HTTP_PROXY:   process.env.HTTP_PROXY  || CLI_PROXY,
      HTTPS_PROXY:  process.env.HTTPS_PROXY || CLI_PROXY,
      NO_PROXY:     process.env.NO_PROXY    || '127.0.0.1,localhost',
      PYTHONUTF8:   '1',
      AI_TEAM_DIR,
      AI_TEAM_ROOM_ID: roomId,
      AI_TEAM_CHARACTER_ID: characterId,
      AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
    };
    // Passthrough Codex-specific auth/config env vars when user sets them
    // (conditional — don't inject empty strings that would override the
    // normal ~/.codex/auth.json login flow).
    for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
                     'OPENAI_PROJECT_ID', 'CODEX_HOME']) {
      if (process.env[k]) out[k] = process.env[k];
    }
    return out;
  }

  /**
   * Insert a message event into team.db events table.
   * Schema: (room_id, actor, kind='message', content, ts).
   */
  _writeTeamDbEvent(roomId, actor, content) {
    const db = new DatabaseSync(TEAM_DB_PATH);
    try {
      db.prepare(
        "INSERT INTO events (room_id, actor, kind, content, ts) VALUES (?, ?, 'message', ?, ?)"
      ).run(roomId, actor, content, String(Math.floor(Date.now() / 1000)));
    } finally {
      db.close();
    }
  }

  /**
   * POST the captured Codex response to Hub's /api/team/response endpoint
   * (same endpoint the ai-team MCP team_respond tool calls for Claude).
   * Fire-and-forget — any error is logged but does not reject sendMessage.
   */
  _postHubCallback(roomId, actor, content) {
    const body = JSON.stringify({ room_id: roomId, character_id: actor, content });
    const req = http.request({
      hostname: '127.0.0.1',
      port: this._hookPort,
      path: '/api/team/response',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => { res.resume(); /* drain */ });
    req.on('error', (e) => {
      console.warn(`[team-tsm] codex hub callback error: ${e.message}`);
    });
    req.write(body);
    req.end();
  }

  /**
   * Write system prompt file for a character in a team context.
   * @returns {string} path to prompt file
   */
  _writePromptFile(roomId, character, cliKind) {
    fs.mkdirSync(PROMPT_DIR, { recursive: true });
    // Gemini gets its own prompt file — the Claude/Codex variant orders the
    // model to call `team_respond`, which does not exist on the ACP path and
    // sends Gemini into a lookup-loop ("where is team_respond?") that wastes
    // multiple seconds per turn and sometimes stalls.
    const suffix = cliKind === 'gemini' ? '-gemini' : '';
    const filePath = path.join(PROMPT_DIR, `${roomId}-${character.id}${suffix}.md`);

    const displayName = character.display_name || character.id;
    const cliLabel = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' }[cliKind] || cliKind;
    const tailLine = cliKind === 'gemini'
      ? '回复会被系统自动转发给队友。'
      : '回复完成后调用 team_respond 工具分享给队友。';
    let content = `你是${displayName}，团队中的${cliLabel}。${tailLine}以原生${cliLabel}的专业风格回复，不要角色扮演。`;

    if (cliKind === 'gemini') {
      const projDir = this._roomProjectDirs.get(roomId);
      if (projDir) {
        for (const name of ['GEMINI.md', 'CLAUDE.md']) {
          try {
            const md = fs.readFileSync(path.join(projDir, name), 'utf-8');
            if (md.trim()) {
              content += `\n\n--- Project Instructions (${name}) ---\n` + md.slice(0, 4000);
              break;
            }
          } catch {}
        }
      }
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Write MCP config for a character. Format depends on backing CLI:
   *   - Claude: JSON file → passed via --mcp-config <path>
   *   - Gemini: .gemini/settings.json in session cwd (read by Gemini CLI)
   *   - Codex: global ~/.codex/config.toml [mcp_servers.ai-team] — env passthrough verified 2026-04-21
   * @returns {string} path (Claude: config file; Gemini: session cwd)
   */
  _writeMcpConfig(roomId, character) {
    const cliKind = this._cliKind(character.backing_cli);
    const mcpServerSpec = {
      command: 'python',
      args: ['-m', 'ai_team.mcp_server'],
      cwd: AI_TEAM_DIR,
      env: {
        AI_TEAM_ROOM_ID: roomId,
        AI_TEAM_CHARACTER_ID: character.id,
        AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
        PYTHONUTF8: '1',
      },
    };

    if (cliKind === 'gemini') {
      // Gemini reads .gemini/ from its cwd (no --mcp-config flag). We create a
      // per-character workdir with .gemini/settings.json for MCP config, and
      // copy global auth files so the session inherits the user's OAuth tokens.
      const workdir = path.join(MCP_CONFIG_DIR, `gemini-${roomId}-${character.id}`);
      const geminiDir = path.join(workdir, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      // Read global ~/.gemini/settings.json and merge our mcpServers into it.
      // If we only write mcpServers, Gemini CLI treats our file as a full
      // override and loses the auth config → "Waiting for authentication".
      const globalGemini = path.join(os.homedir(), '.gemini');
      let globalSettings = {};
      try {
        const raw = fs.readFileSync(path.join(globalGemini, 'settings.json'), 'utf-8');
        globalSettings = JSON.parse(raw);
      } catch {}
      const settings = {
        ...globalSettings,
        mcpServers: {
          ...(globalSettings.mcpServers || {}),
          'ai-team': {
            ...mcpServerSpec,
            timeout: 600000,
            trust: true,
          },
        },
      };
      fs.writeFileSync(path.join(geminiDir, 'settings.json'),
        JSON.stringify(settings, null, 2), 'utf-8');
      // Copy global auth credential files
      for (const authFile of ['oauth_creds.json', 'google_accounts.json', 'installation_id']) {
        const src = path.join(globalGemini, authFile);
        const dst = path.join(geminiDir, authFile);
        try { if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst); } catch {}
      }
      return workdir;
    }

    // Default (Claude): standalone JSON config file
    fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true });
    const filePath = path.join(MCP_CONFIG_DIR, `${roomId}-${character.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { 'ai-team': mcpServerSpec } }, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Wait for CLI to show its ready prompt.
   * Detects Claude tipbox/prompt, Gemini workspace/version markers, Codex model markers.
   * Auto-dismisses Codex update dialogs.
   */
  _waitForReady(pty, cliKind, character, timeoutMs = 60000) {
    return new Promise((resolve) => {
      let buffer = '';
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        dispose();
        // Resolve anyway — CLI might be ready but without expected marker
        console.warn(`[team-tsm] _waitForReady timeout for ${character.id} (${cliKind}), proceeding`);
        resolve();
      }, timeoutMs);

      const dispose = () => {
        if (watcher) { try { watcher.dispose(); } catch {} }
        clearTimeout(timer);
      };

      let watcher;

      const checkReady = (data) => {
        buffer += data;
        // Claude: look for prompt marker or tips box
        if (cliKind === 'claude' || cliKind === 'claude-resume') {
          // Claude CLI prompt marker ❯ may be followed by ANSI escapes, cursor
          // save/restore codes, etc. Just check presence + some bulk output so
          // we don't match a stray early byte.
          if (buffer.length > 200 && (buffer.includes('❯') || buffer.includes('bypass permissions') || buffer.includes('Tips:'))) {
            return true;
          }
        }
        // Gemini: workspace or version marker
        if (cliKind === 'gemini') {
          if (buffer.includes('Workspace:') || buffer.includes('Gemini CLI') || /v\d+\.\d+/.test(buffer)) {
            return true;
          }
        }
        // Codex: model marker or update dialog
        if (cliKind === 'codex') {
          // Auto-dismiss update dialog
          if (buffer.includes('Update available') || buffer.includes('update')) {
            pty.write('\r\n');
          }
          if (buffer.includes('model') || buffer.includes('Codex')) {
            return true;
          }
        }
        return false;
      };

      watcher = pty.onData((data) => {
        if (resolved) return;
        if (checkReady(data)) {
          resolved = true;
          dispose();
          resolve();
        }
      });
    });
  }

  /**
   * Spin up (or reuse) a Gemini ACP session for a character.
   * Returns a synthetic hub session id of the form "acp:<sessionId>" so
   * callers treating session ids opaquely keep working.
   */
  async _ensureGeminiAcpSession(roomId, character) {
    const key = `${roomId}:${character.id}`;
    const existing = this._acp.get(key);
    if (existing) return `acp:${existing.sessionId}`;

    // Dedupe concurrent calls for the same key so we never double-spawn the
    // ACP child process. Later callers await the same Promise.
    const inflight = this._acpPending.get(key);
    if (inflight) return inflight;

    const promise = this._spawnGeminiAcpSession(roomId, character, key);
    this._acpPending.set(key, promise);
    try {
      return await promise;
    } finally {
      this._acpPending.delete(key);
    }
  }

  async _spawnGeminiAcpSession(roomId, character, key) {
    const geminiEntry = findGeminiEntry();
    if (!geminiEntry) {
      throw new Error('Gemini CLI not found. Install @google/gemini-cli (npm i -g @google/gemini-cli) or set HUB_GEMINI_ENTRY.');
    }

    // System prompt — Gemini CLI reads GEMINI_SYSTEM_MD as a markdown file path.
    const promptFile = this._writePromptFile(roomId, character, 'gemini');

    // Dedicated scratch directory as the ACP session cwd. We drop a workspace
    // settings.json that disables Gemini's interactive-shell tool: its bundled
    // node-pty tries AttachConsole during tool registry init, which fails
    // inside our piped stdio and crashes the whole ACP process the moment the
    // first prompt arrives. Workspace settings merge on top of ~/.gemini/
    // settings.json, so the user's OAuth selectedType is preserved.
    const acpWorkdir = path.join(MCP_CONFIG_DIR, `acp-${roomId}-${character.id}`);
    const acpGeminiDir = path.join(acpWorkdir, '.gemini');
    fs.mkdirSync(acpGeminiDir, { recursive: true });
    // - tools.core          built-in allowlist. We only enable no-side-effect
    //                        tools. `run_shell_command` is intentionally off:
    //                        its bundled node-pty crashes with AttachConsole
    //                        failed inside piped stdio. fs/terminal operations
    //                        are separately denied by acp-client's reverse-
    //                        request handler.
    //                        Exact names come from bundle/chunk-*.js:
    //                          WEB_SEARCH_TOOL_NAME = "google_web_search"
    // - tools.shell...:false  belt-and-suspenders shell disable.
    fs.writeFileSync(
      path.join(acpGeminiDir, 'settings.json'),
      JSON.stringify({
        tools: {
          core: ['google_web_search'],
          shell: { enableInteractiveShell: false },
        },
      }, null, 2),
      'utf-8',
    );

    const env = {
      ...process.env,
      HTTP_PROXY: CLI_PROXY,
      HTTPS_PROXY: CLI_PROXY,
      NO_PROXY: 'localhost,127.0.0.1',
      GEMINI_SYSTEM_MD: promptFile,
      AI_TEAM_ROOM_ID: roomId,
      AI_TEAM_CHARACTER_ID: character.id,
      AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
    };
    delete env.DEBUG;
    // Make sure CLAUDE_HUB_DATA_DIR stays propagated for parallel test hubs.
    if (process.env.CLAUDE_HUB_DATA_DIR) {
      env.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
    }

    const client = new AcpClient({ geminiEntry, env });
    client.on('stderr', (s) => {
      const line = s.trimEnd();
      if (line) console.log(`[team-tsm][acp:${character.id}] ${line.slice(0, 400)}`);
    });
    client.on('error', (err) => console.warn(`[team-tsm][acp:${character.id}] error: ${err.message}`));
    client.on('exit', ({ code, signal }) => {
      console.log(`[team-tsm][acp:${character.id}] exit code=${code} sig=${signal}`);
      this._acp.delete(key);
    });

    try {
      await client.start();
      await client.initialize();
      // ai-team MCP: gives the Gemini session team_respond + memory + data
      // access, matching what Claude's `--mcp-config` path already wires in.
      // ACP's zMcpServerStdio (gemini.js:10560-10566) uses `env:[{name,value}]`
      // (array, not object) and has no `cwd` field, so we inject PYTHONPATH
      // so Python can still find the ai_team package.
      const AI_TEAM_HUB_CALLBACK_URL = `http://127.0.0.1:${this._hookPort}`;
      const mcpServers = [{
        name: 'ai-team',
        command: 'python',
        args: ['-m', 'ai_team.mcp_server'],
        env: [
          { name: 'PYTHONPATH', value: AI_TEAM_DIR },
          { name: 'PYTHONUTF8', value: '1' },
          { name: 'AI_TEAM_ROOM_ID', value: roomId },
          { name: 'AI_TEAM_CHARACTER_ID', value: character.id },
          { name: 'AI_TEAM_HUB_CALLBACK_URL', value: AI_TEAM_HUB_CALLBACK_URL },
        ],
      }];
      const sessionId = await client.newSession({
        cwd: acpWorkdir,
        mcpServers,
        modeId: 'yolo',
      });
      // Honor per-character model if the DB specifies one (e.g. gemini-3-pro).
      // Unknown modelIds are logged but don't fail session creation.
      if (character.model) {
        try {
          await client.setModel(sessionId, character.model);
        } catch (e) {
          console.warn(`[team-tsm][acp:${character.id}] setModel(${character.model}) failed: ${e.message}`);
        }
      }
      this._acp.set(key, { client, sessionId });
      return `acp:${sessionId}`;
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  async _sendGeminiAcpMessage(key, text, timeoutMs, onEvent, characterId) {
    const slot = this._acp.get(key);
    if (!slot) throw new Error(`No ACP session for ${key}`);
    const { client, sessionId } = slot;

    // Relay agent_thought_chunk events out as thinking_delta so the renderer
    // can show Gemini's live reasoning inline with the "思考中" indicator.
    let thoughtListener = null;
    if (typeof onEvent === 'function') {
      thoughtListener = ({ sessionId: sid, text: thText }) => {
        if (sid !== sessionId || !thText) return;
        try {
          onEvent('event', {
            type: 'thinking_delta',
            actor: characterId,
            text: thText,
            ts: Math.floor(Date.now() / 1000),
          });
        } catch {}
      };
      client.on('agent-thought', thoughtListener);
    }

    // Capture the content argument of any team_respond tool_call so we can
    // fall back to it when Gemini decides to ship its final answer via the
    // MCP tool instead of agent_message_chunk (the latter leaves prompt().text
    // empty). Take the last one — later invocations override earlier drafts.
    let teamRespondContent = '';
    const updateListener = ({ sessionId: sid, update }) => {
      if (sid !== sessionId || !update) return;
      const kind = update.sessionUpdate;
      if ((kind === 'tool_call' || kind === 'tool_call_update')
          && typeof update.title === 'string'
          && update.title.includes('team_respond')
          && update.rawInput && typeof update.rawInput.content === 'string') {
        teamRespondContent = update.rawInput.content;
      }
    };
    client.on('session-update', updateListener);

    try {
      const result = await client.prompt(sessionId, text, timeoutMs);
      const content = (result.text && result.text.trim())
        ? result.text
        : teamRespondContent;
      // Surface token_count from ACP's _meta.quota so the UI can show
      // "↓ input ↑ output" without us having to extend the events DB schema.
      // Also include the actual model used (from model_usage[0].model) so
      // callers can verify set_model actually took effect.
      const tc = result?.meta?.quota?.token_count;
      const mu = Array.isArray(result?.meta?.quota?.model_usage) ? result.meta.quota.model_usage[0] : null;
      const tokenCount = tc && (tc.input_tokens != null || tc.output_tokens != null)
        ? { input: tc.input_tokens ?? 0, output: tc.output_tokens ?? 0, model: mu?.model || null }
        : null;
      // Persist to team.db when Gemini replied via agent_message_chunk (not
      // team_respond MCP tool). If teamRespondContent was used, the Python MCP
      // server already inserted the row — writing again would duplicate.
      if (content && content !== teamRespondContent) {
        const roomId = key.split(':')[0];
        try { this._writeTeamDbEvent(roomId, characterId, content); }
        catch (e) { console.warn(`[team-tsm] gemini team.db write failed: ${e.message}`); }
      }
      return { content, eventId: null, tokenCount };
    } finally {
      if (thoughtListener) {
        try { client.off('agent-thought', thoughtListener); } catch {}
      }
      try { client.off('session-update', updateListener); } catch {}
    }
  }

  /**
   * Map backing_cli string to session kind understood by SessionManager.
   */
  _cliKind(backingCli) {
    if (!backingCli || backingCli === 'claude') return 'claude';
    if (backingCli === 'gemini') return 'gemini';
    if (backingCli === 'codex') return 'codex';
    return 'claude';
  }
}

module.exports = { TeamSessionManager };
