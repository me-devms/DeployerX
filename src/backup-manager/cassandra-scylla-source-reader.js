const { ADAPTER_ID } = require('./cassandra-scylla');
const { CassandraScyllaPhysicalBackupService, CassandraScyllaPhysicalError } = require('./cassandra-scylla-physical');

class CassandraScyllaSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CassandraScyllaSourceReaderError';
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

class CassandraScyllaSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, adapterRegistry, adapter, physicalBackupService = null } = {}) {
    if (!controlDatabase || !secretStore || !adapterRegistry || !adapter) throw new TypeError('Cassandra/Scylla source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.physicalBackupService = physicalBackupService || new CassandraScyllaPhysicalBackupService({ controlDatabase, secretStore, deviceId, adapter });
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new CassandraScyllaSourceReaderError('CASSANDRA_SOURCE_UNAVAILABLE', 'The Cassandra/Scylla Source is unavailable.');
    if (source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full' || source.physicalExecution?.engine !== 'cassandra-scylla' || source.physicalExecution?.topology !== 'cluster') throw new CassandraScyllaSourceReaderError('CASSANDRA_SOURCE_INVALID', 'The Cassandra/Scylla Source does not contain a valid physical cluster enrollment.', { category: 'validation' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new CassandraScyllaSourceReaderError('CASSANDRA_SOURCE_CONNECTION_UNHEALTHY', 'Test the Cassandra/Scylla seed connection successfully before backup.', { category: 'connectivity', retryable: true });
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new CassandraScyllaSourceReaderError('CASSANDRA_SOURCE_OTHER_DEVICE', 'The Cassandra/Scylla Source belongs to another device.', { category: 'authorization' });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new CassandraScyllaSourceReaderError('CASSANDRA_EXECUTION_UNAVAILABLE', 'Cassandra/Scylla full snapshot execution is unavailable.', { category: 'compatibility' });
    return { source, connection, manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: source.selector.digest, sourceRevision: source.revision } };
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (!['full', 'incremental', 'native'].includes(options.backupMode)) throw new CassandraScyllaSourceReaderError('CASSANDRA_BACKUP_MODE_UNSUPPORTED', 'Cassandra/Scylla backup supports full, incremental, and enrolled Cassandra commit-log modes only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const baselineRequired = new Set([
        'CASSANDRA_INCREMENTAL_PARENT_INVALID', 'CASSANDRA_INCREMENTAL_ROOT_INVALID', 'CASSANDRA_INCREMENTAL_PARENT_AMBIGUOUS',
        'CASSANDRA_INCREMENTAL_PARENT_MISMATCH', 'CASSANDRA_INCREMENTAL_LINEAGE_INVALID', 'CASSANDRA_INCREMENTAL_CURSOR_INVALID',
        'CASSANDRA_INCREMENTAL_SCOPE_CHANGED', 'CASSANDRA_INCREMENTAL_GAP', 'CASSANDRA_INCREMENTAL_MEDIA_CHANGED', 'CASSANDRA_INCREMENTAL_FORMAT_CHANGED',
        'CASSANDRA_COMMIT_LOG_PARENT_INVALID', 'CASSANDRA_COMMIT_LOG_ROOT_INVALID', 'CASSANDRA_COMMIT_LOG_PARENT_AMBIGUOUS',
        'CASSANDRA_COMMIT_LOG_PARENT_MISMATCH', 'CASSANDRA_COMMIT_LOG_LINEAGE_INVALID', 'CASSANDRA_COMMIT_LOG_CURSOR_INVALID',
        'CASSANDRA_COMMIT_LOG_SCOPE_CHANGED', 'CASSANDRA_COMMIT_LOG_CONFIGURATION_CHANGED', 'CASSANDRA_COMMIT_LOG_GAP',
        'CASSANDRA_COMMIT_LOG_REWRITTEN', 'CASSANDRA_COMMIT_LOG_FORMAT_CHANGED', 'CASSANDRA_COMMIT_LOG_TIME_REGRESSED'
      ]);
      const promise = (async () => {
        try { return await this.physicalBackupService.prepare(tenant, executionId, plan, options); }
        catch (error) {
          if (!['incremental', 'native'].includes(options.backupMode) || options.requestedBackupMode !== options.backupMode || !baselineRequired.has(error?.code)) throw error;
          return this.physicalBackupService.prepare(tenant, executionId, plan, { ...options, backupMode: 'full', baselineReason: error.code });
        }
      })();
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    let prepared;
    try { prepared = await this.preparations.get(key); }
    catch (error) {
      if (error instanceof CassandraScyllaPhysicalError || error?.code) throw new CassandraScyllaSourceReaderError(error.code || 'CASSANDRA_SNAPSHOT_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new CassandraScyllaSourceReaderError('CASSANDRA_SNAPSHOT_FAILED', 'DeployerX could not prepare the Cassandra/Scylla cluster snapshot.', { retryable: true });
    }
    const artifacts = prepared.artifacts || [];
    if (!artifacts.length || artifacts.some((artifact) => !artifact.artifactPath || typeof artifact.content !== 'function')) throw new CassandraScyllaSourceReaderError('CASSANDRA_SNAPSHOT_ARTIFACT_INVALID', 'Cassandra/Scylla snapshot preparation returned an invalid artifact set.', { category: 'integrity' });
    const artifactPaths = artifacts.map((artifact) => artifact.artifactPath);
    const physicalBackupService = this.physicalBackupService;
    return {
      ...plan,
      manifest: {
        ...plan.manifest,
        workloadType: 'database',
        resumable: false,
        consistency: prepared.databaseManifest.consistency,
        database: prepared.databaseManifest,
        artifactPath: null,
        artifactPaths,
        noChange: prepared.databaseManifest.noChange === true,
        sizeBytes: null
      },
      create: async function* createCassandraScyllaFiles() {
        for (const artifact of artifacts) {
          if (artifact.componentId === 'cluster-manifest') await physicalBackupService.seal(prepared, options);
          const nodeManifest = prepared.databaseManifest.nodes?.find((node) => node.hostId === artifact.componentId);
          const databaseMetadata = artifact.componentId === 'cluster-manifest' ? prepared.databaseManifest : {
            version: prepared.databaseManifest.version, kind: prepared.databaseManifest.kind, adapterId: prepared.databaseManifest.adapterId,
            adapterVersion: prepared.databaseManifest.adapterVersion, engine: prepared.databaseManifest.engine, backupMethod: prepared.databaseManifest.backupMethod,
            backupMode: prepared.databaseManifest.backupMode, selectionDigest: prepared.databaseManifest.selectionDigest,
            cluster: prepared.databaseManifest.cluster, source: prepared.databaseManifest.source,
            component: { componentId: artifact.componentId, manifestDigest: nodeManifest?.manifestDigest || (artifact.componentId === 'schema' ? prepared.databaseManifest.schema?.sha256 : null) }
          };
          yield {
          path: artifact.artifactPath,
          type: 'file',
          metadata: { workload: 'database', artifactKind: artifact.artifactKind, database: databaseMetadata, componentId: artifact.componentId },
          content: artifact.content()
          };
        }
      }
    };
  }

  async release(workspaceId, executionId) {
    const key = `${requiredText(workspaceId, 'Workspace ID', 200)}:${requiredText(executionId, 'Backup execution ID', 200)}`;
    const promise = this.preparations.get(key);
    this.preparations.delete(key);
    if (!promise) return false;
    const prepared = await promise.catch(() => null);
    return prepared ? this.physicalBackupService.release(prepared) : false;
  }

  async reconcileRun(workspaceId, run) {
    return this.physicalBackupService.reconcile(workspaceId, run);
  }
}

module.exports = { CassandraScyllaSourceReaderError, CassandraScyllaSourceReaderService };
