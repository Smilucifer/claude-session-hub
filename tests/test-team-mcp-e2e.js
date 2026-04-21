'use strict';
/**
 * E2E test: spawn isolated Hub instance, verify /api/team/response endpoint.
 *
 * Launches a real Electron-backed Hub with CLAUDE_HUB_DATA_DIR isolation, then
 * POSTs to its hook server's /api/team/response endpoint. Does NOT drive any
 * real CLI — that's covered by test-team-mcp-integration.js.
 *
 * Safety:
 *   - Refuses to run if any electron.exe is already running (won't touch user
 *     processes).
 *   - Kills ONLY the process we spawned.
 *   - Uses CLAUDE_HUB_DATA_DIR isolation per Hub CLAUDE.md rules.
 *
 * Run manually:
 *     node tests/test-team-mcp-e2e.js
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEST_DATA = path.join(os.tmpdir(), `hub-e2e-mcp-${Date.now()}`);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function safetyCheckNoElectronRunning() {
  // Refuse to run if any electron.exe is already alive. Protects the user's
  // production Hub — we must not risk confusion about which process is ours.
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq electron.exe" /FO CSV /NH', {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const lines = out.split(/\r?\n/).filter((l) => l.toLowerCase().includes('electron.exe'));
    if (lines.length > 0) {
      console.error('[e2e] REFUSING TO RUN - existing electron.exe processes detected:');
      for (const l of lines) console.error('  ' + l);
      console.error('[e2e] Close them manually (or confirm none belong to the user) before running this test.');
      process.exit(2);
    }
  } catch (e) {
    console.warn('[e2e] tasklist check failed:', e.message, '- continuing cautiously');
  }
}

async function main() {
  safetyCheckNoElectronRunning();

  if (!fs.existsSync(ELECTRON)) {
    console.error(`[e2e] electron.exe not found at ${ELECTRON}`);
    process.exit(1);
  }

  fs.mkdirSync(TEST_DATA, { recursive: true });
  console.log(`[e2e] isolated data dir: ${TEST_DATA}`);

  // Launch Hub with full isolation
  const env = Object.assign({}, process.env, { CLAUDE_HUB_DATA_DIR: TEST_DATA });
  const hub = spawn(ELECTRON, [HUB_DIR, '--remote-debugging-port=9227'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(`[e2e] spawned Hub pid=${hub.pid}`);

  let hubOut = '';
  hub.stdout.on('data', (d) => { hubOut += d.toString(); });
  hub.stderr.on('data', (d) => { hubOut += d.toString(); });

  // Give Hub time to boot (Electron + hook server)
  await sleep(6000);

  let exitCode = 0;
  try {
    // Parse port from log (Hub may fall back from 3456 to 3457..3460)
    const portMatch = hubOut.match(/hook server listening on 127\.0\.0\.1:(\d+)/);
    if (!portMatch) {
      throw new Error('Hub did not announce hook server - log head:\n' + hubOut.substring(0, 800));
    }
    const port = parseInt(portMatch[1], 10);
    console.log(`[e2e] Hub hook server on port ${port}`);

    // Test 1: valid team/response payload
    const resp = await post(`http://127.0.0.1:${port}/api/team/response`, {
      room_id: 'e2e-test-room',
      character_id: 'pikachu',
      content: 'E2E test response',
      event_id: 'evt-e2e-test',
    });
    console.log(`[e2e] /api/team/response ${resp.status}: ${resp.body}`);
    if (resp.status !== 200 || !resp.body.includes('ok')) {
      throw new Error(`/api/team/response did not return 200 {"ok":true}: ${resp.status} ${resp.body}`);
    }

    // Test 2: unknown route -> 404
    const r404 = await post(`http://127.0.0.1:${port}/api/nonexistent`, {});
    if (r404.status !== 404) {
      throw new Error(`expected 404 for unknown route, got ${r404.status} ${r404.body}`);
    }
    console.log('[e2e] 404 route handling correct');

    console.log('\nPASS: Hub instance + MCP callback endpoint operational');
  } catch (e) {
    console.error('\nFAIL:', e.message);
    exitCode = 1;
  }

  // Cleanup - kill only the Hub we spawned
  try { hub.kill('SIGTERM'); } catch (_) { /* ignore */ }
  await sleep(2000);
  try {
    // Windows: SIGTERM doesn't always stop Electron - force-kill the tree
    if (process.platform === 'win32') {
      try { execSync(`taskkill /PID ${hub.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* ignore */ }
    } else {
      hub.kill('SIGKILL');
    }
  } catch (_) { /* ignore */ }

  await sleep(1000);
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
