/**
 * Real E2E for transcript-tap: spawn Gemini PTY sub-session, send a message,
 * wait for transcript-tap to capture the authoritative answer from Gemini's
 * ~/.gemini/tmp/<dir>/chats/session-*.jsonl.
 *
 * Prereq: Hub running on CDP 9221 with CLAUDE_HUB_DATA_DIR isolated.
 *
 * Success: get-last-assistant-text returns a non-null string containing the
 * answer within ~60 seconds of sending the message.
 */
'use strict';

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CDP_PORT = parseInt(process.env.CDP_PORT || '9221', 10);

let ws;
let msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }
    }, 15000);
  });
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const pages = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const target = pages.find(p => p.type === 'page' && !p.url.startsWith('devtools://'));
  if (!target) throw new Error('No CDP page');

  await new Promise((resolve, reject) => {
    ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });
  });
  await cdp('Runtime.enable');

  // Bypass meeting-room (which would need xterm attached for ConPTY output to
  // flow under default conptyInheritCursor:true). Use create-session with
  // noInheritCursor so the headless E2E sees PTY output.
  const KIND = process.env.KIND || 'codex';
  console.log(`[e2e] creating standalone ${KIND} session (noInheritCursor for headless)`);
  const step1 = await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      const session = await ipcRenderer.invoke('create-session', { kind: '${KIND}', opts: { noInheritCursor: true } });
      return { session };
    })()
  `);
  console.log('  session:', step1.session?.id, 'kind:', step1.session?.kind, 'cwd:', step1.session?.cwd);
  if (!step1.session?.id) { console.error('Failed to create Gemini session'); process.exit(1); }
  const sid = step1.session.id;

  console.log('[e2e] waiting for CLI TUI ready (up to 90s)...');
  let ready = false;
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    const check = await evalJs(`
      (async () => {
        const { ipcRenderer } = require('electron');
        const buf = await ipcRenderer.invoke('get-ring-buffer', '${sid}');
        return buf || '';
      })()
    `).catch(() => '');
    // Codex TUI: wait for the Context line which only appears when fully ready.
    if (typeof check === 'string' && /Context\\s+\\d+% left|Workspace|Type your message/i.test(check)) {
      ready = true;
      console.log(`  ready after ${(i + 1) * 0.5}s (buffer len=${check.length})`);
      break;
    }
  }
  if (!ready) {
    console.warn('  Gemini TUI not visibly ready after 30s, trying anyway');
  }

  await sleep(2000);

  console.log('[e2e] sending test message (without SM-START marker injection)');
  await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('terminal-input', { sessionId: '${sid}', data: '用一个字回答: 1+1等于几' });
    })()
  `);
  // Codex TUI needs ~1s for the input box to register the typed text before
  // the Enter keypress is honored. Give it generous breathing room.
  await sleep(1500);
  await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('terminal-input', { sessionId: '${sid}', data: '\\r' });
    })()
  `);

  console.log('[e2e] polling get-last-assistant-text (up to 60s)');
  let captured = null;
  const startPoll = Date.now();
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const val = await evalJs(`
      (async () => {
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke('get-last-assistant-text', '${sid}');
      })()
    `).catch(() => null);
    if (typeof val === 'string' && val.trim()) {
      captured = val;
      console.log(`  captured after ${((Date.now() - startPoll) / 1000).toFixed(1)}s`);
      break;
    }
  }

  if (captured) {
    console.log(`  [PASS] get-last-assistant-text returned: ${JSON.stringify(captured).slice(0, 500)}`);
  } else {
    console.log('  [FAIL] get-last-assistant-text never returned non-null within 60s');
  }

  const marker = await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      const q = await ipcRenderer.invoke('quick-summary', '${sid}');
      const s = await ipcRenderer.invoke('marker-status', '${sid}');
      return { quick: q, status: s };
    })()
  `);
  console.log(`  marker fallback: status=${marker.status} quick=${JSON.stringify(marker.quick).slice(0, 100)}`);

  // Inspect what rollout file got written (Codex)
  const today = new Date();
  const codexDir = path.join(os.homedir(), '.codex', 'sessions',
    String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'));
  const recentRollouts = [];
  try {
    const files = fs.readdirSync(codexDir);
    for (const f of files) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const fp = path.join(codexDir, f);
      try {
        const st = fs.statSync(fp);
        if (Date.now() - st.mtimeMs < 180000) recentRollouts.push({ fp, mtime: st.mtimeMs });
      } catch {}
    }
  } catch {}
  recentRollouts.sort((a, b) => b.mtime - a.mtime);
  if (recentRollouts[0]) {
    console.log(`\n[e2e] most recent Codex rollout file (<180s old):`);
    console.log(`  ${recentRollouts[0].fp}`);
    try {
      const content = fs.readFileSync(recentRollouts[0].fp, 'utf8');
      const lines = content.trim().split('\n').slice(-5);
      console.log('  last 5 lines:');
      for (const l of lines) console.log('    ' + l.slice(0, 300));
    } catch {}
  } else {
    console.log('\n[e2e] no recent Codex rollout file found — Codex likely did not complete a turn');
  }

  ws.close();
  process.exit(captured ? 0 : 1);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
