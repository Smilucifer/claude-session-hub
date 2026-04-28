#!/usr/bin/env node
// Driver-mode MCP server.
// Spawned by Claude CLI per main-driver session via --mcp-config.
// Exposes request_review / request_danger_review tools.
// On tool call: HTTP POST → Hub hookServer (loopback) → driver-auto-review IPC → renderer triggerReview.
'use strict';

const http = require('http');

const MEETING_ID = process.env.ARENA_MEETING_ID || '';
const HUB_PORT = parseInt(process.env.ARENA_HUB_PORT || '0', 10);
const HOOK_TOKEN = process.env.ARENA_HOOK_TOKEN || '';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Diagnostic logging gated by env flag. In production (default), only stderr
// is used and only for errors. Set ARENA_MCP_DEBUG=1 to also write a per-PID
// log file into OS tmpdir (won't auto-clean — keep off unless debugging).
const DEBUG = process.env.ARENA_MCP_DEBUG === '1';
const LOG_FILE = DEBUG
  ? path.join(os.tmpdir(), 'arena-mcp-' + Date.now() + '-' + process.pid + '.log')
  : null;
function logErr(msg) {
  try { process.stderr.write('[arena-mcp] ' + msg + '\n'); } catch {}
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  }
}

logErr('startup pid=' + process.pid + ' meeting=' + MEETING_ID + ' port=' + HUB_PORT);

if (!MEETING_ID || !HUB_PORT || !HOOK_TOKEN) {
  logErr('missing required env: ARENA_MEETING_ID/ARENA_HUB_PORT/ARENA_HOOK_TOKEN');
  process.exit(1);
}

// --- MCP tools ---
const TOOLS = [
  {
    name: 'request_review',
    description: '请求副驾（Gemini + Codex）从架构和实现角度独立审查当前方案。在以下场景调用：跨 3+ 文件的修改、引入新依赖/新模块/新抽象、架构变更、对方案不确定。调用是异步的——立即返回，副驾的反馈会通过下次系统提示注入。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: '本次审查的范围摘要：涉及的文件、模块、核心变更（一两句话）',
        },
        open_risks: {
          type: 'string',
          description: '你认为副驾应该重点检查什么——未消解的风险、不确定的设计点、潜在边界条件',
        },
      },
      required: ['scope', 'open_risks'],
    },
  },
  {
    name: 'request_danger_review',
    description: '执行危险操作前请求副驾审查。在以下操作前必须调用：rm/delete/overwrite 文件目录、git reset --hard、git push --force、修改 .env/secret、数据库 migrate/drop、修改 hook/CI、chmod/chown 大范围迁移。审查通过前不要执行命令。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: '即将执行的具体命令或操作描述',
        },
        files: {
          type: 'string',
          description: '受影响的文件/目录路径（可选）',
        },
      },
      required: ['operation'],
    },
  },
  {
    name: 'arena_remember',
    description: '记录主驾会议室级关键决策/事实/教训供下次会议复用。'
               + '注意：工作偏好/技术习惯（如"我用 strict TS"）应走 ~/.claude/CLAUDE.md 或 Anthropic memory tool，'
               + '不要用此工具——这里只放本项目主驾会议室的特定共识。'
               + 'kind=fact 写到 .arena/memory/shared/facts.md（What/Why/Status 三段式），'
               + 'kind=lesson/decision 写到 .arena/memory/episodes.jsonl 事件流。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['fact', 'lesson', 'decision'],
          description: 'fact=项目级事实, lesson=审查中发现的隐患/教训, decision=方案选型决议' },
        what: { type: 'string', description: '当 kind=fact 时必填: 简短一句概括（用作去重 key）' },
        why: { type: 'string', description: '当 kind=fact 时必填: 为什么/原因' },
        status: { type: 'string', enum: ['stable', 'observed', 'deprecated'],
          description: '当 kind=fact 时必填: 状态。stable=稳定的事实, observed=新观察, deprecated=已废弃' },
        content: { type: 'string', description: '当 kind=lesson/decision 时必填: 一句话内容（<= 500 字）' },
      },
      required: ['kind'],
    },
  },
];

// --- HTTP helper ---
function postReview(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: '/api/driver/request-review',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: chunks }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: 'request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

function postRemember(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: '/api/driver/remember',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: chunks }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: 'request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

// --- JSON-RPC over stdio ---
function send(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { logErr('stdout write failed: ' + e.message); }
}
function reply(id, result) {
  if (id != null) send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  if (id != null) send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(req) {
  const { id, method, params } = req || {};
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'arena-driver', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') {
    return; // notification — no reply
  }
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'request_review') {
      const scope = String(args.scope || '');
      const open_risks = String(args.open_risks || '');
      const r = await postReview({ token: HOOK_TOKEN, meetingId: MEETING_ID, isDanger: false, scope, open_risks });
      const text = r.ok
        ? '审查已触发，副驾正在审查中。请继续你的工作，副驾的反馈会通过系统提示注入下次对话。'
        : `审查触发失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
    if (name === 'request_danger_review') {
      const operation = String(args.operation || '');
      const files = String(args.files || '');
      const r = await postReview({ token: HOOK_TOKEN, meetingId: MEETING_ID, isDanger: true, operation, files });
      const text = r.ok
        ? '危险操作审查已触发，副驾正在审查中。请等待副驾反馈再决定是否执行。'
        : `审查触发失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
    if (name === 'arena_remember') {
      const kind = String(args.kind || '').trim();
      if (!['fact', 'lesson', 'decision'].includes(kind)) {
        return reply(id, { content: [{ type: 'text', text: '记忆失败：kind 必须是 fact/lesson/decision' }], isError: true });
      }
      const body = { token: HOOK_TOKEN, meetingId: MEETING_ID, kind };
      if (kind === 'fact') {
        const what = String(args.what || '').trim();
        const why = String(args.why || '').trim();
        const status = String(args.status || '').trim();
        if (!what || !why || !status) {
          return reply(id, { content: [{ type: 'text', text: '记忆失败：fact 需要 what/why/status' }], isError: true });
        }
        Object.assign(body, { what, why, status });
      } else {
        const content = String(args.content || '').trim();
        if (!content) {
          return reply(id, { content: [{ type: 'text', text: `记忆失败：${kind} 需要 content` }], isError: true });
        }
        body.content = content;
      }
      const r = await postRemember(body);
      const text = r.ok
        ? `已记忆 (${kind})。下次启动主驾会议会自动注入。`
        : `记忆失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
    return replyError(id, -32601, 'unknown tool: ' + name);
  }
  return replyError(id, -32601, 'method not found: ' + method);
}

// --- diagnostic heartbeat: only when ARENA_MCP_DEBUG=1 ---
if (DEBUG) {
  let _heartbeat = 0;
  const _hbInterval = setInterval(() => {
    _heartbeat++;
    logErr('heartbeat #' + _heartbeat + ' stdin readable=' + process.stdin.readable + ' stdoutWritable=' + process.stdout.writable);
    if (_heartbeat >= 30) clearInterval(_hbInterval); // stop after 60s
  }, 2000);
}

// --- stdin line buffer ---
let buf = '';
process.stdin.on('data', (chunk) => {
  if (DEBUG) logErr('stdin chunk: ' + chunk.length + ' bytes');
  buf += chunk.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch (e) { logErr('parse failed: ' + e.message); continue; }
    if (DEBUG) logErr('handling method=' + req.method + ' id=' + req.id);
    Promise.resolve(handleRequest(req)).catch((e) => {
      logErr('handler error: ' + e.message);
      replyError(req.id, -32603, 'internal error: ' + e.message);
    });
  }
});
process.stdin.on('end', () => { logErr('stdin ended'); process.exit(0); });
process.stdin.on('error', (e) => logErr('stdin error: ' + e.message));
process.stdin.on('close', () => logErr('stdin closed'));
process.on('SIGTERM', () => { logErr('SIGTERM received'); process.exit(0); });
process.on('exit', (code) => logErr('process exit code=' + code));
