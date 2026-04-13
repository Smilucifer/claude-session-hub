const { spawnSync } = require('child_process');
const path = require('path');
const tests = [
  'test-auth.js',
  'test-protocol.js',
  'test-rest.js',
  'test-ws.js',
  'test-ring-buffer.js',
  'test-e2e-mobile.js',
];
let failed = 0;
for (const t of tests) {
  console.log('--- ' + t);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(t + ' FAILED'); }
}
if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
console.log('ALL PASS');
