'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const INVENTORY_SCHEMA_VERSION = 1;
const REVIEW_SCHEMA_VERSION = 2;
const COMPANION_RELATIVE_DIRECTORY = 'DeployerX DB Manager';
const CARGO_MANIFEST_PATH = `${COMPANION_RELATIVE_DIRECTORY}/src-tauri/Cargo.toml`;
const CARGO_LOCK_PATH = `${COMPANION_RELATIVE_DIRECTORY}/src-tauri/Cargo.lock`;
const PACKAGE_PATH = `${COMPANION_RELATIVE_DIRECTORY}/package.json`;
const PNPM_LOCK_PATH = `${COMPANION_RELATIVE_DIRECTORY}/pnpm-lock.yaml`;
const NOTICE_PATH = 'THIRD_PARTY_NOTICES.md';
const UPSTREAM_LICENSE_PATH = `${COMPANION_RELATIVE_DIRECTORY}/LICENSE`;
const RUST_INVENTORY_PATH = 'third_party_licenses/db-access-manager-rust.json';
const RUST_LICENSE_DIRECTORY = 'third_party_licenses/db-access-manager-rust';
const FRONTEND_INVENTORY_PATH = 'third_party_licenses/db-access-manager-frontend.json';
const FRONTEND_LICENSE_DIRECTORY = 'third_party_licenses/db-access-manager-frontend';
const REVIEW_PATH = 'third_party_licenses/db-access-manager-review.json';
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_INVENTORY_PACKAGES = 3000;
const MAX_LICENSE_FILES_PER_PACKAGE = 12;
const MAX_LICENSE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_LICENSE_BYTES = 96 * 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requiredText(value, label, maximumLength = 1000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) {
    throw new TypeError(`${label} is invalid.`);
  }
  return text;
}

function portableRelativePath(value, label) {
  const source = requiredText(value, label, 2000);
  if (source.includes('\\') || path.posix.isAbsolute(source)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const normalized = path.posix.normalize(source);
  if (normalized !== source || normalized === '.' || normalized.startsWith('../')) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function isInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
}

function tomlString(block, key) {
  return block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm'))?.[1] || null;
}

function parseCargoManifestIdentity(source) {
  const packageBlock = String(source || '').match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] || '';
  const name = tomlString(packageBlock, 'name');
  const version = tomlString(packageBlock, 'version');
  if (!name || !version) throw new TypeError(`${CARGO_MANIFEST_PATH} has no package identity.`);
  return Object.freeze({ name, version });
}

function cargoPackageKey(entry) {
  return `${entry.name}@${entry.version}|${entry.source || 'workspace'}|${entry.checksum || ''}`;
}

function parseCargoLockPackages(source) {
  const packages = String(source || '').split(/(?=^\[\[package\]\]\s*$)/m).map((block) => {
    if (!block.startsWith('[[package]]')) return null;
    const name = tomlString(block, 'name');
    const version = tomlString(block, 'version');
    if (!name || !version) return null;
    const entry = {
      name,
      version,
      source: tomlString(block, 'source'),
      checksum: tomlString(block, 'checksum'),
    };
    return Object.freeze({ ...entry, key: cargoPackageKey(entry) });
  }).filter(Boolean);
  if (!packages.length || packages.length > MAX_INVENTORY_PACKAGES) {
    throw new TypeError(`${CARGO_LOCK_PATH} has an invalid package graph.`);
  }
  const keys = packages.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError(`${CARGO_LOCK_PATH} contains duplicate package identities.`);
  }
  return Object.freeze(packages.sort((left, right) => left.key.localeCompare(right.key)));
}

function normalizeDependencyReference(entry, label) {
  const value = typeof entry === 'string' ? entry : entry?.version;
  return requiredText(value, label, 2000);
}

function productionDependencies(document) {
  return {
    ...(document?.dependencies || {}),
    ...(document?.optionalDependencies || {}),
  };
}

function parsePnpmPackageKey(packageKey) {
  const separator = String(packageKey || '').lastIndexOf('@');
  if (separator < 1) throw new TypeError(`Unsupported pnpm package identity: ${packageKey}`);
  const name = packageKey.slice(0, separator);
  const version = packageKey.slice(separator + 1);
  if (!name || !version || name.includes('@npm:')) {
    throw new TypeError(`Unsupported pnpm package identity: ${packageKey}`);
  }
  return Object.freeze({ name, version });
}

function normalizeWorkspacePath(importerPath, reference) {
  const target = requiredText(reference, 'pnpm workspace reference', 2000);
  if (!target.startsWith('link:')) return null;
  const importerDirectory = importerPath;
  const normalized = path.posix.normalize(path.posix.join(importerDirectory, target.slice(5)));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new TypeError(`Unsafe pnpm workspace reference: ${reference}`);
  }
  return normalized.replace(/^\.\//, '');
}

function packageKeyForSnapshot(snapshotKey, packageKeys) {
  const matches = packageKeys.filter((candidate) => (
    snapshotKey === candidate || snapshotKey.startsWith(`${candidate}(`)
  ));
  if (matches.length !== 1) {
    throw new TypeError(`The pnpm snapshot ${snapshotKey} has no unambiguous package record.`);
  }
  return matches[0];
}

function assertImporterMatchesManifest(importer, manifest, importerPath) {
  const manifestDependencies = Object.keys(productionDependencies(manifest)).sort();
  const importerDependencies = Object.keys(productionDependencies(importer)).sort();
  if (
    manifestDependencies.length !== importerDependencies.length
    || manifestDependencies.some((name, index) => name !== importerDependencies[index])
  ) {
    throw new TypeError(`The pnpm importer ${importerPath} does not exactly lock its production dependencies.`);
  }
}

function buildPnpmProductionGraph({ packageDocument, lockDocument, workspaceManifests = {} } = {}) {
  if (!packageDocument || typeof packageDocument !== 'object' || Array.isArray(packageDocument)) {
    throw new TypeError(`${PACKAGE_PATH} is invalid.`);
  }
  if (!lockDocument || String(lockDocument.lockfileVersion) !== '9.0') {
    throw new TypeError(`${PNPM_LOCK_PATH} must use lockfileVersion 9.0.`);
  }
  const importers = lockDocument.importers;
  const packageRecords = lockDocument.packages;
  const snapshots = lockDocument.snapshots;
  if (!importers?.['.'] || !packageRecords || !snapshots) {
    throw new TypeError(`${PNPM_LOCK_PATH} has an incomplete dependency graph.`);
  }
  assertImporterMatchesManifest(importers['.'], packageDocument, '.');

  const packageKeys = Object.keys(packageRecords).sort((left, right) => right.length - left.length);
  const visitedSnapshots = new Set();
  const visitedWorkspaces = new Set();
  const registryPackages = new Map();
  const workspacePackages = new Map();
  const queue = Object.entries(productionDependencies(importers['.'])).map(([name, entry]) => ({
    name,
    reference: normalizeDependencyReference(entry, `pnpm dependency ${name}`),
    importerPath: '.',
  }));

  while (queue.length) {
    const request = queue.shift();
    const workspacePath = normalizeWorkspacePath(request.importerPath, request.reference);
    if (workspacePath) {
      if (visitedWorkspaces.has(workspacePath)) continue;
      const importer = importers[workspacePath];
      const manifest = workspaceManifests[workspacePath];
      if (!importer || !manifest) {
        throw new TypeError(`The production workspace ${workspacePath} is missing its importer or package manifest.`);
      }
      const name = requiredText(manifest.name, `Workspace ${workspacePath} package name`, 300);
      const version = requiredText(manifest.version, `Workspace ${workspacePath} package version`, 100);
      if (name !== request.name) {
        throw new TypeError(`The workspace ${workspacePath} does not provide ${request.name}.`);
      }
      assertImporterMatchesManifest(importer, manifest, workspacePath);
      visitedWorkspaces.add(workspacePath);
      workspacePackages.set(`workspace:${workspacePath}`, Object.freeze({
        name,
        version,
        packageKey: `workspace:${workspacePath}`,
        workspacePath,
        snapshotKeys: Object.freeze([]),
      }));
      for (const [nameKey, entry] of Object.entries(productionDependencies(importer))) {
        queue.push({
          name: nameKey,
          reference: normalizeDependencyReference(entry, `pnpm dependency ${nameKey}`),
          importerPath: workspacePath,
        });
      }
      continue;
    }

    const candidates = [
      `${request.name}@${request.reference}`,
      request.reference,
      request.reference.startsWith('/') ? request.reference.slice(1) : null,
    ].filter(Boolean);
    const snapshotKey = candidates.find((candidate) => Object.hasOwn(snapshots, candidate));
    if (!snapshotKey) {
      throw new TypeError(`Production dependency ${request.name}@${request.reference} is not locked.`);
    }
    if (visitedSnapshots.has(snapshotKey)) continue;
    visitedSnapshots.add(snapshotKey);

    const packageKey = packageKeyForSnapshot(snapshotKey, packageKeys);
    const identity = parsePnpmPackageKey(packageKey);
    const existing = registryPackages.get(packageKey);
    const snapshotKeys = [...(existing?.snapshotKeys || []), snapshotKey].sort();
    registryPackages.set(packageKey, Object.freeze({
      ...identity,
      packageKey,
      workspacePath: null,
      snapshotKeys: Object.freeze(snapshotKeys),
    }));

    const snapshot = snapshots[snapshotKey];
    const runtimeDependencies = {
      ...(snapshot.dependencies || {}),
      ...(snapshot.optionalDependencies || {}),
    };
    for (const [name, reference] of Object.entries(runtimeDependencies)) {
      queue.push({
        name,
        reference: normalizeDependencyReference(reference, `pnpm dependency ${name}`),
        importerPath: request.importerPath,
      });
    }
  }

  const packages = [...registryPackages.values(), ...workspacePackages.values()]
    .sort((left, right) => left.packageKey.localeCompare(right.packageKey));
  if (!packages.length || packages.length > MAX_INVENTORY_PACKAGES) {
    throw new TypeError('The production pnpm dependency graph is invalid.');
  }
  return Object.freeze({
    packageCount: packages.length,
    snapshotCount: visitedSnapshots.size,
    packages: Object.freeze(packages),
  });
}

function parseJson(source, label) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON: ${error.message}`);
  }
}

function parsePnpmLock(source) {
  try {
    const document = yaml.load(source, { schema: yaml.JSON_SCHEMA });
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('expected an object');
    return document;
  } catch (error) {
    throw new TypeError(`${PNPM_LOCK_PATH} is not valid YAML: ${error.message}`);
  }
}

function normalizeLicenseFiles(value, directory) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_LICENSE_FILES_PER_PACKAGE) return null;
  const files = value.map((entry) => {
    try {
      const relativePath = portableRelativePath(entry, 'License evidence path');
      if (!relativePath.startsWith(`${directory}/`)) return null;
      if (!/-[0-9a-f]{12}\.txt$/.test(path.posix.basename(relativePath))) return null;
      return relativePath;
    } catch {
      return null;
    }
  });
  if (files.some((entry) => !entry) || new Set(files).size !== files.length) return null;
  const sorted = [...files].sort();
  if (files.some((entry, index) => entry !== sorted[index])) return null;
  return Object.freeze(files);
}

function normalizeRustInventory(document) {
  if (
    !document
    || document.schemaVersion !== INVENTORY_SCHEMA_VERSION
    || document.ecosystem !== 'cargo'
    || document.generatedFrom !== CARGO_LOCK_PATH
    || !document.rootPackage
    || !Array.isArray(document.packages)
    || !document.packages.length
    || document.packages.length > MAX_INVENTORY_PACKAGES
    || document.packageCount !== document.packages.length
  ) return null;
  let rootPackage;
  try {
    rootPackage = Object.freeze({
      name: requiredText(document.rootPackage.name, 'Cargo root package name', 300),
      version: requiredText(document.rootPackage.version, 'Cargo root package version', 100),
    });
  } catch {
    return null;
  }
  const packages = document.packages.map((entry) => {
    try {
      const normalized = {
        name: requiredText(entry?.name, 'Cargo package name', 300),
        version: requiredText(entry?.version, 'Cargo package version', 100),
        source: entry?.source == null ? null : requiredText(entry.source, 'Cargo package source', 2000),
        checksum: entry?.checksum == null ? null : requiredText(entry.checksum, 'Cargo package checksum', 200),
        license: requiredText(entry?.license, 'Cargo package license', 1000),
        licenseFiles: normalizeLicenseFiles(entry?.licenseFiles, RUST_LICENSE_DIRECTORY),
      };
      if (!normalized.licenseFiles) return null;
      return Object.freeze({ ...normalized, key: cargoPackageKey(normalized) });
    } catch {
      return null;
    }
  });
  if (packages.some((entry) => !entry)) return null;
  const sorted = [...packages].sort((left, right) => left.key.localeCompare(right.key));
  if (packages.some((entry, index) => entry.key !== sorted[index].key)) return null;
  return Object.freeze({ rootPackage, packages: Object.freeze(packages) });
}

function normalizeFrontendInventory(document) {
  if (
    !document
    || document.schemaVersion !== INVENTORY_SCHEMA_VERSION
    || document.ecosystem !== 'pnpm'
    || document.generatedFrom?.package !== PACKAGE_PATH
    || document.generatedFrom?.lock !== PNPM_LOCK_PATH
    || !Array.isArray(document.packages)
    || !document.packages.length
    || document.packages.length > MAX_INVENTORY_PACKAGES
    || document.packageCount !== document.packages.length
    || !Number.isInteger(document.snapshotCount)
    || document.snapshotCount < 0
  ) return null;
  const packages = document.packages.map((entry) => {
    try {
      const packageKey = requiredText(entry?.packageKey, 'pnpm package key', 2000);
      const workspacePath = entry?.workspacePath == null
        ? null
        : portableRelativePath(entry.workspacePath, 'pnpm workspace path');
      const snapshotKeys = Array.isArray(entry?.snapshotKeys)
        ? entry.snapshotKeys.map((value) => requiredText(value, 'pnpm snapshot key', 2000))
        : null;
      if (!snapshotKeys || new Set(snapshotKeys).size !== snapshotKeys.length) return null;
      const sortedSnapshots = [...snapshotKeys].sort();
      if (snapshotKeys.some((value, index) => value !== sortedSnapshots[index])) return null;
      if ((workspacePath && packageKey !== `workspace:${workspacePath}`) || (!workspacePath && !snapshotKeys.length)) return null;
      const licenseFiles = normalizeLicenseFiles(entry?.licenseFiles, FRONTEND_LICENSE_DIRECTORY);
      if (!licenseFiles) return null;
      return Object.freeze({
        name: requiredText(entry?.name, 'pnpm package name', 300),
        version: requiredText(entry?.version, 'pnpm package version', 100),
        packageKey,
        workspacePath,
        snapshotKeys: Object.freeze(snapshotKeys),
        license: requiredText(entry?.license, 'pnpm package license', 1000),
        licenseFiles,
      });
    } catch {
      return null;
    }
  });
  if (packages.some((entry) => !entry)) return null;
  const sorted = [...packages].sort((left, right) => left.packageKey.localeCompare(right.packageKey));
  if (packages.some((entry, index) => entry.packageKey !== sorted[index].packageKey)) return null;
  const snapshotCount = new Set(packages.flatMap((entry) => entry.snapshotKeys)).size;
  if (snapshotCount !== document.snapshotCount) return null;
  return Object.freeze({ packages: Object.freeze(packages), snapshotCount });
}

function exactStringArray(value) {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => String(entry || '').trim());
  if (entries.some((entry) => !entry) || new Set(entries).size !== entries.length) return null;
  const sorted = [...entries].sort();
  return entries.some((entry, index) => entry !== sorted[index]) ? null : Object.freeze(entries);
}

function expectedLicenseExpressions(rustInventory, frontendInventory) {
  return Object.freeze([...new Set([
    ...rustInventory.packages.map((entry) => entry.license),
    ...frontendInventory.packages.map((entry) => entry.license),
  ])].sort());
}

function normalizeHashBindings(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) return null;
  const records = value.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, 'path')
      || !Object.hasOwn(entry, 'sha256')
    ) return null;
    try {
      const relativePath = portableRelativePath(entry.path, `${label} path`);
      const digest = requiredText(entry.sha256, `${label} SHA-256`, 64);
      if (!/^[0-9a-f]{64}$/.test(digest)) return null;
      return Object.freeze({ path: relativePath, sha256: digest });
    } catch {
      return null;
    }
  });
  if (records.some((entry) => !entry)) return null;
  const sorted = [...records].sort((left, right) => left.path.localeCompare(right.path));
  if (
    records.some((entry, index) => entry.path !== sorted[index].path)
    || new Set(records.map((entry) => entry.path)).size !== records.length
  ) return null;
  return Object.freeze(records);
}

function createReviewBinding({
  cargoLockSource,
  pnpmLockSource,
  packageSource,
  rustInventorySource,
  frontendInventorySource,
  rustInventory,
  frontendInventory,
  companionRevision,
  noticeSource,
  upstreamLicenseSource,
  workspaceManifestBindings = [],
  licenseEvidenceBindings = [],
}) {
  const revision = requiredText(companionRevision, 'Companion revision', 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new TypeError('Companion revision is invalid.');
  const workspaceManifests = normalizeHashBindings(workspaceManifestBindings, 'Workspace manifest');
  const licenseEvidence = normalizeHashBindings(
    licenseEvidenceBindings,
    'License evidence',
    { allowEmpty: false },
  );
  if (!workspaceManifests || !licenseEvidence) throw new TypeError('Review file bindings are invalid.');
  return Object.freeze({
    companionRevision: revision,
    cargoLockPath: CARGO_LOCK_PATH,
    cargoLockSha256: sha256(cargoLockSource),
    pnpmLockPath: PNPM_LOCK_PATH,
    pnpmLockSha256: sha256(pnpmLockSource),
    packagePath: PACKAGE_PATH,
    packageSha256: sha256(packageSource),
    rustInventoryPath: RUST_INVENTORY_PATH,
    rustInventorySha256: sha256(rustInventorySource),
    frontendInventoryPath: FRONTEND_INVENTORY_PATH,
    frontendInventorySha256: sha256(frontendInventorySource),
    noticePath: NOTICE_PATH,
    noticeSha256: sha256(noticeSource),
    upstreamLicensePath: UPSTREAM_LICENSE_PATH,
    upstreamLicenseSha256: sha256(upstreamLicenseSource),
    workspaceManifests,
    licenseEvidence,
    rustPackageCount: rustInventory.packages.length,
    frontendPackageCount: frontendInventory.packages.length,
    acceptedLicenseExpressions: expectedLicenseExpressions(rustInventory, frontendInventory),
  });
}

function normalizeApprovedReview(document, binding) {
  const keys = [
    'schemaVersion', 'decision', 'reviewer', 'reviewedAt',
    'companionRevision',
    'cargoLockPath', 'cargoLockSha256', 'pnpmLockPath', 'pnpmLockSha256',
    'packagePath', 'packageSha256', 'rustInventoryPath', 'rustInventorySha256',
    'frontendInventoryPath', 'frontendInventorySha256', 'rustPackageCount',
    'frontendPackageCount', 'acceptedLicenseExpressions', 'noticePath',
    'noticeSha256', 'upstreamLicensePath', 'upstreamLicenseSha256',
    'workspaceManifests', 'licenseEvidence',
  ];
  if (
    !document
    || typeof document !== 'object'
    || Array.isArray(document)
    || Object.keys(document).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(document, key))
  ) return null;
  const expressions = exactStringArray(document.acceptedLicenseExpressions);
  const workspaceManifests = normalizeHashBindings(document.workspaceManifests, 'Workspace manifest');
  const licenseEvidence = normalizeHashBindings(
    document.licenseEvidence,
    'License evidence',
    { allowEmpty: false },
  );
  const reviewer = String(document.reviewer || '').trim();
  const reviewedAt = String(document.reviewedAt || '').trim();
  if (
    document.schemaVersion !== REVIEW_SCHEMA_VERSION
    || document.decision !== 'approved'
    || !reviewer
    || reviewer.length > 200
    || !reviewedAt
    || reviewedAt.length > 100
    || !Number.isFinite(Date.parse(reviewedAt))
    || !expressions
    || !workspaceManifests
    || !licenseEvidence
  ) return null;
  for (const [key, expected] of Object.entries(binding)) {
    if (key === 'acceptedLicenseExpressions') {
      if (
        expressions.length !== expected.length
        || expressions.some((value, index) => value !== expected[index])
      ) return null;
    } else if (key === 'workspaceManifests') {
      if (JSON.stringify(workspaceManifests) !== JSON.stringify(expected)) return null;
    } else if (key === 'licenseEvidence') {
      if (JSON.stringify(licenseEvidence) !== JSON.stringify(expected)) return null;
    } else if (document[key] !== expected) {
      return null;
    }
  }
  return Object.freeze({ reviewer, reviewedAt });
}

function assertPathHasNoLinkedComponents(root, absolutePath, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(absolutePath);
  if (!isInside(resolvedRoot, resolvedPath)) throw new TypeError(`${label} escapes the project root.`);

  const relative = path.relative(resolvedRoot, resolvedPath);
  let current = resolvedRoot;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new TypeError(`${label} contains a symbolic link or junction.`);
  }

  const realRoot = fs.realpathSync(resolvedRoot);
  const realPath = fs.realpathSync(resolvedPath);
  if (!isInside(realRoot, realPath)) throw new TypeError(`${label} escapes the real project root.`);
}

function readBoundedSource(root, relativePath) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  assertPathHasNoLinkedComponents(root, absolutePath, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_SOURCE_BYTES) {
    throw new TypeError(`${relativePath} is not a bounded regular file.`);
  }
  const content = fs.readFileSync(absolutePath);
  if (content.length !== stat.size || content.includes(0)) throw new TypeError(`${relativePath} is invalid.`);
  return content.toString('utf8');
}

function loadWorkspaceManifests(projectRoot, lockDocument) {
  const manifests = {};
  for (const importerPath of Object.keys(lockDocument.importers || {}).sort()) {
    if (importerPath === '.') continue;
    const safePath = portableRelativePath(importerPath, 'pnpm importer path');
    const relativePackagePath = `${COMPANION_RELATIVE_DIRECTORY}/${safePath}/package.json`;
    const packagePath = path.join(projectRoot, ...relativePackagePath.split('/'));
    if (!fs.existsSync(packagePath)) continue;
    manifests[safePath] = parseJson(
      readBoundedSource(projectRoot, relativePackagePath),
      relativePackagePath,
    );
  }
  return manifests;
}

function resolveCompanionRevision(projectRoot, { runGitCommand } = {}) {
  const companionRoot = path.join(path.resolve(projectRoot), COMPANION_RELATIVE_DIRECTORY);
  const result = runGitCommand
    ? runGitCommand(companionRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
    : spawnSync('git', ['-C', companionRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
  if (result?.error || result?.status !== 0) throw new TypeError('Unable to read the DB Access Manager companion revision.');
  const revision = String(result.stdout || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new TypeError('The DB Access Manager companion revision is invalid.');
  return revision;
}

function workspaceManifestReviewBindings(projectRoot, frontendGraph) {
  const paths = [...new Set(frontendGraph.packages
    .filter((entry) => entry.workspacePath)
    .map((entry) => `${COMPANION_RELATIVE_DIRECTORY}/${entry.workspacePath}/package.json`))].sort();
  return Object.freeze(paths.map((relativePath) => Object.freeze({
    path: relativePath,
    sha256: sha256(readBoundedSource(projectRoot, relativePath)),
  })));
}

function licenseEvidenceReviewBindings(projectRoot, rustInventory, frontendInventory) {
  const paths = [
    ...rustInventory.packages.flatMap((entry) => entry.licenseFiles),
    ...frontendInventory.packages.flatMap((entry) => entry.licenseFiles),
  ].sort();
  return Object.freeze(paths.map((relativePath) => Object.freeze({
    path: relativePath,
    sha256: sha256(readBoundedSource(projectRoot, relativePath)),
  })));
}

function createCurrentReviewBinding({
  projectRoot,
  companionRevision,
  cargoLockSource,
  pnpmLockSource,
  packageSource,
  rustInventorySource,
  frontendInventorySource,
  rustInventory,
  frontendInventory,
  frontendGraph,
}) {
  return createReviewBinding({
    cargoLockSource,
    pnpmLockSource,
    packageSource,
    rustInventorySource,
    frontendInventorySource,
    rustInventory,
    frontendInventory,
    companionRevision,
    noticeSource: readBoundedSource(projectRoot, NOTICE_PATH),
    upstreamLicenseSource: readBoundedSource(projectRoot, UPSTREAM_LICENSE_PATH),
    workspaceManifestBindings: workspaceManifestReviewBindings(projectRoot, frontendGraph),
    licenseEvidenceBindings: licenseEvidenceReviewBindings(
      projectRoot,
      rustInventory,
      frontendInventory,
    ),
  });
}

function graphPackageMatchesInventory(graphEntry, inventoryEntry) {
  return graphEntry.name === inventoryEntry.name
    && graphEntry.version === inventoryEntry.version
    && graphEntry.packageKey === inventoryEntry.packageKey
    && graphEntry.workspacePath === inventoryEntry.workspacePath
    && graphEntry.snapshotKeys.length === inventoryEntry.snapshotKeys.length
    && graphEntry.snapshotKeys.every((key, index) => key === inventoryEntry.snapshotKeys[index]);
}

function validateLicenseEvidence({ projectRoot, entry, relativePath, directory }) {
  const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
  const evidenceRoot = path.join(projectRoot, ...directory.split('/'));
  const expectedPrefix = `${safeSegment(entry.name)}-${safeSegment(entry.version)}-`;
  if (!path.posix.basename(relativePath).startsWith(expectedPrefix)) {
    throw new TypeError('License evidence is assigned to the wrong package.');
  }
  const before = fs.lstatSync(absolutePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_LICENSE_FILE_BYTES) {
    throw new TypeError('License evidence is not a bounded regular file.');
  }
  const realPath = fs.realpathSync(absolutePath);
  if (!isInside(evidenceRoot, realPath)) throw new TypeError('License evidence escapes its generated directory.');
  const content = fs.readFileSync(absolutePath);
  const after = fs.lstatSync(absolutePath);
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || content.length !== before.size || content.includes(0)) {
    throw new TypeError('License evidence changed or is invalid.');
  }
  const expectedDigest = path.posix.basename(relativePath).match(/-([0-9a-f]{12})\.txt$/)?.[1];
  if (!expectedDigest || sha256(content).slice(0, 12) !== expectedDigest) {
    throw new TypeError('License evidence digest does not match its path.');
  }
  return content.length;
}

function auditDbAccessManagerLicenseCompliance({
  projectRoot = path.resolve(__dirname, '..'),
  companionRevision = null,
  runGitCommand,
} = {}) {
  const root = path.resolve(projectRoot);
  const errors = [];
  const addError = (code, detail) => errors.push(Object.freeze({ code, detail }));
  const readSource = (relativePath, code) => {
    try {
      return readBoundedSource(root, relativePath);
    } catch {
      addError(code, `${relativePath} is missing, unreadable, or unsafe.`);
      return null;
    }
  };

  const cargoManifestSource = readSource(CARGO_MANIFEST_PATH, 'DB_ACCESS_CARGO_MANIFEST_MISSING');
  const cargoLockSource = readSource(CARGO_LOCK_PATH, 'DB_ACCESS_CARGO_LOCK_MISSING');
  const packageSource = readSource(PACKAGE_PATH, 'DB_ACCESS_PACKAGE_MISSING');
  const pnpmLockSource = readSource(PNPM_LOCK_PATH, 'DB_ACCESS_PNPM_LOCK_MISSING');
  const rustInventorySource = readSource(RUST_INVENTORY_PATH, 'DB_ACCESS_RUST_INVENTORY_MISSING');
  const frontendInventorySource = readSource(FRONTEND_INVENTORY_PATH, 'DB_ACCESS_FRONTEND_INVENTORY_MISSING');
  const reviewSource = readSource(REVIEW_PATH, 'DB_ACCESS_LICENSE_REVIEW_MISSING');
  const noticeSource = readSource(NOTICE_PATH, 'DB_ACCESS_NOTICE_MISSING');
  const upstreamLicenseSource = readSource(UPSTREAM_LICENSE_PATH, 'DB_ACCESS_UPSTREAM_LICENSE_MISSING');

  let cargoIdentity = null;
  let lockedCargoPackages = [];
  let packageDocument = null;
  let lockDocument = null;
  let frontendGraph = null;
  let rustInventory = null;
  let frontendInventory = null;
  let exactCompanionRevision = null;
  let reviewBinding = null;

  try {
    if (companionRevision == null) {
      exactCompanionRevision = resolveCompanionRevision(root, { runGitCommand });
    } else {
      exactCompanionRevision = requiredText(companionRevision, 'Companion revision', 40).toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(exactCompanionRevision)) throw new TypeError('Companion revision is invalid.');
    }
  } catch (error) {
    addError('DB_ACCESS_COMPANION_REVISION_INVALID', error.message);
  }

  if (cargoManifestSource) {
    try { cargoIdentity = parseCargoManifestIdentity(cargoManifestSource); }
    catch (error) { addError('DB_ACCESS_CARGO_MANIFEST_INVALID', error.message); }
  }
  if (cargoLockSource) {
    try { lockedCargoPackages = parseCargoLockPackages(cargoLockSource); }
    catch (error) { addError('DB_ACCESS_CARGO_LOCK_INVALID', error.message); }
  }
  if (packageSource) {
    try { packageDocument = parseJson(packageSource, PACKAGE_PATH); }
    catch (error) { addError('DB_ACCESS_PACKAGE_INVALID', error.message); }
  }
  if (pnpmLockSource) {
    try { lockDocument = parsePnpmLock(pnpmLockSource); }
    catch (error) { addError('DB_ACCESS_PNPM_LOCK_INVALID', error.message); }
  }
  if (packageDocument && lockDocument) {
    try {
      frontendGraph = buildPnpmProductionGraph({
        packageDocument,
        lockDocument,
        workspaceManifests: loadWorkspaceManifests(root, lockDocument),
      });
    } catch (error) {
      addError('DB_ACCESS_FRONTEND_GRAPH_INVALID', error.message);
    }
  }
  if (rustInventorySource) {
    try { rustInventory = normalizeRustInventory(parseJson(rustInventorySource, RUST_INVENTORY_PATH)); }
    catch { rustInventory = null; }
    if (!rustInventory) addError('DB_ACCESS_RUST_INVENTORY_INVALID', `${RUST_INVENTORY_PATH} has an invalid schema.`);
  }
  if (frontendInventorySource) {
    try { frontendInventory = normalizeFrontendInventory(parseJson(frontendInventorySource, FRONTEND_INVENTORY_PATH)); }
    catch { frontendInventory = null; }
    if (!frontendInventory) addError('DB_ACCESS_FRONTEND_INVENTORY_INVALID', `${FRONTEND_INVENTORY_PATH} has an invalid schema.`);
  }

  if (rustInventory && cargoIdentity && lockedCargoPackages.length) {
    if (
      rustInventory.rootPackage.name !== cargoIdentity.name
      || rustInventory.rootPackage.version !== cargoIdentity.version
    ) {
      addError('DB_ACCESS_RUST_ROOT_STALE', 'The Rust inventory root package does not match Cargo.toml.');
    }
    const rootKey = cargoPackageKey({ ...cargoIdentity, source: null, checksum: null });
    const expected = new Map(lockedCargoPackages.filter((entry) => entry.key !== rootKey).map((entry) => [entry.key, entry]));
    const actual = new Map();
    for (const entry of rustInventory.packages) {
      if (actual.has(entry.key)) addError('DB_ACCESS_RUST_PACKAGE_DUPLICATE', `${entry.key} appears more than once.`);
      actual.set(entry.key, entry);
    }
    for (const key of expected.keys()) {
      if (!actual.has(key)) addError('DB_ACCESS_RUST_PACKAGE_MISSING', `${key} is absent from the Rust license inventory.`);
    }
    for (const key of actual.keys()) {
      if (!expected.has(key)) addError('DB_ACCESS_RUST_PACKAGE_UNLOCKED', `${key} is not present in Cargo.lock.`);
    }
  }

  if (frontendInventory && frontendGraph) {
    const expected = new Map(frontendGraph.packages.map((entry) => [entry.packageKey, entry]));
    const actual = new Map();
    for (const entry of frontendInventory.packages) {
      if (actual.has(entry.packageKey)) addError('DB_ACCESS_FRONTEND_PACKAGE_DUPLICATE', `${entry.packageKey} appears more than once.`);
      actual.set(entry.packageKey, entry);
    }
    for (const [key, graphEntry] of expected) {
      const inventoryEntry = actual.get(key);
      if (!inventoryEntry) addError('DB_ACCESS_FRONTEND_PACKAGE_MISSING', `${key} is absent from the frontend license inventory.`);
      else if (!graphPackageMatchesInventory(graphEntry, inventoryEntry)) addError('DB_ACCESS_FRONTEND_PACKAGE_STALE', `${key} does not match the locked production graph.`);
    }
    for (const key of actual.keys()) {
      if (!expected.has(key)) addError('DB_ACCESS_FRONTEND_PACKAGE_UNLOCKED', `${key} is not in the locked production graph.`);
    }
  }

  const legalRelativePaths = new Set([RUST_INVENTORY_PATH, FRONTEND_INVENTORY_PATH, REVIEW_PATH]);
  let totalLicenseBytes = 0;
  for (const [inventory, directory, ecosystem] of [
    [rustInventory, RUST_LICENSE_DIRECTORY, 'RUST'],
    [frontendInventory, FRONTEND_LICENSE_DIRECTORY, 'FRONTEND'],
  ]) {
    const seen = new Set();
    for (const entry of inventory?.packages || []) {
      for (const relativePath of entry.licenseFiles) {
        legalRelativePaths.add(relativePath);
        if (seen.has(relativePath)) {
          addError(`DB_ACCESS_${ecosystem}_LICENSE_FILE_DUPLICATE`, `${relativePath} is assigned more than once.`);
          continue;
        }
        seen.add(relativePath);
        try {
          totalLicenseBytes += validateLicenseEvidence({ projectRoot: root, entry, relativePath, directory });
          if (totalLicenseBytes > MAX_TOTAL_LICENSE_BYTES) {
            addError('DB_ACCESS_LICENSE_FILES_EXCESSIVE', 'Companion license evidence exceeds the total size limit.');
          }
        } catch {
          addError(`DB_ACCESS_${ecosystem}_LICENSE_FILE_INVALID`, `${relativePath} is missing, changed, or unsafe for ${entry.name}@${entry.version}.`);
        }
      }
    }
  }

  if (
    cargoLockSource
    && pnpmLockSource
    && packageSource
    && rustInventorySource
    && frontendInventorySource
    && noticeSource
    && upstreamLicenseSource
    && rustInventory
    && frontendInventory
    && frontendGraph
    && exactCompanionRevision
  ) {
    try {
      reviewBinding = createCurrentReviewBinding({
        projectRoot: root,
        companionRevision: exactCompanionRevision,
        cargoLockSource,
        pnpmLockSource,
        packageSource,
        rustInventorySource,
        frontendInventorySource,
        rustInventory,
        frontendInventory,
        frontendGraph,
      });
    } catch (error) {
      addError('DB_ACCESS_LICENSE_BINDING_INVALID', error.message);
    }
  }

  if (reviewSource && reviewBinding) {
    let approved = null;
    try { approved = normalizeApprovedReview(parseJson(reviewSource, REVIEW_PATH), reviewBinding); }
    catch { approved = null; }
    if (!approved) addError('DB_ACCESS_LICENSE_REVIEW_INVALID', `${REVIEW_PATH} is not an approval for the exact companion dependency inventories.`);
  }

  return Object.freeze({
    schemaVersion: 1,
    ready: errors.length === 0,
    rustPackageCount: rustInventory?.packages.length || 0,
    frontendPackageCount: frontendInventory?.packages.length || 0,
    companionRevision: exactCompanionRevision,
    reviewBinding,
    legalRelativePaths: Object.freeze([...legalRelativePaths].sort()),
    errors: Object.freeze(errors),
  });
}

function requireDbAccessManagerLicenseCompliance(options = {}) {
  const report = auditDbAccessManagerLicenseCompliance(options);
  if (!report.ready) {
    const first = report.errors[0];
    const error = new Error(`DB Access Manager dependency-license gate failed: ${first?.detail || 'unknown compliance failure'}`);
    error.code = 'DB_ACCESS_LICENSE_COMPLIANCE_FAILED';
    error.errors = report.errors;
    throw error;
  }
  return report;
}

function legalFilesForCompliance(projectRoot, report) {
  if (!report?.ready) throw new TypeError('A ready DB Access Manager license report is required.');
  return report.legalRelativePaths.map((relativePath) => ({
    source: path.join(projectRoot, ...relativePath.split('/')),
    destination: `licenses/dependencies/${relativePath.replace(/^third_party_licenses\//, '')}`,
  }));
}

function runCli() {
  const report = auditDbAccessManagerLicenseCompliance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--require-ready') && !report.ready) process.exitCode = 1;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message || 'DB Access Manager license compliance check failed.'}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CARGO_LOCK_PATH,
  CARGO_MANIFEST_PATH,
  COMPANION_RELATIVE_DIRECTORY,
  FRONTEND_INVENTORY_PATH,
  FRONTEND_LICENSE_DIRECTORY,
  INVENTORY_SCHEMA_VERSION,
  MAX_LICENSE_FILE_BYTES,
  MAX_LICENSE_FILES_PER_PACKAGE,
  MAX_TOTAL_LICENSE_BYTES,
  NOTICE_PATH,
  PACKAGE_PATH,
  PNPM_LOCK_PATH,
  REVIEW_PATH,
  REVIEW_SCHEMA_VERSION,
  RUST_INVENTORY_PATH,
  RUST_LICENSE_DIRECTORY,
  UPSTREAM_LICENSE_PATH,
  assertPathHasNoLinkedComponents,
  auditDbAccessManagerLicenseCompliance,
  buildPnpmProductionGraph,
  cargoPackageKey,
  createReviewBinding,
  createCurrentReviewBinding,
  expectedLicenseExpressions,
  isInside,
  legalFilesForCompliance,
  normalizeApprovedReview,
  normalizeHashBindings,
  normalizeFrontendInventory,
  normalizeRustInventory,
  parseCargoLockPackages,
  parseCargoManifestIdentity,
  parseJson,
  parsePnpmLock,
  portableRelativePath,
  readBoundedSource,
  resolveCompanionRevision,
  requireDbAccessManagerLicenseCompliance,
  safeSegment,
  sha256,
};
