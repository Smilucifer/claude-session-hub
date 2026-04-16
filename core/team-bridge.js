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
      proc.kill('SIGTERM');
      if (onEvent) onEvent('error', { message: 'Timeout after ' + timeout + 'ms' });
    }, timeout);

    let stdout = '';
    proc.stdout.on('data', (data) => {
      const chunk = data.toString('utf-8');
      stdout += chunk;
      const lines = stdout.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (onEvent) onEvent('stdout', lines[i]);
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

  cleanup() {
    if (this._runningProc) {
      this._runningProc.kill('SIGTERM');
      this._runningProc = null;
    }
  }

  // Helper: run bridge_query.py with given args, parse JSON output
  _pyScript(args) {
    const scriptPath = path.join(this.baseDir, 'ai_team', 'bridge_query.py');
    return new Promise((resolve, reject) => {
      const proc = spawn('python', [scriptPath, ...args], {
        env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      proc.stdout.on('data', d => out += d.toString('utf-8'));
      proc.stderr.on('data', d => err += d.toString('utf-8'));
      proc.on('close', (code) => {
        if (code !== 0) { reject(new Error(`bridge_query exit ${code}: ${err.substring(0, 300)}`)); return; }
        try { resolve(JSON.parse(out.trim())); }
        catch (e) { reject(new Error(`JSON parse: ${out.substring(0, 200)}`)); }
      });
    });
  }
}

module.exports = { TeamBridge };
