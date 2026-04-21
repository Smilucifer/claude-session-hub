#!/usr/bin/env node
/**
 * Triangle联测 — 新起 Hub，建 room [pikachu, charmander, squirtle]，
 * 依次 @3 人各发 1 条短消息，每次截图 + 记录回复。
 * 消息刻意极短（"一句话/一个词"）控制 token 消耗。
 * Hub 使用独立 CLAUDE_HUB_DATA_DIR；AI_TEAM_DIR 用生产 .ai-team（角色数据在那里）。
 * 测试后通过 SQL 清理 room + events。
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const DATA_DIR = 'C:\\Users\\lintian\\hub-merged-data';
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'merged-proof');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9226;
const ROOM_NAME = 'triangle-' + Date.now();

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';
const logStream = fs.createWriteStream(path.join(SHOT_DIR, 'triangle-test.log'), { flags: 'w' });
function log(...a) {
  const line = `[${el()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

function httpGetJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); });
    this.ws.on('message', b => {
      const m = JSON.parse(b.toString());
      if (m.id != null && this.pending.has(m.id)) {
        const s = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) s.reject(new Error(m.error.message)); else s.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 420000 });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  }
  async shot(filename) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, filename), Buffer.from(r.data, 'base64'));
    log(`screenshot -> ${filename}`);
  }
}

async function askOne(cdp, roomId, message, actorLabel) {
  log(`--- asking ${actorLabel}: ${message} ---`);
  const startedAt = Date.now();
  const result = await cdp.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    try {
      return await ipcRenderer.invoke('team:ask', ${JSON.stringify(roomId)}, ${JSON.stringify(message)});
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`${actorLabel} replied in ${dur}s: ${JSON.stringify(result).slice(0, 600)}`);
  return { result, dur };
}

(async () => {
  fs.mkdirSync(path.join(DATA_DIR, 'electron-userdata'), { recursive: true });
  const stderrLog = fs.openSync(path.join(SHOT_DIR, 'triangle-hub-stderr.log'), 'w');

  log('spawning hub on CDP', CDP_PORT);
  const hub = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR,
    env: {
      ...process.env,
      CLAUDE_HUB_DATA_DIR: DATA_DIR,
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stdout.on('data', d => fs.writeSync(stderrLog, d));
  hub.stderr.on('data', d => fs.writeSync(stderrLog, d));
  hub.on('exit', c => log(`hub exit ${c}`));

  const stopHub = () => { try { hub.kill('SIGTERM'); } catch {} };

  let page = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const pg = r.filter(p => p.type === 'page' && !p.url.startsWith('devtools://'));
      if (pg.length) { page = pg[0]; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!page) { log('CDP never came up'); stopHub(); process.exit(2); }

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await new Promise(r => setTimeout(r, 2500));

  const inited = await cdp.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('team:isInitialized');
  })()`);
  log(`team:isInitialized = ${inited}`);
  if (!inited) { log('TSM not initialized'); stopHub(); process.exit(2); }

  log('creating room:', ROOM_NAME);
  const room = await cdp.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('team:createRoom', ${JSON.stringify(ROOM_NAME)}, ['pikachu', 'charmander', 'squirtle']);
  })()`);
  const roomId = room && (room.id || room.roomId);
  log(`room id = ${roomId}`);
  if (!roomId) { log('room create failed'); stopHub(); process.exit(2); }

  await cdp.shot('triangle-00-room-created.png');

  // @皮卡丘
  const pika = await askOne(cdp, roomId, '@皮卡丘 一句话介绍你自己。', '皮卡丘');
  await cdp.shot('triangle-01-pikachu-reply.png');

  // @小火龙
  const char = await askOne(cdp, roomId, '@小火龙 一句话介绍你自己。', '小火龙');
  await cdp.shot('triangle-02-charmander-reply.png');

  // @杰尼龟
  const squirt = await askOne(cdp, roomId, '@杰尼龟 一句话介绍你自己。', '杰尼龟');
  await cdp.shot('triangle-03-squirtle-reply.png');

  // Final combined screenshot with all 3 replies in thread
  await new Promise(r => setTimeout(r, 1500));
  await cdp.shot('triangle-04-final-thread.png');

  log('=== SUMMARY ===');
  const extract = r => {
    if (!r || r.error) return { error: r && r.error };
    const first = r.results && r.results[0];
    return first ? { content: (first.content || '').slice(0, 200), tokenCount: first.tokenCount || null } : { raw: JSON.stringify(r).slice(0, 200) };
  };
  const summary = {
    pikachu:    { dur: pika.dur,   ...extract(pika.result) },
    charmander: { dur: char.dur,   ...extract(char.result) },
    squirtle:   { dur: squirt.dur, ...extract(squirt.result) },
  };
  log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(SHOT_DIR, 'triangle-summary.json'), JSON.stringify({ roomId, roomName: ROOM_NAME, summary }, null, 2));

  log('=== done, killing hub ===');
  stopHub();
  await new Promise(r => setTimeout(r, 2500));
  logStream.end();
  process.exit(0);
})().catch(e => {
  log('FATAL', e.message);
  try { logStream.end(); } catch {}
  process.exit(3);
});
