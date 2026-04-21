'use strict';
/**
 * Tachibana E2E (严格): isolated Hub + Team Room UI + real Codex via @squirtle.
 *
 * Two-round resume verification:
 *   Round 1: @squirtle 推荐一个 json 库只答一个词
 *   Round 2: @squirtle 重复你刚刚回复的最后两个字
 *   Assertion: Round 2 包含 Round 1 回答的最后 2 个字 (证明 resume 保留 context)
 *
 * Filesystem assertion:
 *   ~/.codex/sessions/**\/*.jsonl 在两轮间只新增 1 个文件 (证明 resume 复用同一 session)
 *
 * Hub 策略:新建 9232 端口 + 专用 DATA_DIR,不 kill 任何其他 Hub,测试结束不关闭。
 *
 * Run: AI_TEAM_DIR=C:/Users/lintian/ai-team-tachibana \
 *      HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
 *      node tests/tachibana-e2e-codex.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');

const HUB_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  || path.join(os.tmpdir(), 'hub-tachibana-data-codex');
const AI_TEAM_DIR = process.env.AI_TEAM_DIR || 'C:/Users/lintian/ai-team-tachibana';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9232', 10);
const SCREENSHOTS = path.join(__dirname, 'tachibana-screenshots-codex');
const ELECTRON_EXE = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const GLOBAL_CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

const ROOM_ID = 'test-room';
const TARGET = 'squirtle';

const log = (...a) => console.log('[e2e]', ...a);

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function waitForCdpPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (r.status === 200) {
        const pages = JSON.parse(r.body).filter(p => p.type === 'page');
        if (pages.length > 0) return pages[0];
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Hub CDP never came up');
}

class Cdp {
  constructor(ws) { this._ws = ws; this._id = 0; this._pending = new Map(); }
  init() {
    this._ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expr, { awaitPromise = true, timeout = 30 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise,
      timeout: timeout * 1000,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
    return r.result && r.result.value;
  }
  async screenshot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(r.data, 'base64');
    const out = path.join(SCREENSHOTS, `${name}.png`);
    fs.writeFileSync(out, bytes);
    log(`screenshot: ${out} (${bytes.length} bytes)`);
  }
}

function snapshotSessions(dir) {
  const out = new Set();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.jsonl')) out.add(full);
    }
  };
  try { walk(dir); } catch {}
  return out;
}

async function sendMessageAndWait(cdp, msg, db, baselineRowid, phaseLabel) {
  log(`[${phaseLabel}] typing: ${JSON.stringify(msg)}`);
  await cdp.evalJs(`(() => {
    const box = document.getElementById('tr-input-box');
    box.innerText = ${JSON.stringify(msg)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise(r => setTimeout(r, 400));

  const clicked = await cdp.evalJs(`(() => {
    const btn = document.getElementById('tr-send-btn');
    if (!btn || btn.disabled) return 'disabled-or-missing';
    btn.click();
    return 'clicked';
  })()`);
  log(`[${phaseLabel}] send btn: ${clicked}`);

  const qLatest = db.prepare(
    "SELECT rowid AS r, content AS c FROM events WHERE room_id = ? AND actor = ? AND kind = 'message' AND rowid > ? ORDER BY rowid ASC LIMIT 1"
  );
  const startTs = Date.now();
  log(`[${phaseLabel}] waiting for DB row room_id='${ROOM_ID}' actor='${TARGET}' rowid > ${baselineRowid} (up to 240s)...`);
  for (let i = 0; i < 60; i++) {
    const row = qLatest.get(ROOM_ID, TARGET, baselineRowid);
    if (row) {
      log(`[${phaseLabel}] t=${Math.floor((Date.now()-startTs)/1000)}s GOT row rowid=${row.r} content=${JSON.stringify(String(row.c).slice(0,120))}`);
      return { rowid: row.r, content: String(row.c) };
    }
    if (i % 3 === 0) log(`[${phaseLabel}] t=${Math.floor((Date.now()-startTs)/1000)}s still waiting...`);
    await new Promise(r => setTimeout(r, 4000));
  }
  return null;
}

async function main() {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'electron-userdata'), { recursive: true });

  log(`HUB_DIR     = ${HUB_DIR}`);
  log(`AI_TEAM_DIR = ${AI_TEAM_DIR}`);
  log(`DATA_DIR    = ${DATA_DIR}`);
  log(`CDP_PORT    = ${CDP_PORT}`);
  log(`ROOM_ID     = ${ROOM_ID}, TARGET = @${TARGET}`);

  const env = {
    ...process.env,
    CLAUDE_HUB_DATA_DIR: DATA_DIR,
    AI_TEAM_DIR: AI_TEAM_DIR,
    HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7890',
    HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7890',
  };

  log('Spawning electron (detached; will survive this script)...');
  const hub = spawn(
    ELECTRON_EXE,
    ['.', `--remote-debugging-port=${CDP_PORT}`],
    { cwd: HUB_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  );
  const hubLog = fs.openSync(path.join(SCREENSHOTS, '_hub-stderr.log'), 'w');
  hub.stdout.on('data', (d) => { fs.writeSync(hubLog, d); });
  hub.stderr.on('data', (d) => { fs.writeSync(hubLog, d); });
  hub.on('exit', (code) => log(`Hub exited ${code}`));
  hub.unref();

  let exitCode = 1;
  let firstResult = null, secondResult = null;
  let preSessionSnapshot = null, midSessionSnapshot = null, postSessionSnapshot = null;

  try {
    log('Waiting for CDP page...');
    const page = await waitForCdpPage();
    log(`Got CDP page: ${page.id}`);

    const wsUrl = `ws://127.0.0.1:${CDP_PORT}/devtools/page/${page.id}`;
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    log('CDP WebSocket connected');

    const cdp = new Cdp(ws);
    cdp.init();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await new Promise(r => setTimeout(r, 3000));
    const title = await cdp.evalJs('document.title');
    log(`document.title = ${JSON.stringify(title)}`);
    if (title !== 'Claude Session Hub') throw new Error(`Unexpected title: ${title}`);
    await cdp.screenshot('00_initial');

    // Open team room (sidebar or text-match fallback)
    const sidebarClick = await cdp.evalJs(`(() => {
      const el = document.querySelector('.session-item.team-room');
      if (el) { el.click(); return 'via-sidebar'; }
      return null;
    })()`);
    log(`sidebar click: ${sidebarClick}`);
    await new Promise(r => setTimeout(r, 1500));

    if (!sidebarClick) {
      const teamBtn = await cdp.evalJs(`(() => {
        const btns = Array.from(document.querySelectorAll('button, a, .nav-item'));
        for (const b of btns) {
          const t = (b.innerText || '').trim();
          if (/team|团队|作战/i.test(t)) { b.click(); return t; }
        }
        return null;
      })()`);
      log(`fallback team button: ${teamBtn}`);
      await new Promise(r => setTimeout(r, 1500));
    }

    const roomClick = await cdp.evalJs(`(() => {
      const items = Array.from(document.querySelectorAll('[data-room-id], .room-item, .team-room-item, .session-item'));
      for (const el of items) {
        const text = el.innerText || '';
        const rid = el.getAttribute('data-room-id');
        if (rid === '${ROOM_ID}' || text.includes('作战室')) { el.click(); return rid || 'by-text'; }
      }
      return null;
    })()`);
    log(`room click: ${roomClick}`);
    await new Promise(r => setTimeout(r, 2000));
    await cdp.screenshot('01_room_opened');

    const inputProbe = await cdp.evalJs(`(() => ({
      inputFound: !!document.getElementById('tr-input-box'),
      btnFound: !!document.getElementById('tr-send-btn'),
    }))()`);
    log(`input probe: ${JSON.stringify(inputProbe)}`);
    if (!inputProbe.inputFound) {
      await cdp.screenshot('01b_no_input');
      throw new Error('#tr-input-box not found — not in team room view?');
    }

    // Establish DB baseline
    const dbPath = path.resolve(AI_TEAM_DIR, 'team.db');
    log(`dbPath = ${dbPath}`);
    const db = new DatabaseSync(dbPath);
    const qMax = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM events WHERE room_id = ? AND actor = ?");
    const baseline = qMax.get(ROOM_ID, TARGET).m;
    log(`baseline squirtle rowid: ${baseline}`);

    // Snapshot codex sessions before Round 1
    preSessionSnapshot = snapshotSessions(GLOBAL_CODEX_SESSIONS);
    log(`pre-round1 session jsonl count: ${preSessionSnapshot.size}`);

    // ============== ROUND 1 ==============
    const MSG1 = '@squirtle 请推荐一个 Python json 解析库，只回答库名，只要一个词，不要别的。';
    firstResult = await sendMessageAndWait(cdp, MSG1, db, baseline, 'ROUND1');
    if (!firstResult) {
      await cdp.screenshot('02_round1_timeout');
      throw new Error('ROUND1 timeout: no squirtle DB row appeared in 240s');
    }
    await cdp.screenshot('02_round1_replied');

    midSessionSnapshot = snapshotSessions(GLOBAL_CODEX_SESSIONS);
    const newAfterRound1 = [...midSessionSnapshot].filter(f => !preSessionSnapshot.has(f));
    log(`after round1, new session jsonl files: ${newAfterRound1.length}`);
    for (const f of newAfterRound1) log(`  new: ${f}`);

    await new Promise(r => setTimeout(r, 2000));

    // ============== ROUND 2 (resume) ==============
    const MSG2 = '@squirtle 请重复你刚刚回复的最后两个字，只回答那两个字，不要别的。';
    secondResult = await sendMessageAndWait(cdp, MSG2, db, firstResult.rowid, 'ROUND2');
    if (!secondResult) {
      await cdp.screenshot('03_round2_timeout');
      throw new Error('ROUND2 timeout: no squirtle DB row appeared in 240s');
    }
    await cdp.screenshot('03_round2_replied');

    db.close();

    postSessionSnapshot = snapshotSessions(GLOBAL_CODEX_SESSIONS);
    const newAfterRound2 = [...postSessionSnapshot].filter(f => !midSessionSnapshot.has(f));
    log(`after round2, additional new session jsonl files: ${newAfterRound2.length}`);
    for (const f of newAfterRound2) log(`  new: ${f}`);

    // ============== ASSERTIONS ==============
    const round1Last2 = firstResult.content.trim().slice(-2);
    const round2Content = secondResult.content.trim();
    log(`\n=== 断言 ===`);
    log(`Round1 content: ${JSON.stringify(firstResult.content)}`);
    log(`Round2 content: ${JSON.stringify(round2Content)}`);
    log(`Round1 last 2 chars: ${JSON.stringify(round1Last2)}`);

    const contextPreserved = round2Content.includes(round1Last2);
    log(`断言 1 — Round1 非空:                ${firstResult.content.length > 0 ? 'PASS' : 'FAIL'}`);
    log(`断言 2 — Round2 含 Round1 最后两字:   ${contextPreserved ? 'PASS' : 'FAIL'}`);
    log(`断言 3 — Round1 产生 1 个新 session:  ${newAfterRound1.length === 1 ? 'PASS' : `FAIL (got ${newAfterRound1.length})`}`);
    log(`断言 4 — Round2 不再建新 session:     ${newAfterRound2.length === 0 ? 'PASS' : `FAIL (got ${newAfterRound2.length} — resume 未复用)`}`);
    // 断言 5 粗略:session jsonl 体积>2KB 证明累积了两轮 conversation state
    let jsonlSize = 0;
    if (newAfterRound1.length === 1) {
      jsonlSize = fs.statSync(newAfterRound1[0]).size;
      log(`断言 5 — session jsonl 累积两轮:      ${jsonlSize > 2000 ? 'PASS' : 'FAIL'} (size=${jsonlSize}B)`);
    }

    const allPass = firstResult.content.length > 0
      && contextPreserved
      && newAfterRound1.length === 1
      && newAfterRound2.length === 0
      && jsonlSize > 2000;
    if (allPass) {
      log(`\n=== 全部断言 PASS ===`);
      exitCode = 0;
    } else {
      log(`\n=== 有断言 FAIL — 详见上方 ===`);
    }

    await cdp.screenshot('04_final');
    ws.close();
  } catch (e) {
    log(`ERROR: ${e.message}`);
    console.error(e);
  } finally {
    try { fs.closeSync(hubLog); } catch {}
    log(`\n=== Result: ${exitCode === 0 ? 'PASS' : 'FAIL'} ===`);
    log(`Screenshots: ${SCREENSHOTS}`);
    log(`Test Hub 保留在 CDP ${CDP_PORT} + DATA_DIR ${DATA_DIR},可自行关闭。`);
    process.exit(exitCode);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
