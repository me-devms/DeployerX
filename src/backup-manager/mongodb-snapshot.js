const path = require('path');
const { Readable } = require('stream');
const { compareOplogTimestamps, deploymentFingerprint, normalizeConfig, oplogTimestamp } = require('./mongodb');

const MAXIMUM_MEMBERS = 1000;
const MAXIMUM_LOCK_MS = 120000;

class MongoDbSnapshotError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MongoDbSnapshotError';
    this.code = code;
    this.category = options.category || 'snapshot';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function absoluteLinuxPath(value, label, options = {}) {
  const candidate = requiredText(value, label, 4096);
  if (!path.posix.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate || (!options.allowRoot && candidate === '/') || /[\r\n]/.test(candidate)) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PATH_INVALID', `${label} must be a normalized absolute Linux path below the filesystem root.`, { category: 'validation' });
  return candidate;
}

function normalizeLayout(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MongoDB snapshot layout must be an object.');
  const dbPath = absoluteLinuxPath(input.dbPath, 'MongoDB dbPath');
  const journalPath = absoluteLinuxPath(input.journalPath || path.posix.join(dbPath, 'journal'), 'MongoDB journal path');
  const keyFiles = [...new Set((Array.isArray(input.keyFiles) ? input.keyFiles : []).slice(0, 20).map((item) => absoluteLinuxPath(item, 'MongoDB required key/config file')))];
  return { dbPath, journalPath, keyFiles };
}

function normalizeProviderManifest(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('MongoDB snapshot provider manifest must be an object.');
  if (Number(raw.apiVersion) !== 1) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PROVIDER_API_UNSUPPORTED', 'The MongoDB snapshot provider API version is unsupported.', { category: 'compatibility' });
  return {
    apiVersion: 1,
    providerId: requiredText(raw.providerId, 'Snapshot provider ID', 200),
    providerVersion: requiredText(raw.providerVersion, 'Snapshot provider version', 100),
    displayName: requiredText(raw.displayName, 'Snapshot provider name', 200),
    platform: requiredText(raw.platform, 'Snapshot provider platform', 40),
    atomic: raw.atomic === true,
    supportsExport: raw.supportsExport === true,
    supportsDiscard: raw.supportsDiscard === true,
    supportsRestore: raw.supportsRestore === true,
    consistencyProtocols: [...new Set((Array.isArray(raw.consistencyProtocols) ? raw.consistencyProtocols : []).map((item) => requiredText(item, 'Snapshot consistency protocol', 100)))]
  };
}

class MongoDbSnapshotProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider || ['manifest', 'preflight', 'createSnapshot', 'openExport', 'discardSnapshot'].some((method) => typeof provider[method] !== 'function')) throw new TypeError('MongoDB snapshot providers must implement manifest, preflight, createSnapshot, openExport, and discardSnapshot.');
    const manifest = normalizeProviderManifest(provider.manifest());
    if (!manifest.atomic || !manifest.supportsExport || !manifest.supportsDiscard || !manifest.consistencyProtocols.includes('mongodb-fsync-lock')) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PROVIDER_UNSAFE', 'The snapshot provider must prove atomic export, discard, and MongoDB fsync-lock coordination support.', { category: 'compatibility' });
    if (manifest.supportsRestore && ['preflightRestore', 'restoreExport', 'validateRestoredMedia', 'commitRestore', 'rollbackRestore'].some((method) => typeof provider[method] !== 'function')) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_RESTORE_PROVIDER_INVALID', 'Restore-capable MongoDB snapshot providers must implement preflight, media restore, isolated validation, lease commit, and rollback cleanup.', { category: 'compatibility' });
    if (this.providers.has(manifest.providerId)) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PROVIDER_DUPLICATE', 'A MongoDB snapshot provider with this ID is already registered.', { category: 'conflict' });
    this.providers.set(manifest.providerId, { provider, manifest });
    return manifest;
  }

  get(providerId) {
    const entry = this.providers.get(requiredText(providerId, 'Snapshot provider ID', 200));
    if (!entry) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PROVIDER_NOT_FOUND', 'The selected MongoDB snapshot provider is unavailable on this worker.', { category: 'not-found' });
    return entry;
  }

  list() { return [...this.providers.values()].map((entry) => structuredClone(entry.manifest)); }
}

function memberTimestamp(member) {
  return member?.optime ? { $timestamp: oplogTimestamp(member.optime, 'MongoDB replica-set member optime') } : null;
}

function selectReplicaSetMember(identity, input = {}) {
  if (identity?.topology !== 'replica-set' || !identity.replicaSetId || !identity.replicaStatus?.lastCommittedOpTime?.timestamp) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_REPLICA_EVIDENCE_MISSING', 'MongoDB coordinated snapshots require authenticated replica-set health and majority-commit evidence.', { category: 'consistency' });
  const members = Array.isArray(identity.replicaStatus.members) ? identity.replicaStatus.members.slice(0, MAXIMUM_MEMBERS) : [];
  const primary = members.find((member) => member.state === 'PRIMARY' && member.health === 1 && memberTimestamp(member));
  if (!primary) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PRIMARY_UNHEALTHY', 'MongoDB has no healthy primary operation-time reference.', { category: 'connectivity', retryable: true });
  const primaryTimestamp = memberTimestamp(primary);
  const committed = identity.replicaStatus.lastCommittedOpTime.timestamp;
  const maxLagSeconds = Number(input.maxLagSeconds ?? 30);
  if (!Number.isInteger(maxLagSeconds) || maxLagSeconds < 0 || maxLagSeconds > 3600) throw new TypeError('MongoDB snapshot maximum lag must be between 0 and 3600 seconds.');
  const allowPrimary = input.allowPrimary === true;
  const preferredMember = input.preferredMember ? requiredText(input.preferredMember, 'Preferred MongoDB member', 255) : null;
  const candidates = members.map((member) => {
    const timestamp = memberTimestamp(member);
    const lagSeconds = timestamp ? Math.max(0, oplogTimestamp(primaryTimestamp).t - oplogTimestamp(timestamp).t) : Number.POSITIVE_INFINITY;
    const eligible = member.health === 1 && ['PRIMARY', 'SECONDARY'].includes(member.state) && !member.arbiterOnly && !member.hidden && member.secondaryDelaySeconds === 0
      && member.uptimeSeconds >= 60 && timestamp && compareOplogTimestamps(timestamp, committed) >= 0 && lagSeconds <= maxLagSeconds && (member.state === 'SECONDARY' || allowPrimary);
    return { ...member, lagSeconds, eligible: Boolean(eligible) };
  });
  if (preferredMember) {
    const preferred = candidates.find((member) => member.name === preferredMember);
    if (!preferred || !preferred.eligible) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PREFERRED_MEMBER_UNSAFE', 'The preferred MongoDB member is not a healthy, current, data-bearing snapshot source.', { category: 'consistency' });
    return preferred;
  }
  const selected = candidates.filter((member) => member.eligible).sort((left, right) => (left.state === right.state ? left.lagSeconds - right.lagSeconds || left.name.localeCompare(right.name, 'en-US') : left.state === 'SECONDARY' ? -1 : 1))[0];
  if (!selected) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_MEMBER_UNAVAILABLE', 'No healthy MongoDB data-bearing member satisfies the snapshot lag and replication-headroom policy.', { category: 'consistency', retryable: true });
  return selected;
}

function normalizePreflight(raw, manifest, layout) {
  if (!raw || raw.ready !== true) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PROVIDER_NOT_READY', 'The snapshot provider did not prove that the selected member layout is ready.', { category: 'compatibility' });
  const mappings = (Array.isArray(raw.volumeMappings) ? raw.volumeMappings : []).slice(0, 100).map((mapping) => ({
    sourcePath: absoluteLinuxPath(mapping.sourcePath, 'Snapshot source path'),
    volumeId: requiredText(mapping.volumeId, 'Snapshot volume ID', 500),
    filesystem: requiredText(mapping.filesystem, 'Snapshot filesystem', 100),
    mountPoint: absoluteLinuxPath(mapping.mountPoint, 'Snapshot mount point', { allowRoot: true })
  }));
  const covers = (target) => mappings.some((mapping) => mapping.mountPoint === '/' || target === mapping.mountPoint || target.startsWith(`${mapping.mountPoint}/`));
  if (!mappings.length || !covers(layout.dbPath) || !covers(layout.journalPath) || layout.keyFiles.some((item) => !covers(item))) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_VOLUME_MAPPING_INCOMPLETE', 'The snapshot provider does not cover every required MongoDB path.', { category: 'consistency' });
  if (raw.atomic !== true || raw.journalCoLocated !== true || raw.requiresFsyncLock !== true || raw.exportable !== true) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_PROVIDER_GUARANTEE_MISSING', 'The provider did not prove atomicity, journal co-location, fsync-lock coordination, and exportability.', { category: 'consistency' });
  return { providerId: manifest.providerId, providerVersion: manifest.providerVersion, providerIdentity: requiredText(raw.providerIdentity, 'Snapshot provider identity', 500), atomic: true, journalCoLocated: true, requiresFsyncLock: true, exportable: true, volumeMappings: mappings };
}

function normalizeSnapshotResult(raw, preflight, expectedLeaseOwner = null) {
  if (!raw || typeof raw !== 'object') throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_RESULT_INVALID', 'The snapshot provider returned no snapshot identity.', { category: 'integrity' });
  const leaseOwner = raw.leaseOwner ? requiredText(raw.leaseOwner, 'Snapshot lease owner', 500) : null;
  if (expectedLeaseOwner && leaseOwner !== expectedLeaseOwner) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_LEASE_OWNER_MISMATCH', 'The snapshot provider did not confirm the exact backup lease owner.', { category: 'integrity' });
  const volumeSnapshots = (Array.isArray(raw.volumeSnapshots) ? raw.volumeSnapshots : []).slice(0, 100).map((item) => ({ volumeId: requiredText(item.volumeId, 'Snapshot volume ID', 500), snapshotId: requiredText(item.snapshotId, 'Provider snapshot ID', 500) }));
  if (volumeSnapshots.length !== preflight.volumeMappings.length || preflight.volumeMappings.some((mapping) => !volumeSnapshots.some((item) => item.volumeId === mapping.volumeId))) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_RESULT_INCOMPLETE', 'The provider did not return one immutable snapshot for every required volume.', { category: 'integrity' });
  return { snapshotSetId: requiredText(raw.snapshotSetId, 'Snapshot set ID', 500), leaseOwner, createdAt: new Date(requiredText(raw.createdAt, 'Snapshot creation time', 100)).toISOString(), volumeSnapshots, checkpointEvidence: raw.checkpointEvidence && typeof raw.checkpointEvidence === 'object' ? structuredClone(raw.checkpointEvidence) : {} };
}

class MongoDbCoordinatedSnapshotService {
  constructor({ adapter, providerRegistry = new MongoDbSnapshotProviderRegistry(), clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!adapter || typeof adapter.readIdentity !== 'function' || typeof adapter.snapshotMemberIdentity !== 'function' || typeof adapter.setSnapshotMemberLock !== 'function') throw new TypeError('MongoDB snapshot adapter dependencies are required.');
    this.adapter = adapter;
    this.providerRegistry = providerRegistry;
    this.clock = clock;
    this.now = now;
  }

  async prepare(context = {}, request = {}) {
    const connection = normalizeConfig(request.connection);
    const layout = normalizeLayout(request.layout);
    const { provider, manifest } = this.providerRegistry.get(request.providerId);
    const identity = await this.adapter.readIdentity(context, connection, { operation: 'coordinated snapshot topology preflight' });
    const fingerprint = deploymentFingerprint(identity);
    if (request.serverIdentityFingerprint && request.serverIdentityFingerprint !== fingerprint) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_DEPLOYMENT_CHANGED', 'The MongoDB deployment identity changed after Source enrollment.', { category: 'integrity' });
    const selected = selectReplicaSetMember(identity, request.memberPolicy);
    const direct = await this.adapter.snapshotMemberIdentity(context, connection, selected.name);
    if (deploymentFingerprint(direct.identity) !== fingerprint || direct.identity.replicaSetId !== identity.replicaSetId) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_MEMBER_IDENTITY_MISMATCH', 'The selected snapshot member belongs to a different MongoDB deployment.', { category: 'integrity' });
    const preflight = normalizePreflight(await provider.preflight({ member: structuredClone(selected), deployment: { fingerprint, replicaSetId: identity.replicaSetId, setName: identity.setName }, layout: structuredClone(layout), configuration: structuredClone(request.providerConfiguration || {}) }), manifest, layout);
    const leaseOwner = request.leaseOwner ? requiredText(request.leaseOwner, 'MongoDB snapshot lease owner', 500) : null;
    let sourceLease = leaseOwner ? {
      version: 1, kind: 'mongodb-snapshot-backup', providerId: manifest.providerId, providerVersion: manifest.providerVersion,
      ownerId: leaseOwner, snapshotSetId: null, targetIdentity: fingerprint, member: selected.name,
      state: 'acquiring', acquiredAt: this.clock(), updatedAt: this.clock()
    } : null;
    const publishLease = async (changes = {}) => {
      if (!sourceLease) return null;
      sourceLease = { ...sourceLease, ...structuredClone(changes), updatedAt: this.clock() };
      if (typeof context.onLease === 'function') await context.onLease(structuredClone(sourceLease));
      return sourceLease;
    };
    if (sourceLease) await publishLease();
    let lock = null;
    let snapshot = null;
    let unlockError = null;
    let creationError = null;
    const maximumLockMilliseconds = Number(request.maximumLockMilliseconds || MAXIMUM_LOCK_MS);
    if (!Number.isInteger(maximumLockMilliseconds) || maximumLockMilliseconds < 1000 || maximumLockMilliseconds > MAXIMUM_LOCK_MS) throw new TypeError(`MongoDB maximum snapshot lock duration must be between 1000 and ${MAXIMUM_LOCK_MS} milliseconds.`);
    const lockStarted = this.now();
    try {
      lock = await this.adapter.setSnapshotMemberLock(context, connection, selected.name, true);
      snapshot = normalizeSnapshotResult(await provider.createSnapshot({ leaseOwner, member: structuredClone(selected), deployment: { fingerprint, replicaSetId: identity.replicaSetId, setName: identity.setName }, layout: structuredClone(layout), preflight: structuredClone(preflight), operationTime: lock.operationTime || identity.replicaStatus.lastCommittedOpTime.timestamp, signal: context.signal }), preflight, leaseOwner);
      await publishLease({ snapshotSetId: snapshot.snapshotSetId, state: 'active' });
    } catch (_error) {
      creationError = new MongoDbSnapshotError('MONGODB_SNAPSHOT_CREATE_FAILED', 'The snapshot provider could not create a complete atomic snapshot set.', { category: 'execution', retryable: true });
    } finally {
      if (lock) {
        try { await this.adapter.setSnapshotMemberLock({ ...context, signal: undefined }, connection, selected.name, false); }
        catch (error) { unlockError = error; }
      }
    }
    const lockDurationMs = Math.max(0, this.now() - lockStarted);
    const discard = async (reason) => {
      const result = await provider.discardSnapshot({ snapshotSetId: snapshot?.snapshotSetId || null, leaseOwner, reason, signal: undefined });
      if (leaseOwner && (result?.discarded !== true || result.leaseOwner !== leaseOwner)) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_LEASE_CLEANUP_UNPROVEN', 'The snapshot provider did not prove cleanup of the owned backup lease.', { category: 'consistency' });
      await publishLease({ snapshotSetId: snapshot?.snapshotSetId || sourceLease?.snapshotSetId || null, state: 'discarded', releasedAt: this.clock(), releaseReason: reason });
    };
    if (unlockError || lockDurationMs > maximumLockMilliseconds) {
      if (snapshot || leaseOwner) await discard(unlockError ? 'unlock-failed' : 'lock-duration-exceeded').catch(() => {});
      if (unlockError) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_UNLOCK_FAILED', 'MongoDB could not prove that the selected member was unlocked; the snapshot was discarded.', { category: 'consistency', retryable: true });
      throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_LOCK_DURATION_EXCEEDED', 'The MongoDB snapshot exceeded the configured fsync-lock duration and was discarded.', { category: 'consistency', retryable: true });
    }
    if (creationError) {
      if (leaseOwner) {
        try { await discard('create-failed'); }
        catch (_error) { throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_LEASE_CLEANUP_UNPROVEN', 'Snapshot creation was interrupted and cleanup of its owned provider lease could not be proven.', { category: 'consistency' }); }
      }
      throw creationError;
    }
    if (!snapshot) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_CREATE_FAILED', 'The snapshot provider did not create a complete snapshot set.', { category: 'execution', retryable: true });
    try {
      const after = await this.adapter.snapshotMemberIdentity(context, connection, selected.name);
      if (deploymentFingerprint(after.identity) !== fingerprint || after.identity.replicaSetId !== identity.replicaSetId) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_POSTCHECK_FAILED', 'MongoDB deployment identity changed during coordinated snapshot creation.', { category: 'integrity' });
      const current = after.identity.replicaStatus?.members?.find((member) => member.name === selected.name);
      if (!current || current.health !== 1 || !['PRIMARY', 'SECONDARY'].includes(current.state)) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_MEMBER_POSTCHECK_FAILED', 'The selected MongoDB member was unhealthy after snapshot creation.', { category: 'consistency' });
    } catch (error) {
      await discard('postcheck-failed').catch(() => {});
      throw error;
    }
    const metadata = {
      version: 1, kind: 'mongodb-coordinated-snapshot', adapterId: 'deployerx.database.mongodb.native', engine: 'mongodb',
      consistency: { requestedLevel: 'application', achievedLevel: 'application', method: 'mongodb-coordinated-snapshot', backupMethod: 'physical', backupMode: 'full', proven: true },
      deployment: { serverIdentityFingerprint: fingerprint, replicaSetId: identity.replicaSetId, setName: identity.setName },
      member: { name: selected.name, state: selected.state, lagSeconds: selected.lagSeconds, optime: selected.optime },
      provider: { ...preflight, snapshotSetId: snapshot.snapshotSetId, createdAt: snapshot.createdAt, volumeSnapshots: snapshot.volumeSnapshots },
      operationTime: lock.operationTime || identity.replicaStatus.lastCommittedOpTime.timestamp,
      lock: { protocol: 'mongodb-fsync-lock', durationMilliseconds: lockDurationMs, unlocked: true },
      checkpointEvidence: snapshot.checkpointEvidence,
      layout
    };
    let released = false;
    return {
      metadata,
      lease: sourceLease ? structuredClone(sourceLease) : null,
      artifactPath: `mongodb/physical/${encodeURIComponent(snapshot.snapshotSetId)}.snapshot`,
      async content() {
        const exported = await provider.openExport({ snapshotSetId: snapshot.snapshotSetId, signal: context.signal });
        if (!exported || (!(exported[Symbol.asyncIterator]) && !(exported instanceof Readable))) throw new MongoDbSnapshotError('MONGODB_SNAPSHOT_EXPORT_INVALID', 'The snapshot provider did not return a readable export stream.', { category: 'integrity' });
        return exported;
      },
      async release(reason = 'export-complete') {
        if (released) return false;
        await discard(requiredText(reason, 'MongoDB snapshot discard reason', 100));
        released = true;
        return true;
      }
    };
  }
}

module.exports = {
  MAXIMUM_LOCK_MS,
  MongoDbCoordinatedSnapshotService,
  MongoDbSnapshotError,
  MongoDbSnapshotProviderRegistry,
  normalizeLayout,
  normalizeProviderManifest,
  selectReplicaSetMember
};
