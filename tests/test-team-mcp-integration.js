'use strict';
/**
 * Integration test: real Claude CLI + team_respond MCP callback
 *
 * Verifies that a PTY-hosted Claude CLI, spawned by TeamSessionManager with an
 * MCP config pointing at a local callback server, can call the `team_respond`
 * tool and have the callback wire back into TeamSessionManager's pending Promise.
 *
 * This test spins up a tiny HTTP server that mimics Hub's /api/team/response
 * endpoint (no full Electron required). It uses SessionManager +
 * TeamSessionManager directly from core/.
 *
 * NOTE: This test actually invokes Claude CLI and therefore burns API tokens.
 * It also requires a valid Claude CLI login. Run it manually:
 *     node tests/test-team-mcp-integration.js
 */
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { SessionManager } = require('../core/session-manager.js');
const { TeamSessionManager } = require('../core/team-session-manager.js');

const TEST_DIR = path.join(os.tmpdir(), `hub-mcp-int-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.CLAUDE_HUB_DATA_DIR = TEST_DIR;

async function main() {
  // 1. Start callback server that impersonates Hub's /api/team/response endpoint
  let callbackReceived = null;
  let callbackResolve;
  const callbackPromise = new Promise((r) => { callbackResolve = r; });

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/team/response') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          callbackReceived = JSON.parse(body);
          callbackResolve(callbackReceived);
        } catch (e) {
          console.error('[int-test] parse error:', e);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`[int-test] callback server on port ${port}`);

  // 2. Initialize session managers (TSM points at our fake Hub port)
  const sm = new SessionManager();
  const tsm = new TeamSessionManager(sm, port);

  // 3. Define test character — Claude backing, Sonnet, minimal prompt
  const character = {
    id: 'test-pikachu',
    display_name: 'TestPikachu',
    backing_cli: 'claude',
    model: 'sonnet',
    system_prompt: 'You are a test assistant. Respond briefly in English.',
    personality: '',
  };

  let exitCode = 0;
  try {
    // 4. Create session (spawns real PTY + Claude CLI with MCP config)
    console.log('[int-test] creating session...');
    const sessionId = await tsm.ensureSession('test-room', character);
    console.log(`[int-test] session ready: ${sessionId}`);

    // 5. Send message — resolves only when onResponse is triggered
    const sendPromise = tsm.sendMessage(
      'test-room',
      'test-pikachu',
      'Say hello briefly. Then call team_respond tool with your reply.',
      120000,
    );

    // 6. Wait for MCP callback to arrive at our server
    const timeoutP = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout 120s waiting for MCP callback')), 120000),
    );
    const cb = await Promise.race([callbackPromise, timeoutP]);
    console.log('[int-test] callback received:', JSON.stringify(cb).substring(0, 200));

    // 7. Manually trigger onResponse so sendMessage resolves
    //    (our fake server is not wired to TSM the way main.js is)
    tsm.onResponse(cb.room_id, cb.character_id, cb.content, cb.event_id);
    const result = await sendPromise;
    console.log('[int-test] sendMessage resolved:', JSON.stringify(result).substring(0, 200));

    console.log('\nPASS: Real Claude CLI + team_respond MCP callback works end-to-end');
  } catch (e) {
    console.error('\nFAIL:', e.message);
    exitCode = 1;
  }

  // 8. Cleanup: close PTY sessions, stop server, remove temp dir
  try { tsm.closeAll(); } catch (_) { /* ignore */ }
  try { server.close(); } catch (_) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 2000)); // let PTY processes exit
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
