const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { CockroachDbAdapter, ADAPTER_ID: COCKROACH_ADAPTER_ID } = require('./cockroachdb');
const { normalizeDestination } = require('./cockroachdb-native');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const {
  ADAPTER_ID: ENTERPRISE_ADAPTER_ID,
  InfluxDb3EnterpriseAdapter,
  NATIVE_CONSISTENCY_METHOD
} = require('./influxdb3-enterprise');
const { CONSISTENCY_CONFIRMATIONS, CONSISTENCY_METHODS } = require('./influxdb3-enterprise-legacy');

const WORKSPACE_ID = 'workspace-bm411';
const DEVICE_ID = 'device-bm411';

async function fixture(context, adapter) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-bm411-source-job-'));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-05T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(async () => { await controlDatabase.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  const repository = await controlDatabase.repository('repository').create({
    workspaceId: WORKSPACE_ID,
    name: 'Encrypted archive',
    adapterId: 'deployerx.repository.local-folder',
    adapterVersion: '1.0.0',
    engineId: 'deployerx.file-repository',
    engineVersion: '1.0.0',
    workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', lockState: { status: 'available' } },
    location: { path: path.join(rootPath, 'repository') }
  });
  const adapterRegistry = new DatabaseAdapterRegistry([adapter]);
  return {
    controlDatabase,
    repository,
    sourceService: new DatabaseSourceService({ controlDatabase, adapterRegistry, deviceId: DEVICE_ID, clock: () => '2026-08-05T12:00:00.000Z' }),
    jobService: new BackupJobService({ controlDatabase, deviceId: DEVICE_ID, clock: () => '2026-08-05T12:00:00.000Z' }),
    rootPath
  };
}

function wholeClusterSelector() {
  return { allDatabases: true, includeGlobalObjects: false };
}

test('enrolls an exact upgraded-engine Enterprise Source and admits full Jobs only', async (context) => {
  const { controlDatabase, repository, sourceService, jobService } = await fixture(context, new InfluxDb3EnterpriseAdapter());
  const deploymentFingerprint = `sha256:${'1'.repeat(64)}`;
  const capabilityFingerprint = `sha256:${'2'.repeat(64)}`;
  const roleFingerprint = `sha256:${'3'.repeat(64)}`;
  const endpointIdentity = {
    version: '3.5.0', storageEngine: 'upgraded', clusterId: 'cluster-a', nodeId: 'compactor-a', nodeCatalogId: 7, instanceId: 'instance-a', roleFingerprint,
    deploymentFingerprint, capabilityFingerprint, compactorCapable: true, nativeBackupAvailable: true
  };
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Enterprise upgraded', kind: 'database', adapterId: ENTERPRISE_ADAPTER_ID,
    workerAffinity: [`device:${DEVICE_ID}`],
    endpoint: { expectedDeploymentFingerprint: deploymentFingerprint, expectedCapabilityFingerprint: capabilityFingerprint },
    trust: { fingerprint: deploymentFingerprint, capabilityFingerprint },
    lastTest: { status: 'success', endpointIdentity }
  });
  const source = await sourceService.save(WORKSPACE_ID, 'tester', {
    name: 'Enterprise upgraded cluster', connectionId: connection.id, selector: wholeClusterSelector(),
    consistency: { backupMethod: 'physical', backupMode: 'full', method: NATIVE_CONSISTENCY_METHOD, requestedLevel: 'application', captureCoordinates: true },
    physicalExecution: { tier: 'upgraded-native' }
  });
  assert.equal(source.physicalExecution.tier, 'upgraded-native');
  assert.equal(source.physicalExecution.connectionRevision, connection.revision);
  assert.equal((await jobService.readiness(WORKSPACE_ID)).sources.find((item) => item.id === source.id).readiness.ready, true);
  const created = await jobService.create(WORKSPACE_ID, 'tester', { name: 'Enterprise full', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full' });
  assert.equal(created.policy.backupMode, 'full');
  await assert.rejects(
    jobService.create(WORKSPACE_ID, 'tester', { name: 'Enterprise incremental', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental' }),
    /Incremental physical jobs require/
  );
});

async function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function makeLegacyStorage(root, clusterId, compactorId, dataNodeIds) {
  await write(root, `${clusterId}/catalog/0001/catalog.log`, 'catalog');
  await write(root, `${clusterId}/_catalog_checkpoint`, 'checkpoint');
  await write(root, `${clusterId}/enterprise`, 'enterprise');
  for (const nodeId of [...dataNodeIds, compactorId]) {
    await write(root, `${nodeId}/snapshots/0001/snapshot.parquet`, 'snapshot');
    await write(root, `${nodeId}/dbs/db-a/table-a/data.parquet`, 'database');
    await write(root, `${nodeId}/wal/0001/wal.log`, 'wal');
  }
  await write(root, `${compactorId}/cs/summary`, 'summary');
  await write(root, `${compactorId}/cd/detail`, 'detail');
  await write(root, `${compactorId}/c/generation/data.parquet`, 'generation');
}

test('inspects and enrolls exact legacy Enterprise filesystem identity without publishing its path in execution metadata', async (context) => {
  const { controlDatabase, sourceService, jobService, rootPath } = await fixture(context, new InfluxDb3EnterpriseAdapter());
  const clusterId = 'cluster-legacy';
  const compactorId = 'compactor-legacy';
  const dataNodeIds = ['data-01'];
  const dataRoot = path.join(rootPath, 'legacy-data');
  await fs.mkdir(dataRoot);
  await makeLegacyStorage(dataRoot, clusterId, compactorId, dataNodeIds);
  const deploymentFingerprint = `sha256:${'4'.repeat(64)}`;
  const capabilityFingerprint = `sha256:${'5'.repeat(64)}`;
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'Enterprise legacy', kind: 'database', adapterId: ENTERPRISE_ADAPTER_ID,
    workerAffinity: [`device:${DEVICE_ID}`],
    endpoint: { expectedDeploymentFingerprint: deploymentFingerprint, expectedCapabilityFingerprint: capabilityFingerprint },
    trust: { fingerprint: deploymentFingerprint, capabilityFingerprint },
    lastTest: { status: 'success', endpointIdentity: {
      version: '3.5.0', storageEngine: 'legacy-parquet', legacyParquetEngine: true, clusterId, nodeId: compactorId,
      deploymentFingerprint, capabilityFingerprint, compactorCapable: true, nativeBackupAvailable: false
    } }
  });
  const source = await sourceService.save(WORKSPACE_ID, 'tester', {
    name: 'Enterprise legacy cluster', connectionId: connection.id, selector: wholeClusterSelector(),
    consistency: { backupMethod: 'physical', backupMode: 'full', method: CONSISTENCY_METHODS.stopped, requestedLevel: 'application', captureCoordinates: false },
    physicalExecution: { tier: 'legacy-filesystem', consistencyMode: 'stopped', confirmationText: CONSISTENCY_CONFIRMATIONS.stopped, dataNodeIds },
    legacyFilesystem: { kind: 'local-filesystem', dataRoot }
  });
  assert.equal(source.physicalExecution.tier, 'legacy-filesystem');
  assert.match(source.physicalExecution.storageFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(source.physicalExecution).includes(dataRoot), false);
  assert.equal(source.legacyFilesystem.dataRoot, dataRoot);
  assert.equal((await jobService.readiness(WORKSPACE_ID)).sources.find((item) => item.id === source.id).readiness.ready, true);
});

test('enrolls a trusted CockroachDB destination and admits full and incremental Jobs while stale revisions fail closed', async (context) => {
  const { controlDatabase, repository, sourceService, jobService } = await fixture(context, new CockroachDbAdapter());
  const clusterId = '11111111-1111-4111-8111-111111111111';
  const deploymentFingerprint = `sha256:${'6'.repeat(64)}`;
  const topologyFingerprint = `sha256:${'7'.repeat(64)}`;
  const inventoryFingerprint = `sha256:${'8'.repeat(64)}`;
  const destination = normalizeDestination({ type: 'external-connection', externalConnectionName: 'private_archive' });
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'CockroachDB production', kind: 'database', adapterId: COCKROACH_ADAPTER_ID,
    workerAffinity: [`device:${DEVICE_ID}`],
    endpoint: { expectedClusterId: clusterId, expectedDeploymentFingerprint: deploymentFingerprint, expectedTopologyFingerprint: topologyFingerprint, expectedInventoryFingerprint: inventoryFingerprint },
    trust: { clusterId, fingerprint: deploymentFingerprint, topologyFingerprint, inventoryFingerprint },
    lastTest: { status: 'success', endpointIdentity: { clusterId, deploymentFingerprint, topologyFingerprint, inventoryFingerprint } },
    cockroachdbInventory: {
      clusterId, deploymentFingerprint, topologyFingerprint, inventoryFingerprint,
      externalConnections: [{ name: 'private_archive' }],
      capabilities: { backupIntoSyntax: true, detachedJobs: true, jobsVisible: true, externalConnectionsVisible: true, privilegeEvidenceVisible: true, systemPrivileges: { BACKUP: true, VIEWJOB: true, CONTROLJOB: true } }
    },
    cockroachdbBackupDestinationTrust: {
      version: 1, connectionRevision: 1, clusterId, deploymentFingerprint, topologyFingerprint, inventoryFingerprint,
      destination: { type: 'external-connection', localities: destination.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName })) },
      destinationFingerprint: destination.destinationFingerprint, localityFingerprint: destination.localityFingerprint, checkedAt: '2026-08-05T12:00:00.000Z'
    }
  });
  const source = await sourceService.save(WORKSPACE_ID, 'tester', {
    name: 'CockroachDB application', connectionId: connection.id,
    selector: { databases: { include: [{ name: 'app' }] } },
    consistency: { backupMethod: 'physical', backupMode: 'full', method: 'cockroachdb-native-backup', requestedLevel: 'application', captureCoordinates: true },
    physicalExecution: { asOfLagSeconds: 10, revisionHistory: true }
  });
  assert.equal(source.physicalExecution.engine, 'cockroachdb');
  assert.equal(source.physicalExecution.revisionHistory, true);
  assert.equal((await jobService.readiness(WORKSPACE_ID)).sources.find((item) => item.id === source.id).readiness.ready, true);
  const full = await jobService.create(WORKSPACE_ID, 'tester', { name: 'Cockroach full', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full' });
  const incremental = await jobService.create(WORKSPACE_ID, 'tester', { name: 'Cockroach incremental', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'incremental' });
  assert.equal(full.policy.backupMode, 'full');
  assert.equal(incremental.policy.backupMode, 'incremental');
  await controlDatabase.repository('connection').update(WORKSPACE_ID, connection.id, { name: 'CockroachDB production renamed' }, { expectedRevision: connection.revision, actorId: 'tester' });
  assert.equal((await jobService.readiness(WORKSPACE_ID)).sources.find((item) => item.id === source.id).readiness.ready, false);
});
