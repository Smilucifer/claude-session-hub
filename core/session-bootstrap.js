'use strict';
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const TEAM_DB_PATH = path.join(os.homedir(), '.ai-team', 'team.db');
const MAX_BOOTSTRAP_TOKENS = 2000;
const CHARS_PER_TOKEN = 3.5;
const MAX_CHARS = Math.floor(MAX_BOOTSTRAP_TOKENS * CHARS_PER_TOKEN);

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build a structured bootstrap prefix for a new/resumed team session.
 * Inspired by cat-cafe's SessionBootstrap (2000-token cap with priority
 * section dropping): recall → task → digest → threadMemory.
 *
 * @param {string} roomId
 * @param {string} characterId
 * @returns {string} bootstrap text to prepend to the first message
 */
function buildBootstrap(roomId, characterId) {
  const sections = [];

  let db;
  try { db = new DatabaseSync(TEAM_DB_PATH); } catch { return ''; }

  try {
    // --- Section 1: Session Continuity ---
    let sessionCount = 0;
    let lastTs = null;
    try {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt, MAX(updated_ts) as last_ts
         FROM cli_sessions WHERE room_id = ? AND character_id = ?`
      ).get(roomId, characterId);
      sessionCount = row?.cnt || 0;
      lastTs = row?.last_ts;
    } catch {}

    if (sessionCount > 0) {
      const when = lastTs ? new Date(lastTs * 1000).toLocaleString('zh-CN') : '未知';
      sections.push({
        priority: 4,
        text: `[Session Continuity — Session #${sessionCount + 1}]\n上一次会话结束于 ${when}。\n`,
      });
    }

    // --- Section 2: Recent Conversation Summary ---
    try {
      const events = db.prepare(
        `SELECT actor, content FROM events
         WHERE room_id = ? AND kind = 'message'
         ORDER BY rowid DESC LIMIT 8`
      ).all(roomId);

      if (events.length > 0) {
        const lines = events.reverse().map(e =>
          `  ${e.actor}: ${(e.content || '').slice(0, 120)}${(e.content || '').length > 120 ? '…' : ''}`
        );
        sections.push({
          priority: 3,
          text: `[Previous Session Summary]\n${lines.join('\n')}\n`,
        });
      }
    } catch {}

    // --- Section 3: Team Knowledge (Top-K facts) ---
    try {
      const facts = db.prepare(
        `SELECT content FROM room_facts
         WHERE room_id = ? ORDER BY rowid DESC LIMIT 5`
      ).all(roomId);

      if (facts.length > 0) {
        const lines = facts.map(f =>
          `  - ${(f.content || '').slice(0, 100)}${(f.content || '').length > 100 ? '…' : ''}`
        );
        sections.push({
          priority: 2,
          text: `[Team Knowledge — ${facts.length} facts]\n${lines.join('\n')}\n`,
        });
      }
    } catch {}

    // --- Section 4: Character-specific facts ---
    try {
      const charFacts = db.prepare(
        `SELECT content FROM character_facts
         WHERE character_id = ? ORDER BY rowid DESC LIMIT 3`
      ).all(characterId);

      if (charFacts.length > 0) {
        const lines = charFacts.map(f =>
          `  - ${(f.content || '').slice(0, 100)}${(f.content || '').length > 100 ? '…' : ''}`
        );
        sections.push({
          priority: 1,
          text: `[Personal Memory — ${charFacts.length} items]\n${lines.join('\n')}\n`,
        });
      }
    } catch {}
  } finally {
    try { db.close(); } catch {}
  }

  if (sections.length === 0) return '';

  sections.sort((a, b) => b.priority - a.priority);
  let result = '';
  let remaining = MAX_CHARS;

  for (const s of sections) {
    if (s.text.length <= remaining) {
      result += s.text + '\n';
      remaining -= s.text.length;
    }
  }

  return result.trim() ? result.trim() + '\n\n' : '';
}

module.exports = { buildBootstrap, estimateTokens };
