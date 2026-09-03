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
    manualUrl: 'https://dev.mysql.com/downloads/installer/',
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
  }),
  // These tools are installed by their vendors or distribution packages. Keep
  // them in the same catalog so the renderer can always offer the correct
  // installer instead of falling back to an unexplained missing-tool error.
  postgresql: Object.freeze({
    label: 'PostgreSQL',
    packageLabel: 'PostgreSQL 18.3 client tools',
    version: '18.3',
    manualUrl: 'https://www.postgresql.org/download/windows/',
    platforms: Object.freeze({
      'win32-x64': Object.freeze({
        archiveName: 'postgresql-18.3-1-windows-x64-binaries.zip',
        url: 'https://get.enterprisedb.com/postgresql/postgresql-18.3-1-windows-x64-binaries.zip',
        sha256: '4da1a93cbc69e99936616d53c34466f79e4295fc56134ce4a395e88351213d60',
        downloadBytes: 337835847,
        binDirectory: 'pgsql/bin',
        executables: Object.freeze(['psql.exe', 'pg_dump.exe', 'pg_basebackup.exe', 'pg_verifybackup.exe', 'pg_waldump.exe'])
      })
    })
  }),
  mariadb: Object.freeze({ label: 'MariaDB', packageLabel: 'MariaDB client tools (mariadb and mariadb-dump)', manualUrl: 'https://mariadb.com/downloads/community/community-server/' }),
  sqlserver: Object.freeze({ label: 'SQL Server', packageLabel: 'Microsoft sqlcmd', manualUrl: 'https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-download-install' }),
  oracle: Object.freeze({ label: 'Oracle', packageLabel: 'Oracle Instant Client (SQL*Plus)', manualUrl: 'https://www.oracle.com/database/technologies/instant-client/downloads.html' }),
  mongodb: Object.freeze({ label: 'MongoDB', packageLabel: 'MongoDB Database Tools and mongosh', manualUrl: 'https://www.mongodb.com/try/download/database-tools' }),
  redis: Object.freeze({ label: 'Redis', packageLabel: 'Redis CLI', manualUrl: 'https://redis.io/docs/latest/operate/oss_and_stack/install/install-redis/' }),
  clickhouse: Object.freeze({ label: 'ClickHouse', packageLabel: 'ClickHouse client', manualUrl: 'https://clickhouse.com/docs/en/install' }),
  influxdb: Object.freeze({ label: 'InfluxDB', packageLabel: 'InfluxDB CLI', manualUrl: 'https://docs.influxdata.com/influxdb/v2/tools/influx-cli/' }),
  cockroachdb: Object.freeze({ label: 'CockroachDB', packageLabel: 'CockroachDB SQL client', manualUrl: 'https://www.cockroachlabs.com/docs/stable/install-cockroachdb-windows' }),
  neo4j: Object.freeze({ label: 'Neo4j', packageLabel: 'Neo4j command-line tools', manualUrl: 'https://neo4j.com/download-center/' }),
  sqlite: Object.freeze({ label: 'SQLite', packageLabel: 'SQLite command-line shell', manualUrl: 'https://www.sqlite.org/download.html' }),
  cassandra: Object.freeze({ label: 'Cassandra', packageLabel: 'Apache Cassandra tools', manualUrl: 'https://cassandra.apache.org/_/download.html' })
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
  const artifact = definition.platforms?.[`${platform}-${arch}`] || null;
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

async function downloadArchive(url, destination, expectedSha256, { fetchImpl = globalThis.fetch, totalBytes = 0, onProgress } = {}) {
  if (typeof fetchImpl !== 'function') throw new NativeToolManagerError('NATIVE_TOOL_DOWNLOAD_UNAVAILABLE', 'Automatic download is unavailable in this DeployerX build.');
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch {
    throw new NativeToolManagerError('NATIVE_TOOL_DOWNLOAD_FAILED', 'DeployerX could not reach the official client-tool download. Check your internet connection and try again.');
  }
  if (!response.ok || !response.body) throw new NativeToolManagerError('NATIVE_TOOL_DOWNLOAD_FAILED', `The official client-tool download failed with HTTP ${response.status}.`);
  const advertisedContentLength = Number(response.headers.get('content-length') || 0);
  const advertisedBytes = Number.isFinite(advertisedContentLength) && advertisedContentLength > 0 ? advertisedContentLength : 0;
  if (advertisedBytes > MAX_ARCHIVE_BYTES) throw new NativeToolManagerError('NATIVE_TOOL_ARCHIVE_TOO_LARGE', 'The client-tool download was larger than expected.');
  const expectedBytes = advertisedBytes || Math.min(Number(totalBytes) || 0, MAX_ARCHIVE_BYTES);

  let receivedBytes = 0;
  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        receivedBytes,
        totalBytes: expectedBytes,
        percent: expectedBytes ? Math.min(100, (receivedBytes / expectedBytes) * 100) : null
      });
    } catch {
      // Progress reporting must never interrupt a verified download.
    }
  };
  reportProgress();
  const hash = crypto.createHash('sha256');
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_ARCHIVE_BYTES) return callback(new NativeToolManagerError('NATIVE_TOOL_ARCHIVE_TOO_LARGE', 'The client-tool download was larger than expected.'));
      hash.update(chunk);
      reportProgress();
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(destination, { flags: 'wx' }));
  reportProgress();
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
    const installDirectory = entry.definition.version ? path.join(this.rootDirectory, entry.engine, entry.definition.version) : null;
    const binDirectory = entry.artifact && installDirectory ? path.join(installDirectory, entry.artifact.binDirectory) : null;
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
      manual: Boolean(resolved.definition.manualUrl),
      manualUrl: resolved.definition.manualUrl || null,
      installed,
      downloadBytes: resolved.artifact?.downloadBytes || null
    };
  }

  async install(engine, { onProgress } = {}) {
    const resolved = this.resolve(engine);
    if (!resolved.artifact) throw new NativeToolManagerError('NATIVE_TOOL_PLATFORM_UNSUPPORTED', `Automatic ${resolved.definition.label} client setup is not available for this operating system yet.`);
    if (this.installations.has(resolved.engine)) return this.installations.get(resolved.engine);
    const operation = this.installPackage(resolved, { onProgress })
      .catch((error) => {
        if (error instanceof NativeToolManagerError) throw error;
        throw new NativeToolManagerError('NATIVE_TOOL_INSTALL_FAILED', 'DeployerX could not set up the client tools. Check available disk space and permissions, then try again.');
      })
      .finally(() => this.installations.delete(resolved.engine));
    this.installations.set(resolved.engine, operation);
    return operation;
  }

  async installPackage(resolved, { onProgress } = {}) {
    if (this.isInstalledSync(resolved.engine)) return this.status(resolved.engine);
    const downloadDirectory = path.join(this.rootDirectory, '.downloads');
    const stagingDirectory = path.join(this.rootDirectory, '.staging', `${resolved.engine}-${crypto.randomUUID()}`);
    const archivePath = path.join(downloadDirectory, `${resolved.engine}-${crypto.randomUUID()}-${resolved.artifact.archiveName}`);
    await fsPromises.mkdir(downloadDirectory, { recursive: true });
    await fsPromises.mkdir(stagingDirectory, { recursive: true });
    try {
      await this.downloadImpl(resolved.artifact.url, archivePath, resolved.artifact.sha256, {
        fetchImpl: this.fetchImpl,
        totalBytes: resolved.artifact.downloadBytes,
        onProgress
      });
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
