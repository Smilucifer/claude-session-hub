const express = require('express');
const http = require('http');
const path = require('path');
const auth = require('./mobile-auth.js');
const { createRouter } = require('./mobile-routes.js');

const PORT_RANGE = [3470, 3471, 3472, 3473, 3474, 3475, 3476, 3477, 3478, 3479];

function pickPort(preferred) {
  return new Promise((resolve, reject) => {
    const candidates = preferred === 0 ? [0] : (preferred ? [preferred, ...PORT_RANGE] : PORT_RANGE);
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) return reject(new Error('no-port-available'));
      const p = candidates[idx++];
      const s = http.createServer();
      s.once('error', () => { s.close(() => tryNext()); });
      s.listen(p, '0.0.0.0', () => {
        const actualPort = s.address().port;
        s.close(() => resolve(actualPort));
      });
    };
    tryNext();
  });
}

async function createMobileServer({ sessionManager, preferredPort = 3470 }) {
  const port = await pickPort(preferredPort);
  const app = express();
  const pwaRoot = path.join(__dirname, '..', 'renderer-mobile');
  app.use(express.static(pwaRoot, { index: 'index.html', extensions: ['html'] }));
  app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib')));
  app.use('/vendor/xterm-css', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')));
  app.use('/api', createRouter({ sessionManager, authModule: auth }));

  const server = http.createServer(app);
  await new Promise(r => server.listen(port, '0.0.0.0', r));

  return {
    server, app, port,
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { createMobileServer };
