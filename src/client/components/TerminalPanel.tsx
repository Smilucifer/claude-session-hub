import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { SessionInfo } from '../hooks/useSessions';

interface Props {
  session: SessionInfo | null;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onClose: (sessionId: string) => void;
}

interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  sessionId: string;
  container: HTMLDivElement;  // each terminal owns its DOM node
  opened: boolean;
}

// Cache terminals — each terminal keeps its own DOM container
const terminalCache = new Map<string, CachedTerminal>();

// Buffer for terminal data that arrives before terminal is created
const pendingDataBuffer = new Map<string, string[]>();

// Use refs for callbacks to avoid stale closures
const handlerRefs = {
  onInput: (_sid: string, _data: string) => {},
  onResize: (_sid: string, _cols: number, _rows: number) => {},
};

export const TerminalPanel: React.FC<Props> = ({ session, onInput, onResize, onClose }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Keep handler refs fresh via useEffect (not in render body)
  useEffect(() => {
    handlerRefs.onInput = onInput;
    handlerRefs.onResize = onResize;
  });

  const ensureTerminal = useCallback((sessionId: string): CachedTerminal => {
    let cached = terminalCache.get(sessionId);
    if (cached) return cached;

    const terminal = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#f0f6fc',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#f0f6fc',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#ffffff',
      },
      fontSize: 16,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      windowsPty: {
        backend: 'conpty' as const,
        buildNumber: 26200,
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = '11';

    terminal.onData((data) => { handlerRefs.onInput(sessionId, data); });
    terminal.onBinary((data) => { handlerRefs.onInput(sessionId, data); });

    // Each terminal gets its own persistent DOM container
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.display = 'none';  // hidden until activated

    cached = { terminal, fitAddon, sessionId, container, opened: false };
    terminalCache.set(sessionId, cached);

    return cached;
  }, []);

  // Activate/deactivate terminals by toggling CSS display
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // Hide all terminal containers
    for (const [, cached] of terminalCache) {
      cached.container.style.display = 'none';
    }

    if (!session) return;

    const cached = ensureTerminal(session.id);

    // Append container to wrapper if not already there
    if (!wrapper.contains(cached.container)) {
      wrapper.appendChild(cached.container);
    }

    // Show this terminal
    cached.container.style.display = 'block';

    // First-time open (only once per terminal)
    if (!cached.opened) {
      cached.terminal.open(cached.container);
      cached.opened = true;

      // Load WebGL addon once
      try { cached.terminal.loadAddon(new WebglAddon()); } catch { /* canvas fallback */ }

      // Flush any buffered data that arrived before terminal was ready
      const buffered = pendingDataBuffer.get(session.id);
      if (buffered) {
        for (const chunk of buffered) {
          cached.terminal.write(chunk);
        }
        pendingDataBuffer.delete(session.id);
      }
    }

    // Fit after layout settles
    requestAnimationFrame(() => {
      cached.fitAddon.fit();
      handlerRefs.onResize(session.id, cached.terminal.cols, cached.terminal.rows);
    });

    cached.terminal.focus();

    // Resize handling
    const handleResize = () => {
      cached.fitAddon.fit();
      handlerRefs.onResize(session.id, cached.terminal.cols, cached.terminal.rows);
    };
    window.addEventListener('resize', handleResize);

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(cached.container);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
    };
  }, [session?.id, ensureTerminal]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const [, { terminal }] of terminalCache) {
        terminal.dispose();
      }
      terminalCache.clear();
      pendingDataBuffer.clear();
    };
  }, []);

  if (!session) {
    return (
      <div className="terminal-panel">
        <div className="empty-state">
          <div className="empty-state-icon">+</div>
          <div className="empty-state-text">No session selected</div>
          <div className="empty-state-hint">Click "+" to create a new PowerShell session</div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-title-section">
          <span className="terminal-title">{session.title}</span>
          <span className={`terminal-status ${session.status}`}>
            {session.status === 'running' ? '● running' : '○ idle'}
          </span>
        </div>
        <button className="btn-close-session" onClick={() => onClose(session.id)}>
          Close
        </button>
      </div>
      <div className="terminal-container" ref={wrapperRef} />
    </div>
  );
};

// Write data to terminal — buffers if terminal not yet created
export function writeToTerminal(sessionId: string, data: string): void {
  const cached = terminalCache.get(sessionId);
  if (cached) {
    cached.terminal.write(data);
  } else {
    // Buffer data for terminals not yet initialized
    let buffer = pendingDataBuffer.get(sessionId);
    if (!buffer) {
      buffer = [];
      pendingDataBuffer.set(sessionId, buffer);
    }
    buffer.push(data);
  }
}

// Remove terminal from cache when session is closed
export function disposeTerminal(sessionId: string): void {
  const cached = terminalCache.get(sessionId);
  if (cached) {
    cached.terminal.dispose();
    cached.container.remove();
    terminalCache.delete(sessionId);
  }
  pendingDataBuffer.delete(sessionId);
}

// Noise patterns for preview extraction — lines matching these are skipped
const NOISE_PATTERNS = [
  /^\s*[>❯$]\s*$/,                     // empty prompt
  /^\s*PS [A-Z]:\\/,                    // PS C:\> prompt
  /\w+@[\w-]+.*[~\/\\]/,               // user@host prompt
  /\[(Opus|Sonnet|Haiku|Claude)/,       // Claude Code status bar
  /Context\s+/,                         // Context usage line
  /Usage\s+/,                           // Usage line
  /bypass permissions|allowed tools/i,  // permissions line
  /CLAUDE\.md|hooks/,                   // config info line
  /resets in \d+[dhm]/,                 // rate limit info
  /^\s*[━─═╭╮╰╯│]{3,}/,                // box drawing / separators
  /^\s*$/,                              // empty line
  /^\s*\d+ MCPs?\s/,                    // MCP count line
  /remote-control is active/,           // remote control notice
  /Code in CLI or at https/,            // session URL line
  /Switched to .*(Subscription|Proxy|API)/i,  // proxy/subscription switch
  /Claude Code\s+v\d/,                  // version line
  /Accessing workspace/,               // workspace access
  /trust this folder|Security guide/i,  // trust prompt
  /^\s*\d+\.\s+(Yes|No)/,              // numbered choices
];

// Check if a string contains Chinese characters
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

// Extract meaningful preview text from xterm.js buffer
// Strategy: two-pass scan — first look for Chinese lines, then fallback to any meaningful line
export function extractPreviewFromBuffer(sessionId: string): string {
  const cached = terminalCache.get(sessionId);
  if (!cached) return '';

  const buf = cached.terminal.buffer.active;
  const cursorRow = buf.baseY + buf.cursorY;
  const scanStart = Math.max(0, cursorRow - 40);

  // Collect all meaningful (non-noise) lines
  const meaningfulLines: string[] = [];
  for (let i = cursorRow; i >= scanStart; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trim();
    if (text.length < 4) continue;
    if (NOISE_PATTERNS.some(p => p.test(text))) continue;
    meaningfulLines.push(text);
  }

  // Pass 1: prefer the most recent Chinese line
  const chineseLine = meaningfulLines.find(t => hasChinese(t));
  if (chineseLine) return chineseLine.substring(0, 80);

  // Pass 2: fallback to most recent meaningful line
  if (meaningfulLines.length > 0) return meaningfulLines[0].substring(0, 80);

  return '';
}
