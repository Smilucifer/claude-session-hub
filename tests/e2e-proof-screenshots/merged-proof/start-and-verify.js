#!/usr/bin/env node
/**
 * Merged branch (ACP + Codex) smoke verification.
 * Spawns isolated Hub, waits for CDP, screenshots, kills Hub.
 * Does not invoke any CLI — keeps it fast + cheap.
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';
const DATA_DIR = 'C:\\Users\\lintian\\hub-merged-data';
const SHOT_DIR = path.join(HUB_DIR, 'tests', 'e2e-proof-screenshots', 'merged-proof');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9225;

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';
const logStream = fs.createWriteStream(path.join(SHOT_DIR, 'merged-verify.log'), { flags: 'w' });
function log(...a) {
  const line = `[${el()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
  });
}

(async () => {
  const hubStderrLog = fs.openSync(path.join(SHOT_DIR, 'hub-stderr.log'), 'w');
  const env = {
    ...process.env,
    CLAUDE_HUB_DATA_DIR: DATA_DIR,
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
  };

  log(`spawning electron`, ELECTRON);
  const hub = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  let stderrBuf = '';
  hub.stdout.on('data', d => { fs.writeSync(hubStderrLog, d); });
  hub.stderr.on('data', d => { fs.writeSync(hubStderrLog, d); stderrBuf += d.toString('utf-8'); });
  hub.on('exit', c => log(`hub exited code=${c}`));

  const stopHub = () => { try { hub.kill('SIGTERM'); } catch {} };

  let page = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await get(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (r.status === 200) {
        const pgs = JSON.parse(r.body).filter(p => p.type === 'page' && !p.url.startsWith('devtools://'));
        if (pgs.length) { page = pgs[0]; break; }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!page) { log('ERROR: CDP never came up'); stopHub(); process.exit(2); }
  log(`CDP page: ${page.id} url=${page.url}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  log('WS connected');

  let nextId = 0;
  const pending = new Map();
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const slot = pending.get(m.id); pending.delete(m.id);
      if (m.error) slot.reject(new Error(m.error.message)); else slot.resolve(m.result);
    }
  });
  const cdpSend = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async expr => {
    const r = await cdpSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || '').slice(0, 200));
    return r.result && r.result.value;
  };

  await cdpSend('Page.enable');
  await cdpSend('Runtime.enable');
  await new Promise(r => setTimeout(r, 2500));

  const title = await evalJs('document.title');
  log(`title=${JSON.stringify(title)}`);
  const bodyLen = await evalJs('document.body.innerHTML.length');
  log(`body.innerHTML.length=${bodyLen}`);

  const shot1 = await cdpSend('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, '01-hub-launched.png'), Buffer.from(shot1.data, 'base64'));
  log('screenshot: 01-hub-launched.png');

  const tabResult = await evalJs(`(() => {
    const btns = Array.from(document.querySelectorAll('button, a, [role=tab], .tab, .sidebar-item, [data-tab]'));
    const hit = btns.find(b => /team|协作|房间|Team/i.test(b.textContent || '') || /team/i.test(b.getAttribute?.('data-tab') || ''));
    if (hit) { hit.click(); return 'team-clicked:' + (hit.textContent||'').trim().slice(0,30); }
    return 'no-team-tab';
  })()`);
  log(`team tab: ${tabResult}`);
  await new Promise(r => setTimeout(r, 1500));

  const shot2 = await cdpSend('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, '02-after-team-click.png'), Buffer.from(shot2.data, 'base64'));
  log('screenshot: 02-after-team-click.png');

  const chars = await evalJs(`(async () => {
    try {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:loadCharacters');
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  log(`team:loadCharacters = ${JSON.stringify(chars).slice(0, 800)}`);

  const rooms = await evalJs(`(async () => {
    try {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:loadRooms');
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  log(`team:loadRooms = ${JSON.stringify(rooms).slice(0, 400)}`);

  const inited = await evalJs(`(async () => {
    try {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('team:isInitialized');
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  log(`team:isInitialized = ${JSON.stringify(inited)}`);

  const hookLine = (stderrBuf.match(/hook server listening on 127\.0\.0\.1:\d+/) || [])[0] || '(not found)';
  log(`stderr: hook line = ${hookLine}`);
  const tsmLine = (stderrBuf.match(/team-bridge.*|TeamSessionManager.*|TSM.*/i) || [])[0] || '(no explicit TSM init log)';
  log(`stderr: tsm hint  = ${tsmLine}`);
  const errLine = (stderrBuf.match(/App threw an error.*|Cannot find module.*|Error:.*|TypeError:.*/i) || [])[0] || '(no boot error)';
  log(`stderr: err hint  = ${errLine}`);

  log('=== DONE, killing hub ===');
  stopHub();
  await new Promise(r => setTimeout(r, 2000));
  logStream.end();
  process.exit(0);
})().catch(e => {
  log('FATAL:', e.message);
  try { logStream.end(); } catch {}
  process.exit(3);
});
