/**
 * Debug script: check if meeting room PTY sessions actually produce output.
 * Launch Hub, create meeting, add Gemini sub, monitor ring buffer for 30s.
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const CDP_PORT = 9879;
const DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-debug-pty';
const HUB_DIR = 'C:\\Users\\lintian\\claude-session-hub';

let ws, msgId = 0, hubProc = null;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)); } }, 30000);
  });
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const electronExe = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  hubProc = spawn(electronExe, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR,
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hubProc.stdout.on('data', d => { const l = d.toString().trim(); if (l) console.log(`[hub] ${l}`); });
  hubProc.stderr.on('data', d => { const l = d.toString().trim(); if (l && !l.includes('DevTools listening')) console.log(`[hub-err] ${l}`); });

  // Wait CDP
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { const l = JSON.parse(d); if (l.length) resolve(l); else reject(); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      console.log(`CDP ready after ${i+1}s`);
      break;
    } catch {}
  }
  await sleep(3000);

  // Connect
  const listResp = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  const page = listResp.filter(p => p.type === 'page' && !p.url.startsWith('devtools://'))[0];
  await new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', resolve);
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result); }
    });
    ws.on('error', reject);
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(1000);

  // Create meeting + add gemini
  console.log('\n--- Creating meeting + Gemini sub ---');
  const mRaw = await evalJs(`(async () => { const {ipcRenderer}=require('electron'); return JSON.stringify(await ipcRenderer.invoke('create-meeting')); })()`);
  const m = JSON.parse(mRaw);
  console.log(`Meeting: ${m.id}`);

  const gRaw = await evalJs(`(async () => { const {ipcRenderer}=require('electron'); const r=await ipcRenderer.invoke('add-meeting-sub',{meetingId:'${m.id}',kind:'gemini'}); return JSON.stringify({sid:r.session.id,kind:r.session.kind}); })()`);
  const g = JSON.parse(gRaw);
  console.log(`Gemini session: ${g.sid}`);

  // Click sidebar to open meeting
  await evalJs(`(() => { const item=document.querySelector('.session-item.meeting'); if(item) item.click(); return 'ok'; })()`);
  console.log('Opened meeting in sidebar');
  await sleep(3000);

  // Monitor ring buffer every 2s for 30s
  console.log('\n--- Monitoring ring buffer for 30s ---');
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const info = await evalJs(`(async () => {
      const {ipcRenderer}=require('electron');
      const buf = await ipcRenderer.invoke('get-ring-buffer', '${g.sid}');
      const ms = await ipcRenderer.invoke('marker-status', '${g.sid}');
      const last100 = buf ? buf.slice(-100) : '';
      return JSON.stringify({ len: buf?buf.length:0, ms, last100 });
    })()`);
    const d = JSON.parse(info);
    console.log(`  [${(i+1)*2}s] bufLen=${d.len}, marker=${d.ms}, tail="${d.last100.replace(/[\r\n]/g,'\\n').substring(0,80)}"`);
  }

  // Cleanup
  console.log('\nDone. Cleaning up.');
  try { ws.close(); } catch {}
  try { execSync(`taskkill /PID ${hubProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
}

main().catch(err => {
  console.error('Fatal:', err);
  if (hubProc) try { execSync(`taskkill /PID ${hubProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  process.exit(1);
});
