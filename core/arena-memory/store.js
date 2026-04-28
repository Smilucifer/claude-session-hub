// core/arena-memory/store.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getMemoryDir(projectCwd) {
  return path.join(projectCwd, '.arena', 'memory');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function appendEpisode(projectCwd, event) {
  const dir = getMemoryDir(projectCwd);
  ensureDir(dir);
  const filePath = path.join(dir, 'episodes.jsonl');
  const line = JSON.stringify({ v: 1, ts: Date.now(), ...event }) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');
}

module.exports = { getMemoryDir, ensureDir, appendEpisode };
