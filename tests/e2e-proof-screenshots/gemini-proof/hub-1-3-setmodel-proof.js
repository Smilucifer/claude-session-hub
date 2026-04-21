#!/usr/bin/env node
// Phase 1.3 real-world proof: baseline vs. after SQL-level model switch.
// Creates two separate rooms (so each spawns its own ACP session and
// triggers the code path that issues session/set_model), fires a message
// in each, and logs the actual model returned in meta.quota.model_usage.

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9301;
const SHOT_DIR = path.join('C:\\Users\\lintian\\claude-session-hub', 'tests', 'e2e-proof-screenshots', 'gemini-proof');
const LOG_PATH = path.join(SHOT_DIR, 'hub-1-3-setmodel-proof.log');

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
function log(...args) {
  const line = `[${elapsed()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ try { resolve(JSON.parse(b)); } catch(e){ reject(e); } }); }).on('error', reject);
  });
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', b => {
      const m = JSON.parse(b.toString());
      if (m.id != null && this.pending.has(m.id)) {
        const s = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) s.reject(new Error(m.error.message)); else s.resolve(m.result);
      }
    });
  }
  send(method, params={}) {
    const id = this.nextId++;
    return new Promise((res, rej) => { this.pending.set(id, {resolve:res, reject:rej}); this.ws.send(JSON.stringify({id, method, params})); });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }
  async screenshot(filename) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, filename), Buffer.from(r.data, 'base64'));
    log(`screenshot → ${filename}`);
  }
}

async function sendAndReadModel(cdp, roomName, message) {
  const room = await cdp.evaluate(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('team:createRoom', ${JSON.stringify(roomName)}, ['charmander']);
  })()`);
  const roomId = room?.id || room?.roomId;
  log(`room ${roomName} → ${roomId}`);

  const result = await cdp.evaluate(`(async () => {
    const { ipcRenderer } = require('electron');
    try {
      return await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, ${JSON.stringify(message)});
    } catch (e) { return { error: String(e?.message || e) }; }
  })()`);
  log(`ask result: ${JSON.stringify(result).slice(0, 400)}`);
  const tc = result?.results?.[0]?.tokenCount;
  return { roomId, tokenCount: tc, content: result?.results?.[0]?.content };
}

(async () => {
  try {
    const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

    await cdp.screenshot('setmodel-00-start.png');

    // --- Phase A: baseline (charmander.model=NULL) ---
    log('\n=== PHASE A: baseline (charmander.model=NULL) ===');
    const baseline = await sendAndReadModel(cdp, 'setmodel baseline ' + Date.now(), '@小火龙 你好，一个词回复。');
    log('BASELINE tokenCount=', JSON.stringify(baseline.tokenCount));
    await cdp.screenshot('setmodel-01-baseline.png');

    // --- Switch DB ---
    log('\n=== switching charmander.model → pro via SQL ===');
    const { spawnSync } = require('child_process');
    const swOut = spawnSync('python', ['-c',
      "import sqlite3; c=sqlite3.connect(r'C:\\\\Users\\\\lintian\\\\.ai-team\\\\team.db'); c.execute(\"UPDATE characters SET model='pro' WHERE id='charmander'\"); c.commit(); r=c.execute(\"SELECT model FROM characters WHERE id='charmander'\").fetchone(); print('after-update:', r)"
    ], { encoding: 'utf8' });
    log('sql:', swOut.stdout.trim(), swOut.stderr.trim());

    // --- Phase B: after switch (new room → new ACP session → setModel invoked) ---
    log('\n=== PHASE B: after switch (new room triggers new ACP session + setModel) ===');
    const after = await sendAndReadModel(cdp, 'setmodel after ' + Date.now(), '@小火龙 你好，一个词回复。');
    log('AFTER tokenCount=', JSON.stringify(after.tokenCount));
    await cdp.screenshot('setmodel-02-after-switch.png');

    // --- Rollback ---
    log('\n=== rolling back charmander.model → NULL ===');
    const rbOut = spawnSync('python', ['-c',
      "import sqlite3; c=sqlite3.connect(r'C:\\\\Users\\\\lintian\\\\.ai-team\\\\team.db'); c.execute(\"UPDATE characters SET model=NULL WHERE id='charmander'\"); c.commit(); r=c.execute(\"SELECT model FROM characters WHERE id='charmander'\").fetchone(); print('after-rollback:', r)"
    ], { encoding: 'utf8' });
    log('rollback sql:', rbOut.stdout.trim(), rbOut.stderr.trim());

    // --- Summary ---
    log('\n=== SUMMARY ===');
    log(`baseline.model = ${baseline.tokenCount?.model ?? '(no tokenCount)'}`);
    log(`after.model    = ${after.tokenCount?.model ?? '(no tokenCount)'}`);
    const diff = (baseline.tokenCount?.model || '') !== (after.tokenCount?.model || '');
    log(`model changed : ${diff}`);

  } catch (e) {
    log('ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    logStream.end();
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();

setTimeout(() => { log('hard timeout 360s'); logStream.end(); process.exit(3); }, 360000);
