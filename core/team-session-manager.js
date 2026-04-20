'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const AI_TEAM_DIR = path.join(os.homedir(), '.ai-team');
const MCP_CONFIG_DIR = path.join(AI_TEAM_DIR, '.mcp-configs');
const PROMPT_DIR = path.join(AI_TEAM_DIR, '.prompts');

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

    // Write MCP config and prompt files
    const mcpConfigFile = this._writeMcpConfig(roomId, character);
    const promptFile = this._writePromptFile(roomId, character);
    const cliKind = this._cliKind(character.backing_cli);

    // Create session via sessionManager with MCP config
    const session = this._sessionManager.createSession(cliKind, {
      title: `Team: ${character.display_name}`,
      cwd: AI_TEAM_DIR,
      noInheritCursor: true,
      appendSystemPromptFile: promptFile,
      mcpConfigFile: mcpConfigFile,
      extraEnv: {
        AI_TEAM_ROOM_ID: roomId,
        AI_TEAM_CHARACTER_ID: character.id,
        AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
        CLAUDE_CODE_SKIP_HOOKS: '1',
      },
    });

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
        this._sessionManager.closeSession(hubSessionId);
        this._sessions.delete(key);
        // Clean up any pending promises
        const pending = this._pending.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Room closed'));
          this._pending.delete(key);
        }
      }
    }
  }

  /**
   * Close all team sessions.
   */
  closeAll() {
    for (const [key, hubSessionId] of this._sessions.entries()) {
      this._sessionManager.closeSession(hubSessionId);
      const pending = this._pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('All sessions closed'));
      }
    }
    this._sessions.clear();
    this._pending.clear();
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
   * Write MCP config JSON for Claude's --mcp-config flag.
   * @returns {string} path to config file
   */
  _writeMcpConfig(roomId, character) {
    fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true });
    const filePath = path.join(MCP_CONFIG_DIR, `${roomId}-${character.id}.json`);

    const config = {
      mcpServers: {
        'ai-team': {
          command: 'python',
          args: ['-m', 'ai_team.mcp_server'],
          cwd: AI_TEAM_DIR,
          env: {
            AI_TEAM_ROOM_ID: roomId,
            AI_TEAM_CHARACTER_ID: character.id,
            AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
            PYTHONUTF8: '1',
          },
        },
      },
    };

    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
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
