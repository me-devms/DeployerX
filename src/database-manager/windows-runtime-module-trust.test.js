const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  enumerateWindowsProcessModules,
  inspectWindowsRuntimeModules,
  isolatedWindowsEnvironment
} = require('./windows-runtime-module-trust');

const SIGNER = 'a'.repeat(64);

function encoded(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

test('enumerates one bounded process tree through a fixed isolated PowerShell query', async () => {
  let invocation = null;
  const modules = ['C:\\Release\\DeployerX.exe', 'C:\\Windows\\System32\\kernel32.dll'];
  const result = await enumerateWindowsProcessModules(1234, {
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    environment: { SystemRoot: 'C:\\Windows', AWS_SECRET_ACCESS_KEY: 'must-not-pass' },
    execute: async (executable, args, options) => {
      invocation = { executable, args, options };
      return { stdout: JSON.stringify({ schemaVersion: 1, processCount: 3, modules: modules.map(encoded) }) };
    }
  });
  assert.equal(result.processCount, 3);
  assert.deepEqual(result.modules, modules);
  assert.equal(invocation.options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.deepEqual(Object.keys(invocation.options.env).sort(), [
    'ComSpec', 'DEPLOYERX_RUNTIME_ROOT_PROCESS_ID', 'PATH', 'SystemRoot', 'WINDIR'
  ].sort());
  assert.equal(invocation.options.env.DEPLOYERX_RUNTIME_ROOT_PROCESS_ID, '1234');
  assert.equal(invocation.args.includes('C:\\Release\\DeployerX.exe'), false);
});

test('rejects malformed, duplicate, and path-bearing-invalid module evidence', async () => {
  const execute = (report) => async () => ({ stdout: JSON.stringify(report) });
  await assert.rejects(enumerateWindowsProcessModules(1, { execute: execute({ schemaVersion: 1, processCount: 1, modules: ['not-base64'] }) }), /RUNTIME_MODULE_RESPONSE_INVALID/);
  const duplicate = encoded('C:\\Release\\DeployerX.exe');
  await assert.rejects(enumerateWindowsProcessModules(1, { execute: execute({ schemaVersion: 1, processCount: 1, modules: [duplicate, duplicate] }) }), /RUNTIME_MODULE_RESPONSE_INVALID/);
  await assert.rejects(enumerateWindowsProcessModules(0), /RUNTIME_PROCESS_INVALID/);
});

test('accepts only stable Windows or same-signer application modules', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-runtime-modules-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDirectory = path.join(root, 'application');
  const windowsDirectory = path.join(root, 'Windows');
  const applicationExecutable = path.join(applicationDirectory, 'DeployerX.exe');
  const applicationDll = path.join(applicationDirectory, 'ffmpeg.dll');
  const systemDll = path.join(windowsDirectory, 'System32', 'kernel32.dll');
  await fs.mkdir(path.dirname(systemDll), { recursive: true });
  await fs.mkdir(applicationDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(applicationExecutable, 'application'),
    fs.writeFile(applicationDll, 'library'),
    fs.writeFile(systemDll, 'system')
  ]);
  const signed = [];
  const result = await inspectWindowsRuntimeModules({
    rootProcessId: 1234,
    applicationExecutable,
    signerFingerprint: SIGNER,
    environment: { SystemRoot: windowsDirectory },
    enumerate: async () => ({ processCount: 3, modules: [applicationExecutable, applicationDll, systemDll] }),
    signatureVerifier: async (filePath) => {
      signed.push(filePath);
      return { status: 'valid', signerCertificateSha256: SIGNER, timestampPresent: true };
    }
  });
  assert.deepEqual(result, { passed: true, processCount: 3, moduleCount: 3, applicationModuleCount: 2 });
  assert.deepEqual(signed.sort(), [applicationDll, applicationExecutable].sort());
});

test('rejects modules outside trusted roots and wrong application signers', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-runtime-modules-reject-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDirectory = path.join(root, 'application');
  const windowsDirectory = path.join(root, 'Windows');
  const outsideDirectory = path.join(root, 'outside');
  const applicationExecutable = path.join(applicationDirectory, 'DeployerX.exe');
  const outsideDll = path.join(outsideDirectory, 'injected.dll');
  await Promise.all([
    fs.mkdir(applicationDirectory, { recursive: true }),
    fs.mkdir(windowsDirectory, { recursive: true }),
    fs.mkdir(outsideDirectory, { recursive: true })
  ]);
  await Promise.all([fs.writeFile(applicationExecutable, 'application'), fs.writeFile(outsideDll, 'outside')]);
  const common = { rootProcessId: 1234, applicationExecutable, signerFingerprint: SIGNER, environment: { SystemRoot: windowsDirectory } };
  await assert.rejects(inspectWindowsRuntimeModules({
    ...common,
    enumerate: async () => ({ processCount: 2, modules: [applicationExecutable, outsideDll] })
  }), /RUNTIME_MODULE_OUTSIDE_TRUSTED_ROOTS/);
  await assert.rejects(inspectWindowsRuntimeModules({
    ...common,
    enumerate: async () => ({ processCount: 1, modules: [applicationExecutable] }),
    signatureVerifier: async () => ({ status: 'valid', signerCertificateSha256: 'b'.repeat(64), timestampPresent: true })
  }), /RUNTIME_MODULE_SIGNATURE_INVALID/);
});

test('isolated environment never inherits acceptance or credential variables', async () => {
  const environment = isolatedWindowsEnvironment({ SystemRoot: 'C:\\Windows', DEPLOYERX_DB_WINDOWS_SIGNER_CERT_SHA256: SIGNER, TOKEN: 'secret' }, 99);
  assert.equal(environment.DEPLOYERX_DB_WINDOWS_SIGNER_CERT_SHA256, undefined);
  assert.equal(environment.TOKEN, undefined);
  await assert.rejects(inspectWindowsRuntimeModules({}), /RUNTIME_SIGNER_INVALID/);
});
