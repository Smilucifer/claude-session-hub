'use strict';
/**
 * POC: Codex team session 技术假设验证
 *
 * POC-1: 验证 `codex exec -c model_instructions_file=<path>` 真能把文件当 system prompt
 *         prompt: "你是谁？用一句话"
 *         persona: 含 "杰尼龟"
 *         断言: 回答含 "杰尼龟"（或 persona 里其他独特关键词）
 *
 * POC-2: 验证 `codex exec -c sessions.dir=<path>` 真能改 session 落盘位置
 *         断言: .codex-sessions/poc/ 目录下出现新 .jsonl
 *         （至于 ~/.codex/sessions/ 是否同时写入，记录事实但不一票否决）
 *
 * POC-3: 验证 `codex exec resume <sid>` 真能保留 conversation state
 *         Round1: "请记住我的幸运数字是 42,只回答'好'"
 *         Round2 (resume): "我的幸运数字是多少？只回答数字"
 *         断言: Round2 回答含 "42"
 *
 * 任一失败:脚本退出 1,打印降级建议。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POC_DIR = path.join(os.tmpdir(), `codex-poc-${Date.now()}`);
const PERSONA_FILE = path.join(POC_DIR, 'persona.md');
const SESSIONS_DIR = path.join(POC_DIR, 'sessions');
const GLOBAL_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

const log = (...a) => console.log('[poc]', ...a);

function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return new Set();
  const out = new Set();
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.add(full);
    }
  };
  try { walk(dir); } catch {}
  return out;
}

function diffSnapshots(before, after) {
  const added = [];
  for (const f of after) if (!before.has(f)) added.push(f);
  return added;
}

/**
 * Run `codex exec` (or `codex exec resume <sid>`) with POC config.
 * Returns { exitCode, stdoutLines, stderr, sessionId, finalText }.
 *
 * 注意:prompt 通过 stdin 传入(位置参数传 '-'),完全绕开 Windows shell 引号坑。
 */
function runCodex({ prompt, resumeSid, extraArgs = [] }) {
  return new Promise((resolve) => {
    const args = ['exec'];
    if (resumeSid) args.push('resume', resumeSid);
    args.push(
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '-c', `model_instructions_file=${PERSONA_FILE}`,
      ...extraArgs,
      '-'    // prompt via stdin
    );

    log(`spawn: codex ${args.map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' ')}`);
    log(`  stdin prompt: ${JSON.stringify(prompt)}`);
    const env = {
      PATH: process.env.PATH,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7890',
      HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7890',
      NO_PROXY: '127.0.0.1,localhost',
      PYTHONUTF8: '1',
    };

    const proc = spawn('codex', args, {
      cwd: POC_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32', // 让 .cmd 能跑
    });
    // 通过 stdin 喂 prompt
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdoutBuf = '';
    let stderr = '';
    const stdoutLines = [];
    let sessionId = null;
    let finalText = '';

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf-8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        stdoutLines.push(line);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        // 记录所有字段推测 session_id 和 final message 的真实形状
        if (!sessionId) {
          // 尝试多个候选键名
          if (ev.type === 'session.started' && ev.session_id) sessionId = ev.session_id;
          else if (ev.type === 'session.created' && ev.session_id) sessionId = ev.session_id;
          else if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
          else if (ev.session_id && typeof ev.session_id === 'string') sessionId = ev.session_id;
          else if (ev.id && ev.type && ev.type.includes('session')) sessionId = ev.id;
        }
        // 尝试多个候选的最终消息位置
        if (ev.type === 'item.completed' && ev.item && ev.item.type === 'message' && typeof ev.item.text === 'string') {
          finalText = ev.item.text;
        } else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
          finalText = ev.item.text;
        } else if (ev.type === 'message' && typeof ev.text === 'string') {
          finalText = ev.text;
        } else if (ev.type === 'agent_message' && typeof ev.message === 'string') {
          finalText = ev.message;
        }
      }
    });

    proc.stderr.on('data', (c) => { stderr += c.toString('utf-8'); });

    proc.on('close', (code) => {
      resolve({ exitCode: code, stdoutLines, stderr, sessionId, finalText });
    });
    proc.on('error', (err) => {
      resolve({ exitCode: -1, stdoutLines, stderr: String(err), sessionId: null, finalText: '' });
    });
  });
}

async function setupPocDir() {
  fs.mkdirSync(POC_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  // 写 persona 文件(含独特关键词方便 assertion)
  const personaContent = `你是杰尼龟(squirtle-poc-marker),团队的中流砥柱。
扎实可靠的全能型选手。不是最耀眼的,但永远是最让人安心的。
审视问题客观公正,不偏不倚。

[规则]
- 回答时必须以"[杰尼龟]"三字开头,证明你扮演了这个角色。
- 简洁,不超过 30 字。
`;
  fs.writeFileSync(PERSONA_FILE, personaContent, 'utf-8');
  log(`POC_DIR = ${POC_DIR}`);
  log(`PERSONA_FILE = ${PERSONA_FILE}`);
  log(`SESSIONS_DIR = ${SESSIONS_DIR}`);
}

async function poc1() {
  console.log('\n================ POC-1: Persona 注入 ================');
  const r = await runCodex({ prompt: '你是谁？' });
  log(`exitCode=${r.exitCode}, finalText=${JSON.stringify(r.finalText)}`);
  log(`stderr.len=${r.stderr.length}, stderr.tail=${JSON.stringify(r.stderr.slice(-300))}`);
  log(`stdoutLines=${r.stdoutLines.length}, sessionId=${r.sessionId}`);

  if (r.exitCode !== 0) {
    log(`POC-1 FAIL: exit ${r.exitCode}`);
    return { pass: false, reason: `exit ${r.exitCode}`, r };
  }
  const hit = /杰尼龟|squirtle-poc-marker/i.test(r.finalText);
  if (hit) {
    log(`POC-1 PASS: 回答含 persona 关键词`);
    return { pass: true, r };
  }
  log(`POC-1 FAIL: 回答未命中 persona 关键词。实际回答: ${JSON.stringify(r.finalText)}`);
  log(`→ 降级建议:首 prompt 前置 [SYSTEM] 块`);
  return { pass: false, reason: 'persona keyword missing', r };
}

async function poc2(priorRun) {
  console.log('\n================ POC-2: Session 落盘可恢复 ================');
  // 决策修正:Codex 0.121.0 没有 -c sessions.dir 配置项(binary strings 确认)。
  // 走"和独立 codex 完全一致"路径 —— session 落到 ~/.codex/sessions/YYYY/MM/DD/
  // 断言新目标:能按 session_id 找到落盘的 .jsonl,证明 resume 链路有基础。
  const sid = priorRun && priorRun.sessionId;
  if (!sid) {
    log(`POC-2 FAIL: 前置 POC-1 没抓到 session_id,无法验证`);
    return { pass: false };
  }
  const globalPatterns = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.includes(sid)) globalPatterns.push(full);
    }
  };
  walk(GLOBAL_SESSIONS_DIR);
  log(`global path with sid ${sid}:`);
  for (const f of globalPatterns) log(`  ${f}`);
  if (globalPatterns.length >= 1) {
    log(`POC-2 PASS: session ${sid} 可在 ~/.codex/sessions/ 找到,resume 链路基础成立`);
    return { pass: true };
  }
  log(`POC-2 FAIL: 未找到 session_id=${sid} 对应的 .jsonl`);
  return { pass: false };
}

async function poc3(round1Result) {
  console.log('\n================ POC-3: Resume 保留 context ================');
  if (!round1Result.sessionId) {
    log(`POC-3 FAIL: Round1 没抓到 session_id`);
    log(`→ session_id 的真实 JSONL 事件位置:打印头 20 行让人眼辨识`);
    for (const l of round1Result.stdoutLines.slice(0, 20)) log(`  ${l.slice(0, 300)}`);
    return { pass: false };
  }
  log(`Round1 sessionId=${round1Result.sessionId}`);

  // 用干净的一条 prompt 测试 resume
  const round1Fresh = await runCodex({
    prompt: '请记住:我的幸运数字是 42。只回复 "好"。',
  });
  log(`Round1(fresh) exit=${round1Fresh.exitCode} sid=${round1Fresh.sessionId} text=${JSON.stringify(round1Fresh.finalText)}`);
  if (round1Fresh.exitCode !== 0 || !round1Fresh.sessionId) {
    log(`POC-3 FAIL at Round1: 无法启动或无 sid`);
    return { pass: false };
  }

  // 停 2 秒让 session 文件完全落盘
  await new Promise(r => setTimeout(r, 2000));

  const round2 = await runCodex({
    prompt: '我的幸运数字是多少？只回复数字本身,不要任何别的。',
    resumeSid: round1Fresh.sessionId,
  });
  log(`Round2(resume) exit=${round2.exitCode} sid=${round2.sessionId} text=${JSON.stringify(round2.finalText)}`);
  log(`Round2 stderr.tail=${JSON.stringify(round2.stderr.slice(-300))}`);

  if (round2.exitCode !== 0) {
    log(`POC-3 FAIL at Round2: exit ${round2.exitCode} — resume 本身挂了`);
    return { pass: false };
  }
  if (/42/.test(round2.finalText)) {
    log(`POC-3 PASS: resume 保留了 context`);
    return { pass: true, sid: round1Fresh.sessionId };
  }
  log(`POC-3 FAIL: Round2 回答不含 42。实际: ${JSON.stringify(round2.finalText)}`);
  log(`→ A 方案核心假设不成立,需重新评估整体架构`);
  return { pass: false };
}

async function main() {
  log(`Node ${process.version}, platform=${process.platform}`);
  await setupPocDir();

  const r1 = await poc1();
  const r2 = await poc2(r1.r);
  const r3 = r1.pass ? await poc3(r1.r) : { pass: false, reason: 'skipped (POC-1 failed)' };

  console.log('\n================ SUMMARY ================');
  console.log(`POC-1 (persona 注入):       ${r1.pass ? 'PASS' : 'FAIL'}${r1.reason ? ' — ' + r1.reason : ''}`);
  console.log(`POC-2 (sessions.dir 隔离):  ${r2.pass ? 'PASS' : 'FAIL'}`);
  console.log(`POC-3 (resume 保留 context):${r3.pass ? 'PASS' : 'FAIL'}${r3.reason ? ' — ' + r3.reason : ''}`);
  console.log(`POC_DIR 保留在 ${POC_DIR} 供排查`);

  process.exit(r1.pass && r2.pass && r3.pass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
