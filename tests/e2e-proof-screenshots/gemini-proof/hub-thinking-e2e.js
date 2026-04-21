#!/usr/bin/env node
// Phase 2.1 verification: v9 Hub should now forward Gemini's agent_thought_chunk
// out as `thinking_delta` events. Connect, send a reasoning-heavy prompt,
// capture live thinking_delta events and confirm UI renders them.

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9300;
const SHOT_DIR = path.join('C:\\Users\\lintian\\claude-session-hub', 'tests', 'e2e-proof-screenshots', 'gemini-proof');
const LOG_PATH = path.join(SHOT_DIR, 'hub-thinking-e2e.log');

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
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.id != null && this.pending.has(msg.id)) {
        const slot = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message)); else slot.resolve(msg.result);
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
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) throw new Error('evaluate exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
    return res.result?.value;
  }
  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, filename), Buffer.from(res.data, 'base64'));
    log(`screenshot → ${filename}`);
  }
  async close() { try { this.ws.close(); } catch {} }
}

async function pickRendererTarget() {
  const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = list.find(t => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('no page target');
  return page.webSocketDebuggerUrl;
}

(async () => {
  try {
    const v = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    log(`Hub ${v.Browser}`);
    const cdp = new Cdp(await pickRendererTarget());
    await cdp.connect();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

    log('install shim...');
    await cdp.evaluate(`(async () => {
      window.__teamEvents = [];
      if (!window.__teamShim) {
        window.__teamShim = true;
        const { ipcRenderer } = require('electron');
        ipcRenderer.on('team:event', (_, ev) => window.__teamEvents.push({ at: Date.now(), ev }));
      }
      window.__teamAskResult = null;
      return true;
    })()`);

    await cdp.screenshot('thinking-00-loaded.png');

    log('create charmander-only room...');
    const room = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:createRoom', 'thinking 验证 ' + Date.now(), ['charmander']);
    })()`);
    const roomId = room?.id || room?.roomId;
    log('room:', room);
    await cdp.screenshot('thinking-01-room.png');

    const msg = '@小火龙 请思考一下：如果用 Python 写一个 Fibonacci 数列函数，memoization 和递归哪个更快？请在脑中分析后用 1-2 句话总结。';
    log(`send: ${msg}`);
    await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      window.__teamAskResult = null;
      try {
        const r = await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, ${JSON.stringify(msg)});
        window.__teamAskResult = r;
      } catch (e) { window.__teamAskResult = { error: String(e?.message || e) }; }
    })()`);

    let midShot = false;
    const started = Date.now();
    while ((Date.now() - started) < 180000) {
      await sleep(2500);
      const snap = await cdp.evaluate(`({
        ev: (window.__teamEvents || []).length,
        thinkDelta: (window.__teamEvents || []).filter(x => x?.ev?.data?.type === 'thinking_delta').length,
        recentThink: (window.__teamEvents || []).filter(x => x?.ev?.data?.type === 'thinking_delta').slice(-3).map(x => ({
          actor: x.ev.data.actor,
          text: (x.ev.data.text || '').slice(0, 80),
        })),
        ask: window.__teamAskResult,
      })`);
      log(`poll ev=${snap.ev} thinking_delta=${snap.thinkDelta} recent=`, JSON.stringify(snap.recentThink));

      if (!midShot && snap.thinkDelta >= 1) {
        await cdp.screenshot('thinking-02-live-thought.png');
        midShot = true;
      }
      if (snap.ask) break;
    }

    await cdp.screenshot('thinking-03-final.png');

    // Summary
    const summary = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      const events = await ipcRenderer.invoke('team:getEvents', ${JSON.stringify(roomId)}, 20);
      const live = window.__teamEvents || [];
      return {
        liveTotal: live.length,
        thinkDeltas: live.filter(x => x?.ev?.data?.type === 'thinking_delta'),
        messages: live.filter(x => x?.ev?.data?.type === 'message'),
        dbEvents: events,
        ask: window.__teamAskResult,
      };
    })()`);

    log('\n=== SUMMARY ===');
    log('ask final:', JSON.stringify(summary.ask).slice(0, 400));
    log(`live thinking_delta events: ${summary.thinkDeltas.length}`);
    const joined = summary.thinkDeltas.map(x => x.ev.data.text || '').join('');
    log(`concatenated thinking text length: ${joined.length}`);
    log(`preview (first 400 chars): ${joined.slice(0, 400)}`);
    log(`live message events: ${summary.messages.length}`);
    for (const m of summary.messages) log('  msg:', JSON.stringify({ actor: m.ev.data.actor, content: (m.ev.data.content || '').slice(0, 300), tokenCount: m.ev.data.tokenCount }));

    // Phase 2.2 assertions
    const tcSeen = summary.messages.find(m => m.ev.data.tokenCount);
    log(`tokenCount present on message: ${!!tcSeen}`);
    if (tcSeen) log(`  tokenCount = ${JSON.stringify(tcSeen.ev.data.tokenCount)}`);
    const anyNonEmpty = summary.messages.find(m => (m.ev.data.content || '').trim().length > 0);
    log(`non-empty content on message: ${!!anyNonEmpty}`);

    await cdp.close();
  } catch (e) {
    log('ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    logStream.end();
    setTimeout(() => process.exit(process.exitCode || 0), 1000);
  }
})();

setTimeout(() => { log('hard timeout 240s'); logStream.end(); process.exit(3); }, 240000);
