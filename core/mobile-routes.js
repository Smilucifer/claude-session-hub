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
      const status = result.reason === 'token-already-bound' ? 409 : (result.reason === 'deviceid-already-registered' ? 409 : 400);
      return res.status(status).json({ error: result.reason });
    }
    res.json({ ok: true });
  });

  r.post('/hook/tool-use', express.json(), (req, res) => {
    const { sessionId, toolName, toolInput } = req.body || {};
    if (sessionId && toolName) {
      sessionManager.emit('tool-use-preview', { sessionId, toolName, toolInput });
    }
    res.json({ ok: true });
  });

  return r;
}

module.exports = { createRouter };
