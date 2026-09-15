const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

if (process.versions.electron) {
  const { app, safeStorage } = require('electron');
  const fsSync = require('node:fs');
  const [mode, root] = process.argv.slice(2);
  const main = fsSync.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  app.setPath('appData', root);
  const context = vm.createContext({ app, safeStorage, path, os, process, Buffer });
  // Execute the application's actual path setup, before Electron initializes its key.
  vm.runInContext(main.slice(main.indexOf('const APP_USER_DATA_PATH ='), main.indexOf("if (process.platform === 'win32') app.setAppUserModelId")), context);
  app.whenReady().then(async () => {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      context.readSettings = async () => JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      vm.runInContext(main.slice(main.indexOf('function normalizeGithubIntegration('), main.indexOf('async function githubRequest(')), context);
      if (mode === 'write') {
        await fs.mkdir(app.getPath('userData'), { recursive: true });
        const tokenEncrypted = vm.runInContext("encryptGithubToken('deployerx-restart-test')", context);
        await fs.writeFile(settingsPath, JSON.stringify({ githubIntegration: { tokenEncrypted, login: 'test-user' } }));
      } else {
        assert.equal(await vm.runInContext('githubToken()', context), 'deployerx-restart-test');
        const integration = JSON.parse(await fs.readFile(settingsPath, 'utf8')).githubIntegration;
        context.integration = integration;
        const connected = vm.runInContext('publicGithubIntegration(integration)', context);
        assert.equal(connected.connected, true);
        assert.equal('tokenEncrypted' in connected, false);
        assert.equal(vm.runInContext('publicGithubIntegration(null).connected', context), false);
        const broken = vm.runInContext("publicGithubIntegration({ tokenEncrypted: 'invalid', login: 'test-user' })", context);
        assert.equal(broken.connected, false);
        assert.equal(broken.needsReconnect, true);
        assert.match(broken.error, /Reconnect GitHub/);
      }
      console.log(JSON.stringify({ ok: true, mode, session: app.getPath('sessionData') }));
      app.quit(); // Flush Local State exactly as a normal application exit does.
    } catch (error) {
      console.error(error.message);
      app.exit(1);
    }
  });
} else {
  const test = require('node:test');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  test('saved GitHub credentials unlock after an Electron process restart', { skip: process.platform !== 'win32' }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-credential-restart-'));
    const run = promisify(execFile);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const mode of ['write', 'read']) {
      const { stdout } = await run(require('electron'), [__filename, mode, root], { env, windowsHide: true, timeout: 15000 });
      assert.match(stdout, /"ok":true/);
    }
    const main = await fs.readFile(path.join(__dirname, 'main.js'), 'utf8');
    assert.doesNotMatch(main, /fs\.rm\(SESSION_DATA_PATH/, 'Shutdown must retain the encryption key');
  });
}
