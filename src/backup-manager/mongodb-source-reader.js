const { ADAPTER_ID, oplogCoordinate } = require('./mongodb');
const { LogicalDatabaseSourceReaderService, MAX_MYSQL_DUMP_BYTES } = require('./mysql-source-reader');

function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

class MongoDbPhysicalSnapshotBackupService {
  constructor({ controlDatabase, adapterRegistry, adapter, snapshotCoordinator, shardedSnapshotCoordinator = null, shardedWriteGateId = null, secretStore, deviceId } = {}) {
    if (!adapterRegistry || !snapshotCoordinator || !secretStore) throw new TypeError('MongoDB physical snapshot dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.snapshotCoordinator = snapshotCoordinator;
    this.shardedSnapshotCoordinator = shardedSnapshotCoordinator;
    this.shardedWriteGateId = shardedWriteGateId;
    this.secretStore = secretStore;
    this.deviceId = deviceId;
  }

  async prepare(workspaceId, _executionId, plan, options = {}) {
    const execution = plan.source.physicalExecution;
    if (!execution || execution.engine !== 'mongodb' || plan.source.consistency?.backupMethod !== 'physical' || options.backupMode !== 'full') throw new TypeError('MongoDB coordinated snapshots require a physical full Source and Job.');
    if (execution.topology === 'sharded') return this.prepareSharded(workspaceId, _executionId, plan, options);
    let snapshot = null;
    try {
      const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, {
        resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal: options.signal
      }, { connection: plan.connectionConfig, selector: plan.source.selector, consistency: plan.source.consistency, execution });
      if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new Error('The MongoDB deployment identity changed after Source enrollment.');
      const leaseOwner = `mongodb-snapshot-backup:${workspaceId}:${_executionId}`;
      snapshot = await this.snapshotCoordinator.prepare({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal: options.signal, onLease: options.onSourceLease }, {
        connection: plan.connectionConfig, providerId: execution.providerId, providerConfiguration: execution.providerConfiguration,
        leaseOwner,
        serverIdentityFingerprint: plan.connection.trust.fingerprint,
        layout: { dbPath: execution.dbPath, journalPath: execution.journalPath, keyFiles: execution.keyFiles },
        memberPolicy: { preferredMember: execution.preferredMember, maxLagSeconds: execution.maxLagSeconds, allowPrimary: execution.allowPrimary },
        maximumLockMilliseconds: execution.maximumLockMilliseconds
      });
      const artifactPath = snapshot.artifactPath;
      const databaseManifest = {
        version: 1, kind: 'mongodb-coordinated-snapshot', adapterId: ADAPTER_ID, adapterVersion: plan.manifest.adapterVersion, engine: 'mongodb',
        backupMethod: 'physical', backupMode: 'full', selection: plan.source.selector, selectionDigest: plan.source.selector.digest,
        consistency: prepared.consistency,
        server: { ...prepared.consistency.evidence.metadata, ...snapshot.metadata.deployment },
        source: { sourceId: plan.source.id, jobId: options.jobId, connectionId: plan.connection.id, connectionRevision: plan.connection.revision },
        physicalSnapshot: snapshot.metadata,
        restore: { layout: snapshot.metadata.layout, providerId: execution.providerId },
        artifact: { kind: 'physical-backup', path: artifactPath, mediaType: 'application/vnd.deployerx.mongodb-snapshot', sizeBytes: null }
      };
      const content = async function* streamSnapshotExport() {
        const opened = await snapshot.content();
        let sizeBytes = 0;
        for await (const rawChunk of opened) {
          if (options.signal?.aborted) throw new Error('The MongoDB physical snapshot export was canceled.');
          const chunk = Buffer.from(rawChunk);
          sizeBytes += chunk.length;
          if (sizeBytes > MAX_MYSQL_DUMP_BYTES) throw new Error('The MongoDB physical snapshot export exceeds the supported artifact limit.');
          const paced = options.bandwidthLimiter ? await options.bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
          await options.onProgress?.({ phase: 'transferring', path: artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
          yield chunk;
        }
        if (!sizeBytes) throw new Error('The MongoDB snapshot provider returned an empty export.');
      };
      return { physical: true, snapshot, artifactPath, databaseManifest, content };
    } catch (error) {
      if (snapshot) await snapshot.release().catch(() => {});
      throw error;
    }
  }

  async prepareSharded(workspaceId, executionId, plan, options = {}) {
    const execution = plan.source.physicalExecution;
    if (!this.controlDatabase || !this.adapter || !this.shardedSnapshotCoordinator || this.shardedWriteGateId !== execution.writeGateId) {
      const error = new Error('The approved MongoDB sharded snapshot runtime is unavailable.');
      error.code = 'MONGODB_SHARDED_RUNTIME_UNAVAILABLE';
      error.category = 'compatibility';
      throw error;
    }
    if (plan.connection.trust?.fingerprint !== execution.serverIdentityFingerprint || plan.connection.lastTest?.endpointIdentity?.clusterId !== execution.clusterId) {
      const error = new Error('The MongoDB sharded router identity changed after Source enrollment.');
      error.code = 'MONGODB_SHARDED_DEPLOYMENT_CHANGED';
      error.category = 'integrity';
      throw error;
    }
    const componentRequests = [];
    for (const component of execution.components) {
      const connection = await this.controlDatabase.repository('connection').get(workspaceId, component.connectionId);
      const identity = connection?.lastTest?.endpointIdentity;
      if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) {
        const error = new Error(`The MongoDB ${component.componentId} connection is unavailable or unhealthy.`);
        error.code = 'MONGODB_SHARDED_COMPONENT_UNAVAILABLE';
        error.category = 'connectivity';
        throw error;
      }
      if (connection.trust?.fingerprint !== component.serverIdentityFingerprint || identity?.replicaSetId !== component.expectedReplicaSetId || identity?.setName !== component.expectedSetName || identity?.replicaRole !== component.role || !sameStrings(identity?.members, component.expectedHosts)) {
        const error = new Error(`The MongoDB ${component.componentId} identity changed after Source enrollment.`);
        error.code = 'MONGODB_SHARDED_COMPONENT_IDENTITY_CHANGED';
        error.category = 'integrity';
        throw error;
      }
      const [passwordSecretRefId] = connection.secretRefIds || [];
      componentRequests.push({
        role: component.role,
        shardId: component.shardId,
        connection: this.adapter.normalizeConfig({ ...connection.endpoint, passwordSecretRefId }),
        replicaSetId: component.expectedReplicaSetId,
        serverIdentityFingerprint: component.serverIdentityFingerprint,
        providerId: component.providerId,
        providerConfiguration: component.providerConfiguration,
        layout: { dbPath: component.dbPath, journalPath: component.journalPath, keyFiles: component.keyFiles },
        memberPolicy: { preferredMember: component.preferredMember, maxLagSeconds: component.maxLagSeconds, allowPrimary: component.allowPrimary },
        maximumLockMilliseconds: component.maximumLockMilliseconds
      });
    }
    const leaseOwner = `mongodb-sharded-backup:${workspaceId}:${executionId}`;
    let snapshot = null;
    try {
      snapshot = await this.shardedSnapshotCoordinator.prepare({
        resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }),
        signal: options.signal,
        onLease: options.onSourceLease
      }, {
        routerConnection: plan.connectionConfig,
        serverIdentityFingerprint: execution.serverIdentityFingerprint,
        clusterId: execution.clusterId,
        topologyFingerprint: execution.topologyFingerprint,
        leaseOwner,
        writeGateConfiguration: execution.writeGateConfiguration,
        components: componentRequests
      });
      const artifacts = snapshot.components.map((component) => {
        const suffix = component.componentId === 'config-server' ? 'config-server' : `shards/${encodeURIComponent(component.componentId.slice('shard:'.length))}`;
        return { componentId: component.componentId, artifactPath: `mongodb/sharded/${suffix}.snapshot.export`, content: component.content };
      });
      const artifactPathByComponent = new Map(artifacts.map((artifact) => [artifact.componentId, artifact.artifactPath]));
      const physicalSnapshot = {
        ...structuredClone(snapshot.metadata),
        components: snapshot.metadata.components.map((component) => ({ ...component, artifactPath: artifactPathByComponent.get(component.componentId) }))
      };
      const consistency = { ...snapshot.metadata.consistency, captureCoordinates: true };
      const databaseManifest = {
        version: 1, kind: 'mongodb-sharded-coordinated-snapshot', adapterId: ADAPTER_ID, adapterVersion: plan.manifest.adapterVersion, engine: 'mongodb',
        backupMethod: 'physical', backupMode: 'full', selection: plan.source.selector, selectionDigest: plan.source.selector.digest,
        consistency,
        server: { topology: 'sharded', clusterId: execution.clusterId, serverIdentityFingerprint: execution.serverIdentityFingerprint, topologyFingerprint: execution.topologyFingerprint },
        source: { sourceId: plan.source.id, jobId: options.jobId, connectionId: plan.connection.id, connectionRevision: plan.connection.revision },
        physicalSnapshot,
        restore: { topology: 'sharded', components: execution.components.map((component) => ({ componentId: component.componentId, role: component.role, shardId: component.shardId, providerId: component.providerId, layout: { dbPath: component.dbPath, journalPath: component.journalPath, keyFiles: component.keyFiles } })) },
        artifacts: artifacts.map((artifact) => ({ kind: 'physical-backup', componentId: artifact.componentId, path: artifact.artifactPath, mediaType: 'application/vnd.deployerx.mongodb-snapshot', sizeBytes: null }))
      };
      const streamedArtifacts = artifacts.map((artifact) => ({
        ...artifact,
        content: async function* streamComponentExport() {
          const opened = await artifact.content();
          let sizeBytes = 0;
          for await (const rawChunk of opened) {
            if (options.signal?.aborted) throw new Error('The MongoDB sharded snapshot export was canceled.');
            const chunk = Buffer.from(rawChunk);
            sizeBytes += chunk.length;
            if (sizeBytes > MAX_MYSQL_DUMP_BYTES) throw new Error(`The MongoDB ${artifact.componentId} snapshot export exceeds the supported artifact limit.`);
            const paced = options.bandwidthLimiter ? await options.bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
            await options.onProgress?.({ phase: 'transferring', path: artifact.artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
            yield chunk;
          }
          if (!sizeBytes) throw new Error(`The MongoDB ${artifact.componentId} snapshot provider returned an empty export.`);
        }
      }));
      return { physical: true, snapshot, artifacts: streamedArtifacts, databaseManifest };
    } catch (error) {
      if (snapshot) await snapshot.release().catch(() => {});
      throw error;
    }
  }

  async release(prepared) { return prepared?.snapshot ? prepared.snapshot.release() : false; }

  async reconcile(workspaceId, run) {
    const lease = run?.sourceLease;
    if (lease?.kind === 'mongodb-sharded-coordination') return this.reconcileSharded(workspaceId, run);
    const expectedOwner = `mongodb-snapshot-backup:${workspaceId}:${run?.id}`;
    if (!lease || lease.kind !== 'mongodb-snapshot-backup' || !['acquiring', 'active'].includes(lease.state)) return { applicable: false, proven: true, sourceLease: lease || null };
    if (lease.ownerId !== expectedOwner || !lease.providerId || !lease.targetIdentity) return { applicable: true, proven: false, sourceLease: lease };
    try {
      const { provider } = this.snapshotCoordinator.providerRegistry.get(lease.providerId);
      const result = await provider.discardSnapshot({ snapshotSetId: lease.snapshotSetId || null, leaseOwner: lease.ownerId, reason: 'process-interrupted', signal: undefined });
      if (result?.discarded !== true || result.leaseOwner !== lease.ownerId) return { applicable: true, proven: false, sourceLease: lease };
      const releasedAt = new Date().toISOString();
      return { applicable: true, proven: true, sourceLease: { ...lease, state: 'discarded', releasedAt, releaseReason: 'process-interrupted', updatedAt: releasedAt } };
    } catch (_error) {
      return { applicable: true, proven: false, sourceLease: lease };
    }
  }

  async reconcileSharded(workspaceId, run) {
    const lease = run?.sourceLease;
    const expectedOwner = `mongodb-sharded-backup:${workspaceId}:${run?.id}`;
    if (lease?.ownerId !== expectedOwner || !this.controlDatabase || !this.adapter || !this.shardedSnapshotCoordinator) return { applicable: true, proven: false, sourceLease: lease };
    try {
      const job = await this.controlDatabase.repository('backupJob').get(workspaceId, run.jobId);
      const source = job ? await this.controlDatabase.repository('source').get(workspaceId, job.sourceId) : null;
      const router = source ? await this.controlDatabase.repository('connection').get(workspaceId, source.connectionId) : null;
      if (!source || !router || source.physicalExecution?.writeGateId !== this.shardedWriteGateId) return { applicable: true, proven: false, sourceLease: lease };
      const [passwordSecretRefId] = router.secretRefIds || [];
      const routerConnection = this.adapter.normalizeConfig({ ...router.endpoint, passwordSecretRefId });
      const coordination = await this.shardedSnapshotCoordinator.reconcile({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }) }, { lease, leaseOwner: expectedOwner, routerConnection });
      let sourceLease = coordination.lease || lease;
      let providersProven = true;
      const components = [];
      for (const component of sourceLease.components || []) {
        const providerLease = component.providerLease;
        if (!providerLease || !['acquiring', 'active'].includes(providerLease.state)) {
          components.push(component);
          continue;
        }
        try {
          const { provider } = this.shardedSnapshotCoordinator.componentSnapshotService.providerRegistry.get(providerLease.providerId);
          const discarded = await provider.discardSnapshot({ snapshotSetId: providerLease.snapshotSetId || null, leaseOwner: expectedOwner, reason: 'process-interrupted', signal: undefined });
          if (discarded?.discarded !== true || discarded.leaseOwner !== expectedOwner) throw new Error('provider cleanup unproven');
          const releasedAt = new Date().toISOString();
          components.push({ ...component, providerLease: { ...providerLease, state: 'discarded', releasedAt, releaseReason: 'process-interrupted', updatedAt: releasedAt } });
        } catch (_error) {
          providersProven = false;
          components.push(component);
        }
      }
      sourceLease = { ...sourceLease, components };
      return { applicable: true, proven: coordination.proven !== false && providersProven, sourceLease };
    } catch (_error) {
      return { applicable: true, proven: false, sourceLease: lease };
    }
  }
}

class MongoDbSourceReaderService extends LogicalDatabaseSourceReaderService {
  constructor(options = {}) {
    const physicalBackupService = options.physicalBackupService || (options.snapshotCoordinator ? new MongoDbPhysicalSnapshotBackupService(options) : null);
    super({
      ...options,
      physicalBackupService,
      profile: {
        adapterId: ADAPTER_ID,
        codePrefix: 'MONGODB',
        label: 'MongoDB',
        engine: 'mongodb',
        manifestKind: 'mongodb-logical-anchor',
        temporaryPrefix: 'deployerx-mongodb-dump',
        emptyToolName: 'mongodump',
        maximumDumpBytes: MAX_MYSQL_DUMP_BYTES,
        binlogManifestKind: 'mongodb-oplog',
        parseAnchorCoordinate: (_bytes, context, prepared, openedMetadata) => {
          const oplog = openedMetadata?.oplog;
          if (!oplog?.start || !oplog?.end) throw new Error('MongoDB oplog anchor evidence is unavailable.');
          return {
            ...oplogCoordinate(oplog.endEntry, {
              capturedAt: context.capturedAt,
              serverIdentityFingerprint: context.serverIdentityFingerprint,
              replicaSetId: prepared.consistency.evidence.metadata?.replicaSetId
            }),
            start: oplog.start,
            end: oplog.end
          };
        }
      }
    });
  }

  async reconcileRun(workspaceId, run) {
    if (!this.physicalBackupService?.reconcile) return { applicable: false, proven: true, sourceLease: run?.sourceLease || null };
    return this.physicalBackupService.reconcile(workspaceId, run);
  }
}

module.exports = { MongoDbPhysicalSnapshotBackupService, MongoDbSourceReaderService };
