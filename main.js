const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
let QRCode = null;
const { SessionManager } = require('./core/session-manager.js');
const { TeamSessionManager } = require('./core/team-session-manager.js');
const stateStore = require('./core/state-store.js');
const { createMobileServer } = require('./core/mobile-server.js');
const mobileAuth = require('./core/mobile-auth.js');
const { getHubDataDir } = require('./core/data-dir.js');
const { MeetingRoomManager } = require('./core/meeting-room.js');
const meetingStore = require('./core/meeting-store.js');
const { SummaryEngine } = require('./core/summary-engine');
const summaryEngine = new SummaryEngine();
const { TranscriptTap } = require('./core/transcript-tap');
const transcriptTap = new TranscriptTap();
const { DeepSummaryService } = require('./core/deep-summary-service.js');
const { GeminiCliProvider } = require('./core/summary-providers/gemini-cli.js');
const { DeepSeekProvider } = require('./core/summary-providers/deepseek-api.js');
const { loadConfig: loadDeepSummaryConfig } = require('./core/deep-summary-config.js');

// Isolate Chromium userData when CLAUDE_HUB_DATA_DIR is set (parallel test
// instances). Must run before app.whenReady(). Production Hub unaffected
// because the env var is only set by test harnesses.
if (process.env.CLAUDE_HUB_DATA_DIR) {
  app.setPath('userData', path.join(process.env.CLAUDE_HUB_DATA_DIR, 'electron-userdata'));
}

// Auto-deploy hook scripts + settings.json config on first launch.
// Idempotent — skips if already present, never overwrites user's existing hooks.
// claudeDirPath: target Claude config dir (e.g. ~/.claude or ~/.claude-deepseek)
function ensureHooksDeployed(claudeDirPath) {
  const claudeDir = claudeDirPath;
  const scriptsDir = path.join(claudeDir, 'scripts');

  // 1. Copy hook scripts if missing
  const srcDir = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');

  const scriptFiles = ['session-hub-hook.py', 'claude-hub-statusline.js', 'deepseek_repl.py'];
  for (const file of scriptFiles) {
    const dest = path.join(scriptsDir, file);
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(scriptsDir, { recursive: true });
    // Repo-generated scripts (not user-authored): keep deployed copy in sync
    // with the repo. Otherwise an old deployed statusline/hook keeps running
    // and silently ignores new logic shipped in later Hub releases.
    let needsCopy = !fs.existsSync(dest);
    if (!needsCopy) {
      try { needsCopy = !fs.readFileSync(src).equals(fs.readFileSync(dest)); }
      catch { needsCopy = true; }
    }
    if (needsCopy) {
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

// Ensure Codex CLI status bar includes context-remaining so the scanner can
// parse context usage. Idempotent — only patches if the key is absent.
function ensureCodexContextConfig() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const configPath = path.join(home, '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch {}
    if (content.includes('status_line')) return;
    const line = '\n[tui]\nstatus_line = ["model-with-reasoning", "context-remaining", "current-dir"]\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.appendFileSync(configPath, line);
    console.log('[hub] codex config.toml patched with context-remaining');
  } catch (e) {
    console.warn('[hub] codex config patch failed:', e.message);
  }
}

// Find the project directory holding a given CC session's JSONL by globbing
// ~/.claude/projects/<slug>/<ccSessionId>.jsonl across all project slugs.
// Returns the full path, or null if not found.
function findTranscriptByCCSessionId(ccSessionId) {
  if (!ccSessionId) return null;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const candidateRoots = [
    path.join(home, '.claude', 'projects'),
    path.join(home, '.claude-deepseek', 'projects'),
  ];
  for (const projectsDir of candidateRoots) {
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(projectsDir, d.name, ccSessionId + '.jsonl');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
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
const HOOK_PORT_CANDIDATES = [
  3456, 3457, 3458, 3459, 3460,
  3461, 3462, 3463, 3464, 3465,
  3466, 3467, 3468, 3469, 3470,
  3471, 3472, 3473, 3474, 3475,
];
// Random per-launch token; hook POSTs must carry it. Stops any other local
// process from forging unread bumps.
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

let hookPort = null;  // set after listen() succeeds
let mobileSrv = null; // set after app.whenReady startup
let teamSessionManager = null; // set after hookPort is known

let mainWindow;
const sessionManager = new SessionManager();
const meetingManager = new MeetingRoomManager();

// Deep-summary service singleton: instantiated from config-driven fallback chain.
// Providers tried in order; first one with a parseable response wins.
const _deepSummaryConfig = loadDeepSummaryConfig();
function _buildDeepSummaryProviders() {
  const providers = [];
  for (const name of _deepSummaryConfig.fallback_chain) {
    if (name === 'gemini-cli') {
      providers.push(new GeminiCliProvider(_deepSummaryConfig.gemini_cli));
    } else if (name === 'deepseek-api') {
      providers.push(new DeepSeekProvider(_deepSummaryConfig.deepseek_api));
    } else {
      console.warn('[deep-summary] unknown provider in fallback_chain:', name);
    }
  }
  if (providers.length === 0) {
    throw new Error('deep-summary fallback_chain produced 0 providers');
  }
  return providers;
}
const deepSummaryService = new DeepSummaryService({ providers: _buildDeepSummaryProviders() });

// Wire TranscriptTap → MeetingRoomManager timeline.
// When a sub-session's CLI finishes a turn, append the AI text to its
// meeting's timeline (if the sub-session belongs to a meeting).
transcriptTap.on('turn-complete', ({ hubSessionId, text, completedAt }) => {
  const session = sessionManager.getSession(hubSessionId);
  if (!session || !session.meetingId) return;
  const turn = meetingManager.appendTurn(
    session.meetingId,
    hubSessionId,
    text,
    completedAt != null ? completedAt : Date.now(),
  );
  if (turn) {
    sendToRenderer('meeting-timeline-updated', { meetingId: session.meetingId, turn });
  }
});

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
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
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

sessionManager.onSessionClosed = (sessionId, meetingId) => {
  try { transcriptTap.unregisterSession(sessionId); } catch {}
  sendToRenderer('session-closed', { sessionId });
  if (meetingId) {
    const updated = meetingManager.removeSubSession(meetingId, sessionId);
    if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  }
};

// Register a freshly-spawned session with the transcript tap so the appropriate
// backend starts watching its CLI-native transcript file. No-op for kinds
// without a backend (powershell/deepseek).
function registerSessionForTap(session) {
  if (!session || !session.id) return;
  try { transcriptTap.registerSession(session.id, session.kind, { cwd: session.cwd }); }
  catch {}
}

ipcMain.handle('create-session', (_e, arg) => {
  // Back-compat: legacy callers pass just a `kind` string. New callers pass
  // `{ kind, opts }` so they can request `resumeCCSessionId` / custom cwd / etc.
  let kind, opts;
  if (typeof arg === 'string') { kind = arg; opts = {}; }
  else if (arg && typeof arg === 'object') { kind = arg.kind; opts = arg.opts || {}; }
  else { kind = 'powershell'; opts = {}; }
  const session = sessionManager.createSession(kind, opts);
  registerSessionForTap(session);
  sendToRenderer('session-created', { session });
  return session;
});

// --- Meeting Room IPC ---

ipcMain.handle('create-meeting', () => {
  const meeting = meetingManager.createMeeting();
  sendToRenderer('meeting-created', { meeting });
  return meeting;
});

ipcMain.handle('add-meeting-sub', (_e, { meetingId, kind, opts }) => {
  const session = sessionManager.createSession(kind, { ...(opts || {}), meetingId });
  if (!session) return null;
  const updated = meetingManager.addSubSession(meetingId, session.id);
  if (!updated) {
    sessionManager.closeSession(session.id);
    return null;
  }
  registerSessionForTap(session);
  sendToRenderer('session-created', { session });
  sendToRenderer('meeting-updated', { meeting: updated });
  return { session, meeting: updated };
});

ipcMain.handle('remove-meeting-sub', (_e, { meetingId, sessionId }) => {
  sessionManager.closeSession(sessionId);
  const updated = meetingManager.removeSubSession(meetingId, sessionId);
  if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  return updated;
});

ipcMain.handle('close-meeting', (_e, meetingId) => {
  const subIds = meetingManager.closeMeeting(meetingId);
  if (!subIds) return false;
  for (const sid of subIds) {
    sessionManager.closeSession(sid);
  }
  sendToRenderer('meeting-closed', { meetingId });
  return true;
});

ipcMain.handle('get-ring-buffer', (_e, sessionId) => {
  return sessionManager.getSessionBuffer(sessionId);
});

ipcMain.handle('quick-summary', (_e, sessionId) => {
  // Authoritative-first: transcript tap (Stop hook / rollout / chats JSONL).
  // Falls back to marker scan from PTY ring buffer when tap has no value.
  // This makes buildContextSummary / checkDivergence pick up transcript-tap
  // content without changing each call site.
  const tapped = transcriptTap.getLastAssistantText(sessionId);
  if (tapped && tapped.trim()) return tapped;
  const raw = sessionManager.getSessionBuffer(sessionId);
  return summaryEngine.quickSummary(raw || '', sessionId);
});

ipcMain.handle('marker-status', (_e, sessionId) => {
  const raw = sessionManager.getSessionBuffer(sessionId);
  return summaryEngine.markerStatus(raw || '', sessionId);
});

ipcMain.handle('get-marker-instruction', () => {
  return summaryEngine.getMarkerInstruction();
});

// Hub Timeline IPC: append a user turn to the meeting timeline.
// Renderer calls this when user submits a message in meeting room before
// the message goes to PTY(s).
ipcMain.handle('meeting-append-user-turn', (_e, { meetingId, text }) => {
  if (!meetingId || typeof text !== 'string' || !text) return null;
  const turn = meetingManager.appendTurn(meetingId, 'user', text, Date.now());
  if (turn) {
    sendToRenderer('meeting-timeline-updated', { meetingId, turn });
  }
  return turn;
});

// Hub Timeline IPC: full snapshot of meeting timeline (for Feed UI rerender).
ipcMain.handle('meeting-get-timeline', (_e, meetingId) => {
  return meetingManager.getTimeline(meetingId);
});

// Hub Timeline IPC: compute incremental context for a target sub-session.
// Returns { turns: [...], advancedTo: int }. Side effect: cursor advanced.
// Renderer calls this in handleMeetingSend when syncContext is ON.
ipcMain.handle('meeting-incremental-context', (_e, { meetingId, targetSid }) => {
  if (!meetingId || !targetSid) return { turns: [], advancedTo: 0 };
  // Surface misconfiguration: cursor not registered for this target means
  // the sub-session was never added (or already removed) — silent empty
  // return would mask wrong meetingId / sid bugs in callers.
  if (meetingManager.getCursor(meetingId, targetSid) === null) {
    console.warn(`[meeting-ipc] incremental-context called with unregistered targetSid=${targetSid} in meetingId=${meetingId}`);
  }
  return meetingManager.incrementalContext(meetingId, targetSid);
});

// Read the authoritative last-assistant text captured by the transcript tap.
// Returns null if no tap backend has fired for this session yet (CLI hasn't
// finished a turn, hook hasn't triggered, or file path couldn't be resolved).
// Renderer falls back to marker-based extraction when null.
ipcMain.handle('get-last-assistant-text', (_e, sessionId) => {
  return transcriptTap.getLastAssistantText(sessionId);
});

function collectAgentOutputs(meetingId) {
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return null;
  const outputs = {};
  for (const sid of meeting.subSessions) {
    // Authoritative-first: transcript tap, then marker scan fallback.
    let content = transcriptTap.getLastAssistantText(sid);
    if (!content || !content.trim()) {
      const raw = sessionManager.getSessionBuffer(sid);
      content = summaryEngine.extractMarker(raw || '', sid);
    }
    if (content) {
      const session = sessionManager.getSession(sid);
      const label = session ? (session.kind || 'AI') : 'AI';
      outputs[label] = content;
    }
  }
  return Object.keys(outputs).length >= 2 ? outputs : null;
}

ipcMain.handle('compress-context', async (_e, { content, maxChars }) => {
  return await summaryEngine.compressContext(content, maxChars || 1000);
});

ipcMain.handle('detect-divergence', async (_e, { meetingId }) => {
  const outputs = collectAgentOutputs(meetingId);
  if (!outputs) return { consensus: [], divergence: [] };
  return await summaryEngine.detectDivergence(outputs);
});

ipcMain.handle('deep-summary', async (_e, { sessionId, scene, question, agentName }) => {
  // Prefer authoritative transcript-tap content; fall back to PTY ring buffer
  // (which feeds extractMarker inside deepSummary). When tap has content we
  // synthesize a marker-wrapped string so deepSummary's existing extractMarker
  // path picks it up without changing the summary-engine API.
  const tapped = transcriptTap.getLastAssistantText(sessionId);
  let raw;
  if (tapped && tapped.trim()) {
    raw = `\nSM-START\n${tapped}\nSM-END\n`;
  } else {
    raw = sessionManager.getSessionBuffer(sessionId) || '';
  }
  if (!raw) return '';
  return await summaryEngine.deepSummary(raw, { agentName, question, scene });
});

ipcMain.handle('get-summary-scenes', () => {
  return summaryEngine.getScenes();
});

ipcMain.handle('build-injection', (_e, { summaries, userFollowUp }) => {
  return summaryEngine.buildInjection(summaries, userFollowUp);
});

ipcMain.on('update-meeting', (_e, { meetingId, fields }) => {
  const updated = meetingManager.updateMeeting(meetingId, fields);
  if (updated) sendToRenderer('meeting-updated', { meeting: updated });
});

ipcMain.handle('get-meetings', () => {
  return meetingManager.getAllMeetings();
});

// Deep-summary IPC: generate structured meeting summary from full timeline via
// config-driven provider fallback chain (gemini-cli → deepseek-api). This is
// distinct from the older `'deep-summary'` channel above (single-session marker
// summary). Returns the full service result envelope (status / data / _meta).
ipcMain.handle('generate-meeting-summary', async (_event, meetingId) => {
  try {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) {
      return {
        status: 'failed',
        _meta: { last_error: `meeting not found: ${meetingId}`, parse_status: 'failed' },
      };
    }
    const timeline = meetingManager.getTimeline(meetingId);
    const labelMap = new Map();
    const presentAIs = new Set(['user']);
    for (const sid of meeting.subSessions) {
      const s = sessionManager.sessions.get(sid);
      if (s && s.info) {
        labelMap.set(sid, { label: s.info.title || s.info.kind || 'AI', kind: s.info.kind });
        if (s.info.kind) presentAIs.add(s.info.kind);
      }
    }
    return await deepSummaryService.generate(timeline, presentAIs, labelMap);
  } catch (e) {
    console.error('[generate-meeting-summary] error:', e);
    return {
      status: 'failed',
      _meta: { last_error: e.message, parse_status: 'failed' },
    };
  }
});

ipcMain.handle('get-deep-summary-config', async () => _deepSummaryConfig.ui);

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

// Diagnostic: read the PTY ring buffer for a session (used by E2E smoke tests).
ipcMain.handle('debug:get-session-buffer', (_e, sessionId) => {
  return sessionManager.getSessionBuffer(sessionId);
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
// Restore persisted meetings on boot
const bootMeetings = Array.isArray(bootState.meetings) ? bootState.meetings : [];
for (const m of bootMeetings) {
  if (m.layout === 'split') m.layout = 'focus';
  meetingManager.restoreMeeting(m);
}

// Flip cleanShutdown to false immediately on boot; before-quit will flip it back.
stateStore.save({ version: 1, cleanShutdown: false, sessions: lastPersistedSessions, meetings: bootMeetings }, { sync: true });

ipcMain.handle('get-dormant-meetings', () => meetingManager.getAllMeetings());

// Lazy load timeline for a restored meeting (called when user opens the meeting view).
// Idempotent: safe to call multiple times; second+ call returns same in-memory state.
ipcMain.handle('meeting-load-timeline', (_e, meetingId) => {
  if (!meetingId) return { ok: false, reason: 'missing meetingId' };
  const ok = meetingManager.loadTimelineLazy(meetingId);
  if (!ok) return { ok: false, reason: 'no persisted timeline (or meeting unknown)' };
  return {
    ok: true,
    timeline: meetingManager.getTimeline(meetingId),
  };
});

ipcMain.handle('get-dormant-sessions', () => ({
  sessions: lastPersistedSessions,
  wasCleanShutdown: bootWasClean,
}));

ipcMain.on('persist-sessions', (_e, list, meetingList) => {
  if (!Array.isArray(list)) return;
  lastPersistedSessions = list;
  stateStore.save({
    version: 1,
    cleanShutdown: false,
    sessions: list,
    meetings: Array.isArray(meetingList) ? meetingList : meetingManager.getAllMeetings(),
  });
});

// Wake a dormant session: spawn PTY with the same hubId, reusing stored cwd,
// CC session id, title. The session-manager handles `claude --resume <id>` or
// `--continue` as fallback when we don't have a CC id recorded.
ipcMain.handle('resume-session', (_e, meta) => {
  if (!meta || !meta.hubId) return null;
  const isClaude = (meta.kind === 'claude' || meta.kind === 'claude-resume');
  const isDeepSeek = (meta.kind === 'deepseek');
  const isClaudeCliResumable = isClaude || isDeepSeek;
  const isGeminiOrCodex = (meta.kind === 'gemini' || meta.kind === 'codex');
  const session = sessionManager.createSession(meta.kind || 'claude', {
    id: meta.hubId,
    title: meta.title,
    cwd: meta.cwd,
    meetingId: meta.meetingId || null,
    resumeCCSessionId: isClaudeCliResumable ? (meta.ccSessionId || undefined) : undefined,
    useContinue: isClaudeCliResumable && !meta.ccSessionId,
    useResume: isGeminiOrCodex,
    lastMessageTime: meta.lastMessageTime,
    lastOutputPreview: meta.lastOutputPreview,
  });
  registerSessionForTap(session);
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
  const fresh = sessionManager.createSession(old.kind, {
    id: old.id,
    cwd: old.cwd,
    meetingId: old.meetingId || undefined,
  });
  registerSessionForTap(fresh);
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
const imageDir = path.join(getHubDataDir(), 'images');

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

const READ_FILE_EXTS = new Set([
  '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bat', '.ps1', '.xml', '.sql', '.r', '.rb', '.php',
  '.swift', '.kt', '.lua', '.zig', '.asm', '.css', '.scss', '.less',
]);
ipcMain.handle('read-file', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { error: 'invalid path' };
  const ext = path.extname(filePath).toLowerCase();
  if (!READ_FILE_EXTS.has(ext)) return { error: 'unsupported extension' };
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) return { error: 'file too large (>5MB)' };
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { content };
  } catch (e) {
    return { error: String(e && e.message || e) };
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
  if (!QRCode) QRCode = require('qrcode');
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
  const isTeamResponse = req.method === 'POST' && req.url === '/api/team/response';
  if (!isHook && !isStatus && !isTeamResponse) {
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
    // Team MCP callback — no hook token required (loopback only)
    if (isTeamResponse) {
      if (teamSessionManager && parsed.room_id && parsed.character_id && parsed.content) {
        teamSessionManager.onResponse(parsed.room_id, parsed.character_id, parsed.content, parsed.event_id);
        sendToRenderer('team-response', {
          roomId: parsed.room_id,
          characterId: parsed.character_id,
          content: parsed.content,
          eventId: parsed.event_id,
        });
      }
      res.writeHead(200); res.end('{"ok":true}');
      return;
    }
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
        // Feed the Claude transcript tap so the meeting-room blackboard gets
        // the authoritative final assistant turn (replaces SM-START/END markers).
        // Only fire on Stop events — UserPromptSubmit fires before the assistant
        // has responded, so the transcript tail's last-assistant entry would be
        // the previous turn and immediately trigger a stale update.
        if (event === 'stop' && parsed.transcriptPath) {
          transcriptTap.notifyClaudeStop(parsed.sessionId, parsed.transcriptPath).catch(() => {});
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
        if (parsed.usage5h || parsed.usage7d) cacheAccountUsage({ usage5h: parsed.usage5h, usage7d: parsed.usage7d });
        if (teamSessionManager) {
          teamSessionManager.updateStatusForSession(parsed.sessionId, parsed);
        }
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

// --- Account usage cache ---
// Persist the latest Claude account usage so the sidebar renders immediately on
// restart without waiting for the first statusline callback.
const USAGE_CACHE_FILE = path.join(getHubDataDir(), 'usage-cache.json');

function cacheAccountUsage(data) {
  try {
    const existing = loadUsageCache();
    if (data.usage5h) existing.claude = { usage5h: data.usage5h, usage7d: data.usage7d, ts: Date.now() };
    fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(existing));
  } catch {}
}

function cacheAgentUsage(provider, tokenData) {
  try {
    const existing = loadUsageCache();
    existing[provider] = { ...tokenData, ts: Date.now() };
    fs.mkdirSync(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(existing));
  } catch {}
}

function loadUsageCache() {
  try { return JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8')); } catch { return {}; }
}

ipcMain.handle('get-usage-cache', () => loadUsageCache());

// --- Gemini/Codex ring-buffer usage scanner ---
// Periodically scans agent sessions' ring buffers for token/model patterns
// and emits status-event so the renderer can show context/usage badges.
const _agentLastStatus = new Map();
const _agentQuota = { gemini: null, codex: null };

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]/g, '');
}

function parseGeminiUsage(plain) {
  const result = {};
  // Gemini CLI footer: "(95% context left)" — actual context window usage
  const leftMatch = plain.match(/(gemini[-\w.]+)\s*\((\d+)%\s*context\s*left\)/i);
  if (leftMatch) {
    result.model = { id: leftMatch[1], displayName: SessionManager.geminiDisplayName(leftMatch[1]) };
    result.contextPct = 100 - parseInt(leftMatch[2], 10);
  }
  // Gemini CLI footer quota column: "N% used" — API quota, NOT context window
  const usedMatch = plain.match(/(gemini[-\w.]*[a-z])\s*(\d+)%\s*used/i);
  if (usedMatch) {
    if (!result.model) result.model = { id: usedMatch[1], displayName: SessionManager.geminiDisplayName(usedMatch[1]) };
    result.quotaPct = parseInt(usedMatch[2], 10);
  }
  if (!result.model) {
    const modelMatch = plain.match(/\b(gemini[-\w.]+)\b/i);
    if (modelMatch) result.model = { id: modelMatch[1], displayName: SessionManager.geminiDisplayName(modelMatch[1]) };
  }
  return result;
}

function parseCodexUsage(plain) {
  const result = {};
  // Codex CLI status bar: "Context 95% left"
  const ctxMatch = plain.match(/Context\s+(\d+)%\s+left/i);
  if (ctxMatch) {
    const remaining = parseInt(ctxMatch[1], 10);
    result.contextPct = 100 - remaining;
  }
  // Codex status bar: "gpt-5.4 medium" or "gpt-4.1-mini low"
  const modelMatch = plain.match(/\b(gpt-[\w.-]+|o\d-[\w.-]+)\b/i);
  if (modelMatch) {
    const id = modelMatch[1];
    result.model = { id, displayName: id };
  }
  // Exit summary: "Token usage: total=12,840 input=11,897 (+ 3,456 cached) output=943"
  const tokenMatch = plain.match(/Token usage:\s*total=([\d,]+)/i);
  if (tokenMatch) result.tokensUsed = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
  return result;
}

// --- Codex JSONL-based usage scanner ---
// Codex CLI writes authoritative rate_limits to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Each file contains token_count events with primary (5h) and secondary (7d) windows.
let _codexJsonlLastScan = 0;
let _codexJsonlCached = null;
const CODEX_JSONL_THROTTLE_MS = 30_000;

function scanCodexJsonlUsage() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const sessionsDir = path.join(home, '.codex', 'sessions');
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const datePaths = [];
    datePaths.push(path.join(sessionsDir, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())));
    const yesterday = new Date(now.getTime() - 86400000);
    datePaths.push(path.join(sessionsDir, String(yesterday.getFullYear()), pad(yesterday.getMonth() + 1), pad(yesterday.getDate())));

    let newestEntry = null;
    for (const dir of datePaths) {
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')); } catch { continue; }
      const withStats = files.map(f => {
        const fp = path.join(dir, f);
        try { return { path: fp, mtime: fs.statSync(fp).mtimeMs }; } catch { return null; }
      }).filter(Boolean);
      withStats.sort((a, b) => b.mtime - a.mtime);
      for (const file of withStats.slice(0, 3)) {
        const entry = extractCodexRateLimits(file.path);
        if (entry) { newestEntry = entry; break; }
      }
      if (newestEntry) break;
    }
    return newestEntry;
  } catch { return null; }
}

function extractCodexRateLimits(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const tailSize = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count' && obj.payload.rate_limits) {
          const rl = obj.payload.rate_limits;
          const toMs = (t) => (typeof t === 'number' && t < 1e12) ? t * 1000 : t;
          const result = {};
          if (rl.primary && typeof rl.primary.used_percent === 'number') {
            result.usage5h = { pct: Math.round(rl.primary.used_percent), resetsAt: toMs(rl.primary.resets_at) };
          }
          if (rl.secondary && typeof rl.secondary.used_percent === 'number') {
            result.usage7d = { pct: Math.round(rl.secondary.used_percent), resetsAt: toMs(rl.secondary.resets_at) };
          }
          if (result.usage5h || result.usage7d) return result;
        }
      } catch { /* skip malformed lines */ }
    }
    return null;
  } catch { return null; }
}

function scanCodexJsonlUsageThrottled() {
  const now = Date.now();
  if (now - _codexJsonlLastScan < CODEX_JSONL_THROTTLE_MS && _codexJsonlCached) return _codexJsonlCached;
  _codexJsonlLastScan = now;
  _codexJsonlCached = scanCodexJsonlUsage();
  return _codexJsonlCached;
}

// Token-based rolling-window tracker for Gemini/Codex (fallback).
const AGENT_LIMITS = {
  gemini: { tokens5h: 2_000_000, tokens7d: 50_000_000 },
  codex:  { tokens5h: 1_000_000, tokens7d: 10_000_000 },
};
const _agentTokenLog = { gemini: [], codex: [] }; // [{ts, tokens}]

function recordAgentTokens(kind, tokens) {
  if (!_agentTokenLog[kind]) return;
  _agentTokenLog[kind].push({ ts: Date.now(), tokens });
}

function calcAgentUsage(kind) {
  const log = _agentTokenLog[kind];
  if (!log) return null;
  const now = Date.now();
  const H5 = 5 * 3600 * 1000;
  const D7 = 7 * 86400 * 1000;
  // Prune entries older than 7d
  while (log.length && log[0].ts < now - D7) log.shift();
  const tok5h = log.filter(e => e.ts >= now - H5).reduce((s, e) => s + e.tokens, 0);
  const tok7d = log.reduce((s, e) => s + e.tokens, 0);
  const lim = AGENT_LIMITS[kind];
  if (!lim) return null;
  if (tok5h === 0 && tok7d === 0) return null;
  return {
    usage5h: { pct: Math.min(100, Math.round(tok5h / lim.tokens5h * 100)), resetsAt: now + H5 },
    usage7d: { pct: Math.min(100, Math.round(tok7d / lim.tokens7d * 100)), resetsAt: now + D7 },
  };
}

function scanAgentSessions() {
  const allSessions = sessionManager.getAllSessions();
  for (const s of allSessions) {
    if (s.kind !== 'gemini' && s.kind !== 'codex') continue;
    if (s.status === 'dormant') continue;
    const buf = sessionManager.getSessionBuffer(s.id);
    if (!buf) continue;
    const plain = stripAnsi(buf);
    const parsed = s.kind === 'gemini' ? parseGeminiUsage(plain) : parseCodexUsage(plain);
    if (parsed.tokensUsed) {
      const prev = _agentLastStatus.get(s.id + ':tok');
      if (prev !== parsed.tokensUsed) {
        const delta = prev ? parsed.tokensUsed - prev : parsed.tokensUsed;
        if (delta > 0) recordAgentTokens(s.kind, delta);
        _agentLastStatus.set(s.id + ':tok', parsed.tokensUsed);
      }
    }
    // Gemini quotaPct → direct sidebar usage (real API quota from CLI footer)
    if (parsed.quotaPct != null) {
      const now = Date.now();
      const H5 = 5 * 3600 * 1000;
      const usageObj = { usage5h: { pct: parsed.quotaPct, resetsAt: now + H5 }, _ts: now };
      _agentQuota.gemini = usageObj;
    }
    if (!parsed.model && !parsed.tokensUsed && parsed.contextPct == null && parsed.quotaPct == null) continue;
    const prev = _agentLastStatus.get(s.id);
    const sig = JSON.stringify(parsed);
    if (prev === sig) continue;
    _agentLastStatus.set(s.id, sig);
    const payload = { sessionId: s.id };
    if (parsed.contextPct != null) payload.contextPct = parsed.contextPct;
    if (parsed.contextUsed != null) payload.contextUsed = parsed.contextUsed;
    if (parsed.contextMax != null) payload.contextMax = parsed.contextMax;
    if (parsed.model) payload.model = parsed.model;
    sendToRenderer('status-event', payload);
  }
  // Expire stale _agentQuota entries (no fresh CLI data for >10 min)
  const now = Date.now();
  for (const kind of ['gemini', 'codex']) {
    if (_agentQuota[kind] && _agentQuota[kind]._ts && now - _agentQuota[kind]._ts > 10 * 60 * 1000) {
      _agentQuota[kind] = null;
    }
  }
  // Build and broadcast per-provider usage.
  // Priority: Codex JSONL (authoritative) > ring buffer quota > token estimates.
  const agentData = {};
  // Codex: try JSONL first
  const codexJsonl = scanCodexJsonlUsageThrottled();
  if (codexJsonl) {
    agentData.codex = codexJsonl;
    cacheAgentUsage('codex', codexJsonl);
  } else if (_agentQuota.codex) {
    agentData.codex = _agentQuota.codex;
    cacheAgentUsage('codex', _agentQuota.codex);
  } else {
    const usage = calcAgentUsage('codex');
    if (usage) { agentData.codex = usage; cacheAgentUsage('codex', usage); }
  }
  // Gemini: quota from CLI footer > token estimates
  if (_agentQuota.gemini) {
    const gemData = { usage5h: _agentQuota.gemini.usage5h };
    const tokenUsage = calcAgentUsage('gemini');
    if (tokenUsage && tokenUsage.usage7d) gemData.usage7d = tokenUsage.usage7d;
    agentData.gemini = gemData;
    cacheAgentUsage('gemini', gemData);
  } else {
    const usage = calcAgentUsage('gemini');
    if (usage) { agentData.gemini = usage; cacheAgentUsage('gemini', usage); }
  }
  if (Object.keys(agentData).length > 0) sendToRenderer('agent-usage', agentData);
}

let _agentScanInterval = null;
function startAgentScanner() {
  if (_agentScanInterval) return;
  _agentScanInterval = setInterval(scanAgentSessions, 5000);
}

app.whenReady().then(async () => {
  const _home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  ensureHooksDeployed(path.join(_home, '.claude'));
  ensureHooksDeployed(path.join(_home, '.claude-deepseek'));
  ensureCodexContextConfig();
  hookPort = await listenWithFallback();
  if (hookPort) {
    console.log(`[hub] hook server listening on 127.0.0.1:${hookPort}`);
    sessionManager.hookPort = hookPort;
    teamSessionManager = new TeamSessionManager(sessionManager, hookPort);
    teamBridge.setTeamSessionManager(teamSessionManager);
  } else {
    console.warn('[hub] hook server failed to bind — falling back to silence detection');
  }
  createWindow();
  startAgentScanner();
  // Mobile server starts after window — no need to block UI for phone pairing.
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
// TeamSessionManager is wired to teamBridge lazily after hookPort is known
// (see app.whenReady). teamBridge._teamSessionManager is set there too.

ipcMain.handle('team:isInitialized', () => teamBridge.isInitialized());
ipcMain.handle('team:loadRooms', () => teamBridge._getCachedRooms());
ipcMain.handle('team:loadCharacters', () => teamBridge._getCachedCharacters());
ipcMain.handle('team:warm', (_, roomId) => teamBridge.warmRoom(roomId));
ipcMain.handle('team:getEvents', (_, roomId, limit) => teamBridge.getEvents(roomId, limit));
ipcMain.handle('team:getWiki', (_, roomId) => teamBridge.getWiki(roomId));
ipcMain.handle('team:ask', async (event, roomId, message, mode) => {
  try {
    const result = await teamBridge.askTeam(roomId, message, (type, data) => {
      const sender = event.sender;
      if (sender && !sender.isDestroyed()) {
        sender.send('team:event', { type, data, roomId });
      }
    }, 300000, mode || null);
    return result;
  } catch (e) {
    return { code: 1, stderr: e.message, error: true };
  }
});

ipcMain.handle('team:huddle', async (event, roomId) => {
  try {
    const result = await teamBridge.huddle(roomId, (type, data) => {
      const sender = event.sender;
      if (sender && !sender.isDestroyed()) {
        sender.send('team:event', { type, data, roomId });
      }
    });
    return result;
  } catch (e) {
    return { code: 1, stderr: e.message, error: true };
  }
});

ipcMain.handle('team:synthesize', async (event, roomId) => {
  try {
    const result = await teamBridge.synthesize(roomId, (type, data) => {
      const sender = event.sender;
      if (sender && !sender.isDestroyed()) {
        sender.send('team:event', { type, data, roomId });
      }
    });
    return result;
  } catch (e) {
    return { code: 1, stderr: e.message, error: true };
  }
});

ipcMain.handle('team:readFile', async (_, filePath) => {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, 'utf-8');
  if (content.length > 8192) return content.slice(0, 8192) + '\n... (截断，原文件 ' + content.length + ' 字符)';
  return content;
});

ipcMain.handle('team:createRoom', async (_, name, memberIds) => {
  return teamBridge.createRoom(name, memberIds);
});

ipcMain.handle('team:getRoomPreviews', () => teamBridge.getRoomPreviews());
ipcMain.handle('team:deleteRoom', (_, roomId) => teamBridge.deleteRoom(roomId));
ipcMain.handle('team:getWikiCandidates', (_, roomId) => teamBridge.getWikiCandidates(roomId));
ipcMain.handle('team:approveWiki', (_, factId) => teamBridge.approveWiki(factId));
ipcMain.handle('team:rejectWiki', (_, factId) => teamBridge.rejectWiki(factId));
ipcMain.handle('team:exportConversation', (_, roomId) => teamBridge.exportConversation(roomId));

app.on('before-quit', async () => {
  stateStore.save({ version: 1, cleanShutdown: true, sessions: lastPersistedSessions, meetings: meetingManager.getAllMeetings() }, { sync: true });
  try { teamBridge.cleanup(); } catch(e) {}
  if (teamSessionManager) { try { teamSessionManager.closeAll(); } catch(e) {} }
  if (mobileSrv) { try { await mobileSrv.close(); } catch {} }
  try {
    await meetingStore.flushAll();
    console.log('[hub] meeting-store flushed on quit');
  } catch (err) {
    console.warn('[hub] meeting-store flush failed:', err.message);
  }
});

app.on('window-all-closed', () => {
  hookServer.close();
  sessionManager.dispose();
  app.quit();
});
