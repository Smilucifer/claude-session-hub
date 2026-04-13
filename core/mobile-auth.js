const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');

const DEFAULT_STORE = path.join(os.homedir(), '.claude-session-hub', 'mobile-devices.json');
let STORE_PATH = DEFAULT_STORE;
const BCRYPT_ROUNDS = 10;
function _setStorePath(p) { STORE_PATH = p; }

function _load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[mobile-auth] devices file unreadable, starting empty:', e.message);
    }
    return { version: 1, devices: [] };
  }
}

function _save(data) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

// Tokens are validated against the device store (not an in-memory set) so
// verification survives process restarts.
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function registerDevice(token, deviceId, name, ip) {
  if (!token || !deviceId) return { ok: false, reason: 'bad-args' };
  const data = _load();
  if (data.devices.some(d => d.deviceId === deviceId)) {
    return { ok: false, reason: 'deviceid-already-registered' };
  }
  for (const d of data.devices) {
    if (await bcrypt.compare(token, d.tokenHash)) {
      return { ok: false, reason: 'token-already-bound' };
    }
  }
  const hash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  data.devices.push({
    deviceId,
    name: name || 'Unknown',
    tokenHash: hash,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    lastIp: ip || null,
  });
  _save(data);
  return { ok: true };
}

async function verifyToken(token, deviceId) {
  if (!token || !deviceId) return { ok: false };
  const data = _load();
  for (const d of data.devices) {
    if (d.deviceId !== deviceId) continue;
    if (await bcrypt.compare(token, d.tokenHash)) {
      return { ok: true, device: d };
    }
  }
  return { ok: false };
}

function touchDevice(deviceId, ip) {
  const data = _load();
  const d = data.devices.find(x => x.deviceId === deviceId);
  if (!d) return { ok: false, reason: 'not-found' };
  d.lastSeenAt = Date.now();
  if (ip) d.lastIp = ip;
  _save(data);
  return { ok: true };
}

function listDevices() {
  return _load().devices.map(({ tokenHash, ...pub }) => pub);
}

function revokeDevice(deviceId) {
  const data = _load();
  const before = data.devices.length;
  data.devices = data.devices.filter(d => d.deviceId !== deviceId);
  if (data.devices.length === before) return { ok: false, reason: 'not-found' };
  _save(data);
  return { ok: true };
}

module.exports = {
  generateToken,
  registerDevice,
  verifyToken,
  touchDevice,
  listDevices,
  revokeDevice,
  _setStorePath,
};
