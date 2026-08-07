'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CARGO_LOCK_PATH,
  CARGO_MANIFEST_PATH,
  FRONTEND_INVENTORY_PATH,
  FRONTEND_LICENSE_DIRECTORY,
  NOTICE_PATH,
  PACKAGE_PATH,
  PNPM_LOCK_PATH,
  REVIEW_PATH,
  REVIEW_SCHEMA_VERSION,
  RUST_INVENTORY_PATH,
  RUST_LICENSE_DIRECTORY,
  UPSTREAM_LICENSE_PATH,
  auditDbAccessManagerLicenseCompliance,
  buildPnpmProductionGraph,
  parseJson,
  parsePnpmLock,
  sha256,
} = require('./db-access-manager-license-compliance');
const {
  CANONICAL_LICENSE_FILES,
  copyLicenseEvidence,
  generateFrontendInventory,
  generateRustInventory,
} = require('./db-access-manager-license-inventory');
const {
  createDbAccessManagerLicenseReviewRequest,
} = require('./db-access-manager-license-review-request');

const PACKAGE_DOCUMENT = Object.freeze({
  name: 'deployerx-db-access-manager',
  version: '1.0.0',
  dependencies: Object.freeze({
    '@vendor/workspace': 'workspace:*',
    prod: '^1.0.0',
  }),
  devDependencies: Object.freeze({ 'dev-only': '9.0.0' }),
});

const WORKSPACE_DOCUMENT = Object.freeze({
  name: '@vendor/workspace',
  version: '0.2.0',
  license: 'Apache-2.0',
  dependencies: Object.freeze({ nested: '^3.0.0' }),
  devDependencies: Object.freeze({ 'workspace-dev-only': '8.0.0' }),
});

const PNPM_LOCK_SOURCE = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@vendor/workspace':
        specifier: workspace:*
        version: link:packages/workspace
      prod:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      dev-only:
        specifier: 9.0.0
        version: 9.0.0
  packages/workspace:
    dependencies:
      nested:
        specifier: ^3.0.0
        version: 3.0.0
    devDependencies:
      workspace-dev-only:
        specifier: 8.0.0
        version: 8.0.0
packages:
  dev-only@9.0.0: {}
  nested@3.0.0: {}
  optional-runtime@4.0.0: {}
  prod@1.0.0: {}
  transitive@2.0.0: {}
  workspace-dev-only@8.0.0: {}
snapshots:
  dev-only@9.0.0: {}
  nested@3.0.0: {}
  optional-runtime@4.0.0: {}
  prod@1.0.0:
    dependencies:
      transitive: 2.0.0
    optionalDependencies:
      optional-runtime: 4.0.0
  transitive@2.0.0: {}
  workspace-dev-only@8.0.0: {}
`;

const CARGO_MANIFEST_SOURCE = `[package]
name = "deployerx-db-access-manager"
version = "1.0.0"
`;

const COMPANION_REVISION = '1234567890abcdef1234567890abcdef12345678';

const CARGO_LOCK_SOURCE = `version = 3

[[package]]
name = "alpha"
version = "1.2.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[[package]]
name = "beta"
version = "2.0.0"

[[package]]
name = "deployerx-db-access-manager"
version = "1.0.0"
dependencies = [
 "alpha",
 "beta",
]
`;

function write(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function evidence(root, directory, name, version, content) {
  const digest = sha256(Buffer.from(content)).slice(0, 12);
  const relativePath = `${directory}/${name.replace(/[^A-Za-z0-9._-]/g, '-')}-${version}-fixture-1-${digest}.txt`;
  write(root, relativePath, content);
  return relativePath;
}

function fixture(t, { approved = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployerx-access-licenses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, CARGO_MANIFEST_PATH, CARGO_MANIFEST_SOURCE);
  write(root, CARGO_LOCK_PATH, CARGO_LOCK_SOURCE);
  write(root, NOTICE_PATH, '# Exact reviewed notice\n');
  write(root, UPSTREAM_LICENSE_PATH, 'Apache License 2.0\n');
  const packageSource = `${JSON.stringify(PACKAGE_DOCUMENT, null, 2)}\n`;
  write(root, PACKAGE_PATH, packageSource);
  write(root, PNPM_LOCK_PATH, PNPM_LOCK_SOURCE);
  write(root, 'DeployerX DB Manager/packages/workspace/package.json', `${JSON.stringify(WORKSPACE_DOCUMENT, null, 2)}\n`);

  const rustInventory = {
    schemaVersion: 1,
    ecosystem: 'cargo',
    generatedFrom: CARGO_LOCK_PATH,
    rootPackage: { name: 'deployerx-db-access-manager', version: '1.0.0' },
    packageCount: 2,
    packages: [
      {
        name: 'alpha',
        version: '1.2.0',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        license: 'MIT',
        licenseFiles: [evidence(root, RUST_LICENSE_DIRECTORY, 'alpha', '1.2.0', 'MIT alpha\n')],
      },
      {
        name: 'beta',
        version: '2.0.0',
        source: null,
        checksum: null,
        license: 'MIT',
        licenseFiles: [evidence(root, RUST_LICENSE_DIRECTORY, 'beta', '2.0.0', 'MIT beta\n')],
      },
    ],
  };

  const graph = buildPnpmProductionGraph({
    packageDocument: PACKAGE_DOCUMENT,
    lockDocument: parsePnpmLock(PNPM_LOCK_SOURCE),
    workspaceManifests: { 'packages/workspace': WORKSPACE_DOCUMENT },
  });
  const frontendInventory = {
    schemaVersion: 1,
    ecosystem: 'pnpm',
    generatedFrom: { package: PACKAGE_PATH, lock: PNPM_LOCK_PATH },
    packageCount: graph.packageCount,
    snapshotCount: graph.snapshotCount,
    packages: graph.packages.map((entry) => ({
      ...entry,
      license: entry.workspacePath ? 'Apache-2.0' : 'MIT',
      licenseFiles: [evidence(root, FRONTEND_LICENSE_DIRECTORY, entry.name, entry.version, `license ${entry.packageKey}\n`)],
    })),
  };
  const rustInventorySource = `${JSON.stringify(rustInventory, null, 2)}\n`;
  const frontendInventorySource = `${JSON.stringify(frontendInventory, null, 2)}\n`;
  write(root, RUST_INVENTORY_PATH, rustInventorySource);
  write(root, FRONTEND_INVENTORY_PATH, frontendInventorySource);
  const binding = auditDbAccessManagerLicenseCompliance({
    projectRoot: root,
    companionRevision: COMPANION_REVISION,
  }).reviewBinding;
  assert.ok(binding, 'fixture review binding should be available');
  write(root, REVIEW_PATH, `${JSON.stringify({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    decision: approved ? 'approved' : 'pending',
    reviewer: 'Release Counsel',
    reviewedAt: '2026-08-07T12:00:00.000Z',
    ...binding,
  }, null, 2)}\n`);
  return { root, graph, rustInventory, frontendInventory };
}

function auditFixture(root, companionRevision = COMPANION_REVISION) {
  return auditDbAccessManagerLicenseCompliance({ projectRoot: root, companionRevision });
}

test('derives only the complete production pnpm closure and follows workspace dependencies', () => {
  const graph = buildPnpmProductionGraph({
    packageDocument: PACKAGE_DOCUMENT,
    lockDocument: parsePnpmLock(PNPM_LOCK_SOURCE),
    workspaceManifests: { 'packages/workspace': WORKSPACE_DOCUMENT },
  });
  assert.deepEqual(graph.packages.map((entry) => entry.packageKey), [
    'nested@3.0.0',
    'optional-runtime@4.0.0',
    'prod@1.0.0',
    'transitive@2.0.0',
    'workspace:packages/workspace',
  ]);
  assert.equal(graph.snapshotCount, 4);
  assert.ok(!graph.packages.some((entry) => entry.name.includes('dev-only')));
});

test('includes direct optional dependencies from root and production workspaces', () => {
  const packageDocument = {
    ...PACKAGE_DOCUMENT,
    optionalDependencies: { 'root-optional': '5.0.0' },
  };
  const workspaceDocument = {
    ...WORKSPACE_DOCUMENT,
    optionalDependencies: { 'workspace-optional': '6.0.0' },
  };
  const lockDocument = parsePnpmLock(PNPM_LOCK_SOURCE);
  lockDocument.importers['.'].optionalDependencies = {
    'root-optional': { specifier: '5.0.0', version: '5.0.0' },
  };
  lockDocument.importers['packages/workspace'].optionalDependencies = {
    'workspace-optional': { specifier: '6.0.0', version: '6.0.0' },
  };
  lockDocument.packages['root-optional@5.0.0'] = {};
  lockDocument.packages['workspace-optional@6.0.0'] = {};
  lockDocument.snapshots['root-optional@5.0.0'] = {};
  lockDocument.snapshots['workspace-optional@6.0.0'] = {};

  const graph = buildPnpmProductionGraph({
    packageDocument,
    lockDocument,
    workspaceManifests: { 'packages/workspace': workspaceDocument },
  });
  assert.ok(graph.packages.some((entry) => entry.packageKey === 'root-optional@5.0.0'));
  assert.ok(graph.packages.some((entry) => entry.packageKey === 'workspace-optional@6.0.0'));
});

test('rejects a missing lock entry and a workspace importer that does not match its manifest', () => {
  const lock = parsePnpmLock(PNPM_LOCK_SOURCE);
  delete lock.snapshots['transitive@2.0.0'];
  assert.throws(() => buildPnpmProductionGraph({
    packageDocument: PACKAGE_DOCUMENT,
    lockDocument: lock,
    workspaceManifests: { 'packages/workspace': WORKSPACE_DOCUMENT },
  }), /transitive@2\.0\.0 is not locked/);

  const mismatched = parsePnpmLock(PNPM_LOCK_SOURCE);
  delete mismatched.importers['packages/workspace'].dependencies.nested;
  assert.throws(() => buildPnpmProductionGraph({
    packageDocument: PACKAGE_DOCUMENT,
    lockDocument: mismatched,
    workspaceManifests: { 'packages/workspace': WORKSPACE_DOCUMENT },
  }), /does not exactly lock its production dependencies/);
});

test('resolves workspace links relative to the importing workspace', () => {
  const packageDocument = { dependencies: { '@vendor/a': 'workspace:*' } };
  const lockDocument = parsePnpmLock(`lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@vendor/a':
        specifier: workspace:*
        version: link:packages/a
  packages/a:
    dependencies:
      '@vendor/b':
        specifier: workspace:*
        version: link:../b
  packages/b: {}
packages: {}
snapshots: {}
`);
  const graph = buildPnpmProductionGraph({
    packageDocument,
    lockDocument,
    workspaceManifests: {
      'packages/a': { name: '@vendor/a', version: '1.0.0', dependencies: { '@vendor/b': 'workspace:*' } },
      'packages/b': { name: '@vendor/b', version: '1.0.0' },
    },
  });
  assert.deepEqual(graph.packages.map((entry) => entry.packageKey), [
    'workspace:packages/a',
    'workspace:packages/b',
  ]);
});

test('accepts exact reviewed inventories and exposes every required legal file', (t) => {
  const { root, rustInventory, frontendInventory } = fixture(t);
  const report = auditFixture(root);
  assert.equal(report.ready, true, JSON.stringify(report.errors));
  assert.equal(report.rustPackageCount, 2);
  assert.equal(report.frontendPackageCount, 5);
  for (const relativePath of [
    RUST_INVENTORY_PATH,
    FRONTEND_INVENTORY_PATH,
    REVIEW_PATH,
    ...rustInventory.packages.flatMap((entry) => entry.licenseFiles),
    ...frontendInventory.packages.flatMap((entry) => entry.licenseFiles),
  ]) assert.ok(report.legalRelativePaths.includes(relativePath), relativePath);
});

test('rejects missing and unlocked Cargo and frontend inventory packages', async (t) => {
  await t.test('Cargo', (subtest) => {
    const { root, rustInventory } = fixture(subtest);
    rustInventory.packages.shift();
    rustInventory.packages.push({
      name: 'rogue', version: '9.0.0', source: null, checksum: null, license: 'MIT',
      licenseFiles: [evidence(root, RUST_LICENSE_DIRECTORY, 'rogue', '9.0.0', 'rogue\n')],
    });
    rustInventory.packages.sort((left, right) => {
      const key = (entry) => `${entry.name}@${entry.version}|${entry.source || 'workspace'}|${entry.checksum || ''}`;
      return key(left).localeCompare(key(right));
    });
    write(root, RUST_INVENTORY_PATH, `${JSON.stringify(rustInventory, null, 2)}\n`);
    const codes = auditFixture(root).errors.map((entry) => entry.code);
    assert.ok(codes.includes('DB_ACCESS_RUST_PACKAGE_MISSING'));
    assert.ok(codes.includes('DB_ACCESS_RUST_PACKAGE_UNLOCKED'));
  });

  await t.test('frontend', (subtest) => {
    const { root, frontendInventory } = fixture(subtest);
    frontendInventory.packages.shift();
    frontendInventory.packages.push({
      name: 'rogue', version: '9.0.0', packageKey: 'rogue@9.0.0', workspacePath: null,
      snapshotKeys: ['rogue@9.0.0'], license: 'MIT',
      licenseFiles: [evidence(root, FRONTEND_LICENSE_DIRECTORY, 'rogue', '9.0.0', 'rogue\n')],
    });
    frontendInventory.packages.sort((left, right) => left.packageKey.localeCompare(right.packageKey));
    write(root, FRONTEND_INVENTORY_PATH, `${JSON.stringify(frontendInventory, null, 2)}\n`);
    const codes = auditFixture(root).errors.map((entry) => entry.code);
    assert.ok(codes.includes('DB_ACCESS_FRONTEND_PACKAGE_MISSING'));
    assert.ok(codes.includes('DB_ACCESS_FRONTEND_PACKAGE_UNLOCKED'));
  });
});

test('rejects missing or tampered license evidence', async (t) => {
  await t.test('missing', (subtest) => {
    const { root, rustInventory } = fixture(subtest);
    fs.rmSync(path.join(root, ...rustInventory.packages[0].licenseFiles[0].split('/')));
    assert.ok(auditFixture(root).errors.some(
      (entry) => entry.code === 'DB_ACCESS_RUST_LICENSE_FILE_INVALID',
    ));
  });
  await t.test('tampered', (subtest) => {
    const { root, frontendInventory } = fixture(subtest);
    fs.appendFileSync(path.join(root, ...frontendInventory.packages[0].licenseFiles[0].split('/')), 'tampered');
    assert.ok(auditFixture(root).errors.some(
      (entry) => entry.code === 'DB_ACCESS_FRONTEND_LICENSE_FILE_INVALID',
    ));
  });
});

test('rejects missing, unapproved, and stale human review bindings', async (t) => {
  await t.test('missing', (subtest) => {
    const { root } = fixture(subtest);
    fs.rmSync(path.join(root, ...REVIEW_PATH.split('/')));
    assert.ok(auditFixture(root).errors.some(
      (entry) => entry.code === 'DB_ACCESS_LICENSE_REVIEW_MISSING',
    ));
  });
  await t.test('unapproved', (subtest) => {
    const { root } = fixture(subtest, { approved: false });
    assert.ok(auditFixture(root).errors.some(
      (entry) => entry.code === 'DB_ACCESS_LICENSE_REVIEW_INVALID',
    ));
  });
  for (const [label, relativePath, suffix] of [
    ['Cargo lock', CARGO_LOCK_PATH, '\n'],
    ['pnpm lock', PNPM_LOCK_PATH, '\n'],
    ['package manifest', PACKAGE_PATH, ' '],
    ['Rust inventory', RUST_INVENTORY_PATH, ' '],
    ['frontend inventory', FRONTEND_INVENTORY_PATH, ' '],
    ['DeployerX notice', NOTICE_PATH, ' '],
    ['upstream license', UPSTREAM_LICENSE_PATH, ' '],
    ['production workspace manifest', 'DeployerX DB Manager/packages/workspace/package.json', ' '],
  ]) {
    await t.test(`stale ${label}`, (subtest) => {
      const { root } = fixture(subtest);
      fs.appendFileSync(path.join(root, ...relativePath.split('/')), suffix);
      assert.ok(auditFixture(root).errors.some(
        (entry) => entry.code === 'DB_ACCESS_LICENSE_REVIEW_INVALID',
      ));
    });
  }
  await t.test('stale companion revision', (subtest) => {
    const { root } = fixture(subtest);
    assert.ok(auditFixture(root, 'ffffffffffffffffffffffffffffffffffffffff').errors.some(
      (entry) => entry.code === 'DB_ACCESS_LICENSE_REVIEW_INVALID',
    ));
  });
});

test('creates a pending human-review request without treating it as approval', (t) => {
  const { root } = fixture(t, { approved: false });
  const request = createDbAccessManagerLicenseReviewRequest({
    projectRoot: root,
    companionRevision: COMPANION_REVISION,
  });
  assert.equal(request.schemaVersion, REVIEW_SCHEMA_VERSION);
  assert.equal(request.companionRevision, COMPANION_REVISION);
  assert.equal(request.status, 'pending-human-review');
  assert.equal(request.approvalOutputPath, REVIEW_PATH);
  assert.equal(request.rustPackageCount, 2);
  assert.equal(request.frontendPackageCount, 5);
  assert.deepEqual(request.acceptedLicenseExpressions, ['Apache-2.0', 'MIT']);
  assert.ok(!Object.hasOwn(request, 'decision'));
  assert.ok(!Object.hasOwn(request, 'reviewer'));
});

test('generators require exact Cargo metadata and installed frontend package evidence', async (t) => {
  const { root, graph } = fixture(t);
  const rustOutput = path.join(root, 'rust-output');
  const frontendOutput = path.join(root, 'frontend-output');
  fs.mkdirSync(rustOutput);
  fs.mkdirSync(frontendOutput);
  const cargoDirectories = {};
  for (const [name, version, license] of [['alpha', '1.2.0', 'MIT'], ['beta', '2.0.0', 'MIT']]) {
    const directory = path.join(root, 'cargo-packages', name);
    write(directory, 'Cargo.toml', `[package]\nname = "${name}"\nversion = "${version}"\n`);
    write(directory, 'LICENSE', `${license} ${name}\n`);
    cargoDirectories[name] = directory;
  }
  const metadata = {
    resolve: { root: 'root-id' },
    packages: [
      { id: 'root-id', name: 'deployerx-db-access-manager', version: '1.0.0', source: null, manifest_path: path.join(root, ...CARGO_MANIFEST_PATH.split('/')) },
      { id: 'alpha-id', name: 'alpha', version: '1.2.0', source: 'registry+https://github.com/rust-lang/crates.io-index', license: 'MIT', manifest_path: path.join(cargoDirectories.alpha, 'Cargo.toml') },
      { id: 'beta-id', name: 'beta', version: '2.0.0', source: null, license: 'MIT', manifest_path: path.join(cargoDirectories.beta, 'Cargo.toml') },
    ],
  };
  const rust = await generateRustInventory({
    projectRoot: root,
    companionRoot: path.join(root, 'DeployerX DB Manager'),
    cargoMetadata: metadata,
    outputDirectory: rustOutput,
  });
  assert.equal(rust.packageCount, 2);
  await assert.rejects(generateRustInventory({
    projectRoot: root,
    companionRoot: path.join(root, 'DeployerX DB Manager'),
    cargoMetadata: { ...metadata, packages: metadata.packages.slice(0, 2) },
    outputDirectory: path.join(root, 'rust-output-missing'),
  }), /does not cover the exact Cargo\.lock dependency graph/);

  const installed = new Map();
  for (const entry of graph.packages.filter((item) => !item.workspacePath)) {
    const directory = path.join(root, 'installed', entry.name.replace('/', '+'));
    write(directory, 'package.json', `${JSON.stringify({ name: entry.name, version: entry.version, license: 'MIT' })}\n`);
    write(directory, 'LICENSE', `MIT ${entry.packageKey}\n`);
    installed.set(entry.packageKey, directory);
  }
  write(root, 'DeployerX DB Manager/packages/workspace/LICENSE', 'Apache workspace\n');
  await assert.rejects(generateFrontendInventory({
    projectRoot: root,
    companionRoot: path.join(root, 'DeployerX DB Manager'),
    outputDirectory: path.join(root, 'frontend-output-missing'),
  }), /production dependencies are not installed/);
  const frontend = await generateFrontendInventory({
    projectRoot: root,
    companionRoot: path.join(root, 'DeployerX DB Manager'),
    outputDirectory: frontendOutput,
    packageDirectoryResolver: async ({ entry }) => ({
      directory: installed.get(entry.packageKey),
      manifest: parseJson(fs.readFileSync(path.join(installed.get(entry.packageKey), 'package.json'), 'utf8'), entry.packageKey),
    }),
  });
  assert.equal(frontend.packageCount, 5);
  assert.ok(frontend.packages.some((entry) => entry.packageKey === 'workspace:packages/workspace'));
  assert.ok(!frontend.packages.some((entry) => entry.name.includes('dev-only')));
});

test('MIT packages without package-owned license or notice evidence fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployerx-db-access-mit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDirectory = path.join(root, 'package');
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  write(packageDirectory, 'package.json', `${JSON.stringify({
    name: 'missing-mit-notice',
    version: '1.0.0',
    license: 'MIT',
  })}\n`);

  assert.equal(Object.hasOwn(CANONICAL_LICENSE_FILES, 'MIT'), false);
  await assert.rejects(copyLicenseEvidence({
    projectRoot: root,
    packageEntry: { name: 'missing-mit-notice', version: '1.0.0', license: 'MIT' },
    packageDirectory,
    licenseFile: null,
    outputDirectory,
    outputRelativeDirectory: FRONTEND_LICENSE_DIRECTORY,
    identity: 'missing-mit-notice@1.0.0',
  }), /no license file and no approved canonical fallback for MIT/);
});
