'use strict';
// General Roundtable Private Store — 私聊历史持久化
// 私聊（@<who> 单家或多家但非全员）独立存储，不入 roundtable.json 的 turns
//
// 文件结构：<arena-prompts>/<meetingId>-roundtable-private.json
// {
//   claude: [{ ts, userInput, response }, ...],
//   gemini: [{ ts, userInput, response }, ...],
//   codex:  [{ ts, userInput, response }, ...],
// }

const fs = require('fs');
const path = require('path');

const MAX_PRIVATE_TURNS_PER_KIND = 50; // 软上限，超出截断最早的

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function privateFilePath(hubDataDir, meetingId) {
  return path.join(arenaPromptsDir(hubDataDir), `${meetingId}-roundtable-private.json`);
}

function readPrivateStore(hubDataDir, meetingId) {
  const fp = privateFilePath(hubDataDir, meetingId);
  if (!fs.existsSync(fp)) return { claude: [], gemini: [], codex: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return {
      claude: Array.isArray(raw.claude) ? raw.claude : [],
      gemini: Array.isArray(raw.gemini) ? raw.gemini : [],
      codex: Array.isArray(raw.codex) ? raw.codex : [],
    };
  } catch (e) {
    console.warn(`[private-store] read failed for ${meetingId}: ${e.message}`);
    return { claude: [], gemini: [], codex: [] };
  }
}

function appendPrivateTurn(hubDataDir, meetingId, kind, userInput, response) {
  if (!['claude', 'gemini', 'codex'].includes(kind)) {
    throw new Error(`invalid kind: ${kind}`);
  }
  const store = readPrivateStore(hubDataDir, meetingId);
  store[kind].push({
    ts: Date.now(),
    userInput: typeof userInput === 'string' ? userInput : '',
    response: typeof response === 'string' ? response : '',
  });
  if (store[kind].length > MAX_PRIVATE_TURNS_PER_KIND) {
    store[kind] = store[kind].slice(-MAX_PRIVATE_TURNS_PER_KIND);
  }
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privateFilePath(hubDataDir, meetingId), JSON.stringify(store, null, 2), 'utf-8');
}

function listPrivateTurns(hubDataDir, meetingId, kind) {
  const store = readPrivateStore(hubDataDir, meetingId);
  if (kind && ['claude', 'gemini', 'codex'].includes(kind)) {
    return store[kind] || [];
  }
  return store;
}

module.exports = {
  appendPrivateTurn,
  listPrivateTurns,
  readPrivateStore,
  privateFilePath,
  MAX_PRIVATE_TURNS_PER_KIND,
};
