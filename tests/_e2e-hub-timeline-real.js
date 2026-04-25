/**
 * E2E test for Hub Timeline phase 1.
 * Prerequisite: Hub running on CDP_PORT (default 9220).
 * Start a Hub instance manually with isolated data dir, e.g.:
 *   CLAUDE_HUB_DATA_DIR=$HOME/.claude-hub-timeline-test \
 *     ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9220
 *
 * Then: SCENARIO=A node tests/_e2e-hub-timeline-real.js
 */
'use strict';
const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = parseInt(process.env.CDP_PORT || '9220', 10);
const SCENARIO = process.env.SCENARIO || 'A';

let ws, msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }
    }, 30000);
  });
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect() {
  const pages = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const page = pages.find(p => p.type === 'page' && !p.url.startsWith('devtools://'));
  if (!page) throw new Error('No CDP page');
  await new Promise((resolve, reject) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
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
}

async function waitForReady(sid, kindHint, maxSec = 90) {
  for (let i = 0; i < maxSec * 2; i++) {
    await sleep(500);
    const buf = await evalJs(`
      (async () => {
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke('get-ring-buffer', '${sid}');
      })()
    `).catch(() => '');
    if (typeof buf === 'string') {
      if (kindHint === 'codex' && /Context\s+\d+% left/i.test(buf)) return true;
      if (kindHint === 'gemini' && /Type your message/i.test(buf)) return true;
      if (kindHint === 'claude' && /\$|>|❯/.test(buf) && buf.length > 200) return true;
    }
  }
  return false;
}

async function getTimeline(meetingId) {
  return await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('meeting-get-timeline', '${meetingId}');
    })()
  `);
}

async function sendMessage(meetingId, text) {
  await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true, sendTarget: 'all' } });
    })()
  `);
  await sleep(200);
  await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      const meetings = await ipcRenderer.invoke('get-meetings').catch(() => []);
      const meeting = meetings.find(m => m.id === '${meetingId}');
      if (!meeting) return;
      const subs = (meeting.subSessions || []).filter(sid => sid);

      // Phase A: incremental context BEFORE user-turn append (mirrors handleMeetingSend fix)
      const ctxBySid = {};
      for (const sid of subs) {
        const r = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
        if (r && r.turns && r.turns.length > 0) {
          const lines = ['[会议室协作同步]'];
          for (const t of r.turns) {
            const lbl = t.sid === 'user' ? '你' : t.sid.slice(0, 8);
            lines.push('【' + lbl + '】' + t.text);
          }
          lines.push('---', '');
          ctxBySid[sid] = lines.join('\\n');
        }
      }

      // Phase B: append user turn (after cursor advance)
      await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: ${JSON.stringify(text)} });

      // Phase C: send to each sub
      // Get session kinds so we can use codex-specific enter delay (300ms)
      const sessions = await ipcRenderer.invoke('get-sessions').catch(() => []);
      const kindBySid = {};
      for (const s of (sessions || [])) kindBySid[s.id] = s.kind;
      for (const sid of subs) {
        const payload = (ctxBySid[sid] || '') + ${JSON.stringify(text)};
        ipcRenderer.send('terminal-input', { sessionId: sid, data: payload });
        const enterDelay = kindBySid[sid] === 'codex' ? 300 : 80;
        await new Promise(r => setTimeout(r, enterDelay));
        ipcRenderer.send('terminal-input', { sessionId: sid, data: '\\r' });
      }
    })()
  `);
}

async function waitForTimelineLength(meetingId, expected, maxSec = 120) {
  for (let i = 0; i < maxSec; i++) {
    await sleep(1000);
    const tl = await getTimeline(meetingId);
    if (tl.length >= expected) return tl;
  }
  return await getTimeline(meetingId);
}

// === Scenarios ===

async function scenarioA() {
  console.log('=== Scenario A: 3 AIs + syncContext ON + 2 rounds ===');

  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  console.log('  meeting:', meetingId);

  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    console.log('  spawning', kind);
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', {
        meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true }
      });
    })()`);
    if (!r || !r.session) {
      console.error('  FAIL: add-meeting-sub returned', r);
      return false;
    }
    subs[kind] = r.session.id;
  }

  console.log('  waiting for all 3 TUIs ready (up to 90s each)');
  for (const [kind, sid] of Object.entries(subs)) {
    const ok = await waitForReady(sid, kind);
    console.log('    ', kind, ok ? 'READY' : 'NOT READY (proceeding anyway)');
  }
  await sleep(2000);

  console.log('  Round 1: send "用一个字回答: 1+1 等于几"');
  await sendMessage(meetingId, '用一个字回答: 1+1 等于几');

  let tl1 = await waitForTimelineLength(meetingId, 4, 120);
  console.log('  timeline after R1:', tl1.length, 'turns');
  for (const t of tl1) console.log('   ', t.idx, t.sid.slice(0, 8), JSON.stringify(t.text).slice(0, 60));

  if (tl1.length < 4) {
    console.error('  FAIL: expected 4 turns, got', tl1.length);
    return false;
  }

  console.log('  Round 2: send "把刚才的答案翻译成英文"');
  await sendMessage(meetingId, '把刚才的答案翻译成英文');

  let tl2 = await waitForTimelineLength(meetingId, 8, 120);
  console.log('  timeline after R2:', tl2.length, 'turns');
  for (const t of tl2) console.log('   ', t.idx, t.sid.slice(0, 8), JSON.stringify(t.text).slice(0, 60));

  // Validate cursors all advanced (incremental-context returns 0 new turns)
  const cursors = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of [${Object.values(subs).map(s => `'${s}'`).join(',')}]) {
      const r = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
      out[sid] = { newTurns: r.turns.length, advancedTo: r.advancedTo };
    }
    return out;
  })()`);
  console.log('  cursor state:', cursors);

  // Pass criteria: timeline has >= 8 turns AND every cursor advanced to timeline length.
  // Note: cursor advances during Phase A of sendMessage to (old) timeline.length,
  // before new AI turns arrive. So immediately after sendMessage, a fresh
  // incremental-context call will advance cursor to NEW timeline length but
  // returns the new AI turns it just consumed. The right invariant is
  // advancedTo === current timeline length (cursor caught up).
  const pass = tl2.length >= 8
    && Object.values(cursors).every(c => c.advancedTo === tl2.length);
  console.log(pass ? '  ✓ PASS Scenario A' : '  ✗ FAIL Scenario A');
  return pass;
}

async function main() {
  await connect();
  const fns = { A: scenarioA };
  let passed = 0, failed = 0;
  if (SCENARIO === 'all') {
    for (const [name, fn] of Object.entries(fns)) {
      try { const ok = await fn(); if (ok) passed++; else failed++; }
      catch (e) { console.error('Scenario', name, 'threw:', e.message); failed++; }
    }
  } else if (fns[SCENARIO]) {
    const ok = await fns[SCENARIO]();
    if (ok) passed++; else failed++;
  } else {
    console.log('Unknown scenario:', SCENARIO);
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  ws.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
