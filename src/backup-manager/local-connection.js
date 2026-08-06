const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { FileDiscoveryError, createDiscoveryPage } = require('./file-discovery');
const { FileMetadataError, captureLocalFileMetadata, metadataCapabilitiesForConnection } = require('./file-metadata');

const ADAPTER_ID = 'deployerx.connection.local';
const ADAPTER_VERSION = '1.0.0';
const DEVICE_ID_FILE = 'device.json';

function requiredText(value, label, maximumLength = 4096) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > maximumLength) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function safePlatformName(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

async function writeJsonAtomically(fileSystem, targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadOrCreateBackupDeviceId(rootPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const identityPath = path.join(requiredText(rootPath, 'Backup Manager root path'), DEVICE_ID_FILE);
  await fileSystem.mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  try {
    const identity = JSON.parse(await fileSystem.readFile(identityPath, 'utf8'));
    return requiredText(identity.deviceId, 'Backup Manager device ID', 200);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Backup Manager device identity is unreadable.', { cause: error });
  }
  const deviceId = `device_${crypto.randomUUID()}`;
  await writeJsonAtomically(fileSystem, identityPath, {
    schemaVersion: 1,
    deviceId,
    createdAt: new Date().toISOString()
  });
  return deviceId;
}

class LocalComputerConnectionAdapter {
  constructor(options = {}) {
    this.fileSystem = options.fileSystem || fs;
    this.platform = options.platform || process.platform;
    this.architecture = options.architecture || process.arch;
    this.hostname = options.hostname || os.hostname();
    this.homeDirectory = options.homeDirectory || os.homedir();
    this.pathModule = options.pathModule || path;
    this.clock = options.clock || (() => new Date().toISOString());
  }

  manifest() {
    const platform = safePlatformName(this.platform);
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      kind: 'connection',
      displayName: 'This computer',
      description: 'Access files available to the DeployerX process on this computer.',
      lifecycle: 'preview',
      supportedWorkers: [{ os: platform, architectures: [this.architecture] }],
      minimumDeployerXVersion: '0.1.3',
      configurationSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId'],
        properties: { deviceId: { type: 'string', minLength: 1, maxLength: 200 } }
      },
      secretSchema: [],
      capabilities: this.capabilities(),
      requiredExecutables: [],
      requiredPrivileges: [{ id: 'source-read', description: 'Read permission is required for every selected source path.', required: true }]
    };
  }

  capabilities() {
    const metadata = metadataCapabilitiesForConnection('local', safePlatformName(this.platform));
    return {
      workloadTypes: ['files'],
      discovery: { supported: true, pagination: true, searchable: false, lazyHierarchy: true },
      selectionModels: ['paths', 'include-exclude'],
      backupModes: ['full', 'incremental', 'forever-incremental'],
      consistencyModes: ['crash-consistent', 'offline'],
      pointInTimeRecovery: false,
      continuousLogCapture: false,
      resumableBackup: false,
      resumableRestore: false,
      itemLevelRestore: false,
      alternateTargetRestore: false,
      metadata,
      hooks: [],
      runtime: {
        platform: safePlatformName(this.platform),
        architecture: this.architecture,
        pathSeparator: this.platform === 'win32' ? '\\' : '/',
        caseSensitivePaths: this.platform !== 'win32' && this.platform !== 'darwin'
      }
    };
  }

  normalizeConfig(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Local connection configuration must be an object.');
    const unknown = Object.keys(input).filter((key) => key !== 'deviceId');
    if (unknown.length) throw new TypeError(`Unknown local connection field: ${unknown[0]}.`);
    return { deviceId: requiredText(input.deviceId, 'Device ID', 200) };
  }

  validateConfig(config) {
    try {
      this.normalizeConfig(config);
      return [];
    } catch (error) {
      return [{ path: 'deviceId', code: 'LOCAL_CONFIG_INVALID', severity: 'error', message: error.message }];
    }
  }

  async browse(context = {}, input = {}) {
    const config = this.normalizeConfig({ deviceId: input.deviceId });
    if (context.signal?.aborted) throw new FileDiscoveryError('DISCOVERY_CANCELED', 'Directory browsing was canceled.');
    const requestedPath = input.path === null || input.path === undefined || input.path === ''
      ? this.homeDirectory
      : String(input.path);
    if (requestedPath.includes('\0') || requestedPath.length > 4096 || !this.pathModule.isAbsolute(requestedPath)) {
      throw new FileDiscoveryError('DISCOVERY_PATH_INVALID', 'Choose an absolute local directory path.');
    }
    const directoryPath = this.pathModule.normalize(requestedPath);
    let directoryEntries;
    try {
      directoryEntries = await this.fileSystem.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      const denied = error?.code === 'EACCES' || error?.code === 'EPERM';
      throw new FileDiscoveryError(
        denied ? 'DISCOVERY_ACCESS_DENIED' : 'DISCOVERY_READ_FAILED',
        denied ? 'DeployerX does not have permission to read this local directory.' : 'DeployerX could not read this local directory.',
        { category: denied ? 'authorization' : 'discovery', retryable: !denied }
      );
    }
    if (context.signal?.aborted) throw new FileDiscoveryError('DISCOVERY_CANCELED', 'Directory browsing was canceled.');
    const entries = directoryEntries.map((entry) => ({
      name: entry.name,
      path: this.pathModule.join(directoryPath, entry.name),
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      hidden: entry.name.startsWith('.'),
      accessible: true
    }));
    const parent = this.pathModule.dirname(directoryPath);
    const page = createDiscoveryPage({
      adapterId: ADAPTER_ID,
      directoryPath,
      parentPath: parent === directoryPath ? null : parent,
      entries,
      cursor: input.cursor,
      pageSize: input.pageSize
    });
    if (typeof this.fileSystem.lstat === 'function') {
      page.items = await Promise.all(page.items.map(async (item) => {
        try {
          const stat = await this.fileSystem.lstat(item.path);
          const metadata = await captureLocalFileMetadata(this.fileSystem, item.path, stat, this.capabilities().metadata);
          return {
            ...item,
            size: metadata.size,
            modifiedAt: metadata.timestamps?.modifiedAt || null,
            mode: metadata.permissions?.mode ?? null,
            metadata
          };
        } catch (error) {
          return {
            ...item,
            accessible: false,
            size: null,
            modifiedAt: null,
            mode: null,
            metadata: null,
            metadataErrorCode: error instanceof FileMetadataError ? error.code : 'FILE_METADATA_CAPTURE_FAILED'
          };
        }
      }));
    }
    return { ...page, endpointIdentity: { deviceId: config.deviceId } };
  }

  async testConnection(context = {}, input = {}) {
    const startedAt = Date.now();
    const config = this.normalizeConfig(input);
    const base = {
      testedAt: this.clock(),
      latencyMs: 0,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      endpointIdentity: {
        deviceId: config.deviceId,
        hostname: this.hostname,
        platform: safePlatformName(this.platform),
        architecture: this.architecture
      }
    };
    if (context.signal?.aborted) {
      return normalizeConnectionTestResult({
        ...base,
        status: 'failure',
        checks: [],
        error: {
          code: 'LOCAL_TEST_CANCELED', category: 'canceled', retryable: false,
          safeMessage: 'Local connection test was canceled.', retryAfterSeconds: null, details: {}, causeFingerprint: null
        }
      }, { clock: this.clock, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
    try {
      await this.fileSystem.access(this.homeDirectory, fs.constants.R_OK);
      const stat = await this.fileSystem.stat(this.homeDirectory);
      if (!stat.isDirectory()) throw new Error('Home path is not a directory.');
      return normalizeConnectionTestResult({
        ...base,
        status: 'success',
        latencyMs: Math.max(0, Date.now() - startedAt),
        checks: [{ id: 'local-read-access', status: 'pass', safeMessage: 'DeployerX can read local source paths.' }],
        error: null
      }, { clock: this.clock, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    } catch {
      return normalizeConnectionTestResult({
        ...base,
        status: 'failure',
        latencyMs: Math.max(0, Date.now() - startedAt),
        checks: [{ id: 'local-read-access', status: 'fail', safeMessage: 'DeployerX cannot read local source paths.' }],
        error: {
          code: 'LOCAL_SOURCE_READ_DENIED',
          category: 'authorization',
          retryable: false,
          safeMessage: 'Allow DeployerX to read local files, then test this computer again.',
          retryAfterSeconds: null,
          details: { platform: safePlatformName(this.platform) },
          causeFingerprint: null
        }
      }, { clock: this.clock, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    }
  }

  async probeCapabilities(context = {}, input = {}) {
    const connectionTest = await this.testConnection(context, input);
    return {
      status: connectionTest.status === 'success' ? 'available' : 'unavailable',
      probedAt: this.clock(),
      capabilities: this.capabilities(),
      connectionTest,
      reductions: connectionTest.status === 'success' ? [] : [{ capability: 'local-read', reasonCode: 'LOCAL_SOURCE_READ_DENIED' }]
    };
  }
}

class LocalConnectionService {
  constructor({ controlDatabase, deviceId, adapter = new LocalComputerConnectionAdapter() }) {
    if (!controlDatabase) throw new TypeError('Control database is required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
  }

  async list(workspaceId) {
    const records = await this.controlDatabase.repository('connection').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: 1000 });
    return records
      .filter((record) => record.adapterId === ADAPTER_ID)
      .map((record) => ({ ...record, currentDevice: record.endpoint?.deviceId === this.deviceId, capabilities: this.adapter.capabilities() }));
  }

  async ensure(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const probe = await this.adapter.probeCapabilities({}, { deviceId: this.deviceId });
    const connectionTest = normalizeConnectionTestResult(probe.connectionTest, { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    const manifest = this.adapter.manifest();
    return this.controlDatabase.transaction((transaction) => {
      const records = transaction.list('connection', tenant, { limit: 1000 });
      const existing = records.find((record) => record.adapterId === ADAPTER_ID && record.endpoint?.deviceId === this.deviceId);
      if (existing) return existing;
      const hostname = requiredText(connectionTest.endpointIdentity.hostname, 'Hostname', 200);
      const baseName = `This computer (${hostname})`;
      const nameTaken = records.some((record) => record.name.toLowerCase() === baseName.toLowerCase());
      return transaction.create('connection', {
        workspaceId: tenant,
        actorId: actor,
        name: nameTaken ? `${baseName} - ${this.deviceId.slice(-8)}` : baseName,
        kind: 'local',
        adapterId: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        scope: 'device',
        endpoint: connectionTest.endpointIdentity,
        secretRefIds: [],
        trust: { mode: 'local-process' },
        workerAffinity: [`device:${this.deviceId}`],
        lastTest: connectionTest,
        capabilities: manifest.capabilities
      });
    });
  }

  async test(workspaceId, connectionId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Local computer connection was not found.');
    if (current.endpoint?.deviceId !== this.deviceId) throw new Error('This local connection belongs to another device.');
    const result = normalizeConnectionTestResult(
      await this.adapter.testConnection({}, { deviceId: this.deviceId }),
      { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION }
    );
    const updated = await this.controlDatabase.repository('connection').update(
      tenant,
      id,
      { lastTest: result, adapterVersion: ADAPTER_VERSION },
      { expectedRevision: current.revision, actorId }
    );
    return { connection: updated, result };
  }

  async browse(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('Local computer connection was not found.');
    if (current.endpoint?.deviceId !== this.deviceId) throw new Error('This local connection belongs to another device.');
    return this.adapter.browse({}, {
      deviceId: this.deviceId,
      path: input.path,
      cursor: input.cursor,
      pageSize: input.pageSize
    });
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  LocalComputerConnectionAdapter,
  LocalConnectionService,
  loadOrCreateBackupDeviceId
};
