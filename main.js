const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const QRCode = require('qrcode');
const { SessionManager } = require('./core/session-manager.js');
const stateStore = require('./core/state-store.js');
const { createMobileServer } = require('./core/mobile-server.js');
const mobileAuth = require('./core/mobile-auth.js');

// Auto-deploy hook scripts + settings.json config on first launch.
// Idempotent — skips if already present, never overwrites user's existing hooks.
function ensureHooksDeployed() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const claudeDir = path.join(home, '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');

  // 1. Copy hook scripts if missing
  const srcDir = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');

  const scriptFiles = ['session-hub-hook.py', 'claude-hub-statusline.js'];
  for (const file of scriptFiles) {
    const dest = path.join(scriptsDir, file);
    const src = path.join(srcDir, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`[hub] deployed ${file} -> ${dest}`);
    }
  }

  // 2. Merge hook config into settings.json if not present
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

  const hookPyPath = path.join(scriptsDir, 'session-hub-hook.py').replace(/\\/g, '\\\\');
  const statusJsPath = path.join(scriptsDir, 'claude-hub-statusline.js').replace(/\\/g, '/');

  let changed = false;

  // Ensure hooks object
  if (!settings.hooks) settings.hooks = {};

  // Stop hook
  const stopCmd = `python "${hookPyPath}" stop`;
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  const hasStop = settings.hooks.Stop.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes('session-hub-hook'))
  );
  if (!hasStop) {
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: stopCmd, timeout: 5 }]
    });
    changed = true;
  }

  // UserPromptSubmit hook
  const promptCmd = `python "${hookPyPath}" prompt`;
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  const hasPrompt = settings.hooks.UserPromptSubmit.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes('session-hub-hook'))
  );
  if (!hasPrompt) {
    settings.hooks.UserPromptSubmit.push({
      matcher: '',
      hooks: [{ type: 'command', command: promptCmd, timeout: 5 }]
    });
    changed = true;
  }

  // Statusline
  if (!settings.statusLine || !String(settings.statusLine.command || '').includes('claude-hub-statusline')) {
    settings.statusLine = {
      type: 'command',
      command: `node "${statusJsPath}"`
    };
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('[hub] settings.json updated with hook config');
  }
}

// Find the project directory holding a given CC session's JSONL by globbing
// ~/.claude/projects/<slug>/<ccSessionId>.jsonl across all project slugs.
// Returns the full path, or null if not found.
function findTranscriptByCCSessionId(ccSessionId) {
  if (!ccSessionId) return null;
  try {
    const projectsDir = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'projects');
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(projectsDir, d.name, ccSessionId + '.jsonl');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

// Pull the original cwd out of a transcript JSONL. CC embeds `cwd` in most
// message entries as JSON; we read enough to grab the first occurrence.
// Authoritative — this is what the session was actually running in when the
// transcript was written, so using it guarantees `claude --resume <id>` can
// locate the project slug.
function extractCwdFromTranscript(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // Read up to 64KB from the head; cwd appears very early.
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf-8');
      const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse('"' + m[1] + '"');
    } finally { fs.closeSync(fd); }
  } catch {}
  return null;
}

// Heal stale cwds in a persisted session list by looking up each session's
// transcript file and reading the authoritative cwd. Fixes legacy entries
// that were corrupted by the old `status-event` overwrite bug.
function healPersistedCwds(sessions) {
  let fixed = 0;
  for (const s of sessions) {
    if (!s.ccSessionId) continue;
    const tp = findTranscriptByCCSessionId(s.ccSessionId);
    if (!tp) continue;
    const realCwd = extractCwdFromTranscript(tp);
    if (realCwd && realCwd !== s.cwd) {
      console.log(`[hub] heal cwd: "${s.title}" ${s.cwd} -> ${realCwd}`);
      s.cwd = realCwd;
      fixed++;
    }
  }
  return fixed;
}

// Read the last user message text from a Claude Code transcript JSONL file.
// Reads the trailing chunk(s) only (not the whole file) — long sessions can be
// 10MB+ and we used to readFileSync the whole thing on every hook POST, which
// stalled the main-process event loop. Now we seek from EOF and walk backward
// in 64KB chunks until we hit the first complete `user`-typed entry.
// Returns null on any failure — caller should treat absence as non-fatal.
async function readLastUserMessage(transcriptPath) {
  const CHUNK = 65536;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    let pos = size;
    let tail = '';
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // The first fragment may be an incomplete line — keep it for the next pass
      // by prepending it back to `tail`, except when we've reached the very start.
      const firstFragment = pos === 0 ? null : lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const role = entry.type || entry.role;
        if (role !== 'user') continue;
        const msg = entry.message;
        let text = '';
        if (typeof msg === 'string') {
          text = msg;
        } else if (msg && typeof msg.content === 'string') {
          text = msg.content;
        } else if (msg && Array.isArray(msg.content)) {
          // CC stores tool_result entries as role=user too (Anthropic API
          // convention). Skip those — they pollute the preview with strings
          // like "[Image: source: ]" pulled from tool return payloads.
          const hasTool = msg.content.some(c => c && c.type === 'tool_result');
          if (hasTool) continue;
          text = msg.content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ').trim();
        }
        if (text) return text;
      }
      tail = firstFragment == null ? '' : firstFragment;
    }
  } catch {
    // swallowed — non-fatal
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
  return null;
}

// Hook server picks the first free port in this range.
const HOOK_PORT_CANDIDATES = [3456, 3457, 3458, 3459, 3460];
// Random per-launch token; hook POSTs must carry it. Stops any other local
// process from forging unread bumps.
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

let hookPort = null;  // set after listen() succeeds
let mobileSrv = null; // set after app.whenReady startup

let mainWindow;
const sessionManager = new SessionManager();
sessionManager.hookToken = HOOK_TOKEN;  // port set after listen

// NOTE: Don't call app.setAppUserModelId here. Setting an AUMID without also
// registering an icon resource for that AUMID (or matching it on the launcher
// .lnk) decouples the running process from the launching shortcut, and Windows
// falls back to electron.exe's default atom icon in the taskbar. With no AUMID
// set, Windows uses the .lnk's icon for taskbar entries spawned via the .lnk
// and BrowserWindow.icon for the title bar — both end up the octopus.

function createWindow() {
  // Load the icon as a NativeImage so we can pass it to BrowserWindow AND
  // re-apply via setIcon — on Windows the constructor `icon` alone sometimes
  // misses the taskbar; the explicit setIcon nails it.
  const iconPath = path.join(__dirname, 'claude-wx.ico');
  const winIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Claude Session Hub',
    backgroundColor: '#0d1117',
    icon: winIcon,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  if (!winIcon.isEmpty()) {
    mainWindow.setIcon(winIcon);
  } else {
    console.warn('[icon] failed to load', iconPath);
  }

  mainWindow.maximize();
  mainWindow.show();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

sessionManager.onData = (sessionId, data) => {
  sendToRenderer('terminal-data', { sessionId, data });
};

sessionManager.onSessionClosed = (sessionId) => {
  sendToRenderer('session-closed', { sessionId });
};

ipcMain.handle('create-session', (_e, arg) => {
  // Back-compat: legacy callers pass just a `kind` string. New callers pass
  // `{ kind, opts }` so they can request `resumeCCSessionId` / custom cwd / etc.
  let kind, opts;
  if (typeof arg === 'string') { kind = arg; opts = {}; }
  else if (arg && typeof arg === 'object') { kind = arg.kind; opts = arg.opts || {}; }
  else { kind = 'powershell'; opts = {}; }
  const session = sessionManager.createSession(kind, opts);
  sendToRenderer('session-created', { session });
  return session;
});

// Archive scanner: enumerate past Claude Code sessions for the Resume picker.
const sessionArchive = require('./core/session-archive.js');
ipcMain.handle('list-past-sessions', async (_e, { limit = 50 } = {}) => {
  try { return await sessionArchive.listRecent(limit); }
  catch (e) { console.warn('[hub] list-past-sessions failed:', e.message); return []; }
});

ipcMain.handle('search-past-sessions', async (_e, { query, limit = 50 } = {}) => {
  try { return await sessionArchive.searchAcross(query, { limit }); }
  catch (e) { console.warn('[hub] search-past-sessions failed:', e.message); return { hits: [], truncated: false }; }
});

ipcMain.handle('close-session', (_e, sessionId) => {
  // No explicit sendToRenderer here — closeSession kills the PTY, which fires
  // the onExit callback wired up above (line 87) and emits session-closed for
  // us. Emitting twice would spam the renderer for no benefit.
  sessionManager.closeSession(sessionId);
});

ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
  sessionManager.writeToSession(sessionId, data);
});

ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows }) => {
  sessionManager.resizeSession(sessionId, cols, rows);
});

ipcMain.on('focus-session', (_e, { sessionId }) => {
  sessionManager.setFocusedSession(sessionId);
  sessionManager.markRead(sessionId);
});

ipcMain.handle('rename-session', (_e, { sessionId, title }) => {
  const session = sessionManager.renameSession(sessionId, title);
  if (session) sendToRenderer('session-updated', { session });
  return session;
});

ipcMain.handle('get-sessions', () => {
  return sessionManager.getAllSessions();
});

// --- Dormant session persistence ---
// On boot we read state.json; those entries become dormant (sidebar entries
// with no live PTY). User clicks dormant session → resume-session IPC spawns
// PTY with `claude --resume <ccSessionId>`.
const bootState = stateStore.load();
const bootWasClean = bootState.cleanShutdown;
let lastPersistedSessions = Array.isArray(bootState.sessions) ? bootState.sessions : [];
// Heal any cwds that legacy code corrupted (see extractCwdFromTranscript).
// This reads CC's own JSONL transcripts which carry the authoritative cwd.
const healed = healPersistedCwds(lastPersistedSessions);
if (healed > 0) console.log(`[hub] healed ${healed} stale cwd(s) from CC transcripts`);
// Flip cleanShutdown to false immediately on boot; before-quit will flip it back.
stateStore.save({ version: 1, cleanShutdown: false, sessions: lastPersistedSessions }, { sync: true });

ipcMain.handle('get-dormant-sessions', () => ({
  sessions: lastPersistedSessions,
  wasCleanShutdown: bootWasClean,
}));

ipcMain.on('persist-sessions', (_e, list) => {
  if (!Array.isArray(list)) return;
  lastPersistedSessions = list;
  stateStore.save({ version: 1, cleanShutdown: false, sessions: list });
});

// Wake a dormant session: spawn PTY with the same hubId, reusing stored cwd,
// CC session id, title. The session-manager handles `claude --resume <id>` or
// `--continue` as fallback when we don't have a CC id recorded.
ipcMain.handle('resume-session', (_e, meta) => {
  if (!meta || !meta.hubId) return null;
  const session = sessionManager.createSession(meta.kind || 'claude', {
    id: meta.hubId,
    title: meta.title,
    cwd: meta.cwd,
    resumeCCSessionId: meta.ccSessionId || undefined,
    useContinue: !meta.ccSessionId,
    lastMessageTime: meta.lastMessageTime,
    lastOutputPreview: meta.lastOutputPreview,
  });
  sendToRenderer('session-created', { session });
  return session;
});

// Restart a Claude/PowerShell session in place: close old PTY, spawn a new one
// with the same kind. The session gets a new id because PTY identity changes.
ipcMain.handle('restart-session', (_e, sessionId) => {
  const old = sessionManager.getSession(sessionId);
  if (!old) return null;
  // closeSession triggers the onExit callback which emits session-closed;
  // don't emit it a second time here.
  sessionManager.closeSession(sessionId);
  const fresh = sessionManager.createSession(old.kind);
  sendToRenderer('session-created', { session: fresh });
  return fresh;
});

// Show a Windows/OS notification. Renderer decides when to call it.
ipcMain.on('show-notification', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || 'Claude Session Hub', body: body || '', silent: false });
  n.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  n.show();
});

ipcMain.handle('is-window-focused', () => {
  return mainWindow ? mainWindow.isFocused() : false;
});

// --- Clipboard image paste support ---
const imageDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-session-hub', 'images');

ipcMain.handle('save-clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    fs.mkdirSync(imageDir, { recursive: true });

    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // 20260412143052
    const id = crypto.randomBytes(3).toString('hex'); // a1b2c3
    const filename = `${ts}-${id}.png`;
    const filePath = path.join(imageDir, filename);

    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  } catch (e) {
    console.warn('[hub] save-clipboard-image failed:', e.message);
    return null;
  }
});

// Let renderer inspect current hook server health for UI indicator.
ipcMain.handle('get-hook-status', () => ({
  up: hookPort !== null,
  port: hookPort,
}));

// Ctrl+click on a file path in the terminal routes here. shell.openPath
// launches the OS default handler (.md → markdown viewer, .png → image
// viewer, .html → browser, etc). Returns '' on success, error string on
// failure — we surface it back so renderer can log.
ipcMain.handle('open-path', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) return 'empty path';
  try {
    return await shell.openPath(filePath);
  } catch (e) {
    return String(e && e.message || e);
  }
});

// --- Mobile remote IPC handlers ---

ipcMain.handle('mobile:get-ips', () => {
  const nets = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
});

ipcMain.handle('mobile:get-port', () => {
  return (mobileSrv && mobileSrv.port) || 3470;
});

ipcMain.handle('mobile:create-pairing', async (_e, { addresses, deviceName }) => {
  const token = mobileAuth.generateToken();
  const port = (mobileSrv && mobileSrv.port) || 3470;
  const addrs = (addresses && addresses.length) ? addresses : [`127.0.0.1:${port}`];
  const payload = Buffer.from(JSON.stringify(addrs)).toString('base64url');
  const first = addrs[0];
  const scheme = first.startsWith('http://') || first.startsWith('https://') ? '' : 'http://';
  const host = first.replace(/^https?:\/\//, '');
  const pairUrl = `${scheme}${host}/pair?token=${token}&addresses=${payload}&name=${encodeURIComponent(deviceName || 'Phone')}`;
  const qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 1, width: 360 });
  return { token, pairUrl, qrDataUrl };
});

ipcMain.handle('mobile:list-devices', () => mobileAuth.listDevices());

ipcMain.handle('mobile:revoke-device', (_e, deviceId) => {
  return mobileAuth.revokeDevice(deviceId);
});

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires Stop / UserPromptSubmit hooks. Forwards to renderer as IPC events.
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const isHook = req.method === 'POST' && req.url.startsWith('/api/hook/');
  const isStatus = req.method === 'POST' && req.url === '/api/status';
  if (!isHook && !isStatus) {
    res.writeHead(404); res.end('{}'); return;
  }

  // Cap body size at 16KB — statusline payloads are tiny, hooks tinier
  let body = '';
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    if (body.length + c.length > 16384) { tooBig = true; return; }
    body += c;
  });
  req.on('end', async () => {
    if (tooBig) { res.writeHead(413); res.end('{}'); return; }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    if (parsed.token !== HOOK_TOKEN) {
      res.writeHead(403); res.end('{}'); return;
    }
    if (parsed.sessionId && sessionManager.getSession(parsed.sessionId)) {
      if (isHook) {
        const event = req.url.slice('/api/hook/'.length); // 'stop' or 'prompt'
        // Prefer the UserPromptSubmit payload's `prompt` field when present —
        // it's the just-submitted text and doesn't depend on CC having flushed
        // the new transcript entry to disk. For Stop events (no `prompt` in
        // payload) fall back to reading the transcript JSONL tail (async —
        // long transcripts used to block the main-process event loop).
        let latestUserMessage = null;
        if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
          latestUserMessage = parsed.prompt;
        } else if (parsed.transcriptPath) {
          latestUserMessage = await readLastUserMessage(parsed.transcriptPath);
        }
        sendToRenderer('hook-event', {
          event,
          sessionId: parsed.sessionId,
          claudeSessionId: parsed.claudeSessionId,
          cwd: parsed.cwd,
          latestUserMessage,
        });
      } else {
        sendToRenderer('status-event', {
          sessionId: parsed.sessionId,
          contextPct: parsed.contextPct,
          contextUsed: parsed.contextUsed,
          contextMax: parsed.contextMax,
          usage5h: parsed.usage5h,
          usage7d: parsed.usage7d,
          model: parsed.model,
          sessionName: parsed.sessionName,
          cwd: parsed.cwd,
          apiMs: parsed.apiMs,
          linesAdded: parsed.linesAdded,
          linesRemoved: parsed.linesRemoved,
        });
      }
    }
    res.writeHead(200); res.end('{}');
  });
});

// Try candidate ports in order; return the first that listens successfully.
// Any bind error on a candidate (EADDRINUSE, EACCES, EPERM, …) falls through
// to the next; only when all candidates fail do we give up.
function listenWithFallback() {
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= HOOK_PORT_CANDIDATES.length) return resolve(null);
      const port = HOOK_PORT_CANDIDATES[idx++];
      hookServer.removeAllListeners('error');
      hookServer.removeAllListeners('listening');
      hookServer.once('error', (e) => {
        console.warn(`[hub] hook server bind failed on :${port} (${e.code}): ${e.message}`);
        tryNext();
      });
      hookServer.once('listening', () => resolve(port));
      hookServer.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

app.whenReady().then(async () => {
  ensureHooksDeployed();
  hookPort = await listenWithFallback();
  if (hookPort) {
    console.log(`[hub] hook server listening on 127.0.0.1:${hookPort}`);
    sessionManager.hookPort = hookPort;
  } else {
    console.warn('[hub] hook server failed to bind — falling back to silence detection');
  }
  // Start mobile server — awaited so that CLAUDE_HUB_MOBILE_PORT is set before
  // any PTY session is created (dormant restore, etc.). Failure is logged but
  // not fatal: global.__mobileSrv stays null and session-manager falls back to
  // port 3470 as a best-effort default.
  try {
    mobileSrv = await createMobileServer({
      sessionManager,
      preferredPort: 3470,
      getDormantSessions: () => lastPersistedSessions,
    });
    console.log(`[mobile] listening on :${mobileSrv.port}`);
    global.__mobileSrv = mobileSrv;
  } catch (e) {
    console.error('[mobile] failed to start:', e);
    global.__mobileSrv = null;
  }
  createWindow();
  // Push status to renderer after window is ready
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort });
    });
  }
});

// --- AI Team Room IPC ---
const { TeamBridge } = require('./core/team-bridge.js');
const teamBridge = new TeamBridge();

ipcMain.handle('team:isInitialized', () => teamBridge.isInitialized());
ipcMain.handle('team:loadRooms', () => teamBridge.loadRooms());
ipcMain.handle('team:loadCharacters', () => teamBridge.loadCharacters());
ipcMain.handle('team:getEvents', (_, roomId, limit) => teamBridge.getEvents(roomId, limit));
ipcMain.handle('team:getWiki', (_, roomId) => teamBridge.getWiki(roomId));
ipcMain.handle('team:ask', async (event, roomId, message) => {
  try {
    const result = await teamBridge.askTeam(roomId, message, (type, data) => {
      const sender = event.sender;
      if (sender && !sender.isDestroyed()) {
        sender.send('team:event', { type, data });
      }
    });
    return result;
  } catch (e) {
    return { code: 1, stderr: e.message, error: true };
  }
});

app.on('before-quit', async () => {
  // Flush final state with cleanShutdown=true so next boot won't flag as crash.
  stateStore.save({ version: 1, cleanShutdown: true, sessions: lastPersistedSessions }, { sync: true });
  if (mobileSrv) { try { await mobileSrv.close(); } catch {} }
});

app.on('window-all-closed', () => {
  hookServer.close();
  sessionManager.dispose();
  app.quit();
});
