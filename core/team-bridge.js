'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { buildBootstrap } = require('./session-bootstrap');
const AI_TEAM_DIR = path.join(os.homedir(), '.ai-team');
const DB_PATH = path.join(AI_TEAM_DIR, 'team.db');

class TeamBridge {
  constructor() {
    this.baseDir = AI_TEAM_DIR;
    this._runningProc = null;
    this._teamSessionManager = null;
    // Per-character read pointer: Map<"roomId:charId", number> (event cursor)
    this._readPointers = new Map();
  }

  /** Injected by main.js after hookPort is known. */
  setTeamSessionManager(tsm) {
    this._teamSessionManager = tsm;
  }

  isInitialized() {
    return fs.existsSync(DB_PATH) &&
           fs.existsSync(path.join(this.baseDir, 'characters')) &&
           fs.existsSync(path.join(this.baseDir, 'rooms'));
  }

  async loadRooms() {
    return this._pyScript(['rooms']);
  }

  async loadCharacters() {
    return this._pyScript(['characters']);
  }

  async getEvents(roomId, limit = 50) {
    if (typeof roomId !== 'string') throw new Error('roomId must be string');
    if (!Number.isInteger(limit)) limit = 50;
    return this._pyScript(['events', roomId, String(limit)]);
  }

  async getWiki(roomId) {
    if (typeof roomId !== 'string') throw new Error('roomId must be string');
    return this._pyScript(['wiki', roomId]);
  }

  async getRoomPreviews() {
    return this._pyScript(['room-previews']);
  }

  async getWikiCandidates(roomId) {
    if (typeof roomId !== 'string') throw new Error('roomId must be string');
    return this._pyScript(['wiki-candidates', roomId]);
  }

  async approveWiki(factId) {
    if (typeof factId !== 'string') throw new Error('factId must be string');
    return this._pyScript(['wiki-approve', factId]);
  }

  async rejectWiki(factId) {
    if (typeof factId !== 'string') throw new Error('factId must be string');
    return this._pyScript(['wiki-reject', factId]);
  }

  async exportConversation(roomId) {
    if (typeof roomId !== 'string') throw new Error('roomId must be string');
    return this._pyScript(['export', roomId]);
  }

  deleteRoom(roomId) {
    if (typeof roomId !== 'string') throw new Error('roomId must be string');
    // 1. Delete YAML config (this is what loadRooms reads via bridge_query.py)
    const yamlPath = path.join(this.baseDir, 'rooms', `${roomId}.yaml`);
    try { fs.unlinkSync(yamlPath); } catch {}
    // 2. Delete DB rows (events + room record)
    const dbPath = path.join(this.baseDir, 'team.db');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('DELETE FROM events WHERE room_id = ?').run(roomId);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    } finally {
      db.close();
    }
  }

  async askTeam(roomId, message, onEvent, timeout = 300000) {
    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('message must be non-empty string');
    }
    if (message.length > 8192) {
      throw new Error('message too long (max 8192)');
    }

    // If TeamSessionManager is available, use MCP callback flow
    if (this._teamSessionManager) {
      return this._askTeamPTY(roomId, message, onEvent, timeout);
    }

    // Fallback: legacy subprocess orchestrator
    return this._askTeamLegacy(roomId, message, onEvent, timeout);
  }

  /**
   * MCP callback flow: parse @mentions, send to each target via persistent PTY,
   * wait for team_respond callback.
   */
  async _askTeamPTY(roomId, message, onEvent, timeout = 300000) {
    // Load characters for the room
    const allCharacters = await this._pyScript(['characters']);
    const rooms = await this._pyScript(['rooms']);
    const room = rooms.find(r => r.id === roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);

    const memberIds = room.members || [];

    // Parse @mentions: @team/@全体 → all members, @name → specific character
    let targets = [];
    const mentionRegex = /@(\S+)/g;
    let match;
    let hasExplicitMention = false;

    while ((match = mentionRegex.exec(message)) !== null) {
      const name = match[1];
      if (name === 'team' || name === '全体') {
        targets = memberIds.slice();
        hasExplicitMention = true;
        break;
      }
      // Match by id or display_name
      for (const [charId, char] of Object.entries(allCharacters)) {
        if (charId === name || char.display_name === name || char.id === name) {
          if (!targets.includes(charId)) targets.push(charId);
          hasExplicitMention = true;
          break;
        }
      }
    }

    // Default: mention all members if no explicit mention
    if (!hasExplicitMention) {
      targets = memberIds.slice();
    }

    if (targets.length === 0) {
      throw new Error('No valid targets found in room');
    }

    // Persist user message to DB
    await this._pyScript(['insert-event', roomId, 'user', 'message', message]);

    const results = [];

    // Parallel dispatch — each character runs independently (different _pending
    // keys, separate CLI processes). Wall time ≈ max(single) instead of sum(all).
    const dispatches = targets.map(charId => {
      const character = allCharacters[charId];
      if (!character) {
        console.warn(`[team-bridge] character not found: ${charId}`);
        return null;
      }
      if (onEvent) onEvent('event', {
        type: 'thinking',
        actor: charId,
        name: character.display_name || charId,
      });
      return (async () => {
        await this._teamSessionManager.ensureSession(roomId, character);

        const cursor = this._getReadPointer(roomId, charId);
        let history = [];
        try {
          history = await this._pyScript(['events-since', roomId, String(cursor)]);
        } catch (e) {
          console.warn(`[team-bridge] events-since failed: ${e.message}`);
        }
        if (history.length > 30) {
          history = history.slice(history.length - 30);
        }

        let injectedText = buildBootstrap(roomId, charId);
        if (history.length > 0) {
          injectedText += '--- 最近的对话记录 ---\n';
          for (const evt of history) {
            if (evt.kind === 'message') {
              const actorName = (allCharacters[evt.actor] && allCharacters[evt.actor].display_name) || evt.actor;
              injectedText += `[${actorName}]: ${evt.content}\n`;
            }
          }
          injectedText += '--- 记录结束 ---\n\n';
        }
        injectedText += `[用户消息]: ${message}\n\n`;
        injectedText += '请认真思考后给出你的回复。回复完成后，务必调用 team_respond 工具分享给队友。';

        const result = await this._teamSessionManager.sendMessage(roomId, charId, injectedText, timeout, onEvent);

        if (history.length > 0) {
          const lastRowid = Math.max(...history.map(e => Number(e.rowid) || 0));
          if (lastRowid > 0) this._setReadPointer(roomId, charId, lastRowid);
        }

        if (onEvent) onEvent('event', {
          type: 'message',
          actor: charId,
          name: character.display_name || charId,
          content: result.content,
          tokenCount: result.tokenCount || null,
          ts: Math.floor(Date.now() / 1000),
        });

        return { characterId: charId, content: result.content, tokenCount: result.tokenCount || null };
      })().catch(e => {
        console.error(`[team-bridge] error for ${charId}: ${e.message}`);
        if (onEvent) onEvent('event', {
          type: 'error',
          actor: charId,
          name: character.display_name || charId,
          content: e.message,
          ts: Math.floor(Date.now() / 1000),
        });
        return null;
      });
    }).filter(Boolean);

    const settled = await Promise.all(dispatches);
    for (const r of settled) { if (r) results.push(r); }

    if (onEvent) onEvent('done', { code: 0 });
    return { code: 0, results };
  }

  /**
   * Legacy subprocess orchestrator (fallback when TeamSessionManager unavailable).
   */
  _askTeamLegacy(roomId, message, onEvent, timeout = 300000) {
    if (this._runningProc) {
      return Promise.reject(new Error('Another orchestrator is already running'));
    }

    const env = Object.assign({}, process.env, {
      PYTHONUTF8: '1',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      AI_TEAM_ROOM_ID: roomId || '',
    });
    delete env.CLAUDE_CODE_ENTRY_POINT;
    delete env.CLAUDE_CODE_DISPLAY_NAME;
    delete env.CLAUDE_CODE_PACKAGE_DIR;
    delete env.DEBUG;

    const proc = spawn('python', [
      path.join(this.baseDir, 'integration_test.py'),
      message
    ], { cwd: this.baseDir, env, stdio: ['pipe', 'pipe', 'pipe'] });

    this._runningProc = proc;
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill();
      this._runningProc = null;
      if (onEvent) onEvent('error', { message: 'Timeout after ' + timeout + 'ms' });
    }, timeout);

    let stdout = '';
    proc.stdout.on('data', (data) => {
      const chunk = data.toString('utf-8');
      stdout += chunk;
      const lines = stdout.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line.startsWith('EVENT:')) {
          try {
            const evt = JSON.parse(line.slice(6));
            if (onEvent) onEvent('event', evt);
          } catch (e) {
            if (onEvent) onEvent('stdout', line);
          }
        } else if (line) {
          if (onEvent) onEvent('stdout', line);
        }
      }
      stdout = lines[lines.length - 1];
    });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString('utf-8'); });

    return new Promise((resolve, reject) => {
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._runningProc = null;
        if (stdout.trim()) {
          const remaining = stdout.trim();
          if (remaining.startsWith('EVENT:')) {
            try { if (onEvent) onEvent('event', JSON.parse(remaining.slice(6))); } catch {}
          } else if (onEvent) { onEvent('stdout', remaining); }
        }
        if (onEvent) onEvent('done', { code });
        if (code !== 0) {
          reject(new Error(`Orchestrator exit ${code}: ${stderr.substring(0, 300)}`));
        } else {
          resolve({ code, stderr });
        }
      };
      proc.on('close', finish);
      proc.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._runningProc = null;
        reject(err);
      });
    });
  }

  _getReadPointer(roomId, charId) {
    return this._readPointers.get(`${roomId}:${charId}`) || 0;
  }

  _setReadPointer(roomId, charId, cursor) {
    this._readPointers.set(`${roomId}:${charId}`, cursor);
  }

  async createRoom(name, memberIds) {
    const id = 'room-' + Date.now();
    const roomDir = path.join(this.baseDir, 'rooms');
    if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });

    // Write YAML
    const yaml = [
      `id: "${id}"`,
      `display_name: "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]/g, ' ')}"`,
      `members: [${memberIds.map(m => `"${m.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\]]/g, '')}"`).join(', ')}]`,
      `speech_mode: "natural"`,
      `task_mode: "divergent"`,
      `memory_bias: "balanced"`,
      `max_depth: 6`,
      `timeout_seconds: 180`,
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(roomDir, `${id}.yaml`), yaml, 'utf-8');

    // Register in DB via Python bridge
    await this._pyScript(['create-room', id, name, JSON.stringify(memberIds)]);

    return { id, display_name: name };
  }

  cleanup() {
    if (this._runningProc) {
      this._runningProc.kill();
      this._runningProc = null;
    }
    if (this._teamSessionManager) {
      this._teamSessionManager.closeAll();
    }
  }

  // Helper: run bridge_query.py with given args, parse JSON output
  _pyScript(args, timeoutMs = 30000) {
    const scriptPath = path.join(this.baseDir, 'ai_team', 'bridge_query.py');
    return new Promise((resolve, reject) => {
      const minEnv = {
        PATH: process.env.PATH,
        PYTHONUTF8: '1',
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME || process.env.USERPROFILE,
        USERPROFILE: process.env.USERPROFILE,
        HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7890',
        HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7890',
      };
      const proc = spawn('python', [scriptPath, ...args], {
        env: minEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; proc.kill(); reject(new Error(`bridge_query timeout (${timeoutMs}ms): ${args[0]}`)); }
      }, timeoutMs);
      proc.stdout.on('data', d => out += d.toString('utf-8'));
      proc.stderr.on('data', d => err += d.toString('utf-8'));
      proc.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`bridge_query exit ${code}: ${err.substring(0, 300)}`)); return; }
        try { resolve(JSON.parse(out.trim())); }
        catch (e) { reject(new Error(`JSON parse: ${out.substring(0, 200)}`)); }
      });
      proc.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

module.exports = { TeamBridge };
