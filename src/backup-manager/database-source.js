const {
  DatabaseAdapterRegistry,
  assertSecretRefOnlyCredentials,
  digestJson,
  normalizeConsistencyRequest,
  normalizeDatabaseSelector,
  publicDatabaseEndpoint
} = require('./database-adapter');
const { normalizeCommitLogArchiveEnrollment } = require('./cassandra-commit-log');
const { normalizeBackupExecution: normalizeScyllaManagerExecution, taskProperties: scyllaManagerTaskProperties } = require('./scylla-manager');
const { normalizeOnlineExecution: normalizeNeo4jOnlineExecution, supportsPreferDiffAsParent: neo4jSupportsPreferDiff } = require('./neo4j');
const { SUPPORTED_TABLE_ENGINES: CLICKHOUSE_TABLE_ENGINES, destinationFingerprint: clickHouseDestinationFingerprint, normalizeBackupExecution: normalizeClickHouseBackupExecution } = require('./clickhouse');
const { normalizeBackupExecution: normalizeInfluxDbBackupExecution } = require('./influxdb');
const { CONSISTENCY_METHODS: INFLUXDB3_CORE_CONSISTENCY_METHODS, normalizeBackupExecution: normalizeInfluxDb3CoreBackupExecution } = require('./influxdb3-core');
const { NATIVE_CONSISTENCY_METHOD: INFLUXDB3_ENTERPRISE_NATIVE_METHOD, normalizeNativeBackupExecution: normalizeInfluxDb3EnterpriseNativeExecution } = require('./influxdb3-enterprise');
const { inspectLegacyClusterLayout } = require('./influxdb3-enterprise-legacy');
const {
  exactLegacyConsistency: exactInfluxDb3EnterpriseLegacyConsistency,
  exactWholeClusterSelector: exactInfluxDb3EnterpriseSelector,
  normalizeLegacySourceExecution: normalizeInfluxDb3EnterpriseLegacyExecution,
  normalizeLegacySourceStorage: normalizeInfluxDb3EnterpriseLegacyStorage
} = require('./influxdb3-enterprise-legacy-source-reader');
const { admitCockroachDbSource } = require('./cockroachdb-source-reader');

function requiredText(value, label, maximumLength = 512) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalAbsoluteLinuxPath(value, label, fallback) {
  const text = requiredText(value || fallback, label, 4096);
  if (!text.startsWith('/') || text.includes('//') || text.split('/').includes('..')) throw new TypeError(`${label} must be a canonical absolute Linux path.`);
  return text.length > 1 ? text.replace(/\/$/, '') : text;
}

function executableName(value, label, fallback) {
  const text = requiredText(value || fallback, label, 512);
  if (!/^(?:\/[A-Za-z0-9._+/-]+|[A-Za-z0-9._+-]+)$/.test(text) || text.includes('..')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function expectedExecutableName(value, label, fallback, expected) {
  const executable = executableName(value, label, fallback);
  if (executable.split('/').at(-1) !== expected) throw new TypeError(`${label} must resolve to ${expected}.`);
  return executable;
}

function serviceIdentity(value, label, fallback) {
  const text = requiredText(value || fallback, label, 128);
  if (!/^[A-Za-z0-9_.@+-]+$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionValue(value, label, fallback, allowed) {
  const option = String(value || fallback);
  if (!allowed.includes(option)) throw new TypeError(`${label} is invalid.`);
  return option;
}

const SUPABASE_ENDPOINT_MODES = new Set(['direct', 'session-pooler', 'transaction-pooler']);

function sourceAdmissionError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function supabaseEndpointContext(connection, manifest) {
  if (manifest.engine !== 'postgresql' || connection.endpoint?.deploymentProfile !== 'supabase') return null;
  return Object.freeze({
    deploymentProfile: 'supabase',
    connectionMode: String(connection.endpoint.connectionMode || connection.endpoint.supabaseEndpointMode || 'direct').trim().toLowerCase(),
    projectRef: String(connection.endpoint.projectRef || '').trim().toLowerCase()
  });
}

function admitSupabaseSource({ connection, selector, consistency, physicalExecution, context }) {
  if (!SUPABASE_ENDPOINT_MODES.has(context.connectionMode)) {
    throw sourceAdmissionError('POSTGRESQL_SUPABASE_ENDPOINT_MODE_INVALID', 'Supabase backup Sources require a direct or session-pooler endpoint.');
  }
  if (context.connectionMode === 'transaction-pooler') {
    throw sourceAdmissionError('POSTGRESQL_SUPABASE_TRANSACTION_POOLER_INELIGIBLE', 'Supabase transaction-pooler connections cannot be enrolled as backup Sources; use a direct or session-pooler endpoint.');
  }
  if (!/^[a-z0-9]{20}$/.test(context.projectRef)) {
    throw sourceAdmissionError('POSTGRESQL_SUPABASE_PROJECT_REF_INVALID', 'The Supabase backup Source requires a valid 20-character project reference.');
  }
  if (consistency.backupMethod === 'physical' || consistency.method === 'pg-basebackup' || (physicalExecution !== null && physicalExecution !== undefined)) {
    throw sourceAdmissionError('POSTGRESQL_SUPABASE_PHYSICAL_BACKUP_UNAVAILABLE', 'Supabase backup Sources do not support physical base backups or WAL execution; use a logical full transaction snapshot.');
  }
  if (consistency.backupMethod !== 'logical' || consistency.backupMode !== 'full' || !['auto', 'transaction-snapshot'].includes(consistency.method) || consistency.requestedLevel !== 'application' || consistency.captureCoordinates || consistency.allowDowngrade) {
    throw sourceAdmissionError('POSTGRESQL_SUPABASE_SOURCE_CONSISTENCY_INVALID', 'Supabase backup Sources require logical full transaction-snapshot consistency (or auto) without downgrade or coordinate capture.');
  }
  const connectionDatabase = String(connection.endpoint?.maintenanceDatabase || connection.endpoint?.database || '').trim();
  if (selector.allDatabases || selector.databases.include.length !== 1 || selector.databases.exclude.length || !connectionDatabase || selector.databases.include[0].name !== connectionDatabase) {
    throw sourceAdmissionError('POSTGRESQL_SUPABASE_SOURCE_SELECTION_INVALID', 'Supabase backup Sources require exactly one selected project database matching the connection database.');
  }
}

function normalizeMongoSnapshotSettings(input = {}, label = 'MongoDB') {
  const maxLagSeconds = Number(input.maxLagSeconds ?? 30);
  const maximumLockMilliseconds = Number(input.maximumLockMilliseconds ?? 120000);
  if (!Number.isInteger(maxLagSeconds) || maxLagSeconds < 0 || maxLagSeconds > 3600) throw new TypeError(`${label} snapshot maximum lag must be between 0 and 3600 seconds.`);
  if (!Number.isInteger(maximumLockMilliseconds) || maximumLockMilliseconds < 1000 || maximumLockMilliseconds > 120000) throw new TypeError(`${label} maximum snapshot lock duration must be between 1000 and 120000 milliseconds.`);
  const keyFiles = [...new Set((Array.isArray(input.keyFiles) ? input.keyFiles : []).slice(0, 20).map((item) => optionalAbsoluteLinuxPath(item, `${label} required key/config file`)))];
  const providerConfiguration = input.providerConfiguration && typeof input.providerConfiguration === 'object' && !Array.isArray(input.providerConfiguration) ? structuredClone(input.providerConfiguration) : {};
  assertSecretRefOnlyCredentials(providerConfiguration, `${label} snapshot provider configuration`);
  return {
    providerId: requiredText(input.providerId, `${label} snapshot provider ID`, 200),
    dbPath: optionalAbsoluteLinuxPath(input.dbPath, `${label} dbPath`, '/var/lib/mongodb'),
    journalPath: optionalAbsoluteLinuxPath(input.journalPath, `${label} journal path`, '/var/lib/mongodb/journal'),
    keyFiles,
    preferredMember: input.preferredMember ? requiredText(input.preferredMember, `${label} preferred member`, 255) : null,
    maxLagSeconds,
    allowPrimary: input.allowPrimary === true,
    maximumLockMilliseconds,
    providerConfiguration
  };
}

function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function normalizeRedisClusterExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.topology !== 'cluster') throw new TypeError('Redis Cluster physical execution settings are required.');
  if (!Array.isArray(input.masters) || input.masters.length < 1 || input.masters.length > 1000) throw new TypeError('Redis Cluster backup requires every slot-owning master connection.');
  const masters = input.masters.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Redis Cluster master settings are invalid.');
    return { nodeId: requiredText(item.nodeId, 'Redis Cluster master node ID', 200), connectionId: requiredText(item.connectionId, 'Redis Cluster master connection ID', 200) };
  });
  if (new Set(masters.map((item) => item.nodeId)).size !== masters.length || new Set(masters.map((item) => item.connectionId)).size !== masters.length) throw new TypeError('Redis Cluster backup requires one distinct connection for every distinct master node.');
  return Object.freeze({ version: 1, engine: 'redis', topology: 'cluster', masters });
}

function normalizeSearchSnapshotExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Search snapshot repository settings are required.');
  const repositoryName = requiredText(input.repositoryName, 'Search snapshot repository name', 255);
  const featureStates = Array.isArray(input.featureStates) ? [...new Set(input.featureStates.map((item) => requiredText(item, 'Search feature-state name', 255)))].sort() : [];
  if (featureStates.length > 1000) throw new TypeError('Search snapshot selection contains too many feature states.');
  return Object.freeze({ version: 1, engine: 'search-cluster', topology: 'cluster', repositoryName, includeGlobalState: Boolean(input.includeGlobalState), featureStates });
}

function normalizeCassandraClusterExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.topology !== 'cluster') throw new TypeError('Cassandra/Scylla complete-cluster enrollment settings are required.');
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 10000) throw new TypeError('Cassandra/Scylla enrollment requires every token-owning node connection.');
  const nodes = input.nodes.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Cassandra/Scylla node binding is invalid.');
    const hostId = requiredText(item.hostId, 'Cassandra/Scylla host ID', 100).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(hostId)) throw new TypeError('Cassandra/Scylla host ID is invalid.');
    const dataDirectories = [...new Set((Array.isArray(item.dataDirectories) ? item.dataDirectories : []).map((value) => optionalAbsoluteLinuxPath(value, 'Cassandra/Scylla data directory')))];
    if (dataDirectories.length > 16 || dataDirectories.some((value) => value === '/')) throw new TypeError('Cassandra/Scylla data directories are invalid.');
    return {
      hostId,
      connectionId: requiredText(item.connectionId, 'Cassandra/Scylla node connection ID', 200),
      dataDirectories,
      commitLogArchive: normalizeCommitLogArchiveEnrollment(item.commitLogArchive, `Cassandra node ${hostId} commit-log archive`)
    };
  });
  if (new Set(nodes.map((item) => item.hostId)).size !== nodes.length || new Set(nodes.map((item) => item.connectionId)).size !== nodes.length) throw new TypeError('Cassandra/Scylla enrollment requires one distinct connection for every distinct token-owning node.');
  const commitLogNodes = nodes.filter((node) => node.commitLogArchive);
  if (commitLogNodes.length && commitLogNodes.length !== nodes.length) throw new TypeError('Cassandra commit-log PITR enrollment requires archive settings for every token-owning node.');
  if (new Set(commitLogNodes.map((node) => node.commitLogArchive.ownershipMarkerDigest)).size !== commitLogNodes.length) throw new TypeError('Cassandra commit-log PITR requires a distinct ownership marker for every node.');
  if (new Set(commitLogNodes.map((node) => node.commitLogArchive.precision)).size > 1) throw new TypeError('Every Cassandra commit-log archive must use the same timestamp precision.');
  const tableIds = Array.isArray(input.tableIds) ? input.tableIds.map((item) => ({
    keyspace: requiredText(item?.keyspace, 'Cassandra/Scylla expected table keyspace', 255),
    name: requiredText(item?.name, 'Cassandra/Scylla expected table name', 255),
    tableId: requiredText(item?.tableId, 'Cassandra/Scylla expected table ID', 100).toLowerCase()
  })) : [];
  if (tableIds.length > 10000 || new Set(tableIds.map((item) => `${item.keyspace}\0${item.name}`)).size !== tableIds.length) throw new TypeError('Cassandra/Scylla expected table IDs are invalid.');
  return Object.freeze({ version: 1, engine: 'cassandra-scylla', topology: 'cluster', nodes, tableIds });
}

async function enrollCassandraClusterSource({ controlDatabase, tenant, deviceId, connection, selector, consistency, input }) {
  if (consistency.backupMethod !== 'physical' || consistency.backupMode !== 'full' || !['auto', 'cassandra-native-snapshot'].includes(consistency.method) || consistency.requestedLevel !== 'crash' || consistency.captureCoordinates !== true) throw new TypeError('Cassandra/Scylla enrollment requires full physical native-snapshot mode, crash consistency, and coordinate capture.');
  if (selector.allDatabases || selector.databases.include.length < 1 || selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.exclude.length || selector.includeGlobalObjects) throw new TypeError('Cassandra/Scylla enrollment requires explicit keyspace selection with optional exact base-table includes and no exclusions or global objects.');
  const normalized = normalizeCassandraClusterExecution(input);
  const trustedInventory = (record, label) => {
    const inventory = record?.clusterInventory;
    if (!record || record.adapterId !== 'deployerx.database.cassandra-scylla' || record.lastTest?.status !== 'success' || !record.trust?.fingerprint || !inventory) throw new TypeError(`Test ${label} successfully before saving the Source.`);
    if (deviceId && !(record.workerAffinity || []).includes(`device:${deviceId}`)) throw new TypeError('Every Cassandra/Scylla node connection must belong to this device.');
    if (record.trust.fingerprint !== inventory.deploymentFingerprint || record.trust.topologyFingerprint !== inventory.topologyFingerprint) throw new TypeError(`${label} does not have trusted current cluster identity evidence.`);
    if (!inventory.schemaAgreement || inventory.coverage?.mode !== 'vnode-ring' || !inventory.coverage?.ringFingerprint || !Number.isInteger(inventory.coverage?.tokenCount) || inventory.coverage.tokenCount < 1) throw new TypeError(`${label} does not prove schema agreement and complete vnode-ring coverage.`);
    return inventory;
  };
  const seed = trustedInventory(connection, 'the selected Cassandra/Scylla seed connection');
  if (seed.product === 'scylladb' && normalized.nodes.some((node) => node.commitLogArchive)) throw new TypeError('ScyllaDB commit-log PITR is unavailable for the currently supported execution tiers.');
  const requiredNodes = (seed.nodes || []).filter((node) => Number(node.tokenCount) > 0);
  if (!requiredNodes.length || normalized.nodes.length !== requiredNodes.length || requiredNodes.some((node) => !normalized.nodes.some((item) => item.hostId === node.hostId))) throw new TypeError('Cassandra/Scylla node mappings must match every token-owning node in the authenticated ring.');
  const boundNodes = [];
  for (const requiredNode of requiredNodes) {
    const settings = normalized.nodes.find((item) => item.hostId === requiredNode.hostId);
    const nodeConnection = await controlDatabase.repository('connection').get(tenant, settings.connectionId);
    const inventory = trustedInventory(nodeConnection, `Cassandra/Scylla node ${requiredNode.hostId}`);
    if (inventory.localHostId !== requiredNode.hostId) throw new TypeError(`Cassandra/Scylla node ${requiredNode.hostId} connection resolves to a different local host ID.`);
    if (inventory.product !== seed.product || inventory.clusterFingerprint !== seed.clusterFingerprint || inventory.topologyFingerprint !== seed.topologyFingerprint || inventory.coverage.ringFingerprint !== seed.coverage.ringFingerprint || inventory.schemaVersion !== seed.schemaVersion || inventory.coverage.tokenCount !== seed.coverage.tokenCount) throw new TypeError(`Cassandra/Scylla node ${requiredNode.hostId} does not match the authenticated cluster, topology, ring, and schema.`);
    const localCoverage = (inventory.nodes || []).find((node) => node.hostId === requiredNode.hostId);
    if (!localCoverage || localCoverage.tokenCount !== requiredNode.tokenCount || localCoverage.tokenDigest !== requiredNode.tokenDigest) throw new TypeError(`Cassandra/Scylla node ${requiredNode.hostId} token ownership evidence changed.`);
    boundNodes.push({
      hostId: requiredNode.hostId, connectionId: settings.connectionId, address: requiredNode.address, dataCenter: requiredNode.dataCenter, rack: requiredNode.rack,
      tokenCount: requiredNode.tokenCount, tokenDigest: requiredNode.tokenDigest, connectionRevision: nodeConnection.revision,
      serverIdentityFingerprint: nodeConnection.trust.fingerprint, inventoryFingerprint: inventory.inventoryFingerprint,
      incrementalBackupsEnabled: inventory.incrementalBackupsEnabled === true,
      dataDirectories: settings.dataDirectories.length ? settings.dataDirectories : [seed.product === 'scylladb' ? '/var/lib/scylla/data' : '/var/lib/cassandra/data'],
      commitLogArchive: settings.commitLogArchive ? structuredClone(settings.commitLogArchive) : null
    });
  }
  const keyspaceByName = new Map((seed.keyspaces || []).map((item) => [item.name, item]));
  const tableByName = new Map((seed.tables || []).map((item) => [`${item.keyspace}\0${item.name}`, item]));
  const derivedByName = new Map((seed.derivedObjects || []).map((item) => [`${item.keyspace}\0${item.name}`, item]));
  const selectedKeyspaces = selector.databases.include.map(({ name }) => {
    const keyspace = keyspaceByName.get(name);
    if (!keyspace) throw new TypeError(`Selected Cassandra/Scylla keyspace ${name} is not present in the tested inventory.`);
    if (keyspace.system) throw new TypeError(`System keyspace ${name} cannot be selected for Cassandra/Scylla backup.`);
    if (seed.product === 'scylladb' && keyspace.tabletsEnabled !== false) throw new TypeError(`ScyllaDB keyspace ${name} uses tablets or has ambiguous tablet state; native enrollment requires a proven vnode keyspace.`);
    return { name: keyspace.name, durableWrites: keyspace.durableWrites, replication: keyspace.replication, tabletsEnabled: keyspace.tabletsEnabled };
  });
  const selectedNames = new Set(selectedKeyspaces.map((item) => item.name));
  const requestedTables = new Map();
  for (const item of selector.tables.include) {
    if (item.database !== item.schema) throw new TypeError('Cassandra/Scylla table selectors must use the keyspace as both database and schema.');
    if (!selectedNames.has(item.database)) throw new TypeError('Cassandra/Scylla table selectors must reference an explicitly selected keyspace.');
    const key = `${item.database}\0${item.name}`;
    if (derivedByName.has(key)) throw new TypeError(`Derived Cassandra/Scylla object ${item.database}.${item.name} is rebuilt during restore and cannot be selected as a base table.`);
    if (!tableByName.has(key)) throw new TypeError(`Selected Cassandra/Scylla table ${item.database}.${item.name} is not present in the tested inventory.`);
    if (!requestedTables.has(item.database)) requestedTables.set(item.database, new Set());
    requestedTables.get(item.database).add(item.name);
  }
  const selectedTables = [];
  for (const keyspace of selectedKeyspaces) {
    const requested = requestedTables.get(keyspace.name);
    const candidates = (seed.tables || []).filter((table) => table.keyspace === keyspace.name && table.selectable && (!requested || requested.has(table.name)));
    if (!candidates.length) throw new TypeError(`Selected Cassandra/Scylla keyspace ${keyspace.name} contains no selected base tables.`);
    selectedTables.push(...candidates.map(({ keyspace: database, name, tableId }) => ({ database, schema: database, name, tableId: requiredText(tableId, 'Cassandra/Scylla table ID', 100).toLowerCase() })));
  }
  if (selectedKeyspaces.some((item) => !/^[A-Za-z0-9_]+$/.test(item.name)) || selectedTables.some((item) => !/^[A-Za-z0-9_]+$/.test(item.name))) throw new TypeError('Native Cassandra/Scylla snapshot enrollment currently requires filesystem-safe unquoted keyspace and table names.');
  if (normalized.tableIds.length) {
    if (normalized.tableIds.length !== selectedTables.length || normalized.tableIds.some((expected) => !selectedTables.some((table) => table.database === expected.keyspace && table.name === expected.name && table.tableId === expected.tableId))) throw new TypeError('Cassandra/Scylla expected table IDs are stale or incomplete.');
  }
  selectedTables.sort((left, right) => `${left.database}\0${left.name}`.localeCompare(`${right.database}\0${right.name}`, 'en-US'));
  boundNodes.sort((left, right) => left.hostId.localeCompare(right.hostId, 'en-US'));
  const rebuildObjects = (seed.derivedObjects || []).filter((item) => selectedNames.has(item.keyspace)).map((item) => ({ ...item }));
  const resolvedSelection = { keyspaces: selectedKeyspaces, tables: selectedTables, rebuildObjects };
  return Object.freeze({
    version: 1, engine: 'cassandra-scylla', topology: 'cluster', enrollmentOnly: true, product: seed.product, clusterName: seed.clusterName,
    productVersion: seed.productVersion || connection.lastTest?.endpointIdentity?.version || null,
    partitioner: seed.partitioner || connection.lastTest?.endpointIdentity?.partitioner || null,
    clusterFingerprint: seed.clusterFingerprint, topologyFingerprint: seed.topologyFingerprint, ringFingerprint: seed.coverage.ringFingerprint,
    schemaVersion: seed.schemaVersion, coverageMode: seed.coverage.mode, tokenCount: seed.coverage.tokenCount,
    incrementalBackupsEnabled: boundNodes.every((node) => node.incrementalBackupsEnabled),
    commitLogPitrEnabled: seed.product === 'cassandra' && boundNodes.every((node) => Boolean(node.commitLogArchive)),
    seedInventoryFingerprint: seed.inventoryFingerprint, nodes: boundNodes, ...resolvedSelection, selectionFingerprint: digestJson(resolvedSelection)
  });
}

function normalizePhysicalExecution(input = {}, engine = 'mysql') {
  const databaseEngine = String(engine || 'mysql');
  const engineLabel = databaseEngine === 'postgresql' ? 'PostgreSQL' : databaseEngine === 'sqlserver' ? 'SQL Server' : databaseEngine === 'oracle' ? 'Oracle' : databaseEngine === 'mongodb' ? 'MongoDB' : 'MySQL';
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${engineLabel} physical execution settings are required.`);
  if (databaseEngine === 'mongodb') {
    const topology = optionValue(input.topology, 'MongoDB physical topology', 'replica-set', ['replica-set', 'sharded']);
    if (topology === 'sharded') {
      const writeGateConfiguration = input.writeGateConfiguration && typeof input.writeGateConfiguration === 'object' && !Array.isArray(input.writeGateConfiguration) ? structuredClone(input.writeGateConfiguration) : {};
      assertSecretRefOnlyCredentials(writeGateConfiguration, 'MongoDB application write-gate configuration');
      if (!Array.isArray(input.components) || input.components.length < 2 || input.components.length > 1001) throw new TypeError('MongoDB sharded backup requires the config server and every shard component.');
      const components = input.components.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('MongoDB sharded component settings are invalid.');
        const role = optionValue(item.role, 'MongoDB sharded component role', null, ['config-server', 'shard']);
        const shardId = role === 'shard' ? requiredText(item.shardId, 'MongoDB shard ID', 200) : null;
        return {
          componentId: role === 'config-server' ? 'config-server' : `shard:${shardId}`,
          role,
          shardId,
          connectionId: requiredText(item.connectionId, 'MongoDB component connection ID', 200),
          ...normalizeMongoSnapshotSettings(item, `MongoDB ${role === 'config-server' ? 'config server' : `shard ${shardId}`}`)
        };
      });
      if (components.filter((item) => item.role === 'config-server').length !== 1 || new Set(components.map((item) => item.componentId)).size !== components.length || new Set(components.map((item) => item.connectionId)).size !== components.length) throw new TypeError('MongoDB sharded backup requires exactly one config server and one distinct connection per component.');
      return Object.freeze({
        version: 1,
        engine: 'mongodb',
        topology,
        writeGateId: requiredText(input.writeGateId, 'MongoDB approved write-gate ID', 200),
        writeGateConfiguration,
        components
      });
    }
    return Object.freeze({
      version: 1, engine: 'mongodb', topology, ...normalizeMongoSnapshotSettings(input)
    });
  }
  const privilegeMode = String(input.privilegeMode || 'sudo-noninteractive');
  if (!['direct', 'sudo-noninteractive'].includes(privilegeMode)) throw new TypeError('Physical backup privilege mode is invalid.');
  if (databaseEngine === 'postgresql') return Object.freeze({
    version: 1,
    engine: 'postgresql',
    sshConnectionId: requiredText(input.sshConnectionId, 'SSH execution connection ID', 200),
    remoteTemporaryDirectory: optionalAbsoluteLinuxPath(input.remoteTemporaryDirectory, 'Remote temporary directory', '/var/tmp'),
    dataDirectory: optionalAbsoluteLinuxPath(input.dataDirectory, 'PostgreSQL data directory', '/var/lib/postgresql/data'),
    walArchiveDirectory: optionalAbsoluteLinuxPath(input.walArchiveDirectory, 'PostgreSQL WAL archive directory', '/var/lib/postgresql/wal-archive'),
    serviceName: serviceIdentity(input.serviceName, 'PostgreSQL service name', 'postgresql'),
    postgresOwner: serviceIdentity(input.postgresOwner, 'PostgreSQL filesystem owner', 'postgres'),
    postgresGroup: serviceIdentity(input.postgresGroup, 'PostgreSQL filesystem group', 'postgres'),
    privilegeMode,
    pgBasebackupExecutable: executableName(input.pgBasebackupExecutable, 'pg_basebackup executable', 'pg_basebackup'),
    pgVerifybackupExecutable: executableName(input.pgVerifybackupExecutable, 'pg_verifybackup executable', 'pg_verifybackup'),
    pgWaldumpExecutable: executableName(input.pgWaldumpExecutable, 'pg_waldump executable', 'pg_waldump'),
    psqlExecutable: executableName(input.psqlExecutable, 'Remote psql executable', 'psql'),
    tarExecutable: executableName(input.tarExecutable, 'tar executable', 'tar')
  });
  if (databaseEngine === 'sqlserver') return Object.freeze({
    version: 1,
    engine: 'sqlserver',
    sshConnectionId: requiredText(input.sshConnectionId, 'SSH execution connection ID', 200),
    remoteTemporaryDirectory: optionalAbsoluteLinuxPath(input.remoteTemporaryDirectory, 'Remote temporary directory', '/var/tmp'),
    backupDirectory: optionalAbsoluteLinuxPath(input.backupDirectory, 'SQL Server backup directory', '/var/opt/mssql/backup'),
    dataDirectory: optionalAbsoluteLinuxPath(input.dataDirectory, 'SQL Server data directory', '/var/opt/mssql/data'),
    logDirectory: optionalAbsoluteLinuxPath(input.logDirectory, 'SQL Server log directory', '/var/opt/mssql/data'),
    privilegeMode,
    sqlcmdExecutable: executableName(input.sqlcmdExecutable, 'Remote sqlcmd executable', 'sqlcmd'),
    statExecutable: executableName(input.statExecutable, 'Remote stat executable', 'stat'),
    ddExecutable: executableName(input.ddExecutable, 'Remote dd executable', 'dd'),
    rmExecutable: executableName(input.rmExecutable, 'Remote rm executable', 'rm')
  });
  if (databaseEngine === 'oracle') return Object.freeze({
    version: 1,
    engine: 'oracle',
    sshConnectionId: requiredText(input.sshConnectionId, 'SSH execution connection ID', 200),
    remoteTemporaryDirectory: optionalAbsoluteLinuxPath(input.remoteTemporaryDirectory, 'Remote temporary directory', '/var/tmp'),
    backupDirectory: optionalAbsoluteLinuxPath(input.backupDirectory, 'Oracle backup-piece directory', '/var/opt/oracle/deployerx-backup'),
    dataDirectory: optionalAbsoluteLinuxPath(input.dataDirectory, 'Oracle data-file directory', '/u02/oradata'),
    recoveryAreaDirectory: optionalAbsoluteLinuxPath(input.recoveryAreaDirectory, 'Oracle fast-recovery-area directory', '/u03/fast_recovery_area'),
    redoDirectory: optionalAbsoluteLinuxPath(input.redoDirectory, 'Oracle redo-log directory', '/u02/oradata'),
    oracleHome: optionalAbsoluteLinuxPath(input.oracleHome, 'Oracle home', '/opt/oracle/product/19c/dbhome_1'),
    oracleSid: serviceIdentity(input.oracleSid, 'Oracle SID', 'ORCLCDB'),
    oracleOwner: serviceIdentity(input.oracleOwner, 'Oracle software owner', 'oracle'),
    oracleGroup: serviceIdentity(input.oracleGroup, 'Oracle software group', 'oinstall'),
    privilegeMode,
    anchorMode: optionValue(input.anchorMode, 'Oracle full-backup anchor mode', 'level-0', ['level-0', 'full']),
    sqlplusExecutable: expectedExecutableName(input.sqlplusExecutable, 'Remote sqlplus executable', 'sqlplus', 'sqlplus'),
    rmanExecutable: expectedExecutableName(input.rmanExecutable, 'RMAN executable', 'rman', 'rman'),
    tarExecutable: expectedExecutableName(input.tarExecutable, 'tar executable', 'tar', 'tar'),
    statExecutable: expectedExecutableName(input.statExecutable, 'Remote stat executable', 'stat', 'stat'),
    sha256sumExecutable: expectedExecutableName(input.sha256sumExecutable, 'sha256sum executable', 'sha256sum', 'sha256sum'),
    rmExecutable: expectedExecutableName(input.rmExecutable, 'Remote rm executable', 'rm', 'rm')
  });
  if (databaseEngine !== 'mysql') throw new TypeError('Physical backup is unavailable for this database engine.');
  return Object.freeze({
    version: 1,
    engine: 'mysql',
    sshConnectionId: requiredText(input.sshConnectionId, 'SSH execution connection ID', 200),
    remoteTemporaryDirectory: optionalAbsoluteLinuxPath(input.remoteTemporaryDirectory, 'Remote temporary directory', '/var/tmp'),
    dataDirectory: optionalAbsoluteLinuxPath(input.dataDirectory, 'MySQL data directory', '/var/lib/mysql'),
    serviceName: serviceIdentity(input.serviceName, 'MySQL service name', 'mysql'),
    mysqlOwner: serviceIdentity(input.mysqlOwner, 'MySQL filesystem owner', 'mysql'),
    mysqlGroup: serviceIdentity(input.mysqlGroup, 'MySQL filesystem group', 'mysql'),
    privilegeMode,
    xtrabackupExecutable: executableName(input.xtrabackupExecutable, 'XtraBackup executable', 'xtrabackup'),
    xbstreamExecutable: executableName(input.xbstreamExecutable, 'xbstream executable', 'xbstream'),
    mysqlExecutable: executableName(input.mysqlExecutable, 'Remote MySQL executable', 'mysql')
  });
}

class DatabaseSourceService {
  constructor({ controlDatabase, adapterRegistry = new DatabaseAdapterRegistry(), allowedAdapterIds = null, deviceId = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase) throw new TypeError('Control database is required.');
    if (!(adapterRegistry instanceof DatabaseAdapterRegistry)) throw new TypeError('Database adapter registry is required.');
    if (allowedAdapterIds !== null && allowedAdapterIds !== undefined && !Array.isArray(allowedAdapterIds) && !(allowedAdapterIds instanceof Set)) throw new TypeError('Allowed database adapter IDs must be an array or Set.');
    this.controlDatabase = controlDatabase;
    this.adapterRegistry = adapterRegistry;
    this.allowedAdapterIds = allowedAdapterIds === null || allowedAdapterIds === undefined
      ? null
      : new Set([...allowedAdapterIds].map((adapterId) => requiredText(adapterId, 'Allowed database adapter ID', 200)));
    this.deviceId = deviceId ? requiredText(deviceId, 'Device ID', 200) : null;
    this.clock = clock;
  }

  listAdapters() {
    return this.adapterRegistry.list().filter((manifest) => !this.allowedAdapterIds || this.allowedAdapterIds.has(manifest.adapterId));
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const connectionId = options.connectionId ? requiredText(options.connectionId, 'Connection ID', 200) : null;
    return (await this.controlDatabase.repository('source').list(tenant, { limit: 1000 }))
      .filter((source) => source.sourceType === 'database')
      .filter((source) => !connectionId || source.connectionId === connectionId);
  }

  async save(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const connectionId = requiredText(input.connectionId, 'Connection ID', 200);
    const connection = await this.controlDatabase.repository('connection').get(tenant, connectionId);
    if (!connection || connection.kind !== 'database') throw new Error('Database source connection was not found.');
    assertSecretRefOnlyCredentials(connection);
    const adapterId = requiredText(input.adapterId || connection.adapterId, 'Database adapter ID', 200);
    if (connection.adapterId !== adapterId) throw new TypeError('The database source adapter must match its connection adapter.');
    if (!input.id && this.allowedAdapterIds && !this.allowedAdapterIds.has(adapterId)) throw new TypeError('This database adapter is not available for new Sources.');
    const manifest = this.adapterRegistry.manifest(adapterId);
    if (!manifest.executionReady && !manifest.sourceEnrollmentReady) throw new TypeError(`${manifest.displayName} backup execution is not available yet.`);
    const selector = normalizeDatabaseSelector(input.selector, manifest);
    const consistency = normalizeConsistencyRequest(input.consistency || {}, manifest.capabilities);
    const supabaseContext = supabaseEndpointContext(connection, manifest);
    let enforceSupabaseAdmission = Boolean(supabaseContext && !input.id);
    let persistedSupabaseContext = supabaseContext;
    if (supabaseContext && input.id) {
      const currentSource = await this.controlDatabase.repository('source').get(tenant, requiredText(input.id, 'Database source ID', 200));
      enforceSupabaseAdmission = currentSource?.platform?.endpoint?.deploymentProfile === 'supabase';
      if (!enforceSupabaseAdmission) persistedSupabaseContext = null;
    }
    if (enforceSupabaseAdmission) admitSupabaseSource({ connection, selector, consistency, physicalExecution: input.physicalExecution, context: supabaseContext });
    let physicalExecution = null;
    let legacyFilesystem = null;
    if (manifest.engine === 'cassandra-scylla') physicalExecution = await enrollCassandraClusterSource({ controlDatabase: this.controlDatabase, tenant, deviceId: this.deviceId, connection, selector, consistency, input: input.physicalExecution });
    if (manifest.engine === 'mongodb') {
      const filtered = !selector.allDatabases || selector.databases.include.length || selector.databases.exclude.length
        || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      const logical = consistency.backupMethod === 'logical' && consistency.method === 'mongodb-oplog-dump';
      const physical = consistency.backupMethod === 'physical' && consistency.method === 'mongodb-coordinated-snapshot';
      if (filtered || (!logical && !physical) || consistency.backupMode !== 'full' || consistency.captureCoordinates !== true) throw new TypeError('MongoDB backup requires a complete replica-set logical oplog anchor or coordinated physical snapshot with operation-time capture.');
    }
    if (manifest.engine === 'sqlite') {
      const selectedMain = selector.allDatabases === true || (selector.databases.include.length === 1 && selector.databases.include[0].name === 'main');
      const filtered = selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      if (!selectedMain || filtered || consistency.backupMethod !== 'logical' || consistency.backupMode !== 'full' || !['auto', 'sqlite-online-backup'].includes(consistency.method) || consistency.captureCoordinates) throw new TypeError('SQLite online backup requires the complete main database without object filters or coordinate capture.');
      if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new TypeError('Test the selected SQLite connection successfully before saving the Source.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The SQLite connection must belong to this device.');
    }
    if (manifest.engine === 'redis') {
      const childSelection = selector.databases.include.length || selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      const cluster = connection.lastTest?.endpointIdentity?.mode === 'cluster';
      const supportedMethods = cluster ? ['auto', 'redis-cluster-rdb', 'redis-cluster-aof'] : ['auto', 'redis-rdb', 'redis-aof'];
      if (!selector.allDatabases || childSelection || consistency.backupMethod !== 'physical' || consistency.backupMode !== 'full' || !supportedMethods.includes(consistency.method) || consistency.captureCoordinates !== true || (cluster && consistency.requestedLevel !== 'crash') || (!cluster && consistency.requestedLevel !== 'application')) throw new TypeError(`Redis ${cluster ? 'Cluster' : 'instance'} backup requires the complete deployment, full physical mode, ${cluster ? 'crash' : 'application'} consistency, a supported native persistence strategy, and replication-coordinate capture.`);
      if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new TypeError('Test the selected Redis connection successfully before saving the Source.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The Redis connection must belong to this device.');
      const validateFilesystemPair = async (redisConnection, label) => {
        const filesystemConnectionId = requiredText(redisConnection.endpoint?.filesystemConnectionId, `${label} paired filesystem connection ID`, 200);
        const filesystemConnection = await this.controlDatabase.repository('connection').get(tenant, filesystemConnectionId);
        if (!filesystemConnection || !['deployerx.connection.local', 'deployerx.connection.ssh'].includes(filesystemConnection.adapterId)) throw new TypeError(`${label} requires a paired local or SSH filesystem connection.`);
        if (filesystemConnection.lastTest?.status !== 'success' || (this.deviceId && !(filesystemConnection.workerAffinity || []).includes(`device:${this.deviceId}`))) throw new TypeError(`Test the paired ${label} filesystem connection on this device before saving the Source.`);
        if (filesystemConnection.adapterId === 'deployerx.connection.local' && !['localhost', '127.0.0.1', '::1'].includes(String(redisConnection.endpoint.host).toLowerCase())) throw new TypeError(`A local ${label} filesystem connection requires a loopback Redis endpoint.`);
        if (filesystemConnection.adapterId === 'deployerx.connection.ssh' && String(filesystemConnection.endpoint?.host).toLowerCase() !== String(redisConnection.endpoint.host).toLowerCase()) throw new TypeError(`The ${label} Redis and paired SSH connection must identify the same host.`);
        return filesystemConnection;
      };
      if (cluster) {
        const normalized = normalizeRedisClusterExecution(input.physicalExecution);
        const seedIdentity = connection.lastTest.endpointIdentity;
        const expectedMasters = Array.isArray(seedIdentity.clusterMasters) ? seedIdentity.clusterMasters : [];
        if (!seedIdentity.clusterTopologyFingerprint || expectedMasters.length !== seedIdentity.clusterMasterCount || normalized.masters.length !== expectedMasters.length || expectedMasters.some((expected) => !normalized.masters.some((item) => item.nodeId === expected.nodeId))) throw new TypeError('Redis Cluster master mappings must match the complete authenticated seed topology.');
        const boundMasters = [];
        for (const expected of expectedMasters) {
          const settings = normalized.masters.find((item) => item.nodeId === expected.nodeId);
          const masterConnection = await this.controlDatabase.repository('connection').get(tenant, settings.connectionId);
          const masterIdentity = masterConnection?.lastTest?.endpointIdentity;
          if (!masterConnection || masterConnection.adapterId !== manifest.adapterId || masterConnection.lastTest?.status !== 'success' || !masterConnection.trust?.fingerprint) throw new TypeError(`Test Redis Cluster master ${expected.nodeId} successfully before saving the Source.`);
          if (this.deviceId && !(masterConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('Every Redis Cluster master connection must belong to this device.');
          if (masterIdentity?.mode !== 'cluster' || masterIdentity.clusterNodeId !== expected.nodeId || masterIdentity.clusterTopologyFingerprint !== seedIdentity.clusterTopologyFingerprint) throw new TypeError(`Redis Cluster master ${expected.nodeId} does not match the authenticated seed topology.`);
          if (consistency.method === 'redis-cluster-aof' && masterIdentity.backupStrategy === 'rdb') throw new TypeError(`Redis Cluster master ${expected.nodeId} cannot produce the requested AOF recovery set.`);
          const filesystemConnection = await validateFilesystemPair(masterConnection, `Redis Cluster master ${expected.nodeId}`);
          boundMasters.push({ ...settings, slots: expected.slots.slice(), address: expected.address, serverIdentityFingerprint: masterConnection.trust.fingerprint, filesystemConnectionId: filesystemConnection.id, connectionRevision: masterConnection.revision, filesystemConnectionRevision: filesystemConnection.revision });
        }
        physicalExecution = Object.freeze({ ...normalized, seedIdentityFingerprint: connection.trust.fingerprint, topologyFingerprint: seedIdentity.clusterTopologyFingerprint, coveredSlots: seedIdentity.coveredSlots, masters: boundMasters });
      } else {
        await validateFilesystemPair(connection, 'Redis');
      }
    }
    if (manifest.engine === 'search-cluster') {
      const childSelection = selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length;
      if (childSelection || (!selector.allDatabases && !selector.databases.include.length) || consistency.backupMethod !== 'physical' || consistency.backupMode !== 'native' || !['auto', 'search-native-snapshot'].includes(consistency.method) || consistency.requestedLevel !== 'crash' || consistency.captureCoordinates !== true) throw new TypeError('Search backup requires open index/data-stream selection, native physical snapshot mode, crash consistency, and start/end coordinate capture.');
      if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || !connection.endpoint?.expectedClusterUuid || !['elasticsearch', 'opensearch'].includes(connection.endpoint?.expectedProduct)) throw new TypeError('Test the selected search snapshot connection successfully before saving the Source.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The search snapshot connection must belong to this device.');
      const normalized = normalizeSearchSnapshotExecution(input.physicalExecution);
      if (normalized.includeGlobalState !== selector.includeGlobalObjects) throw new TypeError('Search global-state selection must match the Source global-object selection.');
      if (connection.endpoint.expectedProduct === 'opensearch' && (normalized.includeGlobalState || normalized.featureStates.length)) throw new TypeError('OpenSearch Sources exclude global state and do not use Elasticsearch feature states.');
      const repositoryTrust = (Array.isArray(connection.repositoryTrusts) ? connection.repositoryTrusts : []).find((item) => item.repositoryName === normalized.repositoryName);
      if (!repositoryTrust || repositoryTrust.readOnly || repositoryTrust.clusterUuid !== connection.endpoint.expectedClusterUuid || repositoryTrust.writerClusterUuid !== connection.endpoint.expectedClusterUuid || !/^sha256:[0-9a-f]{64}$/.test(String(repositoryTrust.repositoryFingerprint || ''))) throw new TypeError('Verify the selected writable search snapshot repository on this cluster before saving the Source.');
      physicalExecution = Object.freeze({
        ...normalized,
        repositoryFingerprint: repositoryTrust.repositoryFingerprint,
        settingsFingerprint: repositoryTrust.settingsFingerprint,
        locationIdentity: repositoryTrust.locationIdentity,
        repositoryType: repositoryTrust.type,
        writerClusterUuid: repositoryTrust.writerClusterUuid,
        verifiedAt: repositoryTrust.verifiedAt,
        verificationNodeCount: repositoryTrust.verificationNodeCount,
        product: connection.endpoint.expectedProduct,
        clusterUuid: connection.endpoint.expectedClusterUuid,
        connectionRevision: connection.revision
      });
    }
    if (manifest.engine === 'scylla-manager') {
      const childSelection = selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      if (childSelection || (!selector.allDatabases && !selector.databases.include.length) || consistency.backupMethod !== 'physical' || consistency.backupMode !== 'native' || !['auto', 'scylla-manager-backup'].includes(consistency.method) || consistency.requestedLevel !== 'crash' || consistency.captureCoordinates !== true) throw new TypeError('ScyllaDB Manager backup requires exact keyspace/base-table selection, native physical mode, crash consistency, and coordinate capture.');
      if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || !connection.endpoint?.expectedManagerVersion || !connection.endpoint?.expectedDeploymentFingerprint || connection.clusterInventory?.healthy !== true) throw new TypeError('Test the selected ScyllaDB Manager connection with every agent, CQL endpoint, and REST endpoint healthy before saving the Source.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The ScyllaDB Manager connection must belong to this device.');
      const targetTrust = connection.managerTargetTrust;
      if (!targetTrust || targetTrust.managedClusterId !== connection.endpoint.managedClusterId || !/^sha256:[0-9a-f]{64}$/.test(String(targetTrust.targetFingerprint || ''))) throw new TypeError('Verify the exact ScyllaDB Manager backup target before saving the Source.');
      const normalized = normalizeScyllaManagerExecution({ ...input.physicalExecution, managedClusterId: input.physicalExecution?.managedClusterId || connection.endpoint.managedClusterId, locationTrusts: targetTrust.locations });
      if (normalized.managedClusterId !== connection.endpoint.managedClusterId) throw new TypeError('The Manager Source must use the exact tested managed cluster.');
      const sameList = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
      const selectedLocations = normalized.locations.map((item) => item.location);
      const trustedLocations = targetTrust.locations.map((item) => item.location);
      if (!sameList(selectedLocations, trustedLocations) || normalized.locations.some((item) => !targetTrust.locations.some((trust) => trust.location === item.location && trust.locationFingerprint === item.locationFingerprint))) throw new TypeError('The Manager Source locations do not match the verified backup target.');
      if (!sameList(normalized.dataCenters, targetTrust.dataCenters) || normalized.method !== targetTrust.method || normalized.retention !== targetTrust.retention || normalized.retentionDays !== targetTrust.retentionDays || normalized.retentionLockMode !== targetTrust.retentionLockMode || !sameList(normalized.rateLimit, targetTrust.rateLimit) || !sameList(normalized.snapshotParallel, targetTrust.snapshotParallel) || !sameList(normalized.uploadParallel, targetTrust.uploadParallel) || normalized.transfers !== targetTrust.transfers || targetTrust.purgeOnly || targetTrust.skipSchema) throw new TypeError('The Manager Source data centers, method, retention, throttling, transfer settings, or schema/purge safety do not match the verified target.');
      const expectedPatterns = scyllaManagerTaskProperties(normalized, selector).keyspace;
      const trustedPatterns = targetTrust.units.flatMap((unit) => unit.allTables ? [`${unit.keyspace}.*`] : unit.tables.map((table) => `${unit.keyspace}.${table}`)).sort();
      if (!sameList(expectedPatterns, trustedPatterns)) throw new TypeError('The Manager Source keyspace/table selection does not match the verified target.');
      physicalExecution = Object.freeze({
        ...normalized,
        targetFingerprint: targetTrust.targetFingerprint,
        deploymentFingerprint: connection.trust.fingerprint,
        topologyFingerprint: connection.trust.topologyFingerprint,
        managerVersion: connection.endpoint.expectedManagerVersion,
        clusterFingerprint: connection.clusterInventory.clusterFingerprint,
        verifiedAt: targetTrust.verifiedAt,
        connectionRevision: connection.revision
      });
    }
    if (consistency.backupMethod === 'physical' && manifest.engine === 'neo4j') {
      const identity = connection.lastTest?.endpointIdentity;
      const inventory = connection.neo4jInventory;
      const objectFilters = selector.allDatabases || selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length;
      if (connection.lastTest?.status !== 'success' || !identity?.deploymentFingerprint || connection.trust?.fingerprint !== identity.deploymentFingerprint) throw new TypeError('Test the selected Neo4j connection successfully before configuring backup.');
      if (selector.databases.include.length !== 1 || selector.databases.include[0].name.toLowerCase() === 'system' || objectFilters) throw new TypeError('Neo4j backup requires exactly one selected user database without object filters.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The Neo4j connection must belong to this device.');
      if (consistency.method === 'offline') {
        if (consistency.backupMode !== 'full' || consistency.requestedLevel !== 'application' || consistency.captureCoordinates || selector.includeGlobalObjects) throw new TypeError('Neo4j offline backup requires physical full mode, offline application consistency, no coordinate capture, and no RBAC metadata selection.');
        physicalExecution = null;
      } else if (consistency.method === 'neo4j-native-backup') {
        if (!['full', 'differential'].includes(consistency.backupMode) || consistency.requestedLevel !== 'application' || consistency.captureCoordinates !== true) throw new TypeError('Neo4j Enterprise online backup requires physical full or differential mode, application consistency, and transaction-coordinate capture.');
        if (identity.edition !== 'enterprise' || inventory?.edition !== 'enterprise' || inventory.deploymentFingerprint !== identity.deploymentFingerprint || inventory.topologyFingerprint !== identity.topologyFingerprint || connection.trust?.topologyFingerprint !== identity.topologyFingerprint) throw new TypeError('Retest the Neo4j Enterprise connection to capture current deployment and topology inventory.');
        const selectedName = selector.databases.include[0].name.toLowerCase();
        const allocations = (inventory.databases || []).filter((database) => String(database.name).toLowerCase() === selectedName);
        const databaseIds = [...new Set(allocations.map((database) => database.databaseId))];
        if (!allocations.length || databaseIds.length !== 1 || allocations.some((database) => database.system || database.selectable !== true || database.currentStatus !== 'online' || database.requestedStatus !== 'online') || allocations.filter((database) => database.writer).length !== 1) throw new TypeError('Neo4j Enterprise online backup requires one online user database identity with exactly one writer.');
        const hostingServerIds = [...new Set(allocations.map((database) => database.serverId))].sort();
        const hostingServers = hostingServerIds.map((serverId) => (inventory.servers || []).find((server) => server.serverId === serverId));
        if (hostingServers.some((server) => !server || server.state !== 'enabled' || !['available', 'healthy'].includes(server.health))) throw new TypeError('Every server hosting the selected Neo4j database must be enabled and healthy.');
        const normalized = normalizeNeo4jOnlineExecution(input.physicalExecution);
        const preferDiffAsParent = neo4jSupportsPreferDiff(inventory.productVersion);
        if (consistency.backupMode === 'differential' && !preferDiffAsParent) throw new TypeError('Neo4j differential backup requires a calendar-version release with --prefer-diff-as-parent support.');
        physicalExecution = Object.freeze({
          version: 1,
          engine: 'neo4j',
          tier: 'enterprise-online',
          backupAddresses: normalized.backupAddresses,
          metadataPolicy: selector.includeGlobalObjects ? 'all' : 'none',
          compression: true,
          preferDiffAsParent,
          databaseName: selectedName,
          databaseId: databaseIds[0],
          writerServerId: allocations.find((database) => database.writer).serverId,
          hostingServerIds,
          edition: inventory.edition,
          productVersion: inventory.productVersion,
          deploymentFingerprint: inventory.deploymentFingerprint,
          topologyFingerprint: inventory.topologyFingerprint,
          executionMode: connection.endpoint?.executionMode,
          connectionRevision: connection.revision
        });
      } else throw new TypeError('Choose offline dump or Neo4j Enterprise native online backup consistency.');
    }
    if (manifest.engine === 'clickhouse') {
      const childExclusions = selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      if (selector.allDatabases || selector.databases.include.length !== 1 || childExclusions || consistency.backupMethod !== 'physical' || consistency.backupMode !== 'full' || !['auto', 'clickhouse-native-backup'].includes(consistency.method) || consistency.requestedLevel !== 'application' || consistency.captureCoordinates !== true) throw new TypeError('ClickHouse backup requires one database, optional exact tables, full physical mode, application consistency, and coordinate capture.');
      const identity = connection.lastTest?.endpointIdentity;
      const inventory = connection.clickhouseInventory;
      if (connection.lastTest?.status !== 'success' || !identity?.deploymentFingerprint || connection.trust?.fingerprint !== identity.deploymentFingerprint || connection.trust?.topologyFingerprint !== identity.topologyFingerprint || inventory?.deploymentFingerprint !== identity.deploymentFingerprint || inventory?.topologyFingerprint !== identity.topologyFingerprint) throw new TypeError('Retest the ClickHouse connection to capture current deployment, topology, and storage inventory.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The ClickHouse connection must belong to this device.');
      if ((inventory.clusters || []).length || (inventory.replicas || []).length) throw new TypeError('This ClickHouse full-backup slice supports standalone non-replicated selections only.');
      const databaseName = selector.databases.include[0].name;
      const database = (inventory.databases || []).find((item) => item.name === databaseName && item.selectable === true);
      if (!database) throw new TypeError('The selected ClickHouse database is absent from the trusted inventory.');
      const selectedTables = selector.tables.include.length
        ? selector.tables.include.map((rule) => {
          if (rule.database !== databaseName || rule.schema !== databaseName) throw new TypeError('ClickHouse table selection must use the selected database as both database and schema.');
          const table = (inventory.tables || []).find((item) => item.database === databaseName && item.name === rule.name && item.selectable === true);
          if (!table) throw new TypeError(`ClickHouse table ${databaseName}.${rule.name} is absent from the trusted inventory.`);
          return table;
        })
        : (inventory.tables || []).filter((item) => item.database === databaseName && item.selectable === true);
      if (!selectedTables.length) throw new TypeError('The selected ClickHouse database has no protectable tables.');
      const unsupportedTable = selectedTables.find((table) => !CLICKHOUSE_TABLE_ENGINES.has(table.engine));
      if (unsupportedTable) throw new TypeError(`ClickHouse table ${unsupportedTable.database}.${unsupportedTable.name} uses an unsupported engine.`);
      const destinationTrust = connection.clickhouseDestinationTrust;
      const trustedDisk = (inventory.disks || []).find((disk) => disk.name === destinationTrust?.diskName);
      if (!destinationTrust || !trustedDisk || trustedDisk.readOnly || trustedDisk.writeOnce || clickHouseDestinationFingerprint(trustedDisk) !== destinationTrust.destinationFingerprint || destinationTrust.deploymentFingerprint !== identity.deploymentFingerprint || destinationTrust.topologyFingerprint !== identity.topologyFingerprint) throw new TypeError('Approve one writable ClickHouse backup disk before saving the Source.');
      const normalized = normalizeClickHouseBackupExecution({ ...input.physicalExecution, destinationType: 'disk', diskName: destinationTrust.diskName, destinationFingerprint: destinationTrust.destinationFingerprint });
      physicalExecution = Object.freeze({ ...normalized, approvedAt: destinationTrust.approvedAt, deploymentFingerprint: destinationTrust.deploymentFingerprint, topologyFingerprint: destinationTrust.topologyFingerprint, connectionRevision: connection.revision });
    }
    if (manifest.engine === 'influxdb') {
      const childExclusions = selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      if (selector.allDatabases || selector.databases.include.length !== 1 || selector.tables.include.length > 1 || childExclusions || consistency.backupMethod !== 'physical' || consistency.backupMode !== 'full' || !['auto', 'influxdb-v2-native-backup'].includes(consistency.method) || consistency.requestedLevel !== 'application' || consistency.captureCoordinates !== true) throw new TypeError('InfluxDB OSS v2 backup requires one organization, optional one exact bucket, full physical mode, application consistency, and coordinate capture.');
      const identity = connection.lastTest?.endpointIdentity;
      const inventory = connection.influxdbInventory;
      if (connection.lastTest?.status !== 'success' || !identity?.deploymentFingerprint || connection.trust?.fingerprint !== identity.deploymentFingerprint || inventory?.deploymentFingerprint !== identity.deploymentFingerprint || inventory?.inventoryFingerprint !== identity.inventoryFingerprint) throw new TypeError('Retest the InfluxDB connection to capture current organization and bucket inventory.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The InfluxDB connection must belong to this device.');
      const organizationName = selector.databases.include[0].name;
      const organization = (inventory.organizations || []).find((item) => item.name === organizationName && item.selectable === true);
      if (!organization) throw new TypeError('The selected InfluxDB organization is absent from trusted inventory.');
      let bucket = null;
      if (selector.tables.include.length) {
        const rule = selector.tables.include[0];
        if (rule.database !== organizationName || rule.schema !== organizationName) throw new TypeError('InfluxDB bucket selection must use the organization as both database and schema.');
        bucket = (inventory.buckets || []).find((item) => item.organizationId === organization.id && item.name === rule.name && item.selectable === true);
        if (!bucket) throw new TypeError('The selected InfluxDB bucket is absent from trusted inventory.');
      } else if (!(inventory.buckets || []).some((item) => item.organizationId === organization.id && item.selectable === true)) throw new TypeError('The selected InfluxDB organization has no protectable user buckets.');
      physicalExecution = normalizeInfluxDbBackupExecution({
        engine: 'influxdb', scope: bucket ? 'bucket' : 'organization', organizationId: organization.id, organizationName: organization.name,
        bucketId: bucket?.id, bucketName: bucket?.name, deploymentFingerprint: identity.deploymentFingerprint,
        inventoryFingerprint: identity.inventoryFingerprint, connectionRevision: connection.revision
      });
    }
    if (manifest.engine === 'influxdb3-core') {
      const childSelection = selector.databases.include.length || selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      const requestedMode = String(input.physicalExecution?.consistencyMode || '').toLowerCase();
      const requiredMethod = INFLUXDB3_CORE_CONSISTENCY_METHODS[requestedMode];
      const requiredLevel = requestedMode === 'ordered-live-copy' ? 'crash' : 'application';
      if (!selector.allDatabases || childSelection || consistency.backupMethod !== 'physical' || consistency.backupMode !== 'full' || !requiredMethod || !['auto', requiredMethod].includes(consistency.method) || consistency.requestedLevel !== requiredLevel || consistency.captureCoordinates) throw new TypeError('InfluxDB 3 Core object-store backup requires the exact whole node, full physical mode, matching consistency proof, and no coordinate capture.');
      const identity = connection.lastTest?.endpointIdentity;
      const inventory = connection.influxdb3CoreInventory;
      const inventoryNode = (inventory?.nodes || []).find((item) => item.id === identity?.nodeId && item.selectable === true);
      const supportedObjectStores = ['file', 's3', 'azure', 'google'];
      const expectedRestoreSupport = supportedObjectStores.includes(identity?.objectStore);
      if (connection.lastTest?.status !== 'success' || !supportedObjectStores.includes(identity?.objectStore) || identity?.restoreSupported !== expectedRestoreSupport || !identity?.deploymentFingerprint || !identity?.storageFingerprint || connection.trust?.fingerprint !== identity.deploymentFingerprint || connection.trust?.storageFingerprint !== identity.storageFingerprint || connection.trust?.objectStore !== identity.objectStore || inventory?.deploymentFingerprint !== identity.deploymentFingerprint || inventory?.storageFingerprint !== identity.storageFingerprint || inventoryNode?.objectStore !== identity.objectStore || inventoryNode?.restoreSupported !== expectedRestoreSupport) throw new TypeError('Retest the InfluxDB 3 Core connection to capture its exact endpoint and object-store identity.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The InfluxDB 3 Core connection must belong to this device.');
      physicalExecution = normalizeInfluxDb3CoreBackupExecution({
        ...input.physicalExecution,
        engine: 'influxdb3-core', objectStore: identity.objectStore, nodeId: identity.nodeId,
        deploymentFingerprint: identity.deploymentFingerprint, storageFingerprint: identity.storageFingerprint,
        connectionRevision: connection.revision
      });
    }
    if (manifest.engine === 'influxdb3-enterprise') {
      if (!exactInfluxDb3EnterpriseSelector(selector) || consistency.backupMethod !== 'physical' || consistency.backupMode !== 'full' || consistency.allowDowngrade) throw new TypeError('InfluxDB 3 Enterprise backup requires exact whole-cluster selection and full physical mode without consistency downgrade.');
      const identity = connection.lastTest?.endpointIdentity;
      const trusted = connection.lastTest?.status === 'success'
        && identity?.deploymentFingerprint
        && identity?.capabilityFingerprint
        && connection.trust?.fingerprint === identity.deploymentFingerprint
        && connection.trust?.capabilityFingerprint === identity.capabilityFingerprint
        && connection.endpoint?.expectedDeploymentFingerprint === identity.deploymentFingerprint
        && connection.endpoint?.expectedCapabilityFingerprint === identity.capabilityFingerprint;
      if (!trusted) throw new TypeError('Retest the InfluxDB 3 Enterprise connection to capture its exact deployment and capability identity.');
      if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The InfluxDB 3 Enterprise connection must belong to this device.');
      const inferredTier = identity.storageEngine === 'upgraded' ? 'upgraded-native' : identity.storageEngine === 'legacy-parquet' ? 'legacy-filesystem' : null;
      const tier = String(input.physicalExecution?.tier || inferredTier || '').toLowerCase();
      if (tier !== inferredTier) throw new TypeError('The InfluxDB 3 Enterprise Source tier must match the tested storage engine.');
      if (tier === 'upgraded-native') {
        if (identity.compactorCapable !== true || identity.nativeBackupAvailable !== true || !['auto', INFLUXDB3_ENTERPRISE_NATIVE_METHOD].includes(consistency.method) || consistency.requestedLevel !== 'application' || consistency.captureCoordinates !== true) throw new TypeError('InfluxDB 3 Enterprise upgraded-engine backup requires a proven compactor endpoint, native full backup, application consistency, and watermark capture.');
        physicalExecution = normalizeInfluxDb3EnterpriseNativeExecution({
          version: 1,
          engine: 'influxdb3-enterprise',
          tier,
          productVersion: identity.version,
          clusterId: identity.clusterId,
          storageEngine: identity.storageEngine,
          nodeId: identity.nodeId,
          nodeCatalogId: identity.nodeCatalogId,
          instanceId: identity.instanceId,
          roleFingerprint: identity.roleFingerprint,
          deploymentFingerprint: identity.deploymentFingerprint,
          capabilityFingerprint: identity.capabilityFingerprint,
          compactorCapable: true,
          nativeBackupAvailable: true,
          connectionRevision: connection.revision
        });
      } else if (tier === 'legacy-filesystem') {
        if (identity.legacyParquetEngine !== true || identity.compactorCapable !== true || identity.nativeBackupAvailable === true) throw new TypeError('InfluxDB 3 Enterprise legacy filesystem backup requires a proven legacy-engine compactor endpoint.');
        const settings = input.physicalExecution && typeof input.physicalExecution === 'object' && !Array.isArray(input.physicalExecution) ? input.physicalExecution : {};
        const storageInput = input.legacyFilesystem && typeof input.legacyFilesystem === 'object' && !Array.isArray(input.legacyFilesystem) ? input.legacyFilesystem : {};
        const layout = await inspectLegacyClusterLayout({
          dataRoot: storageInput.dataRoot,
          clusterId: identity.clusterId,
          compactorNodeId: identity.nodeId,
          dataNodeIds: settings.dataNodeIds
        });
        physicalExecution = normalizeInfluxDb3EnterpriseLegacyExecution({
          tier,
          consistencyMode: settings.consistencyMode,
          consistencyMethod: settings.consistencyMethod,
          confirmationText: settings.confirmationText,
          operatorAttestation: settings.operatorAttestation,
          clusterId: identity.clusterId,
          compactorNodeId: identity.nodeId,
          dataNodeIds: layout.dataNodeIds,
          topologyFingerprint: layout.topologyFingerprint,
          storageFingerprint: layout.storageFingerprint,
          connectionRevision: connection.revision
        });
        legacyFilesystem = normalizeInfluxDb3EnterpriseLegacyStorage({ kind: 'local-filesystem', dataRoot: storageInput.dataRoot }, physicalExecution);
        if (!exactInfluxDb3EnterpriseLegacyConsistency(consistency, physicalExecution)) throw new TypeError('InfluxDB 3 Enterprise legacy consistency must exactly match its confirmed filesystem capture mode.');
      } else throw new TypeError('Choose a supported InfluxDB 3 Enterprise Source tier.');
    }
    if (manifest.engine === 'cockroachdb') physicalExecution = admitCockroachDbSource({ connection, selector, consistency, input: input.physicalExecution, deviceId: this.deviceId });
    if (consistency.backupMethod === 'physical' && !['redis', 'search-cluster', 'cassandra-scylla', 'scylla-manager', 'neo4j', 'clickhouse', 'influxdb', 'influxdb3-core', 'influxdb3-enterprise', 'cockroachdb'].includes(manifest.engine)) physicalExecution = normalizePhysicalExecution(input.physicalExecution, manifest.engine);
    if (consistency.backupMethod === 'physical' && !['redis', 'search-cluster', 'cassandra-scylla', 'scylla-manager', 'neo4j', 'clickhouse', 'influxdb', 'influxdb3-core', 'influxdb3-enterprise', 'cockroachdb'].includes(manifest.engine)) {
      if (!['mysql', 'postgresql', 'sqlserver', 'oracle', 'mongodb'].includes(manifest.engine)) throw new TypeError('Physical backup is unavailable for this database engine.');
      const testedIdentity = manifest.engine === 'postgresql'
        ? connection.lastTest?.endpointIdentity?.systemIdentifier
        : manifest.engine === 'sqlserver'
          ? connection.lastTest?.endpointIdentity?.instanceFingerprint
          : manifest.engine === 'oracle'
            ? connection.lastTest?.endpointIdentity?.databaseFingerprint
            : manifest.engine === 'mongodb'
              ? connection.lastTest?.endpointIdentity?.deploymentFingerprint
          : connection.lastTest?.endpointIdentity?.serverUuid;
      const physicalLabel = manifest.engine === 'postgresql' ? 'PostgreSQL' : manifest.engine === 'sqlserver' ? 'SQL Server' : manifest.engine === 'oracle' ? 'Oracle' : manifest.engine === 'mongodb' ? 'MongoDB' : 'MySQL';
      if (connection.lastTest?.status !== 'success' || !testedIdentity) throw new TypeError(`Test the selected ${physicalLabel} connection successfully before configuring physical backup.`);
      const testedVersion = String(connection.lastTest?.remotePlatform?.version || '');
      if (manifest.engine === 'mysql' && !/^8\.4(?:\.|$)/.test(testedVersion)) throw new TypeError('MySQL physical backup currently requires a tested MySQL 8.4 server.');
      if (manifest.engine === 'postgresql' && !/^(?:14|15|16|17|18)(?:\.|$)/.test(testedVersion)) throw new TypeError('PostgreSQL physical backup requires a tested PostgreSQL 14 through 18 server.');
      if (manifest.engine === 'sqlserver' && !/^(?:15|16|17)(?:\.|$)/.test(testedVersion)) throw new TypeError('SQL Server native backup requires a tested SQL Server 2019, 2022, or 2025 instance.');
      if (manifest.engine === 'oracle' && !/^(?:19|21|23)(?:\.|$)/.test(testedVersion)) throw new TypeError('Oracle RMAN backup requires a tested Oracle Database 19c, 21c, or 23ai database.');
      if (manifest.engine === 'mongodb' && !/^(?:7|8)(?:\.|$)/.test(testedVersion)) throw new TypeError('MongoDB physical backup requires a tested MongoDB 7.0 or 8.0 deployment.');
      const childSelection = selector.databases.include.length || selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length || selector.includeGlobalObjects;
      if (manifest.engine === 'sqlserver' || manifest.engine === 'oracle') {
        const objectFilters = selector.databases.exclude.length || selector.schemas.include.length || selector.schemas.exclude.length || selector.tables.include.length || selector.tables.exclude.length || selector.includeGlobalObjects;
        if (selector.allDatabases || selector.databases.include.length !== 1 || objectFilters) throw new TypeError(`${physicalLabel} native backup requires exactly one selected database without object filters.`);
        if (manifest.engine === 'oracle' && selector.databases.include[0].name !== connection.lastTest?.endpointIdentity?.databaseUniqueName) throw new TypeError('The selected Oracle database does not match the tested DB_UNIQUE_NAME.');
      } else if (!selector.allDatabases || childSelection) throw new TypeError(`${manifest.engine === 'postgresql' ? 'PostgreSQL' : manifest.engine === 'mongodb' ? 'MongoDB' : 'MySQL'} physical backup requires the whole ${manifest.engine === 'postgresql' || (manifest.engine === 'mongodb' && physicalExecution.topology === 'sharded') ? 'cluster' : manifest.engine === 'mongodb' ? 'replica set' : 'instance'} without object filters.`);
      if (manifest.engine === 'mongodb') {
        const endpointIdentity = connection.lastTest?.endpointIdentity;
        if (physicalExecution.topology === 'sharded') {
          const routerTopology = endpointIdentity?.shardedTopology;
          if (endpointIdentity?.topology !== 'sharded' || !endpointIdentity.clusterId || !routerTopology?.metadataFingerprint || !routerTopology.configServer || !Array.isArray(routerTopology.shards)) throw new TypeError('MongoDB sharded physical backup requires a tested mongos identity and complete shard map.');
          const expected = [
            { componentId: 'config-server', role: 'config-server', shardId: null, ...routerTopology.configServer },
            ...routerTopology.shards.map((shard) => ({ componentId: `shard:${shard.shardId}`, role: 'shard', shardId: shard.shardId, setName: shard.setName, hosts: shard.hosts }))
          ];
          if (physicalExecution.components.length !== expected.length || expected.some((item) => !physicalExecution.components.some((candidate) => candidate.componentId === item.componentId))) throw new TypeError('MongoDB sharded component paths must match the complete authenticated router shard map.');
          const boundComponents = [];
          for (const expectedComponent of expected) {
            const settings = physicalExecution.components.find((item) => item.componentId === expectedComponent.componentId);
            const componentConnection = await this.controlDatabase.repository('connection').get(tenant, settings.connectionId);
            const componentIdentity = componentConnection?.lastTest?.endpointIdentity;
            if (!componentConnection || componentConnection.adapterId !== manifest.adapterId || componentConnection.lastTest?.status !== 'success' || !componentConnection.trust?.fingerprint) throw new TypeError(`Test the MongoDB ${expectedComponent.componentId} connection successfully before saving the Source.`);
            if (componentIdentity?.topology !== 'replica-set' || componentIdentity.replicaRole !== expectedComponent.role || componentIdentity.setName !== expectedComponent.setName || !componentIdentity.replicaSetId || !sameStrings(componentIdentity.members, expectedComponent.hosts)) throw new TypeError(`MongoDB ${expectedComponent.componentId} does not match the authenticated router shard map.`);
            if (this.deviceId && !(componentConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('Every MongoDB sharded component connection must belong to this device.');
            boundComponents.push({
              ...settings,
              expectedSetName: expectedComponent.setName,
              expectedHosts: expectedComponent.hosts.slice(),
              expectedReplicaSetId: componentIdentity.replicaSetId,
              serverIdentityFingerprint: componentConnection.trust.fingerprint
            });
          }
          physicalExecution = Object.freeze({
            ...physicalExecution,
            clusterId: endpointIdentity.clusterId,
            serverIdentityFingerprint: connection.trust.fingerprint,
            topologyFingerprint: routerTopology.metadataFingerprint,
            components: boundComponents
          });
        } else if (endpointIdentity?.topology !== 'replica-set' || !endpointIdentity.replicaSetId) throw new TypeError('MongoDB physical backup requires a tested replica-set identity.');
        if (this.deviceId && !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new TypeError('The MongoDB physical backup connection must belong to this device.');
      } else {
        const sshConnection = await this.controlDatabase.repository('connection').get(tenant, physicalExecution.sshConnectionId);
        if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh') throw new TypeError(`Choose a saved Linux SSH connection for ${physicalLabel} physical execution.`);
        if (sshConnection.lastTest?.status !== 'success') throw new TypeError('Test the selected SSH execution connection successfully first.');
        if (this.deviceId && ![connection, sshConnection].every((item) => (item.workerAffinity || []).includes(`device:${this.deviceId}`))) throw new TypeError(`The ${physicalLabel} and SSH physical backup connections must belong to this device.`);
      }
    }
    const data = {
      name: requiredText(input.name, 'Database source name', 200),
      connectionId,
      sourceType: 'database',
      adapterId: manifest.adapterId,
      enabled: manifest.executionReady ? (input.enabled === undefined ? true : Boolean(input.enabled)) : false,
      executionStatus: manifest.executionReady ? 'ready-for-runtime-preflight' : 'awaiting-adapter-execution',
      selector,
      consistency,
      physicalExecution,
      platform: {
        engine: manifest.engine,
        adapterVersion: manifest.adapterVersion,
        serverVersionRange: manifest.serverVersionRange,
        endpoint: Object.freeze({
          ...publicDatabaseEndpoint(connection.endpoint || {}),
          ...(persistedSupabaseContext ? {
            deploymentProfile: persistedSupabaseContext.deploymentProfile,
            connectionMode: persistedSupabaseContext.connectionMode,
            projectRef: persistedSupabaseContext.projectRef
          } : {})
        }),
        capabilitiesDigest: digestJson(manifest.capabilities)
      },
      lastDiscovery: {
        discoveredAt: this.clock(),
        status: 'configured',
        selectionDigest: selector.digest,
        consistencyStatus: manifest.executionReady ? 'requires-runtime-preflight' : 'awaiting-adapter-execution'
      }
    };
    if (legacyFilesystem) data.legacyFilesystem = legacyFilesystem;
    if (!input.id) return this.controlDatabase.repository('source').create({ workspaceId: tenant, actorId: actor, ...data });
    const id = requiredText(input.id, 'Database source ID', 200);
    const current = await this.controlDatabase.repository('source').get(tenant, id);
    if (!current || current.sourceType !== 'database') throw new Error('Database source was not found.');
    if (current.connectionId !== connectionId) throw new TypeError('A database source cannot be moved to another connection.');
    const expectedRevision = Number(input.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('Database source revision is required for editing.');
    return this.controlDatabase.repository('source').update(tenant, id, data, { expectedRevision, actorId: actor });
  }

  async remove(workspaceId, actorId, sourceId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(sourceId, 'Database source ID', 200);
    const current = await this.controlDatabase.repository('source').get(tenant, id);
    if (!current || current.sourceType !== 'database') throw new Error('Database source was not found.');
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TypeError('Database source revision is required for deletion.');
    return this.controlDatabase.repository('source').softDelete(tenant, id, { expectedRevision, actorId: actor });
  }
}

module.exports = { DatabaseSourceService, normalizeCassandraClusterExecution, normalizePhysicalExecution, normalizeSearchSnapshotExecution };
