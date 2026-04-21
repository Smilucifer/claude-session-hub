'use strict';
// ACP (Agent Client Protocol) client for Gemini CLI.
//
// Spawns `node <bundle/gemini.js> --acp` with piped stdio (NOT a PTY), speaks
// JSON-RPC 2.0 over newline-delimited JSON, and exposes a small promise-based
// API plus events that team-session-manager.js consumes.
//
// Why this exists: Gemini's TUI mode (what node-pty triggers) insists on
// re-running the browser OAuth flow even when ~/.gemini/oauth_creds.json is
// valid, and gets stuck at "Waiting for authentication..." inside ConPTY.
// `--acp` is Gemini's official IDE integration path — headless, JSON-RPC,
// supports multi-turn sessions and MCP servers natively.
//
// Schema refs (Gemini CLI 0.38.2, bundle/gemini.js):
//   AGENT_METHODS          @10384  (initialize, session/new, session/prompt, ...)
//   CLIENT_METHODS         @10399  (session/update, fs/*, terminal/*, ...)
//   ndJsonStream           @11276  (content.split("\n"), JSON.parse each line)
//   GeminiAgent.initialize @12786  (returns {protocolVersion, authMethods,
//                                    agentInfo, agentCapabilities})

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

// Locate a real node.exe binary. We cannot rely on `process.execPath` when
// this code runs inside the Electron main process — there execPath points
// at electron.exe, whose argv parser then injects `--max-old-space-size`
// into Gemini's CLI parser, which promptly crashes with "Unknown arguments".
// Stick to the user's PATH to find a genuine Node.
function findNodeExe() {
  if (process.env.HUB_NODE_EXE && fs.existsSync(process.env.HUB_NODE_EXE)) {
    return process.env.HUB_NODE_EXE;
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const candidates = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of pathDirs) {
    for (const name of candidates) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p)) return p; } catch {}
    }
  }
  return null;
}

class AcpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.geminiEntry — absolute path to bundle/gemini.js
   * @param {object} [opts.env]       — env for the spawned process (defaults to process.env)
   */
  constructor({ geminiEntry, env }) {
    super();
    if (!geminiEntry) throw new Error('AcpClient: geminiEntry is required');
    this._geminiEntry = geminiEntry;
    this._env = env || process.env;
    this._child = null;
    // StringDecoder handles multi-byte UTF-8 that straddles chunk boundaries
    // (plain Buffer.toString('utf8') would emit U+FFFD for split sequences).
    this._stdoutDecoder = new StringDecoder('utf8');
    this._stdoutBuf = '';
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._started = false;
    this._closed = false;
    // Per-session text accumulators, keyed by sessionId. prompt() resets the
    // slot before firing the request and reads it when the response arrives.
    this._textChunks = new Map();
  }

  async start() {
    if (this._started) return;
    this._started = true;
    const nodeExe = findNodeExe() || process.execPath;
    this._child = spawn(nodeExe, [this._geminiEntry, '--acp'], {
      env: this._env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._child.stdout.on('data', (chunk) => this._onStdoutChunk(chunk));
    this._child.stderr.on('data', (chunk) => {
      // stderr from Gemini is usually telemetry noise; forward for debugging.
      this.emit('stderr', chunk.toString('utf8'));
    });
    this._child.on('exit', (code, sig) => {
      this._closed = true;
      // Flush any trailing bytes the decoder is holding so the final line
      // (if any) gets parsed before we tear down.
      const tail = this._stdoutDecoder.end();
      if (tail) this._stdoutBuf += tail;
      if (this._stdoutBuf) {
        const final = this._stdoutBuf.trim();
        this._stdoutBuf = '';
        if (final) {
          try { this._dispatch(JSON.parse(final)); } catch {}
        }
      }
      // Fail any pending requests so callers don't hang.
      for (const [, slot] of this._pending) {
        clearTimeout(slot.timer);
        slot.reject(new Error(`ACP process exited (code=${code} sig=${sig})`));
      }
      this._pending.clear();
      this.emit('exit', { code, signal: sig });
    });
    this._child.on('error', (err) => this.emit('error', err));
  }

  async initialize(clientCapabilities) {
    return this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: clientCapabilities || {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  }

  /**
   * Create a new ACP session.
   * @param {object} opts
   * @param {string} opts.cwd           — working dir for the session (loadSettings reads this)
   * @param {Array}  [opts.mcpServers]  — zMcpServer[] (stdio/http/sse)
   * @param {string} [opts.modeId]      — if set, issue session/set_mode after creation (e.g. 'yolo')
   * @returns {Promise<string>} sessionId
   */
  async newSession({ cwd, mcpServers, modeId }) {
    const result = await this._request('session/new', {
      cwd,
      mcpServers: mcpServers || [],
    });
    const sessionId = result.sessionId;
    if (!sessionId) throw new Error('session/new returned no sessionId');
    if (modeId) {
      try {
        await this._request('session/set_mode', { sessionId, modeId });
      } catch (e) {
        // Non-fatal — the server may refuse unknown modes but the session
        // itself is still usable in its default mode.
        this.emit('warn', `session/set_mode(${modeId}) failed: ${e.message}`);
      }
    }
    return sessionId;
  }

  /**
   * Send a prompt and wait for the turn to end. Collects all
   * agent_message_chunk text into one string.
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {number} [timeoutMs] — defaults to 10 minutes
   * @returns {Promise<{stopReason: string, text: string, meta?: object}>}
   */
  async prompt(sessionId, text, timeoutMs = 600000) {
    this._textChunks.set(sessionId, []);
    try {
      const result = await this._request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text }],
        },
        timeoutMs,
      );
      const chunks = this._textChunks.get(sessionId) || [];
      return {
        stopReason: result?.stopReason || 'unknown',
        text: chunks.join(''),
        meta: result?._meta,
      };
    } finally {
      // Always clean up — timeout / exit / error paths would otherwise leak
      // this buffer and later session/update notifications would keep pushing
      // into a dangling array no one reads.
      this._textChunks.delete(sessionId);
    }
  }

  /**
   * Switch the model used by an existing ACP session.
   * Schema: session/set_model params = { sessionId, modelId }.
   * @param {string} sessionId
   * @param {string} modelId  e.g. 'gemini-3-pro', 'gemini-3-flash-preview'
   */
  async setModel(sessionId, modelId) {
    return this._request('session/set_model', { sessionId, modelId });
  }

  async close() {
    if (!this._child || this._closed) return;
    try { this._child.stdin.end(); } catch {}
    try { this._child.kill('SIGTERM'); } catch {}
    // Give it 2s to exit cleanly; then hard-kill on Windows via kill tree.
    await new Promise((res) => setTimeout(res, 2000));
    try { this._child.kill('SIGKILL'); } catch {}
  }

  // --- internals ------------------------------------------------------------

  _request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this._closed) return Promise.reject(new Error('ACP client is closed'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`ACP request timeout (${method} after ${timeoutMs}ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _send(obj) {
    if (this._closed || !this._child || !this._child.stdin.writable) return;
    this._child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _onStdoutChunk(chunk) {
    this._stdoutBuf += this._stdoutDecoder.write(chunk);
    const lines = this._stdoutBuf.split('\n');
    this._stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); }
      catch { this.emit('warn', `non-JSON line from Gemini: ${trimmed.slice(0, 200)}`); continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our outgoing requests
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && this._pending.has(msg.id)) {
      const slot = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.error) slot.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
      else slot.resolve(msg.result);
      return;
    }

    // Incoming request or notification from agent side
    if (msg.method) {
      const isRequest = msg.id != null;
      try {
        this._handleIncoming(msg, isRequest);
      } catch (e) {
        if (isRequest) {
          this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e.message || e) } });
        } else {
          this.emit('warn', `incoming-${msg.method}-error: ${e.message}`);
        }
      }
    }
  }

  _handleIncoming(msg, isRequest) {
    const { method, params } = msg;

    if (method === 'session/update') {
      const sessionId = params?.sessionId;
      const update = params?.update;
      if (update) {
        // Gemini 0.38.2 sometimes emits chunks with a `content` whose `type`
        // isn't literally 'text' (e.g. thought chunks carry the reasoning
        // object). Key off the presence of `content.text` instead so we don't
        // silently drop valid content.
        const chunkText = typeof update.content?.text === 'string' ? update.content.text : null;
        if (update.sessionUpdate === 'agent_message_chunk' && chunkText) {
          const list = this._textChunks.get(sessionId);
          if (list) list.push(chunkText);
          this.emit('agent-message', { sessionId, text: chunkText });
        } else if (update.sessionUpdate === 'agent_thought_chunk' && chunkText) {
          this.emit('agent-thought', { sessionId, text: chunkText });
        }
      }
      this.emit('session-update', { sessionId, update });
      // session/update is a notification; no response expected.
      return;
    }

    // yolo-ish default: approve tool-call permission requests. In practice we
    // launch sessions with modeId='yolo' so this path is rarely hit, but it
    // protects against the agent re-requesting permission mid-turn.
    if (method === 'session/request_permission' && isRequest) {
      const optionId = params?.options?.[0]?.optionId || 'allow';
      this._send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId } } });
      return;
    }

    // Deny fs / terminal operations by default — the Hub doesn't expose a
    // filesystem or shell to Gemini. Agents should call MCP tools instead.
    if (isRequest && (method.startsWith('fs/') || method.startsWith('terminal/'))) {
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `method not supported: ${method}` },
      });
      return;
    }

    // Unknown request → method-not-found error; unknown notification → just emit.
    if (isRequest) {
      this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${method}` } });
    } else {
      this.emit('unhandled-notification', msg);
    }
  }
}

module.exports = { AcpClient, PROTOCOL_VERSION };
