'use strict';
/** 直接跑一次 codex exec --json,打印原始 stdout 每一行,看真实事件 schema. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `codex-inspect-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
const persona = path.join(TMP, 'persona.md');
fs.writeFileSync(persona, '你是测试助手,简单回答。', 'utf-8');

const env = {
  PATH: process.env.PATH,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH,
  TEMP: process.env.TEMP, TMP: process.env.TMP,
  HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890',
  NO_PROXY: '127.0.0.1,localhost', PYTHONUTF8: '1',
};

const proc = spawn('codex', [
  'exec', '--json', '--full-auto', '--skip-git-repo-check',
  '-c', `model_instructions_file=${persona}`,
  '-'
], { cwd: TMP, env, stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: process.platform==='win32' });

proc.stdin.write('回答"ok"'); proc.stdin.end();

let buf = '';
proc.stdout.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    console.log(`STDOUT> ${line}`);
  }
});
proc.stderr.on('data', (c) => {
  console.log(`STDERR> ${c.toString('utf-8').replace(/\n$/, '')}`);
});
proc.on('close', (code) => {
  console.log(`EXIT ${code}`);
  if (buf) console.log(`STDOUT-trailing> ${buf}`);
});
