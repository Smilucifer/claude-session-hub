const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../../core/mobile-auth.js');

const TMP = path.join(os.tmpdir(), 'csh-mobile-auth-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
auth._setStorePath(path.join(TMP, 'devices.json'));
auth._clearPendingTokens();

(async () => {
  // 1. generateToken: 64 hex chars (32 bytes)
  const t1 = auth.generateToken();
  assert.strictEqual(t1.length, 64, 'token should be 64 hex chars');
  assert.ok(/^[0-9a-f]+$/.test(t1), 'token hex only');

  // 2. registerDevice: pending token + deviceId -> ok
  const reg1 = await auth.registerDevice(t1, 'dev-abc', 'Mate X6', '192.168.1.10');
  assert.strictEqual(reg1.ok, true);

  // 3. registerDevice: same token again (now consumed from pending) -> token-not-pending
  const reg2 = await auth.registerDevice(t1, 'dev-xyz', 'Other', '1.2.3.4');
  assert.strictEqual(reg2.ok, false);
  assert.strictEqual(reg2.reason, 'token-not-pending');

  // 3b. registerDevice with an arbitrary never-generated token -> token-not-pending
  const fakeToken = 'ab'.repeat(32); // 64 hex chars but never generated
  const reg3b = await auth.registerDevice(fakeToken, 'dev-fake', 'Hacker', '6.6.6.6');
  assert.strictEqual(reg3b.ok, false);
  assert.strictEqual(reg3b.reason, 'token-not-pending');

  // 4. verifyToken: correct token+deviceId -> ok
  const v1 = await auth.verifyToken(t1, 'dev-abc');
  assert.strictEqual(v1.ok, true);
  assert.strictEqual(v1.device.name, 'Mate X6');

  // 5. verifyToken: wrong token -> rejected
  const v2 = await auth.verifyToken('0'.repeat(64), 'dev-abc');
  assert.strictEqual(v2.ok, false);

  // 6. verifyToken: right token wrong deviceId -> rejected
  const v3 = await auth.verifyToken(t1, 'dev-abc-fake');
  assert.strictEqual(v3.ok, false);

  // 7. revokeDevice removes entry
  auth.revokeDevice('dev-abc');
  const v4 = await auth.verifyToken(t1, 'dev-abc');
  assert.strictEqual(v4.ok, false);

  // 8. listDevices: returns array without token hashes
  const t2 = auth.generateToken();
  await auth.registerDevice(t2, 'dev-2', 'Phone 2', '5.6.7.8');
  const list = auth.listDevices();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].deviceId, 'dev-2');
  assert.ok(!list[0].tokenHash, 'token hash must not leak');

  // 9. touchDevice: existing deviceId returns ok; unknown returns not-found
  const touch1 = auth.touchDevice('dev-2', '9.9.9.9');
  assert.strictEqual(touch1.ok, true);
  const touch2 = auth.touchDevice('dev-nonexistent', '0.0.0.0');
  assert.strictEqual(touch2.ok, false);
  assert.strictEqual(touch2.reason, 'not-found');

  // 10. revokeDevice: unknown deviceId returns not-found
  const rev1 = auth.revokeDevice('dev-nonexistent');
  assert.strictEqual(rev1.ok, false);
  assert.strictEqual(rev1.reason, 'not-found');
  const rev2 = auth.revokeDevice('dev-2');
  assert.strictEqual(rev2.ok, true);

  // 11. Duplicate deviceId is rejected (need a fresh pending token for each attempt)
  const t3 = auth.generateToken();
  const t4 = auth.generateToken();
  await auth.registerDevice(t3, 'dev-dup', 'First', '1.1.1.1');
  const dupReg = await auth.registerDevice(t4, 'dev-dup', 'Second', '2.2.2.2');
  assert.strictEqual(dupReg.ok, false);
  assert.strictEqual(dupReg.reason, 'deviceid-already-registered');

  // 12. Corrupt JSON file -> _load returns empty, listDevices works
  fs.writeFileSync(path.join(TMP, 'devices.json'), '{not valid json');
  const list2 = auth.listDevices();
  assert.strictEqual(list2.length, 0);

  console.log('OK test-auth');
})().catch(e => { console.error(e); process.exit(1); });
