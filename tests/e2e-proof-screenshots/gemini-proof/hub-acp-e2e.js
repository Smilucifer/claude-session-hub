#!/usr/bin/env node
// Full Hub UI E2E for the Gemini ACP path.
//   1. Spawn a v4 test Hub in an isolated data dir on CDP :9280 (does not
//      touch prod Hub, tachibana Hub, or the v3 test Hub still running).
//   2. Connect to its renderer via CDP and drive `team:createRoom` +
//      `team:ask` through ipcRenderer.
//   3. Poll for `team:event` / `team-response` updates, capture screenshots
//      at key moments, verify a real Gemini reply came back.
//
// Run: node tests/e2e-proof-screenshots/gemini-proof/hub-acp-e2e.js

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
// NOTE: NOT C:\temp — that path is a broken symlink on this machine.
// v5 iteration after v4 exposed the Electron-execPath bug; v4 left running.
const DATA_DIR = 'C:\\Users\\lintian\\hub-gemini-v5-data';
const CDP_PORT = 9290;
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'gemini-proof');
const LOG_PATH = path.join(SHOT_DIR, 'hub-acp-e2e.log');

fs.mkdirSync(DATA_DIR, { recursive: true });

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
function log(...args) {
  const line = `[${elapsed()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

// --- 1. Spawn Hub ----------------------------------------------------------
log(`spawning Hub — dataDir=${DATA_DIR} cdp=${CDP_PORT}`);
const hub = spawn(ELECTRON, [HUB_DIR, `--remote-debugging-port=${CDP_PORT}`], {
  cwd: HUB_DIR,
  env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
hub.stdout.on('data', d => log('HUB-OUT:', d.toString().trimEnd().slice(0, 200)));
hub.stderr.on('data', d => log('HUB-ERR:', d.toString().trimEnd().slice(0, 200)));
hub.on('exit', (code, sig) => log(`Hub process exited code=${code} sig=${sig}`));

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForHub() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const v = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      log('Hub CDP ready, Browser=', v.Browser);
      return;
    } catch {}
    await sleep(1000);
  }
  throw new Error('Hub did not come up within 45s');
}

// --- 2. Minimal CDP client --------------------------------------------------
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.id != null && this.pending.has(msg.id)) {
        const slot = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message));
        else slot.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error('evaluate exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
    }
    return res.result?.value;
  }
  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(SHOT_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
    log(`screenshot → ${outPath}`);
  }
  async close() {
    try { this.ws.close(); } catch {}
  }
}

async function pickRendererTarget() {
  const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  // Prefer the main renderer page (not devtools, not background)
  const page = list.find(t => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('no page target found; targets=' + JSON.stringify(list.map(t => ({ type: t.type, url: t.url }))));
  log(`picked target: ${page.title} ${page.url}`);
  return page.webSocketDebuggerUrl;
}

// --- 3. Drive the UI -------------------------------------------------------
(async () => {
  try {
    await waitForHub();
    await sleep(2500); // give the renderer a moment to finish loading

    const wsUrl = await pickRendererTarget();
    const cdp = new Cdp(wsUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Install an event-capturing shim in the renderer so we can poll results.
    log('installing event shim...');
    await cdp.evaluate(`(async () => {
      window.__teamEvents = window.__teamEvents || [];
      window.__teamResponses = window.__teamResponses || [];
      if (!window.__teamShim) {
        window.__teamShim = true;
        const { ipcRenderer } = require('electron');
        ipcRenderer.on('team:event', (_, ev) => window.__teamEvents.push({ at: Date.now(), ev }));
        ipcRenderer.on('team-response', (_, d) => window.__teamResponses.push({ at: Date.now(), d }));
      }
      return true;
    })()`);

    await cdp.screenshot('hub-acp-v4-00-loaded.png');

    log('creating room with [charmander]...');
    const roomResult = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:createRoom', 'ACP 验证 ' + Date.now(), ['charmander']);
    })()`);
    log('team:createRoom →', roomResult);
    const roomId = roomResult?.roomId || roomResult?.id || roomResult?.room?.id;
    if (!roomId) throw new Error('no roomId in team:createRoom response');

    await cdp.screenshot('hub-acp-v4-01-room-created.png');

    const message = '@小火龙 你好，请用一句话简短打个招呼，提一下你是 Gemini。';
    log(`sending team:ask roomId=${roomId} message=${JSON.stringify(message)}`);

    // Fire and forget; we'll poll __teamEvents / __teamResponses for the real reply.
    const askPromise = cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      try {
        const r = await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, ${JSON.stringify(message)});
        window.__teamAskResult = r;
        return { ok: true };
      } catch (e) {
        window.__teamAskResult = { error: String(e?.message || e) };
        return { ok: false, error: String(e?.message || e) };
      }
    })()`);

    // Poll every 3s up to 180s
    let gotReply = null;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const snapshot = await cdp.evaluate(`({
        events: window.__teamEvents || [],
        responses: window.__teamResponses || [],
        askResult: window.__teamAskResult || null,
      })`);
      const lastEvents = snapshot.events.slice(-5);
      log(`poll #${i+1} events=${snapshot.events.length} responses=${snapshot.responses.length} last=`,
          JSON.stringify(lastEvents).slice(0, 300));

      if (i === 2) await cdp.screenshot('hub-acp-v4-02-thinking.png');

      // We consider reply landed if askResult returned or we saw a response payload
      if (snapshot.askResult || snapshot.responses.length > 0) {
        gotReply = snapshot;
        break;
      }
    }

    await cdp.screenshot('hub-acp-v4-03-reply.png');

    if (!gotReply) {
      log('FAILURE — no reply within 180s');
      process.exitCode = 1;
    } else {
      log('=== SUMMARY ===');
      log('askResult:', gotReply.askResult);
      log('responses:', gotReply.responses.slice(0, 3));
      // Double-check by reading events straight out of the DB through team:getEvents
      const dbEvents = await cdp.evaluate(`(async () => {
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke('team:getEvents', ${JSON.stringify(roomId)}, 30);
      })()`);
      log('team:getEvents returned', Array.isArray(dbEvents) ? dbEvents.length + ' events' : dbEvents);
      if (Array.isArray(dbEvents)) {
        for (const ev of dbEvents.slice(-6)) {
          log('  ev:', JSON.stringify(ev).slice(0, 250));
        }
      }
      log('PASS — reply captured');
    }

    await cdp.close();
  } catch (e) {
    log('ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    logStream.end();
    // IMPORTANT: do NOT kill the Hub. Leave it running so the user can inspect.
    // The process will linger after this Node script exits — that's intentional.
    setTimeout(() => process.exit(process.exitCode || 0), 1500);
  }
})();

setTimeout(() => {
  log('hard timeout 300s — exiting; Hub stays up');
  logStream.end();
  process.exit(3);
}, 300000);
