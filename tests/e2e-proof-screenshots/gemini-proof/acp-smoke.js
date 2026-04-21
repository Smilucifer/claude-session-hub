#!/usr/bin/env node
// ACP smoke test using the AcpClient class (core/acp-client.js). Proves the
// extracted client still produces an end-to-end "Hi" response.

const os = require('os');
const { AcpClient } = require('../../../core/acp-client');

const PROXY = 'http://127.0.0.1:7890';
const env = {
  ...process.env,
  HTTP_PROXY: PROXY,
  HTTPS_PROXY: PROXY,
  NO_PROXY: 'localhost,127.0.0.1',
};
delete env.DEBUG;

const geminiEntry = 'C:\\Users\\lintian\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js';

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';

(async () => {
  const client = new AcpClient({ geminiEntry, env });
  client.on('stderr', (s) => console.log(`[${elapsed()}] STDERR:`, s.trimEnd().slice(0, 300)));
  client.on('warn', (w) => console.log(`[${elapsed()}] WARN:`, w));
  client.on('exit', (ev) => console.log(`[${elapsed()}] exit: code=${ev.code} sig=${ev.signal}`));
  client.on('agent-thought', ({ text }) => console.log(`[${elapsed()}] thought:`, text.trim().slice(0, 120)));
  client.on('agent-message', ({ text }) => console.log(`[${elapsed()}] message:`, text));

  try {
    await client.start();
    console.log(`[${elapsed()}] --- initialize ---`);
    const init = await client.initialize();
    console.log(`[${elapsed()}] initialize OK: ${init.agentInfo?.name} ${init.agentInfo?.version}`);

    console.log(`[${elapsed()}] --- session/new ---`);
    const sid = await client.newSession({ cwd: os.homedir(), mcpServers: [], modeId: 'yolo' });
    console.log(`[${elapsed()}] sessionId=${sid}`);

    console.log(`[${elapsed()}] --- session/prompt ---`);
    const res = await client.prompt(sid, 'say hi in one word');
    console.log(`[${elapsed()}] stopReason=${res.stopReason}`);
    console.log(`[${elapsed()}] === REPLY === ${JSON.stringify(res.text)}`);
    console.log(`[${elapsed()}] meta=${JSON.stringify(res.meta)}`);
  } catch (e) {
    console.error(`[${elapsed()}] ERROR:`, e.message);
    process.exitCode = 1;
  } finally {
    await client.close();
    process.exit(process.exitCode || 0);
  }
})();

setTimeout(() => {
  console.log(`\n[${elapsed()}] 120s hard timeout — force kill`);
  process.exit(1);
}, 120000);
