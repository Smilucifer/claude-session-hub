import * as pty from 'node-pty';
import { v4 as uuid } from 'uuid';
import { SessionInfo } from './types.js';

const OUTPUT_BUFFER_MAX = 8192; // ~8KB ring buffer per session

interface ManagedSession {
  info: SessionInfo;
  pty: pty.IPty;
  outputBuffer: string[];
  outputBufferSize: number;
}

function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1B\[[\?>=!]?[0-9;]*[a-zA-Z]/g, '') // CSI sequences (incl. ?25h etc.)
    .replace(/\x1B\][^\x07]*\x07/g, '')            // OSC (BEL terminated)
    .replace(/\x1B\][^\x1B]*\x1B\\/g, '')          // OSC (ST terminated)
    .replace(/\x1B[()][0-9A-Za-z]/g, '')           // charset selection
    .replace(/\x1B[=>MDHNO78]/g, '')               // single-char escapes
    .replace(/\r/g, '');                            // carriage returns
}

/** Check if a string contains CJK (Chinese) characters */
function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text);
}

/** Filter out terminal noise: status bars, prompts, plugin info, progress, etc. */
function isNoiseLine(line: string): boolean {
  if (/^\s*[>$#%]\s*$/.test(line)) return true;                          // bare prompts
  if (/(?:pwsh|PowerShell)\s+at\s+\d/i.test(line)) return true;          // prompt timestamp
  if (/lintian/.test(line) && !/["\u201c\u201d]/.test(line)) return true;   // user prompt line (incl. Powerline)
  if (/PS\s+[A-Z]:\\/i.test(line)) return true;                          // PS C:\...>
  if (/(?:CLAUDE\.md|MCP|hooks\s*[▸►])/i.test(line)) return true;        // Claude Code status bar
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
  if (/^\s*(?:thinking|Quantiz|Wander)/i.test(line)) return true;         // streaming indicators
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
  return false;
}

function extractPreview(buffer: string[], maxLen = 150): string {
  const raw = buffer.join('');
  const clean = stripAnsi(raw);
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Strategy 1: prefer lines with CJK (Chinese) content, skip noise
  const cjkLines = lines.filter(l => hasCJK(l) && !isNoiseLine(l));
  if (cjkLines.length > 0) {
    const tail = cjkLines.slice(-3).join('\n');
    return tail.length > maxLen ? tail.slice(-maxLen) : tail;
  }

  // Strategy 2: fallback to non-noise lines (for occasional English responses)
  const cleanLines = lines.filter(l => !isNoiseLine(l));
  if (cleanLines.length > 0) {
    const tail = cleanLines.slice(-3).join('\n');
    return tail.length > maxLen ? tail.slice(-maxLen) : tail;
  }

  // Strategy 3: last resort, raw last lines
  const tail = lines.slice(-3).join('\n');
  return tail.length > maxLen ? tail.slice(-maxLen) : tail;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private focusedSessionId: string | null = null;
  private sessionCounter = 0;

  // Callbacks
  onData: (sessionId: string, data: string) => void = () => {};
  onSessionClosed: (sessionId: string) => void = () => {};

  createSession(): SessionInfo {
    const id = uuid();
    this.sessionCounter++;

    const ptyProcess = pty.spawn('powershell.exe', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.env.USERPROFILE || process.env.HOME || '.',
      env: { ...process.env, CLAUDE_HUB_SESSION_ID: id } as Record<string, string>,
      useConpty: true,
      conptyInheritCursor: true,
    });

    const now = Date.now();
    const info: SessionInfo = {
      id,
      title: `PowerShell ${this.sessionCounter}`,
      status: 'idle',
      lastMessageTime: now,
      lastOutputPreview: '',
      unreadCount: 0,
      createdAt: now,
    };

    this.sessions.set(id, { info, pty: ptyProcess, outputBuffer: [], outputBufferSize: 0 });

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
        }
      }
      this.onData(id, data);
    });

    ptyProcess.onExit(() => { this.sessions.delete(id); this.onSessionClosed(id); });

    ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle InlineView 2>$null; clear\r\n');
    return { ...info };
  }

  handleStopHook(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.info.lastMessageTime = Date.now();
    session.info.status = 'idle';
    session.info.lastOutputPreview = extractPreview(session.outputBuffer);

    if (sessionId !== this.focusedSessionId) {
      session.info.unreadCount++;
    }

    return { ...session.info };
  }

  handlePromptSubmitHook(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.info.status = 'running';

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
