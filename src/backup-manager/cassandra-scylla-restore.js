const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ADAPTER_ID, cqlshrcContents, normalizeConfig, stableDigest } = require('./cassandra-scylla');
const {
  ARCHIVE_MAGIC,
  CassandraScyllaNodeRuntimeFactory,
  compareIncrementalCursors
} = require('./cassandra-scylla-physical');
const {
  compareCommitLogCursors,
  evidenceDigest,
  planCassandraCommitLogRestore
} = require('./cassandra-commit-log');

const OFFLINE_CONFIRMATION = 'CREATE CASSANDRA OFFLINE BUNDLE';
const ALTERNATE_CONFIRMATIONS = Object.freeze({
  cassandra: 'RESTORE CASSANDRA ALTERNATE',
  scylladb: 'RESTORE SCYLLA ALTERNATE'
});
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const ACTIVE_STATES = new Set(['queued', 'preparing', 'running', 'validating', 'canceling']);
const MANIFEST_PATH = 'cassandra-scylla/cluster-manifest.json';
const MAX_MANIFEST_BYTES = 24 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_HEADER_BYTES = 64 * 1024;
const MAX_ARCHIVE_FILES = 100000;
const MAX_CHAIN_LENGTH = 10000;
const SAFE_STAGE_PATTERN = /^\/tmp\/deployerx-cassandra-restore-[0-9a-f]{32}$/;

class CassandraScyllaRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CassandraScyllaRestoreError';
    this.code = code;
    this.category = options.category || 'restore';
    this.retryable = Boolean(options.retryable);
    this.details = options.details || {};
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function publicError(error) {
  if (error?.code) return {
    code: String(error.code).slice(0, 100),
    category: String(error.category || 'restore').slice(0, 80),
    retryable: Boolean(error.retryable),
    safeMessage: String(error.message || 'The Cassandra/Scylla recovery failed.').slice(0, 500)
  };
  return { code: 'CASSANDRA_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete Cassandra/Scylla recovery.' };
}

function safeArchivePath(value) {
  const input = requiredText(value, 'Archive member path', 4096);
  if (input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:/.test(input) || /[\u0000-\u001f\u007f]/.test(input)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_PATH_UNSAFE', 'A Cassandra/Scylla archive contains an unsafe path.', { category: 'integrity' });
  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized === '.' || normalized.startsWith('../') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_PATH_UNSAFE', 'A Cassandra/Scylla archive contains an unsafe path.', { category: 'integrity' });
  return normalized;
}

function safeLocalRoot(value) {
  const root = path.resolve(requiredText(value, 'Offline bundle destination', 4096));
  const parsed = path.parse(root);
  if (!path.isAbsolute(root) || root === parsed.root || root.length <= parsed.root.length + 2) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_DESTINATION_UNSAFE', 'Choose a specific absolute destination for the offline bundle.', { category: 'validation' });
  return root;
}

function containedLocalPath(root, relative) {
  const target = path.resolve(root, ...safeArchivePath(relative).split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_PATH_UNSAFE', 'A Cassandra/Scylla archive path escapes the recovery root.', { category: 'integrity' });
  return target;
}

function unsignedDigest(value) {
  const copy = structuredClone(value);
  delete copy.manifestDigest;
  return stableDigest(copy);
}

function parseVersion(value, label) {
  const text = requiredText(value, label, 100);
  const match = /^(20\d{2}|\d{1,2})[.](\d+)(?:[.](\d+))?/.exec(text);
  if (!match) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_VERSION_INVALID', `${label} is invalid.`, { category: 'compatibility' });
  return { text, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
}

function assertCompatibleVersions(product, sourceValue, targetValue) {
  const source = parseVersion(sourceValue, 'Protected product version');
  const target = parseVersion(targetValue, 'Target product version');
  if (source.major !== target.major) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_VERSION_INCOMPATIBLE', 'Alternate recovery requires the same conservative Cassandra/ScyllaDB major release line.', { category: 'compatibility' });
  if (product === 'scylladb' && source.major >= 2000 && source.minor !== target.minor) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_VERSION_INCOMPATIBLE', 'ScyllaDB yearly release lines must match for native SSTable recovery.', { category: 'compatibility' });
  return { source: source.text, target: target.text, policy: 'same-major-release-line' };
}

class AsyncByteReader {
  constructor(source) {
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw new TypeError('Archive content must be an async iterable.');
    this.iterator = source[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  async #fill() {
    while (!this.buffer.length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) { this.ended = true; break; }
      const chunk = Buffer.from(next.value);
      if (chunk.length) this.buffer = chunk;
    }
  }

  async readExactly(length) {
    const chunks = [];
    let remaining = length;
    while (remaining > 0) {
      await this.#fill();
      if (!this.buffer.length) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_TRUNCATED', 'A Cassandra/Scylla archive ended before its authenticated boundary.', { category: 'integrity' });
      const count = Math.min(remaining, this.buffer.length);
      chunks.push(this.buffer.subarray(0, count));
      this.buffer = this.buffer.subarray(count);
      remaining -= count;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }

  async assertEnd() {
    await this.#fill();
    if (this.buffer.length || !this.ended) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_TRAILING_DATA', 'A Cassandra/Scylla archive contains data after its authenticated terminator.', { category: 'integrity' });
  }
}

function expectedArchiveFiles(nodeManifest) {
  if (!nodeManifest || !Array.isArray(nodeManifest.files) || nodeManifest.fileCount !== nodeManifest.files.length || nodeManifest.manifestDigest !== unsignedDigest(nodeManifest)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_NODE_MANIFEST_INVALID', 'A Cassandra/Scylla node manifest failed authentication.', { category: 'integrity' });
  const expected = new Map();
  for (const file of nodeManifest.files) {
    const archivePath = safeArchivePath(file?.archivePath);
    const sizeBytes = Number(file?.sizeBytes);
    const sha256 = requiredText(file?.sha256, 'Archive member digest', 64).toLowerCase();
    if (expected.has(archivePath) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isFinite(Date.parse(file?.modifiedAt))) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_NODE_MANIFEST_INVALID', 'A Cassandra/Scylla node manifest contains invalid or duplicate file evidence.', { category: 'integrity' });
    expected.set(archivePath, { archivePath, sizeBytes, sha256, modifiedAt: file.modifiedAt });
  }
  return expected;
}

async function consumeNodeArchive(source, nodeManifest, onFile, options = {}) {
  if (typeof onFile !== 'function') throw new TypeError('Archive file consumer is required.');
  const reader = new AsyncByteReader(source);
  const magic = await reader.readExactly(ARCHIVE_MAGIC.length);
  if (!magic.equals(ARCHIVE_MAGIC)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_MAGIC_INVALID', 'A Cassandra/Scylla node archive has an invalid format marker.', { category: 'integrity' });
  const expected = expectedArchiveFiles(nodeManifest);
  const observed = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  while (true) {
    if (options.signal?.aborted) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CANCELED', 'Cassandra/Scylla recovery was canceled.', { category: 'canceled' });
    const headerSize = (await reader.readExactly(4)).readUInt32BE(0);
    if (headerSize === 0) break;
    if (headerSize > MAX_ARCHIVE_HEADER_BYTES) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_HEADER_INVALID', 'A Cassandra/Scylla archive header exceeds the supported limit.', { category: 'capacity' });
    let header;
    try { header = JSON.parse((await reader.readExactly(headerSize)).toString('utf8')); }
    catch { throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_HEADER_INVALID', 'A Cassandra/Scylla archive header is invalid.', { category: 'integrity' }); }
    const headerKeys = Object.keys(header || {}).sort().join(',');
    const archivePath = safeArchivePath(header?.path);
    const expectedFile = expected.get(archivePath);
    if (headerKeys !== 'modifiedAt,path,sha256,sizeBytes,version' || header.version !== 1 || !expectedFile || observed.has(archivePath) || header.sizeBytes !== expectedFile.sizeBytes || header.sha256 !== expectedFile.sha256 || header.modifiedAt !== expectedFile.modifiedAt) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_MEMBER_INVALID', 'A Cassandra/Scylla archive member does not match its authenticated node manifest.', { category: 'integrity' });
    observed.add(archivePath);
    fileCount += 1;
    totalBytes += expectedFile.sizeBytes;
    if (fileCount > MAX_ARCHIVE_FILES || !Number.isSafeInteger(totalBytes)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_LIMIT', 'A Cassandra/Scylla archive exceeds the supported recovery limits.', { category: 'capacity' });
    let remaining = expectedFile.sizeBytes;
    const hash = crypto.createHash('sha256');
    let consumed = false;
    const chunks = (async function* authenticatedChunks() {
      if (consumed) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_CONSUMER_INVALID', 'A recovery archive member was consumed more than once.', { category: 'integrity' });
      consumed = true;
      while (remaining > 0) {
        if (options.signal?.aborted) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CANCELED', 'Cassandra/Scylla recovery was canceled.', { category: 'canceled' });
        const chunk = await reader.readExactly(Math.min(1024 * 1024, remaining));
        remaining -= chunk.length;
        hash.update(chunk);
        await options.onBytes?.(chunk.length, archivePath);
        yield chunk;
      }
    })();
    await onFile(expectedFile, chunks);
    if (!consumed || remaining !== 0 || hash.digest('hex') !== expectedFile.sha256) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_DIGEST_MISMATCH', 'A Cassandra/Scylla archive member was not fully consumed or failed digest verification.', { category: 'integrity' });
  }
  await reader.assertEnd();
  if (observed.size !== expected.size || [...expected.keys()].some((name) => !observed.has(name))) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_INCOMPLETE', 'A Cassandra/Scylla archive is missing an authenticated member.', { category: 'integrity' });
  return { fileCount, totalBytes, paths: [...observed].sort() };
}

function validateClusterManifest(point, manifest) {
  if (!manifest || manifest.version !== 1 || manifest.adapterId !== ADAPTER_ID || manifest.engine !== 'cassandra-scylla' || manifest.publication?.state !== 'sealed' || manifest.manifestDigest !== unsignedDigest(manifest)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_MANIFEST_INVALID', 'The Cassandra/Scylla cluster manifest failed authentication.', { category: 'integrity' });
  if (!['cassandra-scylla-native-full', 'cassandra-scylla-native-incremental', 'cassandra-commit-log'].includes(manifest.kind) || !['cassandra', 'scylladb'].includes(manifest.cluster?.product) || manifest.source?.sourceId !== point.sourceId || manifest.source?.jobId !== point.jobId || !requiredText(manifest.selectionDigest, 'Selection digest', 100) || !manifest.selection || typeof manifest.selection !== 'object' || !Array.isArray(manifest.nodes) || !manifest.nodes.length || !Array.isArray(manifest.keyspaces) || !Array.isArray(manifest.tables)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_MANIFEST_IDENTITY_INVALID', 'The Cassandra/Scylla cluster manifest has incomplete recovery identity.', { category: 'integrity' });
  if (new Set(manifest.nodes.map((node) => node.hostId)).size !== manifest.nodes.length) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_MANIFEST_IDENTITY_INVALID', 'The Cassandra/Scylla cluster manifest contains duplicate node identity.', { category: 'integrity' });
  for (const node of manifest.nodes) expectedArchiveFiles(node);
  if (manifest.kind !== 'cassandra-commit-log' && (manifest.schema?.scope !== 'selected-keyspaces' || manifest.schema?.selectionDigest !== manifest.selectionDigest || !/^[0-9a-f]{64}$/.test(String(manifest.schema?.sha256 || '')) || !Number.isSafeInteger(manifest.schema?.sizeBytes) || manifest.schema.sizeBytes < 1 || manifest.schema.sizeBytes > MAX_SCHEMA_BYTES)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_SCHEMA_EVIDENCE_INVALID', 'The recovery point lacks a selected-keyspace authenticated schema artifact.', { category: 'integrity' });
  return manifest;
}

function sameChainIdentity(root, current) {
  return current.source?.sourceId === root.source?.sourceId
    && current.source?.jobId === root.source?.jobId
    && current.selectionDigest === root.selectionDigest
    && current.cluster?.product === root.cluster?.product
    && current.cluster?.version === root.cluster?.version
    && current.cluster?.partitioner === root.cluster?.partitioner
    && current.cluster?.clusterFingerprint === root.cluster?.clusterFingerprint
    && current.cluster?.topologyFingerprint === root.cluster?.topologyFingerprint
    && current.cluster?.ringFingerprint === root.cluster?.ringFingerprint
    && current.cluster?.schemaVersion === root.cluster?.schemaVersion
    && evidenceDigest(current.nodes.map((node) => node.hostId).sort()) === evidenceDigest(root.nodes.map((node) => node.hostId).sort());
}

function validateRecoveryChain(records) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_CHAIN_LENGTH) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CHAIN_INVALID', 'Choose a bounded Cassandra/Scylla recovery chain.', { category: 'validation' });
  const root = records[0];
  if (root.point.type !== 'full' || root.manifest.kind !== 'cassandra-scylla-native-full' || root.point.parentRecoveryPointId || root.point.chainRootId !== root.point.id) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ANCHOR_INVALID', 'The recovery chain does not start with a self-rooted full Cassandra/Scylla snapshot.', { category: 'integrity' });
  const chainKind = records.length === 1 ? 'full' : records[1].manifest.kind === 'cassandra-scylla-native-incremental' ? 'incremental' : records[1].manifest.kind === 'cassandra-commit-log' ? 'commit-log' : null;
  if (!chainKind) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CHAIN_KIND_INVALID', 'The recovery chain contains an unsupported child type.', { category: 'integrity' });
  let previous = root;
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    const expectedKind = chainKind === 'incremental' ? 'cassandra-scylla-native-incremental' : 'cassandra-commit-log';
    if (record.manifest.kind !== expectedKind || !sameChainIdentity(root.manifest, record.manifest) || record.point.parentRecoveryPointId !== previous.point.id || record.point.chainRootId !== root.point.id || record.manifest.chain?.parentRecoveryPointId !== previous.point.id || record.manifest.chain?.chainRootRecoveryPointId !== root.point.id) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CHAIN_MISMATCH', 'The Cassandra/Scylla recovery chain has a gap or mixes incompatible cluster evidence.', { category: 'integrity' });
    if (chainKind === 'incremental') compareIncrementalCursors(previous.manifest.incremental?.cursor, record.manifest.incremental?.cursor);
    else compareCommitLogCursors(previous.manifest.commitLog?.cursor, record.manifest.commitLog?.cursor);
    previous = record;
  }
  return {
    kind: chainKind,
    product: root.manifest.cluster.product,
    root,
    terminal: records.at(-1),
    records,
    recoveryPointIds: records.map((record) => record.point.id),
    nodeHostIds: root.manifest.nodes.map((node) => node.hostId).sort(),
    sourceBytes: records.reduce((total, record) => total + record.manifest.nodes.reduce((sum, node) => sum + Number(node.sourceBytes || 0), 0), 0)
  };
}

function normalizePreviewRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_INPUT_INVALID', 'Cassandra/Scylla recovery input must be an object.', { category: 'validation' });
  const mode = String(input.mode || 'offline-bundle');
  if (!['offline-bundle', 'alternate-cluster'].includes(mode)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_MODE_INVALID', 'Choose an offline bundle or alternate-cluster recovery target.', { category: 'validation' });
  const targetNodes = mode === 'alternate-cluster'
    ? (Array.isArray(input.targetNodes) ? input.targetNodes : []).map((node) => ({ sourceHostId: node.sourceHostId ? requiredText(node.sourceHostId, 'Source host ID', 100) : null, targetHostId: requiredText(node.targetHostId, 'Target host ID', 100), connectionId: requiredText(node.connectionId, 'Target connection ID', 200) }))
    : [];
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    mode,
    destinationRoot: mode === 'offline-bundle' ? safeLocalRoot(input.destinationRoot) : null,
    targetSeedConnectionId: mode === 'alternate-cluster' ? requiredText(input.targetSeedConnectionId, 'Target seed connection ID', 200) : null,
    targetNodes,
    conflictPolicy: mode === 'alternate-cluster' ? String(input.conflictPolicy || 'fail') : 'not-applicable',
    targetUtc: input.targetUtc ? requiredText(input.targetUtc, 'Cassandra recovery target', 100) : null,
    commitLogNodeMappings: Array.isArray(input.commitLogNodeMappings) ? structuredClone(input.commitLogNodeMappings) : []
  };
}

function assertConfirmation(request, input, product) {
  const expected = request.mode === 'offline-bundle' ? OFFLINE_CONFIRMATION : ALTERNATE_CONFIRMATIONS[product];
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== expected) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CONFIRMATION_REQUIRED', `Enter ${expected} to continue.`, { category: 'conflict' });
  return expected;
}

function repositoryFile(opened, manifest, artifact) {
  const file = (opened.manifest.files || []).find((entry) => entry.type === 'file' && entry.path === artifact.path && entry.metadata?.componentId === artifact.componentId && entry.metadata?.artifactKind === artifact.kind && entry.metadata?.database?.adapterId === ADAPTER_ID);
  if (!file || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !file.contentDigest?.digest) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_REPOSITORY_ARTIFACT_INVALID', 'An authenticated repository snapshot is missing a Cassandra/Scylla artifact.', { category: 'integrity' });
  if (artifact.componentId === 'cluster-manifest' && artifact.path !== MANIFEST_PATH) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_REPOSITORY_ARTIFACT_INVALID', 'The Cassandra/Scylla cluster manifest path is invalid.', { category: 'integrity' });
  if (artifact.componentId === 'cluster-manifest' && file.metadata.database.manifestDigest !== manifest.manifestDigest) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_REPOSITORY_ARTIFACT_INVALID', 'The repository cluster-manifest catalog does not match the authenticated Cassandra/Scylla manifest.', { category: 'integrity' });
  if (artifact.componentId === 'schema' && file.metadata.database.component?.manifestDigest !== manifest.schema?.sha256) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_REPOSITORY_ARTIFACT_INVALID', 'The repository schema catalog does not match the authenticated Cassandra/Scylla manifest.', { category: 'integrity' });
  const node = manifest.nodes.find((item) => item.hostId === artifact.componentId);
  if (node && file.metadata.database.component?.manifestDigest !== node.manifestDigest) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_REPOSITORY_ARTIFACT_INVALID', 'A repository node-archive catalog entry does not match its authenticated node manifest.', { category: 'integrity' });
  return file;
}

async function readRepositoryFile(opened, file, maximumBytes, label) {
  const chunks = [];
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  for await (const raw of opened.engine.streamFile({}, { repositoryId: opened.copy.repositoryId, manifest: opened.manifest, masterKey: opened.masterKey, path: file.path })) {
    const chunk = Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARTIFACT_LIMIT', `${label} exceeds the supported recovery limit.`, { category: 'capacity' });
    hash.update(chunk);
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks, bytes);
  const digest = hash.digest('hex');
  const repositoryDigest = String(file.contentDigest.digest).replace(/^sha256:/, '');
  if (bytes !== file.sizeBytes || digest !== repositoryDigest) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_REPOSITORY_DIGEST_MISMATCH', `${label} failed repository digest verification.`, { category: 'integrity' });
  return content;
}

async function writeLocalStream(target, chunks, mode = 0o600) {
  await fsPromises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await pipeline(Readable.from(chunks), fs.createWriteStream(target, { flags: 'wx', mode }));
}

function publicPlan(plan) {
  return {
    version: plan.version,
    operation: plan.operation,
    mode: plan.mode,
    product: plan.product,
    sourceVersion: plan.sourceVersion,
    recoveryPointIds: [...plan.recoveryPointIds],
    chainKind: plan.chainKind,
    destinationRoot: plan.destinationRoot,
    target: plan.target ? structuredClone(plan.target) : null,
    compatibility: plan.compatibility ? structuredClone(plan.compatibility) : null,
    conflicts: [...plan.conflicts],
    blockers: structuredClone(plan.blockers || []),
    executable: plan.executable === true,
    keyspaces: structuredClone(plan.keyspaces),
    tables: structuredClone(plan.tables),
    rebuildObjects: structuredClone(plan.rebuildObjects),
    sourceBytes: plan.sourceBytes,
    targetUtc: plan.targetUtc,
    serviceMutationAllowed: plan.serviceMutationAllowed,
    materializationAllowed: plan.materializationAllowed,
    cancellationRollbackSupported: false,
    planDigest: plan.planDigest
  };
}

function assertExecutablePlan(plan) {
  if (plan.executable === true) return true;
  const blocker = plan.blockers?.[0] || { code: 'CASSANDRA_RESTORE_PLAN_BLOCKED', category: 'conflict', safeMessage: 'The Cassandra/Scylla recovery plan is blocked.' };
  throw new CassandraScyllaRestoreError(blocker.code, blocker.safeMessage, { category: blocker.category, details: blocker.details || {} });
}

class CassandraScyllaRestoreService {
  constructor({ controlDatabase, secretStore, snapshotBrowser, adapter, deviceId, runtimeFactory = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !snapshotBrowser || !adapter) throw new TypeError('Cassandra/Scylla restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.snapshotBrowser = snapshotBrowser;
    this.adapter = adapter;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.runtimeFactory = runtimeFactory || new CassandraScyllaNodeRuntimeFactory({ controlDatabase, secretStore, deviceId });
    this.clock = clock;
    this.active = new Map();
  }

  async #loadRecord(workspaceId, point) {
    if (!point || point.verification?.state !== 'succeeded' || point.retention?.deletionEligible === true || !(point.repositoryCopies || []).length || point.repositoryCopies.some((copy) => copy.state !== 'available')) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_POINT_UNAVAILABLE', 'Every recovery point in the chain must be retained, verified, and available in every cataloged repository.', { category: 'repository', retryable: true });
    const opened = await this.snapshotBrowser.openAuthenticatedSnapshot(workspaceId, point.id);
    const manifestFile = (opened.manifest.files || []).find((file) => file.type === 'file' && file.path === MANIFEST_PATH && file.metadata?.componentId === 'cluster-manifest' && file.metadata?.artifactKind === 'metadata' && file.metadata?.database?.adapterId === ADAPTER_ID);
    if (!manifestFile || manifestFile.sizeBytes < 1 || manifestFile.sizeBytes > MAX_MANIFEST_BYTES) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_MANIFEST_MISSING', 'The authenticated Cassandra/Scylla cluster manifest is missing.', { category: 'integrity' });
    const bytes = await readRepositoryFile(opened, manifestFile, MAX_MANIFEST_BYTES, 'Cassandra/Scylla cluster manifest');
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); }
    catch { throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_MANIFEST_INVALID', 'The authenticated Cassandra/Scylla cluster manifest is not valid JSON.', { category: 'integrity' }); }
    validateClusterManifest(point, manifest);
    const artifacts = new Map();
    for (const artifact of manifest.artifacts || []) {
      const key = `${artifact.componentId}\0${artifact.kind}\0${artifact.path}`;
      if (artifacts.has(key)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_REPOSITORY_ARTIFACT_INVALID', 'The Cassandra/Scylla manifest contains duplicate artifacts.', { category: 'integrity' });
      artifacts.set(key, repositoryFile(opened, manifest, artifact));
    }
    if (![...artifacts.keys()].some((key) => key.startsWith('cluster-manifest\0metadata\0'))) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_MANIFEST_MISSING', 'The Cassandra/Scylla manifest does not authenticate itself as an artifact.', { category: 'integrity' });
    if (manifest.schema && ![...artifacts.keys()].some((key) => key.startsWith('schema\0schema\0'))) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARTIFACT_MISSING', 'The Cassandra/Scylla manifest does not declare its authenticated schema artifact.', { category: 'integrity' });
    const nodeArtifactKind = manifest.kind === 'cassandra-commit-log' ? 'transaction-log' : 'physical-backup';
    if (manifest.nodes.some((node) => node.fileCount > 0 && ![...artifacts.keys()].some((key) => key.startsWith(`${node.hostId}\0${nodeArtifactKind}\0`)))) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARTIFACT_MISSING', 'The Cassandra/Scylla manifest does not declare every non-empty node archive.', { category: 'integrity' });
    return { point, opened, manifest, artifacts };
  }

  async #loadChain(workspaceId, recoveryPointId) {
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAX_CHAIN_LENGTH });
    const byId = new Map(points.map((point) => [point.id, point]));
    const reversed = [];
    const visited = new Set();
    let point = byId.get(recoveryPointId);
    while (point) {
      if (visited.has(point.id)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CHAIN_CYCLE', 'The Cassandra/Scylla recovery chain contains a cycle.', { category: 'integrity' });
      visited.add(point.id);
      reversed.push(point);
      if (!point.parentRecoveryPointId) break;
      point = byId.get(point.parentRecoveryPointId);
      if (!point) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CHAIN_GAP', 'A required Cassandra/Scylla recovery point is missing.', { category: 'integrity' });
    }
    if (!reversed.length) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_POINT_NOT_FOUND', 'The Cassandra/Scylla RecoveryPoint was not found.', { category: 'not-found' });
    const records = [];
    for (const candidate of reversed.reverse()) records.push(await this.#loadRecord(workspaceId, candidate));
    const chain = validateRecoveryChain(records);
    const source = await this.controlDatabase.repository('source').get(workspaceId, chain.root.point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_SOURCE_INVALID', 'The recovery chain is not owned by a Cassandra/Scylla Source.', { category: 'integrity' });
    return { ...chain, source };
  }

  async #targetContext(workspaceId, chain, request) {
    if (chain.kind === 'commit-log') throw new CassandraScyllaRestoreError('CASSANDRA_PITR_ALTERNATE_UNAVAILABLE', 'Cassandra commit-log replay is available only in an offline recovery bundle; alternate-cluster PITR requires a later isolated replay-and-stream workflow.', { category: 'compatibility' });
    if (request.conflictPolicy !== 'fail') throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_CONFLICT_POLICY_UNSUPPORTED', 'Alternate Cassandra/Scylla recovery currently requires the fail-on-conflict policy.', { category: 'conflict' });
    const seed = await this.controlDatabase.repository('connection').get(workspaceId, request.targetSeedConnectionId);
    if (!seed || seed.adapterId !== ADAPTER_ID || seed.lastTest?.status !== 'success' || !seed.trust?.fingerprint || !seed.clusterInventory || !(seed.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_CONNECTION_INVALID', 'Choose a tested Cassandra/Scylla target seed connection on this device.', { category: 'validation' });
    const inventory = seed.clusterInventory;
    if (seed.trust.fingerprint !== inventory.deploymentFingerprint || seed.trust.topologyFingerprint !== inventory.topologyFingerprint) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_CONNECTION_INVALID', 'The target seed connection does not have trusted current cluster identity evidence.', { category: 'integrity' });
    if (inventory.product !== chain.product || inventory.clusterFingerprint === chain.root.manifest.cluster.clusterFingerprint || inventory.partitioner !== chain.root.manifest.cluster.partitioner) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_INCOMPATIBLE', 'The alternate target must be a different same-product cluster using the protected partitioner.', { category: 'compatibility' });
    const compatibility = assertCompatibleVersions(chain.product, chain.root.manifest.cluster.version, inventory.productVersion || seed.lastTest?.endpointIdentity?.version);
    const requiredNodes = (inventory.nodes || []).filter((node) => Number(node.tokenCount) > 0).sort((left, right) => left.hostId.localeCompare(right.hostId, 'en-US'));
    if (!requiredNodes.length || (inventory.nodes || []).some((node) => node.status !== 'up' || node.state !== 'normal')) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_HEALTH_INVALID', 'The alternate target inventory must prove every node is up and normal.', { category: 'integrity' });
    if (request.targetNodes.length !== requiredNodes.length || new Set(request.targetNodes.map((node) => node.targetHostId)).size !== request.targetNodes.length || new Set(request.targetNodes.map((node) => node.connectionId)).size !== request.targetNodes.length || requiredNodes.some((node) => !request.targetNodes.some((item) => item.targetHostId === node.hostId)) || !request.targetNodes.some((node) => node.connectionId === seed.id && node.targetHostId === inventory.localHostId)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_NODE_MAPPING_INVALID', 'Alternate recovery requires one distinct tested connection for every target token-owning node, including the selected seed.', { category: 'validation' });
    const nodes = [];
    for (const target of request.targetNodes) {
      const connection = await this.controlDatabase.repository('connection').get(workspaceId, target.connectionId);
      const nodeInventory = connection?.clusterInventory;
      if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`) || !nodeInventory || connection.trust.fingerprint !== nodeInventory.deploymentFingerprint || connection.trust.topologyFingerprint !== nodeInventory.topologyFingerprint || nodeInventory.localHostId !== target.targetHostId || nodeInventory.product !== inventory.product || nodeInventory.clusterFingerprint !== inventory.clusterFingerprint || nodeInventory.topologyFingerprint !== inventory.topologyFingerprint || nodeInventory.coverage?.ringFingerprint !== inventory.coverage?.ringFingerprint || nodeInventory.schemaVersion !== inventory.schemaVersion || (nodeInventory.nodes || []).some((node) => node.status !== 'up' || node.state !== 'normal')) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_NODE_INVALID', 'A target node connection does not match the trusted healthy alternate cluster.', { category: 'integrity' });
      nodes.push({ ...target, connection, inventory: nodeInventory });
    }
    const protectedKeyspaces = new Set(chain.root.manifest.keyspaces.map((item) => item.name));
    const protectedTables = new Set(chain.root.manifest.tables.map((item) => `${item.database}\0${item.name}`));
    const conflicts = [
      ...(inventory.keyspaces || []).filter((item) => protectedKeyspaces.has(item.name)).map((item) => ({ kind: 'keyspace', name: item.name })),
      ...(inventory.tables || []).filter((item) => protectedTables.has(`${item.keyspace}\0${item.name}`)).map((item) => ({ kind: 'table', name: `${item.keyspace}.${item.name}` }))
    ];
    const blockers = [];
    if (conflicts.length) blockers.push({ code: 'CASSANDRA_RESTORE_TARGET_CONFLICT', category: 'conflict', safeMessage: 'One or more protected keyspaces or tables already exist on the alternate target.', details: { conflicts: conflicts.slice(0, 100) } });
    if ((seed.secretRefIds || []).length) blockers.push({ code: 'CASSANDRA_RESTORE_LOADER_SECRET_UNSUPPORTED', category: 'compatibility', safeMessage: 'Authenticated alternate targets are not yet admitted because sstableloader exposes credentials through process arguments. Use an isolated target with network controls or create an offline bundle.' });
    return { seed, inventory, nodes: nodes.sort((left, right) => left.targetHostId.localeCompare(right.targetHostId, 'en-US')), compatibility, conflicts, blockers };
  }

  async #prepare(workspaceId, input) {
    const request = normalizePreviewRequest(input);
    const chain = await this.#loadChain(workspaceId, request.recoveryPointId);
    let pitrPlan = null;
    if (chain.kind === 'commit-log') {
      if (chain.product !== 'cassandra' || !request.targetUtc) throw new CassandraScyllaRestoreError('CASSANDRA_PITR_TARGET_REQUIRED', 'Cassandra commit-log recovery requires an exact UTC target.', { category: 'validation' });
      pitrPlan = planCassandraCommitLogRestore({ chain: chain.records.map((record) => ({ recoveryPointId: record.point.id, manifest: record.manifest })), targetUtc: request.targetUtc, nodeMappings: request.commitLogNodeMappings });
    } else if (request.targetUtc) throw new CassandraScyllaRestoreError('CASSANDRA_PITR_CHAIN_REQUIRED', 'A UTC target can be used only with a Cassandra commit-log recovery chain.', { category: 'validation' });
    if (request.mode === 'offline-bundle') {
      try { await fsPromises.lstat(request.destinationRoot); throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_DESTINATION_EXISTS', 'The offline bundle destination must not already exist.', { category: 'conflict' }); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    const targetContext = request.mode === 'alternate-cluster' ? await this.#targetContext(workspaceId, chain, request) : null;
    const plan = {
      version: 1,
      operation: request.mode === 'offline-bundle' ? 'cassandra-scylla-offline-bundle' : 'cassandra-scylla-alternate-cluster',
      mode: request.mode,
      product: chain.product,
      sourceVersion: chain.root.manifest.cluster.version || null,
      sourcePartitioner: chain.root.manifest.cluster.partitioner || null,
      sourceClusterFingerprint: chain.root.manifest.cluster.clusterFingerprint,
      recoveryPointIds: chain.recoveryPointIds,
      chainKind: chain.kind,
      destinationRoot: request.destinationRoot,
      target: targetContext ? { clusterName: targetContext.inventory.clusterName, clusterFingerprint: targetContext.inventory.clusterFingerprint, productVersion: targetContext.inventory.productVersion, partitioner: targetContext.inventory.partitioner, seedConnectionId: targetContext.seed.id, nodes: targetContext.nodes.map(({ targetHostId, connection }) => ({ hostId: targetHostId, connectionId: connection.id })) } : null,
      compatibility: targetContext?.compatibility || null,
      conflicts: targetContext?.conflicts || [],
      blockers: targetContext?.blockers || [],
      conflictPolicy: request.conflictPolicy,
      keyspaces: structuredClone(chain.root.manifest.keyspaces),
      tables: structuredClone(chain.root.manifest.tables),
      rebuildObjects: structuredClone(chain.root.manifest.rebuildObjects || []),
      sourceBytes: chain.sourceBytes,
      targetUtc: pitrPlan?.targetUtc || null,
      pitrPlan,
      serviceMutationAllowed: request.mode === 'alternate-cluster',
      materializationAllowed: true
    };
    plan.executable = plan.blockers.length === 0;
    plan.planDigest = evidenceDigest(plan);
    return { request, chain, targetContext, plan };
  }

  async preview(workspaceId, input = {}) {
    return publicPlan((await this.#prepare(requiredText(workspaceId, 'Workspace ID', 200), input)).plan);
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const prepared = await this.#prepare(tenant, input);
    assertExecutablePlan(prepared.plan);
    assertConfirmation(prepared.request, input, prepared.chain.product);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: prepared.plan.recoveryPointIds,
      targetConnectionId: prepared.plan.target?.seedConnectionId || null,
      target: {
        engine: 'cassandra-scylla', operation: prepared.plan.operation, mode: prepared.plan.mode,
        product: prepared.plan.product, sourceId: prepared.chain.source.id,
        destinationRoot: prepared.plan.destinationRoot, alternate: prepared.plan.target,
        planDigest: prepared.plan.planDigest, ownership: null
      },
      mode: prepared.plan.mode,
      conflictPolicy: prepared.plan.conflictPolicy,
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', itemsTotal: prepared.plan.recoveryPointIds.length, itemsCompleted: 0, bytesTotal: prepared.plan.sourceBytes, bytesWritten: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null,
      result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, input, prepared.plan.planDigest, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { controller, operation });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'cassandra-scylla') throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_RUN_NOT_FOUND', 'The Cassandra/Scylla RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'cassandra-scylla');
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'cassandra-scylla') throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_RUN_NOT_FOUND', 'The Cassandra/Scylla RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_NOT_ACTIVE', 'The Cassandra/Scylla restore is not active in this process.', { category: 'conflict' });
    await this.#project(tenant, id, { state: 'canceling', progress: { ...(record.progress || {}), phase: 'canceling', updatedAt: this.clock() } }, actorId);
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.list(tenant, { limit: 200 });
    const projected = [];
    for (const record of records.filter((item) => ACTIVE_STATES.has(item.state) && !this.active.has(item.id))) {
      projected.push(await this.#project(tenant, record.id, {
        state: 'interrupted',
        progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() },
        result: { state: 'interrupted', cleanupRequired: true, targetMutationMayHaveOccurred: record.target?.mode === 'alternate-cluster', error: { code: 'CASSANDRA_RESTORE_PROCESS_INTERRUPTED', category: 'consistency', retryable: false, safeMessage: 'Recovery monitoring was interrupted. Preserve and inspect the owned bundle or alternate target before retrying.' }, completedAt: null }
      }, actorId));
    }
    return projected;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  #repositoryStream(record, file) {
    return record.opened.engine.streamFile({}, { repositoryId: record.opened.copy.repositoryId, manifest: record.opened.manifest, masterKey: record.opened.masterKey, path: file.path });
  }

  #artifact(record, componentId, kind) {
    const artifact = (record.manifest.artifacts || []).find((item) => item.componentId === componentId && item.kind === kind);
    if (!artifact) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARTIFACT_MISSING', `The authenticated ${kind} artifact for ${componentId} is missing.`, { category: 'integrity' });
    return { artifact, file: record.artifacts.get(`${artifact.componentId}\0${artifact.kind}\0${artifact.path}`) };
  }

  async #schemaBytes(chain) {
    const records = chain.records.filter((record) => record.manifest.schema);
    if (!records.length) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_SCHEMA_EVIDENCE_INVALID', 'The recovery chain has no authenticated schema.', { category: 'integrity' });
    const digests = new Set(records.map((record) => record.manifest.schema.sha256));
    if (digests.size !== 1) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_SCHEMA_CHANGED', 'The schema artifact changed inside one recovery chain.', { category: 'integrity' });
    const selected = records.at(-1);
    const { file } = this.#artifact(selected, 'schema', 'schema');
    const bytes = await readRepositoryFile(selected.opened, file, MAX_SCHEMA_BYTES, 'Cassandra/Scylla schema');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== selected.manifest.schema.sha256) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_SCHEMA_DIGEST_MISMATCH', 'The schema artifact does not match the authenticated cluster manifest.', { category: 'integrity' });
    return bytes;
  }

  async #createOfflineOwnership(root, restoreRunId, planDigest) {
    await fsPromises.mkdir(root, { recursive: false, mode: 0o700 });
    const owner = { version: 1, kind: 'cassandra-scylla-offline-bundle', restoreRunId, planDigest };
    await fsPromises.writeFile(path.join(root, '.deployerx-restore-owner'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    return owner;
  }

  async #cleanupOffline(root, owner) {
    try {
      const text = await fsPromises.readFile(path.join(root, '.deployerx-restore-owner'), 'utf8');
      if (text !== `${JSON.stringify(owner)}\n`) return false;
      await fsPromises.rm(root, { recursive: true, force: false });
      return true;
    } catch { return false; }
  }

  async #materializeOffline(prepared, restoreRunId, signal, progress) {
    const root = prepared.plan.destinationRoot;
    const owner = await this.#createOfflineOwnership(root, restoreRunId, prepared.plan.planDigest);
    const inventoryFiles = [];
    try {
      const schema = await this.#schemaBytes(prepared.chain);
      const schemaPath = path.join(root, 'schema', 'schema.cql');
      await writeLocalStream(schemaPath, [schema]);
      inventoryFiles.push({ path: 'schema/schema.cql', sizeBytes: schema.length, sha256: crypto.createHash('sha256').update(schema).digest('hex') });
      for (let index = 0; index < prepared.chain.records.length; index += 1) {
        const record = prepared.chain.records[index];
        const manifestName = `${String(index).padStart(4, '0')}-${record.point.id}.json`;
        const manifestBytes = Buffer.from(JSON.stringify(record.manifest), 'utf8');
        await writeLocalStream(path.join(root, 'manifests', manifestName), [manifestBytes]);
        inventoryFiles.push({ path: `manifests/${manifestName}`, sizeBytes: manifestBytes.length, sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') });
        for (const node of record.manifest.nodes) {
          if (!node.fileCount) continue;
          const kind = record.manifest.kind === 'cassandra-commit-log' ? 'transaction-log' : 'physical-backup';
          const { file } = this.#artifact(record, node.hostId, kind);
          await consumeNodeArchive(this.#repositoryStream(record, file), node, async (entry, chunks) => {
            const relative = `payload/${entry.archivePath}`;
            const target = containedLocalPath(root, relative);
            await writeLocalStream(target, chunks);
            inventoryFiles.push({ path: relative, sizeBytes: entry.sizeBytes, sha256: entry.sha256 });
          }, { signal, onBytes: async (bytes) => { progress.bytesWritten += bytes; } });
        }
        progress.itemsCompleted += 1;
      }
      if (prepared.plan.pitrPlan) {
        for (const config of prepared.plan.pitrPlan.configurations) {
          const relative = `commitlog-config/${config.sourceHostId}/commitlog-archiving.properties`;
          await writeLocalStream(containedLocalPath(root, relative), [Buffer.from(config.contents, 'utf8')]);
          inventoryFiles.push({ path: relative, sizeBytes: Buffer.byteLength(config.contents), sha256: config.digest.replace(/^sha256:/, '') });
        }
      }
      inventoryFiles.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
      const inventory = {
        version: 1, kind: 'cassandra-scylla-offline-bundle', restoreRunId, planDigest: prepared.plan.planDigest,
        product: prepared.plan.product, sourceVersion: prepared.plan.sourceVersion, recoveryPointIds: prepared.plan.recoveryPointIds,
        chainKind: prepared.plan.chainKind, targetUtc: prepared.plan.targetUtc, keyspaces: prepared.plan.keyspaces,
        tables: prepared.plan.tables, rebuildObjects: prepared.plan.rebuildObjects, files: inventoryFiles,
        serviceMutationAllowed: false, createdAt: this.clock()
      };
      inventory.inventoryDigest = evidenceDigest(inventory);
      const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
      await writeLocalStream(path.join(root, 'bundle-inventory.json'), [inventoryBytes]);
      return { owner, inventory, fileCount: inventoryFiles.length + 1, bytesRestored: progress.bytesWritten + schema.length + inventoryBytes.length };
    } catch (error) {
      error.offlineCleanupProven = await this.#cleanupOffline(root, owner);
      throw error;
    }
  }

  async #runtimeAuthentication(runtime, connection, workspaceId) {
    const config = normalizeConfig({ ...connection.endpoint, cqlPasswordSecretRefId: connection.secretRefIds?.[0] || null });
    if (!config.cqlPasswordSecretRefId) return { config, cqlshrcPath: null, cleanup: async () => {} };
    const password = await this.secretStore.resolve({ workspaceId, id: config.cqlPasswordSecretRefId });
    const target = `/tmp/deployerx-cassandra-restore-auth-${crypto.randomBytes(16).toString('hex')}.rc`;
    await runtime.writeFile(target, cqlshrcContents(config.cqlUsername, password), { mode: 0o600 });
    return { config, cqlshrcPath: target, cleanup: () => runtime.run('rm', ['-f', '--', target], { ignoreAbort: true, stdoutLimitBytes: 1024 }) };
  }

  async #discoverTarget(runtime, authentication, signal) {
    const pages = [];
    for await (const page of this.adapter.discover({ signal, cqlshrcPath: authentication.cqlshrcPath, runNativeCommand: ({ executable, args, ...options }) => runtime.run(executable, args, options) }, { kind: 'all', connection: authentication.config })) pages.push(page);
    if (pages.length !== 1) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_DISCOVERY_INVALID', 'The alternate target returned ambiguous discovery evidence.', { category: 'integrity' });
    return pages[0];
  }

  #assertLiveTarget(page, target, mappedNode, plan) {
    const expectedHosts = new Set(target.nodes.map((node) => node.targetHostId));
    const topology = Array.isArray(page.topology) ? page.topology : [];
    const discoveredVersion = page.identity?.version?.text || page.identity?.version;
    const identityMatches = page.product === target.inventory.product
      && discoveredVersion === mappedNode.inventory.productVersion
      && page.identity?.partitioner === target.inventory.partitioner
      && page.clusterName === target.inventory.clusterName
      && page.deploymentFingerprint === mappedNode.inventory.deploymentFingerprint
      && page.clusterFingerprint === target.inventory.clusterFingerprint
      && page.topologyFingerprint === target.inventory.topologyFingerprint
      && page.coverage?.ringFingerprint === target.inventory.coverage?.ringFingerprint
      && page.identity?.localHostId === mappedNode.targetHostId;
    const healthyTopology = topology.length >= expectedHosts.size
      && [...expectedHosts].every((hostId) => topology.some((node) => node.hostId === hostId))
      && topology.every((node) => node.status === 'up' && node.state === 'normal');
    if (!identityMatches || !healthyTopology) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_CHANGED', 'A mapped target node no longer proves the confirmed cluster, topology, ring, local host identity, and healthy membership.', { category: 'conflict' });
    const protectedKeyspaces = new Set(plan.keyspaces.map((item) => item.name));
    const protectedTables = new Set(plan.tables.map((item) => `${item.database}\0${item.name}`));
    const conflicts = [
      ...(page.keyspaces || []).filter((item) => protectedKeyspaces.has(item.name)).map((item) => ({ kind: 'keyspace', name: item.name })),
      ...(page.tables || []).filter((item) => protectedTables.has(`${item.keyspace}\0${item.name}`)).map((item) => ({ kind: 'table', name: `${item.keyspace}.${item.name}` }))
    ];
    if (conflicts.length) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_TARGET_CONFLICT', 'A protected keyspace or table appeared on the alternate target after confirmation.', { category: 'conflict', details: { conflicts: conflicts.slice(0, 100) } });
  }

  async #cleanupRemoteStage(runtime, stageRoot, ownerText) {
    if (!SAFE_STAGE_PATTERN.test(stageRoot)) return false;
    try {
      const marker = `${stageRoot}/.deployerx-restore-owner`;
      const observed = await runtime.run('cat', ['--', marker], { ignoreAbort: true, stdoutLimitBytes: 4096 });
      if (observed.stdout !== ownerText) return false;
      await runtime.run('rm', ['-rf', '--', stageRoot], { ignoreAbort: true, stdoutLimitBytes: 1024 });
      await runtime.run('test', ['!', '-e', stageRoot], { ignoreAbort: true, stdoutLimitBytes: 1024 });
      return true;
    } catch { return false; }
  }

  async #restoreAlternate(workspaceId, prepared, restoreRunId, signal, progress) {
    const target = prepared.targetContext;
    const seedRuntime = await this.runtimeFactory.open(workspaceId, target.seed, signal);
    const stageRoot = `/tmp/deployerx-cassandra-restore-${crypto.createHash('sha256').update(`${workspaceId}\0${restoreRunId}`).digest('hex').slice(0, 32)}`;
    const ownerText = `${JSON.stringify({ version: 1, restoreRunId, planDigest: prepared.plan.planDigest })}\n`;
    let authentication = null;
    let stageCreated = false;
    let schemaApplied = false;
    const loadedDirectories = new Set();
    try {
      authentication = await this.#runtimeAuthentication(seedRuntime, target.seed, workspaceId);
      for (const node of target.nodes) {
        const runtime = node.connection.id === target.seed.id ? seedRuntime : await this.runtimeFactory.open(workspaceId, node.connection, signal);
        let nodeAuthentication = null;
        try {
          nodeAuthentication = node.connection.id === target.seed.id ? authentication : await this.#runtimeAuthentication(runtime, node.connection, workspaceId);
          this.#assertLiveTarget(await this.#discoverTarget(runtime, nodeAuthentication, signal), target, node, prepared.plan);
        } finally {
          if (node.connection.id !== target.seed.id) await nodeAuthentication?.cleanup().catch(() => {});
          if (runtime !== seedRuntime) runtime.close();
        }
      }
      await seedRuntime.run('test', ['!', '-e', stageRoot], { stdoutLimitBytes: 1024 });
      await seedRuntime.run('mkdir', ['-m', '0700', '--', stageRoot], { stdoutLimitBytes: 1024 });
      stageCreated = true;
      await seedRuntime.writeFile(`${stageRoot}/.deployerx-restore-owner`, ownerText, { mode: 0o600 });
      const schema = await this.#schemaBytes(prepared.chain);
      const schemaPath = `${stageRoot}/schema.cql`;
      await seedRuntime.writeFile(schemaPath, schema, { mode: 0o600 });
      for (const record of prepared.chain.records) {
        for (const node of record.manifest.nodes) {
          if (!node.fileCount) continue;
          const { file } = this.#artifact(record, node.hostId, 'physical-backup');
          await consumeNodeArchive(this.#repositoryStream(record, file), node, async (entry, chunks) => {
            const relative = safeArchivePath(entry.archivePath);
            const targetPath = path.posix.join(stageRoot, 'payload', relative);
            if (!targetPath.startsWith(`${stageRoot}/payload/`)) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_ARCHIVE_PATH_UNSAFE', 'A staged SSTable path escapes its owned root.', { category: 'integrity' });
            const directory = path.posix.dirname(targetPath);
            await seedRuntime.run('mkdir', ['-p', '--', directory], { stdoutLimitBytes: 1024 });
            await seedRuntime.writeFile(targetPath, chunks, { mode: 0o600 });
            loadedDirectories.add(directory);
          }, { signal, onBytes: async (bytes) => { progress.bytesWritten += bytes; } });
        }
        progress.itemsCompleted += 1;
      }
      const cqlArgs = [authentication.config.contactHost, String(authentication.config.nativePort), ...(authentication.cqlshrcPath ? ['--cqlshrc', authentication.cqlshrcPath] : []), '--file', schemaPath];
      await seedRuntime.run(authentication.config.cqlshPath, cqlArgs, { stdoutLimitBytes: 4 * 1024 * 1024 });
      schemaApplied = true;
      for (const directory of [...loadedDirectories].sort()) await seedRuntime.run(authentication.config.sstableloaderPath, ['-d', authentication.config.contactHost, '-p', String(authentication.config.nativePort), directory], { stdoutLimitBytes: 4 * 1024 * 1024, timeoutMs: 24 * 60 * 60 * 1000 });
      for (const node of target.nodes) {
        const runtime = node.connection.id === target.seed.id ? seedRuntime : await this.runtimeFactory.open(workspaceId, node.connection, signal);
        try {
          const nodeAuth = node.connection.id === target.seed.id ? authentication : await this.#runtimeAuthentication(runtime, node.connection, workspaceId);
          try {
            for (const keyspace of prepared.plan.keyspaces) await runtime.run(nodeAuth.config.nodetoolPath, ['repair', '--full', keyspace.name], { stdoutLimitBytes: 4 * 1024 * 1024, timeoutMs: 24 * 60 * 60 * 1000 });
            const after = await this.#discoverTarget(runtime, nodeAuth, signal);
            if (after.clusterFingerprint !== target.inventory.clusterFingerprint || (after.topology || []).some((item) => item.status !== 'up' || item.state !== 'normal') || prepared.plan.tables.some((table) => !(after.tables || []).some((item) => item.keyspace === table.database && item.name === table.name))) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_VALIDATION_FAILED', 'The alternate cluster did not prove healthy nodes and every restored base table after repair.', { category: 'integrity' });
          } finally { if (node.connection.id !== target.seed.id) await nodeAuth.cleanup().catch(() => {}); }
        } finally { if (runtime !== seedRuntime) runtime.close(); }
      }
      const cleanupProven = await this.#cleanupRemoteStage(seedRuntime, stageRoot, ownerText);
      if (!cleanupProven) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_STAGE_CLEANUP_UNPROVEN', 'The owned alternate recovery staging directory could not be removed safely.', { category: 'consistency' });
      stageCreated = false;
      return { schemaApplied, loadedDirectoryCount: loadedDirectories.size, repairedNodeCount: target.nodes.length, stageCleanupProven: true, targetMutationOccurred: true };
    } catch (error) {
      if (stageCreated) error.stageCleanupProven = await this.#cleanupRemoteStage(seedRuntime, stageRoot, ownerText);
      error.targetMutationOccurred = schemaApplied;
      throw error;
    } finally {
      await authentication?.cleanup().catch(() => {});
      seedRuntime.close();
    }
  }

  async #execute(workspaceId, actorId, restoreRunId, input, expectedPlanDigest, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', startedAt: progress.startedAt, progress }, actorId);
      const prepared = await this.#prepare(workspaceId, input);
      assertExecutablePlan(prepared.plan);
      assertConfirmation(prepared.request, input, prepared.chain.product);
      if (prepared.plan.planDigest !== expectedPlanDigest) throw new CassandraScyllaRestoreError('CASSANDRA_RESTORE_PLAN_CHANGED', 'Recovery evidence or target state changed after confirmation.', { category: 'conflict' });
      progress = { ...progress, phase: 'running', itemsTotal: prepared.plan.recoveryPointIds.length, bytesTotal: prepared.plan.sourceBytes, updatedAt: this.clock() };
      const ownership = prepared.plan.mode === 'offline-bundle'
        ? { kind: 'local-directory', root: prepared.plan.destinationRoot, state: 'acquiring' }
        : { kind: 'alternate-cluster-stage', clusterFingerprint: prepared.plan.target.clusterFingerprint, state: 'acquiring' };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { ...(await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId)).target, ownership } }, actorId);
      const result = prepared.plan.mode === 'offline-bundle'
        ? await this.#materializeOffline(prepared, restoreRunId, signal, progress)
        : await this.#restoreAlternate(workspaceId, prepared, restoreRunId, signal, progress);
      progress = { ...progress, phase: 'validating', updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validation = prepared.plan.mode === 'offline-bundle'
        ? { state: 'succeeded', mode: 'authenticated-offline-bundle', inventoryDigest: result.inventory.inventoryDigest, serviceMutation: false, completedAt: this.clock() }
        : { state: 'succeeded', mode: 'native-alternate-cluster', schemaApplied: result.schemaApplied, loadedDirectoryCount: result.loadedDirectoryCount, repairedNodeCount: result.repairedNodeCount, nativeValidation: true, completedAt: this.clock() };
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      return this.#project(workspaceId, restoreRunId, {
        state: 'succeeded', completedAt: this.clock(), progress, validation,
        target: { ...(current.target || {}), ownership: { ...(current.target?.ownership || {}), state: prepared.plan.mode === 'offline-bundle' ? 'committed' : 'released', completedAt: this.clock() } },
        result: { state: 'succeeded', mode: prepared.plan.mode, recoveryPointIds: prepared.plan.recoveryPointIds, destinationRoot: prepared.plan.destinationRoot, targetClusterFingerprint: prepared.plan.target?.clusterFingerprint || null, bytesRestored: progress.bytesWritten, fileCount: result.fileCount || null, rebuiltObjects: prepared.plan.rebuildObjects, warnings: [], cancellationRollbackSupported: false, completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'CASSANDRA_RESTORE_CANCELED';
        const cleanupUnproven = error?.offlineCleanupProven === false || error?.stageCleanupProven === false;
        const targetMutation = error?.targetMutationOccurred === true || current.target?.mode === 'alternate-cluster';
        const state = cleanupUnproven ? 'interrupted' : canceled ? 'canceled' : 'failed';
        return this.#project(workspaceId, restoreRunId, {
          state, completedAt: state === 'interrupted' ? null : this.clock(),
          progress: { ...progress, phase: state === 'interrupted' ? 'operator-action-required' : state, updatedAt: this.clock() },
          target: { ...(current.target || {}), ownership: current.target?.ownership ? { ...current.target.ownership, state: cleanupUnproven ? 'active' : 'released', reconciledAt: this.clock() } : null },
          result: { state, cleanupRequired: cleanupUnproven || targetMutation, targetMutationMayHaveOccurred: targetMutation, rollbackPerformed: false, error: publicError(error), completedAt: state === 'interrupted' ? null : this.clock() }
        }, actorId);
      }
      throw error;
    }
  }
}

module.exports = {
  ALTERNATE_CONFIRMATIONS,
  CassandraScyllaRestoreError,
  CassandraScyllaRestoreService,
  MAX_ARCHIVE_FILES,
  OFFLINE_CONFIRMATION,
  assertExecutablePlan,
  assertCompatibleVersions,
  consumeNodeArchive,
  normalizePreviewRequest,
  publicPlan,
  safeArchivePath,
  safeLocalRoot,
  validateClusterManifest,
  validateRecoveryChain
};
