// E2E: open meeting -> add turn -> kill Hub -> restart -> verify recovery
//
// Runs Hub in isolated mode via CLAUDE_HUB_DATA_DIR + custom CDP port to avoid
// touching the user's production Hub. Cleans temp data dir at end.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = path.join(os.tmpdir(), `hub-e2e-resume-${Date.now()}`);
const PORT_1 = 9241;
const PORT_2 = 9242;

let _id = 0;
function rpc(ws, method, params = {}) {
  const i = ++_id;
  return new Promise((res, rej) => {
    const onMsg = raw => {
      const msg = JSON.parse(raw);
      if (msg.id === i) {
        ws.removeListener('message', onMsg);
        msg.error ? rej(msg.error) : res(msg.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

async function attachCDP(port) {
  // Retry a few times in case CDP not yet ready
  let lastErr = null;
  for (let i = 0; i < 10; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (!main) throw new Error('no main window via CDP');
      const ws = new WebSocket(main.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
      await rpc(ws, 'Page.enable');
      await rpc(ws, 'Runtime.enable');
      return ws;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw new Error(`attachCDP failed after retries: ${lastErr?.message || lastErr}`);
}

async function evalRpc(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

async function startHub(port) {
  const env = { ...process.env, CLAUDE_HUB_DATA_DIR: TEMP_DATA };
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: HUB_DIR, env, detached: false, stdio: 'ignore',
  });
  await new Promise(r => setTimeout(r, 6000));
  return proc;
}

(async () => {
  fs.mkdirSync(TEMP_DATA, { recursive: true });
  console.log(`[E2E] TEMP_DATA=${TEMP_DATA}`);

  // Phase 1: start Hub, create meeting + turn
  console.log(`[E2E] Phase 1: start Hub on ${PORT_1}`);
  const hub1 = await startHub(PORT_1);
  const ws1 = await attachCDP(PORT_1);

  const meetingId = await evalRpc(ws1, `(async () => {
    const { ipcRenderer } = require('electron');
    const m = await ipcRenderer.invoke('create-meeting');
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: 'first message before crash' });
    // Force a state.json persist so restart can find the meeting in dormant list.
    // (Renderer's schedulePersist debounces 400ms; we drive it directly with a minimal meeting list.)
    ipcRenderer.send('persist-sessions', [], [{
      id: m.id, type: 'meeting', title: m.title || 'Meeting',
      subSessions: [], layout: 'focus', focusedSub: null,
      syncContext: false, sendTarget: 'all',
      createdAt: m.createdAt || Date.now(), lastMessageTime: Date.now(),
      pinned: false, lastScene: null,
    }]);
    return m.id;
  })()`);
  console.log(`[E2E] Created meeting ${meetingId}`);

  // Wait > 5s for meeting-store debounce flush + state.json sync write
  await new Promise(r => setTimeout(r, 7000));
  ws1.close();

  // Phase 2: kill Hub
  console.log(`[E2E] Phase 2: kill Hub`);
  hub1.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 2000));

  // Verify on-disk
  const meetingFile = path.join(TEMP_DATA, 'meetings', `${meetingId}.json`);
  if (!fs.existsSync(meetingFile)) {
    console.error(`[E2E] FAIL: ${meetingFile} not persisted`);
    process.exit(1);
  }
  const persisted = JSON.parse(fs.readFileSync(meetingFile, 'utf-8'));
  if (!Array.isArray(persisted._timeline) || persisted._timeline.length !== 1) {
    console.error(`[E2E] FAIL: timeline expected 1 turn, got ${persisted._timeline?.length}`);
    process.exit(1);
  }
  console.log('[E2E] Phase 2 PASS: meeting file persisted with timeline');

  const stateFile = path.join(TEMP_DATA, 'state.json');
  if (!fs.existsSync(stateFile)) {
    console.error(`[E2E] FAIL: state.json not persisted`);
    process.exit(1);
  }
  const stateObj = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  if (!Array.isArray(stateObj.meetings) || !stateObj.meetings.find(m => m.id === meetingId)) {
    console.error(`[E2E] FAIL: state.json.meetings missing ${meetingId}`);
    process.exit(1);
  }
  console.log('[E2E] Phase 2 PASS: state.json contains meeting reference');

  // Phase 3: restart Hub
  console.log(`[E2E] Phase 3: restart Hub on ${PORT_2}`);
  const hub2 = await startHub(PORT_2);
  const ws2 = await attachCDP(PORT_2);

  const restored = await evalRpc(ws2, `(async () => {
    const { ipcRenderer } = require('electron');
    const ms = await ipcRenderer.invoke('get-dormant-meetings');
    const found = (ms || []).find(m => m.id === '${meetingId}');
    if (!found) return { ok: false, reason: 'meeting not in dormant list', count: (ms||[]).length };
    const r = await ipcRenderer.invoke('meeting-load-timeline', '${meetingId}');
    return {
      ok: r.ok,
      reason: r.reason || null,
      timelineLen: r.timeline?.length || 0,
      firstText: r.timeline?.[0]?.text || null,
    };
  })()`);
  console.log('[E2E] Restored:', JSON.stringify(restored));

  if (!restored.ok) {
    console.error('[E2E] FAIL: meeting-load-timeline returned ok=false; reason:', restored.reason);
    ws2.close();
    hub2.kill('SIGKILL');
    process.exit(1);
  }
  if (restored.timelineLen !== 1) {
    console.error(`[E2E] FAIL: expected 1 turn, got ${restored.timelineLen}`);
    ws2.close();
    hub2.kill('SIGKILL');
    process.exit(1);
  }
  if (restored.firstText !== 'first message before crash') {
    console.error(`[E2E] FAIL: text mismatch: ${restored.firstText}`);
    ws2.close();
    hub2.kill('SIGKILL');
    process.exit(1);
  }
  console.log('[E2E] Phase 3 PASS: meeting + timeline fully recovered');

  // Cleanup
  ws2.close();
  hub2.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 1500));
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}

  console.log('\n[E2E] ALL PASS');
  process.exit(0);
})().catch(e => {
  console.error('[E2E] FAIL:', e.message, e.stack);
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
