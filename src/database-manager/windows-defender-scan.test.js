const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  comparePlatformVersions,
  isolatedDefenderEnvironment,
  resolveMicrosoftDefenderScanner,
  runMicrosoftDefenderScan
} = require('./windows-defender-scan');

const VALID_SIGNATURE = Object.freeze({
  status: 'valid',
  signerCertificateSha256: 'a'.repeat(64),
  timestampPresent: true
});

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-defender-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const programData = path.join(root, 'ProgramData');
  const programFiles = path.join(root, 'Program Files');
  const targetPath = path.join(root, 'release', 'DeployerX');
  await fs.mkdir(targetPath, { recursive: true });
  return { root, programData, programFiles, targetPath, environment: { SystemRoot: 'C:\\Windows', ProgramData: programData, ProgramFiles: programFiles } };
}

test('resolves the newest bounded platform scanner and falls back to the legacy protected root', async (context) => {
  const values = await fixture(context);
  const platformRoot = path.join(values.programData, 'Microsoft', 'Windows Defender', 'Platform');
  const oldScanner = path.join(platformRoot, '4.18.26050.15-0', 'MpCmdRun.exe');
  const newScanner = path.join(platformRoot, '4.18.26060.3008-0', 'MpCmdRun.exe');
  await Promise.all([fs.mkdir(path.dirname(oldScanner), { recursive: true }), fs.mkdir(path.dirname(newScanner), { recursive: true })]);
  await Promise.all([fs.writeFile(oldScanner, 'old'), fs.writeFile(newScanner, 'new')]);
  const roots = { environment: values.environment, programDataPath: values.programData, programFilesPath: values.programFiles };
  assert.equal(await resolveMicrosoftDefenderScanner(roots), await fs.realpath(newScanner));
  assert.ok(comparePlatformVersions('4.18.26060.3008-0', '4.18.26050.15-0') > 0);

  await fs.rm(platformRoot, { recursive: true, force: true });
  const legacyScanner = path.join(values.programFiles, 'Windows Defender', 'MpCmdRun.exe');
  await fs.mkdir(path.dirname(legacyScanner), { recursive: true });
  await fs.writeFile(legacyScanner, 'legacy');
  assert.equal(await resolveMicrosoftDefenderScanner(roots), await fs.realpath(legacyScanner));
});

test('runs one non-remediating directory scan with isolated bounded process options', async (context) => {
  const values = await fixture(context);
  const scannerPath = path.join(values.root, 'scanner', 'MpCmdRun.exe');
  await fs.mkdir(path.dirname(scannerPath), { recursive: true });
  await fs.writeFile(scannerPath, 'signed-scanner');
  let invocation = null;
  const accepted = await runMicrosoftDefenderScan(values.targetPath, {
    environment: { ...values.environment, AWS_SECRET_ACCESS_KEY: 'must-not-pass' },
    scannerResolver: async () => scannerPath,
    signatureVerifier: async () => VALID_SIGNATURE,
    execute: async (executable, args, options) => { invocation = { executable, args, options }; return { stdout: 'scan complete' }; }
  });
  assert.equal(accepted, true);
  assert.equal(invocation.executable, scannerPath);
  assert.deepEqual(invocation.args.slice(0, 3), ['-Scan', '-ScanType', '3']);
  assert.equal(invocation.args.at(-1), '-DisableRemediation');
  assert.equal(invocation.options.timeout, 180000);
  assert.equal(invocation.options.maxBuffer, 1024 * 1024);
  assert.equal(invocation.options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.deepEqual(Object.keys(invocation.options.env).sort(), ['ComSpec', 'PATH', 'ProgramData', 'ProgramFiles', 'SystemRoot', 'WINDIR'].sort());
});

test('fails closed for unavailable or untrusted scanners and scan failures', async (context) => {
  const values = await fixture(context);
  await assert.rejects(resolveMicrosoftDefenderScanner({
    environment: values.environment,
    programDataPath: values.programData,
    programFilesPath: values.programFiles
  }), /DEFENDER_UNAVAILABLE/);
  const scannerPath = path.join(values.root, 'scanner', 'MpCmdRun.exe');
  await fs.mkdir(path.dirname(scannerPath), { recursive: true });
  await fs.writeFile(scannerPath, 'scanner');
  const options = { environment: values.environment, scannerResolver: async () => scannerPath };
  await assert.rejects(runMicrosoftDefenderScan(values.targetPath, {
    ...options,
    signatureVerifier: async () => ({ ...VALID_SIGNATURE, timestampPresent: false })
  }), /DEFENDER_SCANNER_UNTRUSTED/);
  await assert.rejects(runMicrosoftDefenderScan(values.targetPath, {
    ...options,
    signatureVerifier: async () => VALID_SIGNATURE,
    execute: async () => { throw new Error(`Threat at ${values.targetPath}`); }
  }), /DEFENDER_SCAN_FAILED/);
  await assert.rejects(runMicrosoftDefenderScan(path.parse(values.targetPath).root, options), /DEFENDER_TARGET_INVALID/);
});

test('isolated scan environment excludes credentials and acceptance configuration', () => {
  const environment = isolatedDefenderEnvironment({
    SystemRoot: 'C:\\Windows',
    ProgramData: 'C:\\ProgramData',
    ProgramFiles: 'C:\\Program Files',
    DEPLOYERX_DB_WINDOWS_ARTIFACTS_JSON: 'secret',
    TOKEN: 'secret'
  });
  assert.equal(environment.DEPLOYERX_DB_WINDOWS_ARTIFACTS_JSON, undefined);
  assert.equal(environment.TOKEN, undefined);
});
