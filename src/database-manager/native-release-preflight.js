const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const INVENTORY_SCHEMA_VERSION = 1;
const INVENTORY_PATH = 'third_party_licenses/database-manager-rust.json';
const REVIEW_PATH = 'third_party_licenses/database-manager-rust-review.json';
const LOCK_PATH = 'native/deployerx-db-host/Cargo.lock';
const MANIFEST_PATH = 'native/deployerx-db-host/Cargo.toml';
const HOST_PATH = 'native/deployerx-db-host/dist/win32-x64/deployerx-db-host.exe';
const NOTICE_PATH = 'THIRD_PARTY_NOTICES.md';
const PACKAGE_PATH = 'package.json';
const GENERATED_LICENSE_DIRECTORY = 'third_party_licenses/database-manager-rust';
const MAX_INVENTORY_PACKAGES = 2000;
const MAX_LICENSE_FILES_PER_PACKAGE = 12;
const MAX_LICENSE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_LICENSE_BYTES = 64 * 1024 * 1024;
const MAX_PE_HEADER_OFFSET = 16 * 1024 * 1024;

function tomlString(block, key) {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  return match?.[1] || null;
}

function parseManifest(source) {
  const sections = new Map();
  let activeSection = '';
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^\[([^\]]+)\]\s*$/)?.[1] || '';
    if (heading) {
      activeSection = heading;
      if (!sections.has(activeSection)) sections.set(activeSection, []);
    } else if (activeSection) {
      sections.get(activeSection).push(line);
    }
  }
  const packageBlock = (sections.get('package') || []).join('\n');
  const dependencyBlock = (sections.get('dependencies') || []).join('\n');
  const dependencies = dependencyBlock.split(/\r?\n/).map((line) => line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1]).filter(Boolean);
  return Object.freeze({
    name: tomlString(packageBlock, 'name'),
    version: tomlString(packageBlock, 'version'),
    dependencies: Object.freeze([...new Set(dependencies)].sort())
  });
}

function parseLockPackages(source) {
  return Object.freeze(source.split(/(?=^\[\[package\]\]\s*$)/m).map((block) => {
    if (!block.startsWith('[[package]]')) return null;
    const name = tomlString(block, 'name');
    const version = tomlString(block, 'version');
    return name && version ? Object.freeze({ name, version, key: `${name}@${version}` }) : null;
  }).filter(Boolean));
}

function safeInventoryPath(value) {
  const source = String(value || '');
  if (!source || source.includes('\\') || source.includes('\0')) return null;
  const normalized = source.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized)) return null;
  const resolved = path.posix.normalize(normalized);
  if (resolved !== normalized || !resolved.startsWith(`${GENERATED_LICENSE_DIRECTORY}/`) || resolved.includes('../')) return null;
  return /-[0-9a-f]{12}\.txt$/.test(path.posix.basename(resolved)) ? resolved : null;
}

function inventoryPackages(input) {
  if (!input || input.schemaVersion !== INVENTORY_SCHEMA_VERSION || input.generatedFrom !== LOCK_PATH || !Array.isArray(input.packages) || !input.packages.length || input.packages.length > MAX_INVENTORY_PACKAGES || input.packageCount !== input.packages.length) return null;
  const packages = input.packages.map((entry) => {
    const name = String(entry?.name || '').trim();
    const version = String(entry?.version || '').trim();
    const license = String(entry?.license || '').trim();
    const licenseFiles = Array.isArray(entry?.licenseFiles) ? entry.licenseFiles.map(safeInventoryPath) : [];
    if (!name || name.length > 200 || !version || version.length > 100 || !license || license.length > 500 || !licenseFiles.length || licenseFiles.length > MAX_LICENSE_FILES_PER_PACKAGE || licenseFiles.some((item) => !item) || new Set(licenseFiles).size !== licenseFiles.length) return null;
    return Object.freeze({ name, version, license, licenseFiles: Object.freeze(licenseFiles), key: `${name}@${version}` });
  });
  if (packages.some((entry) => !entry)) return packages;
  const expectedOrder = [...packages].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  if (packages.some((entry, index) => entry.key !== expectedOrder[index].key || entry.licenseFiles.some((file, fileIndex) => file !== [...entry.licenseFiles].sort()[fileIndex]))) return null;
  return packages;
}

function licenseReview(input, { lockSource, inventorySource, inventory }) {
  const keys = ['schemaVersion', 'decision', 'reviewer', 'reviewedAt', 'lockPath', 'lockSha256', 'inventoryPath', 'inventorySha256', 'packageCount', 'acceptedLicenseExpressions'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(input, key))) return null;
  const reviewer = String(input.reviewer || '').trim();
  const reviewedAt = String(input.reviewedAt || '').trim();
  const expressions = Array.isArray(input.acceptedLicenseExpressions) ? input.acceptedLicenseExpressions.map((value) => String(value || '').trim()) : [];
  const expectedExpressions = [...new Set((inventory || []).map((entry) => entry.license))].sort();
  const lockSha256 = crypto.createHash('sha256').update(lockSource || '', 'utf8').digest('hex');
  const inventorySha256 = crypto.createHash('sha256').update(inventorySource || '', 'utf8').digest('hex');
  if (input.schemaVersion !== 1
    || input.decision !== 'approved'
    || !reviewer
    || reviewer.length > 200
    || !reviewedAt
    || reviewedAt.length > 100
    || !Number.isFinite(Date.parse(reviewedAt))
    || input.lockPath !== LOCK_PATH
    || input.inventoryPath !== INVENTORY_PATH
    || String(input.lockSha256 || '').toLowerCase() !== lockSha256
    || String(input.inventorySha256 || '').toLowerCase() !== inventorySha256
    || input.packageCount !== (inventory || []).length
    || expressions.length !== expectedExpressions.length
    || new Set(expressions).size !== expressions.length
    || expressions.some((value, index) => value !== expectedExpressions[index])) return null;
  return Object.freeze({ reviewer, reviewedAt, packageCount: input.packageCount });
}

function isInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
}

async function validateLicenseFile({ root, relativePath, packageName, packageVersion, fileSystem }) {
  const absolutePath = path.join(root, relativePath);
  const licenseRoot = path.join(root, GENERATED_LICENSE_DIRECTORY);
  const expectedPrefix = `${safeSegment(packageName)}-${safeSegment(packageVersion)}-`;
  if (!path.posix.basename(relativePath).startsWith(expectedPrefix)) throw new TypeError('License evidence does not belong to its inventory package.');
  const before = await fileSystem.lstat(absolutePath);
  if (!before.isFile() || before.size < 1 || before.size > MAX_LICENSE_FILE_BYTES) throw new TypeError('License evidence is not a bounded regular file.');
  const realPath = await fileSystem.realpath(absolutePath);
  if (!isInside(licenseRoot, realPath)) throw new TypeError('License evidence escapes the generated notice directory.');
  const content = await fileSystem.readFile(absolutePath);
  const after = await fileSystem.lstat(absolutePath);
  const finalRealPath = await fileSystem.realpath(absolutePath);
  if (!after.isFile() || content.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || finalRealPath !== realPath || content.includes(0)) throw new TypeError('License evidence changed or is invalid.');
  const expectedDigest = path.basename(relativePath).match(/-([0-9a-f]{12})\.txt$/)?.[1];
  const actualDigest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  if (!expectedDigest || actualDigest !== expectedDigest) throw new TypeError('License evidence digest does not match its inventory path.');
  return content.length;
}

async function validatePe32PlusX64(handle) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size < 128) return false;
  const dosHeader = Buffer.alloc(64);
  const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
  if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString('ascii', 0, 2) !== 'MZ') return false;
  const peOffset = dosHeader.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset > MAX_PE_HEADER_OFFSET || peOffset + 26 > stat.size) return false;
  const peHeader = Buffer.alloc(26);
  const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
  if (peRead.bytesRead !== peHeader.length || peHeader.toString('ascii', 0, 4) !== 'PE\0\0') return false;
  const machine = peHeader.readUInt16LE(4);
  const sectionCount = peHeader.readUInt16LE(6);
  const optionalHeaderSize = peHeader.readUInt16LE(20);
  const characteristics = peHeader.readUInt16LE(22);
  const optionalMagic = peHeader.readUInt16LE(24);
  const sectionTableEnd = peOffset + 24 + optionalHeaderSize + (sectionCount * 40);
  return machine === 0x8664
    && sectionCount >= 1
    && sectionCount <= 96
    && optionalHeaderSize >= 112
    && optionalHeaderSize <= 4096
    && optionalMagic === 0x20b
    && (characteristics & 0x0002) !== 0
    && sectionTableEnd <= stat.size;
}

async function auditNativeRelease({ rootPath = path.join(__dirname, '..', '..'), fileSystem = fs } = {}) {
  const root = path.resolve(rootPath);
  const errors = [];
  const addError = (code, detail) => errors.push(Object.freeze({ code, detail }));
  const readText = async (relativePath, code) => {
    try { return await fileSystem.readFile(path.join(root, relativePath), 'utf8'); }
    catch { addError(code, `${relativePath} is missing or unreadable.`); return null; }
  };

  const [manifestSource, lockSource, inventorySource, reviewSource, noticeSource, packageSource] = await Promise.all([
    readText(MANIFEST_PATH, 'NATIVE_MANIFEST_MISSING'),
    readText(LOCK_PATH, 'NATIVE_LOCK_MISSING'),
    readText(INVENTORY_PATH, 'NATIVE_LICENSE_INVENTORY_MISSING'),
    readText(REVIEW_PATH, 'NATIVE_LICENSE_REVIEW_MISSING'),
    readText(NOTICE_PATH, 'NATIVE_NOTICE_MISSING'),
    readText(PACKAGE_PATH, 'NATIVE_PACKAGE_CONFIG_MISSING')
  ]);

  const manifest = manifestSource ? parseManifest(manifestSource) : null;
  if (manifest && (!manifest.name || !manifest.version || !manifest.dependencies.length)) addError('NATIVE_MANIFEST_INVALID', `${MANIFEST_PATH} is incomplete.`);

  const lockedPackages = lockSource ? parseLockPackages(lockSource) : [];
  if (lockSource && !lockedPackages.length) addError('NATIVE_LOCK_INVALID', `${LOCK_PATH} has no package graph.`);

  let inventory = null;
  if (inventorySource) {
    try { inventory = inventoryPackages(JSON.parse(inventorySource)); }
    catch { inventory = null; }
    if (!inventory || inventory.some((entry) => !entry)) {
      addError('NATIVE_LICENSE_INVENTORY_INVALID', `${INVENTORY_PATH} does not satisfy schema version ${INVENTORY_SCHEMA_VERSION}.`);
      inventory = [];
    }
  }

  if (reviewSource && lockSource && inventorySource && inventory) {
    let review = null;
    try { review = licenseReview(JSON.parse(reviewSource), { lockSource, inventorySource, inventory }); }
    catch { review = null; }
    if (!review) addError('NATIVE_LICENSE_REVIEW_INVALID', `${REVIEW_PATH} is not an approval for the exact locked inventory.`);
  }

  const rootKey = manifest?.name && manifest?.version ? `${manifest.name}@${manifest.version}` : null;
  const expectedKeys = new Set(lockedPackages.map((entry) => entry.key).filter((key) => key !== rootKey));
  const inventoryKeys = new Set();
  const inventoryLicensePaths = new Set();
  let totalLicenseBytes = 0;
  for (const entry of inventory || []) {
    if (inventoryKeys.has(entry.key)) addError('NATIVE_LICENSE_INVENTORY_DUPLICATE', `${entry.key} appears more than once.`);
    inventoryKeys.add(entry.key);
    for (const licenseFile of entry.licenseFiles) {
      if (inventoryLicensePaths.has(licenseFile)) {
        addError('NATIVE_LICENSE_FILE_DUPLICATE', `${licenseFile} is assigned more than once.`);
        continue;
      }
      inventoryLicensePaths.add(licenseFile);
      try {
        totalLicenseBytes += await validateLicenseFile({ root, relativePath: licenseFile, packageName: entry.name, packageVersion: entry.version, fileSystem });
        if (totalLicenseBytes > MAX_TOTAL_LICENSE_BYTES) addError('NATIVE_LICENSE_FILES_EXCESSIVE', 'Native dependency license evidence exceeds the total size limit.');
      } catch {
        addError('NATIVE_LICENSE_FILE_INVALID', `${licenseFile} is missing, changed, or unsafe for ${entry.key}.`);
      }
    }
  }
  for (const key of expectedKeys) if (!inventoryKeys.has(key)) addError('NATIVE_LICENSE_PACKAGE_MISSING', `${key} is absent from the license inventory.`);
  for (const key of inventoryKeys) if (!expectedKeys.has(key)) addError('NATIVE_LICENSE_PACKAGE_UNLOCKED', `${key} is not present in the locked graph.`);
  for (const dependency of manifest?.dependencies || []) {
    if (!lockedPackages.some((entry) => entry.name === dependency)) addError('NATIVE_DIRECT_DEPENDENCY_UNLOCKED', `${dependency} is not present in the locked graph.`);
  }

  if (noticeSource && (!noticeSource.includes('## Database Manager Rust Dependencies') || !noticeSource.includes(INVENTORY_PATH) || !noticeSource.includes(REVIEW_PATH))) {
    addError('NATIVE_NOTICE_INCOMPLETE', `${NOTICE_PATH} does not reference the locked Rust inventory.`);
  }

  if (packageSource) {
    try {
      const packageConfig = JSON.parse(packageSource);
      const files = packageConfig?.build?.files || [];
      const resources = packageConfig?.build?.extraResources || [];
      if (packageConfig?.scripts?.['prepackage:win'] !== 'node src/database-manager/native-release-preflight.js --require-ready') addError('NATIVE_PACKAGE_PREFLIGHT_MISSING', 'Windows packaging is not guarded by the native release preflight.');
      if (!files.includes('THIRD_PARTY_NOTICES.md') || !files.includes('third_party_licenses/**/*')) addError('NATIVE_PACKAGE_NOTICES_EXCLUDED', 'Packaged files do not include native dependency notices.');
      if (!resources.some((entry) => entry?.from === HOST_PATH && entry?.to === 'database-manager/win32-x64/deployerx-db-host.exe')) addError('NATIVE_PACKAGE_HOST_EXCLUDED', 'The Windows sidecar is not configured as an extra resource.');
    } catch {
      addError('NATIVE_PACKAGE_CONFIG_INVALID', `${PACKAGE_PATH} is not valid JSON.`);
    }
  }

  let hostHandle = null;
  try { hostHandle = await fileSystem.open(path.join(root, HOST_PATH), 'r'); }
  catch { addError('NATIVE_HOST_MISSING', `${HOST_PATH} is missing or unreadable.`); }
  if (hostHandle) {
    try {
      if (!await validatePe32PlusX64(hostHandle)) addError('NATIVE_HOST_INVALID', `${HOST_PATH} is not a valid PE32+ x64 executable.`);
    } catch { addError('NATIVE_HOST_INVALID', `${HOST_PATH} is not a valid PE32+ x64 executable.`); }
    finally { await hostHandle.close(); }
  }

  return Object.freeze({
    schemaVersion: 1,
    ready: errors.length === 0,
    manifest: Object.freeze({ name: manifest?.name || null, version: manifest?.version || null }),
    lockedPackageCount: expectedKeys.size,
    inventoriedPackageCount: inventoryKeys.size,
    errors: Object.freeze(errors)
  });
}

async function runCli() {
  const report = await auditNativeRelease();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--require-ready') && !report.ready) process.exitCode = 1;
}

if (require.main === module) runCli().catch((error) => {
  process.stderr.write(`${error.message || 'Native release preflight failed.'}\n`);
  process.exitCode = 1;
});

module.exports = {
  HOST_PATH,
  INVENTORY_PATH,
  INVENTORY_SCHEMA_VERSION,
  LOCK_PATH,
  REVIEW_PATH,
  auditNativeRelease,
  inventoryPackages,
  isInside,
  licenseReview,
  parseLockPackages,
  parseManifest,
  safeInventoryPath,
  validatePe32PlusX64
};
