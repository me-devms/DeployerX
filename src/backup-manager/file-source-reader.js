const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { captureLocalFileMetadata, captureSftpFileMetadata, normalizeMetadataCapabilities } = require('./file-metadata');
const { openSftpSession } = require('./sftp-repository');

const LOCAL_CONNECTION_ADAPTER_ID = 'deployerx.connection.local';
const SSH_CONNECTION_ADAPTER_ID = 'deployerx.connection.ssh';
const MAX_SOURCE_ENTRIES = 1000000;
const MAX_DIRECTORY_DEPTH = 256;
const READ_BLOCK_BYTES = 64 * 1024;

class FileSourceReaderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'FileSourceReaderError';
    this.code = code;
    this.category = options.category || 'source';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is required.`);
  return text;
}

function archivePath(value) {
  return requiredText(value, 'Source path').replace(/\\/g, '/');
}

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globRegex(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') { index += 1; expression += '(?:.*/)?'; }
        else expression += '.*';
      } else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end === -1) throw new TypeError('File selection pattern is invalid.');
      const contents = pattern.slice(index + 1, end);
      expression += `[${contents.startsWith('!') ? '^' + contents.slice(1) : contents}]`;
      index = end;
    } else expression += escapeRegex(character);
  }
  return new RegExp(`${expression}$`);
}

function compilePatterns(patterns = []) {
  return (Array.isArray(patterns) ? patterns : []).map((pattern) => globRegex(requiredText(pattern, 'File selection pattern', 512)));
}

function selectionFilter(selector = {}) {
  const includes = compilePatterns(selector.includePatterns);
  const excludes = compilePatterns(selector.excludePatterns);
  return {
    includeHidden: Boolean(selector.options?.includeHidden),
    crossMounts: Boolean(selector.options?.crossMounts),
    include(relativePath, type) {
      if (type === 'directory') return true;
      return includes.length === 0 || includes.some((pattern) => pattern.test(relativePath));
    },
    exclude(relativePath, type) {
      if (!relativePath) return false;
      return excludes.some((pattern) => pattern.test(relativePath) || (type === 'directory' && pattern.test(`${relativePath}/`)));
    }
  };
}

function selectedMetadataCapabilities(source) {
  const capabilities = normalizeMetadataCapabilities(source.platform?.metadataCapabilities || {});
  const preserve = source.selector?.metadataPolicy?.preserve || {};
  if (!Object.keys(preserve).length) return capabilities;
  return Object.fromEntries(Object.entries(capabilities).map(([field, supported]) => [field, Boolean(supported && preserve[field])]))
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new FileSourceReaderError('FILE_SOURCE_CANCELED', 'File backup was canceled.', { category: 'canceled' });
}

function localType(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function remoteType(attributes = {}, longname = '') {
  const mode = Number(attributes.mode) & 0o170000;
  if (mode === 0o040000 || String(longname).startsWith('d')) return 'directory';
  if (mode === 0o100000 || String(longname).startsWith('-')) return 'file';
  if (mode === 0o120000 || String(longname).startsWith('l')) return 'symlink';
  return 'other';
}

async function throttle(limiter, bytes) {
  if (!limiter) return { limitBytesPerSecond: null, waitedMilliseconds: 0 };
  return limiter.consume(bytes);
}

function wrapLocalBody({ filePath, stat, createReadStream, fileSystem, signal, onProgress, bandwidthLimiter }) {
  return (async function* localFileBody() {
    let bytesRead = 0;
    try {
      for await (const rawPart of createReadStream(filePath, { highWaterMark: READ_BLOCK_BYTES })) {
        assertNotAborted(signal);
        const part = Buffer.from(rawPart);
        bytesRead += part.length;
        const paced = await throttle(bandwidthLimiter, part.length);
        await onProgress?.({ phase: 'reading', path: archivePath(filePath), bytesRead: part.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield part;
      }
      const after = await fileSystem.lstat(filePath);
      if (!after.isFile() || bytesRead !== Number(stat.size) || Number(after.size) !== Number(stat.size) || Number(after.mtimeMs) !== Number(stat.mtimeMs)) {
        throw new FileSourceReaderError('FILE_SOURCE_CHANGED', 'A source file changed while it was being backed up.', { retryable: true });
      }
    } catch (error) {
      if (error instanceof FileSourceReaderError) throw error;
      throw new FileSourceReaderError('FILE_SOURCE_READ_FAILED', 'DeployerX could not read a local source file.', { retryable: true });
    }
  })();
}

function wrapRemoteBody({ session, filePath, attributes, signal, onProgress, bandwidthLimiter }) {
  return (async function* remoteFileBody() {
    const handle = await session.open(filePath, 'r');
    let position = 0;
    try {
      while (true) {
        assertNotAborted(signal);
        const buffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
        const bytesRead = await session.read(handle, buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const part = Buffer.from(buffer.subarray(0, bytesRead));
        const paced = await throttle(bandwidthLimiter, part.length);
        await onProgress?.({ phase: 'reading', path: archivePath(filePath), bytesRead: part.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield part;
      }
      const after = await session.lstat(filePath);
      if (!after || remoteType(after) !== 'file' || position !== Number(attributes.size) || Number(after.size) !== Number(attributes.size) || Number(after.mtime) !== Number(attributes.mtime)) {
        throw new FileSourceReaderError('FILE_SOURCE_CHANGED', 'A remote source file changed while it was being backed up.', { retryable: true });
      }
    } catch (error) {
      if (error instanceof FileSourceReaderError) throw error;
      throw new FileSourceReaderError('FILE_SOURCE_READ_FAILED', 'DeployerX could not read a remote source file.', { retryable: true });
    } finally {
      await session.closeHandle(handle).catch(() => {});
    }
  })();
}

class FileSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, fileSystem = fsPromises, createReadStream = fs.createReadStream, openRemoteSession = openSftpSession } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.openRemoteSession = openRemoteSession;
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'files' || !source.enabled) throw new FileSourceReaderError('FILE_SOURCE_UNAVAILABLE', 'The file source is unavailable.');
    if (source.selector?.kind !== 'file-paths' || !Array.isArray(source.selector.roots) || source.selector.roots.length === 0) throw new FileSourceReaderError('FILE_SOURCE_SELECTION_INVALID', 'The file source does not contain a valid selection.');
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection) throw new FileSourceReaderError('FILE_SOURCE_CONNECTION_MISSING', 'The file source connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new FileSourceReaderError('FILE_SOURCE_OTHER_DEVICE', 'The file source belongs to another device.');
    if (connection.lastTest?.status !== 'success') throw new FileSourceReaderError('FILE_SOURCE_CONNECTION_UNHEALTHY', 'Test the source connection successfully before running a backup.');
    if (![LOCAL_CONNECTION_ADAPTER_ID, SSH_CONNECTION_ADAPTER_ID].includes(connection.adapterId)) throw new FileSourceReaderError('FILE_SOURCE_ADAPTER_UNSUPPORTED', 'This file source adapter cannot run manual backups yet.', { category: 'compatibility' });
    return {
      source,
      connection,
      manifest: { adapterId: source.adapterId, adapterVersion: connection.adapterVersion || '1.0.0', selectionDigest: source.selector.digest, sourceRevision: source.revision }
    };
  }

  async files(workspaceId, sourceId, options = {}) {
    const plan = await this.plan(workspaceId, sourceId);
    const create = plan.connection.adapterId === LOCAL_CONNECTION_ADAPTER_ID
      ? () => this.#localFiles(plan, options)
      : () => this.#remoteFiles(workspaceId, plan, options);
    return { ...plan, create };
  }

  async *#localFiles(plan, options) {
    const selector = plan.source.selector;
    const filter = selectionFilter(selector);
    const rules = plan.source.platform?.os === 'windows' ? path.win32 : path.posix;
    const metadataCapabilities = selectedMetadataCapabilities(plan.source);
    let entries = 0;
    for (const root of selector.roots) {
      const rootPath = rules.normalize(root.path);
      let rootStat;
      try { rootStat = await this.fileSystem.lstat(rootPath); }
      catch { throw new FileSourceReaderError('FILE_SOURCE_ROOT_UNAVAILABLE', 'A selected local source path is unavailable.'); }
      const rootDevice = rootStat.dev;
      const stack = [{ filePath: rootPath, relativePath: '', stat: rootStat, depth: 0, explicit: true }];
      while (stack.length) {
        assertNotAborted(options.signal);
        const current = stack.pop();
        const type = localType(current.stat);
        if (type === 'other' || filter.exclude(current.relativePath, type) || (!current.explicit && !filter.includeHidden && rules.basename(current.filePath).startsWith('.'))) continue;
        if (!filter.crossMounts && type === 'directory' && current.stat.dev !== rootDevice) continue;
        entries += 1;
        if (entries > MAX_SOURCE_ENTRIES) throw new FileSourceReaderError('FILE_SOURCE_LIMIT_EXCEEDED', 'The selected source contains too many entries.', { category: 'capacity' });
        const metadata = await captureLocalFileMetadata(this.fileSystem, current.filePath, current.stat, metadataCapabilities);
        await options.onProgress?.({ phase: 'scanning', path: archivePath(current.filePath), itemsScanned: 1, sizeBytes: type === 'file' ? Number(current.stat.size) : 0 });
        if (filter.include(current.relativePath, type)) {
          yield {
            path: archivePath(current.filePath),
            type,
            metadata,
            ...(type === 'file' ? { content: wrapLocalBody({ filePath: current.filePath, stat: current.stat, createReadStream: this.createReadStream, fileSystem: this.fileSystem, signal: options.signal, onProgress: options.onProgress, bandwidthLimiter: options.bandwidthLimiter }) } : {})
          };
        }
        if (type !== 'directory') continue;
        if (current.depth >= MAX_DIRECTORY_DEPTH) throw new FileSourceReaderError('FILE_SOURCE_DEPTH_EXCEEDED', 'The selected source directory nesting is too deep.', { category: 'capacity' });
        let children;
        try { children = await this.fileSystem.readdir(current.filePath, { withFileTypes: true }); }
        catch { throw new FileSourceReaderError('FILE_SOURCE_DIRECTORY_READ_FAILED', 'DeployerX could not read a selected local directory.'); }
        children.sort((left, right) => right.name.localeCompare(left.name, 'en-US'));
        for (const child of children) {
          const childPath = rules.join(current.filePath, child.name);
          const childRelativePath = current.relativePath ? `${current.relativePath}/${child.name}` : child.name;
          let stat;
          try { stat = await this.fileSystem.lstat(childPath); }
          catch { throw new FileSourceReaderError('FILE_SOURCE_ENTRY_READ_FAILED', 'DeployerX could not inspect a selected local source entry.'); }
          stack.push({ filePath: childPath, relativePath: childRelativePath, stat, depth: current.depth + 1, explicit: false });
        }
      }
    }
  }

  async *#remoteFiles(workspaceId, plan, options) {
    const [credentialSecretRefId, passphraseSecretRefId = null] = plan.connection.secretRefIds || [];
    const session = await this.openRemoteSession({
      connectionConfig: { ...plan.connection.endpoint, credentialSecretRefId, passphraseSecretRefId, hostKeyFingerprint: plan.connection.trust?.fingerprint, hostKeyAlgorithm: plan.connection.trust?.algorithm },
      resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }),
      signal: options.signal
    });
    const selector = plan.source.selector;
    const filter = selectionFilter(selector);
    const metadataCapabilities = selectedMetadataCapabilities(plan.source);
    let entries = 0;
    try {
      for (const root of selector.roots) {
        const rootPath = path.posix.normalize(root.path);
        const rootAttributes = await session.lstat(rootPath);
        if (!rootAttributes) throw new FileSourceReaderError('FILE_SOURCE_ROOT_UNAVAILABLE', 'A selected remote source path is unavailable.');
        const stack = [{ filePath: rootPath, relativePath: '', attributes: rootAttributes, longname: '', depth: 0, explicit: true }];
        while (stack.length) {
          assertNotAborted(options.signal);
          const current = stack.pop();
          const type = remoteType(current.attributes, current.longname);
          if (type === 'other' || filter.exclude(current.relativePath, type) || (!current.explicit && !filter.includeHidden && path.posix.basename(current.filePath).startsWith('.'))) continue;
          entries += 1;
          if (entries > MAX_SOURCE_ENTRIES) throw new FileSourceReaderError('FILE_SOURCE_LIMIT_EXCEEDED', 'The selected source contains too many entries.', { category: 'capacity' });
          const metadata = await captureSftpFileMetadata(session.sftp, current.filePath, type, current.attributes, metadataCapabilities);
          await options.onProgress?.({ phase: 'scanning', path: archivePath(current.filePath), itemsScanned: 1, sizeBytes: type === 'file' ? Number(current.attributes.size) : 0 });
          if (filter.include(current.relativePath, type)) {
            yield {
              path: archivePath(current.filePath),
              type,
              metadata,
              ...(type === 'file' ? { content: wrapRemoteBody({ session, filePath: current.filePath, attributes: current.attributes, signal: options.signal, onProgress: options.onProgress, bandwidthLimiter: options.bandwidthLimiter }) } : {})
            };
          }
          if (type !== 'directory') continue;
          if (current.depth >= MAX_DIRECTORY_DEPTH) throw new FileSourceReaderError('FILE_SOURCE_DEPTH_EXCEEDED', 'The selected source directory nesting is too deep.', { category: 'capacity' });
          let children;
          try { children = await session.readdir(current.filePath); }
          catch { throw new FileSourceReaderError('FILE_SOURCE_DIRECTORY_READ_FAILED', 'DeployerX could not read a selected remote directory.'); }
          children = children.filter((entry) => entry?.filename && !['.', '..'].includes(entry.filename) && !entry.filename.includes('/') && !entry.filename.includes('\0'));
          children.sort((left, right) => right.filename.localeCompare(left.filename, 'en-US'));
          for (const child of children) {
            stack.push({ filePath: path.posix.join(current.filePath, child.filename), relativePath: current.relativePath ? `${current.relativePath}/${child.filename}` : child.filename, attributes: child.attrs || {}, longname: child.longname || '', depth: current.depth + 1, explicit: false });
          }
        }
      }
    } finally {
      session.close();
    }
  }
}

module.exports = {
  FileSourceReaderError,
  FileSourceReaderService,
  MAX_DIRECTORY_DEPTH,
  MAX_SOURCE_ENTRIES,
  archivePath,
  globRegex,
  selectionFilter
};
