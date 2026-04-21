'use strict';
/** 验证 review 修复：UTF-8 中文不乱码 + resume 仍生效 + closeAll 清 _characters. */
const { TeamSessionManager } = require('../core/team-session-manager.js');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const AI_TEAM_DIR = process.env.AI_TEAM_DIR || 'C:/Users/lintian/ai-team-tachibana';
process.env.AI_TEAM_DIR = AI_TEAM_DIR;

const fakeSM = { getSession: () => null, createSession: () => { throw new Error('n/a'); } };
const tsm = new TeamSessionManager(fakeSM, 3461);
const c = {
  id: 'squirtle',
  display_name: '杰尼龟',
  backing_cli: 'codex',
  personality: '扎实可靠的全能型选手。不是最耀眼的，但永远是最让人安心的。',
};
const ROOM = 'unit-codex-reviewfix-' + Date.now();

const db = new DatabaseSync(path.join(AI_TEAM_DIR, 'team.db'));
db.prepare(
  `INSERT OR IGNORE INTO rooms (id, display_name, member_ids, speech_mode, task_mode, memory_bias, max_depth, timeout_seconds, created_ts) VALUES (?, 'unit', '["squirtle"]', 'natural', 'divergent', 'balanced', 6, 120, ?)`
).run(ROOM, String(Math.floor(Date.now() / 1000)));
db.close();

(async () => {
  await tsm.ensureSession(ROOM, c);
  console.log('\n=== R1 (Chinese prompt, expect Chinese response) ===');
  const r1 = await tsm.sendMessage(
    ROOM, 'squirtle',
    '用中文一句话介绍你自己，限 15 字以内。',
    120000
  );
  console.log(`R1 content=${JSON.stringify(r1.content)} sid=${tsm._codexSessions.get(ROOM + ':squirtle')}`);

  console.log('\n=== R2 (resume, ask about prior context) ===');
  const r2 = await tsm.sendMessage(
    ROOM, 'squirtle',
    '用中文回答：我上一条问你的是什么？一句话。',
    120000
  );
  console.log(`R2 content=${JSON.stringify(r2.content)} sid=${tsm._codexSessions.get(ROOM + ':squirtle')}`);

  const combined = r1.content + r2.content;
  const gibberish = /�/.test(combined);
  const chinese = /[一-鿿]/.test(combined);
  console.log(`\n断言 1 — UTF-8 无 U+FFFD 替换字符: ${gibberish ? 'FAIL' : 'PASS'}`);
  console.log(`断言 2 — 响应含中文字符:            ${chinese ? 'PASS' : 'FAIL'}`);
  const resumed = /(介绍|自我|你自己|角色|身份|谁)/.test(r2.content);
  console.log(`断言 3 — R2 回忆起 R1 的问题:       ${resumed ? 'PASS' : 'FAIL'}`);

  tsm.closeAll();
  console.log(`断言 4 — closeAll 清 _characters:   ${tsm._characters.size === 0 ? 'PASS' : `FAIL (size=${tsm._characters.size})`}`);

  const allPass = !gibberish && chinese && resumed && tsm._characters.size === 0;
  console.log(`\n=== ${allPass ? 'ALL PASS' : 'SOME FAIL'} ===`);
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
