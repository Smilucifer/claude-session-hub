#!/usr/bin/env node
// Phase 2.2 UI proof: fire a real message and then dump the
// `.tr-msg-tokens` span innerHTML to prove the renderer actually renders
// the token badge, plus take a screenshot with the team-room panel forced
// visible so the badge is eye-verifiable.

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9300;
const SHOT_DIR = path.join('C:\\Users\\lintian\\claude-session-hub', 'tests', 'e2e-proof-screenshots', 'gemini-proof');
const LOG_PATH = path.join(SHOT_DIR, 'hub-2-2-token-proof.log');

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

(async () => {
  try {
    const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

    log('setup shim...');
    await cdp.evaluate(`(async () => {
      window.__teamEvents = window.__teamEvents || [];
      if (!window.__teamShim) {
        window.__teamShim = true;
        const { ipcRenderer } = require('electron');
        ipcRenderer.on('team:event', (_, ev) => window.__teamEvents.push({ at: Date.now(), ev }));
      }
      window.__teamAskResult = null;
      window.__teamEvents.length = 0;
      return true;
    })()`);

    const room = await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:createRoom', '2.2 token 证据 ' + Date.now(), ['charmander']);
    })()`);
    const roomId = room?.id || room?.roomId;
    log('room:', room);

    log('activating team-room panel...');
    const tabResult = await cdp.evaluate(`(() => {
      const btn = document.querySelector('[data-tab="team"], .nav-team, #nav-team, a[href="#team"]');
      if (btn) { btn.click(); return 'clicked tab'; }
      return 'no tab button found';
    })()`);
    log('tab activation:', tabResult);

    await sleep(500);
    const roomClick = await cdp.evaluate(`(() => {
      const item = document.querySelector('[data-room-id=' + ${JSON.stringify(JSON.stringify(roomId))} + ']')
               || Array.from(document.querySelectorAll('.tr-room-item, .room-item, li')).find(el => (el.textContent||'').includes('2.2 token'));
      if (item) { item.click(); return 'clicked room'; }
      return 'room item not found';
    })()`);
    log('room click:', roomClick);

    await sleep(500);
    await cdp.screenshot('token-badge-00-before-send.png');

    log('sending prompt...');
    await cdp.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      window.__teamAskResult = null;
      try {
        const r = await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, ${JSON.stringify('@小火龙 一句话介绍你自己。')});
        window.__teamAskResult = r;
      } catch (e) { window.__teamAskResult = { error: String(e?.message || e) }; }
    })()`);

    const started = Date.now();
    while ((Date.now() - started) < 120000) {
      await sleep(2500);
      const snap = await cdp.evaluate(`({
        ev: (window.__teamEvents || []).length,
        hasMsg: (window.__teamEvents || []).some(x => x?.ev?.data?.type === 'message' && x.ev.data.actor === 'charmander'),
        ask: window.__teamAskResult,
      })`);
      log(`poll ev=${snap.ev} hasMsg=${snap.hasMsg} ask=${snap.ask ? 'done' : 'pending'}`);
      if (snap.hasMsg) break;
    }

    await sleep(2000);

    const domProof = await cdp.evaluate(`(() => {
      const spans = document.querySelectorAll('.tr-msg-tokens');
      const result = [];
      for (const s of spans) {
        result.push({
          outerHTML: s.outerHTML,
          text: s.textContent,
          title: s.getAttribute('title'),
          visible: !!s.offsetParent,
        });
      }
      const msgCount = document.querySelectorAll('.tr-msg').length;
      return { tokenSpansCount: spans.length, totalMessagesInDom: msgCount, spans: result };
    })()`);

    log('\n=== DOM PROOF ===');
    log(`total .tr-msg elements in DOM: ${domProof.totalMessagesInDom}`);
    log(`total .tr-msg-tokens spans: ${domProof.tokenSpansCount}`);
    for (const s of domProof.spans) {
      log(`  text=${JSON.stringify(s.text)} title=${JSON.stringify(s.title)} visible=${s.visible}`);
      log(`  html=${s.outerHTML}`);
    }

    await cdp.screenshot('token-badge-01-after-reply.png');

    await cdp.evaluate(`(() => {
      const panel = document.querySelector('#team-room-panel, .tr-panel, .team-room, #team');
      if (panel) { panel.style.display = 'block'; panel.style.visibility = 'visible'; }
      const thread = document.querySelector('#tr-thread, .tr-thread, #thread');
      if (thread) thread.scrollIntoView({behavior: 'auto', block: 'center'});
      const lastMsg = document.querySelectorAll('.tr-msg');
      if (lastMsg.length) lastMsg[lastMsg.length - 1].scrollIntoView({behavior: 'auto', block: 'center'});
      return 'done';
    })()`);
    await sleep(500);
    await cdp.screenshot('token-badge-02-forced-visible.png');

  } catch (e) {
    log('ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    logStream.end();
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();

setTimeout(() => { log('hard timeout 240s'); logStream.end(); process.exit(3); }, 240000);
