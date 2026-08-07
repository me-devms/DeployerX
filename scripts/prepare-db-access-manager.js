#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  legalFilesForCompliance,
  requireDbAccessManagerLicenseCompliance,
} = require('./db-access-manager-license-compliance');

const PRODUCT_NAME = 'DeployerX DB Access Manager';
const BINARY_NAME = 'deployerx-db-access-manager.exe';
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const STAGED_RELATIVE_DIR = path.join(
  'native',
  'dist',
  'deployerx-db-access-manager',
  'win32-x64',
);
const MANIFEST_NAME = 'artifact-manifest.json';
const UPSTREAM = Object.freeze({
  repository: 'https://github.com/TabularisDB/tabularis',
  release: 'v0.18.0',
  commit: '147777c59947178c54e1a9894d52f5abc9db9208',
});

function fail(message) {
  throw new Error(message);
}

function resolvePathFrom(baseDir, candidate) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
}

function resolveConfiguration(environment = process.env) {
  const projectRoot = path.resolve(__dirname, '..');
  const companionRoot = path.join(projectRoot, 'DeployerX DB Manager');
  for (const variable of [
    'DEPLOYERX_DB_MANAGER_ARTIFACT_DIR',
    'DEPLOYERX_DB_MANAGER_STAGE_DIR',
  ]) {
    if (String(environment[variable] || '').trim()) {
      fail(`${variable} is not supported because release output paths are fixed.`);
    }
  }
  const targetRoot = environment.DEPLOYERX_DB_MANAGER_TARGET_DIR
    ? resolvePathFrom(companionRoot, environment.DEPLOYERX_DB_MANAGER_TARGET_DIR)
    : path.join(companionRoot, 'src-tauri', 'target');
  const artifactDir = path.join(targetRoot, TARGET_TRIPLE, 'release');
  const stageDir = path.join(projectRoot, STAGED_RELATIVE_DIR);

  return {
    projectRoot,
    companionRoot,
    targetRoot,
    artifactDir,
    resourcesDir: path.join(artifactDir, 'resources'),
    stageDir,
  };
}

function parseArguments(argv) {
  const modes = argv.filter((argument) =>
    ['--build', '--validate-only'].includes(argument),
  );
  const unknown = argv.filter((argument) => !modes.includes(argument));

  if (unknown.length > 0) {
    fail(`Unknown argument(s): ${unknown.join(', ')}`);
  }
  if (modes.length > 1) {
    fail('Choose only one of --build or --validate-only.');
  }
  if (!modes.length) fail('Choose --build or --validate-only. Staging unverified build output is not supported.');
  return modes[0];
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    fail(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with code ${result.status}.`);
  }
}

function buildCompanion(configuration, sourceRevision) {
  if (process.platform !== 'win32') {
    fail('The DB Access Manager release artifact must be built on Windows.');
  }

  const pnpm = 'pnpm.cmd';
  const childEnvironment = {
    ...process.env,
    CARGO_TARGET_DIR: configuration.targetRoot,
  };

  run(pnpm, ['install', '--frozen-lockfile'], {
    cwd: configuration.companionRoot,
    env: childEnvironment,
  });
  run(
    pnpm,
    ['exec', 'tauri', 'build', '--no-bundle', '--target', TARGET_TRIPLE],
    {
      cwd: configuration.companionRoot,
      env: childEnvironment,
    },
  );
  const executablePath = path.join(configuration.artifactDir, BINARY_NAME);
  assertWindowsExecutable(executablePath);
  return Object.freeze({
    executablePath: path.resolve(executablePath),
    sha256: hashFile(executablePath),
    resourcesSha256: resourceTreeDigest(configuration.resourcesDir),
    sourceRevision,
  });
}

function readTomlPackageName(cargoToml) {
  const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  const name = packageSection?.[1].match(/^name\s*=\s*"([^"]+)"\s*$/m);
  return name?.[1] || null;
}

function validateCompanionIdentity(companionRoot) {
  const cargoPath = path.join(companionRoot, 'src-tauri', 'Cargo.toml');
  const tauriConfigPath = path.join(companionRoot, 'src-tauri', 'tauri.conf.json');
  const packagePath = path.join(companionRoot, 'package.json');

  for (const requiredPath of [cargoPath, tauriConfigPath, packagePath]) {
    if (!fs.existsSync(requiredPath)) {
      fail(`Missing companion project file: ${requiredPath}`);
    }
  }

  const cargoName = readTomlPackageName(fs.readFileSync(cargoPath, 'utf8'));
  if (cargoName !== 'deployerx-db-access-manager') {
    fail(
      `Companion Cargo package must be named deployerx-db-access-manager; found ${cargoName || 'no package name'}.`,
    );
  }

  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
  if (tauriConfig.productName !== PRODUCT_NAME) {
    fail(
      `Companion Tauri productName must be ${PRODUCT_NAME}; found ${tauriConfig.productName || 'no productName'}.`,
    );
  }

  const companionPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return {
    product: PRODUCT_NAME,
    version: String(companionPackage.version || tauriConfig.version || ''),
  };
}

function runGit(companionRoot, args) {
  return spawnSync('git', ['-C', companionRoot, ...args], {
    encoding: 'utf8',
    shell: false,
  });
}

function validateCompanionRepository(
  companionRoot,
  { runGitCommand = runGit } = {},
) {
  const revisionResult = runGitCommand(companionRoot, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);

  if (revisionResult?.error || revisionResult?.status !== 0) {
    fail('Unable to read the DB Access Manager submodule revision.');
  }

  const revision = String(revisionResult.stdout || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    fail(`Invalid DB Access Manager submodule revision: ${revision || 'empty'}.`);
  }

  const normalizedRevision = revision.toLowerCase();
  const ancestryResult = runGitCommand(companionRoot, [
    'merge-base',
    '--is-ancestor',
    UPSTREAM.commit,
    normalizedRevision,
  ]);
  if (ancestryResult?.error || ![0, 1].includes(ancestryResult?.status)) {
    fail('Unable to verify the DB Access Manager upstream ancestry.');
  }
  if (ancestryResult.status === 1) {
    fail(`DB Access Manager HEAD must descend from approved upstream commit ${UPSTREAM.commit}.`);
  }

  const statusResult = runGitCommand(companionRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (statusResult?.error || statusResult?.status !== 0) {
    fail('Unable to verify that the DB Access Manager source tree is clean.');
  }
  if (String(statusResult.stdout || '').trim()) {
    fail('DB Access Manager source must have no tracked or untracked changes before staging.');
  }

  return Object.freeze({
    revision: normalizedRevision,
    approvedUpstreamRevision: UPSTREAM.commit,
  });
}

function assertPortableRelativePath(relativePath) {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes('..')
  ) {
    fail(`Unsafe artifact path: ${relativePath}`);
  }
}

function isPathBelow(parentDir, candidateDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidateDir));
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function assertExistingPathComponentsAreDirectories(rootDir, candidateDir) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidateDir);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail('The DB Access Manager stage path escapes the project root.');
  }

  let current = resolvedRoot;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      fail(`Symbolic links and junctions are not allowed in the DB Access Manager stage path: ${current}`);
    }
    if (!stat.isDirectory()) {
      fail(`A DB Access Manager stage path component is not a directory: ${current}`);
    }
  }
}

function resolveRealCandidate(candidatePath) {
  let existing = path.resolve(candidatePath);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail(`Unable to resolve release path: ${candidatePath}`);
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...suffix);
}

function pathsOverlap(leftPath, rightPath) {
  const leftToRight = path.relative(leftPath, rightPath);
  const rightToLeft = path.relative(rightPath, leftPath);
  const contains = (relative) => relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  );
  return contains(leftToRight) || contains(rightToLeft);
}

function assertSafeStageDirectory(stageDir, artifactDir, projectRoot) {
  const resolvedStageDir = path.resolve(stageDir);
  const resolvedArtifactDir = path.resolve(artifactDir);
  const resolvedProjectRoot = path.resolve(String(projectRoot || ''));
  const allowedStageRoot = path.join(resolvedProjectRoot, 'native', 'dist');

  if (!projectRoot || !isPathBelow(allowedStageRoot, resolvedStageDir)) {
    fail('The DB Access Manager stage directory must be below the DeployerX native/dist directory.');
  }
  assertExistingPathComponentsAreDirectories(resolvedProjectRoot, resolvedStageDir);
  const realAllowedStageRoot = resolveRealCandidate(allowedStageRoot);
  const realStageDir = resolveRealCandidate(resolvedStageDir);
  const realArtifactDir = resolveRealCandidate(resolvedArtifactDir);
  if (!isPathBelow(realAllowedStageRoot, realStageDir)) {
    fail('The real DB Access Manager stage directory must remain below native/dist.');
  }
  if (pathsOverlap(realStageDir, realArtifactDir)) {
    fail('The stage directory and companion build output must not overlap.');
  }
}

function removeSafeStageDirectory(stageDir, artifactDir, projectRoot) {
  assertSafeStageDirectory(stageDir, artifactDir, projectRoot);
  fs.rmSync(stageDir, { recursive: true, force: true });
}

function copyDirectory(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const entries = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isSymbolicLink()) {
      fail(`Symlinks are not allowed in companion resources: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    } else {
      fail(`Unsupported companion resource entry: ${sourcePath}`);
    }
  }
}

function listFiles(rootDir, currentDir = rootDir) {
  const files = [];
  const entries = fs
    .readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`Symlinks are not allowed in staged artifacts: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...listFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath).split(path.sep).join('/'));
    } else {
      fail(`Unsupported staged artifact entry: ${fullPath}`);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resourceTreeDigest(resourcesDir) {
  if (!fs.existsSync(resourcesDir)) {
    return crypto.createHash('sha256').update('[]').digest('hex');
  }
  const rootStat = fs.lstatSync(resourcesDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`Companion resources path is not a regular directory: ${resourcesDir}`);
  }
  const records = listFiles(resourcesDir).map((relativePath) => {
    const filePath = path.join(resourcesDir, ...relativePath.split('/'));
    return {
      path: relativePath,
      size: fs.statSync(filePath).size,
      sha256: hashFile(filePath),
    };
  });
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function assertWindowsExecutable(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`Missing DB Access Manager executable: ${filePath}`);
  }

  const file = fs.openSync(filePath, 'r');
  const signature = Buffer.alloc(2);
  try {
    if (fs.readSync(file, signature, 0, signature.length, 0) !== signature.length) {
      fail(`DB Access Manager executable is empty or truncated: ${filePath}`);
    }
  } finally {
    fs.closeSync(file);
  }

  if (signature.toString('ascii') !== 'MZ') {
    fail(`DB Access Manager artifact is not a Windows PE executable: ${filePath}`);
  }
}

function createFileRecords(rootDir) {
  return listFiles(rootDir)
    .filter((relativePath) => relativePath !== MANIFEST_NAME)
    .map((relativePath) => {
      const filePath = path.join(rootDir, ...relativePath.split('/'));
      return {
        path: relativePath,
        size: fs.statSync(filePath).size,
        sha256: hashFile(filePath),
      };
    });
}

function defaultLegalFiles(projectRoot, companionRoot, companionRevision = null) {
  const report = requireDbAccessManagerLicenseCompliance({
    projectRoot,
    ...(companionRevision ? { companionRevision } : {}),
  });
  return [
    {
      source: path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'),
      destination: 'THIRD_PARTY_NOTICES.md',
    },
    {
      source: path.join(companionRoot, 'LICENSE'),
      destination: 'licenses/Tabularis-LICENSE.txt',
    },
    ...legalFilesForCompliance(projectRoot, report),
  ];
}

function validateStagedLegalFiles(stageDir, manifest, legalFiles) {
  const records = new Map((manifest?.files || []).map((record) => [record.path, record]));
  const destinations = new Set();
  for (const legalFile of legalFiles) {
    assertPortableRelativePath(legalFile.destination);
    const destination = legalFile.destination.split(path.sep).join('/');
    if (destinations.has(destination)) {
      fail(`Duplicate required legal destination: ${destination}`);
    }
    destinations.add(destination);
    if (!fs.existsSync(legalFile.source) || !fs.statSync(legalFile.source).isFile()) {
      fail(`Missing required legal file: ${legalFile.source}`);
    }
    const record = records.get(destination);
    const sourceSize = fs.statSync(legalFile.source).size;
    const sourceHash = hashFile(legalFile.source);
    if (!record || record.size !== sourceSize || record.sha256 !== sourceHash) {
      fail(`Staged DB Access Manager legal file is missing or stale: ${destination}`);
    }
    const stagedPath = path.join(stageDir, ...destination.split('/'));
    if (!fs.existsSync(stagedPath) || hashFile(stagedPath) !== sourceHash) {
      fail(`Staged DB Access Manager legal file failed source validation: ${destination}`);
    }
  }
  return manifest;
}

function stageArtifacts(options) {
  const {
    artifactDir,
    resourcesDir = path.join(artifactDir, 'resources'),
    stageDir,
    projectRoot,
    legalFiles = [],
    sourceMetadata,
    buildProvenance,
  } = options;
  if (!sourceMetadata?.version || typeof sourceMetadata.version !== 'string') {
    fail('DB Access Manager source version is missing.');
  }
  if (!/^[0-9a-f]{40}$/.test(String(sourceMetadata.revision || ''))) {
    fail('DB Access Manager source revision is invalid.');
  }
  const sourceExecutable = path.join(artifactDir, BINARY_NAME);
  assertSafeStageDirectory(stageDir, artifactDir, projectRoot);
  assertWindowsExecutable(sourceExecutable);
  const sourceHash = hashFile(sourceExecutable);
  if (
    !buildProvenance
    || path.resolve(String(buildProvenance.executablePath || '')) !== path.resolve(sourceExecutable)
    || buildProvenance.sourceRevision !== sourceMetadata.revision
    || buildProvenance.sha256 !== sourceHash
    || buildProvenance.resourcesSha256 !== resourceTreeDigest(resourcesDir)
  ) {
    fail('DB Access Manager staging requires the exact executable produced for the current source revision.');
  }

  const parentDir = path.dirname(stageDir);
  const temporaryDir = path.join(parentDir, `.${path.basename(stageDir)}.tmp-${process.pid}`);
  fs.mkdirSync(parentDir, { recursive: true });
  removeSafeStageDirectory(temporaryDir, artifactDir, projectRoot);
  fs.mkdirSync(temporaryDir, { recursive: true });

  try {
    fs.copyFileSync(sourceExecutable, path.join(temporaryDir, BINARY_NAME));

    if (fs.existsSync(resourcesDir)) {
      if (!fs.statSync(resourcesDir).isDirectory()) {
        fail(`Companion resources path is not a directory: ${resourcesDir}`);
      }
      copyDirectory(resourcesDir, path.join(temporaryDir, 'resources'));
    }

    for (const legalFile of legalFiles) {
      assertPortableRelativePath(legalFile.destination);
      if (!fs.existsSync(legalFile.source) || !fs.statSync(legalFile.source).isFile()) {
        fail(`Missing required legal file: ${legalFile.source}`);
      }
      const destination = path.join(
        temporaryDir,
        ...legalFile.destination.split(/[\\/]/),
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(legalFile.source, destination);
    }

    const manifest = {
      schemaVersion: 1,
      product: PRODUCT_NAME,
      version: sourceMetadata.version,
      platform: 'win32',
      arch: 'x64',
      targetTriple: TARGET_TRIPLE,
      executable: BINARY_NAME,
      sourceRevision: sourceMetadata.revision,
      sourceArtifactSha256: sourceHash,
      sourceResourcesSha256: buildProvenance.resourcesSha256,
      modifiedFrom: UPSTREAM,
      files: createFileRecords(temporaryDir),
    };
    fs.writeFileSync(
      path.join(temporaryDir, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    validateStagedLegalFiles(
      temporaryDir,
      validateStagedArtifacts(temporaryDir),
      legalFiles,
    );
    removeSafeStageDirectory(stageDir, artifactDir, projectRoot);
    fs.renameSync(temporaryDir, stageDir);
    return manifest;
  } catch (error) {
    removeSafeStageDirectory(temporaryDir, artifactDir, projectRoot);
    throw error;
  }
}

function validateStagedArtifacts(stageDir) {
  const manifestPath = path.join(stageDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    fail(`Missing staged artifact manifest: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Invalid staged artifact manifest: ${error.message}`);
  }

  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== PRODUCT_NAME ||
    manifest.platform !== 'win32' ||
    manifest.arch !== 'x64' ||
    manifest.targetTriple !== TARGET_TRIPLE ||
    manifest.executable !== BINARY_NAME ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    !/^[0-9a-f]{40}$/.test(String(manifest.sourceRevision || '')) ||
    !/^[0-9a-f]{64}$/.test(String(manifest.sourceArtifactSha256 || '')) ||
    !/^[0-9a-f]{64}$/.test(String(manifest.sourceResourcesSha256 || '')) ||
    manifest.modifiedFrom?.repository !== UPSTREAM.repository ||
    manifest.modifiedFrom?.release !== UPSTREAM.release ||
    manifest.modifiedFrom?.commit !== UPSTREAM.commit ||
    !Array.isArray(manifest.files)
  ) {
    fail('Staged DB Access Manager manifest has an unsupported identity or format.');
  }

  const manifestPaths = manifest.files.map((record) => record.path);
  for (const relativePath of manifestPaths) {
    assertPortableRelativePath(relativePath);
  }
  if (new Set(manifestPaths).size !== manifestPaths.length) {
    fail('Staged DB Access Manager manifest contains duplicate file paths.');
  }

  const actualPaths = listFiles(stageDir).filter(
    (relativePath) => relativePath !== MANIFEST_NAME,
  );
  const expectedPaths = [...manifestPaths].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail('Staged DB Access Manager files do not match the release manifest.');
  }

  for (const record of manifest.files) {
    const filePath = path.join(stageDir, ...record.path.split('/'));
    const size = fs.statSync(filePath).size;
    const sha256 = hashFile(filePath);
    if (size !== record.size || sha256 !== record.sha256) {
      fail(`Staged DB Access Manager file failed integrity validation: ${record.path}`);
    }
  }

  const executableRecord = manifest.files.find((record) => record.path === BINARY_NAME);
  if (!executableRecord || executableRecord.sha256 !== manifest.sourceArtifactSha256) {
    fail('Staged DB Access Manager executable does not match its build provenance.');
  }
  const stagedResourceRecords = manifest.files
    .filter((record) => record.path.startsWith('resources/'))
    .map((record) => ({ ...record, path: record.path.slice('resources/'.length) }));
  const stagedResourcesSha256 = crypto.createHash('sha256')
    .update(JSON.stringify(stagedResourceRecords))
    .digest('hex');
  if (stagedResourcesSha256 !== manifest.sourceResourcesSha256) {
    fail('Staged DB Access Manager resources do not match their build provenance.');
  }

  assertWindowsExecutable(path.join(stageDir, BINARY_NAME));
  return manifest;
}

function validateStagedSourceRevision(manifest, repository) {
  if (!manifest || manifest.sourceRevision !== repository?.revision) {
    fail('Staged DB Access Manager artifacts do not match the current companion revision.');
  }
  return manifest;
}

function main() {
  const mode = parseArguments(process.argv.slice(2));
  const configuration = resolveConfiguration();
  assertSafeStageDirectory(
    configuration.stageDir,
    configuration.artifactDir,
    configuration.projectRoot,
  );
  const repositoryBefore = validateCompanionRepository(
    configuration.companionRoot,
  );
  let legalFiles = defaultLegalFiles(
    configuration.projectRoot,
    configuration.companionRoot,
    repositoryBefore.revision,
  );

  if (mode === '--validate-only') {
    const manifest = validateStagedSourceRevision(
      validateStagedArtifacts(configuration.stageDir),
      repositoryBefore,
    );
    validateStagedLegalFiles(configuration.stageDir, manifest, legalFiles);
    console.log(`[db-access-manager] Validated ${configuration.stageDir}`);
    return;
  }

  const buildProvenance = buildCompanion(configuration, repositoryBefore.revision);

  const identity = validateCompanionIdentity(configuration.companionRoot);
  const repositoryAfterBuild = validateCompanionRepository(
    configuration.companionRoot,
  );
  if (repositoryAfterBuild.revision !== repositoryBefore.revision) {
    fail('DB Access Manager source revision changed while preparing the release.');
  }
  legalFiles = defaultLegalFiles(
    configuration.projectRoot,
    configuration.companionRoot,
    repositoryAfterBuild.revision,
  );
  const manifest = stageArtifacts({
    artifactDir: configuration.artifactDir,
    resourcesDir: configuration.resourcesDir,
    stageDir: configuration.stageDir,
    projectRoot: configuration.projectRoot,
    legalFiles,
    sourceMetadata: { ...identity, revision: repositoryAfterBuild.revision },
    buildProvenance,
  });
  const repositoryAfterStage = validateCompanionRepository(
    configuration.companionRoot,
  );
  if (repositoryAfterStage.revision !== repositoryAfterBuild.revision) {
    fail('DB Access Manager source revision changed while staging the release.');
  }
  validateStagedSourceRevision(manifest, repositoryAfterStage);
  legalFiles = defaultLegalFiles(
    configuration.projectRoot,
    configuration.companionRoot,
    repositoryAfterStage.revision,
  );
  validateStagedLegalFiles(configuration.stageDir, manifest, legalFiles);
  console.log(`[db-access-manager] Staged and validated ${configuration.stageDir}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[db-access-manager] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BINARY_NAME,
  MANIFEST_NAME,
  PRODUCT_NAME,
  STAGED_RELATIVE_DIR,
  TARGET_TRIPLE,
  UPSTREAM,
  assertSafeStageDirectory,
  assertWindowsExecutable,
  defaultLegalFiles,
  parseArguments,
  resolveConfiguration,
  stageArtifacts,
  validateCompanionIdentity,
  validateCompanionRepository,
  validateStagedArtifacts,
  validateStagedLegalFiles,
  validateStagedSourceRevision,
};
