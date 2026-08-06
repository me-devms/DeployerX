const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { INVENTORY_PATH, INVENTORY_SCHEMA_VERSION, LOCK_PATH } = require('./native-release-preflight');

const execFileAsync = promisify(execFile);
const GENERATED_LICENSE_DIRECTORY = 'third_party_licenses/database-manager-rust';
const MAX_METADATA_PACKAGES = 2000;
const MAX_LICENSE_FILES_PER_PACKAGE = 12;
const MAX_LICENSE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_LICENSE_BYTES = 64 * 1024 * 1024;
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|copyright|notice)([-_.].*)?$/i;
const CANONICAL_LICENSE_FILES = Object.freeze({
  'Apache-2.0': 'third_party_licenses/Apache-2.0.txt',
  'BSL-1.0': 'third_party_licenses/BSL-1.0.txt',
  MIT: 'third_party_licenses/MIT.txt'
});

function requiredText(value, label, maximumLength = 500) {
  const text = String(value || '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function safeSegment(value, label) {
  const text = requiredText(value, label, 200);
  const safe = text.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  if (!safe || safe === '.' || safe === '..') throw new TypeError(`${label} is invalid.`);
  return safe;
}

function isInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function rustVersionParts(value, label) {
  const match = requiredText(value, label, 30).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) throw new TypeError(`${label} is invalid.`);
  return Object.freeze(match.slice(1).map((part) => Number(part || 0)));
}

function compareRustVersions(left, right) {
  const leftParts = rustVersionParts(left, 'Cargo package Rust version');
  const rightParts = rustVersionParts(right, 'Cargo root Rust version');
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function spdxLicenseIds(expression) {
  const source = requiredText(expression, 'Cargo package license expression', 500);
  const tokens = source.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/g) || [];
  if (tokens.join('').toLowerCase() !== source.replace(/\s+/g, '').toLowerCase()) throw new TypeError('Cargo package license expression is unsupported.');
  const ids = [...new Set(tokens.filter((token) => !['(', ')', 'AND', 'OR', 'WITH'].includes(token.toUpperCase())))];
  if (!ids.length) throw new TypeError('Cargo package license expression is unsupported.');
  return Object.freeze(ids);
}

async function canonicalLicenseFiles(packageEntry, rootPath, fileSystem = fs) {
  const relativePaths = spdxLicenseIds(packageEntry.license).map((licenseId) => CANONICAL_LICENSE_FILES[licenseId]);
  if (relativePaths.some((relativePath) => !relativePath)) throw new TypeError(`Cargo package ${packageEntry.key} has no approved canonical license fallback.`);
  const licenseRoot = path.join(rootPath, 'third_party_licenses');
  const resolved = [];
  for (const relativePath of relativePaths) {
    const candidate = path.join(rootPath, relativePath);
    const realCandidate = await fileSystem.realpath(candidate);
    if (!isInside(licenseRoot, realCandidate)) throw new TypeError(`Cargo package ${packageEntry.key} canonical license file escapes the notice directory.`);
    resolved.push(realCandidate);
  }
  return Object.freeze(resolved.sort((left, right) => left.localeCompare(right)));
}

function normalizedMetadataPackages(metadata = {}) {
  if (!Array.isArray(metadata.packages) || !metadata.packages.length || metadata.packages.length > MAX_METADATA_PACKAGES) throw new TypeError('Cargo metadata package graph is invalid.');
  const rootId = String(metadata.resolve?.root || '');
  const rootPackage = metadata.packages.find((entry) => String(entry.id || '') === rootId)
    || metadata.packages.find((entry) => entry.name === 'deployerx-db-host');
  if (!rootPackage) throw new TypeError('Cargo metadata root package is invalid.');
  const rootRustVersion = requiredText(rootPackage.rust_version, 'Cargo root Rust version', 30);
  rustVersionParts(rootRustVersion, 'Cargo root Rust version');
  const seen = new Set();
  return Object.freeze(metadata.packages.filter((entry) => entry !== rootPackage).map((entry) => {
    const name = requiredText(entry.name, 'Cargo package name', 200);
    const version = requiredText(entry.version, 'Cargo package version', 100);
    const key = `${name}@${version}`;
    if (seen.has(key)) throw new TypeError(`Cargo package ${key} is duplicated.`);
    seen.add(key);
    if (entry.rust_version && compareRustVersions(entry.rust_version, rootRustVersion) > 0) throw new TypeError(`Cargo package ${key} requires Rust ${entry.rust_version}, above the root ${rootRustVersion} toolchain.`);
    const manifestPath = path.resolve(requiredText(entry.manifest_path, 'Cargo package manifest path', 4000));
    const packageDirectory = path.dirname(manifestPath);
    const license = entry.license == null || entry.license === '' ? 'LicenseRef-See-License-Files' : requiredText(entry.license, 'Cargo package license', 500);
    return Object.freeze({ name, version, key, packageDirectory, license, licenseFile: entry.license_file ? path.resolve(packageDirectory, String(entry.license_file)) : null });
  }).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)));
}

async function discoverLicenseFiles(packageEntry, fileSystem = fs) {
  const candidates = new Set();
  const realPackageDirectory = await fileSystem.realpath(packageEntry.packageDirectory);
  const directoryEntries = await fileSystem.readdir(packageEntry.packageDirectory, { withFileTypes: true });
  for (const entry of directoryEntries) {
    if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) candidates.add(path.join(packageEntry.packageDirectory, entry.name));
  }
  if (packageEntry.licenseFile) {
    if (!isInside(packageEntry.packageDirectory, packageEntry.licenseFile)) throw new TypeError(`Cargo package ${packageEntry.key} license file escapes its package.`);
    candidates.add(packageEntry.licenseFile);
  }
  const paths = [...candidates].sort((left, right) => left.localeCompare(right));
  if (!paths.length) throw Object.assign(new TypeError(`Cargo package ${packageEntry.key} license files are missing.`), { code: 'NATIVE_LICENSE_FILES_MISSING' });
  if (paths.length > MAX_LICENSE_FILES_PER_PACKAGE) throw new TypeError(`Cargo package ${packageEntry.key} license files are excessive.`);
  const resolvedPaths = [];
  for (const candidate of paths) {
    const realCandidate = await fileSystem.realpath(candidate);
    if (!isInside(realPackageDirectory, realCandidate)) throw new TypeError(`Cargo package ${packageEntry.key} license file escapes its package.`);
    resolvedPaths.push(realCandidate);
  }
  return Object.freeze(resolvedPaths);
}

async function generateNativeLicenseInventory({ metadata, rootPath, fileSystem = fs } = {}) {
  const root = path.resolve(requiredText(rootPath, 'Inventory root path', 4000));
  const packages = normalizedMetadataPackages(metadata);
  const licenseRoot = path.join(root, 'third_party_licenses');
  const outputDirectory = path.join(root, GENERATED_LICENSE_DIRECTORY);
  const inventoryPath = path.join(root, INVENTORY_PATH);
  if (!isInside(licenseRoot, outputDirectory) || !isInside(licenseRoot, inventoryPath)) throw new TypeError('Native license output path is invalid.');

  const generationId = crypto.randomUUID();
  const stagingDirectory = path.join(licenseRoot, `.database-manager-rust-${generationId}`);
  const inventoryTemporaryPath = `${inventoryPath}.${generationId}.tmp`;
  let totalBytes = 0;
  const inventoryPackages = [];
  await fileSystem.mkdir(stagingDirectory, { recursive: true });
  try {
    for (const packageEntry of packages) {
      let sourcePaths;
      try {
        sourcePaths = await discoverLicenseFiles(packageEntry, fileSystem);
      } catch (error) {
        if (error?.code !== 'NATIVE_LICENSE_FILES_MISSING') throw error;
        sourcePaths = await canonicalLicenseFiles(packageEntry, root, fileSystem);
      }
      const licenseFiles = [];
      for (let index = 0; index < sourcePaths.length; index += 1) {
        const sourceStat = await fileSystem.stat(sourcePaths[index]);
        if (!sourceStat.isFile() || !sourceStat.size || sourceStat.size > MAX_LICENSE_FILE_BYTES) throw new TypeError(`Cargo package ${packageEntry.key} has an invalid license file.`);
        const content = await fileSystem.readFile(sourcePaths[index]);
        if (content.length !== sourceStat.size || content.includes(0)) throw new TypeError(`Cargo package ${packageEntry.key} has an invalid license file.`);
        totalBytes += content.length;
        if (totalBytes > MAX_TOTAL_LICENSE_BYTES) throw new TypeError('Native dependency license files exceed the total size limit.');
        const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
        const fileName = `${safeSegment(packageEntry.name, 'Cargo package name')}-${safeSegment(packageEntry.version, 'Cargo package version')}-${index + 1}-${digest}.txt`;
        await fileSystem.writeFile(path.join(stagingDirectory, fileName), content, { flag: 'wx' });
        licenseFiles.push(`${GENERATED_LICENSE_DIRECTORY}/${fileName}`.replace(/\\/g, '/'));
      }
      inventoryPackages.push(Object.freeze({ name: packageEntry.name, version: packageEntry.version, license: packageEntry.license, licenseFiles: Object.freeze(licenseFiles) }));
    }

    const inventory = Object.freeze({
      schemaVersion: INVENTORY_SCHEMA_VERSION,
      generatedFrom: LOCK_PATH,
      packageCount: inventoryPackages.length,
      packages: Object.freeze(inventoryPackages)
    });
    await fileSystem.writeFile(inventoryTemporaryPath, `${JSON.stringify(inventory, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fileSystem.rm(outputDirectory, { recursive: true, force: true });
    await fileSystem.rename(stagingDirectory, outputDirectory);
    await fileSystem.rm(inventoryPath, { force: true });
    await fileSystem.rename(inventoryTemporaryPath, inventoryPath);
    return inventory;
  } catch (error) {
    await fileSystem.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    await fileSystem.rm(inventoryTemporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadLockedCargoMetadata({ rootPath, cargoPath = 'cargo' } = {}) {
  const root = path.resolve(requiredText(rootPath, 'Inventory root path', 4000));
  const manifestPath = path.join(root, 'native', 'deployerx-db-host', 'Cargo.toml');
  const { stdout } = await execFileAsync(cargoPath, ['metadata', '--locked', '--format-version', '1', '--manifest-path', manifestPath], {
    cwd: root,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

async function runCli() {
  const rootPath = path.join(__dirname, '..', '..');
  const metadata = await loadLockedCargoMetadata({ rootPath, cargoPath: process.env.DEPLOYERX_CARGO_PATH || 'cargo' });
  const inventory = await generateNativeLicenseInventory({ metadata, rootPath });
  process.stdout.write(`${JSON.stringify({ generated: INVENTORY_PATH, packageCount: inventory.packageCount })}\n`);
}

if (require.main === module) runCli().catch((error) => {
  process.stderr.write(`${error.message || 'Native license inventory generation failed.'}\n`);
  process.exitCode = 1;
});

module.exports = {
  CANONICAL_LICENSE_FILES,
  GENERATED_LICENSE_DIRECTORY,
  LICENSE_FILE_PATTERN,
  MAX_LICENSE_FILE_BYTES,
  MAX_METADATA_PACKAGES,
  MAX_TOTAL_LICENSE_BYTES,
  canonicalLicenseFiles,
  compareRustVersions,
  discoverLicenseFiles,
  generateNativeLicenseInventory,
  isInside,
  loadLockedCargoMetadata,
  normalizedMetadataPackages,
  rustVersionParts,
  safeSegment,
  spdxLicenseIds
};
