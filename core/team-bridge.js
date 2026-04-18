'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const AI_TEAM_DIR = path.join(os.homedir(), '.ai-team');
const DB_PATH = path.join(AI_TEAM_DIR, 'team.db');

class TeamBridge {
  constructor() {
    this.baseDir = AI_TEAM_DIR;
    this._runningProc = null;
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

  // Spawn the full Python orchestrator for a @team question
  askTeam(roomId, message, onEvent, timeout = 300000) {
    const env = Object.assign({}, process.env, {
      PYTHONUTF8: '1',
      CLAUDE_CODE_SKIP_HOOKS: '1',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
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

    // Timeout guard
    const timer = setTimeout(() => {
      proc.kill();
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
      proc.on('close', (code) => {
        clearTimeout(timer);
        this._runningProc = null;
        if (onEvent) onEvent('done', { code });
        if (code !== 0) {
          reject(new Error(`Orchestrator exit ${code}: ${stderr.substring(0, 300)}`));
        } else {
          resolve({ code, stderr });
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        this._runningProc = null;
        reject(err);
      });
    });
  }

  async createRoom(name, memberIds) {
    const id = 'room-' + Date.now();
    const roomDir = path.join(this.baseDir, 'rooms');
    if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });

    // Write YAML
    const yaml = [
      `id: "${id}"`,
      `display_name: "${name.replace(/"/g, '\\"')}"`,
      `members: [${memberIds.map(m => `"${m}"`).join(', ')}]`,
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
  }

  // Helper: run bridge_query.py with given args, parse JSON output
  _pyScript(args, timeoutMs = 30000) {
    const scriptPath = path.join(this.baseDir, 'ai_team', 'bridge_query.py');
    return new Promise((resolve, reject) => {
      const proc = spawn('python', [scriptPath, ...args], {
        env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
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
