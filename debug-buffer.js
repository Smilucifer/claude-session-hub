// Debug: create session, wait, dump xterm buffer content
const WebSocket = require('ws');
const http = require('http');

let ws, msgId = 0;

async function getPageWs() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const pages = JSON.parse(data);
        const hub = pages.find(p => p.title === 'Claude Session Hub');
        if (!hub) reject(new Error('not found'));
        else resolve(hub.webSocketDebuggerUrl);
      });
    }).on('error', reject);
  });
}

async function connect() {
  const wsUrl = await getPageWs();
  ws = new WebSocket(wsUrl);
  await new Promise(r => ws.on('open', r));
}

function evaluate(expr) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      }
    };
    ws.on('message', handler);
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('timeout')); }, 30000);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  await connect();
  console.log('Connected');

  // Create Claude session
  await evaluate('document.getElementById("btn-new").click()');
  await sleep(200);
  await evaluate('document.querySelector("[data-kind=claude]").click()');
  console.log('Session created, waiting 20s for Claude Code...');
  await sleep(20000);

  // Dump buffer content
  const bufferDump = await evaluate(`
    (function() {
      const cached = Array.from(terminalCache.values())[0];
      if (!cached || !cached.opened) return 'NO_TERMINAL';
      const buf = cached.terminal.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) {
          const text = line.translateToString(true).trim();
          if (text) lines.push(i + ': ' + JSON.stringify(text));
        }
      }
      return lines.join('\\n');
    })()
  `);
  console.log('\\n=== BUFFER CONTENT ===');
  console.log(bufferDump);

  // Check session state
  const state = await evaluate('JSON.stringify(Array.from(sessions.values())[0], null, 2)');
  console.log('\\n=== SESSION STATE ===');
  console.log(state);

  ws.close();
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
