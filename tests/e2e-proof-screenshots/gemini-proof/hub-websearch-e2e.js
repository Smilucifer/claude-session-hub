#!/usr/bin/env node
// Phase 1.2 verification: v8 Hub has google_web_search whitelisted via
// workspace .gemini/settings.json. Ask a question that requires live web
// knowledge, then prove via session/update tool_call events that the search
// actually fired.

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9293;
const SHOT_DIR = path.join('C:\\Users\\lintian\\claude-session-hub', 'tests', 'e2e-proof-screenshots', 'gemini-proof');
const LOG_PATH = path.join(SHOT_DIR, 'hub-websearch-e2e.log');

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
  log(`target: ${page.title} ${page.url}`);
  return page.webSocketDebuggerUrl;
}

(async () => {
  try {
    const v = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    log(`Hub: ${v.Browser}`);
    const cdp = new Cdp(await pickRendererTarget());
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

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

    await cdp.screenshot('websearch-00-loaded.png');

    log('creating room with [charmander]...');
    const room = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:createRoom', 'web_search 验证 ' + Date.now(), ['charmander']);
    })()`);
    const roomId = room?.roomId || room?.id;
    log('room:', room);

    await cdp.screenshot('websearch-01-room.png');

    // Ask a question the model CANNOT answer from training alone
    const msg = '@小火龙 请调用 google_web_search 工具搜一下"2025 Nobel Prize in Physics 获奖者"，然后用一句话告诉我答案。必须先用工具搜索。';
    log(`\n=== send: ${msg}`);

    await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      window.__teamAskResult = null;
      try {
        const r = await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, ${JSON.stringify(msg)});
        window.__teamAskResult = r;
      } catch (e) { window.__teamAskResult = { error: String(e?.message || e) }; }
    })()`);

    let lastShotAt = 0;
    const started = Date.now();
    while ((Date.now() - started) < 180000) {
      await sleep(3000);
      const snap = await cdp.evaluate(`({
        events: window.__teamEvents || [],
        ask: window.__teamAskResult,
      })`);
      const last = snap.events.slice(-3);
      log(`poll ev=${snap.events.length} ask=${snap.ask ? 'DONE' : 'pending'} last=`, JSON.stringify(last).slice(0, 300));
      if ((Date.now() - started) > lastShotAt + 30000) {
        lastShotAt = Date.now() - started;
        await cdp.screenshot(`websearch-mid-${Math.floor((Date.now() - started)/1000)}s.png`);
      }
      if (snap.ask) break;
    }

    await cdp.screenshot('websearch-02-final.png');

    // Summary
    log('\n=== SUMMARY ===');
    const result = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      const events = await ipcRenderer.invoke('team:getEvents', ${JSON.stringify(roomId)}, 30);
      return { events, live: (window.__teamEvents || []), ask: window.__teamAskResult };
    })()`);
    log('ask final:', JSON.stringify(result.ask).slice(0, 500));
    log(`team:getEvents: ${Array.isArray(result.events) ? result.events.length : 'N/A'} rows`);
    if (Array.isArray(result.events)) {
      for (const ev of result.events) {
        log('  ev:', JSON.stringify({ actor: ev.actor, kind: ev.kind, content: (ev.content || '').slice(0, 500) }));
      }
    }

    // Count tool_call events in the live stream
    const liveEvents = result.live || [];
    const toolEvents = liveEvents.filter(x => {
      const d = x?.ev?.data;
      if (!d) return false;
      const t = d.type || '';
      const title = JSON.stringify(d).toLowerCase();
      return t === 'tool_call' || t === 'tool_use' || title.includes('google_web_search') || title.includes('websearch');
    });
    log(`live tool-related events: ${toolEvents.length}`);
    for (const t of toolEvents.slice(0, 5)) log('  tool ev:', JSON.stringify(t).slice(0, 400));

    await cdp.close();
  } catch (e) {
    log('ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    logStream.end();
    setTimeout(() => process.exit(process.exitCode || 0), 1000);
  }
})();

setTimeout(() => { log('hard timeout 300s'); logStream.end(); process.exit(3); }, 300000);
