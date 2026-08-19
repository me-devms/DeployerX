const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 350 * 1024 * 1024;

const NATIVE_TOOL_PACKAGES = Object.freeze({
  mysql: Object.freeze({
    label: 'MySQL',
    packageLabel: 'MySQL 8.4 client tools',
    version: '8.4.6',
    platforms: Object.freeze({
      'win32-x64': Object.freeze({
        archiveName: 'mysql-8.4.6-winx64.zip',
        url: 'https://cdn.mysql.com/archives/mysql-8.4/mysql-8.4.6-winx64.zip',
        sha256: 'b6c152f9f3aaa7294eb47db698e47974d37b261bf3cab4f90dc1243bb5ecd204',
        downloadBytes: 260772595,
        binDirectory: 'mysql-8.4.6-winx64/bin',
        executables: Object.freeze(['mysql.exe', 'mysqldump.exe', 'mysqlbinlog.exe'])
      })
    })
  })
});

class NativeToolManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeToolManagerError';
    this.code = code;
  }
}

function packageFor(catalog, engine, platform, arch) {
  const normalizedEngine = String(engine || '').trim().toLowerCase();
  const definition = catalog[normalizedEngine];
  if (!definition) throw new NativeToolManagerError('NATIVE_TOOL_UNKNOWN', 'This database does not have an automatic client-tool package.');
  const artifact = definition.platforms[`${platform}-${arch}`];
  return { engine: normalizedEngine, definition, artifact: artifact || null };
}

function prependPath(directory, environment = process.env, platform = process.platform) {
  const separator = platform === 'win32' ? ';' : ':';
  const current = String(environment.PATH || environment.Path || '');
  const entries = current.split(separator).filter(Boolean);
  const comparable = platform === 'win32' ? directory.toLowerCase() : directory;
  if (!entries.some((entry) => (platform === 'win32' ? entry.toLowerCase() : entry) === comparable)) entries.unshift(directory);
  environment.PATH = entries.join(separator);
  if (platform === 'win32') environment.Path = environment.PATH;
}

async function downloadArchive(url, destination, expectedSha256, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new NativeToolManagerError('NATIVE_TOOL_DOWNLOAD_UNAVAILABLE', 'Automatic download is unavailable in this DeployerX build.');
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch {
    throw new NativeToolManagerError('NATIVE_TOOL_DOWNLOAD_FAILED', 'DeployerX could not reach the official client-tool download. Check your internet connection and try again.');
  }
  if (!response.ok || !response.body) throw new NativeToolManagerError('NATIVE_TOOL_DOWNLOAD_FAILED', `The official client-tool download failed with HTTP ${response.status}.`);
  const advertisedBytes = Number(response.headers.get('content-length') || 0);
  if (advertisedBytes > MAX_ARCHIVE_BYTES) throw new NativeToolManagerError('NATIVE_TOOL_ARCHIVE_TOO_LARGE', 'The client-tool download was larger than expected.');

  let receivedBytes = 0;
  const hash = crypto.createHash('sha256');
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_ARCHIVE_BYTES) return callback(new NativeToolManagerError('NATIVE_TOOL_ARCHIVE_TOO_LARGE', 'The client-tool download was larger than expected.'));
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(destination, { flags: 'wx' }));
  if (hash.digest('hex') !== expectedSha256) throw new NativeToolManagerError('NATIVE_TOOL_CHECKSUM_FAILED', 'The downloaded client tools did not pass the integrity check.');
}

async function extractZip(archivePath, destination, { platform = process.platform } = {}) {
  const executable = platform === 'win32' ? 'tar.exe' : 'unzip';
  const args = platform === 'win32' ? ['-xf', archivePath, '-C', destination] : ['-q', archivePath, '-d', destination];
  try {
    await execFileAsync(executable, args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new NativeToolManagerError('NATIVE_TOOL_EXTRACT_FAILED', 'DeployerX could not unpack the downloaded client tools.');
  }
}

class NativeToolManager {
  constructor({
    rootDirectory,
    platform = process.platform,
    arch = process.arch,
    environment = process.env,
    catalog = NATIVE_TOOL_PACKAGES,
    fetchImpl = globalThis.fetch,
    downloadImpl = downloadArchive,
    extractImpl = extractZip
  } = {}) {
    if (!rootDirectory) throw new TypeError('Native tool root directory is required.');
    this.rootDirectory = path.resolve(rootDirectory);
    this.platform = platform;
    this.arch = arch;
    this.environment = environment;
    this.catalog = catalog;
    this.fetchImpl = fetchImpl;
    this.downloadImpl = downloadImpl;
    this.extractImpl = extractImpl;
    this.installations = new Map();
  }

  resolve(engine) {
    const entry = packageFor(this.catalog, engine, this.platform, this.arch);
    const installDirectory = path.join(this.rootDirectory, entry.engine, entry.definition.version);
    const binDirectory = entry.artifact ? path.join(installDirectory, entry.artifact.binDirectory) : null;
    return { ...entry, installDirectory, binDirectory };
  }

  isInstalledSync(engine) {
    const resolved = this.resolve(engine);
    return Boolean(resolved.artifact && resolved.artifact.executables.every((name) => fs.existsSync(path.join(resolved.binDirectory, name))));
  }

  activateInstalledSync() {
    for (const engine of Object.keys(this.catalog)) {
      const resolved = this.resolve(engine);
      if (this.isInstalledSync(engine)) prependPath(resolved.binDirectory, this.environment, this.platform);
    }
  }

  async status(engine) {
    const resolved = this.resolve(engine);
    const installed = this.isInstalledSync(engine);
    if (installed) prependPath(resolved.binDirectory, this.environment, this.platform);
    return {
      engine: resolved.engine,
      label: resolved.definition.label,
      packageLabel: resolved.definition.packageLabel,
      version: resolved.definition.version,
      supported: Boolean(resolved.artifact),
      installed,
      downloadBytes: resolved.artifact?.downloadBytes || null
    };
  }

  async install(engine) {
    const resolved = this.resolve(engine);
    if (!resolved.artifact) throw new NativeToolManagerError('NATIVE_TOOL_PLATFORM_UNSUPPORTED', `Automatic ${resolved.definition.label} client setup is not available for this operating system yet.`);
    if (this.installations.has(resolved.engine)) return this.installations.get(resolved.engine);
    const operation = this.installPackage(resolved)
      .catch((error) => {
        if (error instanceof NativeToolManagerError) throw error;
        throw new NativeToolManagerError('NATIVE_TOOL_INSTALL_FAILED', 'DeployerX could not set up the client tools. Check available disk space and permissions, then try again.');
      })
      .finally(() => this.installations.delete(resolved.engine));
    this.installations.set(resolved.engine, operation);
    return operation;
  }

  async installPackage(resolved) {
    if (this.isInstalledSync(resolved.engine)) return this.status(resolved.engine);
    const downloadDirectory = path.join(this.rootDirectory, '.downloads');
    const stagingDirectory = path.join(this.rootDirectory, '.staging', `${resolved.engine}-${crypto.randomUUID()}`);
    const archivePath = path.join(downloadDirectory, `${resolved.engine}-${crypto.randomUUID()}-${resolved.artifact.archiveName}`);
    await fsPromises.mkdir(downloadDirectory, { recursive: true });
    await fsPromises.mkdir(stagingDirectory, { recursive: true });
    try {
      await this.downloadImpl(resolved.artifact.url, archivePath, resolved.artifact.sha256, { fetchImpl: this.fetchImpl });
      await this.extractImpl(archivePath, stagingDirectory, { platform: this.platform });
      const stagedBin = path.join(stagingDirectory, resolved.artifact.binDirectory);
      const valid = resolved.artifact.executables.every((name) => fs.existsSync(path.join(stagedBin, name)));
      if (!valid) throw new NativeToolManagerError('NATIVE_TOOL_PACKAGE_INVALID', 'The downloaded package did not contain the required client tools.');
      await fsPromises.mkdir(path.dirname(resolved.installDirectory), { recursive: true });
      await fsPromises.rm(resolved.installDirectory, { recursive: true, force: true });
      await fsPromises.rename(stagingDirectory, resolved.installDirectory);
      prependPath(resolved.binDirectory, this.environment, this.platform);
      return this.status(resolved.engine);
    } finally {
      await fsPromises.rm(archivePath, { force: true }).catch(() => {});
      await fsPromises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  NATIVE_TOOL_PACKAGES,
  NativeToolManager,
  NativeToolManagerError,
  downloadArchive,
  prependPath
};
