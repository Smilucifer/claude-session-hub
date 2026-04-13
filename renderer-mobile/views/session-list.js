export function renderSessionList(root, transport, onEnter) {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-list';
  wrap.innerHTML = `
    <header class="list-header">
      <h1>Claude 会话</h1>
      <span class="conn-indicator" id="conn-ind">●</span>
    </header>
    <ul id="session-items" class="list-items"></ul>
    <div class="empty-hint" id="empty-hint">(空) 在电脑端 Hub 新建会话</div>
  `;
  root.appendChild(wrap);

  const items = wrap.querySelector('#session-items');
  const emptyHint = wrap.querySelector('#empty-hint');
  const ind = wrap.querySelector('#conn-ind');

  function setConn(ok) {
    ind.style.color = ok ? '#4ae290' : '#e24a4a';
    ind.title = ok ? '已连接' : '断开中';
  }

  function render() {
    const list = transport.sessions || [];
    items.innerHTML = '';
    emptyHint.style.display = list.length ? 'none' : 'block';
    const sorted = [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    for (const s of sorted) {
      const li = document.createElement('li');
      li.className = 'session-item';
      li.innerHTML = `
        <div class="row1">
          <span class="title">${escapeHtml(s.title || '(untitled)')}</span>
          <span class="time">${s.lastMessageTime ? formatTime(s.lastMessageTime) : ''}</span>
        </div>
        <div class="row2">
          <span class="preview">${escapeHtml(s.lastOutputPreview || '')}</span>
          ${s.unreadCount ? `<span class="badge">${s.unreadCount}</span>` : ''}
        </div>
      `;
      li.addEventListener('click', () => onEnter(s.id));
      items.appendChild(li);
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const onMsg = () => render();
  const onConn = () => setConn(true);
  const onDisc = () => setConn(false);
  transport.addEventListener('msg', onMsg);
  transport.addEventListener('connected', onConn);
  transport.addEventListener('disconnected', onDisc);

  render();
  setConn(transport.ws && transport.ws.readyState === 1);

  return {
    destroy() {
      transport.removeEventListener('msg', onMsg);
      transport.removeEventListener('connected', onConn);
      transport.removeEventListener('disconnected', onDisc);
    },
  };
}
