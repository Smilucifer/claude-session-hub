import { Router } from '/router.js';
import { Transport } from '/transport.js';

const KEY_TOKEN = 'csh.token';
const KEY_DEVICE = 'csh.deviceId';
const KEY_ADDRS = 'csh.addresses';

function getDeviceId() {
  let d = localStorage.getItem(KEY_DEVICE);
  if (!d) {
    d = 'dev-' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random()));
    localStorage.setItem(KEY_DEVICE, d);
  }
  return d;
}

function getState() {
  return {
    token: localStorage.getItem(KEY_TOKEN),
    deviceId: getDeviceId(),
    addresses: JSON.parse(localStorage.getItem(KEY_ADDRS) || '[]'),
  };
}

async function boot() {
  const state = getState();
  if (!state.token || !state.addresses.length) {
    document.getElementById('app').innerHTML = `
      <div style="padding:40px 20px;text-align:center">
        <h2>未配对</h2>
        <p>请在电脑端 Hub 点"📱"按钮生成二维码并扫码</p>
      </div>`;
    return;
  }
  window.__transport = new Transport(state);
  window.__router = new Router(document.getElementById('app'), window.__transport);
  window.__router.start();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.__transport) {
      const ws = window.__transport.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        window.__transport.reconnectDelay = 300;
        if (ws) try { ws.close(); } catch {}
        window.__transport.connect();
      }
    }
  });
}

if (location.pathname === '/' || location.pathname.endsWith('/index.html')) {
  boot();
}
