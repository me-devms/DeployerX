const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Client } = require('ssh2');
const { applyLocalFileMetadata, metadataCapabilitiesForConnection } = require('./file-metadata');
const { normalizeArchivePath } = require('./snapshot-browser');
const { fingerprintHostKey } = require('./ssh-connection');

const MAX_SELECTIONS = 500;
const MAX_RESTORE_ITEMS = 100000;
const MAX_RENAME_ATTEMPTS = 1000;
const MODES = new Set(['original', 'alternate']);
const CONFLICT_POLICIES = new Set(['fail', 'overwrite', 'rename', 'skip']);

class FileRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'FileRestoreError';
    this.code = code;
    this.category = options.category || 'restore';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 8192) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new FileRestoreError('RESTORE_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function depth(archivePath) {
  return archivePath.split('/').filter(Boolean).length;
}

function isDescendant(candidate, root) {
  if (candidate === root) return true;
  if (root === '/') return candidate.startsWith('/') && !candidate.startsWith('//');
  return candidate.startsWith(`${root}/`);
}

function baseName(archivePath) {
  return archivePath.replace(/\/$/, '').split('/').filter(Boolean).pop() || 'root';
}

function archiveRelativePath(archivePath) {
  const normalized = normalizeArchivePath(archivePath);
  if (normalized.startsWith('//')) return normalized.slice(2);
  if (/^[A-Za-z]:\//.test(normalized)) return `${normalized[0]}/${normalized.slice(3)}`;
  return normalized.replace(/^\/+/, '');
}

function relativeWithin(root, child) {
  if (root === child) return '';
  return child.slice(root.length).replace(/^\/+/, '');
}

function renamedPath(pathModule, targetPath, attempt) {
  const directory = pathModule.dirname(targetPath);
  const extension = pathModule.extname(targetPath);
  const name = pathModule.basename(targetPath, extension);
  return pathModule.join(directory, `${name} (restored ${attempt})${extension}`);
}

function normalizeRequest(input = {}) {
  const mode = String(input.mode || 'alternate');
  const conflictPolicy = String(input.conflictPolicy || 'fail');
  if (!MODES.has(mode)) throw new FileRestoreError('RESTORE_MODE_INVALID', 'Restore mode is invalid.', { category: 'validation' });
  if (!CONFLICT_POLICIES.has(conflictPolicy)) throw new FileRestoreError('RESTORE_CONFLICT_POLICY_INVALID', 'Restore conflict policy is invalid.', { category: 'validation' });
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_SELECTIONS) throw new FileRestoreError('RESTORE_SELECTION_INVALID', `Choose between 1 and ${MAX_SELECTIONS} snapshot paths.`, { category: 'validation' });
  const paths = [...new Set(input.paths.map((item) => normalizeArchivePath(item)))].sort((left, right) => depth(left) - depth(right) || left.localeCompare(right, 'en-US'));
  const roots = paths.filter((candidate, index) => !paths.slice(0, index).some((root) => isDescendant(candidate, root)));
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'Recovery point ID', 200),
    targetConnectionId: requiredText(input.targetConnectionId, 'Target connection ID', 200),
    mode,
    destinationPath: mode === 'alternate' ? requiredText(input.destinationPath, 'Destination path') : null,
    conflictPolicy,
    paths: roots
  };
}

function expandSelection(manifest, selectedPaths) {
  const manifestEntries = new Map((manifest.files || []).map((entry) => [normalizeArchivePath(entry.path), { ...entry, path: normalizeArchivePath(entry.path) }]));
  const groups = [];
  let totalItems = 0;
  for (const rootPath of selectedPaths) {
    let rootEntry = manifestEntries.get(rootPath) || null;
    const descendants = [...manifestEntries.values()].filter((entry) => isDescendant(entry.path, rootPath));
    if (!rootEntry && descendants.length) rootEntry = { path: rootPath, type: 'directory', sizeBytes: 0, metadata: null, virtual: true };
    if (!rootEntry) throw new FileRestoreError('RESTORE_SELECTION_NOT_FOUND', 'A selected path is not present in this recovery point.', { category: 'not-found' });
    const entries = [rootEntry, ...descendants.filter((entry) => entry.path !== rootPath)]
      .sort((left, right) => depth(left.path) - depth(right.path) || (left.type === 'directory' ? -1 : 1) || left.path.localeCompare(right.path, 'en-US'));
    totalItems += entries.length;
    if (totalItems > MAX_RESTORE_ITEMS) throw new FileRestoreError('RESTORE_SELECTION_TOO_LARGE', `A restore is limited to ${MAX_RESTORE_ITEMS} items.`, { category: 'validation' });
    groups.push({ root: rootEntry, entries });
  }
  return groups;
}

function publicError(error) {
  if (error instanceof FileRestoreError) return { code: error.code, category: error.category, retryable: error.retryable, safeMessage: error.message };
  return { code: 'RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the selected-file restore.' };
}

class LocalRestoreTarget {
  constructor(options = {}) {
    this.fileSystem = options.fileSystem || fs;
    this.pathModule = options.pathModule || path;
    this.platform = options.platform || process.platform;
  }

  normalizeAbsolute(value) {
    const targetPath = requiredText(value, 'Restore target path');
    if (!this.pathModule.isAbsolute(targetPath)) throw new FileRestoreError('RESTORE_TARGET_PATH_INVALID', 'Choose an absolute restore destination.', { category: 'validation' });
    return this.pathModule.normalize(targetPath);
  }

  originalPath(archivePath) {
    const normalized = normalizeArchivePath(archivePath);
    if (this.platform === 'win32') {
      if (!/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith('//')) throw new FileRestoreError('RESTORE_ORIGINAL_PLATFORM_MISMATCH', 'This recovery path cannot be restored to its original location on this computer.', { category: 'compatibility' });
      return this.normalizeAbsolute(normalized.replace(/\//g, '\\'));
    }
    if (!normalized.startsWith('/') || normalized.startsWith('//')) throw new FileRestoreError('RESTORE_ORIGINAL_PLATFORM_MISMATCH', 'This recovery path cannot be restored to its original location on this computer.', { category: 'compatibility' });
    return this.normalizeAbsolute(normalized);
  }

  alternatePath(destinationPath, archivePath) {
    const root = this.normalizeAbsolute(destinationPath);
    const target = this.pathModule.resolve(root, ...archiveRelativePath(archivePath).split('/'));
    const relative = this.pathModule.relative(root, target);
    if (relative.startsWith('..') || this.pathModule.isAbsolute(relative)) throw new FileRestoreError('RESTORE_TARGET_ESCAPE', 'A restore path would escape the selected destination.', { category: 'integrity' });
    return target;
  }

  async inspect(targetPath) {
    try {
      const stat = await this.fileSystem.lstat(targetPath);
      return { exists: true, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, type: null };
      throw new FileRestoreError('RESTORE_TARGET_INSPECTION_FAILED', 'DeployerX could not inspect the restore destination.', { category: 'authorization' });
    }
  }

  async assertSafeParents(targetPath) {
    const parsed = this.pathModule.parse(targetPath);
    const relativeParts = targetPath.slice(parsed.root.length).split(this.pathModule.sep).filter(Boolean);
    let current = parsed.root;
    for (const part of relativeParts.slice(0, -1)) {
      current = this.pathModule.join(current, part);
      const inspected = await this.inspect(current);
      if (!inspected.exists) continue;
      if (inspected.type === 'symlink') throw new FileRestoreError('RESTORE_TARGET_LINK_UNSAFE', 'Restore destinations cannot pass through symbolic links.', { category: 'integrity' });
      if (inspected.type !== 'directory') throw new FileRestoreError('RESTORE_TARGET_PARENT_INVALID', 'A restore destination parent is not a directory.', { category: 'conflict' });
    }
  }

  async ensureDirectory(targetPath) {
    await this.assertSafeParents(this.pathModule.join(targetPath, '.restore-child'));
    const parsed = this.pathModule.parse(targetPath);
    const parts = targetPath.slice(parsed.root.length).split(this.pathModule.sep).filter(Boolean);
    let current = parsed.root;
    for (const part of parts) {
      current = this.pathModule.join(current, part);
      let inspected = await this.inspect(current);
      if (!inspected.exists) {
        try { await this.fileSystem.mkdir(current, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        inspected = await this.inspect(current);
      }
      if (inspected.type === 'symlink' || inspected.type !== 'directory') throw new FileRestoreError('RESTORE_TARGET_PATH_UNSAFE', 'A restore directory is not safe to use.', { category: 'integrity' });
    }
  }

  async commitStage(stagePath, targetPath, overwrite) {
    if (!overwrite) {
      await this.fileSystem.rename(stagePath, targetPath);
      return;
    }
    try {
      await this.fileSystem.rename(stagePath, targetPath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      const rollbackPath = `${targetPath}.deployerx-rollback-${crypto.randomUUID()}`;
      await this.fileSystem.rename(targetPath, rollbackPath);
      try {
        await this.fileSystem.rename(stagePath, targetPath);
        await this.fileSystem.rm(rollbackPath, { recursive: true, force: true });
      } catch (commitError) {
        await this.fileSystem.rename(rollbackPath, targetPath).catch(() => {});
        throw commitError;
      }
    }
  }

  async writeFile(targetPath, chunks, expectedBytes, options = {}) {
    await this.ensureDirectory(this.pathModule.dirname(targetPath));
    const stagePath = `${targetPath}.deployerx-stage-${crypto.randomUUID()}`;
    let handle;
    let bytesWritten = 0;
    try {
      handle = await this.fileSystem.open(stagePath, 'wx', 0o600);
      for await (const chunk of chunks) {
        await handle.write(Buffer.from(chunk));
        bytesWritten += chunk.length;
        options.onBytes?.(chunk.length);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (bytesWritten !== Number(expectedBytes)) throw new FileRestoreError('RESTORE_BYTE_COUNT_MISMATCH', 'A restored file did not match its expected size.', { category: 'integrity' });
      await this.commitStage(stagePath, targetPath, options.overwrite);
      return bytesWritten;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.fileSystem.rm(stagePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async createSymlink(targetPath, linkTarget, options = {}) {
    if (this.pathModule.isAbsolute(linkTarget) || linkTarget.split(/[\\/]+/).includes('..')) throw new FileRestoreError('RESTORE_SYMBOLIC_LINK_UNSAFE', 'Only contained relative symbolic links can be restored.', { category: 'integrity' });
    await this.ensureDirectory(this.pathModule.dirname(targetPath));
    const stagePath = `${targetPath}.deployerx-stage-${crypto.randomUUID()}`;
    try {
      await this.fileSystem.symlink(linkTarget, stagePath);
      await this.commitStage(stagePath, targetPath, options.overwrite);
    } catch (error) {
      await this.fileSystem.rm(stagePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async applyMetadata(targetPath, metadata) {
    if (!metadata) return [];
    const platform = this.platform === 'win32' ? 'windows' : this.platform === 'darwin' ? 'macos' : 'linux';
    const result = await applyLocalFileMetadata(this.fileSystem, targetPath, metadata, metadataCapabilitiesForConnection('local', platform), { strict: false });
    return result.warnings || [];
  }
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => sftp[method](...args, (error, result) => error ? reject(error) : resolve(result)));
}

class SftpRestoreTarget {
  constructor(client, sftp) {
    this.client = client;
    this.sftp = sftp;
    this.pathModule = path.posix;
  }

  normalizeAbsolute(value) {
    const targetPath = requiredText(value, 'Restore target path').replace(/\\/g, '/');
    if (!targetPath.startsWith('/') || targetPath.includes('\0')) throw new FileRestoreError('RESTORE_TARGET_PATH_INVALID', 'Choose an absolute SFTP restore destination.', { category: 'validation' });
    const normalized = path.posix.normalize(targetPath);
    if (!normalized.startsWith('/')) throw new FileRestoreError('RESTORE_TARGET_ESCAPE', 'A restore path would escape the selected destination.', { category: 'integrity' });
    return normalized;
  }

  originalPath(archivePath) {
    const normalized = normalizeArchivePath(archivePath);
    if (!normalized.startsWith('/') || normalized.startsWith('//')) throw new FileRestoreError('RESTORE_ORIGINAL_PLATFORM_MISMATCH', 'This recovery path cannot be restored to its original location on this SSH server.', { category: 'compatibility' });
    return this.normalizeAbsolute(normalized);
  }

  alternatePath(destinationPath, archivePath) {
    const root = this.normalizeAbsolute(destinationPath);
    const target = path.posix.resolve(root, archiveRelativePath(archivePath));
    if (target !== root && !target.startsWith(`${root}/`)) throw new FileRestoreError('RESTORE_TARGET_ESCAPE', 'A restore path would escape the selected destination.', { category: 'integrity' });
    return target;
  }

  async inspect(targetPath) {
    try {
      const stat = await sftpCall(this.sftp, 'lstat', targetPath);
      const mode = Number(stat.mode || 0) & 0o170000;
      return { exists: true, type: mode === 0o040000 ? 'directory' : mode === 0o100000 ? 'file' : mode === 0o120000 ? 'symlink' : 'other' };
    } catch (error) {
      if (error?.code === 2 || error?.code === 'ENOENT') return { exists: false, type: null };
      throw new FileRestoreError('RESTORE_TARGET_INSPECTION_FAILED', 'DeployerX could not inspect the SFTP restore destination.', { category: 'authorization' });
    }
  }

  async assertSafeParents(targetPath) {
    const parts = path.posix.normalize(targetPath).split('/').filter(Boolean);
    let current = '/';
    for (const part of parts.slice(0, -1)) {
      current = path.posix.join(current, part);
      const inspected = await this.inspect(current);
      if (!inspected.exists) continue;
      if (inspected.type === 'symlink') throw new FileRestoreError('RESTORE_TARGET_LINK_UNSAFE', 'Restore destinations cannot pass through symbolic links.', { category: 'integrity' });
      if (inspected.type !== 'directory') throw new FileRestoreError('RESTORE_TARGET_PARENT_INVALID', 'A restore destination parent is not a directory.', { category: 'conflict' });
    }
  }

  async ensureDirectory(targetPath) {
    const parts = path.posix.normalize(targetPath).split('/').filter(Boolean);
    let current = '/';
    for (const part of parts) {
      current = path.posix.join(current, part);
      let inspected = await this.inspect(current);
      if (!inspected.exists) {
        try { await sftpCall(this.sftp, 'mkdir', current, { mode: 0o700 }); } catch (error) { if (error?.code !== 4) throw error; }
        inspected = await this.inspect(current);
      }
      if (inspected.type === 'symlink' || inspected.type !== 'directory') throw new FileRestoreError('RESTORE_TARGET_PATH_UNSAFE', 'An SFTP restore directory is not safe to use.', { category: 'integrity' });
    }
  }

  async commitStage(stagePath, targetPath, overwrite) {
    if (overwrite) {
      if (typeof this.sftp.ext_openssh_rename !== 'function') throw new FileRestoreError('RESTORE_ATOMIC_OVERWRITE_UNAVAILABLE', 'This SFTP server does not support atomic overwrite restores. Choose rename or skip.', { category: 'compatibility' });
      await sftpCall(this.sftp, 'ext_openssh_rename', stagePath, targetPath);
      return;
    }
    await sftpCall(this.sftp, 'rename', stagePath, targetPath);
  }

  async writeFile(targetPath, chunks, expectedBytes, options = {}) {
    await this.ensureDirectory(path.posix.dirname(targetPath));
    const stagePath = `${targetPath}.deployerx-stage-${crypto.randomUUID()}`;
    let handle = null;
    let position = 0;
    try {
      handle = await sftpCall(this.sftp, 'open', stagePath, 'wx', 0o600);
      for await (const value of chunks) {
        const buffer = Buffer.from(value);
        await new Promise((resolve, reject) => this.sftp.write(handle, buffer, 0, buffer.length, position, (error) => error ? reject(error) : resolve()));
        position += buffer.length;
        options.onBytes?.(buffer.length);
      }
      if (typeof this.sftp.ext_openssh_fsync === 'function') await sftpCall(this.sftp, 'ext_openssh_fsync', handle);
      await sftpCall(this.sftp, 'close', handle);
      handle = null;
      if (position !== Number(expectedBytes)) throw new FileRestoreError('RESTORE_BYTE_COUNT_MISMATCH', 'A restored file did not match its expected size.', { category: 'integrity' });
      await this.commitStage(stagePath, targetPath, options.overwrite);
      return position;
    } catch (error) {
      if (handle) await sftpCall(this.sftp, 'close', handle).catch(() => {});
      await sftpCall(this.sftp, 'unlink', stagePath).catch(() => {});
      throw error;
    }
  }

  async createSymlink(targetPath, linkTarget, options = {}) {
    if (path.posix.isAbsolute(linkTarget) || linkTarget.split('/').includes('..')) throw new FileRestoreError('RESTORE_SYMBOLIC_LINK_UNSAFE', 'Only contained relative symbolic links can be restored.', { category: 'integrity' });
    await this.ensureDirectory(path.posix.dirname(targetPath));
    const stagePath = `${targetPath}.deployerx-stage-${crypto.randomUUID()}`;
    try {
      await sftpCall(this.sftp, 'symlink', linkTarget, stagePath);
      await this.commitStage(stagePath, targetPath, options.overwrite);
    } catch (error) {
      await sftpCall(this.sftp, 'unlink', stagePath).catch(() => {});
      throw error;
    }
  }

  async applyMetadata(targetPath, metadata) {
    if (!metadata) return [];
    const warnings = [];
    const attempt = async (field, method, ...args) => {
      if (typeof this.sftp[method] !== 'function') return warnings.push({ field, code: 'FILE_METADATA_RESTORE_HANDLER_MISSING' });
      try { await sftpCall(this.sftp, method, targetPath, ...args); } catch { warnings.push({ field, code: 'FILE_METADATA_RESTORE_FAILED' }); }
    };
    if (metadata.ownership && Number.isInteger(metadata.ownership.uid) && Number.isInteger(metadata.ownership.gid)) await attempt('ownership', 'chown', metadata.ownership.uid, metadata.ownership.gid);
    if (metadata.permissions?.mode !== undefined && metadata.type !== 'symlink') await attempt('permissions', 'chmod', Number(metadata.permissions.mode));
    if (metadata.timestamps?.accessedAt && metadata.timestamps?.modifiedAt && metadata.type !== 'symlink') {
      await attempt('timestamps', 'utimes', Math.floor(new Date(metadata.timestamps.accessedAt).getTime() / 1000), Math.floor(new Date(metadata.timestamps.modifiedAt).getTime() / 1000));
    }
    return warnings;
  }

  async close() {
    try { this.sftp.end(); } catch {}
    try { this.client.end(); } catch {}
  }
}

async function createConnectionRestoreTarget({ connection, workspaceId, secretStore, ClientClass = Client } = {}) {
  if (connection.kind === 'local') return new LocalRestoreTarget();
  if (connection.kind !== 'ssh') throw new FileRestoreError('RESTORE_TARGET_UNSUPPORTED', 'This connection type cannot receive file restores.', { category: 'compatibility' });
  if (!secretStore) throw new TypeError('SecretRef store is required for SSH restores.');
  const endpoint = connection.endpoint || {};
  const expectedFingerprint = requiredText(connection.trust?.fingerprint, 'Pinned SSH host-key fingerprint', 200);
  const [credentialSecretRefId, passphraseSecretRefId = null] = connection.secretRefIds || [];
  return new Promise((resolve, reject) => {
    const client = new ClientClass();
    let settled = false;
    let hostVerified = false;
    const finish = (error, target) => {
      if (settled) return;
      settled = true;
      if (error) { try { client.end(); } catch {}; reject(error); }
      else resolve(target);
    };
    client.once('error', () => finish(new FileRestoreError('RESTORE_SSH_CONNECTION_FAILED', 'DeployerX could not connect to the SSH restore target.', { category: 'connection', retryable: true })));
    client.once('ready', () => client.sftp((error, sftp) => error
      ? finish(new FileRestoreError('RESTORE_SFTP_UNAVAILABLE', 'SSH connected, but SFTP is unavailable for restores.', { category: 'compatibility' }))
      : finish(null, new SftpRestoreTarget(client, sftp))));
    client.connect({
      host: requiredText(endpoint.host, 'SSH host', 255),
      port: Number(endpoint.port || 22),
      username: requiredText(endpoint.username, 'SSH username', 255),
      readyTimeout: Math.min(120000, Math.max(1000, Number(endpoint.timeoutMs) || 15000)),
      hostVerifier(key) {
        hostVerified = fingerprintHostKey(key) === expectedFingerprint;
        return hostVerified;
      },
      authHandler(_methodsLeft, _partialSuccess, callback) {
        if (!hostVerified) return callback(false);
        Promise.resolve(secretStore.resolve({ workspaceId, id: credentialSecretRefId }))
          .then(async (credential) => endpoint.authType === 'password'
            ? callback({ type: 'password', username: endpoint.username, password: credential })
            : callback({ type: 'publickey', username: endpoint.username, key: credential, ...(passphraseSecretRefId ? { passphrase: await secretStore.resolve({ workspaceId, id: passphraseSecretRefId }) } : {}) }))
          .catch(() => callback(false));
      }
    });
  });
}

class FileRestoreService {
  constructor({ controlDatabase, snapshotBrowser, deviceId, createTarget, clock } = {}) {
    if (!controlDatabase || !snapshotBrowser || !deviceId) throw new TypeError('Control database, snapshot browser, and device ID are required.');
    this.controlDatabase = controlDatabase;
    this.snapshotBrowser = snapshotBrowser;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.createTarget = createTarget || (() => new LocalRestoreTarget());
    this.clock = clock || (() => new Date().toISOString());
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: [request.recoveryPointId],
      targetConnectionId: request.targetConnectionId,
      target: { destinationPath: request.destinationPath, selectedPaths: request.paths },
      mode: request.mode,
      conflictPolicy: request.conflictPolicy,
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', itemsTotal: 0, itemsCompleted: 0, itemsSkipped: 0, bytesTotal: 0, bytesWritten: 0, currentPath: null, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null,
      result: null
    });
    const operation = this.#execute(tenant, actor, record.id, request).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, operation);
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record) throw new FileRestoreError('RESTORE_RUN_NOT_FOUND', 'The restore run was not found.', { category: 'not-found' });
    return record;
  }

  async list(workspaceId, options = {}) {
    const records = await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) });
    return records.filter((record) => !record.target?.engine);
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const records = await this.controlDatabase.repository('restoreRun').list(tenant, { limit: 1000 });
    const abandoned = records.filter((record) => !record.target?.engine && ['queued', 'preparing', 'running', 'validating'].includes(record.state) && !this.active.has(record.id));
    const reconciled = [];
    for (const record of abandoned) {
      const interrupted = await this.#project(tenant, record.id, {
        state: 'interrupted',
        progress: { ...(record.progress || {}), phase: 'interrupted', currentPath: null, updatedAt: this.clock() }
      }, actor);
      reconciled.push(await this.#project(tenant, record.id, {
        state: 'failed',
        result: { error: { code: 'RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: true, safeMessage: 'The DeployerX process stopped before this restore completed.' }, completedAt: this.clock() }
      }, actor));
    }
    return reconciled;
  }

  async #project(workspaceId, restoreRunId, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, restoreRunId);
      return transaction.projectExecution('restoreRun', workspaceId, restoreRunId, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #execute(workspaceId, actorId, restoreRunId, request) {
    const startedMs = Date.now();
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, itemsSkipped: 0, bytesTotal: 0, bytesWritten: 0, currentPath: null, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let target = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const opened = await this.snapshotBrowser.openAuthenticatedSnapshot(workspaceId, request.recoveryPointId);
      const [source, targetConnection] = await Promise.all([
        this.controlDatabase.repository('source').get(workspaceId, opened.point.sourceId),
        this.controlDatabase.repository('connection').get(workspaceId, request.targetConnectionId)
      ]);
      if (!source || !targetConnection) throw new FileRestoreError('RESTORE_TARGET_NOT_FOUND', 'The restore source or target connection was not found.', { category: 'not-found' });
      if (request.mode === 'original' && source.connectionId !== targetConnection.id) throw new FileRestoreError('RESTORE_ORIGINAL_TARGET_MISMATCH', 'Original-location restore must use the protected source connection.', { category: 'validation' });
      if (!(targetConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new FileRestoreError('RESTORE_TARGET_DEVICE_MISMATCH', 'This restore target belongs to another DeployerX device.', { category: 'authorization' });
      if (targetConnection.lastTest?.status !== 'success') throw new FileRestoreError('RESTORE_TARGET_NOT_READY', 'Test the restore target successfully before restoring files.', { category: 'connection', retryable: true });
      const groups = expandSelection(opened.manifest, request.paths);
      target = await this.createTarget({ workspaceId, connection: targetConnection, restoreRunId });
      const plan = await this.#plan(target, groups, request);
      progress = {
        ...progress,
        phase: 'running',
        itemsTotal: plan.length,
        bytesTotal: plan.reduce((sum, item) => sum + (item.entry.type === 'file' && !item.skip ? Number(item.entry.sizeBytes || 0) : 0), 0),
        itemsSkipped: plan.filter((item) => item.skip).length,
        updatedAt: this.clock()
      };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      const directoryMetadata = [];
      for (const item of plan) {
        progress.currentPath = baseName(item.entry.path);
        if (!item.skip) {
          if (item.entry.type === 'directory') {
            await target.ensureDirectory(item.targetPath);
            directoryMetadata.push(item);
          } else if (item.entry.type === 'file') {
            const chunks = opened.engine.streamFile({}, { repositoryId: opened.copy.repositoryId, manifest: opened.manifest, path: item.entry.path, masterKey: opened.masterKey });
            await target.writeFile(item.targetPath, chunks, item.entry.sizeBytes, { overwrite: item.overwrite, onBytes: (count) => { progress.bytesWritten += count; } });
            progress.warnings.push(...(await target.applyMetadata(item.targetPath, item.entry.metadata)).map((warning) => ({ path: baseName(item.entry.path), ...warning })));
          } else if (item.entry.type === 'symlink') {
            const linkTarget = item.entry.metadata?.links?.symbolic?.target;
            if (!linkTarget) throw new FileRestoreError('RESTORE_SYMBOLIC_LINK_METADATA_MISSING', 'A selected symbolic link has no authenticated link target.', { category: 'integrity' });
            await target.createSymlink(item.targetPath, linkTarget, { overwrite: item.overwrite });
            progress.warnings.push(...(await target.applyMetadata(item.targetPath, item.entry.metadata)).map((warning) => ({ path: baseName(item.entry.path), ...warning })));
          } else {
            throw new FileRestoreError('RESTORE_ITEM_TYPE_UNSUPPORTED', 'A selected snapshot item type cannot be restored safely.', { category: 'compatibility' });
          }
        }
        progress.itemsCompleted += 1;
        progress.updatedAt = this.clock();
        progress.throughputBytesPerSecond = Math.round(progress.bytesWritten / Math.max(1, (Date.now() - startedMs) / 1000));
        await this.#project(workspaceId, restoreRunId, { progress: { ...progress } }, actorId);
      }
      for (const item of directoryMetadata.sort((left, right) => depth(right.entry.path) - depth(left.entry.path))) {
        progress.warnings.push(...(await target.applyMetadata(item.targetPath, item.entry.metadata)).map((warning) => ({ path: baseName(item.entry.path), ...warning })));
      }
      progress = { ...progress, phase: 'validating', currentPath: null, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const warning = progress.warnings.length > 0 || progress.itemsSkipped > 0;
      return this.#project(workspaceId, restoreRunId, {
        state: warning ? 'warning' : 'succeeded',
        progress: { ...progress, phase: 'complete', updatedAt: this.clock() },
        validation: { state: 'succeeded', verifiedFiles: plan.filter((item) => item.entry.type === 'file' && !item.skip).length, bytesVerified: progress.bytesWritten, completedAt: this.clock() },
        result: { restoredItems: progress.itemsCompleted - progress.itemsSkipped, skippedItems: progress.itemsSkipped, bytesRestored: progress.bytesWritten, warnings: progress.warnings, completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !['succeeded', 'warning', 'failed', 'canceled'].includes(current.state)) {
        return this.#project(workspaceId, restoreRunId, {
          state: 'failed',
          progress: { ...progress, phase: 'failed', currentPath: null, updatedAt: this.clock() },
          result: { error: publicError(error), completedAt: this.clock() }
        }, actorId);
      }
      throw error;
    } finally {
      await target?.close?.().catch(() => {});
    }
  }

  async #plan(target, groups, request) {
    const plan = [];
    for (const group of groups) {
      const initialRoot = request.mode === 'original'
        ? target.originalPath(group.root.path)
        : target.alternatePath(request.destinationPath, group.root.path);
      await target.assertSafeParents(initialRoot);
      const rootInspection = await target.inspect(initialRoot);
      let rootTarget = initialRoot;
      if (rootInspection.exists && request.conflictPolicy === 'fail') throw new FileRestoreError('RESTORE_CONFLICT', 'A restore target already exists. No files were changed.', { category: 'conflict' });
      if (rootInspection.exists && request.conflictPolicy === 'rename') {
        let found = false;
        for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt += 1) {
          const candidate = renamedPath(target.pathModule, initialRoot, attempt);
          if (!(await target.inspect(candidate)).exists) { rootTarget = candidate; found = true; break; }
        }
        if (!found) throw new FileRestoreError('RESTORE_RENAME_EXHAUSTED', 'DeployerX could not find an available restored-item name.', { category: 'conflict' });
      }
      for (const entry of group.entries) {
        const relative = relativeWithin(group.root.path, entry.path);
        const targetPath = relative ? target.pathModule.join(rootTarget, ...relative.split('/')) : rootTarget;
        await target.assertSafeParents(targetPath);
        const inspected = await target.inspect(targetPath);
        if (request.conflictPolicy === 'fail' && inspected.exists) throw new FileRestoreError('RESTORE_CONFLICT', 'A restore target already exists. No files were changed.', { category: 'conflict' });
        const compatibleDirectory = entry.type === 'directory' && inspected.type === 'directory' && request.conflictPolicy === 'overwrite';
        plan.push({ entry, targetPath, skip: request.conflictPolicy === 'skip' && inspected.exists, overwrite: inspected.exists && request.conflictPolicy === 'overwrite' && !compatibleDirectory });
      }
    }
    return plan;
  }
}

module.exports = {
  CONFLICT_POLICIES,
  FileRestoreError,
  FileRestoreService,
  LocalRestoreTarget,
  SftpRestoreTarget,
  MAX_RESTORE_ITEMS,
  MAX_SELECTIONS,
  archiveRelativePath,
  createConnectionRestoreTarget,
  expandSelection,
  normalizeRequest
};
