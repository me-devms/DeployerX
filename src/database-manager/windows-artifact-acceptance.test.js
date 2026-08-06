const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const {
  WINDOWS_ARTIFACTS_ENV,
  WINDOWS_SIGNER_ENV,
  configuredSignerFingerprint,
  configuredWindowsArtifacts,
  runWindowsArtifactAcceptance
} = require('./windows-artifact-acceptance');

const execFileAsync = promisify(execFile);
const SIGNER_FINGERPRINT = 'a'.repeat(64);

function trustOptions({ signerFingerprint = SIGNER_FINGERPRINT, dependencies = ['kernel32.dll'] } = {}) {
  return {
    signatureVerifier: async () => ({ status: 'valid', signerCertificateSha256: signerFingerprint, timestampPresent: true }),
    dependencyInspector: async () => dependencies,
    applicationSmokeRunner: async () => true,
    malwareScanner: async () => true
  };
}

function peFixture() {
  const content = Buffer.alloc(512);
  const peOffset = 0x80;
  content.write('MZ', 0, 'ascii');
  content.writeUInt32LE(peOffset, 0x3c);
  content.write('PE\0\0', peOffset, 'ascii');
  content.writeUInt16LE(0x8664, peOffset + 4);
  content.writeUInt16LE(1, peOffset + 6);
  content.writeUInt16LE(112, peOffset + 20);
  content.writeUInt16LE(0x0002, peOffset + 22);
  content.writeUInt16LE(0x20b, peOffset + 24);
  return content;
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-windows-artifacts-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuration = {};
  const archives = new Map();
  const archivePaths = {};
  for (const kind of ['installed', 'portable']) {
    const layoutRoot = path.join(root, kind);
    const resourcesPath = path.join(layoutRoot, 'resources');
    const applicationExecutable = path.join(layoutRoot, 'DeployerX.exe');
    const hostPath = path.join(resourcesPath, 'database-manager', 'win32-x64', 'deployerx-db-host.exe');
    const archivePath = path.join(resourcesPath, 'app.asar');
    await fs.mkdir(path.dirname(hostPath), { recursive: true });
    await fs.writeFile(applicationExecutable, peFixture());
    await fs.writeFile(hostPath, peFixture());
    await fs.writeFile(archivePath, Buffer.alloc(128, 1));
    const licenseContent = Buffer.from(`${kind} MIT license fixture`);
    const licenseDigest = crypto.createHash('sha256').update(licenseContent).digest('hex').slice(0, 12);
    const licensePath = `third_party_licenses/database-manager-rust/example-1.0.0-1-${licenseDigest}.txt`;
    const inventory = {
      schemaVersion: 1,
      generatedFrom: 'native/deployerx-db-host/Cargo.lock',
      packageCount: 1,
      packages: [{ name: 'example', version: '1.0.0', license: 'MIT', licenseFiles: [licensePath] }]
    };
    const inventorySource = JSON.stringify(inventory);
    const review = {
      schemaVersion: 1,
      decision: 'approved',
      reviewer: 'Windows artifact fixture',
      reviewedAt: '2026-08-06T00:00:00.000Z',
      lockPath: 'native/deployerx-db-host/Cargo.lock',
      lockSha256: 'a'.repeat(64),
      inventoryPath: 'third_party_licenses/database-manager-rust.json',
      inventorySha256: crypto.createHash('sha256').update(inventorySource).digest('hex'),
      packageCount: 1,
      acceptedLicenseExpressions: ['MIT']
    };
    archives.set(archivePath, new Map([
      ['THIRD_PARTY_NOTICES.md', Buffer.from('## Database Manager Rust Dependencies\nthird_party_licenses/database-manager-rust.json\nthird_party_licenses/database-manager-rust-review.json')],
      ['third_party_licenses/database-manager-rust.json', Buffer.from(inventorySource)],
      ['third_party_licenses/database-manager-rust-review.json', Buffer.from(JSON.stringify(review))],
      [licensePath, licenseContent]
    ]));
    archivePaths[kind] = archivePath;
    configuration[kind] = { applicationExecutable, resourcesPath };
  }
  const archiveReader = {
    async readFile(archivePath, entryPath) {
      const entries = archives.get(archivePath);
      if (!entries?.has(entryPath)) throw new Error(`Missing archive entry at C:\\secret\\artifact: ${entryPath}`);
      return Buffer.from(entries.get(entryPath));
    }
  };
  return {
    root,
    configuration,
    environment: {
      [WINDOWS_ARTIFACTS_ENV]: JSON.stringify(configuration),
      [WINDOWS_SIGNER_ENV]: SIGNER_FINGERPRINT
    },
    archives,
    archivePaths,
    archiveReader
  };
}

class FakeRuntime {
  constructor(calls, kind, failure = null) { this.calls = calls; this.kind = kind; this.failure = failure; }
  async health() {
    this.calls.push(`${this.kind}:health`);
    if (this.failure === 'health') throw Object.assign(new Error('C:\\secret\\artifact and token=hunter2'), { code: 'DATABASE_MANAGER_DRIVER_HOST_EXITED' });
    return { status: 'ready', protocolVersion: 1 };
  }
  async stop() { this.calls.push(`${this.kind}:stop`); }
}

test('accepts distinct installed and portable PE layouts through the packaged host path', async (context) => {
  const values = await fixture(context);
  const calls = [];
  const executablePaths = [];
  const smokeSignerFingerprints = [];
  const scannedPaths = [];
  const report = await runWindowsArtifactAcceptance({
    environment: values.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: values.archiveReader,
    ...trustOptions(),
    applicationSmokeRunner: async ({ signerFingerprint }) => {
      smokeSignerFingerprints.push(signerFingerprint);
      return true;
    },
    malwareScanner: async ({ targetPath }) => { scannedPaths.push(targetPath); return true; },
    runtimeFactory: ({ executablePath, kind }) => {
      executablePaths.push(executablePath);
      return new FakeRuntime(calls, kind);
    }
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { total: 2, passed: 2, failed: 0 });
  assert.deepEqual(calls, ['installed:health', 'installed:stop', 'portable:health', 'portable:stop']);
  assert.ok(executablePaths.every((value) => value.endsWith(path.join('database-manager', 'win32-x64', 'deployerx-db-host.exe'))));
  assert.deepEqual(smokeSignerFingerprints, [SIGNER_FINGERPRINT, SIGNER_FINGERPRINT]);
  assert.deepEqual(scannedPaths, [
    path.dirname(values.configuration.installed.applicationExecutable),
    path.dirname(values.configuration.portable.applicationExecutable)
  ]);
  assert.deepEqual(report.layouts[0].checks.slice(1, 7).map((check) => check.name), [
    'application-authenticode',
    'application-dependencies',
    'application-bundled-dependencies',
    'application-binary-stable',
    'resources-directory',
    'application-asar-contained'
  ]);
  assert.ok(report.layouts[0].checks.some((check) => check.name === 'sidecar-authenticode' && check.status === 'passed'));
  assert.ok(report.layouts[0].checks.some((check) => check.name === 'sidecar-dependencies' && check.status === 'passed'));
  assert.ok(report.layouts[0].checks.some((check) => check.name === 'application-ui-smoke' && check.status === 'passed'));
  assert.ok(report.layouts[0].checks.some((check) => check.name === 'windows-defender-scan' && check.status === 'passed'));
  assert.equal(JSON.stringify(report).includes(values.root), false);
});

test('rejects missing, malformed, oversized, relative, extra, and duplicate layout configuration', async (context) => {
  const values = await fixture(context);
  assert.throws(() => configuredWindowsArtifacts({}), /WINDOWS_ARTIFACT_CONFIGURATION_MISSING/);
  assert.throws(() => configuredWindowsArtifacts({ [WINDOWS_ARTIFACTS_ENV]: '{' }), /WINDOWS_ARTIFACT_CONFIGURATION_JSON_INVALID/);
  assert.throws(() => configuredWindowsArtifacts({ [WINDOWS_ARTIFACTS_ENV]: 'x'.repeat(65537) }), /WINDOWS_ARTIFACT_CONFIGURATION_TOO_LARGE/);
  const relative = structuredClone(values.configuration);
  relative.installed.resourcesPath = 'relative';
  assert.throws(() => configuredWindowsArtifacts({ [WINDOWS_ARTIFACTS_ENV]: JSON.stringify(relative) }), /WINDOWS_ARTIFACT_CONFIGURATION_INVALID/);
  const extra = { ...values.configuration, unexpected: {} };
  assert.throws(() => configuredWindowsArtifacts({ [WINDOWS_ARTIFACTS_ENV]: JSON.stringify(extra) }), /WINDOWS_ARTIFACT_CONFIGURATION_INVALID/);
  const duplicate = structuredClone(values.configuration);
  duplicate.portable.resourcesPath = duplicate.installed.resourcesPath;
  assert.throws(() => configuredWindowsArtifacts({ [WINDOWS_ARTIFACTS_ENV]: JSON.stringify(duplicate) }), /WINDOWS_ARTIFACT_LAYOUTS_NOT_DISTINCT/);
  assert.throws(() => configuredSignerFingerprint({}), /WINDOWS_ARTIFACT_SIGNER_CONFIGURATION_MISSING/);
  assert.throws(() => configuredSignerFingerprint({ [WINDOWS_SIGNER_ENV]: 'not-a-certificate' }), /WINDOWS_ARTIFACT_SIGNER_CONFIGURATION_INVALID/);
  assert.equal(configuredSignerFingerprint({ [WINDOWS_SIGNER_ENV]: SIGNER_FINGERPRINT.toUpperCase() }), SIGNER_FINGERPRINT);
});

test('fails closed on an invalid application artifact before starting its sidecar', async (context) => {
  const values = await fixture(context);
  await fs.writeFile(values.configuration.installed.applicationExecutable, Buffer.from('not a PE artifact'));
  const calls = [];
  const report = await runWindowsArtifactAcceptance({
    environment: values.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: values.archiveReader,
    ...trustOptions(),
    runtimeFactory: ({ kind }) => new FakeRuntime(calls, kind)
  });
  assert.equal(report.passed, false);
  assert.equal(report.layouts[0].checks[0].code, 'WINDOWS_ARTIFACT_APPLICATION_INVALID');
  assert.equal(report.layouts[0].checks.find((check) => check.name === 'sidecar-health').status, 'skipped');
  assert.deepEqual(calls, ['portable:health', 'portable:stop']);
});

test('stops a started sidecar after a health failure and reports only safe evidence', async (context) => {
  const values = await fixture(context);
  const calls = [];
  const report = await runWindowsArtifactAcceptance({
    environment: values.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: values.archiveReader,
    ...trustOptions(),
    runtimeFactory: ({ kind }) => new FakeRuntime(calls, kind, kind === 'installed' ? 'health' : null)
  });
  assert.equal(report.passed, false);
  assert.equal(report.layouts[0].checks.find((check) => check.name === 'sidecar-health').code, 'DATABASE_MANAGER_DRIVER_HOST_EXITED');
  assert.ok(calls.includes('installed:stop'));
  const serialized = JSON.stringify(report);
  for (const sensitive of [values.root, 'secret', 'hunter2']) assert.equal(serialized.includes(sensitive), false);
});

test('fails closed on missing, stale, or changed packaged license evidence', async (context) => {
  const missing = await fixture(context);
  const missingEntries = missing.archives.get(missing.archivePaths.installed);
  missingEntries.delete('third_party_licenses/database-manager-rust-review.json');
  const missingReport = await runWindowsArtifactAcceptance({
    environment: missing.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: missing.archiveReader,
    ...trustOptions(),
    runtimeFactory: ({ kind }) => new FakeRuntime([], kind)
  });
  assert.equal(missingReport.layouts[0].checks.find((check) => check.name === 'packaged-license-review').code, 'WINDOWS_ARTIFACT_LICENSE_REVIEW_INVALID');
  assert.equal(JSON.stringify(missingReport).includes('secret'), false);

  const stale = await fixture(context);
  const staleEntries = stale.archives.get(stale.archivePaths.installed);
  const staleReviewPath = 'third_party_licenses/database-manager-rust-review.json';
  const staleReview = JSON.parse(staleEntries.get(staleReviewPath).toString('utf8'));
  staleReview.inventorySha256 = 'b'.repeat(64);
  staleEntries.set(staleReviewPath, Buffer.from(JSON.stringify(staleReview)));
  const staleReport = await runWindowsArtifactAcceptance({
    environment: stale.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: stale.archiveReader,
    ...trustOptions(),
    runtimeFactory: ({ kind }) => new FakeRuntime([], kind)
  });
  assert.equal(staleReport.layouts[0].checks.find((check) => check.name === 'packaged-license-review').code, 'WINDOWS_ARTIFACT_LICENSE_REVIEW_INVALID');

  const changed = await fixture(context);
  const changedEntries = changed.archives.get(changed.archivePaths.installed);
  const inventory = JSON.parse(changedEntries.get('third_party_licenses/database-manager-rust.json').toString('utf8'));
  changedEntries.set(inventory.packages[0].licenseFiles[0], Buffer.from('changed license text'));
  const changedReport = await runWindowsArtifactAcceptance({
    environment: changed.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: changed.archiveReader,
    ...trustOptions(),
    runtimeFactory: ({ kind }) => new FakeRuntime([], kind)
  });
  assert.equal(changedReport.layouts[0].checks.find((check) => check.name === 'packaged-license-evidence').code, 'WINDOWS_ARTIFACT_LICENSE_EVIDENCE_INVALID');
});

test('rejects a wrong signer or an unreviewed imported dependency before sidecar health', async (context) => {
  const wrongSigner = await fixture(context);
  const signerCalls = [];
  const wrongSignerReport = await runWindowsArtifactAcceptance({
    environment: wrongSigner.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: wrongSigner.archiveReader,
    ...trustOptions({ signerFingerprint: 'b'.repeat(64) }),
    runtimeFactory: ({ kind }) => new FakeRuntime(signerCalls, kind)
  });
  assert.equal(wrongSignerReport.layouts[0].checks.find((check) => check.name === 'application-authenticode').code, 'WINDOWS_ARTIFACT_APPLICATION_SIGNATURE_INVALID');
  assert.deepEqual(signerCalls, []);

  const unreviewed = await fixture(context);
  const dependencyCalls = [];
  const unreviewedReport = await runWindowsArtifactAcceptance({
    environment: unreviewed.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: unreviewed.archiveReader,
    ...trustOptions({ dependencies: ['unreviewed.dll'] }),
    runtimeFactory: ({ kind }) => new FakeRuntime(dependencyCalls, kind)
  });
  assert.equal(unreviewedReport.layouts[0].checks.find((check) => check.name === 'application-dependencies').code, 'WINDOWS_ARTIFACT_APPLICATION_DEPENDENCIES_UNREVIEWED');
  assert.deepEqual(dependencyCalls, []);
});

test('requires a bundled direct dependency to be contained and trusted', async (context) => {
  const missing = await fixture(context);
  const calls = [];
  const report = await runWindowsArtifactAcceptance({
    environment: missing.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: missing.archiveReader,
    signatureVerifier: trustOptions().signatureVerifier,
    dependencyInspector: async (filePath) => path.basename(filePath).toLowerCase() === 'ffmpeg.dll' ? ['kernel32.dll'] : ['ffmpeg.dll', 'kernel32.dll'],
    runtimeFactory: ({ kind }) => new FakeRuntime(calls, kind)
  });
  assert.equal(report.layouts[0].checks.find((check) => check.name === 'application-bundled-dependencies').code, 'WINDOWS_ARTIFACT_BUNDLED_DEPENDENCY_INVALID');
  assert.deepEqual(calls, []);
});

test('requires the packaged application smoke report before sidecar health', async (context) => {
  const values = await fixture(context);
  const calls = [];
  const report = await runWindowsArtifactAcceptance({
    environment: values.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: values.archiveReader,
    ...trustOptions(),
    applicationSmokeRunner: async () => false,
    runtimeFactory: ({ kind }) => new FakeRuntime(calls, kind)
  });
  assert.equal(report.layouts[0].checks.find((check) => check.name === 'application-ui-smoke').code, 'WINDOWS_ARTIFACT_APPLICATION_SMOKE_FAILED');
  assert.deepEqual(calls, []);
});

test('binds resources to the executable layout and scans before application or sidecar execution', async (context) => {
  const detached = await fixture(context);
  const originalResources = detached.configuration.installed.resourcesPath;
  const detachedResources = path.join(detached.root, 'detached-resources');
  await fs.rename(originalResources, detachedResources);
  detached.configuration.installed.resourcesPath = detachedResources;
  detached.environment[WINDOWS_ARTIFACTS_ENV] = JSON.stringify(detached.configuration);
  const detachedReport = await runWindowsArtifactAcceptance({
    environment: detached.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: detached.archiveReader,
    ...trustOptions(),
    runtimeFactory: ({ kind }) => new FakeRuntime([], kind)
  });
  assert.equal(detachedReport.layouts[0].checks.find((check) => check.name === 'resources-directory').code, 'WINDOWS_ARTIFACT_RESOURCES_INVALID');
  assert.equal(detachedReport.layouts[0].checks.find((check) => check.name === 'windows-defender-scan').status, 'skipped');

  const blocked = await fixture(context);
  const calls = [];
  const report = await runWindowsArtifactAcceptance({
    environment: blocked.environment,
    platform: 'win32',
    arch: 'x64',
    archiveReader: blocked.archiveReader,
    ...trustOptions(),
    malwareScanner: async () => false,
    applicationSmokeRunner: async () => { calls.push('smoke'); return true; },
    runtimeFactory: ({ kind }) => new FakeRuntime(calls, kind)
  });
  assert.equal(report.layouts[0].checks.find((check) => check.name === 'windows-defender-scan').code, 'WINDOWS_ARTIFACT_DEFENDER_SCAN_FAILED');
  assert.equal(report.layouts[0].checks.find((check) => check.name === 'application-ui-smoke').status, 'skipped');
  assert.deepEqual(calls, []);
});

test('rejects non-Windows and non-x64 acceptance hosts before reading configuration', async () => {
  await assert.rejects(runWindowsArtifactAcceptance({ platform: 'linux', arch: 'x64', environment: {} }), /WINDOWS_ARTIFACT_HOST_UNSUPPORTED/);
  await assert.rejects(runWindowsArtifactAcceptance({ platform: 'win32', arch: 'arm64', environment: {} }), /WINDOWS_ARTIFACT_HOST_UNSUPPORTED/);
});

test('exposes a fixed package command and CLI failure report without accepting path arguments', async () => {
  const root = path.join(__dirname, '..', '..');
  const packageConfig = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageConfig.scripts['database-windows:accept'], 'node src/database-manager/windows-artifact-acceptance.js');
  assert.equal(packageConfig.devDependencies['@electron/asar'], '3.2.17');
  assert.equal(packageConfig.build.forceCodeSigning, true);
  assert.equal(packageConfig.build.win.signDlls, true);
  const environment = { ...process.env };
  delete environment[WINDOWS_ARTIFACTS_ENV];
  await assert.rejects(execFileAsync(process.execPath, [path.join(__dirname, 'windows-artifact-acceptance.js')], {
    cwd: root,
    env: environment,
    windowsHide: true
  }), (error) => {
    const report = JSON.parse(error.stdout);
    assert.deepEqual(report, { schemaVersion: 1, passed: false, error: { code: 'WINDOWS_ARTIFACT_CONFIGURATION_MISSING' } });
    return true;
  });
});
