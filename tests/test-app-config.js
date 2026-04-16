const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadAppConfig, getDefaultWorkingDirectory } = require('../core/app-config.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-'));
const goodDir = path.join(tempRoot, 'workspace');
fs.mkdirSync(goodDir, { recursive: true });

const goodConfigPath = path.join(tempRoot, 'session-hub.json');
fs.writeFileSync(goodConfigPath, JSON.stringify({ defaultWorkingDirectory: goodDir }, null, 2));

const loaded = loadAppConfig({ configPath: goodConfigPath, fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(loaded.defaultWorkingDirectory, goodDir, 'should use configured existing directory');

const missing = loadAppConfig({ configPath: path.join(tempRoot, 'missing.json'), fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(missing.defaultWorkingDirectory, 'C:\\fallback', 'should fall back when config file is missing');

const badConfigPath = path.join(tempRoot, 'bad.json');
fs.writeFileSync(badConfigPath, '{bad json');
const bad = loadAppConfig({ configPath: badConfigPath, fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(bad.defaultWorkingDirectory, 'C:\\fallback', 'should fall back when JSON is invalid');

const nonexistentConfigPath = path.join(tempRoot, 'nonexistent.json');
fs.writeFileSync(nonexistentConfigPath, JSON.stringify({ defaultWorkingDirectory: 'Z:\\definitely-missing' }, null, 2));
const nonexistent = getDefaultWorkingDirectory({ configPath: nonexistentConfigPath, fallbackDirectory: 'C:\\fallback' });
assert.strictEqual(nonexistent, 'C:\\fallback', 'should fall back when configured directory does not exist');

console.log('OK test-app-config');
