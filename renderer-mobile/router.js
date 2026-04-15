import { renderSessionList } from '/views/session-list.js';
import { renderSessionView } from '/views/session-view.js';

export class Router {
  constructor(root, transport) {
    this.root = root;
    this.transport = transport;
    this.currentView = null;
  }

  async start() {
    this._checkLayout();
    window.addEventListener('resize', () => this._checkLayout());
    // hashchange fires on programmatic location.hash = ... assignments.
    // popstate only fires on back/forward navigation, so we need both.
    window.addEventListener('hashchange', () => this.route());
    window.addEventListener('popstate', () => this.route());
    this.transport.addEventListener('connected', () => this.route());
    this.transport.addEventListener('fatal', (e) => {
      this.root.innerHTML = `<div style="padding:40px 20px;text-align:center;color:#e24a4a"><h2>连接失败</h2><p>${e.detail || '未知错误'}</p></div>`;
    });
    await this.transport.connect();
    this.route();
  }

  _checkLayout() {
    const wide = window.matchMedia('(min-width: 768px)').matches;
    document.body.classList.toggle('twopane', wide);
  }

  route() {
    const wide = document.body.classList.contains('twopane');
    if (wide) return this.showSplit();
    const p = location.hash || '#/';
    if (p.startsWith('#/session/')) {
      const id = decodeURIComponent(p.slice('#/session/'.length));
      this.showSession(id);
    } else {
      this.showList();
    }
  }

  showList() {
    if (this.currentView && this.currentView.destroy) this.currentView.destroy();
    this.root.innerHTML = '';
    this.currentView = renderSessionList(this.root, this.transport, (id) => {
      location.hash = '#/session/' + encodeURIComponent(id);
    });
  }

  showSession(id) {
    if (this.currentView && this.currentView.destroy) this.currentView.destroy();
    this.root.innerHTML = '';
    this.currentView = renderSessionView(this.root, this.transport, id, () => history.back());
  }

  showSplit() {
    if (this.currentView && this.currentView.destroy) this.currentView.destroy();
    this.root.innerHTML = '';
    const listPane = document.createElement('div'); listPane.className = 'pane-left';
    const sessionPane = document.createElement('div'); sessionPane.className = 'pane-right';
    this.root.appendChild(listPane);
    this.root.appendChild(sessionPane);
    let activeId = null;
    let activeView = null;
    const listView = renderSessionList(listPane, this.transport, (id) => {
      if (activeId === id) return;
      activeId = id;
      if (activeView && activeView.destroy) activeView.destroy();
      sessionPane.innerHTML = '';
      activeView = renderSessionView(sessionPane, this.transport, id, () => {
        sessionPane.innerHTML = '<div style="padding:40px;text-align:center;color:#666">← 左侧选择会话</div>';
        activeId = null;
        activeView = null;
      });
    });
    sessionPane.innerHTML = '<div style="padding:40px;text-align:center;color:#666">← 左侧选择会话</div>';
    this.currentView = { destroy() { if (listView && listView.destroy) listView.destroy(); if (activeView && activeView.destroy) activeView.destroy(); } };
  }
}
