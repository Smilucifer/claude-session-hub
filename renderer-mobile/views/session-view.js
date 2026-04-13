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
    try {
      term.clear();
      const buf = await transport.fetchBuffer(sessionId);
      if (buf) term.write(buf);
    } catch {}
  };
  transport.addEventListener('connected', onReconnected);

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
      transport.unsubscribe(sessionId);
      transport.removeEventListener('msg', onMsg);
      transport.removeEventListener('connected', onReconnected);
      try { term.dispose(); } catch {}
    },
  };
}
