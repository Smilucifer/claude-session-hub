const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

function readSecret(filepath, key) {
  let content;
  try { content = fs.readFileSync(filepath, 'utf8'); }
  catch { throw new Error(`secrets file not found: ${filepath}`); }
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm');
  const m = content.match(re);
  if (!m) throw new Error(`secrets key ${key} not found in ${filepath}`);
  return m[1];
}

function postJson(endpoint, payload, headers, timeout_ms) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: timeout_ms,
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP timeout after ${timeout_ms}ms`));
    });
    req.on('error', err => reject(err));
    req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class DeepSeekProvider {
  constructor(options) {
    this.name = 'deepseek-api';
    this.model = options.model || 'deepseek-chat';
    this.endpoint = options.endpoint;
    this.timeout_ms = options.timeout_ms || 60000;
    this.max_retries = options.max_retries == null ? 1 : options.max_retries;
    this.secrets_file = options.secrets_file;
    this.secrets_key = options.secrets_key;
  }

  async call({ system, user }) {
    const apiKey = readSecret(this.secrets_file, this.secrets_key);
    const start = Date.now();
    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    };
    const headers = { authorization: `Bearer ${apiKey}` };

    let lastErr;
    for (let attempt = 0; attempt <= this.max_retries; attempt++) {
      try {
        const { status, body } = await postJson(this.endpoint, payload, headers, this.timeout_ms);
        if (status === 200) {
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { throw new Error(`DeepSeek 200 but body not JSON: ${body.slice(0, 200)}`); }
          const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
          if (typeof content !== 'string' || content.length < 5) {
            throw new Error(`DeepSeek empty content: ${body.slice(0, 200)}`);
          }
          return { raw: content, elapsed_ms: Date.now() - start };
        }
        if (status === 401 || status === 403) {
          throw new Error(`DeepSeek auth failed (${status}): check API key`);
        }
        if (status === 429 || status === 503) {
          lastErr = new Error(`DeepSeek transient error ${status}: ${body.slice(0, 100)}`);
          if (attempt < this.max_retries) {
            await sleep(1000 * (attempt + 1));
            continue;
          }
          throw lastErr;
        }
        throw new Error(`DeepSeek HTTP ${status}: ${body.slice(0, 200)}`);
      } catch (e) {
        lastErr = e;
        if (/auth/i.test(e.message)) throw e;
        if (attempt >= this.max_retries) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr;
  }
}

module.exports = { DeepSeekProvider };
