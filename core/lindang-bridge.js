'use strict';
// LinDangAgent 桥接：spawn `python -m services.fetch_for_arena ...` 拉取 A 股数据
// 三种 endpoint：fetchStock / fetchConcept / fetchSector
// 失败兜底返回 { ok: false, error, stdout, stderr }

const { spawn } = require('child_process');

const LINDANG_DIR = process.env.LINDANG_DIR || 'C:\\LinDangAgent';
const PYTHON_BIN = process.env.LINDANG_PYTHON
  || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';

function _runFetch(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(PYTHON_BIN, ['-X', 'utf8', '-m', 'services.fetch_for_arena', ...args], {
        cwd: LINDANG_DIR,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8:replace',
          LANG: 'zh_CN.UTF-8',
          LC_ALL: 'zh_CN.UTF-8',
        },
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn failed: ' + e.message });
    }
    // 用 raw Buffer 累积，结束后再 toString utf-8 整体解析（避免 utf-8 多字节字符在 chunk 边界被切坏）
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => { stdoutChunks.push(c); });
    child.stderr.on('data', (c) => { stderrChunks.push(c); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout (' + timeoutMs + 'ms)', stdout, stderr });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'process error: ' + e.message, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const trimmed = stdout.trim();
      if (code === 0 && trimmed) {
        // 跳过 xtquant 等三方库 import 时污染 stdout 的广告 print
        // 找第一个 { 或 [ 字符作为 JSON 起点
        const jsonStart = trimmed.search(/[{\[]/);
        const jsonText = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
        try {
          const data = JSON.parse(jsonText);
          resolve({ ok: true, data });
        } catch (e) {
          resolve({ ok: false, error: 'json parse: ' + e.message, stdout: jsonText.slice(0, 1000), stderr: stderr.slice(0, 500) });
        }
      } else {
        resolve({ ok: false, error: 'exit code ' + code, stdout: trimmed.slice(0, 500), stderr: stderr.slice(0, 1500) });
      }
    });
  });
}

async function fetchStock(symbol, name = '') {
  if (!symbol) return { ok: false, error: 'symbol 必填' };
  const args = ['stock', '--symbol', symbol];
  if (name) args.push('--name', name);
  // build_report_context 5+ 层兜底（QMT/tushare/akshare/baostock/sina），首次 3-5 min
  return await _runFetch(args, 300000);
}

async function fetchConcept(concept, topN = 10) {
  if (!concept) return { ok: false, error: 'concept 必填' };
  return await _runFetch(['concept', '--concept', concept, '--top-n', String(topN)], 90000);
}

async function fetchSector(sector) {
  if (!sector) return { ok: false, error: 'sector 必填' };
  return await _runFetch(['sector', '--sector', sector], 90000);
}

module.exports = { fetchStock, fetchConcept, fetchSector, LINDANG_DIR, PYTHON_BIN };
