const crypto = require('crypto');
const path = require('path');
const {
  buildMetadataPreservationPolicy,
  metadataCapabilitiesForConnection,
  normalizeMetadataCapabilities
} = require('./file-metadata');

const LOCAL_CONNECTION_ADAPTER_ID = 'deployerx.connection.local';
const SSH_CONNECTION_ADAPTER_ID = 'deployerx.connection.ssh';
const LOCAL_FILE_ADAPTER_ID = 'deployerx.files.local';
const SSH_FILE_ADAPTER_ID = 'deployerx.files.ssh';
const MAX_ROOTS = 256;
const MAX_INCLUDE_PATTERNS = 128;
const MAX_EXCLUDE_PATTERNS = 256;

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} is required.`);
  if (text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function pathRules(platform) {
  const windows = platform === 'windows';
  return { module: windows ? path.win32 : path.posix, caseInsensitive: windows };
}

function pathKey(value, caseInsensitive) {
  return caseInsensitive ? value.toLocaleLowerCase('en-US') : value;
}

function isDescendant(candidate, ancestor, rules) {
  const relative = rules.module.relative(ancestor, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${rules.module.sep}`) && !rules.module.isAbsolute(relative);
}

function normalizeRoots(input, platform) {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError('Select at least one file or directory.');
  if (input.length > MAX_ROOTS) throw new TypeError(`A file source can contain at most ${MAX_ROOTS} selected paths.`);
  const rules = pathRules(platform);
  const allowedTypes = new Set(['directory', 'file', 'symlink']);
  const unique = new Map();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Every selected path must be an object.');
    const sourcePath = requiredText(raw.path, 'Selected path', 4096);
    if (!rules.module.isAbsolute(sourcePath)) throw new TypeError('Every selected path must be absolute.');
    const normalizedPath = rules.module.normalize(sourcePath);
    const type = requiredText(raw.type, 'Selected path type', 20);
    if (!allowedTypes.has(type)) throw new TypeError(`Selected path type "${type}" is not supported.`);
    unique.set(pathKey(normalizedPath, rules.caseInsensitive), { path: normalizedPath, type });
  }
  const ordered = [...unique.values()].sort((left, right) => {
    const depthDifference = left.path.split(rules.module.sep).length - right.path.split(rules.module.sep).length;
    return depthDifference || pathKey(left.path, rules.caseInsensitive).localeCompare(pathKey(right.path, rules.caseInsensitive), 'en-US');
  });
  return ordered.filter((candidate, index) => !ordered.slice(0, index).some((ancestor) => ancestor.type === 'directory' && isDescendant(candidate.path, ancestor.path, rules)));
}

function normalizePattern(value, label) {
  const pattern = requiredText(value, label, 512);
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern) || pattern.startsWith('!')) {
    throw new TypeError(`${label} must be a relative, non-negated pattern.`);
  }
  if (pattern.includes('\\') || pattern.includes('//') || /[{}()]/.test(pattern)) {
    throw new TypeError(`${label} uses unsupported glob syntax.`);
  }
  const segments = pattern.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} contains an invalid path segment.`);
  }
  let bracketDepth = 0;
  for (const character of pattern) {
    if (character === '[') bracketDepth += 1;
    if (character === ']') bracketDepth -= 1;
    if (bracketDepth < 0 || bracketDepth > 1) throw new TypeError(`${label} contains an invalid character class.`);
  }
  if (bracketDepth !== 0) throw new TypeError(`${label} contains an unterminated character class.`);
  return pattern;
}

function normalizePatterns(input, label, maximumCount) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array.`);
  if (input.length > maximumCount) throw new TypeError(`${label} can contain at most ${maximumCount} patterns.`);
  const seen = new Set();
  const patterns = [];
  for (const value of input) {
    const pattern = normalizePattern(value, `${label} entry`);
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}

function selectionDigest(selector) {
  return crypto.createHash('sha256').update(JSON.stringify(selector)).digest('hex');
}

function normalizeFileSelector(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('File selector must be an object.');
  const platform = options.platform === 'windows' ? 'windows' : 'posix';
  const metadataCapabilities = normalizeMetadataCapabilities(
    options.metadataCapabilities || metadataCapabilitiesForConnection(options.connectionKind || 'local', platform)
  );
  const metadataInput = input.metadataPolicy && typeof input.metadataPolicy === 'object' && !Array.isArray(input.metadataPolicy)
    ? input.metadataPolicy
    : {};
  const selector = {
    version: 1,
    kind: 'file-paths',
    roots: normalizeRoots(input.roots, platform),
    includePatterns: normalizePatterns(input.includePatterns, 'Include patterns', MAX_INCLUDE_PATTERNS),
    excludePatterns: normalizePatterns(input.excludePatterns, 'Exclude patterns', MAX_EXCLUDE_PATTERNS),
    options: {
      includeHidden: Boolean(input.options?.includeHidden),
      crossMounts: Boolean(input.options?.crossMounts)
    },
    metadataPolicy: buildMetadataPreservationPolicy(metadataCapabilities, {
      fields: metadataInput.fields || metadataInput.requested,
      onUnsupported: metadataInput.onUnsupported
    })
  };
  return { ...selector, digest: selectionDigest(selector) };
}

function fileAdapterForConnection(connection) {
  if (connection.adapterId === LOCAL_CONNECTION_ADAPTER_ID) {
    const platform = connection.endpoint?.platform === 'windows' ? 'windows' : 'posix';
    return {
      adapterId: LOCAL_FILE_ADAPTER_ID,
      platform,
      metadataCapabilities: metadataCapabilitiesForConnection('local', platform)
    };
  }
  if (connection.adapterId === SSH_CONNECTION_ADAPTER_ID) {
    return {
      adapterId: SSH_FILE_ADAPTER_ID,
      platform: 'posix',
      metadataCapabilities: metadataCapabilitiesForConnection('ssh', 'linux')
    };
  }
  throw new TypeError('This connection does not support file-source selection.');
}

class FileSourceService {
  constructor({ controlDatabase, clock = () => new Date().toISOString() }) {
    if (!controlDatabase) throw new TypeError('Control database is required.');
    this.controlDatabase = controlDatabase;
    this.clock = clock;
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const connectionId = options.connectionId ? requiredText(options.connectionId, 'Connection ID', 200) : null;
    return (await this.controlDatabase.repository('source').list(tenant, { limit: 1000 }))
      .filter((source) => source.sourceType === 'files')
      .filter((source) => !connectionId || source.connectionId === connectionId);
  }

  async save(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const connectionId = requiredText(input.connectionId, 'Connection ID', 200);
    const connection = await this.controlDatabase.repository('connection').get(tenant, connectionId);
    if (!connection) throw new Error('File source connection was not found.');
    const adapter = fileAdapterForConnection(connection);
    const selector = normalizeFileSelector(input.selector, {
      platform: adapter.platform,
      metadataCapabilities: adapter.metadataCapabilities
    });
    const data = {
      name: requiredText(input.name, 'File source name', 200),
      connectionId,
      sourceType: 'files',
      adapterId: adapter.adapterId,
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      selector,
      platform: {
        os: connection.adapterId === SSH_CONNECTION_ADAPTER_ID ? 'linux' : connection.endpoint?.platform || 'unknown',
        architecture: connection.endpoint?.architecture || null,
        metadataCapabilities: adapter.metadataCapabilities
      },
      lastDiscovery: {
        discoveredAt: this.clock(),
        status: 'configured',
        rootCount: selector.roots.length,
        selectionDigest: selector.digest,
        metadataReductions: selector.metadataPolicy.reductions
      }
    };
    if (!input.id) {
      return this.controlDatabase.repository('source').create({ workspaceId: tenant, actorId: actor, ...data });
    }
    const id = requiredText(input.id, 'File source ID', 200);
    const current = await this.controlDatabase.repository('source').get(tenant, id);
    if (!current || current.sourceType !== 'files') throw new Error('File source was not found.');
    if (current.connectionId !== connectionId) throw new TypeError('A file source cannot be moved to another connection.');
    const expectedRevision = Number(input.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('File source revision is required for editing.');
    return this.controlDatabase.repository('source').update(tenant, id, data, { expectedRevision, actorId: actor });
  }

  async remove(workspaceId, actorId, sourceId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(sourceId, 'File source ID', 200);
    const current = await this.controlDatabase.repository('source').get(tenant, id);
    if (!current || current.sourceType !== 'files') throw new Error('File source was not found.');
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('File source revision is required for deletion.');
    return this.controlDatabase.repository('source').softDelete(tenant, id, { expectedRevision, actorId: actor });
  }
}

module.exports = {
  FileSourceService,
  LOCAL_FILE_ADAPTER_ID,
  MAX_EXCLUDE_PATTERNS,
  MAX_INCLUDE_PATTERNS,
  MAX_ROOTS,
  SSH_FILE_ADAPTER_ID,
  normalizeFileSelector
};
