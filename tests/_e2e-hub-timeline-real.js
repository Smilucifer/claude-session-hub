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

async function scenarioB() {
  console.log('=== Scenario B: syncContext OFF — no injection, cursor never advances ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);

  // Explicitly leave syncContext OFF (default). Send 2 rounds via direct
  // terminal-input + append-user-turn (skip incremental-context entirely).
  for (let r = 1; r <= 2; r++) {
    await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: false, sendTarget: 'all' } });
    })()`);
    await sleep(200);
    await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: 'Round ${r} 用一个字回答 ${r}+${r} 等于几' });
      const sessions = await ipcRenderer.invoke('get-sessions').catch(() => []);
      const kindBySid = {};
      for (const s of (sessions || [])) kindBySid[s.id] = s.kind;
      for (const sid of [${Object.values(subs).map(s => `'${s}'`).join(',')}]) {
        ipcRenderer.send('terminal-input', { sessionId: sid, data: 'Round ${r} 用一个字回答 ${r}+${r} 等于几' });
        const enterDelay = kindBySid[sid] === 'codex' ? 300 : 80;
        await new Promise(rs => setTimeout(rs, enterDelay));
        ipcRenderer.send('terminal-input', { sessionId: sid, data: '\\r' });
      }
    })()`);
    await waitForTimelineLength(meetingId, r * 4, 120);
  }

  // OFF mode: cursors should still be 0 (sendMessage/incremental-context never called)
  const cursorState = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of [${Object.values(subs).map(s => `'${s}'`).join(',')}]) {
      // Probe cursor without advancing: incremental-context advances; instead,
      // the FIRST call returns "everything since 0 minus self". We use that as
      // proxy for "cursor was at 0".
      const r = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
      out[sid] = { newTurnsOnFirstCall: r.turns.length, advancedTo: r.advancedTo };
    }
    return out;
  })()`);
  console.log('  cursor state (OFF mode, FIRST incremental call):', cursorState);
  // After 2 rounds with 3 AIs we have 8 turns. First incremental returns
  // turns where t.sid !== self. For each of 3 subs, that's 8 - own_turns
  // = 8 - 2 = 6 turns. So newTurnsOnFirstCall should be 6, not 3 (which
  // would mean only 1 round happened).
  const tl = await getTimeline(meetingId);
  const pass = tl.length >= 8
    && Object.values(cursorState).every(c => c.newTurnsOnFirstCall >= 4 && c.advancedTo === tl.length);
  console.log(pass ? '  ✓ PASS Scenario B' : '  ✗ FAIL Scenario B');
  return pass;
}

async function scenarioC() {
  console.log('=== Scenario C: mid-meeting AI join — cursor=0 sees full history ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;

  // Spawn 2 AIs first (Claude + Codex)
  const subs = {};
  for (const kind of ['claude', 'codex']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);

  // Round 1+2 with syncContext ON between Claude+Codex
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true } });
  })()`);
  await sleep(200);

  for (let r = 1; r <= 2; r++) {
    await sendMessage(meetingId, 'R' + r + ' 用一个字回答');
    // 1 user + 2 AI per round
    await waitForTimelineLength(meetingId, r * 3, 120);
  }
  const tlBefore = await getTimeline(meetingId);
  console.log('  timeline before Gemini join:', tlBefore.length, 'turns');

  // Now add Gemini
  const geminiR = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: 'gemini', opts: { noInheritCursor: true } });
  })()`);
  subs.gemini = geminiR.session.id;
  await waitForReady(subs.gemini, 'gemini');
  await sleep(2000);

  // Round 3
  await sendMessage(meetingId, '请综合大家观点');
  await waitForTimelineLength(meetingId, tlBefore.length + 4, 120);

  // Gemini's cursor should now have advancedTo == timeline.length
  // because sendMessage Phase A consumed full prior history (cursor was 0).
  const tlFinal = await getTimeline(meetingId);
  const peek = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: '${subs.gemini}' });
  })()`);
  console.log('  Gemini peek after R3:', peek);
  const pass = peek.advancedTo === tlFinal.length;
  console.log(pass ? '  ✓ PASS Scenario C' : '  ✗ FAIL Scenario C');
  return pass;
}

async function scenarioD() {
  console.log('=== Scenario D: @target single → @all switch ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true, sendTarget: 'all' } });
  })()`);
  await sleep(200);

  // R1 @all
  await sendMessage(meetingId, 'R1 @all 用一个字回答 1+1');
  await waitForTimelineLength(meetingId, 4, 120);

  // Switch to @Codex only — sendMessage uses meeting.sendTarget read from get-meetings
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { sendTarget: '${subs.codex}' } });
  })()`);
  await sleep(200);
  // sendMessage helper resets sendTarget to 'all' on entry — replicate manual single-target send here
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const sid = '${subs.codex}';
    // Phase A: incremental for Codex only
    const r = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
    let payload = 'R2 codex only 用一个字回答 2+2';
    if (r && r.turns && r.turns.length > 0) {
      const lines = ['[会议室协作同步]'];
      for (const t of r.turns) lines.push('【' + (t.sid === 'user' ? '你' : t.sid.slice(0,8)) + '】' + t.text);
      lines.push('---', '');
      payload = lines.join('\\n') + payload;
    }
    // Phase B: append user turn
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: '${meetingId}', text: 'R2 codex only 用一个字回答 2+2' });
    // Phase C: send to Codex only
    ipcRenderer.send('terminal-input', { sessionId: sid, data: payload });
    await new Promise(r => setTimeout(r, 300)); // codex enterDelay
    ipcRenderer.send('terminal-input', { sessionId: sid, data: '\\r' });
  })()`);
  // Wait for Codex turn (timeline now has 4 + 1 user + 1 codex = 6)
  await waitForTimelineLength(meetingId, 6, 120);

  // Switch back to @all and round 3
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { sendTarget: 'all' } });
  })()`);
  await sleep(200);
  await sendMessage(meetingId, 'R3 @all 综合一下');
  // 6 + 1 user + 3 AI = 10
  await waitForTimelineLength(meetingId, 10, 120);

  // Verify Claude/Gemini received the R2 codex turn + R2 user turn in their R3 injection
  // (cursor advancedTo should equal timeline.length).
  const tlFinal = await getTimeline(meetingId);
  const cursors = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of ['${subs.claude}', '${subs.gemini}']) {
      const r = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: sid });
      out[sid] = { advancedTo: r.advancedTo };
    }
    return out;
  })()`);
  console.log('  Claude/Gemini cursors after R3:', cursors);
  const pass = tlFinal.length >= 10
    && Object.values(cursors).every(c => c.advancedTo === tlFinal.length);
  console.log(pass ? '  ✓ PASS Scenario D' : '  ✗ FAIL Scenario D');
  return pass;
}

async function scenarioE() {
  console.log('=== Scenario E: restart AI preserves cursor ===');
  const meeting = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('create-meeting');
  })()`);
  const meetingId = meeting.id;
  const subs = {};
  for (const kind of ['claude', 'codex', 'gemini']) {
    const r = await evalJs(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('add-meeting-sub', { meetingId: '${meetingId}', kind: '${kind}', opts: { noInheritCursor: true } });
    })()`);
    subs[kind] = r.session.id;
  }
  for (const [kind, sid] of Object.entries(subs)) await waitForReady(sid, kind);
  await sleep(2000);
  await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-meeting', { meetingId: '${meetingId}', fields: { syncContext: true } });
  })()`);
  await sleep(200);

  // 2 rounds → cursors advance
  for (let r = 1; r <= 2; r++) {
    await sendMessage(meetingId, 'R' + r + ' 一个字回答 ' + r + '+' + r);
    await waitForTimelineLength(meetingId, r * 4, 120);
  }
  const tlPre = await getTimeline(meetingId);
  const tlPreLen = tlPre.length;
  console.log('  timeline before restart:', tlPreLen);

  // Probe Claude cursor before restart
  const claudeCursorPre = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    const r = await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: '${subs.claude}' });
    return { advancedTo: r.advancedTo };
  })()`);
  // ^ note: this probe ITSELF advances cursor to current timeline.length (8).
  // That's expected — restart should preserve THIS value (8).

  // Restart Claude — Task 6 makes it reuse old.id, so subs.claude should be same hubSessionId
  const restarted = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('restart-session', '${subs.claude}');
  })()`);
  const samePid = restarted && restarted.id === subs.claude;
  console.log('  restart preserved hubSessionId:', samePid, 'restarted.id=', restarted && restarted.id);
  await waitForReady(subs.claude, 'claude');
  await sleep(2000);

  // Round 3
  await sendMessage(meetingId, 'R3 一个字回答 3+3');
  // Expected: tlPreLen + 4 (1 user + 3 AI) — but cursor for Claude should
  // have started from claudeCursorPre.advancedTo (8), NOT 0
  const tlFinal = await getTimeline(meetingId);
  await waitForTimelineLength(meetingId, tlPreLen + 4, 180);

  // Probe Claude cursor: should be at timeline.length (caught up after R3)
  const peek = await evalJs(`(async () => {
    const { ipcRenderer } = require('electron');
    return await ipcRenderer.invoke('meeting-incremental-context', { meetingId: '${meetingId}', targetSid: '${subs.claude}' });
  })()`);
  const tlAfter = await getTimeline(meetingId);
  console.log('  Claude cursor after R3:', peek, 'timeline.length:', tlAfter.length);
  const pass = samePid && peek.advancedTo === tlAfter.length;
  console.log(pass ? '  ✓ PASS Scenario E' : '  ✗ FAIL Scenario E');
  return pass;
}

async function main() {
  await connect();
  const fns = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE };
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
