import * as pty from 'node-pty';
import { v4 as uuid } from 'uuid';
import { SessionInfo, SessionKind } from './types.js';

const OUTPUT_BUFFER_MAX = 8192; // ~8KB ring buffer per session

interface ManagedSession {
  info: SessionInfo;
  pty: pty.IPty;
  outputBuffer: string[];
  outputBufferSize: number;
  promptBufferMark: number; // buffer index when prompt hook fires
}

function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1B\[[\?>=!]?[0-9;]*[a-zA-Z]/g, '') // CSI sequences (incl. ?25h etc.)
    .replace(/\x1B\][^\x07]*\x07/g, '')            // OSC (BEL terminated)
    .replace(/\x1B\][^\x1B]*\x1B\\/g, '')          // OSC (ST terminated)
    .replace(/\x1B[()][0-9A-Za-z]/g, '')           // charset selection
    .replace(/\x1B[=>MDHNO78]/g, '')               // single-char escapes
    .replace(/\x9B[0-9;]*[A-Za-z]/g, '')           // 8-bit CSI (0x9B prefix)
    .replace(/\[([0-9;]+)?[ABCDHJKfm]/g, '')       // orphaned CSI fragments (lost ESC prefix)
    .replace(/\r/g, '')                             // carriage returns
    .replace(/[\uE000-\uF8FF]/g, '')               // Private Use Area (Nerd Font/Powerline)
    .replace(/[\u2500-\u257F]/g, '')                // Box drawing characters (─│┌┐└┘├┤┬┴┼)
    .replace(/[\u2300-\u23FF]/g, '')                // Misc Technical (⎿⌘ etc.)
    .replace(/[\u2700-\u27BF]/g, '')                // Dingbats (❯❮✶✢ etc.)
    .replace(/[\u2800-\u28FF]/g, '')                // Braille patterns (spinners)
    .replace(/[\u2190-\u21FF]/g, '')                // Arrows (←→↑↓)
    .replace(/[●○◆◇▸►▹▷★☆✦✧·•※✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋]/g, '') // decorative symbols
    .replace(/\uFFFD/g, '')                         // Unicode replacement character
    .replace(/[?]{3,}/g, '')                        // garbled question mark runs
    .replace(/[ ]{3,}/g, ' ');                      // collapse excessive spaces
}

/** Extract meaningful CJK text segments from a line (Chinese chars + punctuation) */
function extractCJKSegments(text: string): string {
  // Match runs of CJK characters, Chinese/fullwidth punctuation, and common marks
  const cjkRuns = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff01-\uff5e！？。，、；：""''（）【】\u2026]+/g);
  if (!cjkRuns) return '';
  // Only keep runs that contain at least 2 actual CJK characters
  const meaningful = cjkRuns.filter(r => (r.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length >= 2);
  return meaningful.join(' ');
}

/** Check if a string contains meaningful CJK content (≥2 consecutive CJK chars) */
function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,}/.test(text);
}

/** Filter out terminal noise: status bars, prompts, plugin info, progress, etc. */
function isNoiseLine(line: string): boolean {
  if (line.length > 300) return true;                                       // extremely long lines (streaming spam)
  if (/^\s*[>$#%]\s*$/.test(line)) return true;                          // bare prompts
  if (/(?:pwsh|PowerShell)\s+at\s+\d/i.test(line)) return true;          // prompt timestamp
  if (/lintian/.test(line) && !/["\u201c\u201d]/.test(line)) return true;   // user prompt line (incl. Powerline)
  if (/PS\s+[A-Z]:\\/i.test(line)) return true;                          // PS C:\...>
  if (/(?:CLAUDE\.md|MCP|hooks)/i.test(line)) return true;                // Claude Code status bar
  if (/(?:Opus|Sonnet|Haiku)\s+\d/i.test(line)) return true;             // model info
  if (/Claude\s+(?:Code|Max)/i.test(line)) return true;                   // product name
  if (/(?:bypass\s+permissions|shift\+tab)/i.test(line)) return true;     // UI hints
  if (/(?:InlineView|Set-PSReadLineOption|ViewStyle)/i.test(line)) return true; // PS config
  if (/(?:Context|Usage)\s+\d+%/i.test(line)) return true;               // context/usage bar
  if (/(?:\d+%\s*\||\|.*[█▓░]|[█▓░]{2,})/.test(line)) return true;      // progress bars
  if (/resets?\s+in\s+\d/i.test(line)) return true;                       // rate limit info
  if (/^\s*[│├└─┌┐┘┤┬┴┼╭╮╰╯]+\s*$/.test(line)) return true;            // box drawing only
  if (/^[\s\-=_*#·•]{3,}$/.test(line)) return true;                      // decorative lines
  if (/Switched\s+to\s+.*Subscription/i.test(line)) return true;          // subscription switch
  if (/Clash\s+Proxy/i.test(line)) return true;                           // proxy info
  if (/\w+ing\s*(?:\.{2,}|…)/i.test(line)) return true;                   // streaming indicators (Simmering..., Brewing…, etc.)
  if (/\w+ing[^a-zA-Z].*\w+ing[^a-zA-Z]/i.test(line)) return true;      // repeated streaming patterns
  if (/(?:running\s+stop\s+hook|stop\s+hook)/i.test(line)) return true;   // hook execution messages
  if (/Tip:/i.test(line) && !hasCJK(line)) return true;                    // Claude Code tips (any format)
  if (/History/i.test(line) && !hasCJK(line)) return true;                 // PSReadLine history
  if (/^\s*[●○▸►▹▷◆◇]\s*(?:running|idle|waiting)/i.test(line)) return true; // status indicators
  if (/Microsoft\s+Corporation/i.test(line)) return true;                  // PS copyright
  if (/版权所有|保留所有权利|aka\.ms/i.test(line)) return true;             // PS copyright (zh-CN)
  if (/安装最新的?\s*PowerShell/i.test(line)) return true;                 // PS upgrade prompt
  if (/了解新功能和改进/i.test(line)) return true;                          // PS upgrade prompt (zh)
  if (/https?:\/\/\S+/i.test(line) && !hasCJK(line.replace(/https?:\/\/\S+/g, ''))) return true; // URL-only lines
  if (/^\s*clear\s*$/.test(line)) return true;                             // clear command
  if (/^Windows\s+PowerShell/i.test(line)) return true;                    // PS startup header
  if (/Set-PSRe/i.test(line)) return true;                                 // PSReadLine partial render
  if (/^[?\s*]+$/.test(line)) return true;                                 // garbled question marks only
  return false;
}


function extractCJKFromText(text: string, maxLen: number): string {
  // Extract all CJK segments from the entire text (ignoring line boundaries)
  const segments = extractCJKSegments(text);
  if (!segments) return '';
  // Split by whitespace (extractCJKSegments joins multiple runs with space)
  const parts = segments.split(/\s+/).filter(s => s.length >= 2);
  // Deduplicate consecutive identical segments
  const deduped = parts.filter((s, i) => i === 0 || s !== parts[i - 1]);
  const result = deduped.slice(-5).join(' ');
  return result.length > maxLen ? result.slice(-maxLen) : result;
}

function extractEnglishFromLines(lines: string[], maxLen: number): string {
  const cleanLines = lines.filter(l => !isNoiseLine(l) && l.length >= 5);
  if (cleanLines.length > 0) {
    const tail = cleanLines.slice(-3).map(l => l.slice(0, 80)).join('\n');
    return tail.length > maxLen ? tail.slice(-maxLen) : tail;
  }
  return '';
}

function extractPreview(buffer: string[], startIndex: number, maxLen = 150): string {
  // Try hook window first (prompt → stop), then fall back to full buffer
  const ranges = [
    startIndex > 0 && startIndex < buffer.length ? buffer.slice(startIndex) : null,
    buffer,
  ];

  for (const range of ranges) {
    if (!range) continue;
    const raw = range.join('');
    const clean = stripAnsi(raw);

    // Strategy 1: extract CJK directly from full text (no line splitting needed)
    const cjk = extractCJKFromText(clean, maxLen);
    if (cjk) return cjk;

    // Strategy 2: fallback to non-noise English lines
    const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const eng = extractEnglishFromLines(lines, maxLen);
    if (eng) return eng;
  }

  return '';
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private focusedSessionId: string | null = null;
  private claudeCounter = 0;
  private psCounter = 0;

  // Callbacks
  onData: (sessionId: string, data: string) => void = () => {};
  onSessionClosed: (sessionId: string) => void = () => {};

  createSession(kind: SessionKind = 'powershell'): SessionInfo {
    const id = uuid();
    const title = kind === 'claude'
      ? `Claude ${++this.claudeCounter}`
      : `PowerShell ${++this.psCounter}`;

    const sessionEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_HUB_SESSION_ID: id,
    };

    if (kind === 'claude') {
      // Set proxy and clear third-party API settings at process level
      // (equivalent to claude-pro, but without depending on profile load timing)
      sessionEnv.ANTHROPIC_BASE_URL = '';
      sessionEnv.ANTHROPIC_AUTH_TOKEN = '';
      sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = '';
      sessionEnv.HTTP_PROXY = 'http://127.0.0.1:7890';
      sessionEnv.HTTPS_PROXY = 'http://127.0.0.1:7890';
      // Ensure hook scripts can reach localhost hub without going through Clash
      sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
    }

    // Claude sessions: -NoProfile -NoLogo for fast startup, interactive mode
    // so readline absorbs ConPTY init sequences before we launch claude
    // PowerShell sessions: full interactive shell with profile
    const shell = 'powershell.exe';
    const shellArgs = kind === 'claude'
      ? ['-NoProfile', '-NoLogo']
      : [];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.env.USERPROFILE || process.env.HOME || '.',
      env: sessionEnv,
      useConpty: true,
      conptyInheritCursor: true,
    });

    const now = Date.now();
    const info: SessionInfo = {
      id,
      kind,
      title,
      status: 'idle',
      lastMessageTime: now,
      lastOutputPreview: '',
      unreadCount: 0,
      createdAt: now,
    };

    this.sessions.set(id, { info, pty: ptyProcess, outputBuffer: [], outputBufferSize: 0, promptBufferMark: 0 });

    ptyProcess.onData((data: string) => {
      // Append to ring buffer
      const session = this.sessions.get(id);
      if (session) {
        session.outputBuffer.push(data);
        session.outputBufferSize += data.length;
        // Trim oldest chunks when over limit
        while (session.outputBufferSize > OUTPUT_BUFFER_MAX && session.outputBuffer.length > 1) {
          const removed = session.outputBuffer.shift()!;
          session.outputBufferSize -= removed.length;
          // Adjust promptBufferMark when buffer entries are trimmed
          if (session.promptBufferMark > 0) session.promptBufferMark--;
        }
      }
      this.onData(id, data);
    });

    ptyProcess.onExit(() => { this.sessions.delete(id); this.onSessionClosed(id); });

    if (kind === 'powershell') {
      ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle InlineView 2>$null; clear\r\n');
    }

    if (kind === 'claude') {
      // Wait for interactive shell to absorb ConPTY init sequences, then launch claude
      // 300ms debounce is safe with -NoProfile -NoLogo (very fast startup)
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const watcher = ptyProcess.onData(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(' claude\r\n');
        }, 300);
      });
      setTimeout(() => {
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
      }, 15000);
    }

    return { ...info };
  }

  handleStopHook(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.info.lastMessageTime = Date.now();
    session.info.status = 'idle';
    // Extract preview only from the prompt→stop window
    session.info.lastOutputPreview = extractPreview(session.outputBuffer, session.promptBufferMark);

    if (sessionId !== this.focusedSessionId) {
      session.info.unreadCount++;
    }

    return { ...session.info };
  }

  handlePromptSubmitHook(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.info.status = 'running';
    // Mark current buffer position as the start of this conversation turn
    session.promptBufferMark = session.outputBuffer.length;

    return { ...session.info };
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pty.kill();
    this.sessions.delete(sessionId);
  }

  writeToSession(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data);
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.pty.resize(cols, rows);
  }

  setFocusedSession(sessionId: string): void {
    this.focusedSessionId = sessionId;
  }

  markRead(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.info.unreadCount = 0;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt);
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.pty.kill();
    this.sessions.clear();
  }
}
