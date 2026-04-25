const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class GeminiCliProvider {
  constructor(options = {}) {
    this.name = 'gemini-cli';
    this.timeout_ms = options.timeout_ms || 90000;
    this.modelOverride = options.model_override || null;
    // Test injection
    this._binOverride = options._binOverride || null;
    this._argsOverride = options._argsOverride || null;
  }

  async call({ system, user }) {
    const start = Date.now();
    const sysFile = path.join(os.tmpdir(), `gemini-sys-${crypto.randomBytes(4).toString('hex')}.md`);
    fs.writeFileSync(sysFile, system, 'utf8');
    try {
      const raw = await this._spawn(user, sysFile);
      if (!raw || raw.length < 5) {
        throw new Error(`Gemini CLI returned empty output (${raw.length} bytes)`);
      }
      // 输出格式 JSON (含 .response 字段)
      let response = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.response === 'string') {
          response = parsed.response;
        } else if (raw.length < 200) {
          throw new Error(`Gemini CLI returned suspect short output without .response field: ${raw.slice(0, 100)}`);
        }
      } catch (e) {
        // 不是 JSON 包装,raw 本身就是输出 (rare)
        if (raw.length < 200) throw new Error(`Gemini CLI output too short: ${raw.slice(0, 100)}`);
      }
      return { raw: response, elapsed_ms: Date.now() - start };
    } finally {
      try { fs.unlinkSync(sysFile); } catch {}
    }
  }

  _spawn(userPrompt, sysFile) {
    return new Promise((resolve, reject) => {
      const bin = this._binOverride || 'gemini';
      const args = this._argsOverride
        ? this._argsOverride
        : ['--output-format', 'json', '-y'];
      const env = { ...process.env, GEMINI_SYSTEM_MD: sysFile };
      delete env.DEBUG;
      env.HTTP_PROXY = env.HTTP_PROXY || 'http://127.0.0.1:7890';
      env.HTTPS_PROXY = env.HTTPS_PROXY || 'http://127.0.0.1:7890';

      const child = spawn(bin, args, { env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`Gemini CLI timeout after ${this.timeout_ms}ms`));
      }, this.timeout_ms);

      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', err => {
        clearTimeout(timer);
        if (!killed) reject(new Error(`Gemini CLI spawn error: ${err.message}`));
      });
      child.on('exit', code => {
        clearTimeout(timer);
        if (killed) return;
        if (code !== 0) {
          return reject(new Error(`Gemini CLI exit ${code}: ${stderr.slice(0, 300)}`));
        }
        resolve(stdout);
      });

      child.stdin.write(userPrompt);
      child.stdin.end();
    });
  }
}

module.exports = { GeminiCliProvider };
