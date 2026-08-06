const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SidecarDriverRuntime, resolveDatabaseDriverHostPath } = require('./driver-runtime');
const { runPackagedApplicationSmoke } = require('./packaged-ui-smoke');
const { runMicrosoftDefenderScan } = require('./windows-defender-scan');
const {
  INVENTORY_PATH,
  LOCK_PATH,
  REVIEW_PATH,
  inventoryPackages,
  validatePe32PlusX64
} = require('./native-release-preflight');
const {
  bundledWindowsDependencies,
  inspectPeImports,
  reviewedWindowsDependencies,
  signatureMatches,
  verifyAuthenticode
} = require('./windows-binary-trust');

const WINDOWS_ARTIFACTS_ENV = 'DEPLOYERX_DB_WINDOWS_ARTIFACTS_JSON';
const WINDOWS_SIGNER_ENV = 'DEPLOYERX_DB_WINDOWS_SIGNER_CERT_SHA256';
const REPORT_SCHEMA_VERSION = 1;
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_APPLICATION_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_HOST_BYTES = 512 * 1024 * 1024;
const MAX_NOTICE_BYTES = 2 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_BYTES = 256 * 1024;
const MAX_LICENSE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_LICENSE_BYTES = 64 * 1024 * 1024;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;
const LAYOUT_KINDS = Object.freeze(['installed', 'portable']);
const NOTICE_PATH = 'THIRD_PARTY_NOTICES.md';
const APPLICATION_ARCHIVE_NAME = 'app.asar';

class WindowsArtifactAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WindowsArtifactAcceptanceError';
    this.code = code;
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(value, key));
}

function normalizeAbsolutePath(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 32767 || input.includes('\0') || !path.isAbsolute(input)) {
    throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_CONFIGURATION_INVALID');
  }
  return path.resolve(input);
}

function configuredWindowsArtifacts(environment = process.env) {
  const serialized = environment[WINDOWS_ARTIFACTS_ENV];
  if (serialized === undefined || String(serialized).trim() === '') throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_CONFIGURATION_MISSING');
  const source = String(serialized);
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIGURATION_BYTES) throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_CONFIGURATION_TOO_LARGE');
  let input;
  try { input = JSON.parse(source); }
  catch { throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_CONFIGURATION_JSON_INVALID'); }
  if (!exactKeys(input, LAYOUT_KINDS)) throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_CONFIGURATION_INVALID');
  const normalized = {};
  for (const kind of LAYOUT_KINDS) {
    const layout = input[kind];
    if (!exactKeys(layout, ['applicationExecutable', 'resourcesPath'])) throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_CONFIGURATION_INVALID');
    normalized[kind] = Object.freeze({
      applicationExecutable: normalizeAbsolutePath(layout.applicationExecutable),
      resourcesPath: normalizeAbsolutePath(layout.resourcesPath)
    });
  }
  if (normalized.installed.applicationExecutable === normalized.portable.applicationExecutable
    || normalized.installed.resourcesPath === normalized.portable.resourcesPath) {
    throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_LAYOUTS_NOT_DISTINCT');
  }
  return Object.freeze(normalized);
}

function configuredSignerFingerprint(environment = process.env) {
  const value = environment[WINDOWS_SIGNER_ENV];
  if (value === undefined || String(value).trim() === '') throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_SIGNER_CONFIGURATION_MISSING');
  const fingerprint = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_SIGNER_CONFIGURATION_INVALID');
  return fingerprint;
}

function isInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeCode(error, fallback) {
  const code = String(error?.code || '');
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function defaultArchiveReader() {
  let asar = null;
  return Object.freeze({
    async readFile(archivePath, entryPath) {
      if (!asar) {
        try { asar = require('@electron/asar'); }
        catch { throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_ASAR_READER_UNAVAILABLE'); }
      }
      return asar.extractFile(archivePath, entryPath);
    }
  });
}

async function readBoundedArchiveEntry(archiveReader, archivePath, entryPath, maximumBytes) {
  const content = await archiveReader.readFile(archivePath, entryPath);
  if (!Buffer.isBuffer(content) || content.length < 1 || content.length > maximumBytes || content.includes(0)) {
    throw new TypeError('Packaged archive entry is invalid.');
  }
  return content;
}

function packagedLicenseReview(input, { inventorySource, inventory }) {
  const keys = ['schemaVersion', 'decision', 'reviewer', 'reviewedAt', 'lockPath', 'lockSha256', 'inventoryPath', 'inventorySha256', 'packageCount', 'acceptedLicenseExpressions'];
  if (!plainObject(input) || Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(input, key))) return null;
  const reviewer = String(input.reviewer || '').trim();
  const reviewedAt = String(input.reviewedAt || '').trim();
  const expressions = Array.isArray(input.acceptedLicenseExpressions) ? input.acceptedLicenseExpressions.map((value) => String(value || '').trim()) : [];
  const expectedExpressions = [...new Set(inventory.map((entry) => entry.license))].sort();
  const inventorySha256 = crypto.createHash('sha256').update(inventorySource).digest('hex');
  if (input.schemaVersion !== 1
    || input.decision !== 'approved'
    || !reviewer
    || reviewer.length > 200
    || !reviewedAt
    || reviewedAt.length > 100
    || !Number.isFinite(Date.parse(reviewedAt))
    || input.lockPath !== LOCK_PATH
    || !/^[0-9a-f]{64}$/.test(String(input.lockSha256 || '').toLowerCase())
    || input.inventoryPath !== INVENTORY_PATH
    || String(input.inventorySha256 || '').toLowerCase() !== inventorySha256
    || input.packageCount !== inventory.length
    || expressions.length !== expectedExpressions.length
    || new Set(expressions).size !== expressions.length
    || expressions.some((value, index) => value !== expectedExpressions[index])) return null;
  return Object.freeze({ packageCount: input.packageCount });
}

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
}

async function validatePeFile(filePath, maximumBytes, { fileSystem, peValidator }) {
  const before = await fileSystem.lstat(filePath);
  if (!before.isFile() || before.size < 128 || before.size > maximumBytes) return false;
  const realPath = await fileSystem.realpath(filePath);
  const handle = await fileSystem.open(realPath, 'r');
  try {
    if (!await peValidator(handle)) return false;
    const after = await fileSystem.lstat(realPath);
    return after.isFile() && after.size === before.size && after.mtimeMs === before.mtimeMs;
  } finally {
    await handle.close();
  }
}

async function acceptLayout(kind, layout, {
  fileSystem,
  archiveReader,
  applicationSmokeRunner,
  malwareScanner,
  signatureVerifier,
  dependencyInspector,
  signerFingerprint,
  peValidator,
  runtimeFactory,
  platform,
  arch
}) {
  const checks = [];
  let runtime = null;
  let failed = false;
  const check = async (name, fallbackCode, operation) => {
    if (failed) {
      checks.push(Object.freeze({ name, status: 'skipped' }));
      return;
    }
    try {
      const accepted = await operation();
      if (accepted === false) throw new WindowsArtifactAcceptanceError(fallbackCode);
      checks.push(Object.freeze({ name, status: 'passed' }));
    } catch (error) {
      failed = true;
      checks.push(Object.freeze({ name, status: 'failed', code: safeCode(error, fallbackCode) }));
    }
  };

  await check('application-pe32-x64', 'WINDOWS_ARTIFACT_APPLICATION_INVALID', () =>
    validatePeFile(layout.applicationExecutable, MAX_APPLICATION_BYTES, { fileSystem, peValidator }));

  let applicationRealPath = null;
  let applicationState = null;
  let applicationImports = null;
  await check('application-authenticode', 'WINDOWS_ARTIFACT_APPLICATION_SIGNATURE_INVALID', async () => {
    const before = await fileSystem.lstat(layout.applicationExecutable);
    applicationRealPath = await fileSystem.realpath(layout.applicationExecutable);
    applicationState = Object.freeze({ size: before.size, mtimeMs: before.mtimeMs });
    return before.isFile() && signatureMatches(await signatureVerifier(applicationRealPath), signerFingerprint);
  });
  await check('application-dependencies', 'WINDOWS_ARTIFACT_APPLICATION_DEPENDENCIES_UNREVIEWED', async () => {
    applicationImports = await dependencyInspector(applicationRealPath);
    return reviewedWindowsDependencies(applicationImports);
  });
  await check('application-bundled-dependencies', 'WINDOWS_ARTIFACT_BUNDLED_DEPENDENCY_INVALID', async () => {
    const bundledImports = bundledWindowsDependencies(applicationImports);
    if (!bundledImports) return false;
    const applicationDirectory = path.dirname(applicationRealPath);
    for (const moduleName of bundledImports) {
      try {
        const modulePath = path.join(applicationDirectory, moduleName);
        const before = await fileSystem.lstat(modulePath);
        if (!before.isFile() || before.size < 128 || before.size > MAX_HOST_BYTES) return false;
        const moduleRealPath = await fileSystem.realpath(modulePath);
        if (!isInside(applicationDirectory, moduleRealPath)
          || !await validatePeFile(moduleRealPath, MAX_HOST_BYTES, { fileSystem, peValidator })
          || !signatureMatches(await signatureVerifier(moduleRealPath), signerFingerprint)
          || !reviewedWindowsDependencies(await dependencyInspector(moduleRealPath))) return false;
        const after = await fileSystem.lstat(moduleRealPath);
        if (!after.isFile()
          || await fileSystem.realpath(modulePath) !== moduleRealPath
          || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
  await check('application-binary-stable', 'WINDOWS_ARTIFACT_APPLICATION_CHANGED', async () => {
    const after = await fileSystem.lstat(applicationRealPath);
    return after.isFile()
      && await fileSystem.realpath(layout.applicationExecutable) === applicationRealPath
      && after.size === applicationState.size
      && after.mtimeMs === applicationState.mtimeMs;
  });

  let resourcesRealPath = null;
  await check('resources-directory', 'WINDOWS_ARTIFACT_RESOURCES_INVALID', async () => {
    const stat = await fileSystem.lstat(layout.resourcesPath);
    if (!stat.isDirectory()) return false;
    resourcesRealPath = await fileSystem.realpath(layout.resourcesPath);
    const expectedResourcesPath = path.join(path.dirname(applicationRealPath), 'resources');
    return path.resolve(layout.resourcesPath).toLowerCase() === path.resolve(expectedResourcesPath).toLowerCase()
      && resourcesRealPath.toLowerCase() === path.resolve(expectedResourcesPath).toLowerCase();
  });

  const archivePath = path.join(layout.resourcesPath, APPLICATION_ARCHIVE_NAME);
  let archiveRealPath = null;
  let archiveState = null;
  await check('application-asar-contained', 'WINDOWS_ARTIFACT_ASAR_INVALID', async () => {
    const before = await fileSystem.lstat(archivePath);
    if (!before.isFile() || before.size < 1 || before.size > MAX_APPLICATION_BYTES) return false;
    archiveRealPath = await fileSystem.realpath(archivePath);
    if (!resourcesRealPath || !isInside(resourcesRealPath, archiveRealPath)) return false;
    archiveState = Object.freeze({ size: before.size, mtimeMs: before.mtimeMs });
    return true;
  });

  let inventorySource = null;
  let inventory = null;
  await check('packaged-third-party-notice', 'WINDOWS_ARTIFACT_NOTICE_INVALID', async () => {
    const content = await readBoundedArchiveEntry(archiveReader, archiveRealPath, NOTICE_PATH, MAX_NOTICE_BYTES);
    const source = content.toString('utf8');
    return source.includes('## Database Manager Rust Dependencies') && source.includes(INVENTORY_PATH) && source.includes(REVIEW_PATH);
  });
  await check('packaged-license-inventory', 'WINDOWS_ARTIFACT_LICENSE_INVENTORY_INVALID', async () => {
    const content = await readBoundedArchiveEntry(archiveReader, archiveRealPath, INVENTORY_PATH, MAX_INVENTORY_BYTES);
    inventorySource = content.toString('utf8');
    try { inventory = inventoryPackages(JSON.parse(inventorySource)); }
    catch { inventory = null; }
    return Boolean(inventory && !inventory.some((entry) => !entry));
  });
  await check('packaged-license-review', 'WINDOWS_ARTIFACT_LICENSE_REVIEW_INVALID', async () => {
    const content = await readBoundedArchiveEntry(archiveReader, archiveRealPath, REVIEW_PATH, MAX_REVIEW_BYTES);
    let review = null;
    try { review = packagedLicenseReview(JSON.parse(content.toString('utf8')), { inventorySource, inventory }); }
    catch { review = null; }
    return Boolean(review);
  });
  await check('packaged-license-evidence', 'WINDOWS_ARTIFACT_LICENSE_EVIDENCE_INVALID', async () => {
    const assignedPaths = new Set();
    let totalBytes = 0;
    for (const entry of inventory) {
      const expectedPrefix = `${safeSegment(entry.name)}-${safeSegment(entry.version)}-`;
      for (const licenseFile of entry.licenseFiles) {
        if (assignedPaths.has(licenseFile) || !path.posix.basename(licenseFile).startsWith(expectedPrefix)) return false;
        assignedPaths.add(licenseFile);
        const content = await readBoundedArchiveEntry(archiveReader, archiveRealPath, licenseFile, MAX_LICENSE_FILE_BYTES);
        totalBytes += content.length;
        if (totalBytes > MAX_TOTAL_LICENSE_BYTES) return false;
        const expectedDigest = path.posix.basename(licenseFile).match(/-([0-9a-f]{12})\.txt$/)?.[1];
        const actualDigest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
        if (!expectedDigest || actualDigest !== expectedDigest) return false;
      }
    }
    return assignedPaths.size > 0;
  });
  await check('application-asar-stable', 'WINDOWS_ARTIFACT_ASAR_CHANGED', async () => {
    const after = await fileSystem.lstat(archiveRealPath);
    const finalRealPath = await fileSystem.realpath(archivePath);
    return after.isFile() && finalRealPath === archiveRealPath && after.size === archiveState.size && after.mtimeMs === archiveState.mtimeMs;
  });
  await check('windows-defender-scan', 'WINDOWS_ARTIFACT_DEFENDER_SCAN_FAILED', () =>
    malwareScanner({ targetPath: path.dirname(applicationRealPath), kind }));
  await check('application-ui-smoke', 'WINDOWS_ARTIFACT_APPLICATION_SMOKE_FAILED', () =>
    applicationSmokeRunner({ executablePath: applicationRealPath, kind, signerFingerprint }));

  const hostPath = resolveDatabaseDriverHostPath({ isPackaged: true, resourcesPath: layout.resourcesPath, platform, arch });
  let hostRealPath = null;
  await check('sidecar-contained', 'WINDOWS_ARTIFACT_HOST_CONTAINMENT_FAILED', async () => {
    const hostEntry = await fileSystem.lstat(hostPath);
    if (!hostEntry.isFile()) return false;
    hostRealPath = await fileSystem.realpath(hostPath);
    return Boolean(resourcesRealPath && isInside(resourcesRealPath, hostRealPath));
  });
  await check('sidecar-pe32-x64', 'WINDOWS_ARTIFACT_HOST_INVALID', () =>
    validatePeFile(hostRealPath || hostPath, MAX_HOST_BYTES, { fileSystem, peValidator }));
  let hostState = null;
  await check('sidecar-authenticode', 'WINDOWS_ARTIFACT_HOST_SIGNATURE_INVALID', async () => {
    const before = await fileSystem.lstat(hostRealPath || hostPath);
    hostState = Object.freeze({ size: before.size, mtimeMs: before.mtimeMs });
    return before.isFile() && signatureMatches(await signatureVerifier(hostRealPath || hostPath), signerFingerprint);
  });
  await check('sidecar-dependencies', 'WINDOWS_ARTIFACT_HOST_DEPENDENCIES_UNREVIEWED', async () =>
    reviewedWindowsDependencies(await dependencyInspector(hostRealPath || hostPath)));
  await check('sidecar-binary-stable', 'WINDOWS_ARTIFACT_HOST_CHANGED', async () => {
    const after = await fileSystem.lstat(hostRealPath || hostPath);
    return after.isFile()
      && await fileSystem.realpath(hostPath) === hostRealPath
      && after.size === hostState.size
      && after.mtimeMs === hostState.mtimeMs;
  });
  await check('sidecar-health', 'WINDOWS_ARTIFACT_HOST_HEALTH_FAILED', async () => {
    runtime = runtimeFactory({ executablePath: hostRealPath || hostPath, kind });
    const health = await runtime.health({ timeoutMs: 5000 });
    return health?.status === 'ready' && health?.protocolVersion === 1;
  });

  try {
    if (runtime) await runtime.stop();
    checks.push(Object.freeze({ name: 'sidecar-stop', status: runtime ? 'passed' : 'skipped' }));
  } catch (error) {
    failed = true;
    checks.push(Object.freeze({ name: 'sidecar-stop', status: 'failed', code: safeCode(error, 'WINDOWS_ARTIFACT_HOST_STOP_FAILED') }));
  }
  return Object.freeze({ kind, status: failed ? 'failed' : 'passed', checks: Object.freeze(checks) });
}

async function runWindowsArtifactAcceptance({
  environment = process.env,
  fileSystem = fs,
  archiveReader = defaultArchiveReader(),
  applicationSmokeRunner = ({ executablePath, signerFingerprint }) => runPackagedApplicationSmoke(executablePath, { signerFingerprint }),
  malwareScanner = ({ targetPath }) => runMicrosoftDefenderScan(targetPath),
  signatureVerifier = verifyAuthenticode,
  dependencyInspector = inspectPeImports,
  peValidator = validatePe32PlusX64,
  runtimeFactory = ({ executablePath }) => new SidecarDriverRuntime({ executablePath, requestTimeoutMs: 5000 }),
  platform = process.platform,
  arch = process.arch
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') throw new WindowsArtifactAcceptanceError('WINDOWS_ARTIFACT_HOST_UNSUPPORTED');
  const configuration = configuredWindowsArtifacts(environment);
  const signerFingerprint = configuredSignerFingerprint(environment);
  const layouts = [];
  for (const kind of LAYOUT_KINDS) {
    layouts.push(await acceptLayout(kind, configuration[kind], {
      fileSystem,
      archiveReader,
      applicationSmokeRunner,
      malwareScanner,
      signatureVerifier,
      dependencyInspector,
      signerFingerprint,
      peValidator,
      runtimeFactory,
      platform,
      arch
    }));
  }
  const passed = layouts.filter((layout) => layout.status === 'passed').length;
  const failed = layouts.length - passed;
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    passed: failed === 0,
    layouts: Object.freeze(layouts),
    summary: Object.freeze({ total: layouts.length, passed, failed })
  });
}

async function runCli() {
  try {
    const report = await runWindowsArtifactAcceptance();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const report = { schemaVersion: REPORT_SCHEMA_VERSION, passed: false, error: { code: safeCode(error, 'WINDOWS_ARTIFACT_ACCEPTANCE_FAILED') } };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = {
  LAYOUT_KINDS,
  MAX_CONFIGURATION_BYTES,
  WINDOWS_ARTIFACTS_ENV,
  WINDOWS_SIGNER_ENV,
  WindowsArtifactAcceptanceError,
  configuredWindowsArtifacts,
  configuredSignerFingerprint,
  defaultArchiveReader,
  isInside,
  packagedLicenseReview,
  readBoundedArchiveEntry,
  runWindowsArtifactAcceptance,
  validatePeFile
};
