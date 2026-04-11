import React, { useEffect, useRef, useState } from 'react';
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
  onRename: (sessionId: string, title: string) => void;
}

interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  sessionId: string;
  container: HTMLDivElement;
  opened: boolean;
}

const terminalCache = new Map<string, CachedTerminal>();
const pendingDataBuffer = new Map<string, string[]>();
const PENDING_BUFFER_MAX = 100; // max chunks per session before opened

// Handler refs to avoid stale closures
const handlerRefs = {
  onInput: (_sid: string, _data: string) => {},
  onResize: (_sid: string, _cols: number, _rows: number) => {},
};

export const TerminalPanel: React.FC<Props> = ({ session, onInput, onResize, onClose, onRename }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  useEffect(() => {
    handlerRefs.onInput = onInput;
    handlerRefs.onResize = onResize;
  });

  // Mount/switch terminals
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // Hide all terminals
    for (const [, cached] of terminalCache) {
      cached.container.style.display = 'none';
    }

    if (!session) return;

    let cached = terminalCache.get(session.id);
    if (!cached) {
      const terminal = new Terminal({
        theme: {
          background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
          cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
          black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
          blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
          brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
          brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
          brightCyan: '#56d364', brightWhite: '#ffffff',
        },
        fontSize: 16,
        fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
        windowsPty: { backend: 'conpty' as const, buildNumber: 26200 },
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = '11';

      const sessionId = session.id;

      terminal.onData((data) => { handlerRefs.onInput(sessionId, data); });
      terminal.onBinary((data) => { handlerRefs.onInput(sessionId, data); });

      const container = document.createElement('div');
      container.style.width = '100%';
      container.style.height = '100%';
      container.style.display = 'none';

      cached = { terminal, fitAddon, sessionId, container, opened: false };
      terminalCache.set(sessionId, cached);
    }

    if (!wrapper.contains(cached.container)) {
      wrapper.appendChild(cached.container);
    }
    cached.container.style.display = 'block';

    if (!cached.opened) {
      cached.terminal.open(cached.container);
      cached.opened = true;
      try {
        const webgl = new WebglAddon();
        // On WebGL context loss, dispose addon and let xterm fall back to canvas
        webgl.onContextLoss(() => { webgl.dispose(); });
        cached.terminal.loadAddon(webgl);
      } catch {}

      // Flush buffered data
      const buffered = pendingDataBuffer.get(session.id);
      if (buffered) {
        for (const chunk of buffered) cached.terminal.write(chunk);
        pendingDataBuffer.delete(session.id);
      }
    }

    const rafId = requestAnimationFrame(() => {
      if (cached) {
        cached.fitAddon.fit();
        handlerRefs.onResize(session.id, cached.terminal.cols, cached.terminal.rows);
      }
    });
    cached.terminal.focus();

    // Resize handling
    const handleResize = () => {
      if (cached) {
        cached.fitAddon.fit();
        handlerRefs.onResize(session.id, cached.terminal.cols, cached.terminal.rows);
      }
    };
    window.addEventListener('resize', handleResize);
    const ro = new ResizeObserver(handleResize);
    ro.observe(cached.container);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      ro.disconnect();
    };
  }, [session?.id]);

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
          <div className="empty-state-hint">Click "+" to create a new session</div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-title-section">
          {editingTitle ? (
            <input
              className="terminal-title-input"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={() => {
                const trimmed = titleDraft.trim();
                if (trimmed && trimmed !== session.title) onRename(session.id, trimmed);
                setEditingTitle(false);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              autoFocus
            />
          ) : (
            <span
              className="terminal-title"
              onClick={() => { setTitleDraft(session.title); setEditingTitle(true); }}
              title="Click to rename"
            >
              {session.title}
            </span>
          )}
          <span className={`terminal-status ${session.status}`}>
            {session.status === 'running' ? '● running' : '○ idle'}
          </span>
        </div>
        <button className="btn-close-session" onClick={() => onClose(session.id)}>Close</button>
      </div>
      <div className="terminal-container" ref={wrapperRef} />
    </div>
  );
};

export function writeToTerminal(sessionId: string, data: string): void {
  const cached = terminalCache.get(sessionId);
  if (cached) {
    cached.terminal.write(data);
  } else {
    let buffer = pendingDataBuffer.get(sessionId);
    if (!buffer) { buffer = []; pendingDataBuffer.set(sessionId, buffer); }
    buffer.push(data);
    // Prevent unbounded memory growth for unopened sessions
    while (buffer.length > PENDING_BUFFER_MAX) buffer.shift();
  }
}

export function disposeTerminal(sessionId: string): void {
  const cached = terminalCache.get(sessionId);
  if (cached) {
    cached.terminal.dispose();
    cached.container.remove();
    terminalCache.delete(sessionId);
  }
  pendingDataBuffer.delete(sessionId);
}
