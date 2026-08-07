#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  CARGO_LOCK_PATH,
  CARGO_MANIFEST_PATH,
  COMPANION_RELATIVE_DIRECTORY,
  FRONTEND_INVENTORY_PATH,
  FRONTEND_LICENSE_DIRECTORY,
  INVENTORY_SCHEMA_VERSION,
  MAX_LICENSE_FILE_BYTES,
  MAX_LICENSE_FILES_PER_PACKAGE,
  MAX_TOTAL_LICENSE_BYTES,
  PACKAGE_PATH,
  PNPM_LOCK_PATH,
  RUST_INVENTORY_PATH,
  RUST_LICENSE_DIRECTORY,
  buildPnpmProductionGraph,
  assertPathHasNoLinkedComponents,
  cargoPackageKey,
  isInside,
  parseCargoLockPackages,
  parseCargoManifestIdentity,
  parseJson,
  parsePnpmLock,
  safeSegment,
  sha256,
} = require('./db-access-manager-license-compliance');

const execFileAsync = promisify(execFile);
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|copyright|notice)([-_.].*)?$/i;
const CANONICAL_LICENSE_FILES = Object.freeze({
  'Apache-2.0': 'third_party_licenses/Apache-2.0.txt',
  'BSL-1.0': 'third_party_licenses/BSL-1.0.txt',
});

function requiredText(value, label, maximumLength = 2000) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function spdxLicenseIds(expression) {
  const source = requiredText(expression, 'Package license expression', 1000);
  const tokens = source.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/g) || [];
  if (tokens.join('').toLowerCase() !== source.replace(/\s+/g, '').toLowerCase()) {
    throw new TypeError(`Unsupported license expression: ${source}`);
  }
  const ids = [...new Set(tokens.filter((token) => !['(', ')', 'AND', 'OR', 'WITH'].includes(token.toUpperCase())))];
  if (!ids.length) throw new TypeError(`Unsupported license expression: ${source}`);
  return ids;
}

function normalizedPackageLicense(manifest, packageKey) {
  if (typeof manifest?.license === 'string' && manifest.license.trim()) return manifest.license.trim();
  if (manifest?.license && typeof manifest.license.type === 'string' && manifest.license.type.trim()) return manifest.license.type.trim();
  if (Array.isArray(manifest?.licenses)) {
    const expressions = manifest.licenses.map((entry) => (
      typeof entry === 'string' ? entry.trim() : String(entry?.type || '').trim()
    )).filter(Boolean);
    if (expressions.length) return [...new Set(expressions)].sort().join(' OR ');
  }
  return 'LicenseRef-See-License-Files';
}

async function existingLicenseSources({ packageDirectory, licenseFile = null }) {
  const realPackageDirectory = await fs.realpath(packageDirectory);
  const candidates = new Set();
  const entries = await fs.readdir(packageDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) candidates.add(path.join(packageDirectory, entry.name));
  }
  if (licenseFile) {
    const candidate = path.resolve(packageDirectory, licenseFile);
    if (!isInside(packageDirectory, candidate)) throw new TypeError('A package license_file escapes its package directory.');
    candidates.add(candidate);
  }
  const paths = [...candidates].sort((left, right) => left.localeCompare(right));
  if (paths.length > MAX_LICENSE_FILES_PER_PACKAGE) throw new TypeError('A package has too many license evidence files.');
  const resolved = [];
  for (const candidate of paths) {
    const realCandidate = await fs.realpath(candidate);
    if (!isInside(realPackageDirectory, realCandidate)) throw new TypeError('A package license file escapes its package directory.');
    resolved.push(realCandidate);
  }
  return resolved;
}

async function canonicalLicenseSources({ projectRoot, license, packageKey }) {
  const ids = spdxLicenseIds(license);
  const paths = ids.map((id) => CANONICAL_LICENSE_FILES[id]);
  if (paths.some((entry) => !entry)) {
    throw new TypeError(`${packageKey} has no license file and no approved canonical fallback for ${license}.`);
  }
  const licenseRoot = path.join(projectRoot, 'third_party_licenses');
  const resolved = [];
  for (const relativePath of paths) {
    const candidate = path.join(projectRoot, ...relativePath.split('/'));
    const realCandidate = await fs.realpath(candidate);
    if (!isInside(licenseRoot, realCandidate)) throw new TypeError(`${packageKey} canonical license evidence escapes third_party_licenses.`);
    resolved.push(realCandidate);
  }
  return resolved.sort((left, right) => left.localeCompare(right));
}

async function copyLicenseEvidence({ projectRoot, packageEntry, packageDirectory, licenseFile, outputDirectory, outputRelativeDirectory, identity }) {
  let sources = await existingLicenseSources({ packageDirectory, licenseFile });
  if (!sources.length) {
    sources = await canonicalLicenseSources({ projectRoot, license: packageEntry.license, packageKey: identity });
  }
  if (!sources.length || sources.length > MAX_LICENSE_FILES_PER_PACKAGE) throw new TypeError(`${identity} has invalid license evidence.`);

  const identityDigest = sha256(identity).slice(0, 10);
  const relativePaths = [];
  let totalBytes = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const stat = await fs.stat(sources[index]);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_LICENSE_FILE_BYTES) throw new TypeError(`${identity} has an invalid license file.`);
    const content = await fs.readFile(sources[index]);
    if (content.length !== stat.size || content.includes(0)) throw new TypeError(`${identity} has an invalid license file.`);
    totalBytes += content.length;
    const digest = sha256(content).slice(0, 12);
    const fileName = `${safeSegment(packageEntry.name)}-${safeSegment(packageEntry.version)}-${identityDigest}-${index + 1}-${digest}.txt`;
    await fs.writeFile(path.join(outputDirectory, fileName), content, { flag: 'wx' });
    relativePaths.push(`${outputRelativeDirectory}/${fileName}`);
  }
  return Object.freeze({ relativePaths: Object.freeze(relativePaths.sort()), totalBytes });
}

function cargoMetadataSource(entry) {
  if (entry?.source == null) return null;
  if (typeof entry.source === 'string') return entry.source;
  if (typeof entry.source.repr === 'string') return entry.source.repr;
  return String(entry.source);
}

function cargoMetadataIdentity(entry) {
  return `${entry.name}@${entry.version}|${cargoMetadataSource(entry) || 'workspace'}`;
}

async function generateRustInventory({ projectRoot, companionRoot, cargoMetadata, outputDirectory }) {
  const cargoManifestSource = await fs.readFile(path.join(projectRoot, ...CARGO_MANIFEST_PATH.split('/')), 'utf8');
  const cargoLockSource = await fs.readFile(path.join(projectRoot, ...CARGO_LOCK_PATH.split('/')), 'utf8');
  const rootIdentity = parseCargoManifestIdentity(cargoManifestSource);
  const lockedPackages = parseCargoLockPackages(cargoLockSource);
  const rootLockKey = cargoPackageKey({ ...rootIdentity, source: null, checksum: null });
  const expected = lockedPackages.filter((entry) => entry.key !== rootLockKey);
  const metadataPackages = Array.isArray(cargoMetadata?.packages) ? cargoMetadata.packages : [];
  const metadataRootId = String(cargoMetadata?.resolve?.root || '');
  const metadataRoot = metadataPackages.find((entry) => String(entry.id || '') === metadataRootId)
    || metadataPackages.find((entry) => entry.name === rootIdentity.name && entry.version === rootIdentity.version && cargoMetadataSource(entry) == null);
  if (!metadataRoot) throw new TypeError('Cargo metadata does not identify the companion root package.');

  const metadataByIdentity = new Map();
  for (const entry of metadataPackages) {
    if (entry === metadataRoot) continue;
    const key = cargoMetadataIdentity(entry);
    if (metadataByIdentity.has(key)) throw new TypeError(`Cargo metadata duplicates ${key}.`);
    metadataByIdentity.set(key, entry);
  }
  if (metadataByIdentity.size !== expected.length) throw new TypeError('Cargo metadata does not cover the exact Cargo.lock dependency graph.');

  let totalBytes = 0;
  const packages = [];
  for (const locked of expected) {
    const metadata = metadataByIdentity.get(`${locked.name}@${locked.version}|${locked.source || 'workspace'}`);
    if (!metadata) throw new TypeError(`${locked.key} is missing from Cargo metadata.`);
    const packageDirectory = path.dirname(path.resolve(requiredText(metadata.manifest_path, `${locked.key} manifest path`, 4000)));
    const license = metadata.license == null || metadata.license === ''
      ? 'LicenseRef-See-License-Files'
      : requiredText(metadata.license, `${locked.key} license`, 1000);
    const licenseFile = metadata.license_file
      ? path.relative(packageDirectory, path.resolve(metadata.license_file))
      : null;
    const base = { name: locked.name, version: locked.version, source: locked.source, checksum: locked.checksum, license };
    const evidence = await copyLicenseEvidence({
      projectRoot,
      packageEntry: base,
      packageDirectory,
      licenseFile,
      outputDirectory,
      outputRelativeDirectory: RUST_LICENSE_DIRECTORY,
      identity: locked.key,
    });
    totalBytes += evidence.totalBytes;
    if (totalBytes > MAX_TOTAL_LICENSE_BYTES) throw new TypeError('Rust dependency license evidence exceeds the total size limit.');
    packages.push(Object.freeze({ ...base, licenseFiles: evidence.relativePaths }));
  }
  packages.sort((left, right) => cargoPackageKey(left).localeCompare(cargoPackageKey(right)));
  return Object.freeze({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    ecosystem: 'cargo',
    generatedFrom: CARGO_LOCK_PATH,
    rootPackage: rootIdentity,
    packageCount: packages.length,
    packages: Object.freeze(packages),
  });
}

async function readWorkspaceManifests(projectRoot, companionRoot, lockDocument) {
  const manifests = {};
  const realCompanionRoot = await fs.realpath(companionRoot);
  for (const importerPath of Object.keys(lockDocument.importers || {}).sort()) {
    if (importerPath === '.') continue;
    const candidate = path.resolve(companionRoot, ...importerPath.split('/'), 'package.json');
    if (!isInside(companionRoot, candidate)) throw new TypeError(`Unsafe pnpm importer path: ${importerPath}`);
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError(`Unsafe pnpm importer manifest: ${importerPath}`);
      const realCandidate = await fs.realpath(candidate);
      if (!isInside(realCompanionRoot, realCandidate)) throw new TypeError(`Unsafe pnpm importer manifest: ${importerPath}`);
      manifests[importerPath] = parseJson(await fs.readFile(candidate, 'utf8'), `${COMPANION_RELATIVE_DIRECTORY}/${importerPath}/package.json`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return manifests;
}

async function packageDirectoryMatches(candidate, expected) {
  try {
    const manifest = parseJson(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'), `${expected.packageKey} package.json`);
    return manifest.name === expected.name && String(manifest.version) === expected.version
      ? Object.freeze({ directory: await fs.realpath(candidate), manifest })
      : null;
  } catch {
    return null;
  }
}

function encodedVirtualStorePrefix(entry) {
  return `${entry.name.replace('/', '+')}@${entry.version}`;
}

async function defaultPnpmPackageDirectoryResolver({ companionRoot, entry, virtualStoreEntries }) {
  const direct = await packageDirectoryMatches(path.join(companionRoot, 'node_modules', ...entry.name.split('/')), entry);
  if (direct) return direct;
  const prefix = encodedVirtualStorePrefix(entry);
  const matchingDirectories = virtualStoreEntries
    .filter((name) => name === prefix || name.startsWith(`${prefix}_`))
    .sort();
  for (const storeEntry of matchingDirectories) {
    const candidate = path.join(companionRoot, 'node_modules', '.pnpm', storeEntry, 'node_modules', ...entry.name.split('/'));
    const match = await packageDirectoryMatches(candidate, entry);
    if (match) return match;
  }
  throw new TypeError(`${entry.packageKey} is not installed under the companion node_modules tree.`);
}

async function generateFrontendInventory({ projectRoot, companionRoot, outputDirectory, packageDirectoryResolver = defaultPnpmPackageDirectoryResolver }) {
  const packageSource = await fs.readFile(path.join(projectRoot, ...PACKAGE_PATH.split('/')), 'utf8');
  const lockSource = await fs.readFile(path.join(projectRoot, ...PNPM_LOCK_PATH.split('/')), 'utf8');
  const packageDocument = parseJson(packageSource, PACKAGE_PATH);
  const lockDocument = parsePnpmLock(lockSource);
  const workspaceManifests = await readWorkspaceManifests(projectRoot, companionRoot, lockDocument);
  const graph = buildPnpmProductionGraph({ packageDocument, lockDocument, workspaceManifests });
  let virtualStoreEntries = [];
  try {
    virtualStoreEntries = (await fs.readdir(path.join(companionRoot, 'node_modules', '.pnpm'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (
      packageDirectoryResolver === defaultPnpmPackageDirectoryResolver
      && graph.packages.some((entry) => !entry.workspacePath)
    ) {
      throw new TypeError('Companion production dependencies are not installed; run the documented frozen pnpm install before inventory generation.');
    }
  }

  let totalBytes = 0;
  const packages = [];
  for (const graphEntry of graph.packages) {
    let packageDirectory;
    let manifest;
    if (graphEntry.workspacePath) {
      packageDirectory = path.join(companionRoot, ...graphEntry.workspacePath.split('/'));
      manifest = workspaceManifests[graphEntry.workspacePath];
    } else {
      const resolved = await packageDirectoryResolver({ companionRoot, entry: graphEntry, virtualStoreEntries });
      packageDirectory = resolved.directory;
      manifest = resolved.manifest;
    }
    const license = normalizedPackageLicense(manifest, graphEntry.packageKey);
    const packageEntry = { ...graphEntry, license };
    const evidence = await copyLicenseEvidence({
      projectRoot,
      packageEntry,
      packageDirectory,
      licenseFile: null,
      outputDirectory,
      outputRelativeDirectory: FRONTEND_LICENSE_DIRECTORY,
      identity: graphEntry.packageKey,
    });
    totalBytes += evidence.totalBytes;
    if (totalBytes > MAX_TOTAL_LICENSE_BYTES) throw new TypeError('Frontend dependency license evidence exceeds the total size limit.');
    packages.push(Object.freeze({ ...packageEntry, licenseFiles: evidence.relativePaths }));
  }
  packages.sort((left, right) => left.packageKey.localeCompare(right.packageKey));
  return Object.freeze({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    ecosystem: 'pnpm',
    generatedFrom: Object.freeze({ package: PACKAGE_PATH, lock: PNPM_LOCK_PATH }),
    packageCount: packages.length,
    snapshotCount: graph.snapshotCount,
    packages: Object.freeze(packages),
  });
}

async function loadLockedCargoMetadata({ companionRoot, cargoPath = 'cargo' }) {
  const manifestPath = path.join(companionRoot, 'src-tauri', 'Cargo.toml');
  const { stdout } = await execFileAsync(cargoPath, [
    'metadata', '--locked', '--format-version', '1', '--manifest-path', manifestPath,
  ], {
    cwd: companionRoot,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 96 * 1024 * 1024,
  });
  return parseJson(stdout, 'Cargo metadata');
}

async function replaceGeneratedOutput({ temporaryDirectory, finalDirectory, temporaryInventory, finalInventory }) {
  for (const candidate of [finalDirectory, finalInventory]) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new TypeError(`Refusing to replace linked license output: ${candidate}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await fs.rm(finalDirectory, { recursive: true, force: true });
  await fs.rename(temporaryDirectory, finalDirectory);
  await fs.rm(finalInventory, { force: true });
  await fs.rename(temporaryInventory, finalInventory);
}

async function generateDbAccessManagerLicenseInventories({
  projectRoot = path.resolve(__dirname, '..'),
  cargoMetadata = null,
  cargoPath = process.env.DEPLOYERX_CARGO_PATH || 'cargo',
  packageDirectoryResolver,
} = {}) {
  const root = path.resolve(projectRoot);
  const companionRoot = path.join(root, COMPANION_RELATIVE_DIRECTORY);
  const licenseRoot = path.join(root, 'third_party_licenses');
  assertPathHasNoLinkedComponents(root, licenseRoot, 'third_party_licenses');
  const generationId = crypto.randomUUID();
  const rustTemporaryDirectory = path.join(licenseRoot, `.db-access-manager-rust-${generationId}`);
  const frontendTemporaryDirectory = path.join(licenseRoot, `.db-access-manager-frontend-${generationId}`);
  const rustInventoryTemporary = path.join(licenseRoot, `.db-access-manager-rust-${generationId}.json`);
  const frontendInventoryTemporary = path.join(licenseRoot, `.db-access-manager-frontend-${generationId}.json`);
  await fs.mkdir(rustTemporaryDirectory, { recursive: true });
  await fs.mkdir(frontendTemporaryDirectory, { recursive: true });
  try {
    const metadata = cargoMetadata || await loadLockedCargoMetadata({ companionRoot, cargoPath });
    const rustInventory = await generateRustInventory({ projectRoot: root, companionRoot, cargoMetadata: metadata, outputDirectory: rustTemporaryDirectory });
    const frontendInventory = await generateFrontendInventory({
      projectRoot: root,
      companionRoot,
      outputDirectory: frontendTemporaryDirectory,
      ...(packageDirectoryResolver ? { packageDirectoryResolver } : {}),
    });
    await fs.writeFile(rustInventoryTemporary, `${JSON.stringify(rustInventory, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.writeFile(frontendInventoryTemporary, `${JSON.stringify(frontendInventory, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    assertPathHasNoLinkedComponents(root, licenseRoot, 'third_party_licenses');
    await replaceGeneratedOutput({
      temporaryDirectory: rustTemporaryDirectory,
      finalDirectory: path.join(root, ...RUST_LICENSE_DIRECTORY.split('/')),
      temporaryInventory: rustInventoryTemporary,
      finalInventory: path.join(root, ...RUST_INVENTORY_PATH.split('/')),
    });
    assertPathHasNoLinkedComponents(root, licenseRoot, 'third_party_licenses');
    await replaceGeneratedOutput({
      temporaryDirectory: frontendTemporaryDirectory,
      finalDirectory: path.join(root, ...FRONTEND_LICENSE_DIRECTORY.split('/')),
      temporaryInventory: frontendInventoryTemporary,
      finalInventory: path.join(root, ...FRONTEND_INVENTORY_PATH.split('/')),
    });
    return Object.freeze({ rustInventory, frontendInventory });
  } catch (error) {
    await Promise.all([
      fs.rm(rustTemporaryDirectory, { recursive: true, force: true }),
      fs.rm(frontendTemporaryDirectory, { recursive: true, force: true }),
      fs.rm(rustInventoryTemporary, { force: true }),
      fs.rm(frontendInventoryTemporary, { force: true }),
    ]).catch(() => {});
    throw error;
  }
}

async function runCli() {
  const result = await generateDbAccessManagerLicenseInventories();
  process.stdout.write(`${JSON.stringify({
    rustInventory: RUST_INVENTORY_PATH,
    rustPackageCount: result.rustInventory.packageCount,
    frontendInventory: FRONTEND_INVENTORY_PATH,
    frontendPackageCount: result.frontendInventory.packageCount,
  })}\n`);
}

if (require.main === module) runCli().catch((error) => {
  process.stderr.write(`${error.message || 'DB Access Manager license inventory generation failed.'}\n`);
  process.exitCode = 1;
});

module.exports = {
  CANONICAL_LICENSE_FILES,
  LICENSE_FILE_PATTERN,
  copyLicenseEvidence,
  defaultPnpmPackageDirectoryResolver,
  generateDbAccessManagerLicenseInventories,
  generateFrontendInventory,
  generateRustInventory,
  loadLockedCargoMetadata,
  normalizedPackageLicense,
  spdxLicenseIds,
};
