export class Transport extends EventTarget {
  constructor({ token, deviceId, addresses }) {
    super();
    this.token = token;
    this.deviceId = deviceId;
    this.addresses = addresses;
    this.baseUrl = null;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.shouldReconnect = true;
    this.subscriptions = new Set();
    this.lastSeq = null;
    this.sessions = [];
  }

  async connect() {
    const probed = await this._probeAddresses();
    if (!probed) {
      this.dispatchEvent(new CustomEvent('fatal', { detail: '所有已知地址均不可达' }));
      return;
    }
    this.baseUrl = probed;
    this._openWs();
  }

  async _probeAddresses() {
    const probes = this.addresses.map(a => this._ping(a));
    const results = await Promise.allSettled(probes);
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled' && results[i].value) {
        return this._toBase(this.addresses[i]);
      }
    }
    return null;
  }

  _toBase(addr) {
    if (addr.startsWith('http://') || addr.startsWith('https://')) return addr.replace(/\/$/, '');
    return 'http://' + addr;
  }

  async _ping(addr) {
    try {
      const url = this._toBase(addr) + `/api/ping?token=${encodeURIComponent(this.token)}&deviceId=${encodeURIComponent(this.deviceId)}`;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 500);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      return resp.ok;
    } catch { return false; }
  }

  _openWs() {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws')
      + `/ws?token=${encodeURIComponent(this.token)}&deviceId=${encodeURIComponent(this.deviceId)}`
      + (this.lastSeq != null ? `&lastSeq=${this.lastSeq}` : '');
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      this.dispatchEvent(new Event('connected'));
      for (const sid of this.subscriptions) this.send({ type: 'subscribe', sessionId: sid });
    });
    this.ws.addEventListener('message', (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'session-list') this.sessions = msg.sessions;
      if (msg.type === 'session-updated') {
        const idx = this.sessions.findIndex(s => s.id === msg.session.id);
        if (idx >= 0) this.sessions[idx] = msg.session; else this.sessions.push(msg.session);
      }
      if (msg.type === 'output' && typeof msg.seq === 'number') this.lastSeq = msg.seq;
      this.dispatchEvent(new CustomEvent('msg', { detail: msg }));
    });
    this.ws.addEventListener('close', async () => {
      this.dispatchEvent(new Event('disconnected'));
      if (!this.shouldReconnect) return;
      let delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      // After a few failed retries on the same address (backoff >= 8s means ~3
      // consecutive failures), re-probe all configured addresses. This handles
      // Wi-Fi → cellular switchover or any route change that makes the chosen
      // address permanently unreachable.
      if (delay >= 8000) {
        try {
          const alt = await this._probeAddresses();
          if (alt && alt !== this.baseUrl) {
            this.baseUrl = alt;
            this.reconnectDelay = 1000; // reset backoff on new route
            delay = 300;
          }
        } catch {}
      }
      setTimeout(() => this._openWs(), delay);
    });
    this.ws.addEventListener('error', () => { /* close will fire */ });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  subscribe(sessionId) { this.subscriptions.add(sessionId); this.send({ type: 'subscribe', sessionId }); }
  unsubscribe(sessionId) { this.subscriptions.delete(sessionId); this.send({ type: 'unsubscribe', sessionId }); }
  sendInput(sessionId, data) { this.send({ type: 'input', sessionId, data }); }
  markRead(sessionId) { this.send({ type: 'mark-read', sessionId }); }

  async fetchBuffer(sessionId) {
    const url = this.baseUrl + `/api/sessions/${encodeURIComponent(sessionId)}/buffer?token=${encodeURIComponent(this.token)}&deviceId=${encodeURIComponent(this.deviceId)}`;
    const r = await fetch(url);
    if (!r.ok) return '';
    return r.text();
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) try { this.ws.close(); } catch {}
  }
}
