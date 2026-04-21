#!/usr/bin/env node
// Phase 1.1 verification: connect to an already-running v7 Hub (CDP :9292),
// drive `team:createRoom` + `team:ask` for charmander, capture screenshots
// + Hub log snippets that prove the ai-team MCP server is actually wired up
// and callable by Gemini ACP. Does NOT spawn a Hub; uses the existing one.

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9292;
const SHOT_DIR = path.join('C:\\Users\\lintian\\claude-session-hub', 'tests', 'e2e-proof-screenshots', 'gemini-proof');
const LOG_PATH = path.join(SHOT_DIR, 'hub-mcp-e2e.log');

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
      throw new Error('evaluate exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
    }
    return res.result?.value;
  }
  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(SHOT_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
    log(`screenshot → ${path.basename(outPath)}`);
  }
  async close() { try { this.ws.close(); } catch {} }
}

async function pickRendererTarget() {
  const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = list.find(t => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('no page target; targets=' + JSON.stringify(list.map(t => ({ t: t.type, u: t.url }))));
  log(`picked target: ${page.title} ${page.url}`);
  return page.webSocketDebuggerUrl;
}

async function waitForReply(cdp, roomId, beforeEventCount, { maxSeconds = 120, shotEvery = 20, shotPrefix }) {
  const started = Date.now();
  while ((Date.now() - started) < maxSeconds * 1000) {
    await sleep(3000);
    const snapshot = await cdp.evaluate(`({
      events: window.__teamEvents || [],
      askResult: window.__teamAskResult || null,
    })`);
    const newSinceBefore = snapshot.events.slice(beforeEventCount);
    const sawMessage = newSinceBefore.find(e => e.ev?.data?.type === 'message' && e.ev.data.actor === 'charmander');
    log(`poll events=${snapshot.events.length} (+${newSinceBefore.length}) ask=${snapshot.askResult ? 'DONE' : 'pending'} last=`,
      JSON.stringify(newSinceBefore.slice(-3)).slice(0, 300));

    if (shotPrefix && ((Date.now() - started) / 1000 | 0) % shotEvery < 3) {
      // opportunistic mid-flight shot
    }

    if (sawMessage || snapshot.askResult) return { snapshot, newSinceBefore };
  }
  log(`TIMEOUT after ${maxSeconds}s`);
  return { timeout: true };
}

(async () => {
  try {
    log(`connecting to existing Hub CDP :${CDP_PORT}`);
    const v = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    log(`Hub alive: ${v.Browser}`);

    const wsUrl = await pickRendererTarget();
    const cdp = new Cdp(wsUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

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
      window.__teamAskResult = null;
      window.__teamEvents.length = 0;
      return true;
    })()`);

    await cdp.screenshot('mcp-e2e-00-loaded.png');

    log('creating charmander-only room...');
    const roomResult = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:createRoom', 'MCP 验证 ' + Date.now(), ['charmander']);
    })()`);
    log('team:createRoom →', roomResult);
    const roomId = roomResult?.roomId || roomResult?.id || roomResult?.room?.id;
    if (!roomId) throw new Error('no roomId');
    await cdp.screenshot('mcp-e2e-01-room-created.png');

    // ---- message 1: sanity — regular hello ----------------------------------
    log('\n=== MSG 1: sanity hello ===');
    const beforeCount1 = await cdp.evaluate('(window.__teamEvents||[]).length');
    await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      window.__teamAskResult = null;
      try {
        const r = await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, ${JSON.stringify('@小火龙 你好，用一句话打个招呼')});
        window.__teamAskResult = r;
      } catch (e) { window.__teamAskResult = { error: String(e?.message || e) }; }
      return true;
    })()`);
    const m1 = await waitForReply(cdp, roomId, beforeCount1, { maxSeconds: 120 });
    await cdp.screenshot('mcp-e2e-02-reply-hello.png');
    if (m1.timeout) log('msg1 TIMEOUT'); else log('msg1 DONE');

    // ---- message 2: ask charmander to list its tools (MCP presence check) ---
    log('\n=== MSG 2: list available tools ===');
    const beforeCount2 = await cdp.evaluate('(window.__teamEvents||[]).length');
    await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      window.__teamAskResult = null;
      const msg = ${JSON.stringify('@小火龙 请列出你现在可用的所有 MCP 工具（tool 的名字，逐行列出即可）。如果你看到以 team_ 或 write_character / recall 开头的工具，请特别标注。')};
      try {
        const r = await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, msg);
        window.__teamAskResult = r;
      } catch (e) { window.__teamAskResult = { error: String(e?.message || e) }; }
      return true;
    })()`);
    const m2 = await waitForReply(cdp, roomId, beforeCount2, { maxSeconds: 120 });
    await cdp.screenshot('mcp-e2e-03-reply-tools.png');
    if (m2.timeout) log('msg2 TIMEOUT'); else log('msg2 DONE');

    // ---- message 3: real memory write via MCP tool --------------------------
    log('\n=== MSG 3: memory write via MCP ===');
    const beforeCount3 = await cdp.evaluate('(window.__teamEvents||[]).length');
    await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      window.__teamAskResult = null;
      const msg = ${JSON.stringify('@小火龙 请调用 ai-team 的记忆写入 MCP 工具，记录这条事实："立花道雪的测试密钥是 QUANTUM-42"。写完确认一下。')};
      try {
        const r = await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, msg);
        window.__teamAskResult = r;
      } catch (e) { window.__teamAskResult = { error: String(e?.message || e) }; }
      return true;
    })()`);
    const m3 = await waitForReply(cdp, roomId, beforeCount3, { maxSeconds: 180 });
    await cdp.screenshot('mcp-e2e-04-reply-memory.png');
    if (m3.timeout) log('msg3 TIMEOUT'); else log('msg3 DONE');

    // ---- aggregate summary --------------------------------------------------
    log('\n=== SUMMARY ===');
    const final = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      const events = await ipcRenderer.invoke('team:getEvents', ${JSON.stringify(roomId)}, 60);
      return { events, shim: (window.__teamEvents || []).length };
    })()`);
    log(`renderer saw ${final.shim} live team:event payloads`);
    log(`team:getEvents returned ${Array.isArray(final.events) ? final.events.length : 'N/A'} rows`);
    if (Array.isArray(final.events)) {
      for (const ev of final.events) {
        const short = {
          id: ev.id, actor: ev.actor, kind: ev.kind,
          content: (ev.content || '').slice(0, 400),
          ts: ev.ts,
        };
        log('  ev:', JSON.stringify(short));
      }
    }

    // Detect a tool_call event (proves MCP was actually invoked)
    const renderer = await cdp.evaluate('window.__teamEvents || []');
    const toolEvents = renderer.filter(x => {
      const d = x?.ev?.data;
      return d && (d.type === 'tool_call' || d.type === 'tool_use' || (d.sessionUpdate && d.sessionUpdate.includes('tool')));
    });
    log(`tool-related events in stream: ${toolEvents.length}`);
    for (const t of toolEvents.slice(0, 5)) log('  tool ev:', JSON.stringify(t).slice(0, 300));

    await cdp.close();
  } catch (e) {
    log('ERROR:', e.message, e.stack);
    process.exitCode = 2;
  } finally {
    logStream.end();
    setTimeout(() => process.exit(process.exitCode || 0), 1000);
  }
})();

setTimeout(() => {
  log('hard timeout 600s');
  logStream.end();
  process.exit(3);
}, 600000);
