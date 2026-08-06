const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { domainToASCII } = require('url');
const { Client, utils } = require('ssh2');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { FileDiscoveryError, createDiscoveryPage } = require('./file-discovery');
const { FileMetadataError, captureSftpFileMetadata, metadataCapabilitiesForConnection } = require('./file-metadata');

const ADAPTER_ID = 'deployerx.connection.ssh';
const ADAPTER_VERSION = '1.0.0';
const MAX_REMOTE_OUTPUT_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 20000;

function requiredText(value, label, maximumLength = 4096) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > maximumLength) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function normalizeHost(value) {
  const input = requiredText(value, 'SSH host', 253);
  if (/[:][/][/]|[\s/@\\]/.test(input)) throw new TypeError('SSH host must be a hostname or IP address without a URL scheme or path.');
  if (net.isIP(input)) return input.toLowerCase();
  const ascii = domainToASCII(input.replace(/[.]$/, '')).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split('.').every((part) => part && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw new TypeError('SSH host is invalid.');
  }
  return ascii;
}

function normalizePort(value) {
  const port = Number(value ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('SSH port must be between 1 and 65535.');
  return port;
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new TypeError('SSH timeout must be between 1 and 60 seconds.');
  return timeoutMs;
}

function fingerprintHostKey(key) {
  const raw = Buffer.from(key);
  return `SHA256:${crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

function normalizeFingerprint(value) {
  const fingerprint = requiredText(value, 'SSH host-key fingerprint', 80).replace(/=+$/, '');
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new TypeError('SSH host-key fingerprint must use the SHA-256 format.');
  return fingerprint;
}

function hostKeyAlgorithm(key) {
  try {
    const parsed = utils.parseKey(Buffer.from(key));
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    return String(item?.type || 'unknown');
  } catch {
    return 'unknown';
  }
}

function adapterError(code, category, safeMessage, retryable = false, details = {}) {
  return { code, category, retryable, safeMessage, retryAfterSeconds: null, details, causeFingerprint: null };
}

function failureResult(base, error) {
  return { ...base, status: 'failure', checks: [], error };
}

function classifyConnectionError(error, flags = {}) {
  if (flags.hostKeyMismatch) {
    return adapterError('SSH_HOST_KEY_MISMATCH', 'integrity', 'The server host key does not match the approved fingerprint. Verify the server before trusting a new key.', false, {
      observedFingerprint: flags.observedFingerprint || null
    });
  }
  if (flags.canceled) return adapterError('SSH_TEST_CANCELED', 'canceled', 'SSH connection test was canceled.');
  if (error?.code === 'ETIMEDOUT' || error?.level === 'client-timeout') {
    return adapterError('SSH_CONNECTION_TIMEOUT', 'timeout', 'The SSH server did not respond before the connection timeout.', true);
  }
  if (error?.level === 'client-authentication') {
    return adapterError('SSH_AUTHENTICATION_FAILED', 'authentication', 'SSH authentication failed. Check the username and credential, then try again.');
  }
  return adapterError('SSH_CONNECT_FAILED', 'connectivity', 'DeployerX could not establish the SSH connection. Check the host, port, firewall, and SSH service.', true);
}

function readLinuxIdentity(connection, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Canceled'), { code: 'ABORT_ERR' }));
    connection.exec('uname -s', (error, stream) => {
      if (error) return reject(Object.assign(new Error('Remote platform probe failed.'), { code: 'SSH_PLATFORM_PROBE_FAILED' }));
      let output = '';
      let overflow = false;
      const onData = (chunk) => {
        if (overflow) return;
        output += Buffer.from(chunk).toString('utf8');
        if (Buffer.byteLength(output, 'utf8') > MAX_REMOTE_OUTPUT_BYTES) overflow = true;
      };
      stream.on('data', onData);
      stream.stderr?.on('data', () => {});
      stream.once('error', () => reject(Object.assign(new Error('Remote platform probe failed.'), { code: 'SSH_PLATFORM_PROBE_FAILED' })));
      stream.once('close', (code) => {
        if (overflow || code !== 0) return reject(Object.assign(new Error('Remote platform probe failed.'), { code: 'SSH_PLATFORM_PROBE_FAILED' }));
        resolve(output.trim());
      });
    });
  });
}

function verifySftp(connection) {
  return new Promise((resolve, reject) => {
    connection.sftp((error, sftp) => {
      if (error) return reject(Object.assign(new Error('SFTP subsystem is unavailable.'), { code: 'SSH_SFTP_UNAVAILABLE' }));
      try { sftp.end(); } catch {}
      resolve();
    });
  });
}

function sftpEntryType(attributes = {}, longname = '') {
  const mode = Number(attributes.mode);
  if (Number.isInteger(mode)) {
    const format = mode & 0o170000;
    if (format === 0o040000) return 'directory';
    if (format === 0o100000) return 'file';
    if (format === 0o120000) return 'symlink';
  }
  if (String(longname).startsWith('d')) return 'directory';
  if (String(longname).startsWith('l')) return 'symlink';
  if (String(longname).startsWith('-')) return 'file';
  return 'other';
}

class LinuxSshConnectionAdapter {
  constructor(options = {}) {
    this.clientFactory = options.clientFactory || (() => new Client());
    this.clock = options.clock || (() => new Date().toISOString());
  }

  manifest() {
    return {
      apiVersion: 1,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      kind: 'connection',
      displayName: 'Linux server over SSH',
      description: 'Access Linux files through host-key-verified SSH and SFTP.',
      lifecycle: 'preview',
      supportedWorkers: [{ os: 'any', architectures: ['any'] }],
      minimumDeployerXVersion: '0.1.3',
      configurationSchema: {
        type: 'object', additionalProperties: false,
        required: ['host', 'port', 'username', 'authType', 'credentialSecretRefId', 'hostKeyFingerprint'],
        properties: {
          host: { type: 'string', minLength: 1, maxLength: 253 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          username: { type: 'string', minLength: 1, maxLength: 128 },
          authType: { enum: ['password', 'private-key'] },
          credentialSecretRefId: { type: 'string', minLength: 1, maxLength: 200 },
          passphraseSecretRefId: { type: ['string', 'null'], maxLength: 200 },
          hostKeyFingerprint: { type: 'string', pattern: '^SHA256:' },
          hostKeyAlgorithm: { type: ['string', 'null'] },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 }
        }
      },
      secretSchema: [
        { id: 'credential', types: ['password', 'private-key'], required: true },
        { id: 'passphrase', types: ['password'], required: false }
      ],
      capabilities: this.capabilities(),
      requiredExecutables: [],
      requiredPrivileges: [{ id: 'ssh-login', description: 'The SSH account must authenticate and open the SFTP subsystem.', required: true }]
    };
  }

  capabilities() {
    const metadata = metadataCapabilitiesForConnection('ssh', 'linux');
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
      transport: { protocol: 'ssh', fileProtocol: 'sftp', hostKeyVerification: 'pinned-sha256' }
    };
  }

  normalizeScanConfig(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('SSH scan configuration must be an object.');
    const unknown = Object.keys(input).filter((key) => !['host', 'port', 'timeoutMs'].includes(key));
    if (unknown.length) throw new TypeError(`Unknown SSH scan field: ${unknown[0]}.`);
    return { host: normalizeHost(input.host), port: normalizePort(input.port), timeoutMs: normalizeTimeout(input.timeoutMs) };
  }

  normalizeConfig(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('SSH connection configuration must be an object.');
    const allowed = ['host', 'port', 'username', 'authType', 'credentialSecretRefId', 'passphraseSecretRefId', 'hostKeyFingerprint', 'hostKeyAlgorithm', 'timeoutMs'];
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new TypeError(`Unknown SSH connection field: ${unknown[0]}.`);
    const authType = requiredText(input.authType, 'SSH authentication type', 40);
    if (!['password', 'private-key'].includes(authType)) throw new TypeError('SSH authentication type is not supported.');
    const username = requiredText(input.username, 'SSH username', 128);
    if (/\p{C}/u.test(username)) throw new TypeError('SSH username contains invalid characters.');
    const passphraseSecretRefId = input.passphraseSecretRefId ? requiredText(input.passphraseSecretRefId, 'Passphrase SecretRef ID', 200) : null;
    if (authType === 'password' && passphraseSecretRefId) throw new TypeError('Password authentication cannot use a key passphrase.');
    return {
      host: normalizeHost(input.host),
      port: normalizePort(input.port),
      username,
      authType,
      credentialSecretRefId: requiredText(input.credentialSecretRefId, 'Credential SecretRef ID', 200),
      passphraseSecretRefId,
      hostKeyFingerprint: normalizeFingerprint(input.hostKeyFingerprint),
      hostKeyAlgorithm: input.hostKeyAlgorithm ? requiredText(input.hostKeyAlgorithm, 'Host-key algorithm', 80) : null,
      timeoutMs: normalizeTimeout(input.timeoutMs)
    };
  }

  validateConfig(config) {
    try {
      this.normalizeConfig(config);
      return [];
    } catch (error) {
      return [{ path: '', code: 'SSH_CONFIG_INVALID', severity: 'error', message: error.message }];
    }
  }

  scanHostKey(context = {}, input = {}) {
    const config = this.normalizeScanConfig(input);
    const client = this.clientFactory();
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener?.('abort', onAbort);
        try { client.end(); } catch {}
        resolve(result);
      };
      const onAbort = () => finish({ status: 'failure', scannedAt: this.clock(), host: config.host, port: config.port, error: adapterError('SSH_SCAN_CANCELED', 'canceled', 'SSH host-key scan was canceled.') });
      if (context.signal?.aborted) return onAbort();
      context.signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => finish({ status: 'failure', scannedAt: this.clock(), host: config.host, port: config.port, error: adapterError('SSH_SCAN_TIMEOUT', 'timeout', 'The SSH server did not present a host key before the timeout.', true) }), config.timeoutMs);
      client.once('error', (error) => {
        if (!settled) finish({ status: 'failure', scannedAt: this.clock(), host: config.host, port: config.port, error: classifyConnectionError(error) });
      });
      try {
        client.connect({
          host: config.host,
          port: config.port,
          username: 'deployerx-host-key-scan',
          readyTimeout: config.timeoutMs,
          hostVerifier: (key) => {
            finish({
              status: 'success', scannedAt: this.clock(), host: config.host, port: config.port,
              fingerprint: fingerprintHostKey(key), algorithm: hostKeyAlgorithm(key),
              warning: 'Confirm this fingerprint through a trusted server channel before approving it.'
            });
            return false;
          }
        });
      } catch (error) {
        finish({ status: 'failure', scannedAt: this.clock(), host: config.host, port: config.port, error: classifyConnectionError(error) });
      }
    });
  }

  testConnection(context = {}, input = {}) {
    const config = this.normalizeConfig(input);
    const client = this.clientFactory();
    const startedAt = Date.now();
    const base = { testedAt: this.clock(), latencyMs: 0, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, endpointIdentity: { host: config.host, port: config.port, hostKeyFingerprint: config.hostKeyFingerprint, hostKeyAlgorithm: config.hostKeyAlgorithm } };
    return new Promise((resolve) => {
      let settled = false;
      let authAttempted = false;
      let timer = null;
      const flags = { hostKeyMismatch: false, canceled: false, observedFingerprint: null };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener?.('abort', onAbort);
        try { client.end(); } catch {}
        resolve(normalizeConnectionTestResult(
          { ...result, latencyMs: Math.max(0, Date.now() - startedAt) },
          { clock: this.clock, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION }
        ));
      };
      const onAbort = () => {
        flags.canceled = true;
        finish(failureResult(base, classifyConnectionError(null, flags)));
      };
      if (context.signal?.aborted) return onAbort();
      context.signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(failureResult(base, adapterError('SSH_CONNECTION_TIMEOUT', 'timeout', 'The SSH connection test did not finish before the timeout.', true))), config.timeoutMs);
      client.once('error', (error) => finish(failureResult(base, classifyConnectionError(error, flags))));
      client.once('ready', async () => {
        try {
          const platform = await readLinuxIdentity(client, context.signal);
          if (platform.toLowerCase() !== 'linux') {
            return finish(failureResult(base, adapterError('SSH_NOT_LINUX', 'compatibility', 'The connected SSH server is not Linux.')));
          }
          await verifySftp(client);
          finish({
            ...base,
            status: 'success',
            checks: [
              { id: 'host-key', status: 'pass', safeMessage: 'Approved SSH host key matched.' },
              { id: 'authentication', status: 'pass', safeMessage: 'SSH authentication succeeded.' },
              { id: 'linux-platform', status: 'pass', safeMessage: 'Remote platform is Linux.' },
              { id: 'sftp', status: 'pass', safeMessage: 'SFTP subsystem is available.' }
            ],
            remotePlatform: { os: 'linux' },
            error: null
          });
        } catch (error) {
          const resultError = error.code === 'SSH_SFTP_UNAVAILABLE'
            ? adapterError('SSH_SFTP_UNAVAILABLE', 'compatibility', 'SSH connected, but the SFTP subsystem is unavailable for file backup.')
            : error.code === 'ABORT_ERR'
              ? adapterError('SSH_TEST_CANCELED', 'canceled', 'SSH connection test was canceled.')
              : adapterError('SSH_PLATFORM_PROBE_FAILED', 'compatibility', 'SSH connected, but DeployerX could not confirm a Linux server.');
          finish(failureResult(base, resultError));
        }
      });
      try {
        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          readyTimeout: config.timeoutMs,
          keepaliveInterval: 10000,
          keepaliveCountMax: 2,
          hostVerifier: (key) => {
            const observed = fingerprintHostKey(key);
            flags.observedFingerprint = observed;
            const matches = observed === config.hostKeyFingerprint;
            flags.hostKeyMismatch = !matches;
            return matches;
          },
          authHandler: (_methodsLeft, _partialSuccess, callback) => {
            if (authAttempted || !flags.observedFingerprint || flags.hostKeyMismatch) return callback(false);
            authAttempted = true;
            Promise.resolve(context.resolveSecret(config.credentialSecretRefId))
              .then(async (credential) => {
                if (config.authType === 'password') return callback({ type: 'password', username: config.username, password: credential });
                const passphrase = config.passphraseSecretRefId ? await context.resolveSecret(config.passphraseSecretRefId) : undefined;
                callback({ type: 'publickey', username: config.username, key: credential, ...(passphrase ? { passphrase } : {}) });
              })
              .catch(() => callback(false));
          }
        });
      } catch (error) {
        finish(failureResult(base, classifyConnectionError(error, flags)));
      }
    });
  }

  browse(context = {}, input = {}) {
    const config = this.normalizeConfig({
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      credentialSecretRefId: input.credentialSecretRefId,
      passphraseSecretRefId: input.passphraseSecretRefId,
      hostKeyFingerprint: input.hostKeyFingerprint,
      hostKeyAlgorithm: input.hostKeyAlgorithm,
      timeoutMs: input.timeoutMs
    });
    const requestedPath = input.path === null || input.path === undefined || input.path === '' ? '/' : String(input.path);
    if (!requestedPath.startsWith('/') || requestedPath.includes('\0') || requestedPath.length > 4096) {
      throw new FileDiscoveryError('DISCOVERY_PATH_INVALID', 'Choose an absolute Linux directory path.');
    }
    const directoryPath = path.posix.normalize(requestedPath);
    const client = this.clientFactory();
    return new Promise((resolve, reject) => {
      let settled = false;
      let authAttempted = false;
      let timer = null;
      let activeSftp = null;
      const flags = { hostKeyMismatch: false, canceled: false, observedFingerprint: null };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener?.('abort', onAbort);
        try { activeSftp?.end(); } catch {}
        try { client.end(); } catch {}
        if (error) reject(error);
        else resolve(result);
      };
      const failFromConnection = (error) => {
        const diagnostic = classifyConnectionError(error, flags);
        finish(new FileDiscoveryError(diagnostic.code, diagnostic.safeMessage, { category: diagnostic.category, retryable: diagnostic.retryable }));
      };
      const onAbort = () => {
        flags.canceled = true;
        finish(new FileDiscoveryError('DISCOVERY_CANCELED', 'Directory browsing was canceled.', { category: 'canceled' }));
      };
      if (context.signal?.aborted) return onAbort();
      context.signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(new FileDiscoveryError('DISCOVERY_TIMEOUT', 'The directory listing did not finish before the SSH timeout.', { category: 'timeout', retryable: true })), config.timeoutMs);
      client.once('error', failFromConnection);
      client.once('ready', () => {
        client.sftp((sftpError, sftp) => {
          if (sftpError) return finish(new FileDiscoveryError('SSH_SFTP_UNAVAILABLE', 'SSH connected, but the SFTP subsystem is unavailable for file browsing.', { category: 'compatibility' }));
          activeSftp = sftp;
          sftp.readdir(directoryPath, async (readError, list = []) => {
            if (readError) {
              const denied = readError.code === 3 || readError.code === 'EACCES' || readError.code === 'EPERM';
              return finish(new FileDiscoveryError(
                denied ? 'DISCOVERY_ACCESS_DENIED' : 'DISCOVERY_READ_FAILED',
                denied ? 'The SSH account does not have permission to read this directory.' : 'DeployerX could not read this SFTP directory.',
                { category: denied ? 'authorization' : 'discovery', retryable: !denied }
              ));
            }
            try {
              const entries = list
                .filter((entry) => entry?.filename
                  && entry.filename !== '.'
                  && entry.filename !== '..'
                  && !entry.filename.includes('/')
                  && !entry.filename.includes('\0')
                  && entry.filename.length <= 1024)
                .map((entry) => ({
                  name: entry.filename,
                  path: path.posix.join(directoryPath, entry.filename),
                  type: sftpEntryType(entry.attrs, entry.longname),
                  size: Number.isSafeInteger(entry.attrs?.size) && entry.attrs.size >= 0 ? entry.attrs.size : null,
                  modifiedAt: Number.isFinite(entry.attrs?.mtime) && Number.isFinite(new Date(entry.attrs.mtime * 1000).getTime())
                    ? new Date(entry.attrs.mtime * 1000).toISOString()
                    : null,
                  mode: Number.isInteger(entry.attrs?.mode) ? entry.attrs.mode : null,
                  hidden: entry.filename.startsWith('.'),
                  accessible: true,
                  sourceAttributes: entry.attrs || {}
                }));
              const parent = path.posix.dirname(directoryPath);
              const page = createDiscoveryPage({
                adapterId: ADAPTER_ID,
                directoryPath,
                parentPath: parent === directoryPath ? null : parent,
                entries,
                cursor: input.cursor,
                pageSize: input.pageSize
              });
              const metadataByPath = new Map(entries.map((entry) => [entry.path, { type: entry.type, attrs: entry.sourceAttributes }]));
              page.items = await Promise.all(page.items.map(async (item) => {
                try {
                  const source = metadataByPath.get(item.path) || { type: item.type, attrs: {} };
                  const metadata = await captureSftpFileMetadata(sftp, item.path, source.type, source.attrs, this.capabilities().metadata);
                  return { ...item, size: metadata.size, modifiedAt: metadata.timestamps?.modifiedAt || null, mode: metadata.permissions?.mode ?? null, metadata };
                } catch (error) {
                  return {
                    ...item,
                    accessible: false,
                    metadata: null,
                    metadataErrorCode: error instanceof FileMetadataError ? error.code : 'FILE_METADATA_CAPTURE_FAILED'
                  };
                }
              }));
              finish(null, { ...page, endpointIdentity: { host: config.host, port: config.port, hostKeyFingerprint: config.hostKeyFingerprint } });
            } catch (error) {
              finish(error instanceof FileDiscoveryError ? error : new FileDiscoveryError('DISCOVERY_RESULT_INVALID', 'The SFTP server returned an invalid directory listing.'));
            }
          });
        });
      });
      try {
        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          readyTimeout: config.timeoutMs,
          keepaliveInterval: 10000,
          keepaliveCountMax: 2,
          hostVerifier: (key) => {
            const observed = fingerprintHostKey(key);
            flags.observedFingerprint = observed;
            flags.hostKeyMismatch = observed !== config.hostKeyFingerprint;
            return !flags.hostKeyMismatch;
          },
          authHandler: (_methodsLeft, _partialSuccess, callback) => {
            if (authAttempted || !flags.observedFingerprint || flags.hostKeyMismatch) return callback(false);
            authAttempted = true;
            Promise.resolve(context.resolveSecret(config.credentialSecretRefId))
              .then(async (credential) => {
                if (config.authType === 'password') return callback({ type: 'password', username: config.username, password: credential });
                const passphrase = config.passphraseSecretRefId ? await context.resolveSecret(config.passphraseSecretRefId) : undefined;
                callback({ type: 'publickey', username: config.username, key: credential, ...(passphrase ? { passphrase } : {}) });
              })
              .catch(() => callback(false));
          }
        });
      } catch (error) {
        failFromConnection(error);
      }
    });
  }

  async probeCapabilities(context = {}, input = {}) {
    const connectionTest = await this.testConnection(context, input);
    return { status: connectionTest.status === 'success' ? 'available' : 'unavailable', probedAt: this.clock(), capabilities: this.capabilities(), connectionTest, reductions: connectionTest.status === 'success' ? [] : [{ capability: 'ssh-files', reasonCode: connectionTest.error.code }] };
  }
}

function secretMetadataInput(ref, actorId) {
  return {
    ...ref,
    actorId,
    id: ref.id,
    workspaceId: ref.workspaceId,
    name: ref.name,
    provider: ref.provider,
    scope: ref.scope,
    providerKey: ref.providerKey,
    secretType: ref.secretType,
    version: ref.version
  };
}

class SshConnectionService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new LinuxSshConnectionAdapter() }) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
  }

  scanHostKey(input) {
    return this.adapter.scanHostKey({}, input);
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('connection').list(tenant, { limit: 1000 }))
      .filter((record) => record.adapterId === ADAPTER_ID)
      .map((record) => ({ ...record, capabilities: this.adapter.capabilities(), currentDevice: (record.workerAffinity || []).includes(`device:${this.deviceId}`) }));
  }

  async create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const name = requiredText(input.name, 'Connection name', 200);
    const authType = requiredText(input.authType, 'SSH authentication type', 40);
    if (!['password', 'private-key'].includes(authType)) throw new TypeError('SSH authentication type is not supported.');
    if (input.hostKeyApproved !== true) throw new TypeError('Explicit SSH host-key approval is required.');
    const credential = requiredText(input.credential, authType === 'password' ? 'SSH password' : 'SSH private key', 1024 * 1024);
    const approvedFingerprint = normalizeFingerprint(input.hostKeyFingerprint);
    const scan = await this.adapter.scanHostKey({}, { host: input.host, port: input.port, timeoutMs: input.timeoutMs });
    if (scan.status !== 'success') throw new Error(scan.error.safeMessage);
    if (scan.fingerprint !== approvedFingerprint) throw new Error('The SSH host key changed before the connection was saved. Scan and verify it again.');

    const createdRefs = [];
    try {
      const credentialRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} SSH ${authType === 'password' ? 'password' : 'private key'}`, secretType: authType === 'password' ? 'password' : 'private-key', value: credential, scope: 'device' });
      createdRefs.push(credentialRef);
      let passphraseRef = null;
      if (authType === 'private-key' && input.passphrase) {
        passphraseRef = await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: `${name} SSH key passphrase`, secretType: 'password', value: String(input.passphrase), scope: 'device' });
        createdRefs.push(passphraseRef);
      }
      const config = this.adapter.normalizeConfig({
        host: input.host, port: input.port, username: input.username, authType,
        credentialSecretRefId: credentialRef.id,
        passphraseSecretRefId: passphraseRef?.id || null,
        hostKeyFingerprint: approvedFingerprint,
        hostKeyAlgorithm: scan.algorithm,
        timeoutMs: input.timeoutMs
      });
      const connection = await this.controlDatabase.transaction((transaction) => {
        for (const ref of createdRefs) transaction.create('secretRef', secretMetadataInput(ref, actor));
        return transaction.create('connection', {
          workspaceId: tenant, actorId: actor, name, kind: 'ssh', adapterId: ADAPTER_ID,
          adapterVersion: ADAPTER_VERSION, scope: 'device',
          endpoint: { host: config.host, port: config.port, username: config.username, authType: config.authType, timeoutMs: config.timeoutMs },
          secretRefIds: createdRefs.map((ref) => ref.id),
          trust: { mode: 'pinned-sha256', fingerprint: config.hostKeyFingerprint, algorithm: config.hostKeyAlgorithm, approvedAt: new Date().toISOString(), approvedBy: actor },
          workerAffinity: [`device:${this.deviceId}`], lastTest: null
        });
      });
      return connection;
    } catch (error) {
      for (const ref of createdRefs.reverse()) {
        await this.secretStore.delete({ workspaceId: tenant, id: ref.id }).catch(() => {});
      }
      throw error;
    }
  }

  async test(workspaceId, connectionId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('SSH source connection was not found.');
    const [credentialSecretRefId, passphraseSecretRefId = null] = current.secretRefIds || [];
    const config = {
      ...current.endpoint,
      credentialSecretRefId,
      passphraseSecretRefId,
      hostKeyFingerprint: current.trust?.fingerprint,
      hostKeyAlgorithm: current.trust?.algorithm
    };
    const result = normalizeConnectionTestResult(await this.adapter.testConnection({
      resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId })
    }, config), { adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION });
    if (result.status === 'success') {
      for (const secretRefId of current.secretRefIds || []) {
        const ref = await this.secretStore.markValidated({ workspaceId: tenant, id: secretRefId, actorId: actorId });
        const metadata = await this.controlDatabase.repository('secretRef').get(tenant, secretRefId);
        if (metadata) await this.controlDatabase.repository('secretRef').update(tenant, secretRefId, { lastValidatedAt: ref.lastValidatedAt }, { expectedRevision: metadata.revision, actorId });
      }
    }
    const updated = await this.controlDatabase.repository('connection').update(tenant, id, { lastTest: result, adapterVersion: ADAPTER_VERSION }, { expectedRevision: current.revision, actorId });
    return { connection: updated, result };
  }

  async browse(workspaceId, connectionId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(connectionId, 'Connection ID', 200);
    const current = await this.controlDatabase.repository('connection').get(tenant, id);
    if (!current || current.adapterId !== ADAPTER_ID) throw new Error('SSH source connection was not found.');
    if (!(current.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Error('This SSH source connection belongs to another device.');
    const [credentialSecretRefId, passphraseSecretRefId = null] = current.secretRefIds || [];
    return this.adapter.browse({
      resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId: tenant, id: secretRefId })
    }, {
      ...current.endpoint,
      credentialSecretRefId,
      passphraseSecretRefId,
      hostKeyFingerprint: current.trust?.fingerprint,
      hostKeyAlgorithm: current.trust?.algorithm,
      path: input.path,
      cursor: input.cursor,
      pageSize: input.pageSize
    });
  }
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  LinuxSshConnectionAdapter,
  SshConnectionService,
  fingerprintHostKey,
  normalizeFingerprint
};
