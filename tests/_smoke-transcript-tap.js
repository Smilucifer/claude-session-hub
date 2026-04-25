/**
 * Smoke test: verify transcript-tap integration via CDP + IPC eval.
 *
 * Prereq: Hub already running on CDP port 9221 with CLAUDE_HUB_DATA_DIR set.
 *
 * Checks:
 *   1. IPC handler 'get-last-assistant-text' is registered (returns null for
 *      unknown sid, not error)
 *   2. get-marker-instruction still callable (fallback path preserved)
 *   3. quick-summary + marker-status still work for unknown sid
 */
'use strict';

const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = 9221;

let ws;
let msgId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, 10000);
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

async function main() {
  const pagesRaw = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });

  const pages = pagesRaw.filter(p => p.type === 'page' && !p.url.startsWith('devtools://'));
  if (pages.length === 0) throw new Error('No CDP pages');
  const target = pages[0];
  console.log(`CDP target: ${target.title}`);

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

  let failCount = 0;
  const pass = (name, v) => {
    console.log(`  [${v ? 'PASS' : 'FAIL'}] ${name}`);
    if (!v) failCount++;
  };

  const result1 = await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      try {
        const r = await ipcRenderer.invoke('get-last-assistant-text', 'definitely-not-a-real-sid');
        return { ok: true, val: r };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    })()
  `);
  pass('get-last-assistant-text IPC registered, returns null for unknown sid',
    result1.ok && result1.val === null);
  console.log(`    actual: ${JSON.stringify(result1)}`);

  const result2 = await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      try {
        const r = await ipcRenderer.invoke('get-marker-instruction');
        return { ok: true, val: r };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    })()
  `);
  pass('get-marker-instruction still callable (fallback preserved)',
    result2.ok && typeof result2.val === 'string' && result2.val.includes('SM-START'));
  console.log(`    actual: ${JSON.stringify(result2).slice(0, 200)}`);

  const result3 = await evalJs(`
    (async () => {
      const { ipcRenderer } = require('electron');
      const a = await ipcRenderer.invoke('quick-summary', 'fake-sid');
      const b = await ipcRenderer.invoke('marker-status', 'fake-sid');
      return { quickSummary: a, markerStatus: b };
    })()
  `);
  pass('quick-summary + marker-status IPC still work for unknown sid',
    typeof result3.quickSummary === 'string' && typeof result3.markerStatus === 'string');
  console.log(`    actual: ${JSON.stringify(result3)}`);

  // Test 4: verify MeetingBlackboard.resolveSummary is in place (indirect check:
  // it's IIFE-scoped, but confirm the module loaded successfully by checking
  // that MeetingBlackboard is exposed on window with all 4 public methods).
  const result4 = await evalJs(`
    (async () => {
      if (typeof MeetingBlackboard === 'undefined') return { loaded: false };
      return {
        loaded: true,
        methods: {
          renderBlackboard: typeof MeetingBlackboard.renderBlackboard,
          renderBlackboardToolbar: typeof MeetingBlackboard.renderBlackboardToolbar,
          clearCache: typeof MeetingBlackboard.clearCache,
          handleSyncFromFocus: typeof MeetingBlackboard.handleSyncFromFocus,
        },
      };
    })()
  `);
  const mbOk = result4.loaded && Object.values(result4.methods || {}).every(t => t === 'function');
  pass('MeetingBlackboard IIFE loaded with all 4 public methods', mbOk);
  console.log(`    actual: ${JSON.stringify(result4)}`);

  ws.close();
  console.log(`\nSmoke test complete: ${failCount === 0 ? 'ALL PASS' : failCount + ' FAILURES'}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
