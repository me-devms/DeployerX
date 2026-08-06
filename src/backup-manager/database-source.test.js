const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { BackupJobService } = require('./backup-job');
const { CassandraScyllaAdapter } = require('./cassandra-scylla');
const { DatabaseSourceService } = require('./database-source');

function adapter(executionReady = true, adapterId = 'deployerx.database.test.logical') {
  return {
    manifest() {
      return {
        apiVersion: 1, adapterId, adapterVersion: '1.2.3', displayName: `TestDB ${adapterId.split('.').at(-1)}`,
        engine: 'testdb', executionReady, serverVersionRange: '>=10 <20', restoreVersionRange: '>=10 <21',
        capabilities: {
          backupMethods: ['logical'], backupModes: ['full'], selection: { database: true, schema: true, table: true, globalObjects: true },
          consistencyStrategies: [{ id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'none', capturesCoordinates: true }],
          transactionLogs: { supported: false, type: null, pointInTimeRecovery: false, granularitySeconds: null },
          streaming: { backup: true, restore: true, compression: true, encryption: false },
          restore: { alternateTarget: true, nativeValidation: true }, replicaAware: false
        },
        requiredTools: [], requiredPrivileges: []
      };
    },
    async testConnection() {}, async *discover() {}, async preflight() {}, async planBackup() {}, async executeBackup() {},
    async planRestore() {}, async executeRestore() {}, async validateRestore() {}
  };
}

function postgresqlPhysicalAdapter() {
  return {
    manifest() {
      return {
        apiVersion: 1, adapterId: 'deployerx.database.postgresql.logical', adapterVersion: '1.4.0', displayName: 'PostgreSQL',
        engine: 'postgresql', serverVersionRange: '>=14 <19', restoreVersionRange: '>=14 <19',
        capabilities: {
          backupMethods: ['logical', 'physical'], backupModes: ['full', 'incremental'], selection: { database: true, schema: true, table: true, globalObjects: false },
          consistencyStrategies: [
            { id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'table', capturesCoordinates: false },
            { id: 'pg-basebackup', produces: 'application', backupMethods: ['physical'], lockScope: 'cluster', capturesCoordinates: true }
          ],
          transactionLogs: { supported: true, type: 'wal', pointInTimeRecovery: true, granularitySeconds: 1 },
          streaming: { backup: true, restore: true, compression: true, encryption: false },
          restore: { alternateTarget: true, nativeValidation: true }, replicaAware: false
        },
        requiredTools: [], requiredPrivileges: []
      };
    },
    async testConnection() {}, async *discover() {}, async preflight() {}, async planBackup() {}, async executeBackup() {},
    async planRestore() {}, async executeRestore() {}, async validateRestore() {}
  };
}

async function supabaseSourceFixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-supabase-source-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-05T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const service = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([postgresqlPhysicalAdapter()]) });
  const createConnection = (mode, suffix, options = {}) => controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: `Supabase ${mode} ${suffix}`, kind: 'database', adapterId: 'deployerx.database.postgresql.logical',
    endpoint: {
      host: mode === 'direct' ? 'db.abcdefghijklmnopqrst.supabase.co' : 'aws-0-us-east-1.pooler.supabase.com',
      port: mode === 'transaction-pooler' ? 6543 : 5432,
      database: 'postgres', maintenanceDatabase: 'postgres', username: mode === 'direct' ? 'postgres' : 'postgres.abcdefghijklmnopqrst',
      tlsMode: 'verify-full', deploymentProfile: 'supabase', projectRef: 'abcdefghijklmnopqrst',
      ...(options.legacyModeAlias ? { supabaseEndpointMode: mode } : { connectionMode: mode }),
      passwordSecretRefId: 'sec_supabase_password'
    }
  });
  const sourceInput = (connectionId, overrides = {}) => ({
    name: 'Supabase PostgreSQL database backup', connectionId,
    selector: { databases: { include: [{ name: 'postgres' }] }, schemas: { include: [{ database: 'postgres', name: 'public' }] } },
    consistency: { requestedLevel: 'application', method: 'transaction-snapshot', backupMethod: 'logical', backupMode: 'full' },
    ...overrides
  });
  return { controlDatabase, service, createConnection, sourceInput };
}

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-source-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-03T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'TestDB production', kind: 'database',
    adapterId: 'deployerx.database.test.logical',
    endpoint: { host: 'db.example.com', port: 15432, database: 'orders', username: 'backup', tlsMode: 'verify-full', serverIdentityFingerprint: 'sha256:server' }
  });
  const registry = new DatabaseAdapterRegistry([adapter()]);
  return { controlDatabase, connection, service: new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, clock: () => '2026-08-03T12:00:00.000Z' }) };
}

test('persists normalized workspace-scoped database sources without credentials', async (context) => {
  const { service, connection } = await fixture(context);
  const source = await service.save('workspace-a', 'tester', {
    name: 'Production orders',
    connectionId: connection.id,
    selector: { databases: { include: [{ name: 'orders' }] }, schemas: { include: [{ database: 'orders', name: 'public' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
  });
  assert.equal(source.sourceType, 'database');
  assert.equal(source.adapterId, 'deployerx.database.test.logical');
  assert.equal(source.platform.engine, 'testdb');
  assert.equal(source.platform.endpoint.host, 'db.example.com');
  assert.equal(source.platform.endpoint.password, undefined);
  assert.equal(source.lastDiscovery.consistencyStatus, 'requires-runtime-preflight');
  assert.match(source.selector.digest, /^[a-f0-9]{64}$/);
  assert.equal((await service.list('workspace-a')).length, 1);
  assert.deepEqual(await service.list('workspace-b'), []);
  assert.equal(service.listAdapters()[0].capabilities.selection.table, true);
});

test('edits database sources optimistically and soft-deletes them', async (context) => {
  const { service, connection } = await fixture(context);
  const created = await service.save('workspace-a', 'tester', {
    name: 'Orders', connectionId: connection.id,
    selector: { databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'application' }
  });
  const updated = await service.save('workspace-a', 'tester', {
    id: created.id, revision: created.revision, name: 'Orders selected', connectionId: connection.id,
    selector: { databases: { include: [{ name: 'orders' }, { name: 'accounts' }] } },
    consistency: { requestedLevel: 'application' }
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.selector.databases.include.length, 2);
  await assert.rejects(service.save('workspace-a', 'tester', {
    id: created.id, revision: 1, name: 'Stale', connectionId: connection.id,
    selector: { databases: { include: [{ name: 'orders' }] } }
  }), /revision conflict/);
  const deleted = await service.remove('workspace-a', 'tester', updated.id, updated.revision);
  assert.equal(deleted.revision, 3);
  assert.deepEqual(await service.list('workspace-a'), []);
});

test('refuses unsupported adapters, non-database connections, and plaintext persistence', async (context) => {
  const { controlDatabase, service, connection } = await fixture(context);
  const local = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Local', kind: 'local', adapterId: 'deployerx.connection.local', endpoint: { platform: 'windows' }
  });
  await assert.rejects(service.save('workspace-a', 'tester', {
    name: 'Wrong connection', connectionId: local.id, selector: { allDatabases: true }
  }), /not found/);
  await assert.rejects(service.save('workspace-a', 'tester', {
    name: 'Wrong adapter', connectionId: connection.id, adapterId: 'deployerx.database.other', selector: { allDatabases: true }
  }), /must match/);
  await assert.rejects(controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Unsafe DB', kind: 'database', adapterId: 'deployerx.database.test.logical', endpoint: { host: 'db.example.com', password: 'plaintext' }
  }), /SecretRef ID/);
});

test('refuses source creation until a registered adapter declares execution readiness', async (context) => {
  const { controlDatabase, connection } = await fixture(context);
  const service = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([adapter(false)]) });
  assert.equal(service.listAdapters()[0].executionReady, false);
  await assert.rejects(service.save('workspace-a', 'tester', {
    name: 'Not executable', connectionId: connection.id,
    selector: { databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'application' }
  }), /backup execution is not available yet/);
});

test('advertises only allowed adapters while preserving existing out-of-scope sources', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-source-scope-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-05T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const allowedAdapterId = 'deployerx.database.test.allowed';
  const legacyAdapterId = 'deployerx.database.test.legacy';
  const registry = new DatabaseAdapterRegistry([adapter(true, allowedAdapterId), adapter(true, legacyAdapterId)]);
  const allowedConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Allowed database', kind: 'database', adapterId: allowedAdapterId,
    endpoint: { host: 'allowed.example.com', port: 15432, database: 'orders', username: 'backup' }
  });
  const legacyConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Legacy database', kind: 'database', adapterId: legacyAdapterId,
    endpoint: { host: 'legacy.example.com', port: 15432, database: 'archive', username: 'backup' }
  });
  const unrestrictedService = new DatabaseSourceService({ controlDatabase, adapterRegistry: registry });
  const legacySource = await unrestrictedService.save('workspace-a', 'tester', {
    name: 'Legacy archive', connectionId: legacyConnection.id,
    selector: { databases: { include: [{ name: 'archive' }] } }, consistency: { requestedLevel: 'application' }
  });
  const scopedService = new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, allowedAdapterIds: [allowedAdapterId] });

  assert.deepEqual(scopedService.listAdapters().map((manifest) => manifest.adapterId), [allowedAdapterId]);
  await assert.rejects(scopedService.save('workspace-a', 'tester', {
    name: 'New legacy archive', connectionId: legacyConnection.id,
    selector: { databases: { include: [{ name: 'archive' }] } }, consistency: { requestedLevel: 'application' }
  }), /not available for new Sources/);
  const allowedSource = await scopedService.save('workspace-a', 'tester', {
    name: 'Allowed orders', connectionId: allowedConnection.id,
    selector: { databases: { include: [{ name: 'orders' }] } }, consistency: { requestedLevel: 'application' }
  });
  assert.equal(allowedSource.adapterId, allowedAdapterId);
  assert.equal((await scopedService.list('workspace-a')).some((source) => source.id === legacySource.id), true);

  const updatedLegacySource = await scopedService.save('workspace-a', 'tester', {
    id: legacySource.id, revision: legacySource.revision, name: 'Legacy archive retained', connectionId: legacyConnection.id,
    selector: { databases: { include: [{ name: 'archive' }] } }, consistency: { requestedLevel: 'application' }
  });
  assert.equal(updatedLegacySource.name, 'Legacy archive retained');
  assert.equal(updatedLegacySource.adapterId, legacyAdapterId);
});

test('admits direct and session-pooler Supabase logical Sources with safe deployment context', async (context) => {
  const { service, createConnection, sourceInput } = await supabaseSourceFixture(context);
  const directConnection = await createConnection('direct', 'direct');
  const direct = await service.save('workspace-a', 'tester', sourceInput(directConnection.id));
  assert.equal(direct.consistency.backupMethod, 'logical');
  assert.equal(direct.consistency.backupMode, 'full');
  assert.equal(direct.platform.endpoint.deploymentProfile, 'supabase');
  assert.equal(direct.platform.endpoint.connectionMode, 'direct');
  assert.equal(direct.platform.endpoint.supabaseEndpointMode, undefined);
  assert.equal(direct.platform.endpoint.projectRef, 'abcdefghijklmnopqrst');
  assert.equal(direct.platform.endpoint.passwordSecretRefId, undefined);
  assert.equal(JSON.stringify(direct).includes('sec_supabase_password'), false);

  const sessionConnection = await createConnection('session-pooler', 'session');
  const session = await service.save('workspace-a', 'tester', sourceInput(sessionConnection.id, {
    name: 'Supabase session-pooler backup',
    consistency: { requestedLevel: 'application', method: 'auto', backupMethod: 'logical', backupMode: 'full' }
  }));
  assert.equal(session.platform.endpoint.connectionMode, 'session-pooler');
  assert.equal(session.selector.databases.include[0].name, 'postgres');

  const legacyAliasConnection = await createConnection('direct', 'legacy-alias', { legacyModeAlias: true });
  const legacyAlias = await service.save('workspace-a', 'tester', sourceInput(legacyAliasConnection.id, { name: 'Supabase PostgreSQL legacy-mode connection' }));
  assert.equal(legacyAlias.platform.endpoint.connectionMode, 'direct');
  assert.equal(legacyAlias.platform.endpoint.supabaseEndpointMode, undefined);
});

test('refuses Supabase transaction-pooler, physical, WAL, and non-full Source enrollment with stable errors', async (context) => {
  const { service, createConnection, sourceInput } = await supabaseSourceFixture(context);
  const transactionConnection = await createConnection('transaction-pooler', 'transaction');
  await assert.rejects(service.save('workspace-a', 'tester', sourceInput(transactionConnection.id)), (error) => {
    assert.equal(error.code, 'POSTGRESQL_SUPABASE_TRANSACTION_POOLER_INELIGIBLE');
    assert.equal(error.message, 'Supabase transaction-pooler connections cannot be enrolled as backup Sources; use a direct or session-pooler endpoint.');
    return true;
  });

  const directConnection = await createConnection('direct', 'physical');
  const physicalRequest = sourceInput(directConnection.id, {
    consistency: { requestedLevel: 'application', method: 'pg-basebackup', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true },
    physicalExecution: { sshConnectionId: 'legacy-ssh', walArchiveDirectory: '/var/lib/postgresql/wal-archive' }
  });
  await assert.rejects(service.save('workspace-a', 'tester', physicalRequest), (error) => {
    assert.equal(error.code, 'POSTGRESQL_SUPABASE_PHYSICAL_BACKUP_UNAVAILABLE');
    assert.equal(error.message, 'Supabase backup Sources do not support physical base backups or WAL execution; use a logical full transaction snapshot.');
    return true;
  });
  await assert.rejects(service.save('workspace-a', 'tester', sourceInput(directConnection.id, {
    name: 'Supabase WAL settings', physicalExecution: { walArchiveDirectory: '/var/lib/postgresql/wal-archive' }
  })), (error) => error.code === 'POSTGRESQL_SUPABASE_PHYSICAL_BACKUP_UNAVAILABLE');
  await assert.rejects(service.save('workspace-a', 'tester', sourceInput(directConnection.id, {
    name: 'Supabase incremental',
    consistency: { requestedLevel: 'application', method: 'transaction-snapshot', backupMethod: 'logical', backupMode: 'incremental' }
  })), (error) => error.code === 'POSTGRESQL_SUPABASE_SOURCE_CONSISTENCY_INVALID');
  await assert.rejects(service.save('workspace-a', 'tester', sourceInput(directConnection.id, {
    name: 'Wrong Supabase database', selector: { databases: { include: [{ name: 'other' }] } }
  })), (error) => error.code === 'POSTGRESQL_SUPABASE_SOURCE_SELECTION_INVALID');
});

test('grandfathers existing PostgreSQL physical Sources when their connection becomes Supabase-profiled', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-supabase-legacy-source-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Legacy PostgreSQL', kind: 'database', adapterId: 'deployerx.database.postgresql.logical',
    endpoint: { host: 'db.example.com', port: 5432, database: 'postgres', maintenanceDatabase: 'postgres', username: 'backup' },
    workerAffinity: ['device:device-a'], trust: { fingerprint: 'sha256:postgresql' },
    lastTest: { status: 'success', remotePlatform: { version: '16.4' }, endpointIdentity: { systemIdentifier: '7420000000000000001' } }
  });
  const sshConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Legacy Linux', kind: 'ssh', adapterId: 'deployerx.connection.ssh',
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  });
  const service = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([postgresqlPhysicalAdapter()]), deviceId: 'device-a' });
  const request = {
    name: 'Legacy PostgreSQL physical', connectionId: connection.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'pg-basebackup', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true },
    physicalExecution: { sshConnectionId: sshConnection.id }
  };
  const legacySource = await service.save('workspace-a', 'tester', request);
  const profiledConnection = await controlDatabase.repository('connection').update('workspace-a', connection.id, {
    ...connection,
    endpoint: {
      ...connection.endpoint, host: 'db.abcdefghijklmnopqrst.supabase.co', deploymentProfile: 'supabase', connectionMode: 'direct', projectRef: 'abcdefghijklmnopqrst'
    }
  }, { expectedRevision: connection.revision, actorId: 'tester' });
  const updated = await service.save('workspace-a', 'tester', { ...request, id: legacySource.id, revision: legacySource.revision, connectionId: profiledConnection.id, name: 'Legacy physical retained' });
  assert.equal(updated.name, 'Legacy physical retained');
  assert.equal(updated.physicalExecution.engine, 'postgresql');
  assert.equal(updated.platform.endpoint.deploymentProfile, undefined);
  const updatedAgain = await service.save('workspace-a', 'tester', { ...request, id: updated.id, revision: updated.revision, connectionId: profiledConnection.id, name: 'Legacy physical still retained' });
  assert.equal(updatedAgain.name, 'Legacy physical still retained');
});

test('persists PostgreSQL whole-cluster physical execution settings for paired tested connections', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-postgresql-source-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-04T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Production PostgreSQL', kind: 'database', adapterId: 'deployerx.database.postgresql.logical',
    endpoint: { host: 'db.example.com', port: 5432, username: 'backup', maintenanceDatabase: 'postgres' },
    workerAffinity: ['device:device-a'], trust: { fingerprint: 'sha256:postgresql' },
    lastTest: { status: 'success', remotePlatform: { version: '16.4' }, endpointIdentity: { systemIdentifier: '7420000000000000001' } }
  });
  const sshConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Production Linux', kind: 'ssh', adapterId: 'deployerx.connection.ssh',
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  });
  const service = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([postgresqlPhysicalAdapter()]), deviceId: 'device-a' });
  const source = await service.save('workspace-a', 'tester', {
    name: 'Production PostgreSQL physical', connectionId: connection.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', backupMethod: 'physical', backupMode: 'full' },
    physicalExecution: { sshConnectionId: sshConnection.id, remoteTemporaryDirectory: '/var/tmp', dataDirectory: '/var/lib/postgresql/data', walArchiveDirectory: '/var/lib/postgresql/wal-archive', serviceName: 'postgresql', postgresOwner: 'postgres', postgresGroup: 'postgres' }
  });
  assert.equal(source.selector.allDatabases, true);
  assert.equal(source.physicalExecution.engine, 'postgresql');
  assert.equal(source.physicalExecution.walArchiveDirectory, '/var/lib/postgresql/wal-archive');
  assert.equal(source.physicalExecution.pgBasebackupExecutable, 'pg_basebackup');
  assert.equal(JSON.stringify(source).includes('7420000000000000001'), false);
});

test('refuses unsupported PostgreSQL versions and filtered physical selections', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-postgresql-source-refusal-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Old PostgreSQL', kind: 'database', adapterId: 'deployerx.database.postgresql.logical',
    workerAffinity: ['device:device-a'], trust: { fingerprint: 'sha256:postgresql' },
    lastTest: { status: 'success', remotePlatform: { version: '13.12' }, endpointIdentity: { systemIdentifier: '7420000000000000001' } }
  });
  const sshConnection = await controlDatabase.repository('connection').create({ workspaceId: 'workspace-a', actorId: 'tester', name: 'Linux', kind: 'ssh', adapterId: 'deployerx.connection.ssh', workerAffinity: ['device:device-a'], lastTest: { status: 'success' } });
  const service = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([postgresqlPhysicalAdapter()]), deviceId: 'device-a' });
  const request = { name: 'PostgreSQL physical', connectionId: connection.id, selector: { allDatabases: true }, consistency: { backupMethod: 'physical' }, physicalExecution: { sshConnectionId: sshConnection.id } };
  await assert.rejects(service.save('workspace-a', 'tester', request), /PostgreSQL 14 through 18/);
  const tested = await controlDatabase.repository('connection').update('workspace-a', connection.id, { ...connection, lastTest: { ...connection.lastTest, remotePlatform: { version: '14.11' } } }, { expectedRevision: connection.revision, actorId: 'tester' });
  await assert.rejects(service.save('workspace-a', 'tester', { ...request, connectionId: tested.id, selector: { databases: { include: [{ name: 'orders' }] } } }), /whole cluster/);
});

async function cassandraSourceFixture(context, options = {}) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-source-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-04T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const hostIds = [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333'
  ];
  const nodes = hostIds.map((hostId, index) => ({ hostId, address: `10.0.0.${index + 1}`, dataCenter: 'dc1', rack: `rack${index + 1}`, status: 'up', state: 'normal', tokenCount: 2, tokenDigest: `sha256:tokens-${index + 1}` }));
  const product = options.product || 'scylladb';
  const baseInventory = {
    version: 1, capturedAt: '2026-08-04T12:00:00.000Z', product, productVersion: product === 'cassandra' ? '5.0.3' : '6.2.1', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', clusterName: 'production-ring',
    clusterFingerprint: 'sha256:cluster', topologyFingerprint: 'sha256:topology', schemaVersion: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', schemaAgreement: true, incrementalBackupsEnabled: options.incrementalEnabled !== false,
    nodes, coverage: { mode: 'vnode-ring', tokenCount: 6, ringFingerprint: 'sha256:ring' },
    keyspaces: [
      { name: 'app', durableWrites: true, replication: { class: 'NetworkTopologyStrategy', dc1: '3' }, tabletsEnabled: false, system: false },
      { name: 'tablet_app', durableWrites: true, replication: { class: 'NetworkTopologyStrategy', dc1: '3' }, tabletsEnabled: true, system: false },
      { name: 'system', durableWrites: true, replication: { class: 'LocalStrategy' }, tabletsEnabled: false, system: true }
    ],
    tables: [
      { keyspace: 'app', name: 'orders', tableId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', system: false, selectable: true },
      { keyspace: 'tablet_app', name: 'events', tableId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', system: false, selectable: true },
      { keyspace: 'system', name: 'local', tableId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', system: true, selectable: false }
    ],
    derivedObjects: [{ kind: 'materialized-view', keyspace: 'app', name: 'orders_by_customer', baseTableId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', objectId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', restoreAction: 'rebuild' }]
  };
  const connections = [];
  for (const [index, hostId] of hostIds.entries()) {
    const deploymentFingerprint = `sha256:node-${index + 1}`;
    const clusterInventory = { ...structuredClone(baseInventory), localHostId: hostId, deploymentFingerprint, inventoryFingerprint: `sha256:inventory-${index + 1}` };
    connections.push(await controlDatabase.repository('connection').create({
      workspaceId: 'workspace-a', actorId: 'tester', name: `${product === 'cassandra' ? 'Cassandra' : 'Scylla'} node ${index + 1}`, kind: 'database', adapterId: 'deployerx.database.cassandra-scylla', adapterVersion: '0.1.0',
      endpoint: { expectedProduct: product, expectedClusterName: 'production-ring' }, workerAffinity: ['device:device-a'],
      trust: { fingerprint: deploymentFingerprint, topologyFingerprint: 'sha256:topology' }, lastTest: { status: 'success', endpointIdentity: { version: baseInventory.productVersion, partitioner: baseInventory.partitioner } }, clusterInventory
    }));
  }
  const sourceService = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([new CassandraScyllaAdapter()]), deviceId: 'device-a', clock: () => '2026-08-04T12:00:00.000Z' });
  const request = {
    name: `Production ${product === 'cassandra' ? 'Cassandra' : 'Scylla'} cluster`, connectionId: connections[0].id,
    selector: { databases: { include: [{ name: 'app' }] }, tables: { include: [{ database: 'app', schema: 'app', name: 'orders' }] } },
    consistency: { requestedLevel: 'crash', backupMethod: 'physical', backupMode: 'full', method: 'cassandra-native-snapshot', captureCoordinates: true },
    physicalExecution: {
      topology: 'cluster',
      nodes: hostIds.map((hostId, index) => ({
        hostId,
        connectionId: connections[index].id,
        commitLogArchive: options.commitLogEnabled ? {
          directory: '/var/lib/cassandra/commitlog-archive',
          propertiesPath: '/etc/cassandra/commitlog_archiving.properties',
          archiveCommand: 'test ! -e /var/lib/cassandra/commitlog-archive/%name && cp -- %path /var/lib/cassandra/commitlog-archive/%name',
          ownershipMarker: `workspace-a:${hostId}`,
          precision: 'MICROSECONDS',
          maximumClockSkewSeconds: 5
        } : undefined
      })),
      tableIds: [{ keyspace: 'app', name: 'orders', tableId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }]
    }
  };
  return { controlDatabase, connections, hostIds, sourceService, request };
}

test('enrolls an executable exact Cassandra/Scylla cluster Source and admits full and enabled incremental Jobs', async (context) => {
  const fixture = await cassandraSourceFixture(context);
  const source = await fixture.sourceService.save('workspace-a', 'tester', fixture.request);
  assert.equal(source.enabled, true);
  assert.equal(source.executionStatus, 'ready-for-runtime-preflight');
  assert.equal(source.lastDiscovery.consistencyStatus, 'requires-runtime-preflight');
  assert.equal(source.physicalExecution.nodes.length, 3);
  assert.equal(source.physicalExecution.tokenCount, 6);
  assert.equal(source.physicalExecution.incrementalBackupsEnabled, true);
  assert.equal(source.physicalExecution.nodes.every((node) => node.incrementalBackupsEnabled), true);
  assert.deepEqual(source.physicalExecution.tables, [{ database: 'app', schema: 'app', name: 'orders', tableId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }]);
  assert.equal(source.physicalExecution.rebuildObjects[0].name, 'orders_by_customer');
  const repository = await fixture.controlDatabase.repository('repository').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Archive', adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0', engineId: 'deployerx.file-repository', engineVersion: '1.0.0',
    workerAffinity: ['device:device-a'], health: { status: 'ready', lockState: { status: 'available' } }, location: { path: 'C:\\backup' }
  });
  const jobs = new BackupJobService({ controlDatabase: fixture.controlDatabase, deviceId: 'device-a', clock: () => '2026-08-04T12:00:00.000Z' });
  const readiness = await jobs.readiness('workspace-a');
  assert.equal(readiness.sources.find((item) => item.id === source.id).readiness.ready, true);
  const created = await jobs.create('workspace-a', 'tester', { name: 'Scylla full snapshot', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full' });
  assert.equal(created.job.state, 'enabled');
  const incremental = await jobs.create('workspace-a', 'tester', { name: 'Scylla incremental chain', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental' });
  assert.equal(incremental.job.state, 'enabled');
});

test('refuses incomplete, mismatched, stale, derived, and tablet Cassandra/Scylla enrollment', async (context) => {
  const fixture = await cassandraSourceFixture(context);
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', { ...fixture.request, physicalExecution: { ...fixture.request.physicalExecution, nodes: fixture.request.physicalExecution.nodes.slice(0, 2) } }), /every token-owning node/i);
  const rotated = fixture.request.physicalExecution.nodes.map((item, index, nodes) => ({ ...item, connectionId: nodes[(index + 1) % nodes.length].connectionId }));
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', { ...fixture.request, physicalExecution: { ...fixture.request.physicalExecution, nodes: rotated } }), /different local host ID/i);
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', { ...fixture.request, physicalExecution: { ...fixture.request.physicalExecution, tableIds: [{ keyspace: 'app', name: 'orders', tableId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }] } }), /stale or incomplete/i);
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', { ...fixture.request, selector: { databases: { include: [{ name: 'app' }] }, tables: { include: [{ database: 'app', schema: 'app', name: 'orders_by_customer' }] } }, physicalExecution: { ...fixture.request.physicalExecution, tableIds: [] } }), /Derived .* cannot be selected/i);
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', { ...fixture.request, selector: { databases: { include: [{ name: 'tablet_app' }] }, tables: { include: [{ database: 'tablet_app', schema: 'tablet_app', name: 'events' }] } }, physicalExecution: { ...fixture.request.physicalExecution, tableIds: [] } }), /uses tablets or has ambiguous tablet state/i);
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', { ...fixture.request, selector: { databases: { include: [{ name: 'system' }] } }, physicalExecution: { ...fixture.request.physicalExecution, tableIds: [] } }), /System keyspace/i);
  const repository = fixture.controlDatabase.repository('connection');
  let changed = await repository.update('workspace-a', fixture.connections[2].id, { workerAffinity: ['device:other-device'] }, { expectedRevision: fixture.connections[2].revision, actorId: 'tester' });
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', fixture.request), /must belong to this device/i);
  changed = await repository.update('workspace-a', changed.id, {
    workerAffinity: ['device:device-a'], trust: { ...changed.trust, topologyFingerprint: 'sha256:changed-topology' },
    clusterInventory: { ...changed.clusterInventory, topologyFingerprint: 'sha256:changed-topology' }
  }, { expectedRevision: changed.revision, actorId: 'tester' });
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', fixture.request), /does not match the authenticated cluster, topology, ring, and schema/i);
  changed = await repository.update('workspace-a', changed.id, {
    trust: { ...changed.trust, topologyFingerprint: 'sha256:topology' },
    clusterInventory: { ...changed.clusterInventory, topologyFingerprint: 'sha256:topology', schemaVersion: 'ffffffff-ffff-ffff-ffff-ffffffffffff', coverage: { ...changed.clusterInventory.coverage, ringFingerprint: 'sha256:changed-ring' } }
  }, { expectedRevision: changed.revision, actorId: 'tester' });
  await assert.rejects(fixture.sourceService.save('workspace-a', 'tester', fixture.request), /does not match the authenticated cluster, topology, ring, and schema/i);
});

test('refuses Cassandra/Scylla incremental Jobs unless every enrolled node enabled native incrementals', async (context) => {
  const fixture = await cassandraSourceFixture(context, { incrementalEnabled: false });
  const source = await fixture.sourceService.save('workspace-a', 'tester', fixture.request);
  assert.equal(source.physicalExecution.incrementalBackupsEnabled, false);
  const repository = await fixture.controlDatabase.repository('repository').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Archive', adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0', engineId: 'deployerx.file-repository', engineVersion: '1.0.0',
    workerAffinity: ['device:device-a'], health: { status: 'ready', lockState: { status: 'available' } }, location: { path: 'C:\\backup' }
  });
  const jobs = new BackupJobService({ controlDatabase: fixture.controlDatabase, deviceId: 'device-a', clock: () => '2026-08-04T12:00:00.000Z' });
  await assert.rejects(jobs.create('workspace-a', 'tester', { name: 'Unsafe incremental', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental' }), /enabled incremental capture/i);
});

test('enrolls Cassandra-only commit-log archives and admits bounded native PITR Jobs without persisting commands', async (context) => {
  const fixture = await cassandraSourceFixture(context, { product: 'cassandra', commitLogEnabled: true });
  const source = await fixture.sourceService.save('workspace-a', 'tester', fixture.request);
  assert.equal(source.physicalExecution.commitLogPitrEnabled, true);
  assert.equal(source.physicalExecution.nodes.every((node) => node.commitLogArchive?.precision === 'MICROSECONDS'), true);
  assert.equal(JSON.stringify(source).includes('test ! -e'), false);
  assert.equal(source.physicalExecution.nodes.every((node) => /^sha256:/.test(node.commitLogArchive.archiveCommandDigest)), true);
  const repository = await fixture.controlDatabase.repository('repository').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Archive', adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0', engineId: 'deployerx.file-repository', engineVersion: '1.0.0',
    workerAffinity: ['device:device-a'], health: { status: 'ready', lockState: { status: 'available' } }, location: { path: 'C:\\backup' }
  });
  const jobs = new BackupJobService({ controlDatabase: fixture.controlDatabase, deviceId: 'device-a', clock: () => '2026-08-04T12:00:00.000Z' });
  const created = await jobs.create('workspace-a', 'tester', { name: 'Cassandra PITR', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'native', maximumCommitLogChainLength: 720 });
  assert.equal(created.job.adapterSettings.cassandraCommitLog.maximumChainLength, 720);

  const scylla = await cassandraSourceFixture(context, { commitLogEnabled: true });
  await assert.rejects(scylla.sourceService.save('workspace-a', 'tester', scylla.request), /ScyllaDB commit-log PITR is unavailable/i);
  const partial = await cassandraSourceFixture(context, { product: 'cassandra', commitLogEnabled: true });
  partial.request.physicalExecution.nodes[0].commitLogArchive = undefined;
  await assert.rejects(partial.sourceService.save('workspace-a', 'tester', partial.request), /archive settings for every token-owning node/i);
  const duplicate = await cassandraSourceFixture(context, { product: 'cassandra', commitLogEnabled: true });
  duplicate.request.physicalExecution.nodes[1].commitLogArchive.ownershipMarker = duplicate.request.physicalExecution.nodes[0].commitLogArchive.ownershipMarker;
  await assert.rejects(duplicate.sourceService.save('workspace-a', 'tester', duplicate.request), /distinct ownership marker/i);

  const unenrolled = await cassandraSourceFixture(context, { product: 'cassandra' });
  const unenrolledSource = await unenrolled.sourceService.save('workspace-a', 'tester', unenrolled.request);
  const unenrolledRepository = await unenrolled.controlDatabase.repository('repository').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Archive', adapterId: 'deployerx.repository.local-folder', adapterVersion: '1.0.0', engineId: 'deployerx.file-repository', engineVersion: '1.0.0',
    workerAffinity: ['device:device-a'], health: { status: 'ready', lockState: { status: 'available' } }, location: { path: 'C:\\backup' }
  });
  const unenrolledJobs = new BackupJobService({ controlDatabase: unenrolled.controlDatabase, deviceId: 'device-a', clock: () => '2026-08-04T12:00:00.000Z' });
  await assert.rejects(unenrolledJobs.create('workspace-a', 'tester', { name: 'Unsafe PITR', sourceId: unenrolledSource.id, repositoryIds: [unenrolledRepository.id], backupMode: 'native' }), /Cassandra commit-log PITR Source/i);
});
