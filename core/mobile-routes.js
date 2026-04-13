const express = require('express');

function createRouter({ sessionManager, authModule }) {
  const r = express.Router();

  async function guard(req, res, next) {
    const token = req.query.token || req.headers['x-mobile-token'];
    const deviceId = req.query.deviceId || req.headers['x-mobile-device-id'];
    if (!token || !deviceId) return res.status(401).json({ error: 'missing-auth' });
    const v = await authModule.verifyToken(token, deviceId);
    if (!v.ok) return res.status(401).json({ error: 'bad-auth' });
    authModule.touchDevice(deviceId, req.ip);
    req.device = v.device;
    next();
  }

  r.get('/ping', guard, (_req, res) => {
    res.json({ ok: true, serverTime: Date.now() });
  });

  r.get('/sessions', guard, (_req, res) => {
    res.json({ sessions: sessionManager.listSessions() });
  });

  r.get('/sessions/:id/buffer', guard, (req, res) => {
    const buf = sessionManager.getSessionBuffer(req.params.id);
    if (buf == null) return res.status(404).json({ error: 'no-session' });
    res.type('text/plain').send(buf);
  });

  r.post('/devices/register', express.json(), async (req, res) => {
    const { token, deviceId, name } = req.body || {};
    if (!token || !deviceId) return res.status(400).json({ error: 'missing-fields' });
    const result = await authModule.registerDevice(token, deviceId, name, req.ip);
    if (!result.ok) {
      // All registration errors are client errors (400); 409 is gone because
      // token-already-bound no longer exists (pending predicate replaces it).
      return res.status(400).json({ error: result.reason });
    }
    res.json({ ok: true });
  });

  r.post('/hook/tool-use', express.json(), (req, res) => {
    const addr = req.socket.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      return res.status(403).json({ error: 'loopback-only' });
    }
    const { sessionId, toolName, toolInput } = req.body || {};
    if (sessionId && toolName && typeof sessionManager.emit === 'function') {
      sessionManager.emit('tool-use-preview', { sessionId, toolName, toolInput });
    }
    res.json({ ok: true });
  });

  return r;
}

module.exports = { createRouter };
