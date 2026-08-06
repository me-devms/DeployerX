const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeDriverManifest } = require('./domain');
const { pluginRuntimeRequirement } = require('./plugin-runtime-requirement');

const PLUGIN_REGISTRY_SCHEMA_VERSION = 1;
const PLUGIN_INSTALLED_STATE_SCHEMA_VERSION = 2;
const PLUGIN_CONTENT_INTEGRITY_SCHEMA_VERSION = 1;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_RELEASE_BYTES = 512 * 1024 * 1024;
const MAX_PLUGIN_COUNT = 200;
const MAX_PLUGIN_FILE_COUNT = 10000;
const MAX_PLUGIN_TREE_DEPTH = 32;
const MAX_PLUGIN_ID_LENGTH = 100;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64', 'universal']);
const RUNTIME_METHOD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const RUNTIME_METHOD_PATTERN = /^[a-z][a-z0-9_]*(?:[.-][a-z][a-z0-9_]*){0,5}$/;

class DatabasePluginRegistryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DatabasePluginRegistryError';
    this.code = code;
    this.category = options.category || 'database-plugin';
    this.retryable = Boolean(options.retryable);
    this.details = options.details && typeof options.details === 'object' ? options.details : {};
  }
}

function fail(code, message, options) {
  throw new DatabasePluginRegistryError(code, message, options);
}

function text(value, label, maximum = 512) {
  const result = String(value ?? '').trim();
  if (!result || result.length > maximum || result.includes('\0')) fail('DATABASE_PLUGIN_MANIFEST_INVALID', `${label} is invalid.`);
  return result;
}

function optionalText(value, maximum = 512) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, 'Plugin value', maximum);
}

function normalizeId(value, label = 'Plugin ID') {
  const id = text(value, label, MAX_PLUGIN_ID_LENGTH).toLowerCase();
  if (!PLUGIN_ID_PATTERN.test(id)) fail('DATABASE_PLUGIN_MANIFEST_INVALID', `${label} is invalid.`);
  return id;
}

function normalizeSha256(value) {
  const hash = text(value, 'Plugin SHA-256 hash', 128).toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin SHA-256 hash is invalid.');
  return hash;
}

function normalizeVersion(value) {
  const version = text(value, 'Plugin version', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin version is invalid.');
  return version;
}

function normalizeEntrypoint(value) {
  const entrypoint = text(value, 'Plugin entrypoint', 512);
  if (path.isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes('..')) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin entrypoint must stay inside the plugin directory.');
  return entrypoint;
}

function normalizeRuntime(input = {}) {
  const runtimeInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (runtimeInput.args !== undefined && !Array.isArray(runtimeInput.args)) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin runtime arguments are invalid.');
  const runtimeArgs = (runtimeInput.args || []).map((item) => text(item, 'Plugin runtime argument', 500));
  if (runtimeArgs.length > 20) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin runtime arguments are invalid.');
  if (runtimeInput.methods !== undefined && (!runtimeInput.methods || typeof runtimeInput.methods !== 'object' || Array.isArray(runtimeInput.methods))) {
    fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin runtime methods are invalid.');
  }
  const methodEntries = Object.entries(runtimeInput.methods || {});
  if (methodEntries.length > 10) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin runtime methods are invalid.');
  const runtimeMethods = {};
  for (const [key, value] of methodEntries) {
    if (!RUNTIME_METHOD_KEY_PATTERN.test(key)) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin runtime method key is invalid.');
    const method = text(value, 'Plugin runtime method', 120);
    if (!RUNTIME_METHOD_PATTERN.test(method)) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin runtime method is invalid.');
    runtimeMethods[key] = method;
  }
  return Object.freeze({ args: Object.freeze(runtimeArgs), methods: Object.freeze(runtimeMethods) });
}

function safeRelativeFilePath(value) {
  const relativePath = text(value, 'Plugin content path', 1024).replaceAll('\\', '/');
  if (relativePath.startsWith('/') || /^[a-z]:\//i.test(relativePath) || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content inventory is invalid.');
  }
  return relativePath;
}

function normalizeContentIntegrity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.schemaVersion !== PLUGIN_CONTENT_INTEGRITY_SCHEMA_VERSION
    || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_PLUGIN_FILE_COUNT) {
    fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content inventory is invalid.');
  }
  let totalBytes = 0;
  const paths = new Set();
  const files = input.files.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content inventory is invalid.');
    const relativePath = safeRelativeFilePath(item.path);
    const size = Number(item.size);
    if (paths.has(relativePath) || !Number.isSafeInteger(size) || size < 0 || size > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content inventory is invalid.');
    paths.add(relativePath);
    totalBytes += size;
    if (totalBytes > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content inventory is invalid.');
    return Object.freeze({ path: relativePath, size, sha256: normalizeSha256(item.sha256) });
  }).sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({ schemaVersion: PLUGIN_CONTENT_INTEGRITY_SCHEMA_VERSION, files: Object.freeze(files) });
}

async function hashPluginFile(fileSystem, filePath) {
  const handle = await fileSystem.open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content is invalid.');
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content is invalid.');
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('DATABASE_PLUGIN_CONTENT_CHANGED', 'Plugin content changed while it was being verified.');
    return { size: total, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function buildPluginContentIntegrity(rootPath, fileSystem) {
  const canonicalRoot = await fileSystem.realpath(rootPath);
  const pending = [{ directory: canonicalRoot, depth: 0 }];
  const files = [];
  let visitedEntries = 0;
  let totalBytes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current.depth > MAX_PLUGIN_TREE_DEPTH) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content tree is too deep.');
    const children = [];
    const directory = await fileSystem.opendir(current.directory);
    try {
      for await (const child of directory) {
        visitedEntries += 1;
        if (visitedEntries > MAX_PLUGIN_FILE_COUNT) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content contains too many entries.');
        children.push(child);
      }
    } finally {
      await directory.close().catch(() => {});
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = path.join(current.directory, child.name);
      const metadata = await fileSystem.lstat(childPath);
      if (metadata.isSymbolicLink()) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content must not contain symbolic links.');
      const canonicalChild = await fileSystem.realpath(childPath);
      const relative = path.relative(canonicalRoot, canonicalChild);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content escapes its installation directory.');
      if (metadata.isDirectory()) {
        pending.push({ directory: canonicalChild, depth: current.depth + 1 });
        continue;
      }
      if (!metadata.isFile()) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content contains an unsupported filesystem entry.');
      const hashed = await hashPluginFile(fileSystem, canonicalChild);
      const verifiedMetadata = await fileSystem.lstat(childPath);
      const verifiedCanonicalChild = await fileSystem.realpath(childPath);
      if (!verifiedMetadata.isFile() || verifiedMetadata.isSymbolicLink() || verifiedCanonicalChild !== canonicalChild) fail('DATABASE_PLUGIN_CONTENT_CHANGED', 'Plugin content changed while it was being verified.');
      totalBytes += hashed.size;
      if (totalBytes > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_CONTENT_INVALID', 'Plugin content is too large.');
      files.push({ path: relative.replaceAll('\\', '/'), size: hashed.size, sha256: hashed.sha256 });
    }
  }
  return normalizeContentIntegrity({ schemaVersion: PLUGIN_CONTENT_INTEGRITY_SCHEMA_VERSION, files });
}

function sameContentIntegrity(left, right) {
  if (!left || !right || left.files.length !== right.files.length) return false;
  return left.files.every((file, index) => file.path === right.files[index].path && file.size === right.files[index].size && file.sha256 === right.files[index].sha256);
}

function normalizeInstalledDriverManifest(input, pluginId, version, entrypoint) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
  try {
    if (input.entrypoint && normalizeEntrypoint(input.entrypoint) !== entrypoint) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
    const normalized = normalizeDriverManifest({ ...input, id: pluginId, name: input.name || pluginId, version, source: 'plugin' });
    return Object.freeze({ ...normalized, entrypoint, runtime: normalizeRuntime(input.runtime) });
  } catch (error) {
    if (error instanceof DatabasePluginRegistryError && error.code === 'DATABASE_PLUGIN_STATE_INVALID') throw error;
    fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
  }
}

async function normalizeInstalledRecord(input, rootPath, fileSystem, { legacy = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
  try {
    const pluginId = normalizeId(input.pluginId);
    const version = normalizeVersion(input.version);
    const entrypoint = normalizeEntrypoint(input.entrypoint);
    const expectedInstallPath = path.resolve(rootPath, 'installed', pluginId, version);
    const persistedInstallPath = input.installPath ? path.resolve(String(input.installPath)) : null;
    if (!persistedInstallPath || path.relative(expectedInstallPath, persistedInstallPath) !== '') fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
    const canonicalRoot = await fileSystem.realpath(rootPath);
    const canonicalInstallPath = await fileSystem.realpath(expectedInstallPath);
    const installRelative = path.relative(canonicalRoot, canonicalInstallPath);
    if (!installRelative || installRelative.startsWith('..') || path.isAbsolute(installRelative)) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
    const canonicalEntrypoint = await fileSystem.realpath(path.resolve(expectedInstallPath, entrypoint));
    const entrypointRelative = path.relative(canonicalInstallPath, canonicalEntrypoint);
    if (!entrypointRelative || entrypointRelative.startsWith('..') || path.isAbsolute(entrypointRelative)) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
    const entrypointStat = await fileSystem.stat(canonicalEntrypoint);
    if (!entrypointStat.isFile()) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
    const contentIntegrity = legacy ? null : normalizeContentIntegrity(input.contentIntegrity);
    const actualIntegrity = legacy ? null : await buildPluginContentIntegrity(canonicalInstallPath, fileSystem);
    const integrityStatus = legacy ? 'reinstall-required' : sameContentIntegrity(contentIntegrity, actualIntegrity) ? 'verified' : 'failed';
    const signatureVerified = input.signatureVerified === true;
    return Object.freeze({
      pluginId,
      version,
      enabled: !legacy && signatureVerified && integrityStatus === 'verified' && input.enabled !== false,
      installedAt: optionalText(input.installedAt, 100),
      updatedAt: optionalText(input.updatedAt, 100),
      installPath: expectedInstallPath,
      entrypoint,
      driverManifest: normalizeInstalledDriverManifest(input.driverManifest, pluginId, version, entrypoint),
      signatureVerified,
      signatureKeyId: optionalText(input.signatureKeyId, 200),
      contentIntegrity,
      integrityStatus
    });
  } catch (error) {
    if (error instanceof DatabasePluginRegistryError && error.code === 'DATABASE_PLUGIN_STATE_INVALID') throw error;
    fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
  }
}

function serializedInstalledRecord(record) {
  return {
    pluginId: record.pluginId,
    version: record.version,
    enabled: record.enabled,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    installPath: record.installPath,
    entrypoint: record.entrypoint,
    driverManifest: record.driverManifest,
    signatureVerified: record.signatureVerified,
    signatureKeyId: record.signatureKeyId,
    contentIntegrity: record.contentIntegrity
  };
}

function runtimeInstalledRecord(record) {
  if (!record) return null;
  const { contentIntegrity: _contentIntegrity, ...projection } = record;
  return Object.freeze(projection);
}

function installedStatus(record) {
  return Object.freeze({
    pluginId: record.pluginId,
    version: record.version,
    enabled: record.enabled,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    signatureVerified: record.signatureVerified,
    signatureKeyId: record.signatureKeyId,
    integrityStatus: record.integrityStatus
  });
}

function normalizeTarget(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const platforms = Array.isArray(raw.platforms) ? [...new Set(raw.platforms.map((item) => String(item).toLowerCase()))] : ['win32'];
  const architectures = Array.isArray(raw.architectures) ? [...new Set(raw.architectures.map((item) => String(item).toLowerCase()))] : ['x64', 'universal'];
  if (!platforms.length || platforms.some((item) => !SUPPORTED_PLATFORMS.has(item))) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin release platforms are invalid.');
  if (!architectures.length || architectures.some((item) => !SUPPORTED_ARCHITECTURES.has(item))) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin release architectures are invalid.');
  return Object.freeze({ platforms: Object.freeze(platforms), architectures: Object.freeze(architectures) });
}

function normalizeRelease(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin release is invalid.');
  const pluginId = normalizeId(input.pluginId || input.id);
  const version = normalizeVersion(input.version);
  const name = text(input.name || pluginId, 'Plugin name', 120);
  const archive = input.archive && typeof input.archive === 'object' ? input.archive : {};
  const size = Number(archive.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_RELEASE_TOO_LARGE', 'Plugin release archive size is invalid.');
  const url = text(archive.url, 'Plugin release URL', 2048);
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin release URL is invalid.'); }
  if (!['https:', 'http:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Plugin release URL must use HTTP or HTTPS without credentials.');
  const signature = input.signature && typeof input.signature === 'object' ? input.signature : null;
  const manifestSha256 = input.manifestSha256 ? normalizeSha256(input.manifestSha256) : null;
  if (signature && !manifestSha256) fail('DATABASE_PLUGIN_MANIFEST_INVALID', 'Signed plugin manifest integrity is required.');
  const driverManifest = input.driverManifest && typeof input.driverManifest === 'object' ? input.driverManifest : {};
  const entrypoint = normalizeEntrypoint(input.entrypoint || driverManifest.entrypoint);
  const runtime = normalizeRuntime(driverManifest.runtime);
  const normalizedDriverManifest = normalizeDriverManifest({ ...driverManifest, id: driverManifest.id || pluginId, name: driverManifest.name || name, version, source: 'plugin' });
  return Object.freeze({
    pluginId,
    version,
    name,
    description: optionalText(input.description, 1000),
    approved: input.approved === true,
    target: normalizeTarget(input.target),
    archive: Object.freeze({ name: text(archive.name || path.basename(parsedUrl.pathname), 'Plugin archive name', 300), url, size, sha256: normalizeSha256(archive.sha256) }),
    signature: signature ? Object.freeze({ algorithm: optionalText(signature.algorithm, 40) || 'Ed25519', value: text(signature.value, 'Plugin signature', 8192), keyId: optionalText(signature.keyId, 200) }) : null,
    manifestSha256,
    entrypoint,
    driverManifest: Object.freeze({ ...normalizedDriverManifest, entrypoint, runtime })
  });
}

function normalizeCatalog(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  try {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_CATALOG_BYTES) fail('DATABASE_PLUGIN_CATALOG_TOO_LARGE', 'The database plugin catalog is too large.');
  } catch (error) {
    if (error instanceof DatabasePluginRegistryError) throw error;
    fail('DATABASE_PLUGIN_CATALOG_INVALID', 'The database plugin catalog is invalid.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== PLUGIN_REGISTRY_SCHEMA_VERSION || !Array.isArray(raw.releases)) {
    fail('DATABASE_PLUGIN_CATALOG_INVALID', 'The database plugin catalog is invalid.');
  }
  if (raw.releases.length > MAX_PLUGIN_COUNT) fail('DATABASE_PLUGIN_CATALOG_TOO_LARGE', 'The database plugin catalog contains too many releases.');
  const releases = raw.releases.map(normalizeRelease);
  const unavailableInput = raw.unavailable === undefined ? [] : raw.unavailable;
  if (!Array.isArray(unavailableInput) || unavailableInput.length > MAX_PLUGIN_COUNT) fail('DATABASE_PLUGIN_CATALOG_INVALID', 'The unavailable plugin catalog is invalid.');
  const unavailable = unavailableInput.map((item) => Object.freeze({
    pluginId: normalizeId(item?.pluginId || item?.id),
    version: optionalText(item?.version, 64),
    name: text(item?.name || item?.pluginId || item?.id, 'Plugin name', 120),
    description: optionalText(item?.description, 1000),
    unavailableReason: text(item?.unavailableReason || 'No compatible release asset is available for this device.', 'Plugin unavailable reason', 500)
  }));
  const seen = new Set();
  for (const release of releases) {
    const key = `${release.pluginId}@${release.version}`;
    if (seen.has(key)) fail('DATABASE_PLUGIN_CATALOG_INVALID', 'The database plugin catalog contains duplicate releases.');
    seen.add(key);
  }
  return Object.freeze({ schemaVersion: PLUGIN_REGISTRY_SCHEMA_VERSION, generatedAt: optionalText(raw.generatedAt, 100), releases: Object.freeze(releases), unavailable: Object.freeze(unavailable) });
}

function releaseForHost(release, platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'ia32' ? 'x86' : String(arch).toLowerCase();
  const supported = release.target.platforms.includes(platform) && (release.target.architectures.includes(normalizedArch) || release.target.architectures.includes('universal'));
  return supported ? release : null;
}

async function sha256File(fileSystem, filePath) {
  const digest = crypto.createHash('sha256');
  const data = await fileSystem.readFile(filePath);
  digest.update(data);
  return digest.digest('hex');
}

function safeArchiveEntries(entries, entrypoint) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 10000) fail('DATABASE_PLUGIN_ARCHIVE_INVALID', 'The plugin archive entries are invalid.');
  let total = 0;
  for (const item of entries) {
    const name = text(item?.path, 'Plugin archive entry', 1024).replaceAll('\\', '/');
    if (name.startsWith('/') || /^[a-z]:\//i.test(name) || name.split('/').includes('..')) fail('DATABASE_PLUGIN_ARCHIVE_TRAVERSAL', 'The plugin archive contains an unsafe path.');
    const size = Number(item?.size || 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_ARCHIVE_INVALID', 'The plugin archive contains an invalid entry size.');
    total += size;
    if (total > MAX_RELEASE_BYTES) fail('DATABASE_PLUGIN_RELEASE_TOO_LARGE', 'The plugin archive is too large.');
  }
  const normalizedEntrypoint = entrypoint.replaceAll('\\', '/');
  const executable = entries.find((item) => item.path.replaceAll('\\', '/') === normalizedEntrypoint);
  if (!executable) fail('DATABASE_PLUGIN_ENTRYPOINT_MISSING', 'The plugin archive does not contain its declared entrypoint.');
  if (executable.executable === false) fail('DATABASE_PLUGIN_ENTRYPOINT_INVALID', 'The plugin entrypoint is not executable.');
  return { totalBytes: total, entrypoint: normalizedEntrypoint };
}

async function writeJsonAtomically(fileSystem, targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fileSystem.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await fileSystem.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

class DatabasePluginRegistry {
  constructor({ rootPath, fileSystem = fs, platform = process.platform, arch = process.arch, download, extract, verifySignature, clock = () => new Date().toISOString() } = {}) {
    if (!rootPath) throw new TypeError('Plugin registry root path is required.');
    if (typeof download !== 'function') throw new TypeError('Plugin registry download function is required.');
    if (typeof extract !== 'function') throw new TypeError('Plugin registry extract function is required.');
    this.rootPath = path.resolve(String(rootPath));
    this.statePath = path.join(this.rootPath, 'plugins.json');
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.arch = arch;
    this.download = download;
    this.extract = extract;
    this.verifySignature = verifySignature;
    this.clock = clock;
    this.catalog = normalizeCatalog({ schemaVersion: PLUGIN_REGISTRY_SCHEMA_VERSION, releases: [] });
    this.state = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await this.fileSystem.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await this.fileSystem.readFile(this.statePath, 'utf8'));
      const legacy = parsed?.schemaVersion === 1;
      if ((!legacy && parsed?.schemaVersion !== PLUGIN_INSTALLED_STATE_SCHEMA_VERSION) || !Array.isArray(parsed.plugins) || parsed.plugins.length > MAX_PLUGIN_COUNT) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
      const records = [];
      const ids = new Set();
      let stateChanged = legacy;
      for (const item of parsed.plugins) {
        const record = await normalizeInstalledRecord(item, this.rootPath, this.fileSystem, { legacy });
        if (ids.has(record.pluginId)) fail('DATABASE_PLUGIN_STATE_INVALID', 'Installed database plugin state is invalid.');
        if (item.enabled !== false && record.enabled === false) stateChanged = true;
        ids.add(record.pluginId);
        records.push(record);
      }
      this.state = new Map(records.map((record) => [record.pluginId, record]));
      if (stateChanged) await this.#persist();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  setCatalog(input) { this.catalog = normalizeCatalog(input); return this.list(); }

  getInstalled(pluginIdValue) {
    const pluginId = normalizeId(pluginIdValue);
    const installed = this.state.get(pluginId);
    if (!installed || !installed.enabled) return null;
    return runtimeInstalledRecord(installed);
  }

  listInstalled({ includeDisabled = false } = {}) {
    return Object.freeze([...this.state.values()].filter((plugin) => includeDisabled || plugin.enabled).map(runtimeInstalledRecord));
  }

  getDriverManifest(pluginIdValue) {
    const installed = this.getInstalled(pluginIdValue);
    if (!installed?.driverManifest) return null;
    return Object.freeze({ ...installed.driverManifest, id: pluginIdValue, source: 'plugin', version: installed.version });
  }

  async verifyInstalled(pluginIdValue) {
    await this.initialize();
    const pluginId = normalizeId(pluginIdValue);
    const current = this.state.get(pluginId);
    if (!current) fail('DATABASE_PLUGIN_NOT_INSTALLED', 'This plugin is not installed or enabled.');
    if (!current.signatureVerified) fail('DATABASE_PLUGIN_SIGNATURE_REQUIRED', 'A verified plugin release signature is required before this plugin can run.');
    if (!current.enabled) fail('DATABASE_PLUGIN_NOT_INSTALLED', 'This plugin is not installed or enabled.');
    if (!current.contentIntegrity) fail('DATABASE_PLUGIN_INTEGRITY_REQUIRED', 'Reinstall this plugin before enabling it.');
    if (!await this.#contentMatches(current)) {
      await this.#quarantine(current);
      fail('DATABASE_PLUGIN_INTEGRITY_MISMATCH', 'The installed plugin content failed integrity verification. Reinstall the plugin before enabling it.');
    }
    return Object.freeze({ pluginId, integrityStatus: 'verified' });
  }

  list() {
    const releases = this.catalog.releases.filter((release) => release.approved).map((release) => {
      const installed = this.state.get(release.pluginId);
      const hostSupported = Boolean(releaseForHost(release, this.platform, this.arch));
      const supported = hostSupported && Boolean(release.signature);
      const unsupportedReason = !hostSupported ? `Not available for ${this.platform}/${this.arch}.` : !release.signature ? 'A signed release is required before this driver can be installed.' : null;
      return Object.freeze({ pluginId: release.pluginId, version: release.version, name: release.name, description: release.description, supported, unsupportedReason, approved: release.approved, signature: release.signature ? { algorithm: release.signature.algorithm, keyId: release.signature.keyId } : null, signatureVerified: installed ? installed.signatureVerified === true : null, installedVersion: installed?.version || null, enabled: installed?.enabled === true, installed: Boolean(installed), integrityStatus: installed?.integrityStatus || null, runtimeRequirement: pluginRuntimeRequirement(installed?.entrypoint || release.entrypoint, release.pluginId), driver: installed?.driverManifest ? Object.freeze({ id: release.pluginId, name: installed.driverManifest.name || release.name, defaultPort: installed.driverManifest.defaultPort ?? null, capabilities: installed.driverManifest.capabilities || {}, credentialSlots: installed.driverManifest.credentialSlots || [], settings: installed.driverManifest.settings || {} }) : null });
    });
    const catalogIds = new Set(releases.map((release) => release.pluginId));
    for (const unavailable of this.catalog.unavailable) {
      if (catalogIds.has(unavailable.pluginId)) continue;
      const installed = this.state.get(unavailable.pluginId);
      releases.push(Object.freeze({
        pluginId: unavailable.pluginId,
        version: unavailable.version,
        name: unavailable.name,
        description: unavailable.description,
        supported: false,
        unsupportedReason: unavailable.unavailableReason,
        approved: true,
        signature: null,
        signatureVerified: installed ? installed.signatureVerified === true : null,
        installedVersion: installed?.version || null,
        enabled: installed?.enabled === true,
        installed: Boolean(installed),
        integrityStatus: installed?.integrityStatus || null,
        runtimeRequirement: pluginRuntimeRequirement(installed?.entrypoint, unavailable.pluginId),
        driver: installed?.driverManifest ? Object.freeze({ id: installed.pluginId, name: installed.driverManifest.name || unavailable.name, defaultPort: installed.driverManifest.defaultPort ?? null, capabilities: installed.driverManifest.capabilities || {}, credentialSlots: installed.driverManifest.credentialSlots || [], settings: installed.driverManifest.settings || {} }) : null
      }));
      catalogIds.add(unavailable.pluginId);
    }
    for (const installed of this.state.values()) {
      if (catalogIds.has(installed.pluginId)) continue;
      releases.push(Object.freeze({ pluginId: installed.pluginId, version: installed.version, name: installed.driverManifest?.name || installed.pluginId, description: installed.driverManifest?.description || null, supported: installed.signatureVerified === true, unsupportedReason: installed.signatureVerified ? null : 'A signed release is required before this driver can run.', approved: true, signature: installed.signatureVerified ? { algorithm: 'Ed25519', keyId: installed.signatureKeyId } : null, signatureVerified: installed.signatureVerified === true, installedVersion: installed.version, enabled: installed.enabled, installed: true, integrityStatus: installed.integrityStatus, runtimeRequirement: pluginRuntimeRequirement(installed.entrypoint, installed.pluginId), driver: installed.driverManifest ? Object.freeze({ id: installed.pluginId, name: installed.driverManifest.name || installed.pluginId, defaultPort: installed.driverManifest.defaultPort ?? null, capabilities: installed.driverManifest.capabilities || {}, credentialSlots: installed.driverManifest.credentialSlots || [], settings: installed.driverManifest.settings || {} }) : null }));
    }
    return Object.freeze(releases);
  }

  async install(pluginIdValue, versionValue) {
    await this.initialize();
    const pluginId = normalizeId(pluginIdValue);
    const candidates = this.catalog.releases.filter((release) => release.pluginId === pluginId && (!versionValue || release.version === String(versionValue)) && release.approved).filter((release) => releaseForHost(release, this.platform, this.arch));
    const release = candidates[0];
    if (!release) fail('DATABASE_PLUGIN_RELEASE_UNAVAILABLE', 'This plugin release is not approved or supported on this device.');
    if (!release.signature) fail('DATABASE_PLUGIN_SIGNATURE_REQUIRED', 'A verified plugin release signature is required before installation.');
    const payload = await this.download(release.archive.url, { maxBytes: release.archive.size });
    const archive = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    if (archive.byteLength !== release.archive.size) fail('DATABASE_PLUGIN_ARCHIVE_SIZE_MISMATCH', 'The downloaded plugin archive size does not match its manifest.');
    if (crypto.createHash('sha256').update(archive).digest('hex') !== release.archive.sha256) fail('DATABASE_PLUGIN_HASH_MISMATCH', 'The downloaded plugin archive failed SHA-256 verification.');
    if (release.signature) {
      const verified = this.verifySignature ? await this.verifySignature({ release, payload: archive }) : false;
      if (!verified) fail('DATABASE_PLUGIN_SIGNATURE_INVALID', 'The plugin release signature could not be verified.');
    }
    const installPath = path.join(this.rootPath, 'installed', pluginId, release.version);
    const stagingPath = path.join(this.rootPath, 'staging', `${pluginId}-${crypto.randomUUID()}`);
    let entries;
    let contentIntegrity;
    try {
      entries = await this.extract(archive, stagingPath, { maxBytes: MAX_RELEASE_BYTES, entrypoint: release.entrypoint });
      safeArchiveEntries(entries, release.entrypoint);
      const entrypointPath = path.resolve(stagingPath, release.entrypoint);
      const canonicalRoot = await this.fileSystem.realpath(this.rootPath).catch(() => null);
      const canonicalInstallPath = await this.fileSystem.realpath(stagingPath).catch(() => null);
      const canonicalEntrypoint = await this.fileSystem.realpath(entrypointPath).catch(() => null);
      const relativeInstallPath = canonicalRoot && canonicalInstallPath ? path.relative(canonicalRoot, canonicalInstallPath) : '..';
      const relativeEntrypoint = canonicalInstallPath && canonicalEntrypoint ? path.relative(canonicalInstallPath, canonicalEntrypoint) : '..';
      if (!relativeInstallPath || relativeInstallPath.startsWith('..') || path.isAbsolute(relativeInstallPath)
        || !relativeEntrypoint || relativeEntrypoint.startsWith('..') || path.isAbsolute(relativeEntrypoint)) {
        fail('DATABASE_PLUGIN_ENTRYPOINT_OUT_OF_ROOT', 'The plugin entrypoint resolves outside its installation directory.');
      }
      const entrypointStat = await this.fileSystem.stat(canonicalEntrypoint).catch(() => null);
      if (!entrypointStat?.isFile()) fail('DATABASE_PLUGIN_ENTRYPOINT_INVALID', 'The plugin entrypoint is not a file.');
      contentIntegrity = await buildPluginContentIntegrity(canonicalInstallPath, this.fileSystem);
    } catch (error) {
      await this.fileSystem.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const previous = this.state.get(pluginId);
    const next = Object.freeze({ pluginId, version: release.version, enabled: true, installedAt: previous?.installedAt || this.clock(), updatedAt: this.clock(), installPath, entrypoint: release.entrypoint, driverManifest: release.driverManifest, signatureVerified: Boolean(release.signature), signatureKeyId: release.signature?.keyId || null, contentIntegrity, integrityStatus: 'verified' });
    const previousInstallBackup = `${installPath}.previous-${crypto.randomUUID()}`;
    let movedPreviousInstall = false;
    let publishedInstall = false;
    try {
      await this.fileSystem.mkdir(path.dirname(installPath), { recursive: true, mode: 0o700 });
      try {
        await this.fileSystem.rename(installPath, previousInstallBackup);
        movedPreviousInstall = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await this.fileSystem.rename(stagingPath, installPath);
      publishedInstall = true;
      this.state.set(pluginId, next);
      await this.#persist();
    } catch (error) {
      if (previous) this.state.set(pluginId, previous); else this.state.delete(pluginId);
      if (publishedInstall) await this.fileSystem.rm(installPath, { recursive: true, force: true }).catch(() => {});
      if (movedPreviousInstall) await this.fileSystem.rename(previousInstallBackup, installPath).catch(() => {});
      await this.fileSystem.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (movedPreviousInstall) await this.fileSystem.rm(previousInstallBackup, { recursive: true, force: true }).catch(() => {});
    if (previous?.installPath && previous.installPath !== installPath) await this.fileSystem.rm(previous.installPath, { recursive: true, force: true }).catch(() => {});
    return installedStatus(next);
  }

  async setEnabled(pluginIdValue, enabled) {
    await this.initialize();
    const pluginId = normalizeId(pluginIdValue);
    const current = this.state.get(pluginId);
    if (!current) fail('DATABASE_PLUGIN_NOT_INSTALLED', 'This plugin is not installed.');
    if (enabled && !current.signatureVerified) fail('DATABASE_PLUGIN_SIGNATURE_REQUIRED', 'A verified plugin release signature is required before this plugin can run.');
    if (enabled && !current.contentIntegrity) fail('DATABASE_PLUGIN_INTEGRITY_REQUIRED', 'Reinstall this plugin before enabling it.');
    if (enabled && !await this.#contentMatches(current)) {
      await this.#quarantine(current);
      fail('DATABASE_PLUGIN_INTEGRITY_MISMATCH', 'The installed plugin content failed integrity verification. Reinstall the plugin before enabling it.');
    }
    const next = Object.freeze({ ...current, enabled: Boolean(enabled), integrityStatus: current.contentIntegrity ? 'verified' : 'reinstall-required', updatedAt: this.clock() });
    this.state.set(pluginId, next);
    await this.#persist();
    return installedStatus(next);
  }

  async remove(pluginIdValue) { await this.initialize(); const pluginId = normalizeId(pluginIdValue); const current = this.state.get(pluginId); if (!current) return { pluginId, removed: false }; if (current.installPath) await this.fileSystem.rm(current.installPath, { recursive: true, force: true }); this.state.delete(pluginId); await this.#persist(); return { pluginId, removed: true }; }

  async #contentMatches(record) {
    try {
      return sameContentIntegrity(record.contentIntegrity, await buildPluginContentIntegrity(record.installPath, this.fileSystem));
    } catch {
      return false;
    }
  }

  async #quarantine(record) {
    const quarantined = Object.freeze({ ...record, enabled: false, integrityStatus: 'failed', updatedAt: this.clock() });
    this.state.set(record.pluginId, quarantined);
    await this.#persist();
  }

  #persist() {
    return writeJsonAtomically(this.fileSystem, this.statePath, {
      schemaVersion: PLUGIN_INSTALLED_STATE_SCHEMA_VERSION,
      plugins: [...this.state.values()].map(serializedInstalledRecord)
    });
  }
}

module.exports = { DatabasePluginRegistry, DatabasePluginRegistryError, MAX_CATALOG_BYTES, MAX_RELEASE_BYTES, PLUGIN_CONTENT_INTEGRITY_SCHEMA_VERSION, PLUGIN_INSTALLED_STATE_SCHEMA_VERSION, PLUGIN_REGISTRY_SCHEMA_VERSION, buildPluginContentIntegrity, normalizeCatalog, normalizeContentIntegrity, normalizeRelease, releaseForHost, safeArchiveEntries, sha256File };
