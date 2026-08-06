const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateNativeLicenseInventory, normalizedMetadataPackages } = require('./native-license-inventory');
const { auditNativeRelease } = require('./native-release-preflight');

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

async function writeReview(root) {
  const lockSource = await fs.readFile(path.join(root, 'native', 'deployerx-db-host', 'Cargo.lock'), 'utf8');
  const inventorySource = await fs.readFile(path.join(root, 'third_party_licenses', 'database-manager-rust.json'), 'utf8');
  const inventory = JSON.parse(inventorySource);
  await fs.writeFile(path.join(root, 'third_party_licenses', 'database-manager-rust-review.json'), JSON.stringify({
    schemaVersion: 1,
    decision: 'approved',
    reviewer: 'Native inventory fixture',
    reviewedAt: '2026-08-06T00:00:00.000Z',
    lockPath: 'native/deployerx-db-host/Cargo.lock',
    lockSha256: crypto.createHash('sha256').update(lockSource).digest('hex'),
    inventoryPath: 'third_party_licenses/database-manager-rust.json',
    inventorySha256: crypto.createHash('sha256').update(inventorySource).digest('hex'),
    packageCount: inventory.packageCount,
    acceptedLicenseExpressions: [...new Set(inventory.packages.map((entry) => entry.license))].sort()
  }));
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-license-inventory-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const rootPackage = path.join(root, 'native', 'deployerx-db-host');
  const base64Package = path.join(root, 'cargo-registry', 'base64-0.22.1');
  const serdePackage = path.join(root, 'cargo-registry', 'serde-1.0.219');
  await fs.mkdir(path.join(rootPackage, 'dist', 'win32-x64'), { recursive: true });
  await fs.mkdir(base64Package, { recursive: true });
  await fs.mkdir(serdePackage, { recursive: true });
  await fs.mkdir(path.join(root, 'third_party_licenses'), { recursive: true });
  await fs.writeFile(path.join(root, 'third_party_licenses', 'MIT.txt'), 'canonical MIT license');
  await fs.writeFile(path.join(root, 'third_party_licenses', 'Apache-2.0.txt'), 'canonical Apache license');
  await fs.writeFile(path.join(root, 'third_party_licenses', 'BSL-1.0.txt'), 'canonical Boost license');
  const manifest = `[package]\nname = "deployerx-db-host"\nversion = "0.1.0"\n\n[dependencies]\nbase64 = "0.22.1"\nserde = "1.0"\n`;
  await fs.writeFile(path.join(rootPackage, 'Cargo.toml'), manifest);
  await fs.writeFile(path.join(base64Package, 'Cargo.toml'), '[package]\nname = "base64"\nversion = "0.22.1"\n');
  await fs.writeFile(path.join(serdePackage, 'Cargo.toml'), '[package]\nname = "serde"\nversion = "1.0.219"\n');
  await fs.writeFile(path.join(base64Package, 'LICENSE-MIT'), 'base64 MIT license');
  await fs.writeFile(path.join(base64Package, 'LICENSE-APACHE'), 'base64 Apache license');
  await fs.writeFile(path.join(serdePackage, 'COPYRIGHT'), 'serde copyright and license');
  await fs.writeFile(path.join(rootPackage, 'Cargo.lock'), `version = 3\n\n[[package]]\nname = "deployerx-db-host"\nversion = "0.1.0"\n\n[[package]]\nname = "base64"\nversion = "0.22.1"\n\n[[package]]\nname = "serde"\nversion = "1.0.219"\n`);
  await fs.writeFile(path.join(rootPackage, 'dist', 'win32-x64', 'deployerx-db-host.exe'), peFixture());
  await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), '# Third-Party Notices\n\n## Database Manager Rust Dependencies\n\nSee `third_party_licenses/database-manager-rust.json` and `third_party_licenses/database-manager-rust-review.json`.\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'prepackage:win': 'node src/database-manager/native-release-preflight.js --require-ready' }, build: { files: ['THIRD_PARTY_NOTICES.md', 'third_party_licenses/**/*'], extraResources: [{ from: 'native/deployerx-db-host/dist/win32-x64/deployerx-db-host.exe', to: 'database-manager/win32-x64/deployerx-db-host.exe' }] } }));
  return {
    root,
    serdePackage,
    metadata: {
      packages: [
        { id: 'path+root', name: 'deployerx-db-host', version: '0.1.0', rust_version: '1.77.2', manifest_path: path.join(rootPackage, 'Cargo.toml'), license: 'Apache-2.0' },
        { id: 'registry+base64', name: 'base64', version: '0.22.1', rust_version: '1.60', manifest_path: path.join(base64Package, 'Cargo.toml'), license: 'MIT OR Apache-2.0' },
        { id: 'registry+serde', name: 'serde', version: '1.0.219', rust_version: '1.56.0', manifest_path: path.join(serdePackage, 'Cargo.toml'), license: null, license_file: path.join(serdePackage, 'COPYRIGHT') }
      ],
      resolve: { root: 'path+root' }
    }
  };
}

test('generates deterministic bounded license copies that satisfy release preflight', async (context) => {
  const values = await fixture(context);
  const first = await generateNativeLicenseInventory({ metadata: values.metadata, rootPath: values.root });
  const second = await generateNativeLicenseInventory({ metadata: values.metadata, rootPath: values.root });
  await writeReview(values.root);
  assert.deepEqual(second, first);
  assert.equal(first.packageCount, 2);
  assert.deepEqual(first.packages.map((entry) => [entry.name, entry.version, entry.license]), [
    ['base64', '0.22.1', 'MIT OR Apache-2.0'],
    ['serde', '1.0.219', 'LicenseRef-See-License-Files']
  ]);
  assert.equal(first.packages[0].licenseFiles.length, 2);
  assert.equal(first.packages[1].licenseFiles.length, 1);
  for (const entry of first.packages) for (const licenseFile of entry.licenseFiles) assert.match(licenseFile, /^third_party_licenses\/database-manager-rust\/[A-Za-z0-9._-]+\.txt$/);
  const report = await auditNativeRelease({ rootPath: values.root });
  assert.equal(report.ready, true);
  assert.equal(report.inventoriedPackageCount, 2);
});

test('rejects packages without license evidence and leaves no published inventory', async (context) => {
  const values = await fixture(context);
  await fs.rm(path.join(values.serdePackage, 'COPYRIGHT'));
  values.metadata.packages[2].license_file = null;
  await assert.rejects(generateNativeLicenseInventory({ metadata: values.metadata, rootPath: values.root }), /no approved canonical license fallback/);
  await assert.rejects(fs.access(path.join(values.root, 'third_party_licenses', 'database-manager-rust.json')));
});

test('copies approved canonical SPDX texts when a crate package omits license files', async (context) => {
  const values = await fixture(context);
  await fs.rm(path.join(values.serdePackage, 'COPYRIGHT'));
  values.metadata.packages[2].license = 'MIT OR Apache-2.0';
  values.metadata.packages[2].license_file = null;
  const inventory = await generateNativeLicenseInventory({ metadata: values.metadata, rootPath: values.root });
  await writeReview(values.root);
  const serde = inventory.packages.find((entry) => entry.name === 'serde');
  assert.equal(serde.licenseFiles.length, 2);
  assert.ok(serde.licenseFiles.every((licenseFile) => /serde-1\.0\.219/.test(licenseFile)));
  assert.equal((await auditNativeRelease({ rootPath: values.root })).ready, true);
});

test('rejects duplicate packages and license files outside the resolved package', async (context) => {
  const values = await fixture(context);
  values.metadata.packages.push({ ...values.metadata.packages[1], id: 'registry+base64-duplicate' });
  assert.throws(() => normalizedMetadataPackages(values.metadata), /duplicated/);
  values.metadata.packages.pop();
  values.metadata.packages[2].license_file = path.join(values.root, 'outside-license.txt');
  await fs.writeFile(values.metadata.packages[2].license_file, 'outside');
  await assert.rejects(generateNativeLicenseInventory({ metadata: values.metadata, rootPath: values.root }), /escapes its package/);
});

test('rejects locked metadata whose declared MSRV exceeds the root toolchain', async (context) => {
  const values = await fixture(context);
  values.metadata.packages[1].rust_version = '1.82';
  assert.throws(() => normalizedMetadataPackages(values.metadata), /requires Rust 1\.82, above the root 1\.77\.2/);
});
