const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID, clusterTopologyFingerprint, deploymentFingerprint } = require('./redis');
const { openSftpSession } = require('./sftp-repository');

const LOCAL_CONNECTION_ADAPTER_ID = 'deployerx.connection.local';
const SSH_CONNECTION_ADAPTER_ID = 'deployerx.connection.ssh';
const READ_BLOCK_BYTES = 64 * 1024;

class RedisSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'RedisSourceReaderError';
    this.code = code;
    this.category = options.category || 'source';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function preparationPrefix(workspaceId, executionId) {
  return `run-${crypto.createHash('sha256').update(`${workspaceId}\0${executionId}`).digest('hex').slice(0, 32)}-`;
}

function normalizedLocalStat(stat) {
  if (!stat) return null;
  return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink(), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
}

function normalizedRemoteStat(attributes) {
  if (!attributes) return null;
  const mode = Number(attributes.mode) & 0o170000;
  return { isFile: mode === 0o100000, isSymbolicLink: mode === 0o120000, size: Number(attributes.size), mtimeMs: Number(attributes.mtime) * 1000 };
}

function localFilesystemProvider({ fileSystem, createReadStream }) {
  return {
    resolvePath(directory, filename) {
      const root = path.resolve(requiredText(directory, 'Redis persistence directory'));
      const resolved = path.resolve(root, requiredText(filename, 'Redis RDB filename', 255));
      if (path.dirname(resolved) !== root) throw new RedisSourceReaderError('REDIS_RDB_PATH_INVALID', 'The Redis RDB path escapes its configured persistence directory.', { category: 'integrity' });
      return resolved;
    },
    resolveAofPath(directory, appendDirectoryName, filename) {
      const root = path.resolve(requiredText(directory, 'Redis persistence directory'), requiredText(appendDirectoryName, 'Redis AOF directory name', 255));
      const resolved = path.resolve(root, requiredText(filename, 'Redis AOF filename', 255));
      if (path.dirname(resolved) !== root) throw new RedisSourceReaderError('REDIS_AOF_PATH_INVALID', 'The Redis AOF path escapes its configured persistence directory.', { category: 'integrity' });
      return resolved;
    },
    validateBackupPath(directory, backupDirectoryName, listedPath) {
      const root = path.resolve(requiredText(directory, 'Redis persistence directory'), requiredText(backupDirectoryName, 'Redis backup directory name', 255));
      const input = requiredText(listedPath, 'Redis sealed backup path');
      if (!path.isAbsolute(input)) throw new RedisSourceReaderError('REDIS_BACKUP_PATH_INVALID', 'Redis sealed backup paths must be absolute.', { category: 'integrity' });
      const resolved = path.resolve(input);
      if (path.dirname(resolved) !== root) throw new RedisSourceReaderError('REDIS_BACKUP_PATH_INVALID', 'A Redis sealed backup path is outside the configured backup directory.', { category: 'integrity' });
      return resolved;
    },
    async lstat(filePath) { return normalizedLocalStat(await fileSystem.lstat(filePath)); },
    read(filePath, signal) { return createReadStream(filePath, { highWaterMark: READ_BLOCK_BYTES, signal }); },
    close() {}
  };
}

function remoteFilesystemProvider(session) {
  return {
    resolvePath(directory, filename) {
      const root = path.posix.normalize(requiredText(directory, 'Redis persistence directory'));
      if (!root.startsWith('/')) throw new RedisSourceReaderError('REDIS_RDB_PATH_INVALID', 'The remote Redis persistence directory must be absolute.', { category: 'integrity' });
      const resolved = path.posix.join(root, requiredText(filename, 'Redis RDB filename', 255));
      if (path.posix.dirname(resolved) !== root) throw new RedisSourceReaderError('REDIS_RDB_PATH_INVALID', 'The Redis RDB path escapes its configured persistence directory.', { category: 'integrity' });
      return resolved;
    },
    resolveAofPath(directory, appendDirectoryName, filename) {
      const root = path.posix.join(path.posix.normalize(requiredText(directory, 'Redis persistence directory')), requiredText(appendDirectoryName, 'Redis AOF directory name', 255));
      if (!root.startsWith('/')) throw new RedisSourceReaderError('REDIS_AOF_PATH_INVALID', 'The remote Redis AOF directory must be absolute.', { category: 'integrity' });
      const resolved = path.posix.join(root, requiredText(filename, 'Redis AOF filename', 255));
      if (path.posix.dirname(resolved) !== root) throw new RedisSourceReaderError('REDIS_AOF_PATH_INVALID', 'The Redis AOF path escapes its configured persistence directory.', { category: 'integrity' });
      return resolved;
    },
    validateBackupPath(directory, backupDirectoryName, listedPath) {
      const root = path.posix.join(path.posix.normalize(requiredText(directory, 'Redis persistence directory')), requiredText(backupDirectoryName, 'Redis backup directory name', 255));
      const input = requiredText(listedPath, 'Redis sealed backup path');
      if (!input.startsWith('/')) throw new RedisSourceReaderError('REDIS_BACKUP_PATH_INVALID', 'Remote Redis sealed backup paths must be absolute.', { category: 'integrity' });
      const resolved = path.posix.normalize(input);
      if (path.posix.dirname(resolved) !== root) throw new RedisSourceReaderError('REDIS_BACKUP_PATH_INVALID', 'A Redis sealed backup path is outside the configured backup directory.', { category: 'integrity' });
      return resolved;
    },
    async lstat(filePath) { return normalizedRemoteStat(await session.lstat(filePath)); },
    read(filePath, signal) {
      return (async function* readRemoteRdb() {
        const handle = await session.open(filePath, 'r');
        let position = 0;
        try {
          while (true) {
            if (signal?.aborted) throw new RedisSourceReaderError('REDIS_BACKUP_CANCELED', 'The Redis RDB backup was canceled.', { category: 'canceled' });
            const buffer = Buffer.allocUnsafe(READ_BLOCK_BYTES);
            const bytesRead = await session.read(handle, buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            position += bytesRead;
            yield Buffer.from(buffer.subarray(0, bytesRead));
          }
        } finally { await session.closeHandle(handle).catch(() => {}); }
      })();
    },
    close() { session.close(); }
  };
}

class RedisSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, adapterRegistry, adapter, temporaryRoot = path.join(os.tmpdir(), 'deployerx-redis-backups'), fileSystem = fsPromises, createReadStream = fs.createReadStream, openRemoteSession = openSftpSession } = {}) {
    if (!controlDatabase || !secretStore || !adapterRegistry || !adapter) throw new TypeError('Redis source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'Redis temporary root'));
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.openRemoteSession = openRemoteSession;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new RedisSourceReaderError('REDIS_SOURCE_UNAVAILABLE', 'The Redis source is unavailable.');
    const selector = source.selector || {};
    const childRules = (selector.databases?.include?.length || 0) + (selector.databases?.exclude?.length || 0) + (selector.schemas?.include?.length || 0) + (selector.schemas?.exclude?.length || 0) + (selector.tables?.include?.length || 0) + (selector.tables?.exclude?.length || 0);
    if (selector.allDatabases !== true || childRules || selector.includeGlobalObjects || source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full' || !['redis-rdb', 'redis-aof', 'redis-cluster-rdb', 'redis-cluster-aof'].includes(source.consistency?.method)) throw new RedisSourceReaderError('REDIS_SOURCE_SELECTION_INVALID', 'The Redis source must protect the complete deployment as a full native recovery point.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new RedisSourceReaderError('REDIS_SOURCE_CONNECTION_MISSING', 'The Redis source connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new RedisSourceReaderError('REDIS_SOURCE_OTHER_DEVICE', 'The Redis source belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new RedisSourceReaderError('REDIS_SOURCE_CONNECTION_UNHEALTHY', 'Test the Redis connection successfully before running a backup.', { category: 'connectivity', retryable: true });
    const loadPair = async (redisConnection, label) => {
      const filesystemConnection = await this.controlDatabase.repository('connection').get(tenant, requiredText(redisConnection.endpoint?.filesystemConnectionId, `${label} filesystem connection ID`, 200));
      if (!filesystemConnection || ![LOCAL_CONNECTION_ADAPTER_ID, SSH_CONNECTION_ADAPTER_ID].includes(filesystemConnection.adapterId)) throw new RedisSourceReaderError('REDIS_FILESYSTEM_CONNECTION_MISSING', `The paired ${label} filesystem connection is unavailable.`);
      if (!(filesystemConnection.workerAffinity || []).includes(`device:${this.deviceId}`) || filesystemConnection.lastTest?.status !== 'success') throw new RedisSourceReaderError('REDIS_FILESYSTEM_CONNECTION_UNHEALTHY', `Test the paired ${label} filesystem connection on this device before backup.`, { category: 'connectivity', retryable: true });
      if (filesystemConnection.adapterId === LOCAL_CONNECTION_ADAPTER_ID && !['localhost', '127.0.0.1', '::1'].includes(String(redisConnection.endpoint.host).toLowerCase())) throw new RedisSourceReaderError('REDIS_LOCAL_PAIR_MISMATCH', `A local ${label} filesystem pair requires a loopback Redis endpoint.`, { category: 'integrity' });
      if (filesystemConnection.adapterId === SSH_CONNECTION_ADAPTER_ID && String(filesystemConnection.endpoint?.host).toLowerCase() !== String(redisConnection.endpoint.host).toLowerCase()) throw new RedisSourceReaderError('REDIS_SSH_PAIR_MISMATCH', `The ${label} Redis and paired SSH connection do not identify the same host.`, { category: 'integrity' });
      const [passwordSecretRefId] = redisConnection.secretRefIds || [];
      return { connection: redisConnection, filesystemConnection, connectionConfig: this.adapter.normalizeConfig({ ...redisConnection.endpoint, passwordSecretRefId }) };
    };
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new RedisSourceReaderError('REDIS_EXECUTION_NOT_READY', 'Redis backup execution is unavailable.', { category: 'compatibility' });
    const seed = await loadPair(connection, 'Redis');
    const result = {
      source,
      ...seed,
      manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: source.selector.digest, sourceRevision: source.revision }
    };
    if (connection.lastTest.endpointIdentity?.mode !== 'cluster') return result;
    const execution = source.physicalExecution;
    if (execution?.topology !== 'cluster' || execution.seedIdentityFingerprint !== connection.trust.fingerprint || execution.topologyFingerprint !== connection.lastTest.endpointIdentity.clusterTopologyFingerprint || !Array.isArray(execution.masters) || execution.masters.length !== connection.lastTest.endpointIdentity.clusterMasterCount) throw new RedisSourceReaderError('REDIS_CLUSTER_SOURCE_CHANGED', 'The Redis Cluster Source no longer matches its authenticated seed topology.', { category: 'integrity' });
    const clusterMasters = [];
    for (const enrolled of execution.masters) {
      const masterConnection = await this.controlDatabase.repository('connection').get(tenant, enrolled.connectionId);
      const identity = masterConnection?.lastTest?.endpointIdentity;
      if (!masterConnection || masterConnection.adapterId !== ADAPTER_ID || masterConnection.lastTest?.status !== 'success' || !(masterConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new RedisSourceReaderError('REDIS_CLUSTER_MASTER_UNAVAILABLE', `Redis Cluster master ${enrolled.nodeId} is unavailable or unhealthy.`, { category: 'connectivity', retryable: true });
      if (masterConnection.trust?.fingerprint !== enrolled.serverIdentityFingerprint || identity?.mode !== 'cluster' || identity.clusterNodeId !== enrolled.nodeId || identity.clusterTopologyFingerprint !== execution.topologyFingerprint) throw new RedisSourceReaderError('REDIS_CLUSTER_MASTER_IDENTITY_CHANGED', `Redis Cluster master ${enrolled.nodeId} no longer matches the enrolled topology.`, { category: 'integrity' });
      clusterMasters.push({ ...enrolled, ...await loadPair(masterConnection, `Redis Cluster master ${enrolled.nodeId}`) });
    }
    return { ...result, clusterMasters };
  }

  async #filesystem(workspaceId, plan, signal) {
    if (plan.filesystemConnection.adapterId === LOCAL_CONNECTION_ADAPTER_ID) return localFilesystemProvider({ fileSystem: this.fileSystem, createReadStream: this.createReadStream });
    const connection = plan.filesystemConnection;
    const [credentialSecretRefId, passphraseSecretRefId = null] = connection.secretRefIds || [];
    const session = await this.openRemoteSession({
      connectionConfig: { ...connection.endpoint, credentialSecretRefId, passphraseSecretRefId, hostKeyFingerprint: connection.trust?.fingerprint, hostKeyAlgorithm: connection.trust?.algorithm },
      resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }),
      signal
    });
    return remoteFilesystemProvider(session);
  }

  async #captureMedia(workspaceId, member, adapterPlan, destination, options, onSession) {
    const filesystem = await this.#filesystem(workspaceId, member, options.signal);
    try {
      const context = { resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), filesystem, signal: options.signal, onProgress: options.onProgress, onSession };
      return adapterPlan.operation === 'redis-sealed-backup'
        ? await this.adapter.createSealedBackupMedia(context, adapterPlan, destination)
        : adapterPlan.operation === 'redis-multipart-aof-backup'
          ? await this.adapter.createMultipartAofMedia(context, adapterPlan, destination)
          : await this.adapter.createRdbMedia(context, adapterPlan, destination);
    } finally { filesystem.close(); }
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    let filesystem = null;
    try {
      const resolveSecret = (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId });
      const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, { resolveSecret, signal: options.signal }, { connection: plan.connectionConfig, selector: plan.source.selector, consistency: plan.source.consistency, execution: plan.source.physicalExecution });
      if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new RedisSourceReaderError('REDIS_IDENTITY_CHANGED', 'Redis identity changed after its last successful connection test.', { category: 'integrity' });
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const ownerPath = path.join(directory, '.owner.json');
      let owner = { version: 1, workspaceId, executionId, connectionId: plan.connection.id, redisSession: null };
      await this.fileSystem.writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      const onSession = async (session, connectionId = plan.connection.id) => {
        owner = { ...owner, redisSession: session ? { connectionId, ownership: session } : null };
        const nextPath = `${ownerPath}.next`;
        await this.fileSystem.writeFile(nextPath, JSON.stringify(owner), { flag: 'w', mode: 0o600 });
        await this.fileSystem.rename(nextPath, ownerPath);
      };
      if (['redis-cluster-rdb-backup', 'redis-cluster-aof-backup'].includes(prepared.adapterPlan.operation)) {
        const execution = plan.source.physicalExecution;
        const seedBefore = await this.adapter.readIdentity({ resolveSecret, signal: options.signal }, plan.connectionConfig);
        if (deploymentFingerprint(seedBefore) !== execution.seedIdentityFingerprint || clusterTopologyFingerprint(seedBefore.cluster) !== execution.topologyFingerprint) throw new RedisSourceReaderError('REDIS_CLUSTER_TOPOLOGY_CHANGED', 'Redis Cluster topology changed before capture.', { category: 'integrity' });
        const files = [];
        const masters = [];
        for (const member of plan.clusterMasters) {
          if (options.signal?.aborted) throw new RedisSourceReaderError('REDIS_OPERATION_CANCELED', 'Redis Cluster backup was canceled.', { category: 'canceled' });
          const memberPlan = await this.adapter.planClusterMemberBackup({ resolveSecret, signal: options.signal }, { connection: member.connectionConfig, nodeId: member.nodeId, topologyFingerprint: execution.topologyFingerprint, method: plan.source.consistency.method, artifactPrefix: 'redis/cluster' });
          const memberDirectory = path.join(directory, crypto.createHash('sha256').update(member.nodeId).digest('hex').slice(0, 24));
          if (memberPlan.operation === 'redis-rdb-backup') await this.fileSystem.mkdir(memberDirectory, { recursive: false, mode: 0o700 });
          const media = await this.#captureMedia(workspaceId, member, memberPlan, memberPlan.operation === 'redis-rdb-backup' ? path.join(memberDirectory, 'dump.rdb') : memberDirectory, options, (session) => onSession(session, member.connection.id));
          const protectedSet = memberPlan.operation !== 'redis-rdb-backup';
          const memberFiles = (protectedSet ? media.files : [{ component: 'rdb', filePath: media.filePath, artifactPath: memberPlan.artifact.path, sizeBytes: media.sizeBytes, digest: media.digest, mediaType: memberPlan.artifact.mediaType }]).map((file) => ({ ...file, nodeId: member.nodeId, artifactKind: 'physical-backup' }));
          files.push(...memberFiles);
          masters.push({
            nodeId: member.nodeId, address: member.address, slots: member.slots.slice(), connectionId: member.connection.id, connectionRevision: member.connection.revision,
            filesystemConnectionId: member.filesystemConnection.id, filesystemConnectionRevision: member.filesystemConnection.revision,
            serverIdentityFingerprint: member.serverIdentityFingerprint, kind: protectedSet ? memberPlan.operation === 'redis-sealed-backup' ? 'redis-sealed-backup' : 'redis-multipart-aof' : 'redis-rdb',
            serverVersion: memberPlan.consistency.evidence.metadata.serverVersion, databases: memberPlan.consistency.evidence.metadata.databases || [], before: media.before, after: media.after,
            ...(protectedSet ? { manifestEntries: media.manifestEntries } : {}),
            artifacts: memberFiles.map((file) => ({ kind: 'physical-backup', component: file.component, path: file.artifactPath, filename: file.filename || path.basename(file.artifactPath), mediaType: file.mediaType || (file.component === 'base' ? 'application/x-redis-rdb' : file.component === 'increment' ? 'application/x-redis-aof' : file.component === 'rdb' ? 'application/x-redis-rdb' : 'text/plain'), sizeBytes: file.sizeBytes, contentDigest: file.digest }))
          });
        }
        const seedAfter = await this.adapter.readIdentity({ resolveSecret, signal: options.signal }, plan.connectionConfig);
        if (deploymentFingerprint(seedAfter) !== execution.seedIdentityFingerprint || clusterTopologyFingerprint(seedAfter.cluster) !== execution.topologyFingerprint) throw new RedisSourceReaderError('REDIS_CLUSTER_TOPOLOGY_CHANGED', 'Redis Cluster topology changed during per-master capture.', { category: 'integrity' });
        if (masters.length !== execution.masters.length || masters.reduce((total, master) => total + master.slots.reduce((count, range) => { const [first, last = first] = range.split('-').map(Number); return count + last - first + 1; }, 0), 0) !== 16384) throw new RedisSourceReaderError('REDIS_CLUSTER_ARTIFACT_SET_INCOMPLETE', 'Redis Cluster recovery metadata does not cover every slot-owning master.', { category: 'integrity' });
        const databaseManifest = {
          version: 1, kind: 'redis-cluster-backup', adapterId: ADAPTER_ID, adapterVersion: prepared.adapterVersion, engine: 'redis', backupMethod: 'physical', backupMode: 'full',
          selection: plan.source.selector, selectionDigest: plan.source.selector.digest, consistency: prepared.consistency,
          source: { seedConnectionId: plan.connection.id, seedConnectionRevision: plan.connection.revision, seedIdentityFingerprint: execution.seedIdentityFingerprint },
          cluster: { topologyFingerprint: execution.topologyFingerprint, coveredSlots: execution.coveredSlots, masters },
          artifacts: masters.flatMap((master) => master.artifacts),
          restore: { originalReplacementSupported: false, alternateIsolatedOnly: true, topology: 'cluster' }
        };
        return { directory, files, sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0), prepared, databaseManifest };
      }
      filesystem = await this.#filesystem(workspaceId, plan, options.signal);
      const media = prepared.adapterPlan.operation === 'redis-sealed-backup'
        ? await this.adapter.createSealedBackupMedia({ resolveSecret, filesystem, signal: options.signal, onProgress: options.onProgress, onSession }, prepared.adapterPlan, path.join(directory, 'sealed'))
        : prepared.adapterPlan.operation === 'redis-multipart-aof-backup'
          ? await this.adapter.createMultipartAofMedia({ resolveSecret, filesystem, signal: options.signal, onProgress: options.onProgress, onSession }, prepared.adapterPlan, path.join(directory, 'aof'))
          : await this.adapter.createRdbMedia({ resolveSecret, filesystem, signal: options.signal, onProgress: options.onProgress }, prepared.adapterPlan, path.join(directory, 'dump.rdb'));
      filesystem.close();
      filesystem = null;
      const protectedSet = ['redis-sealed-backup', 'redis-multipart-aof-backup'].includes(prepared.adapterPlan.operation);
      const files = protectedSet ? media.files : [{ component: 'rdb', filePath: media.filePath, artifactPath: prepared.adapterPlan.artifact.path, sizeBytes: media.sizeBytes, digest: media.digest, mediaType: prepared.adapterPlan.artifact.mediaType }];
      const databaseManifest = {
        version: 1,
        kind: prepared.adapterPlan.operation === 'redis-sealed-backup' ? 'redis-sealed-backup' : prepared.adapterPlan.operation === 'redis-multipart-aof-backup' ? 'redis-multipart-aof' : 'redis-rdb',
        adapterId: ADAPTER_ID,
        adapterVersion: prepared.adapterVersion,
        engine: 'redis',
        backupMethod: 'physical',
        backupMode: 'full',
        selection: plan.source.selector,
        selectionDigest: plan.source.selector.digest,
        consistency: prepared.consistency,
        source: { redisConnectionId: plan.connection.id, redisConnectionRevision: plan.connection.revision, filesystemConnectionId: plan.filesystemConnection.id, filesystemConnectionRevision: plan.filesystemConnection.revision, serverIdentityFingerprint: prepared.consistency.evidence.serverIdentityFingerprint },
        coordinates: { before: media.before, after: media.after },
        ...(protectedSet ? {
          ...(media.session ? { session: media.session } : {}),
          ...(media.rewritePolicy ? { rewritePolicy: media.rewritePolicy } : {}),
          manifestEntries: media.manifestEntries,
          artifacts: files.map((file) => ({ kind: 'physical-backup', component: file.component, path: file.artifactPath, mediaType: file.mediaType || (file.component === 'base' ? 'application/x-redis-rdb' : file.component === 'increment' ? 'application/x-redis-aof' : 'text/plain'), sizeBytes: file.sizeBytes, contentDigest: file.digest, filename: file.filename }))
        } : { artifact: { kind: 'database-dump', path: prepared.adapterPlan.artifact.path, mediaType: prepared.adapterPlan.artifact.mediaType, sizeBytes: media.sizeBytes, contentDigest: media.digest } }),
        restore: { originalReplacementSupported: false, alternateIsolatedOnly: true }
      };
      return { directory, files, sizeBytes: media.sizeBytes, prepared, databaseManifest };
    } catch (error) {
      filesystem?.close();
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof RedisSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError || error?.code) throw new RedisSourceReaderError(error.code || 'REDIS_BACKUP_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new RedisSourceReaderError('REDIS_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the Redis backup.', { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (options.backupMode && options.backupMode !== 'full') throw new RedisSourceReaderError('REDIS_BACKUP_MODE_UNSUPPORTED', 'Redis backup currently supports full recovery points only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    const createReadStream = this.createReadStream;
    const signal = options.signal;
    const onProgress = options.onProgress;
    const bandwidthLimiter = options.bandwidthLimiter;
    const content = (file) => (async function* readStagedRedisArtifact() {
      for await (const rawChunk of createReadStream(file.filePath, { highWaterMark: READ_BLOCK_BYTES, signal })) {
        const chunk = Buffer.from(rawChunk);
        const paced = bandwidthLimiter ? await bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await onProgress?.({ phase: 'transferring', path: file.artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
    })();
    const artifactPaths = prepared.files.map((file) => file.artifactPath);
    return {
      ...plan,
      manifest: { ...plan.manifest, workloadType: 'database', resumable: false, consistency: prepared.prepared.consistency, database: prepared.databaseManifest, artifactPath: artifactPaths.length === 1 ? artifactPaths[0] : null, artifactPaths, sizeBytes: prepared.sizeBytes },
      create: async function* createRedisFiles() {
        for (const file of prepared.files) yield { path: file.artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: file.artifactKind || (file.component === 'rdb' ? 'database-dump' : 'physical-backup'), component: file.component, ...(file.nodeId ? { clusterNodeId: file.nodeId } : {}), database: prepared.databaseManifest }, content: content(file) };
      }
    };
  }

  async release(workspaceId, executionId) {
    const key = `${requiredText(workspaceId, 'Workspace ID', 200)}:${requiredText(executionId, 'Backup execution ID', 200)}`;
    const promise = this.preparations.get(key);
    this.preparations.delete(key);
    if (!promise) return false;
    const prepared = await promise.catch(() => null);
    if (prepared?.directory) await this.fileSystem.rm(prepared.directory, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async reconcileRun(workspaceId, run = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(run.id, 'Backup execution ID', 200);
    const prefix = preparationPrefix(tenant, executionId);
    const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    let removed = 0;
    let reconciledSessions = 0;
    let proven = true;
    for (const entry of entries.slice(0, 10000)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const directory = path.join(this.temporaryRoot, entry.name);
      const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (owner?.version !== 1 || owner.workspaceId !== tenant || owner.executionId !== executionId) continue;
      if (owner.redisSession) {
        const sessionRecord = owner.redisSession.ownership ? owner.redisSession : { connectionId: owner.connectionId, ownership: owner.redisSession };
        const connection = await this.controlDatabase.repository('connection').get(tenant, sessionRecord.connectionId);
        if (!connection || connection.adapterId !== ADAPTER_ID) { proven = false; continue; }
        const [passwordSecretRefId] = connection.secretRefIds || [];
        const result = await this.adapter.reconcileBackupSession({ resolveSecret: (id) => this.secretStore.resolve({ workspaceId: tenant, id }) }, this.adapter.normalizeConfig({ ...connection.endpoint, passwordSecretRefId }), sessionRecord.ownership);
        if (!result.proven) { proven = false; continue; }
        if (result.reconciled) reconciledSessions += 1;
      }
      await this.fileSystem.rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return { applicable: true, proven, removedTemporaryDirectories: removed, reconciledSessions, sourceLease: run.sourceLease || null };
  }
}

module.exports = {
  LOCAL_CONNECTION_ADAPTER_ID,
  RedisSourceReaderError,
  RedisSourceReaderService,
  SSH_CONNECTION_ADAPTER_ID,
  localFilesystemProvider,
  normalizedLocalStat,
  normalizedRemoteStat,
  preparationPrefix,
  remoteFilesystemProvider
};
