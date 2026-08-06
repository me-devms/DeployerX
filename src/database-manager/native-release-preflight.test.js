const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { auditNativeRelease, safeInventoryPath } = require('./native-release-preflight');

const execFileAsync = promisify(execFile);

function peFixture({ machine = 0x8664, optionalMagic = 0x20b } = {}) {
  const content = Buffer.alloc(512);
  const peOffset = 0x80;
  content.write('MZ', 0, 'ascii');
  content.writeUInt32LE(peOffset, 0x3c);
  content.write('PE\0\0', peOffset, 'ascii');
  content.writeUInt16LE(machine, peOffset + 4);
  content.writeUInt16LE(1, peOffset + 6);
  content.writeUInt16LE(112, peOffset + 20);
  content.writeUInt16LE(0x0002, peOffset + 22);
  content.writeUInt16LE(optionalMagic, peOffset + 24);
  return content;
}

async function writeLicenseEvidence(root, stem, content) {
  const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  const relativePath = `third_party_licenses/database-manager-rust/${stem}-${digest}.txt`;
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.writeFile(path.join(root, relativePath), content);
  return relativePath;
}

async function writeReview(root) {
  const lockSource = await fs.readFile(path.join(root, 'native', 'deployerx-db-host', 'Cargo.lock'), 'utf8');
  const inventorySource = await fs.readFile(path.join(root, 'third_party_licenses', 'database-manager-rust.json'), 'utf8');
  const inventory = JSON.parse(inventorySource);
  const review = {
    schemaVersion: 1,
    decision: 'approved',
    reviewer: 'Native release fixture',
    reviewedAt: '2026-08-06T00:00:00.000Z',
    lockPath: 'native/deployerx-db-host/Cargo.lock',
    lockSha256: crypto.createHash('sha256').update(lockSource).digest('hex'),
    inventoryPath: 'third_party_licenses/database-manager-rust.json',
    inventorySha256: crypto.createHash('sha256').update(inventorySource).digest('hex'),
    packageCount: inventory.packageCount,
    acceptedLicenseExpressions: [...new Set(inventory.packages.map((entry) => entry.license))].sort()
  };
  await fs.writeFile(path.join(root, 'third_party_licenses', 'database-manager-rust-review.json'), JSON.stringify(review));
}

async function writeFixture(root, { omitInventoryPackage = false, traversal = false, hostMode = 'valid', duplicateLicenseFile = false, swapLicenseFiles = false } = {}) {
  await fs.mkdir(path.join(root, 'native', 'deployerx-db-host', 'dist', 'win32-x64'), { recursive: true });
  await fs.mkdir(path.join(root, 'third_party_licenses'), { recursive: true });
  await fs.writeFile(path.join(root, 'native', 'deployerx-db-host', 'Cargo.toml'), `[package]\nname = "deployerx-db-host"\nversion = "0.1.0"\n\n[dependencies]\nbase64 = "0.22.1"\nserde = "1.0"\n`);
  await fs.writeFile(path.join(root, 'native', 'deployerx-db-host', 'Cargo.lock'), `version = 3\n\n[[package]]\nname = "deployerx-db-host"\nversion = "0.1.0"\ndependencies = ["base64", "serde"]\n\n[[package]]\nname = "base64"\nversion = "0.22.1"\n\n[[package]]\nname = "serde"\nversion = "1.0.219"\n`);
  const mitPath = await writeLicenseEvidence(root, 'base64-0.22.1-1', 'MIT license fixture');
  const apachePath = await writeLicenseEvidence(root, 'serde-1.0.219-1', 'Apache license fixture');
  const packages = [
    { name: 'base64', version: '0.22.1', license: 'MIT OR Apache-2.0', licenseFiles: [traversal ? '../outside.txt' : (swapLicenseFiles ? apachePath : mitPath)] },
    ...(!omitInventoryPackage ? [{ name: 'serde', version: '1.0.219', license: 'MIT OR Apache-2.0', licenseFiles: [duplicateLicenseFile ? mitPath : (swapLicenseFiles ? mitPath : apachePath)] }] : [])
  ];
  await fs.writeFile(path.join(root, 'third_party_licenses', 'database-manager-rust.json'), JSON.stringify({ schemaVersion: 1, generatedFrom: 'native/deployerx-db-host/Cargo.lock', packageCount: packages.length, packages }));
  await writeReview(root);
  await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), '# Third-Party Notices\n\n## Database Manager Rust Dependencies\n\nSee `third_party_licenses/database-manager-rust.json` and `third_party_licenses/database-manager-rust-review.json`.\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'prepackage:win': 'node src/database-manager/native-release-preflight.js --require-ready' }, build: { files: ['THIRD_PARTY_NOTICES.md', 'third_party_licenses/**/*'], extraResources: [{ from: 'native/deployerx-db-host/dist/win32-x64/deployerx-db-host.exe', to: 'database-manager/win32-x64/deployerx-db-host.exe' }] } }));
  const hostPath = path.join(root, 'native', 'deployerx-db-host', 'dist', 'win32-x64', 'deployerx-db-host.exe');
  if (hostMode === 'valid') await fs.writeFile(hostPath, peFixture());
  if (hostMode === 'mz-only') await fs.writeFile(hostPath, Buffer.from('MZ'.padEnd(128, '\0')));
  if (hostMode === 'x86') await fs.writeFile(hostPath, peFixture({ machine: 0x014c, optionalMagic: 0x10b }));
}

test('accepts a locked graph with an exact packaged license inventory and PE host', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-ready-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixture(root);
  const report = await auditNativeRelease({ rootPath: root });
  assert.equal(report.ready, true);
  assert.equal(report.lockedPackageCount, 2);
  assert.equal(report.inventoriedPackageCount, 2);
  assert.deepEqual(report.errors, []);
});

test('rejects missing locked packages, traversal paths, and a missing host', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-incomplete-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixture(root, { omitInventoryPackage: true, traversal: true, hostMode: 'missing' });
  const report = await auditNativeRelease({ rootPath: root });
  assert.equal(report.ready, false);
  assert.ok(report.errors.some((entry) => entry.code === 'NATIVE_LICENSE_INVENTORY_INVALID'));
  assert.ok(report.errors.some((entry) => entry.code === 'NATIVE_LICENSE_PACKAGE_MISSING'));
  assert.ok(report.errors.some((entry) => entry.code === 'NATIVE_HOST_MISSING'));
  assert.equal(safeInventoryPath('../outside.txt'), null);
  assert.equal(safeInventoryPath('third_party_licenses/../../outside.txt'), null);
});

test('rejects MZ-only and non-x64 host artifacts', async (context) => {
  const mzRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-mz-'));
  const x86Root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-x86-'));
  context.after(() => Promise.all([fs.rm(mzRoot, { recursive: true, force: true }), fs.rm(x86Root, { recursive: true, force: true })]));
  await writeFixture(mzRoot, { hostMode: 'mz-only' });
  await writeFixture(x86Root, { hostMode: 'x86' });
  const mzReport = await auditNativeRelease({ rootPath: mzRoot });
  const x86Report = await auditNativeRelease({ rootPath: x86Root });
  assert.ok(mzReport.errors.some((entry) => entry.code === 'NATIVE_HOST_INVALID'));
  assert.ok(x86Report.errors.some((entry) => entry.code === 'NATIVE_HOST_INVALID'));
});

test('rejects changed, reassigned, and multiply assigned generated license evidence', async (context) => {
  const changedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-license-change-'));
  const duplicateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-license-duplicate-'));
  const swappedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-license-swapped-'));
  context.after(() => Promise.all([fs.rm(changedRoot, { recursive: true, force: true }), fs.rm(duplicateRoot, { recursive: true, force: true }), fs.rm(swappedRoot, { recursive: true, force: true })]));
  await writeFixture(changedRoot);
  const inventory = JSON.parse(await fs.readFile(path.join(changedRoot, 'third_party_licenses', 'database-manager-rust.json'), 'utf8'));
  await fs.writeFile(path.join(changedRoot, inventory.packages[0].licenseFiles[0]), 'changed after inventory generation');
  await writeFixture(duplicateRoot, { duplicateLicenseFile: true });
  await writeFixture(swappedRoot, { swapLicenseFiles: true });
  const changedReport = await auditNativeRelease({ rootPath: changedRoot });
  const duplicateReport = await auditNativeRelease({ rootPath: duplicateRoot });
  const swappedReport = await auditNativeRelease({ rootPath: swappedRoot });
  assert.ok(changedReport.errors.some((entry) => entry.code === 'NATIVE_LICENSE_FILE_INVALID'));
  assert.ok(duplicateReport.errors.some((entry) => entry.code === 'NATIVE_LICENSE_FILE_DUPLICATE'));
  assert.equal(swappedReport.errors.filter((entry) => entry.code === 'NATIVE_LICENSE_FILE_INVALID').length, 2);
});

test('rejects a legal review that no longer matches the locked graph', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-release-review-stale-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixture(root);
  await fs.appendFile(path.join(root, 'native', 'deployerx-db-host', 'Cargo.lock'), '\n');
  const report = await auditNativeRelease({ rootPath: root });
  assert.equal(report.ready, false);
  assert.ok(report.errors.some((entry) => entry.code === 'NATIVE_LICENSE_REVIEW_INVALID'));
});

test('require-ready CLI exits nonzero with a structured report for the current incomplete release', async () => {
  await assert.rejects(execFileAsync(process.execPath, [path.join(__dirname, 'native-release-preflight.js'), '--require-ready'], { windowsHide: true }), (error) => {
    const report = JSON.parse(error.stdout);
    assert.equal(report.ready, false);
    assert.ok(!report.errors.some((entry) => entry.code === 'NATIVE_LOCK_MISSING'));
    assert.ok(!report.errors.some((entry) => entry.code === 'NATIVE_LICENSE_INVENTORY_MISSING'));
    assert.ok(report.errors.some((entry) => entry.code === 'NATIVE_LICENSE_REVIEW_MISSING'));
    assert.equal(report.lockedPackageCount, report.inventoriedPackageCount);
    assert.ok(report.lockedPackageCount > 0);
    assert.ok(report.errors.some((entry) => entry.code === 'NATIVE_HOST_MISSING'));
    return true;
  });
});
