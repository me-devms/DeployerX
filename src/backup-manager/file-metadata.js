const crypto = require('crypto');

const METADATA_FIELDS = Object.freeze([
  'permissions',
  'ownership',
  'timestamps',
  'acl',
  'extendedAttributes',
  'symbolicLinks',
  'hardLinks',
  'sparseFiles'
]);
const MAX_ACL_ENTRIES = 256;
const MAX_EXTENDED_ATTRIBUTES = 256;
const MAX_EXTENDED_ATTRIBUTE_BYTES = 1024 * 1024;
const MAX_SPARSE_RANGES = 10000;

class FileMetadataError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'FileMetadataError';
    this.code = code;
    this.field = options.field || null;
  }
}

function boundedText(value, label, maximumLength = 4096) {
  const text = String(value ?? '');
  if (!text || text.includes('\0') || text.length > maximumLength) throw new FileMetadataError('FILE_METADATA_INVALID', `${label} is invalid.`);
  return text;
}

function safeInteger(value, label, options = {}) {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new FileMetadataError('FILE_METADATA_INVALID', `${label} is invalid.`);
  }
  return number;
}

function optionalInteger(value, label, options = {}) {
  if (value === null || value === undefined) return null;
  return safeInteger(value, label, options);
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeMetadataCapabilities(input = {}) {
  return Object.fromEntries(METADATA_FIELDS.map((field) => [field, Boolean(input[field])]));
}

function metadataCapabilitiesForConnection(connectionKind, platform) {
  const ssh = connectionKind === 'ssh';
  const posix = ssh || platform === 'posix' || platform === 'linux' || platform === 'macos';
  return normalizeMetadataCapabilities({
    permissions: posix,
    ownership: posix,
    timestamps: true,
    acl: false,
    extendedAttributes: false,
    symbolicLinks: true,
    hardLinks: !ssh,
    sparseFiles: false
  });
}

function buildMetadataPreservationPolicy(capabilities, input = {}) {
  const supported = normalizeMetadataCapabilities(capabilities);
  const explicit = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? input.fields : {};
  const requested = Object.fromEntries(METADATA_FIELDS.map((field) => [
    field,
    explicit[field] === undefined ? supported[field] : Boolean(explicit[field])
  ]));
  const preserve = Object.fromEntries(METADATA_FIELDS.map((field) => [field, requested[field] && supported[field]]));
  const reductions = METADATA_FIELDS
    .filter((field) => requested[field] && !supported[field])
    .map((field) => ({ field, reasonCode: `METADATA_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}_UNSUPPORTED` }));
  return {
    version: 1,
    requested,
    preserve,
    symbolicLinkMode: preserve.symbolicLinks ? 'preserve' : 'exclude',
    hardLinkMode: preserve.hardLinks ? 'preserve' : 'duplicate-content',
    onUnsupported: input.onUnsupported === 'fail' ? 'fail' : 'warn',
    reductions
  };
}

function normalizeAcl(input) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input) || input.length > MAX_ACL_ENTRIES) throw new FileMetadataError('FILE_METADATA_ACL_INVALID', 'File ACL metadata is invalid.', { field: 'acl' });
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new FileMetadataError('FILE_METADATA_ACL_INVALID', 'File ACL entry is invalid.', { field: 'acl' });
    const type = boundedText(entry.type, 'ACL entry type', 20);
    if (!['allow', 'deny', 'audit', 'alarm'].includes(type)) throw new FileMetadataError('FILE_METADATA_ACL_INVALID', 'File ACL entry type is unsupported.', { field: 'acl' });
    const normalizeList = (value, label, maximum) => {
      if (!Array.isArray(value) || value.length > maximum) throw new FileMetadataError('FILE_METADATA_ACL_INVALID', `${label} is invalid.`, { field: 'acl' });
      return [...new Set(value.map((item) => boundedText(item, label, 80)))].sort();
    };
    return {
      type,
      principal: boundedText(entry.principal, 'ACL principal', 256),
      permissions: normalizeList(entry.permissions, 'ACL permission', 32),
      flags: normalizeList(entry.flags || [], 'ACL flag', 16)
    };
  });
}

function normalizeExtendedAttributes(input) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input) || input.length > MAX_EXTENDED_ATTRIBUTES) {
    throw new FileMetadataError('FILE_METADATA_XATTR_INVALID', 'Extended-attribute metadata is invalid.', { field: 'extendedAttributes' });
  }
  let totalBytes = 0;
  const seen = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new FileMetadataError('FILE_METADATA_XATTR_INVALID', 'Extended-attribute entry is invalid.', { field: 'extendedAttributes' });
    const name = boundedText(entry.name, 'Extended-attribute name', 255);
    if (seen.has(name)) throw new FileMetadataError('FILE_METADATA_XATTR_INVALID', 'Extended-attribute names must be unique.', { field: 'extendedAttributes' });
    seen.add(name);
    const value = boundedText(entry.value, 'Extended-attribute value', Math.ceil(MAX_EXTENDED_ATTRIBUTE_BYTES * 4 / 3) + 8);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new FileMetadataError('FILE_METADATA_XATTR_INVALID', 'Extended-attribute value must be base64.', { field: 'extendedAttributes' });
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new FileMetadataError('FILE_METADATA_XATTR_INVALID', 'Extended-attribute value is not canonical base64.', { field: 'extendedAttributes' });
    totalBytes += bytes.length;
    if (totalBytes > MAX_EXTENDED_ATTRIBUTE_BYTES) throw new FileMetadataError('FILE_METADATA_XATTR_INVALID', 'Extended-attribute metadata is too large.', { field: 'extendedAttributes' });
    return { name, encoding: 'base64', value };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

function normalizeSparse(input, size) {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FileMetadataError('FILE_METADATA_SPARSE_INVALID', 'Sparse-file metadata is invalid.', { field: 'sparseFiles' });
  const logicalSize = safeInteger(input.logicalSize ?? size, 'Sparse logical size');
  const allocatedSize = optionalInteger(input.allocatedSize, 'Sparse allocated size');
  if (allocatedSize !== null && allocatedSize > logicalSize) throw new FileMetadataError('FILE_METADATA_SPARSE_INVALID', 'Sparse allocated size exceeds logical size.', { field: 'sparseFiles' });
  if (!Array.isArray(input.dataRanges) || input.dataRanges.length > MAX_SPARSE_RANGES) throw new FileMetadataError('FILE_METADATA_SPARSE_INVALID', 'Sparse data ranges are invalid.', { field: 'sparseFiles' });
  let previousEnd = 0;
  const dataRanges = input.dataRanges.map((range) => {
    if (!range || typeof range !== 'object' || Array.isArray(range)) throw new FileMetadataError('FILE_METADATA_SPARSE_INVALID', 'Sparse data range is invalid.', { field: 'sparseFiles' });
    const offset = safeInteger(range.offset, 'Sparse range offset');
    const length = safeInteger(range.length, 'Sparse range length', { minimum: 1 });
    const end = offset + length;
    if (!Number.isSafeInteger(end) || offset < previousEnd || end > logicalSize) throw new FileMetadataError('FILE_METADATA_SPARSE_INVALID', 'Sparse data ranges overlap or exceed the logical size.', { field: 'sparseFiles' });
    previousEnd = end;
    return { offset, length };
  });
  return { logicalSize, allocatedSize, dataRanges };
}

function metadataDigest(metadata) {
  return crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}

function normalizeFileMetadata(input = {}, capabilities = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FileMetadataError('FILE_METADATA_INVALID', 'File metadata must be an object.');
  const supported = normalizeMetadataCapabilities(capabilities);
  const type = boundedText(input.type, 'File type', 20);
  if (!['directory', 'file', 'symlink', 'other'].includes(type)) throw new FileMetadataError('FILE_METADATA_INVALID', 'File type is unsupported.');
  const size = optionalInteger(input.size, 'File size');
  const metadata = {
    version: 1,
    type,
    size,
    permissions: supported.permissions && input.permissions ? { mode: safeInteger(input.permissions.mode, 'File mode', { maximum: 0o7777 }) } : null,
    ownership: supported.ownership && input.ownership ? {
      uid: optionalInteger(input.ownership.uid, 'Owner UID'),
      gid: optionalInteger(input.ownership.gid, 'Owner GID'),
      user: input.ownership.user ? boundedText(input.ownership.user, 'Owner name', 256) : null,
      group: input.ownership.group ? boundedText(input.ownership.group, 'Group name', 256) : null
    } : null,
    timestamps: supported.timestamps && input.timestamps ? {
      accessedAt: normalizeTimestamp(input.timestamps.accessedAt),
      modifiedAt: normalizeTimestamp(input.timestamps.modifiedAt),
      changedAt: normalizeTimestamp(input.timestamps.changedAt),
      createdAt: normalizeTimestamp(input.timestamps.createdAt),
      resolution: ['nanoseconds', 'milliseconds', 'seconds'].includes(input.timestamps.resolution) ? input.timestamps.resolution : 'milliseconds'
    } : null,
    links: {
      symbolic: supported.symbolicLinks && input.links?.symbolic ? { target: boundedText(input.links.symbolic.target, 'Symbolic-link target', 4096) } : null,
      hard: supported.hardLinks && input.links?.hard ? {
        key: boundedText(input.links.hard.key, 'Hard-link key', 256),
        linkCount: safeInteger(input.links.hard.linkCount, 'Hard-link count', { minimum: 2 })
      } : null
    },
    acl: supported.acl ? normalizeAcl(input.acl) : null,
    extendedAttributes: supported.extendedAttributes ? normalizeExtendedAttributes(input.extendedAttributes) : null,
    sparse: supported.sparseFiles ? normalizeSparse(input.sparse, size) : null
  };
  return { ...metadata, digest: metadataDigest(metadata) };
}

function statTimestamp(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

async function captureLocalFileMetadata(fileSystem, filePath, stat, capabilities) {
  const supported = normalizeMetadataCapabilities(capabilities);
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
  let symbolic = null;
  if (type === 'symlink' && supported.symbolicLinks) {
    if (typeof fileSystem.readlink !== 'function') throw new FileMetadataError('FILE_METADATA_LINK_READ_FAILED', 'DeployerX could not read the symbolic-link target.', { field: 'symbolicLinks' });
    try {
      symbolic = { target: await fileSystem.readlink(filePath) };
    } catch {
      throw new FileMetadataError('FILE_METADATA_LINK_READ_FAILED', 'DeployerX could not read the symbolic-link target.', { field: 'symbolicLinks' });
    }
  }
  const linkCount = optionalInteger(stat.nlink, 'Hard-link count');
  const hard = supported.hardLinks && type === 'file' && linkCount > 1
    ? { key: `${safeInteger(stat.dev, 'Device ID')}:${safeInteger(stat.ino, 'Inode ID')}`, linkCount }
    : null;
  return normalizeFileMetadata({
    type,
    size: type === 'file' ? optionalInteger(stat.size, 'File size') : null,
    permissions: stat.mode === undefined ? null : { mode: Number(stat.mode) & 0o7777 },
    ownership: stat.uid === undefined && stat.gid === undefined ? null : { uid: stat.uid, gid: stat.gid },
    timestamps: {
      accessedAt: statTimestamp(stat.atime),
      modifiedAt: statTimestamp(stat.mtime),
      changedAt: statTimestamp(stat.ctime),
      createdAt: statTimestamp(stat.birthtime),
      resolution: 'milliseconds'
    },
    links: { symbolic, hard }
  }, supported);
}

function sftpReadlink(sftp, filePath) {
  return new Promise((resolve, reject) => {
    if (typeof sftp.readlink !== 'function') return reject(new Error('unsupported'));
    sftp.readlink(filePath, (error, target) => error ? reject(error) : resolve(target));
  });
}

async function captureSftpFileMetadata(sftp, filePath, type, attributes = {}, capabilities) {
  const supported = normalizeMetadataCapabilities(capabilities);
  let symbolic = null;
  if (type === 'symlink' && supported.symbolicLinks) {
    try {
      symbolic = { target: await sftpReadlink(sftp, filePath) };
    } catch {
      throw new FileMetadataError('FILE_METADATA_LINK_READ_FAILED', 'DeployerX could not read the remote symbolic-link target.', { field: 'symbolicLinks' });
    }
  }
  const secondsToIso = (value) => Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
  return normalizeFileMetadata({
    type,
    size: type === 'file' ? attributes.size : null,
    permissions: attributes.mode === undefined ? null : { mode: Number(attributes.mode) & 0o7777 },
    ownership: attributes.uid === undefined && attributes.gid === undefined ? null : { uid: attributes.uid, gid: attributes.gid },
    timestamps: { accessedAt: secondsToIso(attributes.atime), modifiedAt: secondsToIso(attributes.mtime), changedAt: null, createdAt: null, resolution: 'seconds' },
    links: { symbolic, hard: null }
  }, supported);
}

async function applyLocalFileMetadata(fileSystem, filePath, metadata, capabilities, options = {}) {
  const supported = normalizeMetadataCapabilities(capabilities);
  const normalized = normalizeFileMetadata(metadata, supported);
  const strict = options.strict !== false;
  const applied = [];
  const warnings = [];
  const run = async (field, operation) => {
    try {
      await operation();
      applied.push(field);
    } catch {
      if (strict) throw new FileMetadataError('FILE_METADATA_RESTORE_FAILED', `DeployerX could not restore ${field} metadata.`, { field });
      warnings.push({ field, code: 'FILE_METADATA_RESTORE_FAILED' });
    }
  };
  const symbolic = normalized.type === 'symlink';
  if (normalized.ownership) {
    const method = symbolic && typeof fileSystem.lchown === 'function' ? 'lchown' : 'chown';
    if (typeof fileSystem[method] === 'function') await run('ownership', () => fileSystem[method](filePath, normalized.ownership.uid, normalized.ownership.gid));
    else if (strict) throw new FileMetadataError('FILE_METADATA_RESTORE_HANDLER_MISSING', 'No restore handler is available for ownership metadata.', { field: 'ownership' });
    else warnings.push({ field: 'ownership', code: 'FILE_METADATA_RESTORE_HANDLER_MISSING' });
  }
  if (normalized.permissions && !symbolic && typeof fileSystem.chmod === 'function') {
    await run('permissions', () => fileSystem.chmod(filePath, normalized.permissions.mode));
  } else if (normalized.permissions && !symbolic) {
    if (strict) throw new FileMetadataError('FILE_METADATA_RESTORE_HANDLER_MISSING', 'No restore handler is available for permissions metadata.', { field: 'permissions' });
    warnings.push({ field: 'permissions', code: 'FILE_METADATA_RESTORE_HANDLER_MISSING' });
  }
  if (normalized.timestamps?.accessedAt && normalized.timestamps?.modifiedAt) {
    const method = symbolic && typeof fileSystem.lutimes === 'function' ? 'lutimes' : symbolic ? null : 'utimes';
    if (method && typeof fileSystem[method] === 'function') {
      await run('timestamps', () => fileSystem[method](filePath, new Date(normalized.timestamps.accessedAt), new Date(normalized.timestamps.modifiedAt)));
    } else {
      if (strict) throw new FileMetadataError('FILE_METADATA_RESTORE_HANDLER_MISSING', 'No restore handler is available for timestamp metadata.', { field: 'timestamps' });
      warnings.push({ field: 'timestamps', code: 'FILE_METADATA_RESTORE_HANDLER_MISSING' });
    }
  }
  const handlers = options.handlers || {};
  for (const [field, value, handlerName] of [
    ['acl', normalized.acl, 'applyAcl'],
    ['extendedAttributes', normalized.extendedAttributes, 'applyExtendedAttributes'],
    ['sparseFiles', normalized.sparse, 'applySparseLayout']
  ]) {
    if (value === null) continue;
    if (typeof handlers[handlerName] !== 'function') {
      if (strict) throw new FileMetadataError('FILE_METADATA_RESTORE_HANDLER_MISSING', `No restore handler is available for ${field} metadata.`, { field });
      warnings.push({ field, code: 'FILE_METADATA_RESTORE_HANDLER_MISSING' });
    } else {
      await run(field, () => handlers[handlerName](filePath, value));
    }
  }
  return { applied, warnings, metadataDigest: normalized.digest };
}

module.exports = {
  FileMetadataError,
  MAX_ACL_ENTRIES,
  MAX_EXTENDED_ATTRIBUTES,
  MAX_EXTENDED_ATTRIBUTE_BYTES,
  MAX_SPARSE_RANGES,
  METADATA_FIELDS,
  applyLocalFileMetadata,
  buildMetadataPreservationPolicy,
  captureLocalFileMetadata,
  captureSftpFileMetadata,
  metadataCapabilitiesForConnection,
  normalizeFileMetadata,
  normalizeMetadataCapabilities
};
