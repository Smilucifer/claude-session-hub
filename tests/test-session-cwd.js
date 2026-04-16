const assert = require('assert');
const { SessionManager } = require('../core/session-manager.js');

const writes = [];
const sm = new SessionManager({ getDefaultCwd: () => 'D:\\ClaudeWorkspace' });

sm.sessions.set('ps', {
  info: {
    id: 'ps',
    title: 'PowerShell 1',
    kind: 'powershell',
    cwd: 'C:\\Users\\InBlu',
    unreadCount: 0,
    lastMessageTime: Date.now(),
    lastOutputPreview: '',
  },
  pty: { write: (data) => writes.push(data), resize() {}, kill() {} },
  pendingTimers: [],
  ringBuffer: '',
});

sm.sessions.set('claude', {
  info: {
    id: 'claude',
    title: 'Claude 1',
    kind: 'claude',
    cwd: 'C:\\Users\\InBlu',
    unreadCount: 0,
    lastMessageTime: Date.now(),
    lastOutputPreview: '',
  },
  pty: { write: () => { throw new Error('claude PTY should not receive cwd command'); }, resize() {}, kill() {} },
  pendingTimers: [],
  ringBuffer: '',
});

const psUpdated = sm.changeSessionCwd('ps', 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(psUpdated.cwd, 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(writes.length, 1, 'powershell session should receive exactly one cwd command');
assert.strictEqual(writes[0], "Set-Location -LiteralPath 'D:\\ClaudeWorkspace\\Code'\r\n");

const claudeUpdated = sm.changeSessionCwd('claude', 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(claudeUpdated.cwd, 'D:\\ClaudeWorkspace\\Code');
assert.strictEqual(writes.length, 1, 'claude session should not write to PTY');

let emitted = null;
sm.on('session-updated', (payload) => { emitted = payload; });
sm.changeSessionCwd('ps', 'D:\\ClaudeWorkspace\\Documents');
assert.ok(emitted, 'changeSessionCwd should emit session-updated');
assert.strictEqual(emitted.cwd, 'D:\\ClaudeWorkspace\\Documents');

const originalSpawn = require('node-pty').spawn;
const fakeWrites = [];
require('node-pty').spawn = () => ({
  write: (data) => fakeWrites.push(data),
  onData: () => ({ dispose() {} }),
  onExit: () => {},
  resize() {},
  kill() {},
});

const created = sm.createSession('powershell');
assert.strictEqual(created.cwd, 'D:\\ClaudeWorkspace', 'createSession should use injected default cwd');
assert.ok(fakeWrites[0] && fakeWrites[0].includes('Set-PSReadLineOption'), 'powershell init command should still run');

require('node-pty').spawn = originalSpawn;

console.log('OK test-session-cwd');
