const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PACKAGED_SMOKE_ARGUMENT,
  PACKAGED_SMOKE_RELEASE_ARGUMENT,
  parsePackagedSmokeReport,
  runPackagedApplicationSmoke
} = require('./packaged-ui-smoke');

const CHECK_NAMES = [
  'renderer-loaded',
  'window-policy',
  'preload-bridge',
  'database-route',
  'database-tabs',
  'database-add-control',
  'renderer-node-require',
  'renderer-node-buffer',
  'renderer-process-isolation',
  'renderer-ipc-isolation'
];

function passingReport() {
  return {
    schemaVersion: 1,
    passed: true,
    checks: CHECK_NAMES.map((name) => ({ name, status: 'passed' }))
  };
}

test('launches a packaged smoke check with isolated state and a minimal environment', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-smoke-runner-test-'));
  let invocation = null;
  try {
    const accepted = await runPackagedApplicationSmoke('C:\\release\\DeployerX.exe', {
      temporaryRoot,
      environment: {
        SystemRoot: 'C:\\Windows',
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
        LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
        APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\fixture',
        AWS_SECRET_ACCESS_KEY: 'must-not-pass'
      },
      execute: async (executable, args, options) => {
        invocation = {
          executable,
          args,
          options,
          profilePath: args.find((argument) => argument.startsWith('--user-data-dir=')).slice('--user-data-dir='.length),
          releasePath: args.find((argument) => argument.startsWith(PACKAGED_SMOKE_RELEASE_ARGUMENT)).slice(PACKAGED_SMOKE_RELEASE_ARGUMENT.length)
        };
        return { stdout: `startup output\n${JSON.stringify(passingReport())}\n` };
      }
    });
    assert.equal(accepted, true);
    assert.equal(invocation.executable, 'C:\\release\\DeployerX.exe');
    assert.equal(invocation.args[0], PACKAGED_SMOKE_ARGUMENT);
    assert.ok(invocation.args.some((argument) => argument.startsWith('--user-data-dir=')));
    assert.equal(path.dirname(invocation.releasePath), invocation.profilePath);
    assert.equal(invocation.options.windowsHide, true);
    assert.equal(invocation.options.timeout, 45000);
    assert.equal(invocation.options.maxBuffer, 1024 * 1024);
    assert.equal(invocation.options.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.deepEqual(Object.keys(invocation.options.env).sort(), [
      'APPDATA', 'ComSpec', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'
    ].sort());
    await assert.rejects(fs.access(path.dirname(invocation.profilePath)));
    await assert.rejects(fs.access(invocation.releasePath));
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects malformed, failed, reordered, and oversized smoke reports', async () => {
  assert.equal(parsePackagedSmokeReport('{'), null);
  assert.equal(parsePackagedSmokeReport(JSON.stringify({ ...passingReport(), passed: false })), null);
  const reordered = passingReport();
  reordered.checks.reverse();
  assert.equal(parsePackagedSmokeReport(JSON.stringify(reordered)), null);
  assert.equal(parsePackagedSmokeReport('x'.repeat((1024 * 1024) + 1)), null);
});

test('runs the real source application through the packaged smoke startup path', { timeout: 45000 }, async (context) => {
  const root = path.join(__dirname, '..', '..');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-source-smoke-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const accepted = await runPackagedApplicationSmoke(require('electron'), {
    temporaryRoot,
    applicationArguments: [root]
  });
  assert.equal(accepted, true);
});
