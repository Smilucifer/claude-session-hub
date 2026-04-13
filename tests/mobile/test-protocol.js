const assert = require('assert');
const p = require('../../core/mobile-protocol.js');

// encode/decode round-trip
const msg = { type: 'output', sessionId: 's1', seq: 42, data: 'hello' };
const enc = p.encode(msg);
assert.strictEqual(typeof enc, 'string');
const dec = p.decode(enc);
assert.deepStrictEqual(dec, msg);

// validate accepts known types
assert.ok(p.validate({ type: 'input', sessionId: 'x', data: 'y' }));
assert.ok(p.validate({ type: 'subscribe', sessionId: 'x' }));
assert.ok(p.validate({ type: 'mark-read', sessionId: 'x' }));
assert.ok(p.validate({ type: 'ping' }));

// rejects unknown
assert.ok(!p.validate({ type: 'rm-rf-home' }));
// rejects wrong shape
assert.ok(!p.validate({ type: 'input' })); // missing sessionId
// rejects non-object
assert.ok(!p.validate(null));
assert.ok(!p.validate('string'));

// decode bad input returns null
assert.strictEqual(p.decode('not-json'), null);

console.log('OK test-protocol');
