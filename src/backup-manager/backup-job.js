const ALLOWED_BACKUP_MODES = new Set(['full', 'incremental', 'differential', 'native']);
const ALLOWED_COMPRESSION = new Set(['none', 'fast', 'balanced', 'maximum']);
const ACTIVE_RUN_STATES = new Set(['queued', 'preparing', 'running', 'verifying']);
const MAX_REPOSITORIES = 8;
const { normalizeExecutionPolicy } = require('./execution-policy');
const { normalizeRetentionPolicy } = require('./retention-policy');
const { nextOccurrence } = require('./schedule');
const { normalizeSchedulePolicy } = require('./schedule-policy');
const { destinationFingerprint: clickHouseDestinationFingerprint } = require('./clickhouse');
const { cockroachDbSourceReadiness } = require('./cockroachdb-source-reader');
const { influxDb3EnterpriseSourceReadiness } = require('./influxdb3-enterprise-source-router');

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is required.`);
  return text;
}

function uniqueIds(input, label) {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError(`Choose at least one ${label}.`);
  const ids = input.map((value) => requiredText(value, `${label} ID`));
  if (ids.length > MAX_REPOSITORIES) throw new TypeError(`A backup job can use at most ${MAX_REPOSITORIES} repositories.`);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} selections must be unique.`);
  return ids;
}

function optionalUniqueIds(input, label, maximum = 20) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new TypeError(`${label} selections are invalid.`);
  const ids = input.map((value) => requiredText(value, `${label} ID`));
  if (ids.length > maximum) throw new TypeError(`A backup job can use at most ${maximum} ${label}s.`);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} selections must be unique.`);
  return ids;
}

function normalizeObjectiveMinutes(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new TypeError(`${label} target must be between 1 minute and 1 year.`);
  return minutes;
}

function normalizeRpoMinutes(value) { return normalizeObjectiveMinutes(value, 'RPO'); }

function normalizeRtoMinutes(value) { return normalizeObjectiveMinutes(value, 'RTO'); }

class BackupJobLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupJobLifecycleError';
    this.code = code;
  }
}

function requiredRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new TypeError('Backup job revision is required.');
  return revision;
}

function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sourceReadiness(source, connection, deviceId, executionConnection = null, componentConnections = []) {
  if (!source.enabled) return { ready: false, reasonCode: 'SOURCE_DISABLED', message: 'The source profile is disabled.' };
  const fileSelection = source.sourceType === 'files' && source.selector?.kind === 'file-paths' && Array.isArray(source.selector?.roots) && source.selector.roots.length > 0;
  const databaseSelection = source.sourceType === 'database' && source.selector?.kind === 'database-objects'
    && (source.selector.allDatabases || source.selector.databases?.include?.length > 0);
  if (!fileSelection && !databaseSelection) return { ready: false, reasonCode: 'SOURCE_SELECTION_MISSING', message: 'The source does not contain a valid saved selection.' };
  if (!connection) return { ready: false, reasonCode: 'CONNECTION_MISSING', message: 'The source connection is unavailable.' };
  if (!(connection.workerAffinity || []).includes(`device:${deviceId}`)) return { ready: false, reasonCode: 'CONNECTION_OTHER_DEVICE', message: 'The source connection belongs to another device.' };
  if (connection.lastTest?.status !== 'success') return { ready: false, reasonCode: 'CONNECTION_UNHEALTHY', message: 'Test the source connection successfully before creating a job.' };
  const physicalEngine = source.physicalExecution?.engine || source.platform?.engine || null;
  const oracleTrust = physicalEngine === 'oracle' && connection.trust?.mode === 'verify-identity';
  if (source.sourceType === 'database' && !connection.trust?.fingerprint && !oracleTrust) return { ready: false, reasonCode: 'DATABASE_IDENTITY_MISSING', message: 'Retest the database connection to capture its server identity.' };
  if (source.consistency?.backupMethod === 'physical') {
    const physicalIdentity = physicalEngine === 'postgresql'
      ? connection.lastTest?.endpointIdentity?.systemIdentifier
      : physicalEngine === 'sqlserver'
        ? connection.lastTest?.endpointIdentity?.instanceFingerprint
        : physicalEngine === 'oracle'
          ? connection.lastTest?.endpointIdentity?.databaseFingerprint
          : physicalEngine === 'mongodb'
            ? connection.lastTest?.endpointIdentity?.deploymentFingerprint
            : physicalEngine === 'cassandra-scylla'
              ? connection.lastTest?.endpointIdentity?.clusterFingerprint || connection.clusterInventory?.clusterFingerprint
              : physicalEngine === 'scylla-manager'
                ? connection.lastTest?.endpointIdentity?.deploymentFingerprint
                : physicalEngine === 'neo4j' || physicalEngine === 'clickhouse' || physicalEngine === 'influxdb' || physicalEngine === 'influxdb3-core' || physicalEngine === 'influxdb3-enterprise' || physicalEngine === 'cockroachdb'
                  ? connection.lastTest?.endpointIdentity?.deploymentFingerprint
                  : connection.lastTest?.endpointIdentity?.serverUuid;
    const physicalLabel = physicalEngine === 'postgresql' ? 'PostgreSQL' : physicalEngine === 'sqlserver' ? 'SQL Server' : physicalEngine === 'oracle' ? 'Oracle' : physicalEngine === 'mongodb' ? 'MongoDB' : physicalEngine === 'cassandra-scylla' ? 'Cassandra/Scylla' : physicalEngine === 'scylla-manager' ? 'ScyllaDB Manager' : physicalEngine === 'neo4j' ? 'Neo4j' : physicalEngine === 'clickhouse' ? 'ClickHouse' : physicalEngine === 'influxdb' ? 'InfluxDB' : physicalEngine === 'influxdb3-core' ? 'InfluxDB 3 Core' : physicalEngine === 'influxdb3-enterprise' ? 'InfluxDB 3 Enterprise' : physicalEngine === 'cockroachdb' ? 'CockroachDB' : 'MySQL';
    if (!physicalIdentity) return { ready: false, reasonCode: 'DATABASE_UUID_MISSING', message: `Retest the ${physicalLabel} connection to capture its server identity.` };
    if (physicalEngine === 'mongodb') {
      if (source.physicalExecution?.topology === 'sharded') {
        if (connection.lastTest?.endpointIdentity?.topology !== 'sharded' || !source.physicalExecution.writeGateId) return { ready: false, reasonCode: 'SHARDED_COORDINATION_MISSING', message: 'Retest the mongos connection and choose an approved application write gate.' };
        if (!source.physicalExecution.components?.length || componentConnections.length !== source.physicalExecution.components.length) return { ready: false, reasonCode: 'SHARDED_COMPONENT_MISSING', message: 'One or more MongoDB sharded component connections are unavailable.' };
        for (let index = 0; index < source.physicalExecution.components.length; index += 1) {
          const component = source.physicalExecution.components[index];
          const componentConnection = componentConnections[index];
          if (!component.providerId) return { ready: false, reasonCode: 'SNAPSHOT_PROVIDER_MISSING', message: `Choose a snapshot provider for MongoDB ${component.componentId}.` };
          if (componentConnection.adapterId !== 'deployerx.database.mongodb.native' || componentConnection.lastTest?.status !== 'success') return { ready: false, reasonCode: 'SHARDED_COMPONENT_UNHEALTHY', message: `Test the MongoDB ${component.componentId} connection successfully before creating a job.` };
          if (!(componentConnection.workerAffinity || []).includes(`device:${deviceId}`)) return { ready: false, reasonCode: 'SHARDED_COMPONENT_OTHER_DEVICE', message: `The MongoDB ${component.componentId} connection belongs to another device.` };
          const identity = componentConnection.lastTest?.endpointIdentity;
          if (componentConnection.trust?.fingerprint !== component.serverIdentityFingerprint || identity?.replicaSetId !== component.expectedReplicaSetId || identity?.setName !== component.expectedSetName || identity?.replicaRole !== component.role || !sameStrings(identity?.members, component.expectedHosts)) return { ready: false, reasonCode: 'SHARDED_COMPONENT_IDENTITY_CHANGED', message: `Retest and re-save the Source because MongoDB ${component.componentId} identity changed.` };
        }
        return { ready: true, reasonCode: null, message: 'Ready' };
      }
      if (!source.physicalExecution?.providerId) return { ready: false, reasonCode: 'SNAPSHOT_PROVIDER_MISSING', message: 'Choose a MongoDB snapshot provider before creating a job.' };
      return { ready: true, reasonCode: null, message: 'Ready' };
    }
    if (physicalEngine === 'cassandra-scylla') {
      const bindings = source.physicalExecution?.nodes || [];
      if (!bindings.length || componentConnections.length !== bindings.length) return { ready: false, reasonCode: 'CASSANDRA_NODE_MISSING', message: 'One or more Cassandra/Scylla node connections are unavailable.' };
      for (let index = 0; index < bindings.length; index += 1) {
        const binding = bindings[index];
        const node = componentConnections[index];
        const inventory = node?.clusterInventory;
        if (!node || node.adapterId !== 'deployerx.database.cassandra-scylla' || node.lastTest?.status !== 'success') return { ready: false, reasonCode: 'CASSANDRA_NODE_UNHEALTHY', message: `Test Cassandra/Scylla node ${binding.hostId} successfully before creating a job.` };
        if (!(node.workerAffinity || []).includes(`device:${deviceId}`)) return { ready: false, reasonCode: 'CASSANDRA_NODE_OTHER_DEVICE', message: `Cassandra/Scylla node ${binding.hostId} belongs to another device.` };
        if (inventory?.localHostId !== binding.hostId || inventory.clusterFingerprint !== source.physicalExecution.clusterFingerprint || inventory.topologyFingerprint !== source.physicalExecution.topologyFingerprint || inventory.coverage?.ringFingerprint !== source.physicalExecution.ringFingerprint || inventory.schemaVersion !== source.physicalExecution.schemaVersion || node.trust?.fingerprint !== binding.serverIdentityFingerprint) return { ready: false, reasonCode: 'CASSANDRA_NODE_IDENTITY_CHANGED', message: `Retest and re-save the Source because Cassandra/Scylla node ${binding.hostId} identity changed.` };
      }
      return { ready: true, reasonCode: null, message: 'Ready' };
    }
    if (physicalEngine === 'scylla-manager') {
      if (connection.adapterId !== 'deployerx.database.scylla-manager' || connection.clusterInventory?.healthy !== true || connection.trust?.fingerprint !== source.physicalExecution?.deploymentFingerprint || connection.managerTargetTrust?.targetFingerprint !== source.physicalExecution?.targetFingerprint || connection.endpoint?.managedClusterId !== source.physicalExecution?.managedClusterId) return { ready: false, reasonCode: 'SCYLLA_MANAGER_TARGET_CHANGED', message: 'Retest and re-save the Source because the Manager cluster health, identity, or verified backup target changed.' };
      return { ready: true, reasonCode: null, message: 'Ready' };
    }
    if (physicalEngine === 'neo4j') {
      if (connection.adapterId !== 'deployerx.database.neo4j' || connection.trust?.fingerprint !== physicalIdentity) return { ready: false, reasonCode: 'NEO4J_SOURCE_IDENTITY_CHANGED', message: 'Retest and re-save the Source because its Neo4j identity changed.' };
      if (source.physicalExecution?.tier === 'enterprise-online') {
        const execution = source.physicalExecution;
        const identity = connection.lastTest?.endpointIdentity;
        const inventory = connection.neo4jInventory;
        const allocations = (inventory?.databases || []).filter((database) => String(database.name).toLowerCase() === execution.databaseName);
        const version = /^(\d+)[.](\d+)/.exec(String(execution.productVersion || ''));
        const expectedPreferDiff = Boolean(version) && (Number(version[1]) > 2025 || (Number(version[1]) === 2025 && Number(version[2]) >= 4));
        if (source.consistency?.method !== 'neo4j-native-backup' || source.consistency?.captureCoordinates !== true || !['full', 'differential'].includes(source.consistency?.backupMode)
          || execution.connectionRevision !== connection.revision || execution.edition !== 'enterprise' || identity?.edition !== 'enterprise'
          || connection.trust?.topologyFingerprint !== execution.topologyFingerprint || identity?.topologyFingerprint !== execution.topologyFingerprint
          || identity?.deploymentFingerprint !== execution.deploymentFingerprint || inventory?.deploymentFingerprint !== execution.deploymentFingerprint || inventory?.topologyFingerprint !== execution.topologyFingerprint
          || execution.databaseId !== [...new Set(allocations.map((database) => database.databaseId))][0] || allocations.some((database) => database.currentStatus !== 'online' || database.requestedStatus !== 'online')
          || allocations.filter((database) => database.writer).length !== 1 || !Array.isArray(execution.backupAddresses) || !execution.backupAddresses.length
          || execution.metadataPolicy !== (source.selector?.includeGlobalObjects ? 'all' : 'none') || execution.compression !== true || execution.preferDiffAsParent !== expectedPreferDiff) return { ready: false, reasonCode: 'NEO4J_SOURCE_IDENTITY_CHANGED', message: 'Retest and re-save the Source because its Neo4j Enterprise online backup identity, topology, or policy changed.' };
      } else if (source.consistency?.method !== 'offline' || source.consistency?.backupMode !== 'full' || source.consistency?.captureCoordinates) return { ready: false, reasonCode: 'NEO4J_SOURCE_IDENTITY_CHANGED', message: 'Retest and re-save the Source because its Neo4j offline backup policy changed.' };
      return { ready: true, reasonCode: null, message: 'Ready' };
    }
    if (physicalEngine === 'clickhouse') {
      const execution = source.physicalExecution;
      const identity = connection.lastTest?.endpointIdentity;
      const inventory = connection.clickhouseInventory;
      const destinationTrust = connection.clickhouseDestinationTrust;
      const disk = (inventory?.disks || []).find((item) => item.name === execution?.diskName);
      if (connection.adapterId !== 'deployerx.database.clickhouse' || connection.trust?.fingerprint !== physicalIdentity || connection.trust?.topologyFingerprint !== identity?.topologyFingerprint
        || execution?.connectionRevision !== connection.revision || execution?.deploymentFingerprint !== physicalIdentity || execution?.topologyFingerprint !== identity?.topologyFingerprint
        || inventory?.deploymentFingerprint !== physicalIdentity || inventory?.topologyFingerprint !== identity?.topologyFingerprint || (inventory?.clusters || []).length || (inventory?.replicas || []).length
        || !['auto', 'clickhouse-native-backup'].includes(source.consistency?.method) || source.consistency?.backupMode !== 'full' || source.consistency?.captureCoordinates !== true
        || destinationTrust?.diskName !== execution?.diskName || destinationTrust?.destinationFingerprint !== execution?.destinationFingerprint || destinationTrust?.deploymentFingerprint !== physicalIdentity || destinationTrust?.topologyFingerprint !== identity?.topologyFingerprint
        || !disk || disk.readOnly || disk.writeOnce || clickHouseDestinationFingerprint(disk) !== execution?.destinationFingerprint) return { ready: false, reasonCode: 'CLICKHOUSE_SOURCE_IDENTITY_CHANGED', message: 'Retest and re-save the Source because its ClickHouse identity, topology, or approved backup disk changed.' };
      return { ready: true, reasonCode: null, message: 'Ready' };
    }
    if (physicalEngine === 'influxdb') {
      const execution = source.physicalExecution;
      const identity = connection.lastTest?.endpointIdentity;
      const inventory = connection.influxdbInventory;
      const organization = (inventory?.organizations || []).find((item) => item.id === execution?.organizationId && item.name === execution?.organizationName && item.selectable === true);
      const bucket = execution?.scope === 'bucket' ? (inventory?.buckets || []).find((item) => item.id === execution?.bucketId && item.organizationId === execution?.organizationId && item.name === execution?.bucketName && item.selectable === true) : true;
      if (connection.adapterId !== 'deployerx.database.influxdb' || connection.trust?.fingerprint !== physicalIdentity || execution?.connectionRevision !== connection.revision
        || execution?.deploymentFingerprint !== physicalIdentity || execution?.inventoryFingerprint !== identity?.inventoryFingerprint || inventory?.deploymentFingerprint !== physicalIdentity || inventory?.inventoryFingerprint !== identity?.inventoryFingerprint
        || !organization || !bucket || !['auto', 'influxdb-v2-native-backup'].includes(source.consistency?.method) || source.consistency?.backupMode !== 'full' || source.consistency?.captureCoordinates !== true) return { ready: false, reasonCode: 'INFLUXDB_SOURCE_IDENTITY_CHANGED', message: 'Retest and re-save the Source because its InfluxDB organization, bucket, deployment, or inventory identity changed.' };
      return { ready: true, reasonCode: null, message: 'Ready' };
    }
    if (physicalEngine === 'influxdb3-core') {
      const execution = source.physicalExecution;
      const identity = connection.lastTest?.endpointIdentity;
      const inventory = connection.influxdb3CoreInventory;
      const inventoryNode = (inventory?.nodes || []).find((item) => item.id === execution?.nodeId && item.selectable === true);
      const requiredLevel = execution?.consistencyMode === 'ordered-live-copy' ? 'crash' : 'application';
      if (connection.adapterId !== 'deployerx.database.influxdb3-core' || connection.trust?.fingerprint !== physicalIdentity || connection.trust?.storageFingerprint !== execution?.storageFingerprint
        || execution?.connectionRevision !== connection.revision || execution?.deploymentFingerprint !== physicalIdentity || identity?.storageFingerprint !== execution?.storageFingerprint
        || inventory?.deploymentFingerprint !== physicalIdentity || inventory?.storageFingerprint !== execution?.storageFingerprint || identity?.nodeId !== execution?.nodeId || !['file', 's3', 'azure', 'google'].includes(execution?.objectStore)
        || identity?.objectStore !== execution.objectStore || connection.trust?.objectStore !== execution.objectStore || inventoryNode?.objectStore !== execution.objectStore
        || source.selector?.allDatabases !== true || source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full' || source.consistency?.requestedLevel !== requiredLevel
        || !['auto', execution?.consistencyMethod].includes(source.consistency?.method) || source.consistency?.captureCoordinates !== false) return { ready: false, reasonCode: 'INFLUXDB3_CORE_SOURCE_IDENTITY_CHANGED', message: 'Retest and re-save the Source because its InfluxDB 3 Core endpoint, node, object store, or consistency proof changed.' };
      return { ready: true, reasonCode: null, message: 'Ready' };
    }
    if (physicalEngine === 'influxdb3-enterprise') return influxDb3EnterpriseSourceReadiness(source, connection, deviceId);
    if (physicalEngine === 'cockroachdb') return cockroachDbSourceReadiness(source, connection, deviceId);
    if (!executionConnection || executionConnection.adapterId !== 'deployerx.connection.ssh') return { ready: false, reasonCode: 'PHYSICAL_SSH_MISSING', message: 'The physical backup SSH execution connection is unavailable.' };
    if (!(executionConnection.workerAffinity || []).includes(`device:${deviceId}`)) return { ready: false, reasonCode: 'PHYSICAL_SSH_OTHER_DEVICE', message: 'The physical backup SSH connection belongs to another device.' };
    if (executionConnection.lastTest?.status !== 'success') return { ready: false, reasonCode: 'PHYSICAL_SSH_UNHEALTHY', message: 'Test the physical backup SSH connection successfully before creating a job.' };
  }
  return { ready: true, reasonCode: null, message: 'Ready' };
}

function repositoryReadiness(repository, deviceId) {
  if (!(repository.workerAffinity || []).includes(`device:${deviceId}`)) return { ready: false, reasonCode: 'REPOSITORY_OTHER_DEVICE', message: 'The repository belongs to another device.' };
  if (repository.health?.status !== 'ready') return { ready: false, reasonCode: 'REPOSITORY_UNHEALTHY', message: 'Test the repository successfully before creating a job.' };
  if (repository.health?.lockState?.status === 'unavailable') return { ready: false, reasonCode: 'REPOSITORY_LOCKING_UNAVAILABLE', message: 'Repository locking is unavailable.' };
  return { ready: true, reasonCode: null, message: repository.health?.lockState?.status === 'contended' ? 'Ready; currently busy' : 'Ready' };
}

function databaseSelectionSummary(selector = {}) {
  const tableCount = selector.tables?.include?.length || 0;
  if (tableCount) return { objectCount: tableCount, objectKind: 'table' };
  const schemaCount = selector.schemas?.include?.length || 0;
  if (schemaCount) return { objectCount: schemaCount, objectKind: 'schema' };
  return { objectCount: selector.databases?.include?.length || 0, objectKind: 'database' };
}

function sourceSummary(source, connection, deviceId, executionConnection = null, componentConnections = []) {
  const databaseSelection = source.sourceType === 'database' ? databaseSelectionSummary(source.selector) : { objectCount: 0, objectKind: null };
  return {
    id: source.id,
    name: source.name,
    revision: source.revision,
    sourceType: source.sourceType,
    adapterId: source.adapterId,
    connectionId: source.connectionId,
    connectionName: connection?.name || 'Unavailable connection',
    connectionKind: connection?.kind || null,
    rootCount: source.selector?.roots?.length || 0,
    objectCount: databaseSelection.objectCount,
    objectKind: databaseSelection.objectKind,
    selection: source.selector || null,
    requestedConsistency: source.consistency || null,
    physicalExecution: source.physicalExecution || null,
    executionConnectionName: executionConnection?.name || null,
    readiness: sourceReadiness(source, connection, deviceId, executionConnection, componentConnections)
  };
}

function repositorySummary(repository, deviceId) {
  return {
    id: repository.id,
    name: repository.name,
    revision: repository.revision,
    adapterId: repository.adapterId,
    adapterVersion: repository.adapterVersion,
    engineId: repository.engineId,
    engineVersion: repository.engineVersion,
    location: repository.location,
    capacity: repository.capacity,
    immutability: repository.immutability,
    health: repository.health,
    readiness: repositoryReadiness(repository, deviceId)
  };
}

class BackupJobService {
  constructor({ controlDatabase, deviceId, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase) throw new TypeError('Control database is required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID');
    this.clock = clock;
  }

  async readiness(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const [sources, connections, repositories] = await Promise.all([
      this.controlDatabase.repository('source').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('connection').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('repository').list(tenant, { limit: 1000 })
    ]);
    const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
    return {
      checkedAt: this.clock(),
      sources: sources.filter((source) => ['files', 'database'].includes(source.sourceType)).map((source) => sourceSummary(
        source,
        connectionById.get(source.connectionId),
        this.deviceId,
        connectionById.get(source.physicalExecution?.sshConnectionId),
        [...(source.physicalExecution?.components || []), ...(source.physicalExecution?.nodes || [])].map((component) => connectionById.get(component.connectionId)).filter(Boolean)
      )),
      repositories: repositories.map((repository) => repositorySummary(repository, this.deviceId))
    };
  }

  async list(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const [jobs, policies, readiness] = await Promise.all([
      this.controlDatabase.repository('backupJob').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('policy').list(tenant, { limit: 1000 }),
      this.readiness(tenant)
    ]);
    const sources = new Map(readiness.sources.map((source) => [source.id, source]));
    const repositories = new Map(readiness.repositories.map((repository) => [repository.id, repository]));
    const policiesById = new Map(policies.map((policy) => [policy.id, policy]));
    return jobs.map((job) => ({
      ...job,
      source: sources.get(job.sourceId) || null,
      policy: policiesById.get(job.policyId) || null,
      repositories: (job.repositoryBindings || []).map((binding) => ({ ...binding, repository: repositories.get(binding.repositoryId) || null })),
      ready: Boolean(sources.get(job.sourceId)?.readiness.ready) && (job.repositoryBindings || []).every((binding) => repositories.get(binding.repositoryId)?.readiness.ready)
    }));
  }

  async pause(workspaceId, actorId, jobId, revision) {
    return this.#transitionState(workspaceId, actorId, jobId, revision, ['enabled'], 'paused', 'pausedAt');
  }

  async resume(workspaceId, actorId, jobId, revision) {
    return this.#transitionState(workspaceId, actorId, jobId, revision, ['paused'], 'enabled', 'resumedAt');
  }

  async disable(workspaceId, actorId, jobId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const id = requiredText(jobId, 'Backup job ID');
    const expectedRevision = requiredRevision(revision);
    return this.controlDatabase.transaction((transaction) => {
      const job = transaction.get('backupJob', tenant, id);
      if (!job) throw new BackupJobLifecycleError('BACKUP_JOB_NOT_FOUND', 'The backup job was not found.');
      if (job.revision !== expectedRevision) throw new BackupJobLifecycleError('BACKUP_JOB_REVISION_CONFLICT', 'The backup job changed. Refresh and try again.');
      if (!['enabled', 'paused'].includes(job.state)) throw new BackupJobLifecycleError('BACKUP_JOB_NOT_DISABLEABLE', 'Only an enabled or paused backup job can be disabled.');
      const active = transaction.list('run', tenant, { limit: 1000 }).find((run) => run.jobId === id && ACTIVE_RUN_STATES.has(run.state));
      if (active) throw new BackupJobLifecycleError('BACKUP_JOB_ACTIVE_RUN', 'Cancel or finish the active backup before disabling this job.');
      return transaction.update('backupJob', tenant, id, {
        state: 'disabled',
        lifecycle: { ...(job.lifecycle || {}), disabledAt: this.clock(), disabledBy: actor }
      }, { expectedRevision, actorId: actor });
    });
  }

  async clone(workspaceId, actorId, jobId, revision, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const id = requiredText(jobId, 'Backup job ID');
    const expectedRevision = requiredRevision(revision);
    const [job, policies, jobs] = await Promise.all([
      this.controlDatabase.repository('backupJob').get(tenant, id),
      this.controlDatabase.repository('policy').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('backupJob').list(tenant, { limit: 1000 })
    ]);
    if (!job) throw new BackupJobLifecycleError('BACKUP_JOB_NOT_FOUND', 'The backup job was not found.');
    if (job.revision !== expectedRevision) throw new BackupJobLifecycleError('BACKUP_JOB_REVISION_CONFLICT', 'The backup job changed. Refresh and try again.');
    const policy = policies.find((candidate) => candidate.id === job.policyId);
    if (!policy) throw new BackupJobLifecycleError('BACKUP_JOB_POLICY_MISSING', 'The backup job policy is unavailable.');
    const existingNames = new Set(jobs.map((candidate) => candidate.name.toLocaleLowerCase('en-US')));
    let name = input.name === undefined || input.name === null || input.name === '' ? `${job.name} copy` : requiredText(input.name, 'Backup job name');
    if (!input.name) {
      const base = name;
      let suffix = 2;
      while (existingNames.has(name.toLocaleLowerCase('en-US'))) name = `${base} ${suffix++}`;
    }
    return this.create(tenant, actor, {
      name,
      sourceId: job.sourceId,
      repositoryIds: (job.repositoryBindings || []).map((binding) => binding.repositoryId),
      notificationRouteIds: policy.notificationRouteIds || [],
      rpoMinutes: policy.objectives?.rpoMinutes,
      rtoMinutes: policy.objectives?.rtoMinutes,
      backupMode: policy.backupMode,
      maximumIncrementalChainLength: job.adapterSettings?.cassandraIncremental?.maximumChainLength,
      maximumCommitLogChainLength: job.adapterSettings?.cassandraCommitLog?.maximumChainLength,
      compression: policy.performance?.compression,
      verifyAfterBackup: policy.verification?.checksum,
      schedule: policy.schedule,
      retention: policy.retention,
      executionPolicy: {
        priority: policy.performance?.priority,
        retry: policy.retry,
        bandwidth: policy.performance?.bandwidth
      }
    }, { cloneSource: { id, revision: expectedRevision } });
  }

  async delete(workspaceId, actorId, jobId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const id = requiredText(jobId, 'Backup job ID');
    const expectedRevision = requiredRevision(revision);
    return this.controlDatabase.transaction((transaction) => {
      const job = transaction.get('backupJob', tenant, id);
      if (!job) throw new BackupJobLifecycleError('BACKUP_JOB_NOT_FOUND', 'The backup job was not found.');
      if (job.revision !== expectedRevision) throw new BackupJobLifecycleError('BACKUP_JOB_REVISION_CONFLICT', 'The backup job changed. Refresh and try again.');
      if (job.state !== 'disabled') throw new BackupJobLifecycleError('BACKUP_JOB_NOT_DELETABLE', 'Disable the backup job before deleting it.');
      const active = transaction.list('run', tenant, { limit: 1000 }).find((run) => run.jobId === id && ACTIVE_RUN_STATES.has(run.state));
      if (active) throw new BackupJobLifecycleError('BACKUP_JOB_ACTIVE_RUN', 'Cancel or finish the active backup before deleting this job.');
      transaction.softDelete('backupJob', tenant, id, { expectedRevision, actorId: actor });
      const policyStillUsed = transaction.list('backupJob', tenant, { limit: 1000 }).some((candidate) => candidate.policyId === job.policyId);
      const policy = transaction.get('policy', tenant, job.policyId);
      let policyDeleted = false;
      if (policy && !policyStillUsed) {
        const detachedPolicy = (policy.notificationRouteIds || []).length
          ? transaction.update('policy', tenant, policy.id, { enabled: false, notificationRouteIds: [] }, { expectedRevision: policy.revision, actorId: actor })
          : policy;
        transaction.softDelete('policy', tenant, detachedPolicy.id, { expectedRevision: detachedPolicy.revision, actorId: actor });
        policyDeleted = true;
      }
      return { id, policyId: job.policyId, deleted: true, policyDeleted };
    });
  }

  async #transitionState(workspaceId, actorId, jobId, revision, allowedStates, nextState, timestampField) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const id = requiredText(jobId, 'Backup job ID');
    const expectedRevision = requiredRevision(revision);
    return this.controlDatabase.transaction((transaction) => {
      const job = transaction.get('backupJob', tenant, id);
      if (!job) throw new BackupJobLifecycleError('BACKUP_JOB_NOT_FOUND', 'The backup job was not found.');
      if (job.revision !== expectedRevision) throw new BackupJobLifecycleError('BACKUP_JOB_REVISION_CONFLICT', 'The backup job changed. Refresh and try again.');
      if (!allowedStates.includes(job.state)) throw new BackupJobLifecycleError('BACKUP_JOB_STATE_INVALID', `The backup job cannot move from ${job.state} to ${nextState}.`);
      return transaction.update('backupJob', tenant, id, {
        state: nextState,
        lifecycle: { ...(job.lifecycle || {}), [timestampField]: this.clock(), [`${timestampField.slice(0, -2)}By`]: actor }
      }, { expectedRevision, actorId: actor });
    });
  }

  async create(workspaceId, actorId, input = {}, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId, 'Actor ID');
    const name = requiredText(input.name, 'Backup job name');
    const sourceId = requiredText(input.sourceId, 'Source ID');
    const repositoryIds = uniqueIds(input.repositoryIds, 'repository');
    const notificationRouteIds = optionalUniqueIds(input.notificationRouteIds, 'notification route');
    const rpoMinutes = normalizeRpoMinutes(input.rpoMinutes);
    const rtoMinutes = normalizeRtoMinutes(input.rtoMinutes);
    const backupMode = String(input.backupMode || 'incremental');
    if (!ALLOWED_BACKUP_MODES.has(backupMode)) throw new TypeError('Choose a supported backup mode.');
    const maximumIncrementalChainLength = Number(input.maximumIncrementalChainLength ?? 30);
    if (!Number.isInteger(maximumIncrementalChainLength) || maximumIncrementalChainLength < 1 || maximumIncrementalChainLength > 1000) throw new TypeError('Maximum incremental chain length must be between 1 and 1000.');
    const maximumCommitLogChainLength = Number(input.maximumCommitLogChainLength ?? 1440);
    if (!Number.isInteger(maximumCommitLogChainLength) || maximumCommitLogChainLength < 1 || maximumCommitLogChainLength > 10000) throw new TypeError('Maximum commit-log chain length must be between 1 and 10000.');
    const compression = String(input.compression || 'balanced');
    if (!ALLOWED_COMPRESSION.has(compression)) throw new TypeError('Choose a supported compression mode.');
    const createdAt = this.clock();
    const schedule = normalizeSchedulePolicy(input.schedule || { type: 'manual' }, { now: createdAt });
    const retention = normalizeRetentionPolicy(input.retention || {
      timezone: schedule.timezone,
      keepLast: input.keepLast,
      hourly: input.keepHourly,
      daily: input.keepDaily,
      weekly: input.keepWeekly,
      monthly: input.keepMonthly,
      yearly: input.keepYearly
    }, { timezone: schedule.timezone });
    const executionPolicy = normalizeExecutionPolicy(input.executionPolicy || {
      priority: input.priority,
      retry: input.retry || {
        maximumAttempts: input.maximumRetryAttempts,
        backoff: input.retryBackoff,
        initialDelaySeconds: input.retryInitialDelaySeconds,
        maximumDelaySeconds: input.retryMaximumDelaySeconds,
        jitterPercent: input.retryJitterPercent,
        retryableCategories: input.retryableCategories
      },
      bandwidth: input.bandwidth || {
        timezone: input.bandwidthTimezone || schedule.timezone,
        defaultLimitBytesPerSecond: input.bandwidthLimitBytesPerSecond,
        windows: input.bandwidthWindows
      }
    }, { timezone: schedule.timezone });
    const nextRunAt = nextOccurrence(schedule, createdAt);

    const [readiness, notificationRoutes] = await Promise.all([
      this.readiness(tenant),
      this.controlDatabase.repository('notificationRoute').list(tenant, { limit: 1000 })
    ]);
    const source = readiness.sources.find((candidate) => candidate.id === sourceId);
    if (!source) throw new Error('Backup source was not found in this workspace.');
    if (!source.readiness.ready) throw new Error(source.readiness.message);
    if (source.sourceType === 'database' && backupMode === 'incremental') {
      const physical = source.requestedConsistency?.backupMethod === 'physical';
      if (physical) {
        const supportedWholePhysical = ['deployerx.database.mysql.logical', 'deployerx.database.postgresql.logical'].includes(source.adapterId) && source.selection?.allDatabases === true;
        const selectedDatabasePhysical = ['deployerx.database.sqlserver.native', 'deployerx.database.oracle.rman'].includes(source.adapterId) && source.selection?.allDatabases === false && source.selection?.databases?.include?.length === 1;
        const cassandraPhysical = source.adapterId === 'deployerx.database.cassandra-scylla' && source.physicalExecution?.topology === 'cluster' && source.physicalExecution?.incrementalBackupsEnabled === true && source.physicalExecution.nodes?.every((node) => node.incrementalBackupsEnabled === true);
        const clickHousePhysical = source.adapterId === 'deployerx.database.clickhouse' && source.selection?.allDatabases === false && source.selection?.databases?.include?.length === 1 && source.physicalExecution?.destinationType === 'disk' && source.physicalExecution?.destinationFingerprint;
        const cockroachDbPhysical = source.adapterId === 'deployerx.database.cockroachdb' && source.physicalExecution?.engine === 'cockroachdb' && ['cluster', 'database', 'table'].includes(source.physicalExecution?.selection?.scope) && source.physicalExecution?.destination?.destinationFingerprint;
        if (!supportedWholePhysical && !selectedDatabasePhysical && !cassandraPhysical && !clickHousePhysical && !cockroachDbPhysical) throw new TypeError('Incremental physical jobs require a supported physical Source with an unambiguous recovery chain and enabled incremental capture.');
        if (source.adapterId === 'deployerx.database.oracle.rman' && source.physicalExecution?.anchorMode === 'full') throw new TypeError('Oracle level-1 jobs require a Source configured to create incremental level-0 anchors.');
      } else {
        const mongoDbPitr = source.adapterId === 'deployerx.database.mongodb.native';
        const pitrAdapter = source.adapterId === 'deployerx.database.mysql.logical' || source.adapterId === 'deployerx.database.mariadb.logical' || mongoDbPitr;
        const selector = source.selection || {};
        const unfiltered = !(selector.databases?.exclude?.length || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.include?.length || selector.tables?.exclude?.length || selector.includeGlobalObjects);
        const wholeDatabase = mongoDbPitr ? selector.allDatabases === true && unfiltered : !selector.allDatabases && selector.databases?.include?.length === 1 && unfiltered;
        if (!pitrAdapter || source.requestedConsistency?.captureCoordinates !== true || !wholeDatabase) throw new TypeError('Incremental database jobs require a PITR-enabled source covering one whole database or deployment and supported by the selected adapter.');
      }
    }
    if (source.sourceType === 'database' && backupMode === 'differential') {
      const neo4jOnline = source.adapterId === 'deployerx.database.neo4j' && source.physicalExecution?.tier === 'enterprise-online' && source.physicalExecution?.preferDiffAsParent === true && source.requestedConsistency?.method === 'neo4j-native-backup' && source.requestedConsistency?.captureCoordinates === true;
      if ((!['deployerx.database.sqlserver.native', 'deployerx.database.oracle.rman'].includes(source.adapterId) && !neo4jOnline) || source.requestedConsistency?.backupMethod !== 'physical' || source.selection?.allDatabases || source.selection?.databases?.include?.length !== 1) throw new TypeError('Differential jobs require a supported native Source with exactly one selected database.');
      if (source.adapterId === 'deployerx.database.oracle.rman' && source.physicalExecution?.anchorMode === 'full') throw new TypeError('Oracle level-1 cumulative jobs require a Source configured to create incremental level-0 anchors.');
    }
    if (source.sourceType === 'database' && backupMode === 'native') {
      const oracleRedo = source.adapterId === 'deployerx.database.oracle.rman' && source.requestedConsistency?.backupMethod === 'physical' && !source.selection?.allDatabases && source.selection?.databases?.include?.length === 1;
      const searchSnapshot = source.adapterId === 'deployerx.database.search.snapshot' && source.requestedConsistency?.backupMethod === 'physical' && source.requestedConsistency?.method === 'search-native-snapshot' && source.requestedConsistency?.captureCoordinates === true && (source.selection?.allDatabases || source.selection?.databases?.include?.length);
      const cassandraCommitLog = source.adapterId === 'deployerx.database.cassandra-scylla' && source.requestedConsistency?.backupMethod === 'physical' && source.physicalExecution?.product === 'cassandra' && source.physicalExecution?.commitLogPitrEnabled === true && source.physicalExecution.nodes?.every((node) => Boolean(node.commitLogArchive));
      const scyllaManager = source.adapterId === 'deployerx.database.scylla-manager' && source.requestedConsistency?.backupMethod === 'physical' && source.requestedConsistency?.method === 'scylla-manager-backup' && source.requestedConsistency?.captureCoordinates === true && source.physicalExecution?.targetFingerprint;
      if (!oracleRedo && !searchSnapshot && !cassandraCommitLog && !scyllaManager) throw new TypeError('Native jobs require an Oracle archived-redo Source, Cassandra commit-log PITR Source, Elasticsearch/OpenSearch native snapshot Source, or ScyllaDB Manager Source.');
    }
    const selectedRepositories = repositoryIds.map((id) => readiness.repositories.find((candidate) => candidate.id === id));
    if (selectedRepositories.some((repository) => !repository)) throw new Error('A selected repository was not found in this workspace.');
    const unavailable = selectedRepositories.find((repository) => !repository.readiness.ready);
    if (unavailable) throw new Error(`${unavailable.name}: ${unavailable.readiness.message}`);
    const selectedRoutes = notificationRouteIds.map((id) => notificationRoutes.find((route) => route.id === id));
    if (selectedRoutes.some((route) => !route)) throw new Error('A selected notification route was not found in this workspace.');
    if (selectedRoutes.some((route) => !route.enabled)) throw new Error('Disabled notification routes cannot be assigned to a new backup job.');

    return this.controlDatabase.transaction((transaction) => {
      if (options.cloneSource) {
        const cloneSource = transaction.get('backupJob', tenant, options.cloneSource.id);
        if (!cloneSource || cloneSource.revision !== options.cloneSource.revision) {
          throw new BackupJobLifecycleError('BACKUP_JOB_REVISION_CONFLICT', 'The backup job changed. Refresh and try again.');
        }
      }
      const duplicateJob = transaction.list('backupJob', tenant, { limit: 1000 }).find((job) => job.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
      if (duplicateJob) throw new TypeError('A backup job with this name already exists.');
      const policyNameBase = `${name} policy`;
      const policyNames = new Set(transaction.list('policy', tenant, { limit: 1000 }).map((policy) => policy.name.toLocaleLowerCase('en-US')));
      let policyName = policyNameBase;
      let suffix = 2;
      while (policyNames.has(policyName.toLocaleLowerCase('en-US'))) policyName = `${policyNameBase} ${suffix++}`;
      const policy = transaction.create('policy', {
        workspaceId: tenant,
        actorId: actor,
        name: policyName,
        enabled: true,
        schedule,
        backupMode,
        retention,
        verification: { checksum: input.verifyAfterBackup !== false, sampleRestore: false, fullRecoveryTest: false, timeoutSeconds: 3600 },
        performance: {
          concurrency: 2,
          bandwidthLimitBytesPerSecond: executionPolicy.bandwidth.defaultLimitBytesPerSecond,
          bandwidth: executionPolicy.bandwidth,
          priority: executionPolicy.priority,
          compression
        },
        retry: executionPolicy.retry,
        hooks: { preBackup: [], postBackup: [] },
        objectives: { rpoMinutes, rtoMinutes },
        notificationRouteIds
      });
      const repositoryBindings = selectedRepositories.map((repository, index) => ({
        repositoryId: repository.id,
        role: index === 0 ? 'primary' : 'copy',
        order: index,
        adapterId: repository.adapterId,
        adapterVersion: repository.adapterVersion,
        engineId: repository.engineId,
        engineVersion: repository.engineVersion,
        repositoryRevision: repository.revision,
        requirements: { encryption: true, locking: true, immutableObjects: true }
      }));
      const job = transaction.create('backupJob', {
        workspaceId: tenant,
        actorId: actor,
        name,
        sourceId,
        policyId: policy.id,
        repositoryBindings,
        selection: structuredClone(source.selection),
        consistency: source.sourceType === 'database'
          ? { level: source.requestedConsistency?.requestedLevel || 'application', method: source.requestedConsistency?.method || 'auto', quiesce: false, preHookRequired: false, postHookRequired: false }
          : { level: 'filesystem', snapshot: 'none', quiesce: false, preHookRequired: false, postHookRequired: false },
        adapterSettings: {
          sourceAdapterId: source.adapterId,
          sourceRevision: source.revision,
          metadataPolicy: structuredClone(source.selection?.metadataPolicy || null),
          databaseConsistency: structuredClone(source.requestedConsistency || null),
          cassandraIncremental: source.adapterId === 'deployerx.database.cassandra-scylla' && backupMode === 'incremental' ? { maximumChainLength: maximumIncrementalChainLength } : null,
          cassandraCommitLog: source.adapterId === 'deployerx.database.cassandra-scylla' && backupMode === 'native' ? { maximumChainLength: maximumCommitLogChainLength } : null,
          compression
        },
        workerId: null,
        workerAffinity: [`device:${this.deviceId}`],
        state: 'enabled',
        nextRunAt,
        lastSuccessfulRunId: null,
        lastRecoveryPointId: null,
        scheduleState: { calculatedAt: createdAt, lastScheduledFor: null, lastDispatchedAt: null, lastRunId: null, lastDispatchError: null, nextDispatchAttemptAt: null },
        readinessSnapshot: { checkedAt: readiness.checkedAt, sourceReady: true, repositoryIds: repositoryIds.slice() }
      });
      return { job, policy };
    });
  }
}

module.exports = {
  ACTIVE_RUN_STATES,
  ALLOWED_BACKUP_MODES,
  ALLOWED_COMPRESSION,
  BackupJobLifecycleError,
  BackupJobService,
  MAX_REPOSITORIES,
  normalizeObjectiveMinutes,
  normalizeRpoMinutes,
  normalizeRtoMinutes,
  requiredRevision,
  repositoryReadiness,
  sourceReadiness
};
