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
  }

  isInitialized() {
    return fs.existsSync(DB_PATH) &&
           fs.existsSync(path.join(this.baseDir, 'characters')) &&
           fs.existsSync(path.join(this.baseDir, 'rooms'));
  }

  // Load rooms via Python (avoids js-yaml dependency)
  async loadRooms() {
    return this._pyQuery(`
import yaml, json, os
rooms = []
room_dir = os.path.join(r'${this.baseDir.replace(/\\/g, '\\\\')}', 'rooms')
for f in os.listdir(room_dir):
    if f.endswith('.yaml'):
        with open(os.path.join(room_dir, f), 'r', encoding='utf-8') as fh:
            rooms.append(yaml.safe_load(fh))
print(json.dumps(rooms, ensure_ascii=False))
`);
  }

  async loadCharacters() {
    return this._pyQuery(`
import yaml, json, os
chars = {}
char_dir = os.path.join(r'${this.baseDir.replace(/\\/g, '\\\\')}', 'characters')
for f in os.listdir(char_dir):
    if f.endswith('.yaml'):
        with open(os.path.join(char_dir, f), 'r', encoding='utf-8') as fh:
            d = yaml.safe_load(fh)
            chars[d['id']] = d
print(json.dumps(chars, ensure_ascii=False))
`);
  }

  async getEvents(roomId, limit = 50) {
    return this._pyQuery(`
import json, sys, sqlite3
conn = sqlite3.connect(r'${DB_PATH.replace(/\\/g, '\\\\')}')
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT id, actor, kind, content, mentions, ts FROM events WHERE room_id=? ORDER BY ts DESC LIMIT ?",
    (${JSON.stringify(roomId)}, ${limit})
).fetchall()
events = [dict(r) for r in rows]
events.reverse()
print(json.dumps(events, ensure_ascii=False))
conn.close()
`);
  }

  async getWiki(roomId) {
    return this._pyQuery(`
import json, sqlite3
conn = sqlite3.connect(r'${DB_PATH.replace(/\\/g, '\\\\')}')
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT id, what, why, status, importance, contributed_by FROM room_facts WHERE room_id=? AND status='active' ORDER BY importance DESC",
    (${JSON.stringify(roomId)},)
).fetchall()
print(json.dumps([dict(r) for r in rows], ensure_ascii=False))
conn.close()
`);
  }

  // Spawn the full Python orchestrator for a @team question
  askTeam(roomId, message, onEvent) {
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
        if (onEvent) onEvent('done', { code });
        resolve({ code, stderr });
      });
      proc.on('error', (err) => reject(err));
    });
  }

  // Helper: run inline Python, parse JSON output
  _pyQuery(code) {
    return new Promise((resolve, reject) => {
      const proc = spawn('python', ['-c', code], {
        env: Object.assign({}, process.env, { PYTHONUTF8: '1' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      proc.stdout.on('data', d => out += d.toString('utf-8'));
      proc.stderr.on('data', d => err += d.toString('utf-8'));
      proc.on('close', (code) => {
        if (code !== 0) { reject(new Error(`Python exit ${code}: ${err.substring(0, 300)}`)); return; }
        try { resolve(JSON.parse(out.trim())); }
        catch (e) { reject(new Error(`JSON parse: ${out.substring(0, 200)}`)); }
      });
    });
  }
}

module.exports = { TeamBridge };
