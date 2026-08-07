'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BINARY_NAME,
  MANIFEST_NAME,
  STAGED_RELATIVE_DIR,
  UPSTREAM,
  assertSafeStageDirectory,
  defaultLegalFiles,
  parseArguments,
  resolveConfiguration,
  stageArtifacts,
  validateCompanionRepository,
  validateStagedArtifacts,
  validateStagedLegalFiles,
  validateStagedSourceRevision,
} = require('./prepare-db-access-manager');
const {
  resolveDatabaseAccessCompanionExecutablePath,
} = require('../src/database-manager/access-companion-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployerx-db-access-'));
  const projectRoot = path.join(root, 'project');
  const artifactDir = path.join(root, 'release');
  const resourcesDir = path.join(artifactDir, 'resources');
  const stageDir = path.join(projectRoot, 'native', 'dist', 'stage');
  const notice = path.join(root, 'THIRD_PARTY_NOTICES.md');
  const license = path.join(root, 'LICENSE');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, BINARY_NAME), Buffer.concat([
    Buffer.from('MZ', 'ascii'),
    Buffer.alloc(126, 7),
  ]));
  fs.mkdirSync(path.join(resourcesDir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'locales', 'en.json'), '{"ok":true}\n');
  fs.writeFileSync(notice, '# Notices\n');
  fs.writeFileSync(license, 'Apache License 2.0\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourceMetadata = {
    version: '0.18.0-deployerx.1',
    revision: '1234567890abcdef1234567890abcdef12345678',
  };
  const executablePath = path.join(artifactDir, BINARY_NAME);
  const resourcePath = path.join(resourcesDir, 'locales', 'en.json');
  const resourceRecords = [{
    path: 'locales/en.json',
    size: fs.statSync(resourcePath).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(resourcePath)).digest('hex'),
  }];
  return {
    artifactDir,
    projectRoot,
    resourcesDir,
    stageDir,
    legalFiles: [
      { source: notice, destination: 'THIRD_PARTY_NOTICES.md' },
      { source: license, destination: 'licenses/Tabularis-LICENSE.txt' },
    ],
    sourceMetadata,
    buildProvenance: {
      executablePath,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex'),
      resourcesSha256: crypto.createHash('sha256').update(JSON.stringify(resourceRecords)).digest('hex'),
      sourceRevision: sourceMetadata.revision,
    },
  };
}

test('stages a deterministic Windows x64 companion payload', (t) => {
  const options = fixture(t);
  const firstManifest = stageArtifacts(options);
  const firstManifestText = fs.readFileSync(
    path.join(options.stageDir, MANIFEST_NAME),
    'utf8',
  );

  assert.equal(firstManifest.executable, BINARY_NAME);
  assert.equal(firstManifest.sourceArtifactSha256, options.buildProvenance.sha256);
  assert.equal(firstManifest.sourceResourcesSha256, options.buildProvenance.resourcesSha256);
  assert.deepEqual(
    firstManifest.files.map((record) => record.path),
    [
      BINARY_NAME,
      'licenses/Tabularis-LICENSE.txt',
      'resources/locales/en.json',
      'THIRD_PARTY_NOTICES.md',
    ].sort((left, right) => left.localeCompare(right)),
  );
  assert.equal(validateStagedArtifacts(options.stageDir).arch, 'x64');

  stageArtifacts(options);
  assert.equal(
    fs.readFileSync(path.join(options.stageDir, MANIFEST_NAME), 'utf8'),
    firstManifestText,
  );
});

test('rejects staging without exact build-produced executable provenance', (t) => {
  const options = fixture(t);
  assert.throws(
    () => stageArtifacts({ ...options, buildProvenance: null }),
    /requires the exact executable produced/,
  );
  assert.throws(
    () => stageArtifacts({
      ...options,
      buildProvenance: { ...options.buildProvenance, sha256: 'f'.repeat(64) },
    }),
    /requires the exact executable produced/,
  );
  assert.throws(
    () => stageArtifacts({
      ...options,
      buildProvenance: {
        ...options.buildProvenance,
        sourceRevision: 'ffffffffffffffffffffffffffffffffffffffff',
      },
    }),
    /requires the exact executable produced/,
  );
  fs.appendFileSync(path.join(options.resourcesDir, 'locales', 'en.json'), 'changed');
  assert.throws(
    () => stageArtifacts(options),
    /requires the exact executable produced/,
  );
});

test('validation rejects a staged payload changed after preparation', (t) => {
  const options = fixture(t);
  stageArtifacts(options);
  fs.appendFileSync(path.join(options.stageDir, BINARY_NAME), 'tampered');

  assert.throws(
    () => validateStagedArtifacts(options.stageDir),
    /failed integrity validation/,
  );
});

test('stages every required legal input and rejects a source file changed after staging', (t) => {
  const options = fixture(t);
  const inventory = path.join(path.dirname(options.artifactDir), 'db-access-inventory.json');
  fs.writeFileSync(inventory, '{"approved":true}\n');
  options.legalFiles.push({
    source: inventory,
    destination: 'licenses/dependencies/db-access-manager-inventory.json',
  });
  const manifest = stageArtifacts(options);
  assert.ok(manifest.files.some(
    (record) => record.path === 'licenses/dependencies/db-access-manager-inventory.json',
  ));
  assert.doesNotThrow(() => validateStagedLegalFiles(options.stageDir, manifest, options.legalFiles));

  fs.appendFileSync(inventory, 'stale');
  assert.throws(
    () => validateStagedLegalFiles(options.stageDir, validateStagedArtifacts(options.stageDir), options.legalFiles),
    /legal file is missing or stale/,
  );
});

test('default release legal inputs fail closed without generated inventories and approval', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployerx-db-access-legal-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => defaultLegalFiles(root, path.join(root, 'DeployerX DB Manager')),
    /dependency-license gate failed/,
  );
});

test('preparation rejects a non-Windows executable', (t) => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.artifactDir, BINARY_NAME), '#!/bin/sh\n');

  assert.throws(
    () => stageArtifacts(options),
    /not a Windows PE executable/,
  );
});

test('rejects destructive stage targets outside DeployerX native/dist', (t) => {
  const options = fixture(t);
  const externalStage = path.join(path.dirname(options.projectRoot), 'external-stage');
  const marker = path.join(externalStage, 'keep.txt');
  fs.mkdirSync(externalStage, { recursive: true });
  fs.writeFileSync(marker, 'keep');

  for (const stageDir of [
    externalStage,
    options.projectRoot,
    path.join(options.projectRoot, 'native', 'dist'),
  ]) {
    assert.throws(
      () => stageArtifacts({ ...options, stageDir }),
      /must be below the DeployerX native\/dist directory/,
    );
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
});

test('accepts only a non-overlapping stage child under DeployerX native/dist', (t) => {
  const options = fixture(t);
  assert.doesNotThrow(() => assertSafeStageDirectory(
    options.stageDir,
    options.artifactDir,
    options.projectRoot,
  ));
});

test('rejects stage-only operation and release-path overrides', () => {
  assert.equal(parseArguments(['--build']), '--build');
  assert.equal(parseArguments(['--validate-only']), '--validate-only');
  assert.throws(() => parseArguments([]), /Choose --build or --validate-only/);
  assert.throws(() => parseArguments(['--stage-only']), /Unknown argument/);
  assert.throws(
    () => resolveConfiguration({ DEPLOYERX_DB_MANAGER_STAGE_DIR: 'native/dist/alternate' }),
    /release output paths are fixed/,
  );
  assert.throws(
    () => resolveConfiguration({ DEPLOYERX_DB_MANAGER_ARTIFACT_DIR: 'elsewhere' }),
    /release output paths are fixed/,
  );
});

test('rejects a junction stage target before recursive cleanup', (t) => {
  const options = fixture(t);
  const externalStage = path.join(path.dirname(options.projectRoot), 'external-junction-target');
  const marker = path.join(externalStage, 'keep.txt');
  fs.mkdirSync(path.dirname(options.stageDir), { recursive: true });
  fs.mkdirSync(externalStage, { recursive: true });
  fs.writeFileSync(marker, 'keep');
  fs.symlinkSync(externalStage, options.stageDir, 'junction');

  assert.throws(
    () => stageArtifacts(options),
    /Symbolic links and junctions are not allowed/,
  );
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
});

function injectedGit({
  revision = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  ancestryStatus = 0,
  statusOutput = '',
} = {}) {
  const calls = [];
  const runGitCommand = (_companionRoot, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${revision}\n` };
    if (args[0] === 'merge-base') return { status: ancestryStatus, stdout: '' };
    if (args[0] === 'status') return { status: 0, stdout: statusOutput };
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  };
  return { calls, runGitCommand };
}

test('accepts only a clean companion revision descended from the approved upstream pin', () => {
  const git = injectedGit();
  const repository = validateCompanionRepository('C:\\source\\companion', git);

  assert.equal(repository.revision, 'abcdefabcdefabcdefabcdefabcdefabcdefabcd');
  assert.equal(repository.approvedUpstreamRevision, UPSTREAM.commit);
  assert.deepEqual(git.calls, [
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    ['merge-base', '--is-ancestor', UPSTREAM.commit, repository.revision],
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
  ]);
});

test('rejects a companion revision outside the approved upstream history', () => {
  const git = injectedGit({ ancestryStatus: 1 });
  assert.throws(
    () => validateCompanionRepository('C:\\source\\companion', git),
    /must descend from approved upstream commit/,
  );
});

test('rejects tracked and untracked companion source changes', () => {
  for (const statusOutput of [' M src-tauri/src/main.rs\n', '?? untracked.txt\n']) {
    const git = injectedGit({ statusOutput });
    assert.throws(
      () => validateCompanionRepository('C:\\source\\companion', git),
      /must have no tracked or untracked changes/,
    );
  }
});

test('rejects staged artifacts whose claimed source revision is stale', (t) => {
  const options = fixture(t);
  const manifest = stageArtifacts(options);
  assert.throws(
    () => validateStagedSourceRevision(manifest, {
      revision: 'ffffffffffffffffffffffffffffffffffffffff',
    }),
    /do not match the current companion revision/,
  );
});

test('keeps staged, installed, and runtime executable paths aligned', () => {
  const configuration = resolveConfiguration({});
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(configuration.projectRoot, 'package.json'), 'utf8'),
  );
  const resource = packageJson.build.extraResources.find(
    (entry) => entry.to === 'db-access-manager',
  );
  assert.ok(resource, 'Electron Builder must install the companion resource');
  assert.equal(path.normalize(resource.from), STAGED_RELATIVE_DIR);
  assert.equal(
    resolveDatabaseAccessCompanionExecutablePath({
      isPackaged: false,
      appPath: configuration.projectRoot,
    }),
    path.join(configuration.projectRoot, STAGED_RELATIVE_DIR, BINARY_NAME),
  );
  assert.equal(
    resolveDatabaseAccessCompanionExecutablePath({
      isPackaged: true,
      resourcesPath: path.join(configuration.projectRoot, 'installed-resources'),
    }),
    path.join(
      configuration.projectRoot,
      'installed-resources',
      resource.to,
      BINARY_NAME,
    ),
  );
  assert.match(packageJson.scripts['package:win'], /database-access:prepare/);
  assert.match(packageJson.scripts['package:win'], /database-access:validate/);
  assert.equal(
    packageJson.scripts['database-access:license-check'],
    'node scripts/db-access-manager-license-compliance.js --require-ready',
  );
  assert.match(packageJson.scripts['database-access:licenses'], /db-access-manager-license-inventory/);
  assert.match(packageJson.scripts['database-access:license-review-request'], /db-access-manager-license-review-request/);
  assert.match(
    fs.readFileSync(path.join(configuration.projectRoot, 'build-exe.bat'), 'utf8'),
    /call npm run package:win/,
  );
});

test('retains modified Tabularis attribution in the packaged legal notice', () => {
  const configuration = resolveConfiguration({});
  const notice = fs.readFileSync(
    path.join(configuration.projectRoot, 'THIRD_PARTY_NOTICES.md'),
    'utf8',
  );
  assert.match(notice, /## Tabularis/);
  assert.match(notice, new RegExp(UPSTREAM.commit));
  assert.match(notice, /Apache License 2\.0/);
  assert.match(notice, /modified and rebranded executable/);
  assert.match(notice, /licenses\/Tabularis-LICENSE\.txt/);
  assert.match(notice, /licenses\/dependencies\/db-access-manager-rust\.json/);
  assert.match(notice, /licenses\/dependencies\/db-access-manager-frontend\.json/);
  assert.match(notice, /licenses\/dependencies\/db-access-manager-review\.json/);
  assert.match(notice, /Releases are rejected until\s+the exact human\s+approval/);
  assert.doesNotMatch(notice, /current source tree does\s+not contain that human approval/);
});
