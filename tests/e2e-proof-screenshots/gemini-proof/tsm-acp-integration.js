#!/usr/bin/env node
// Integration test: drive TeamSessionManager's Gemini ACP path end-to-end,
// without booting the full Electron Hub. Proves ensureSession + sendMessage
// wire up correctly and return a non-empty reply.

const { TeamSessionManager } = require('../../../core/team-session-manager');

// Minimal SessionManager stub — the Gemini ACP branch never calls
// createSession/writeToSession, so we only need the shape.
const fakeSessionManager = {
  sessions: new Map(),
  getSession: () => null,
  closeSession: () => {},
  writeToSession: () => {},
  createSession: () => { throw new Error('createSession should not be called for ACP'); },
};

const character = {
  id: 'charmander',
  display_name: '小火龙',
  backing_cli: 'gemini',
  personality: '你是小火龙，热情开朗。每次回复尽量简短，一两句话就好。',
};

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';

(async () => {
  const tsm = new TeamSessionManager(fakeSessionManager, 3456);
  try {
    console.log(`[${elapsed()}] ensureSession...`);
    const hubId = await tsm.ensureSession('room-acp-test', character);
    console.log(`[${elapsed()}] ensureSession OK: hubId=${hubId}`);

    console.log(`[${elapsed()}] sendMessage #1 (greeting)...`);
    const r1 = await tsm.sendMessage('room-acp-test', 'charmander', '你好！请用一句话问候。', 120000);
    console.log(`[${elapsed()}] sendMessage #1 OK, content=${JSON.stringify(r1.content)}`);

    console.log(`[${elapsed()}] sendMessage #2 (multi-turn: should remember context)...`);
    const r2 = await tsm.sendMessage('room-acp-test', 'charmander', '刚才我跟你说的第一句话是什么？', 120000);
    console.log(`[${elapsed()}] sendMessage #2 OK, content=${JSON.stringify(r2.content)}`);

    console.log(`\n[${elapsed()}] === SUMMARY ===`);
    console.log(`reply1: ${r1.content}`);
    console.log(`reply2: ${r2.content}`);
    if (!r1.content.trim()) throw new Error('reply1 is empty');
    if (!r2.content.trim()) throw new Error('reply2 is empty');
    console.log(`[${elapsed()}] PASS`);
  } catch (e) {
    console.error(`[${elapsed()}] FAIL:`, e.message);
    process.exitCode = 1;
  } finally {
    tsm.closeAll();
    setTimeout(() => process.exit(process.exitCode || 0), 3000);
  }
})();

setTimeout(() => {
  console.error(`\n[${elapsed()}] 240s hard timeout`);
  process.exit(2);
}, 240000);
