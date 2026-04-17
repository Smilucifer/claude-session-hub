const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainPath = path.join(__dirname, '..', 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8') + `
module.exports = {
  launchAdminPowerShell,
  escapePowerShellSingleQuoted,
  normalizeAdminLaunchCwd,
  registerCreateSessionHandler: (deps = {}) => {
    const localSessionManager = deps.sessionManager || sessionManager;
    const localSendToRenderer = deps.sendToRenderer || sendToRenderer;
    const localLaunchAdminPowerShell = deps.launchAdminPowerShell || launchAdminPowerShell;
    const localGetDefaultWorkingDirectory = deps.getDefaultWorkingDirectory || (() => appConfig.getDefaultWorkingDirectory());
    return async (_e, arg) => {
      let kind, opts;
      if (typeof arg === 'string') { kind = arg; opts = {}; }
      else if (arg && typeof arg === 'object') { kind = arg.kind; opts = arg.opts || {}; }
      else { kind = 'powershell'; opts = {}; }
      if (kind === 'powershell-admin') {
        const cwd = localGetDefaultWorkingDirectory();
        return await localLaunchAdminPowerShell({ cwd });
      }
      const session = localSessionManager.createSession(kind, opts);
      localSendToRenderer('session-created', { session });
      return session;
    };
  },
};`;

function loadMainModule() {
  const electronStub = {
    app: {
      isPackaged: false,
      whenReady: () => ({ then() {} }),
      on() {},
      quit() {},
    },
    BrowserWindow: function BrowserWindow() {
      return {
        webContents: { send() {} },
        on() {},
        maximize() {},
        show() {},
        loadFile() {},
        isDestroyed() { return false; },
        setIcon() {},
      };
    },
    ipcMain: { handle() {}, on() {} },
    clipboard: {},
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    Notification: function Notification() {},
    shell: {},
  };

  class FakeSessionManager {
    constructor() {
      this.createCalls = [];
      this.onData = () => {};
      this.onSessionClosed = () => {};
    }
    createSession(kind, opts) {
      this.createCalls.push({ kind, opts });
      return { id: 'session-1', kind, title: 'stub' };
    }
    closeSession() {}
    writeToSession() {}
    resizeSession() {}
    setFocusedSession() {}
    markRead() {}
    renameSession() { return null; }
    changeSessionCwd() { return null; }
    getAllSessions() { return []; }
    on() {}
  }

  const sandbox = {
    module: { exports: {} },
    exports: {},
    __dirname: path.dirname(mainPath),
    __filename: mainPath,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    global: {},
    require: (request) => {
      if (request === 'electron') return electronStub;
      if (request === 'qrcode') return {};
      if (request === './core/session-manager.js') return { SessionManager: FakeSessionManager };
      if (request === './core/app-config.js') return { getDefaultWorkingDirectory: () => 'D:\\ClaudeWorkspace' };
      if (request === './core/state-store.js') return { load: () => ({ cleanShutdown: true, sessions: [] }), save() {} };
      if (request === './core/mobile-server.js') return { createMobileServer: () => ({}) };
      if (request === './core/mobile-auth.js') return {};
      if (request === './core/session-archive.js') return { listRecent: async () => [], searchAcross: async () => ({ hits: [], truncated: false }) };
      return require(request);
    },
  };
  sandbox.global = sandbox;
  vm.runInNewContext(mainSource, sandbox, { filename: mainPath });
  return sandbox.module.exports;
}

function createSpawnDouble({ code = 0, stderr = '', fireError = null } = {}) {
  const calls = [];
  const spawnProcess = (file, args) => {
    calls.push({ file, args });
    const listeners = {};
    const child = {
      stderr: {
        on(event, handler) {
          if (event === 'data' && stderr) setImmediate(() => handler(Buffer.from(stderr)));
        },
      },
      on(event, handler) {
        listeners[event] = handler;
        if (event === 'error' && fireError) setImmediate(() => handler(fireError));
        if (event === 'close' && !fireError) setImmediate(() => handler(code));
        return child;
      },
    };
    return child;
  };
  return { calls, spawnProcess };
}

(async () => {
  const {
    launchAdminPowerShell,
    escapePowerShellSingleQuoted,
    normalizeAdminLaunchCwd,
    registerCreateSessionHandler,
  } = loadMainModule();

  assert.strictEqual(escapePowerShellSingleQuoted("D:\\O'Hara"), "D:\\O''Hara");
  assert.strictEqual(
    normalizeAdminLaunchCwd('Z:\\missing-path', () => false, 'C:\\Users\\InBlu'),
    'C:\\Users\\InBlu'
  );
  assert.strictEqual(
    normalizeAdminLaunchCwd('D:\\ClaudeWorkspace', (candidate) => candidate === 'D:\\ClaudeWorkspace', 'C:\\Users\\InBlu'),
    'D:\\ClaudeWorkspace'
  );

  const launchedDouble = createSpawnDouble({ code: 0 });
  const launched = await launchAdminPowerShell({ cwd: 'D:\\ClaudeWorkspace', spawnProcess: launchedDouble.spawnProcess });
  assert.strictEqual(launched.action, 'launched');
  assert.strictEqual(launchedDouble.calls.length, 1);
  assert.strictEqual(launchedDouble.calls[0].file.toLowerCase(), 'powershell.exe');
  const launchedArgs = launchedDouble.calls[0].args.join(' ');
  assert.ok(launchedArgs.includes('Start-Process'));
  assert.ok(launchedArgs.includes('-Verb RunAs'));
  assert.ok(launchedArgs.includes("Set-Location -LiteralPath 'D:\\ClaudeWorkspace'"));

  const cancelledDouble = createSpawnDouble({ code: 1, stderr: 'User cancelled' });
  const cancelled = await launchAdminPowerShell({ cwd: 'D:\\ClaudeWorkspace', spawnProcess: cancelledDouble.spawnProcess });
  assert.strictEqual(cancelled.action, 'cancelled');

  const failedDouble = createSpawnDouble({ code: 1, stderr: 'Access is denied.' });
  const failed = await launchAdminPowerShell({ cwd: 'D:\\ClaudeWorkspace', spawnProcess: failedDouble.spawnProcess });
  assert.strictEqual(failed.action, 'failed');
  assert.ok(failed.error.includes('Access is denied'));

  const handlerLaunchCalls = [];
  const fakeSessionManager = {
    createSession() {
      throw new Error('powershell-admin should not call createSession');
    },
  };
  const createSessionHandler = registerCreateSessionHandler({
    sessionManager: fakeSessionManager,
    sendToRenderer: () => { throw new Error('powershell-admin should not emit session-created'); },
    getDefaultWorkingDirectory: () => 'D:\\ClaudeWorkspace\\Code',
    launchAdminPowerShell: async ({ cwd }) => {
      handlerLaunchCalls.push(cwd);
      return { ok: true, action: 'launched' };
    },
  });
  const adminResult = await createSessionHandler({}, { kind: 'powershell-admin', opts: {} });
  assert.strictEqual(adminResult.action, 'launched');
  assert.deepStrictEqual(handlerLaunchCalls, ['D:\\ClaudeWorkspace\\Code']);

  let createdSession = null;
  let emittedPayload = null;
  const normalHandler = registerCreateSessionHandler({
    sessionManager: {
      createSession(kind, opts) {
        createdSession = { kind, opts, id: 'session-2', title: 'PowerShell 1' };
        return createdSession;
      },
    },
    sendToRenderer: (channel, payload) => { emittedPayload = { channel, payload }; },
    launchAdminPowerShell: async () => { throw new Error('normal sessions should not launch admin PowerShell'); },
  });
  const normalResult = await normalHandler({}, 'powershell');
  assert.strictEqual(normalResult.id, 'session-2');
  assert.strictEqual(createdSession.kind, 'powershell');
  assert.strictEqual(emittedPayload.channel, 'session-created');
  assert.strictEqual(emittedPayload.payload.session.id, 'session-2');

  console.log('OK test-admin-powershell');
})();
