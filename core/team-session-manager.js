'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { StringDecoder } = require('string_decoder');

const AI_TEAM_DIR = path.join(os.homedir(), '.ai-team');
const MCP_CONFIG_DIR = path.join(AI_TEAM_DIR, '.mcp-configs');
const PROMPT_DIR = path.join(AI_TEAM_DIR, '.prompts');
const CODEX_PERSONAS_DIR = path.join(AI_TEAM_DIR, '.codex-personas');
const TEAM_DB_PATH = path.join(AI_TEAM_DIR, 'team.db');

// Default proxy for CLI sessions
const CLI_PROXY = 'http://127.0.0.1:7890';

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
    // Map<string, hubSessionId> keyed by "roomId:characterId"
    this._sessions = new Map();
    // Map<string, { resolve, reject, timer }> keyed by "roomId:characterId"
    this._pending = new Map();
    // Map<string, character> cached between ensureSession and sendMessage
    // for deferred (one-shot) flows (Codex, and Gemini ACP after stash-pop).
    this._characters = new Map();
    // Codex path: Map<"roomId:charId", session_id> retained across messages so
    // `codex exec resume <sid>` on subsequent sends preserves full conversation
    // state (same mechanism as native `codex resume --last`).
    this._codexSessions = new Map();
    // Codex path: Map<"roomId:charId", ChildProcess> for in-flight exec procs
    // so we can SIGKILL on timeout / room close.
    this._codexProcs = new Map();
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
    pending.resolve({ content, eventId });
  }

  /**
   * Ensure a PTY session exists for (roomId, character).
   * Creates one via sessionManager if needed, with MCP config injected.
   * @param {string} roomId
   * @param {object} character — { id, display_name, backing_cli, model, personality, ... }
   * @returns {Promise<string>} hubSessionId
   */
  async ensureSession(roomId, character) {
    const key = `${roomId}:${character.id}`;
    const existing = this._sessions.get(key);
    if (existing) {
      // Check session is still alive
      const session = this._sessionManager.getSession(existing);
      if (session) return existing;
      // Dead session — clean up and recreate
      this._sessions.delete(key);
    }

    // Write MCP config (format depends on CLI) and system prompt
    const mcpConfigPath = this._writeMcpConfig(roomId, character);
    const promptFile = this._writePromptFile(roomId, character);
    const cliKind = this._cliKind(character.backing_cli);

    // Gemini reads .gemini/settings.json from cwd, so we launch the shell in
    // the per-character workdir. Claude/Codex read a file path flag.
    const sessionCwd = cliKind === 'gemini' ? mcpConfigPath : AI_TEAM_DIR;
    const createOpts = {
      title: `Team: ${character.display_name}`,
      cwd: sessionCwd,
      noInheritCursor: true,
      appendSystemPromptFile: promptFile,
      extraEnv: {
        AI_TEAM_ROOM_ID: roomId,
        AI_TEAM_CHARACTER_ID: character.id,
        AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
        CLAUDE_CODE_SKIP_HOOKS: '1',
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
  sendMessage(roomId, characterId, text, timeout = 300000) {
    const key = `${roomId}:${characterId}`;
    const hubSessionId = this._sessions.get(key);
    if (!hubSessionId) {
      return Promise.reject(new Error(`No session for ${key}`));
    }

    // Codex: fresh `codex exec` per message, chained via `exec resume <sid>`.
    if (hubSessionId === 'codex-deferred') {
      return this._sendMessageCodex(roomId, characterId, text, timeout);
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
  _sendMessageCodex(roomId, characterId, text, timeout) {
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
      cwd: AI_TEAM_DIR,
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
          // final agent reply: `item.completed` where item.type === 'agent_message'
          if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
            finalText = ev.item.text; // take last one if Codex emits multiple
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
        }

        // Persist event + notify Hub (mirrors what Claude's team_respond MCP
        // tool + Gemini's AfterAgent hook do; codex has no hook so we do it).
        try { this._writeTeamDbEvent(roomId, characterId, finalText); }
        catch (e) { console.warn(`[team-tsm] codex team.db write failed key=${key}: ${e.message}`); }
        this._postHubCallback(roomId, characterId, finalText);

        resolve({ content: finalText });
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
    const personality = character.personality || '';
    const displayName = character.display_name || character.id;
    const content = [
      `# ${displayName} — AI Team Room`,
      '',
      `你是 ${displayName}，一个 AI 团队成员。`,
      '',
      personality ? `## 性格\n${personality.trim()}\n` : '',
      `## 团队协作规则`,
      '',
      `- 你在房间 ${roomId} 中与其他 AI 角色协作讨论。`,
      `- 收到队友或用户的消息后，认真思考并直接以文本回答。`,
      `- 保持你的角色特征和说话风格一致。`,
      '',
      `[重要] 直接输出答案即可，不需要调用任何 MCP 工具（除非确实需要查团队历史用 team_list_rooms / team_read_room）。系统会从你的 stdout 提取回答。`,
    ].join('\n');
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
  _writePromptFile(roomId, character) {
    fs.mkdirSync(PROMPT_DIR, { recursive: true });
    const filePath = path.join(PROMPT_DIR, `${roomId}-${character.id}.md`);

    const personality = character.personality || '';
    const displayName = character.display_name || character.id;

    const content = [
      `# ${displayName} — AI Team Room`,
      '',
      `你是 ${displayName}，一个 AI 团队成员。`,
      '',
      personality ? `## 性格\n${personality.trim()}\n` : '',
      `## 团队协作规则`,
      '',
      `- 你在房间 ${roomId} 中与其他 AI 角色协作讨论。`,
      `- 收到队友或用户的消息后，认真思考并给出你的观点。`,
      `- 保持你的角色特征和说话风格一致。`,
      '',
      `[重要] 回复完成后，你必须调用 team_respond 工具将你的完整回复分享给队友。这是必须的步骤，不要跳过。`,
    ].join('\n');

    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Write MCP config for a character. Format depends on backing CLI:
   *   - Claude: JSON file → passed via --mcp-config <path>
   *   - Gemini: .gemini/settings.json in session cwd (read by Gemini CLI)
   *   - Codex: not implemented yet (uses --config flags; future)
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
      // Gemini reads .gemini/settings.json from its cwd (no --mcp-config flag).
      // Create a per-character workdir under MCP_CONFIG_DIR so each session
      // has its own .gemini dir.
      const workdir = path.join(MCP_CONFIG_DIR, `gemini-${roomId}-${character.id}`);
      const geminiDir = path.join(workdir, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      const settings = {
        mcpServers: {
          'ai-team': {
            ...mcpServerSpec,
            timeout: 600000,
            trust: true,
          },
        },
      };
      fs.writeFileSync(path.join(geminiDir, 'settings.json'),
        JSON.stringify(settings, null, 2), 'utf-8');
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
