import { mountPermissionCard } from '/views/permission-card.js';

export function renderSessionView(root, transport, sessionId, onBack) {
  const session = (transport.sessions || []).find(s => s.id === sessionId);
  const title = session ? session.title : sessionId;

  const wrap = document.createElement('div');
  wrap.className = 'mobile-session';
  wrap.innerHTML = `
    <header class="session-header">
      <button class="back-btn" aria-label="返回">←</button>
      <span class="session-title">${escapeHtml(title || '')}</span>
      <span class="conn-indicator" id="conn-ind-s">●</span>
    </header>
    <div class="terminal-host" id="term-host"></div>
    <div class="quick-bar">
      <button data-send="\x1b">ESC</button>
      <button data-send="\x03">Ctrl-C</button>
      <button data-send="1\r">1 允许</button>
      <button data-send="2\r">2 拒绝</button>
      <button data-send="\x1b[A" title="上一条历史">↑</button>
    </div>
    <div class="input-bar">
      <textarea id="prompt-input" placeholder="输入 prompt…" rows="2"></textarea>
      <button id="send-btn">发送</button>
    </div>
    <div id="perm-slot"></div>
  `;
  root.appendChild(wrap);

  const termHost = wrap.querySelector('#term-host');
  const ind = wrap.querySelector('#conn-ind-s');
  const term = new Terminal({
    cursorBlink: false,
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: window.matchMedia('(min-width: 768px)').matches ? 14 : 12,
    theme: { background: '#1a1d23', foreground: '#e6e6e6' },
    disableStdin: true,
    scrollback: 5000,
    convertEol: true,
  });
  term.open(termHost);

  // On mobile: detach xterm's touch listeners that capture events for text
  // selection, so vertical swipe scrolling works naturally.
  // The CSS touch-action: pan-y handles the browser layer; here we also
  // prevent xterm's JS-level touchstart handler from calling preventDefault.
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isMobile) {
    const viewport = termHost.querySelector('.xterm-viewport');
    const screen = termHost.querySelector('.xterm-screen');
    if (screen) {
      screen.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true, capture: true });
      screen.addEventListener('touchmove', (e) => { e.stopPropagation(); }, { passive: true, capture: true });
    }
    // Ensure viewport scrolls with touch
    if (viewport) {
      viewport.style.overflowY = 'auto';
      viewport.style.webkitOverflowScrolling = 'touch';
    }
  }

  // Fit xterm to fill the container (inline FitAddon equivalent).
  function fitTerminal() {
    try {
      const core = term._core;
      const dims = core._renderService && core._renderService.dimensions;
      if (!dims || !dims.css || !dims.css.cell) return;
      const cols = Math.max(2, Math.floor(termHost.clientWidth / dims.css.cell.width));
      const rows = Math.max(1, Math.floor(termHost.clientHeight / dims.css.cell.height));
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    } catch {}
  }
  // TUI prompt hiding is done purely via CSS (nth-last-child opacity fade).
  // No scrollLines hack — it causes visible jank on every write.
  setTimeout(fitTerminal, 50);
  setTimeout(fitTerminal, 300);
  window.addEventListener('resize', fitTerminal);

  // Connection status indicator
  function setConn(ok) {
    if (ind) { ind.style.color = ok ? '#4ae290' : '#e24a4a'; ind.title = ok ? '已连接' : '断开中'; }
  }
  setConn(transport.ws && transport.ws.readyState === 1);

  // Initial buffer fetch — starts before reconnect listener is attached, so the
  // 'connected' event (fired on WS reopen, NOT on first open) never races this.
  transport.fetchBuffer(sessionId).then(buf => { if (buf) term.write(buf); });
  transport.subscribe(sessionId);
  transport.markRead(sessionId);

  const onMsg = (e) => {
    const m = e.detail;
    if (m.type === 'output' && m.sessionId === sessionId) {
      term.write(m.data);
    } else if (m.type === 'permission-prompt' && m.sessionId === sessionId) {
      mountPermissionCard(wrap.querySelector('#perm-slot'), m, (decision) => {
        transport.sendInput(sessionId, decision === 'allow' ? '1\r' : '2\r');
      });
    }
  };
  transport.addEventListener('msg', onMsg);

  // On WS reconnect: re-fetch the ring buffer to recover output missed during
  // the disconnect. The 'connected' event fires only on reopens, not on initial
  // connect, so this never double-writes with the fetchBuffer above.
  const onReconnected = async () => {
    setConn(true);
    try {
      term.clear();
      const buf = await transport.fetchBuffer(sessionId);
      if (buf) term.write(buf);
    } catch {}
  };
  const onDisconnected = () => setConn(false);
  transport.addEventListener('connected', onReconnected);
  transport.addEventListener('disconnected', onDisconnected);

  wrap.querySelector('.back-btn').addEventListener('click', onBack);
  wrap.querySelector('#send-btn').addEventListener('click', send);
  const promptInput = wrap.querySelector('#prompt-input');
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  promptInput.addEventListener('focus', () => {
    setTimeout(() => promptInput.scrollIntoView({ block: 'end' }), 100);
  });
  wrap.querySelectorAll('.quick-bar button').forEach(b => {
    b.addEventListener('click', () => transport.sendInput(sessionId, b.dataset.send));
  });

  function send() {
    const v = promptInput.value;
    if (!v) return;
    transport.sendInput(sessionId, v + '\r');
    promptInput.value = '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return {
    destroy() {
      window.removeEventListener('resize', fitTerminal);
      transport.unsubscribe(sessionId);
      transport.removeEventListener('msg', onMsg);
      transport.removeEventListener('connected', onReconnected);
      transport.removeEventListener('disconnected', onDisconnected);
      try { term.dispose(); } catch {}
    },
  };
}
