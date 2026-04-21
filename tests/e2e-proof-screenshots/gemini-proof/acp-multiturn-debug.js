#!/usr/bin/env node
// Debug: drive AcpClient directly for a 2-turn conversation, logging every
// session/update event so we can see where turn #2 stalls.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { AcpClient } = require('../../../core/acp-client');

// Write a system prompt file mirroring what team-session-manager produces for
// a real character — this is the variable we're isolating.
const systemPromptPath = path.join(os.tmpdir(), 'acp-mt-system-prompt.md');
fs.writeFileSync(systemPromptPath, [
  '# 小火龙 — AI Team Room',
  '',
  '你是小火龙，一个 AI 团队成员。',
  '',
  '## 性格',
  '你是小火龙，热情开朗。每次回复尽量简短，一两句话就好。',
  '',
  '## 团队协作规则',
  '- 你在房间 room-acp-test 中与其他 AI 角色协作讨论。',
  '- 收到队友或用户的消息后，认真思考并给出你的观点。',
  '- 保持你的角色特征和说话风格一致。',
  '',
  '[重要] 回复完成后，你必须调用 team_respond 工具将你的完整回复分享给队友。这是必须的步骤，不要跳过。',
].join('\n'), 'utf-8');

const PROXY = 'http://127.0.0.1:7890';
const env = {
  ...process.env,
  HTTP_PROXY: PROXY,
  HTTPS_PROXY: PROXY,
  NO_PROXY: 'localhost,127.0.0.1',
  GEMINI_SYSTEM_MD: systemPromptPath,
};
delete env.DEBUG;

const geminiEntry = 'C:\\Users\\lintian\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js';
const workdir = path.join(os.tmpdir(), 'acp-multiturn-debug');
fs.mkdirSync(path.join(workdir, '.gemini'), { recursive: true });
fs.writeFileSync(path.join(workdir, '.gemini', 'settings.json'),
  JSON.stringify({
    tools: {
      core: ['google_web_search'],   // mirror production Hub workspace
      shell: { enableInteractiveShell: false },
    },
  }, null, 2),
  'utf-8',
);

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';

(async () => {
  const client = new AcpClient({ geminiEntry, env });
  client.on('stderr', (s) => console.log(`[${elapsed()}] STDERR:`, s.trimEnd().slice(0, 300)));
  client.on('warn', (w) => console.log(`[${elapsed()}] WARN:`, w));
  let thoughtFires = 0;
  client.on('agent-thought', ({ text }) => {
    thoughtFires += 1;
    if (thoughtFires <= 3) console.log(`[${elapsed()}] [agent-thought FIRE #${thoughtFires}] len=${text.length} preview=${JSON.stringify(text.slice(0,60))}`);
  });
  client.on('agent-message', ({ text }) => console.log(`[${elapsed()}] [agent-message FIRE] ${JSON.stringify(text.slice(0,60))}`));
  client.on('session-update', ({ update }) => {
    const kind = update?.sessionUpdate;
    const text = update?.content?.text;
    const preview = text ? `text=${JSON.stringify(text.slice(0, 80))}` : JSON.stringify(update).slice(0, 200);
    console.log(`[${elapsed()}] UPDATE ${kind}: ${preview}`);
  });
  client.on('exit', (ev) => console.log(`[${elapsed()}] exit: code=${ev.code} sig=${ev.signal}`));

  try {
    await client.start();
    await client.initialize();
    // Mirror the production team-session-manager MCP wiring to see whether
    // Gemini still emits agent_thought_chunk when ai-team MCP is attached.
    const AI_TEAM_DIR = 'C:\\Users\\lintian\\.ai-team';
    const mcpServers = [{
      name: 'ai-team',
      command: 'python',
      args: ['-m', 'ai_team.mcp_server'],
      env: [
        { name: 'PYTHONPATH', value: AI_TEAM_DIR },
        { name: 'PYTHONUTF8', value: '1' },
        { name: 'AI_TEAM_ROOM_ID', value: 'debug-room' },
        { name: 'AI_TEAM_CHARACTER_ID', value: 'charmander' },
        { name: 'AI_TEAM_HUB_CALLBACK_URL', value: 'http://127.0.0.1:3460' },
      ],
    }];
    const sid = await client.newSession({ cwd: workdir, mcpServers, modeId: 'yolo' });
    console.log(`[${elapsed()}] sessionId=${sid}`);

    console.log(`\n[${elapsed()}] === turn 1 ===`);
    const r1 = await client.prompt(sid, '你好！请用一句话问候。');
    console.log(`[${elapsed()}] turn 1 stopReason=${r1.stopReason} text=${JSON.stringify(r1.text)}`);

    console.log(`\n[${elapsed()}] === turn 2 ===`);
    const r2 = await client.prompt(sid, '刚才我跟你说的第一句话是什么？', 90000);
    console.log(`[${elapsed()}] turn 2 stopReason=${r2.stopReason} text=${JSON.stringify(r2.text)}`);
  } catch (e) {
    console.error(`[${elapsed()}] ERROR:`, e.message);
    process.exitCode = 1;
  } finally {
    await client.close();
    process.exit(process.exitCode || 0);
  }
})();

setTimeout(() => {
  console.error(`\n[${elapsed()}] 180s hard timeout`);
  process.exit(2);
}, 180000);
