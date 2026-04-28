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

function factEntry({ what, why, status, source }) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `## ${what}`,
    `**What**: ${what}`,
    `**Why**: ${why}`,
    `**Status**: ${status}`,
    `**Source**: ${source} / ${today}`,
    '',
  ].join('\n');
}

const FACTS_HEADER = `# Project Facts (.arena/memory/shared/facts.md)
> 由 Hub 主驾模式自动管理。What/Why/Status 三段式。Hub 内部代写，AI 不直接写。

`;

async function appendFact(projectCwd, { what, why, status, source }) {
  if (!what || !why || !status) throw new Error('appendFact requires what/why/status');
  const sharedDir = path.join(getMemoryDir(projectCwd), 'shared');
  ensureDir(sharedDir);
  const filePath = path.join(sharedDir, 'facts.md');
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : FACTS_HEADER;
  // 去重：以 "## <what>" 行为唯一键，存在则跳过
  const heading = `## ${what}`;
  if (content.split('\n').some((line) => line.trim() === heading)) {
    return { added: false, reason: 'duplicate' };
  }
  if (!content.endsWith('\n\n')) content += content.endsWith('\n') ? '\n' : '\n\n';
  content += factEntry({ what, why, status, source: source || 'manual' });
  content += '\n---\n\n';
  fs.writeFileSync(filePath + '.tmp', content, 'utf-8');
  fs.renameSync(filePath + '.tmp', filePath);
  return { added: true };
}

module.exports = { getMemoryDir, ensureDir, appendEpisode, appendFact };
