#!/usr/bin/env node
// Research Roundtable MCP server.
// Spawned by Claude/Codex/Gemini CLI per research mode meeting，through MCP config 注入。
// 暴露三个工具：fetch_lindang_stock / fetch_concept_stocks / fetch_sector_overview
// 工具调用 → HTTP POST → Hub hookServer (loopback) → core/lindang-bridge.js → LinDangAgent
//
// 仿 core/driver-mcp-server.js 模式。
'use strict';

const http = require('http');

const MEETING_ID = process.env.ARENA_MEETING_ID || '';
const HUB_PORT = parseInt(process.env.ARENA_HUB_PORT || '0', 10);
const HOOK_TOKEN = process.env.ARENA_HOOK_TOKEN || '';
const AI_KIND = process.env.ARENA_AI_KIND || 'unknown';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG = process.env.ARENA_MCP_DEBUG === '1';
const LOG_FILE = DEBUG
  ? path.join(os.tmpdir(), 'arena-research-mcp-' + Date.now() + '-' + process.pid + '.log')
  : null;
function logErr(msg) {
  try { process.stderr.write('[arena-research-mcp] ' + msg + '\n'); } catch {}
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  }
}

logErr('startup pid=' + process.pid + ' meeting=' + MEETING_ID + ' port=' + HUB_PORT + ' kind=' + AI_KIND);

if (!MEETING_ID || !HUB_PORT || !HOOK_TOKEN) {
  logErr('missing required env: ARENA_MEETING_ID/ARENA_HUB_PORT/ARENA_HOOK_TOKEN');
  process.exit(1);
}

// --- MCP tools ---
const TOOLS = [
  {
    name: 'fetch_lindang_stock',
    description: '从用户的 LinDangAgent（A股投研项目）拉单股 33 字段全量数据：基本面（营收/利润/毛利率/ROE）+ 资金面（北向/龙虎榜/主力净流入）+ 技术面（K线/MA/RSI/量比）+ 题材（概念/板块/行业地位）+ 估值（PE/PB 历史分位）。优先用此工具，不够时再用联网搜索。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'A股股票代码（6位数字如"603986"，或带后缀如"603986.SH"）',
        },
        name: {
          type: 'string',
          description: '公司名（可选，用于辅助匹配）',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'fetch_concept_stocks',
    description: '按 A 股概念查正宗龙头股票池（5 路候选合并 + 量价回测 + 成分股权重排序）。例：DDR5 / AI 算力 / 人形机器人 / 减肥药 / 算力租赁。返回 top_n 只候选股票及其评分。',
    inputSchema: {
      type: 'object',
      properties: {
        concept: {
          type: 'string',
          description: '概念名（中文，例 "DDR5"、"人形机器人"、"算力租赁"）',
        },
        top_n: {
          type: 'number',
          description: '返回前 N 只（默认 10）',
        },
      },
      required: ['concept'],
    },
  },
  {
    name: 'fetch_sector_overview',
    description: '查 A 股板块/行业的整体行情：板块涨跌幅、成交额、成分股数、领涨/领跌、资金流向。例 "半导体" / "白酒" / "新能源"。',
    inputSchema: {
      type: 'object',
      properties: {
        sector: {
          type: 'string',
          description: '板块/行业名（中文，例 "半导体"、"白酒"、"光伏"）',
        },
      },
      required: ['sector'],
    },
  },
];

// --- HTTP helper ---
function postFetch(endpoint, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 320000, // LinDangAgent 单股全量首次 3-5 min，给 320s 兜底（bridge 端 300s + 缓冲）
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: chunks }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: 'request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout (90s)' }); });
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
      serverInfo: { name: 'arena-research', version: '1.0.0' },
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
    const baseBody = { token: HOOK_TOKEN, meetingId: MEETING_ID, kind: AI_KIND };

    if (name === 'fetch_lindang_stock') {
      const symbol = String(args.symbol || '');
      const stockName = String(args.name || '');
      if (!symbol) {
        return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填（例 "603986"）' }], isError: true });
      }
      const r = await postFetch('/api/research/fetch-stock', { ...baseBody, symbol, name: stockName });
      const text = r.ok ? r.body : `LinDangAgent 拉股票数据失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
    if (name === 'fetch_concept_stocks') {
      const concept = String(args.concept || '');
      const top_n = parseInt(args.top_n || '10', 10);
      if (!concept) {
        return reply(id, { content: [{ type: 'text', text: '错误：concept 参数必填（例 "DDR5"）' }], isError: true });
      }
      const r = await postFetch('/api/research/fetch-concept', { ...baseBody, concept, top_n });
      const text = r.ok ? r.body : `LinDangAgent 概念查询失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
    if (name === 'fetch_sector_overview') {
      const sector = String(args.sector || '');
      if (!sector) {
        return reply(id, { content: [{ type: 'text', text: '错误：sector 参数必填（例 "半导体"）' }], isError: true });
      }
      const r = await postFetch('/api/research/fetch-sector', { ...baseBody, sector });
      const text = r.ok ? r.body : `LinDangAgent 板块查询失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
    return replyError(id, -32601, 'unknown tool: ' + name);
  }
  return replyError(id, -32601, 'method not found: ' + method);
}

// --- diagnostic heartbeat ---
if (DEBUG) {
  let _hb = 0;
  const _hbI = setInterval(() => {
    _hb++;
    logErr('heartbeat #' + _hb);
    if (_hb >= 30) clearInterval(_hbI);
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
