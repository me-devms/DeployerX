const assert = require('node:assert/strict');
const test = require('node:test');
const { SnapshotBrowserService, normalizeArchivePath, pathPrefixes } = require('./snapshot-browser');

const WORKSPACE_ID = 'local';

function point(id, capturedTo, snapshotId, options = {}) {
  const copies = options.copies || [{ repositoryId: 'repo-primary', engineSnapshotId: snapshotId, state: 'available', manifestLocator: `manifests/${snapshotId}`, manifestChecksum: { algorithm: 'sha256', digest: `checksum-${snapshotId}` } }];
  return {
    id, workspaceId: options.workspaceId || WORKSPACE_ID, jobId: 'job-1', sourceId: 'source-1', runId: `run-${id}`,
    type: options.type || 'incremental', consistency: 'filesystem', chainRootId: 'point-old', parentRecoveryPointId: options.parentRecoveryPointId || null,
    capturedFrom: capturedTo, capturedTo, repositoryCopies: copies,
    verification: { state: 'succeeded' }, retention: { expireAt: null }
  };
}

function manifest(snapshotId, files) {
  return { snapshotId, files };
}

function file(path, sizeBytes, digest, modifiedAt = '2026-08-01T00:00:00.000Z') {
  return { path, type: 'file', sizeBytes, contentDigest: { algorithm: 'hmac-sha256', digest }, chunks: [], metadata: { timestamps: { modifiedAt }, permissions: { mode: '0644' } } };
}

function directory(path) {
  return { path, type: 'directory', sizeBytes: 0, contentDigest: null, chunks: [], metadata: { permissions: { mode: '0755' } } };
}

function fixture(options = {}) {
  const oldPoint = point('point-old', '2026-08-01T01:00:00.000Z', 'snapshot-old', { type: 'full' });
  const middleCopies = [
    { repositoryId: 'repo-primary', engineSnapshotId: 'snapshot-middle', state: 'available', manifestLocator: 'manifests/snapshot-middle', manifestChecksum: { algorithm: 'sha256', digest: 'checksum-snapshot-middle' } },
    { repositoryId: 'repo-copy', engineSnapshotId: 'snapshot-middle-copy', state: 'available', manifestLocator: 'manifests/snapshot-middle-copy', manifestChecksum: { algorithm: 'sha256', digest: 'checksum-snapshot-middle-copy' } }
  ];
  const middlePoint = point('point-middle', '2026-08-02T01:00:00.000Z', 'snapshot-middle', { parentRecoveryPointId: oldPoint.id, copies: middleCopies });
  const latestPoint = point('point-latest', '2026-08-03T01:00:00.000Z', 'snapshot-latest', { parentRecoveryPointId: middlePoint.id });
  const foreignPoint = point('point-foreign', '2026-08-04T01:00:00.000Z', 'snapshot-foreign', { workspaceId: 'other' });
  const manifests = new Map([
    ['snapshot-old', manifest('snapshot-old', [directory('/srv'), directory('/srv/app'), file('/srv/app/report.txt', 5, 'digest-a'), file('/srv/app/metadata.txt', 4, 'digest-meta'), file('C:/Logs/system.log', 3, 'digest-system')])],
    ['snapshot-middle-copy', manifest('snapshot-middle-copy', [directory('/srv'), directory('/srv/app'), file('/srv/app/report.txt', 7, 'digest-b', '2026-08-02T00:00:00.000Z'), file('/srv/app/metadata.txt', 4, 'digest-meta', '2026-08-02T00:00:00.000Z'), file('/srv/app/new.txt', 2, 'digest-new'), file('C:/Logs/current.log', 3, 'digest-current'), file('//fileserver/share/archive.zip', 9, 'digest-archive')])],
    ['snapshot-latest', manifest('snapshot-latest', [directory('/srv'), directory('/srv/app'), file('/srv/app/metadata.txt', 4, 'digest-meta', '2026-08-02T00:00:00.000Z'), file('/srv/app/new.txt', 2, 'digest-new')])]
  ]);
  const points = [foreignPoint, latestPoint, middlePoint, oldPoint];
  const repositories = [
    { id: 'repo-primary', workspaceId: WORKSPACE_ID, name: 'Primary archive' },
    { id: 'repo-copy', workspaceId: WORKSPACE_ID, name: 'Offsite copy' }
  ];
  const artifacts = [];
  for (const recoveryPoint of points.filter((candidate) => candidate.workspaceId === WORKSPACE_ID)) {
    for (const copy of recoveryPoint.repositoryCopies) {
      artifacts.push({
        id: `artifact-${recoveryPoint.id}-${copy.repositoryId}`, workspaceId: WORKSPACE_ID, recoveryPointId: recoveryPoint.id,
        repositoryId: copy.repositoryId, kind: 'manifest', locator: copy.manifestLocator,
        checksum: copy.manifestChecksum
      });
    }
  }
  const records = {
    recoveryPoint: points,
    backupJob: [{ id: 'job-1', workspaceId: WORKSPACE_ID, name: 'Application protection' }],
    source: [{ id: 'source-1', workspaceId: WORKSPACE_ID, name: 'Application files' }],
    repository: repositories,
    artifact: artifacts
  };
  const controlDatabase = {
    repository(type) {
      return {
        async list(workspaceId, listOptions = {}) {
          return (records[type] || []).filter((record) => record.workspaceId === workspaceId).slice(0, listOptions.limit || 100);
        },
        async get(workspaceId, id) {
          return (records[type] || []).find((record) => record.workspaceId === workspaceId && record.id === id) || null;
        }
      };
    }
  };
  const openedRepositories = [];
  const openRepository = async (_workspaceId, repositoryId) => {
    openedRepositories.push(repositoryId);
    return {
      masterKey: Buffer.alloc(32, 1),
      engine: {
        async openSnapshot(_context, input) {
          if (repositoryId === 'repo-primary' && input.snapshotId === 'snapshot-middle') throw new Error('primary unavailable');
          const value = manifests.get(input.snapshotId);
          if (!value) throw new Error('snapshot unavailable');
          return {
            manifest: value,
            summary: { snapshotId: input.snapshotId, manifestKey: `manifests/${input.snapshotId}`, manifestChecksum: { algorithm: 'sha256', digest: `checksum-${input.snapshotId}` } }
          };
        }
      }
    };
  };
  const service = new SnapshotBrowserService({ controlDatabase, openRepository });
  return { service, records, openedRepositories, latestPoint, middlePoint, oldPoint, ...options };
}

test('normalizes POSIX, drive, and UNC archive paths without accepting traversal', () => {
  assert.equal(normalizeArchivePath('/srv/app/'), '/srv/app');
  assert.equal(normalizeArchivePath('C:\\Logs\\app.log'), 'C:/Logs/app.log');
  assert.equal(normalizeArchivePath('\\\\fileserver\\share\\folder'), '//fileserver/share/folder');
  assert.deepEqual(pathPrefixes('//fileserver/share/folder/report.txt'), ['//fileserver/share', '//fileserver/share/folder', '//fileserver/share/folder/report.txt']);
  assert.throws(() => normalizeArchivePath('/srv/../secret'), (error) => error.code === 'SNAPSHOT_PATH_INVALID');
});

test('lists workspace recovery points with job, source, and repository summaries', async () => {
  const { service } = fixture();
  const first = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 2 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.items.map((item) => item.id), ['point-latest', 'point-middle']);
  assert.equal(first.items[0].jobName, 'Application protection');
  assert.equal(first.items[0].sourceName, 'Application files');
  assert.equal(first.items[1].repositoryCopies[1].repositoryName, 'Offsite copy');
  const second = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), ['point-old']);
  await assert.rejects(service.listRecoveryPoints(WORKSPACE_ID, { cursor: `${first.nextCursor}x` }), (error) => error.code === 'SNAPSHOT_CURSOR_INVALID');
});

test('projects only the authenticated point-in-time window for a database log point', async () => {
  const { service, records, latestPoint, oldPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.mysql.logical', connectionId: 'connection-mysql' };
  oldPoint.type = 'full';
  oldPoint.chainRootId = oldPoint.id;
  latestPoint.type = 'log';
  latestPoint.chainRootId = oldPoint.id;
  const earliestCoordinate = { version: 1, engine: 'mysql', file: 'mysql-bin.000042', position: 8192, gtidSet: null, capturedAt: '2026-08-01T01:00:00.000Z', serverIdentityFingerprint: 'sha256:server' };
  const latestCoordinate = { ...earliestCoordinate, file: 'mysql-bin.000043', position: 7000, capturedAt: '2026-08-03T01:00:00.000Z' };
  records.artifact.push(
    { id: 'artifact-anchor-dump', workspaceId: WORKSPACE_ID, recoveryPointId: oldPoint.id, repositoryId: 'repo-primary', kind: 'database-dump', metadata: { binaryLog: { anchorCoordinate: earliestCoordinate } } },
    { id: 'artifact-terminal-log', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'transaction-log', metadata: { binaryLog: { endCoordinate: latestCoordinate, segments: [{ file: latestCoordinate.file }] }, locator: 'private/repository/locator' } }
  );
  const listed = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = listed.items.find((item) => item.id === latestPoint.id);
  assert.deepEqual(projected.pointInTime, { earliest: earliestCoordinate.capturedAt, latest: latestCoordinate.capturedAt, earliestCoordinate, latestCoordinate });
  assert.equal(JSON.stringify(projected).includes('private/repository/locator'), false);
});

test('projects MongoDB replica-set oplog bounds without repository locators', async () => {
  const { service, records, latestPoint, oldPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.mongodb.native', connectionId: 'connection-mongodb' };
  oldPoint.type = 'full';
  oldPoint.chainRootId = oldPoint.id;
  latestPoint.type = 'log';
  latestPoint.chainRootId = oldPoint.id;
  const earliestCoordinate = { version: 1, engine: 'mongodb', timestamp: { $timestamp: { t: 200, i: 1 } }, term: 1, hash: 'anchor', capturedAt: '2026-08-01T01:00:00.000Z', serverIdentityFingerprint: 'sha256:server', replicaSetId: 'replica-set-id' };
  const latestCoordinate = { ...earliestCoordinate, timestamp: { $timestamp: { t: 300, i: 2 } }, term: 2, hash: 'next', capturedAt: '2026-08-03T01:00:00.000Z' };
  records.artifact.push(
    { id: 'artifact-mongodb-anchor', workspaceId: WORKSPACE_ID, recoveryPointId: oldPoint.id, repositoryId: 'repo-primary', kind: 'database-dump', metadata: { kind: 'mongodb-logical-anchor', binaryLog: { anchorCoordinate: earliestCoordinate } } },
    { id: 'artifact-mongodb-oplog', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'transaction-log', metadata: { kind: 'mongodb-oplog', binaryLog: { endCoordinate: latestCoordinate }, locator: 'private/mongodb/oplog.bson' } }
  );
  const listed = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = listed.items.find((item) => item.id === latestPoint.id);
  assert.deepEqual(projected.pointInTime, { type: 'mongodb-oplog', earliest: earliestCoordinate.capturedAt, latest: latestCoordinate.capturedAt, replicaSetId: 'replica-set-id', earliestCoordinate, latestCoordinate });
  assert.equal(projected.backupMethod, 'logical');
  assert.equal(JSON.stringify(projected).includes('private/mongodb'), false);
});

test('projects native search snapshot identity and shard evidence without repository location data', async () => {
  const { service, records, latestPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.search.snapshot', connectionId: 'connection-search' };
  latestPoint.type = 'full';
  latestPoint.consistency = 'crash';
  records.artifact.push({
    id: 'artifact-search-snapshot', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'metadata',
    metadata: {
      kind: 'search-native-snapshot', product: 'elasticsearch', serverVersion: '9.1.2', clusterUuid: 'cluster-source', clusterName: 'production-search',
      repository: { repositoryName: 'archive', locationIdentity: 'private-location-identity' },
      snapshot: { name: 'deployerx-run-latest', uuid: 'snapshot-uuid', state: 'SUCCESS', startTimeMs: 1785837600000, endTimeMs: 1785837660000, shards: { total: 3, successful: 3, failed: 0 } },
      selectedResources: [{ kind: 'search-index', name: 'orders', uuid: 'index-uuid', primaryShards: 3 }], featureStates: ['kibana'], includeGlobalState: false
    }
  });
  const page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = page.items.find((item) => item.id === latestPoint.id);
  assert.deepEqual(projected.searchSnapshot.shards, { total: 3, successful: 3, failed: 0 });
  assert.equal(projected.searchSnapshot.snapshotUuid, 'snapshot-uuid');
  assert.equal(projected.searchSnapshot.startedAt, '2026-08-04T10:00:00.000Z');
  assert.equal(projected.searchSnapshot.completedAt, '2026-08-04T10:01:00.000Z');
  assert.deepEqual(projected.searchSnapshot.resources, [{ kind: 'search-index', name: 'orders', uuid: 'index-uuid', primaryShards: 3 }]);
  assert.equal(JSON.stringify(projected).includes('private-location-identity'), false);
});

test('projects bounded ScyllaDB Manager recovery evidence without credentials or private catalog data', async () => {
  const { service, records, latestPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.scylla-manager', connectionId: 'connection-manager' };
  latestPoint.type = 'full';
  latestPoint.consistency = 'crash';
  records.artifact.push({
    id: 'artifact-scylla-manager', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'metadata', locator: 'private/scylla-manager/backup-metadata.json',
    metadata: {
      kind: 'scylla-manager-backup', adapterId: 'deployerx.database.scylla-manager', managerVersion: '3.11.0', managedClusterId: 'cluster-source',
      deploymentFingerprint: 'private-deployment-fingerprint', clusterFingerprint: 'sha256:cluster', topologyFingerprint: 'sha256:topology', scyllaVersions: ['2025.1.3'],
      taskId: 'backup-task-001', runId: 'backup-run-001', snapshotTag: 'sm_20260804000000UTC', completedAt: '2026-08-04T00:01:00.000Z',
      target: {
        locations: [{ location: 's3:company-backups/production', scheme: 's3', locationFingerprint: 'sha256:location', accessKey: 'private-access-key' }],
        units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }], dataCenters: ['dc1'], retention: 4, retentionDays: 30, retentionLockMode: 'none'
      },
      progress: { size: 4096, uploaded: 3072, skipped: 1024, retentionDays: 30, retentionLockMode: 'none' },
      catalog: { privateRemoteLocator: 's3://private-catalog-location' }, credential: 'private-manager-credential'
    }
  });
  const page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'native');
  assert.deepEqual(projected.scyllaManager, {
    managerVersion: '3.11.0', managedClusterId: 'cluster-source', clusterFingerprint: 'sha256:cluster', topologyFingerprint: 'sha256:topology', scyllaVersions: ['2025.1.3'],
    taskId: 'backup-task-001', runId: 'backup-run-001', snapshotTag: 'sm_20260804000000UTC',
    locations: [{ location: 's3:company-backups/production', scheme: 's3', locationFingerprint: 'sha256:location' }],
    units: [{ keyspace: 'orders', tables: ['items', 'payments'], allTables: false }], dataCenters: ['dc1'], retention: 4, retentionDays: 30, retentionLockMode: 'none',
    sizeBytes: 4096, uploadedBytes: 3072, skippedBytes: 1024, completedAt: '2026-08-04T00:01:00.000Z'
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('private-deployment-fingerprint'), false);
  assert.equal(serialized.includes('private-access-key'), false);
  assert.equal(serialized.includes('private-manager-credential'), false);
  assert.equal(serialized.includes('private-catalog-location'), false);
  assert.equal(serialized.includes('private/scylla-manager'), false);
});

test('projects bounded Neo4j native recovery evidence without repository or credential data', async () => {
  const { service, records, latestPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.neo4j', connectionId: 'connection-neo4j' };
  latestPoint.type = 'full';
  latestPoint.consistency = 'application';
  records.artifact.push({
    id: 'artifact-neo4j', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'physical-backup', locator: 'private/neo4j/orders.backup',
    metadata: {
      kind: 'neo4j-enterprise-backup', adapterId: 'deployerx.database.neo4j', edition: 'enterprise', productVersion: '2026.04.1', backupMode: 'full',
      database: { name: 'orders', databaseId: 'database-orders' },
      source: { deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', password: 'private-password' },
      artifact: { nativeKind: 'neo4j-backup', nativeFileName: 'orders.backup', storeFormat: 'aligned', sizeBytes: 8192, path: '/private/stage/orders.backup' },
      transactionRange: { lowestTransactionId: 100, highestTransactionId: 450 }, metadataScope: 'database-store-and-rbac',
      aggregation: { sourceRecoveryPointIds: ['point-old', 'point-latest'], sourceMediaPreserved: true, privateStage: '/private/aggregate' },
      credential: 'private-credential'
    }
  });
  const page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.deepEqual(projected.neo4j, {
    edition: 'enterprise', productVersion: '2026.04.1', databaseName: 'orders', databaseId: 'database-orders',
    deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', backupMode: 'full', storeFormat: 'aligned',
    artifactKind: 'neo4j-backup', nativeFileName: 'orders.backup', sizeBytes: 8192, lowestTransactionId: 100, highestTransactionId: 450,
    metadataScope: 'database-store-and-rbac', includesRbac: true, aggregated: true,
    sourceRecoveryPointIds: ['point-old', 'point-latest'], sourceMediaPreserved: true
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('private/neo4j'), false);
  assert.equal(serialized.includes('/private/stage'), false);
  assert.equal(serialized.includes('private-password'), false);
  assert.equal(serialized.includes('private-credential'), false);
  assert.equal(serialized.includes('/private/aggregate'), false);
});

test('projects bounded ClickHouse native recovery evidence without disk paths or SQL', async () => {
  const { service, records, latestPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.clickhouse', connectionId: 'connection-clickhouse' };
  latestPoint.type = 'incremental';
  latestPoint.consistency = 'application';
  records.artifact.push({
    id: 'artifact-clickhouse', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'metadata', locator: 'private/clickhouse/backup-metadata.json',
    metadata: {
      kind: 'clickhouse-native-backup', adapterId: 'deployerx.database.clickhouse', productVersion: '25.8.3.66', backupMode: 'incremental', deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', restoreSupported: true,
      selection: { database: { name: 'analytics', uuid: '11111111-1111-4111-8111-111111111111' }, wholeDatabase: false, tables: [{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree' }], statistics: [{ database: 'analytics', table: 'events', rowCount: 1000, partCount: 3, partitionCount: 1 }] },
      destination: { diskName: 'backups', destinationFingerprint: 'sha256:destination', relativePath: 'private/native.zip', privatePath: '/private/backups' },
      operation: { id: 'deployerx-11111111111111111111111111111111', name: "Disk('backups', 'private/native.zip')", status: 'BACKUP_CREATED', files: 4, entries: 1, totalBytes: 4096 },
      chain: { baseOperationId: 'deployerx-00000000000000000000000000000000', baseRelativePath: 'private/base.zip' }, statement: 'private SQL'
    }
  });
  const page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.deepEqual(projected.clickhouse, {
    productVersion: '25.8.3.66', databaseName: 'analytics', databaseUuid: '11111111-1111-4111-8111-111111111111', deploymentFingerprint: 'sha256:deployment', topologyFingerprint: 'sha256:topology', backupMode: 'incremental', wholeDatabase: false,
    tables: [{ database: 'analytics', name: 'events', uuid: '22222222-2222-4222-8222-222222222222', engine: 'MergeTree' }], tableCount: 1, rowCount: 1000, partCount: 3, partitionCount: 1,
    diskName: 'backups', destinationFingerprint: 'sha256:destination', operationId: 'deployerx-11111111111111111111111111111111', operationStatus: 'BACKUP_CREATED', files: 4, entries: 1, totalBytes: 4096, baseOperationId: 'deployerx-00000000000000000000000000000000', restoreSupported: true
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('private/native.zip'), false);
  assert.equal(serialized.includes('/private/backups'), false);
  assert.equal(serialized.includes('private SQL'), false);
  assert.equal(serialized.includes("Disk('backups'"), false);
});

test('projects bounded InfluxDB recovery evidence without repository or native member paths', async () => {
  const { service, records, latestPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.influxdb', connectionId: 'connection-influxdb' };
  latestPoint.type = 'full';
  latestPoint.consistency = 'application';
  records.artifact.push({
    id: 'artifact-influxdb', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'metadata', locator: 'private/influxdb/backup-metadata.json',
    metadata: {
      kind: 'influxdb-oss-v2-native-backup', adapterId: 'deployerx.database.influxdb', backupMethod: 'physical', backupMode: 'full', tokenRecovery: 'hash-only-plaintext-unrecoverable',
      source: { product: 'influxdb-oss-v2', productVersion: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: 'sha256:deployment', inventoryFingerprint: 'sha256:inventory' },
      scope: { type: 'bucket', organizationId: '0123456789abcdef', organizationName: 'Production', bucketId: 'fedcba9876543210', bucketName: 'metrics', buckets: [{ id: 'fedcba9876543210', name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }] }] },
      nativeMedia: { fileCount: 2, totalBytes: 4096, mediaFingerprint: 'sha256:media', members: [{ path: 'influxdb/native/private.tar.gz', relativePath: 'private.tar.gz', sizeBytes: 4000, contentDigest: 'sha256:private' }] },
      artifact: { kind: 'metadata', path: 'influxdb/backup-metadata.json', mediaType: 'application/json', restoreSupported: true },
      privateStagingPath: 'C:\\private\\influxdb'
    }
  });
  const page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.deepEqual(projected.influxdb, {
    productVersion: '2.7.11', cliVersion: '2.7.5', deploymentFingerprint: 'sha256:deployment', inventoryFingerprint: 'sha256:inventory', backupMode: 'full', scope: 'bucket',
    organizationId: '0123456789abcdef', organizationName: 'Production', bucketId: 'fedcba9876543210', bucketName: 'metrics',
    buckets: [{ id: 'fedcba9876543210', name: 'metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 86400, shardGroupDurationSeconds: 3600 }] }], bucketCount: 1,
    fileCount: 2, totalBytes: 4096, mediaFingerprint: 'sha256:media', tokenRecovery: 'hash-only-plaintext-unrecoverable', restoreSupported: true
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('private.tar.gz'), false);
  assert.equal(serialized.includes('C:\\private'), false);
  assert.equal(serialized.includes('private/influxdb'), false);
});

test('projects provider-bound InfluxDB 3 Core Azure and GCS restore capabilities', async () => {
  const providers = [
    { objectStore: 'azure', kind: 'influxdb3-core-azure-full' },
    { objectStore: 'google', kind: 'influxdb3-core-gcs-full' }
  ];
  for (const provider of providers) {
    const { service, records, latestPoint } = fixture();
    records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.influxdb3-core', connectionId: `connection-core-${provider.objectStore}` };
    latestPoint.type = 'full';
    latestPoint.consistency = 'application';
    const metadata = {
      kind: provider.kind,
      adapterId: 'deployerx.database.influxdb3-core',
      backupMethod: 'physical',
      backupMode: 'full',
      source: {
        productVersion: '3.6.2', nodeId: 'node-a', objectStore: provider.objectStore,
        deploymentFingerprint: 'sha256:deployment', storageFingerprint: 'sha256:storage',
        credential: 'private-provider-credential'
      },
      capture: {
        consistencyMode: 'stopped', achievedConsistency: 'application',
        copyOrder: ['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint'],
        excluded: ['table-snapshots/'], sourceDriftPhases: []
      },
      nativeMedia: {
        fileCount: 5, directoryCount: 7, totalBytes: 12288,
        mediaFingerprint: `sha256:${'d'.repeat(64)}`, directoryFingerprint: `sha256:${'e'.repeat(64)}`,
        members: [{ path: 'private/provider/member', contentDigest: 'sha256:private' }]
      },
      artifact: { kind: 'metadata', path: 'influxdb3-core/backup-metadata.json', restoreSupported: true }
    };
    records.artifact.push({
      id: `artifact-core-${provider.objectStore}`, workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id,
      repositoryId: 'repo-primary', kind: 'metadata', locator: 'private/provider/metadata.json', metadata
    });

    let page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
    let projected = page.items.find((item) => item.id === latestPoint.id).influxdb3Core;
    assert.equal(projected.artifactKind, provider.kind);
    assert.equal(projected.objectStore, provider.objectStore);
    assert.equal(projected.restoreSupported, true);
    assert.equal(JSON.stringify(projected).includes('private'), false);

    metadata.artifact.restoreSupported = false;
    page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
    projected = page.items.find((item) => item.id === latestPoint.id).influxdb3Core;
    assert.equal(projected.restoreSupported, false);

    metadata.artifact.restoreSupported = true;
    metadata.source.objectStore = provider.objectStore === 'azure' ? 'google' : 'azure';
    page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
    projected = page.items.find((item) => item.id === latestPoint.id).influxdb3Core;
    assert.equal(projected.restoreSupported, false);
  }
});

test('projects only redacted upgraded-native InfluxDB 3 Enterprise recovery evidence', async () => {
  const { service, records, latestPoint } = fixture();
  records.source[0] = {
    ...records.source[0],
    name: 'Production Enterprise cluster',
    sourceType: 'database',
    adapterId: 'deployerx.database.influxdb3-enterprise',
    connectionId: 'connection-enterprise',
    physicalExecution: {
      tier: 'upgraded-native',
      deploymentFingerprint: 'private-source-deployment-fingerprint',
      capabilityFingerprint: 'private-source-capability-fingerprint',
      secretRefIds: ['secret-enterprise-token'],
      stagingPath: 'C:\\private\\enterprise'
    }
  };
  latestPoint.type = 'full';
  latestPoint.consistency = 'application';
  records.artifact.push({
    id: 'artifact-influxdb3-enterprise', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id,
    repositoryId: 'repo-primary', kind: 'metadata', locator: 'private/enterprise/native-backup-metadata.json',
    metadata: {
      kind: 'influxdb3-enterprise-native-backup', adapterId: 'deployerx.database.influxdb3-enterprise', engine: 'influxdb3-enterprise', backupMethod: 'physical', backupMode: 'full',
      source: {
        product: 'InfluxDB 3 Enterprise', productVersion: '3.6.1', clusterId: 'cluster-production', storageEngine: 'upgraded',
        nodeId: 'compactor-private', nodeCatalogId: 7, instanceId: 'instance-private', roleFingerprint: 'private-role-fingerprint',
        deploymentFingerprint: 'private-artifact-deployment-fingerprint', capabilityFingerprint: 'private-artifact-capability-fingerprint',
        token: 'private-enterprise-token', endpoint: 'enterprise-private.internal', dataPath: '/private/enterprise/data'
      },
      operation: { backupName: 'deployerx-native-20260805', backupType: 'full', status: 'completed', watermark: 'wal:9001', createdAt: '2026-08-05T01:00:00.000Z', completedAt: '2026-08-05T01:00:05.000Z' },
      consistency: { level: 'application', method: 'influxdb3-enterprise-native-backup', persistedDataWatermark: 'wal:9001' },
      publication: { path: 'influxdb3-enterprise/native-backup-metadata.json' },
      externalNativeMedia: { serverPath: '/private/enterprise/provider-media' },
      secretRefId: 'secret-enterprise-token'
    }
  });

  let page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  let projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.deepEqual(projected.influxdb3Enterprise, {
    tier: 'upgraded-native',
    productVersion: '3.6.1',
    clusterId: 'cluster-production',
    storageEngine: 'upgraded',
    backupMode: 'full',
    backupName: 'deployerx-native-20260805',
    backupType: 'full',
    backupStatus: 'completed',
    backupWatermark: 'wal:9001',
    createdAt: '2026-08-05T01:00:00.000Z',
    completedAt: '2026-08-05T01:00:05.000Z',
    consistencyLevel: 'application',
    restoreMode: 'in-place',
    destructive: true,
    liveCluster: true,
    wholeCluster: true,
    rollbackAvailable: false,
    providerRestoreConflictScope: 'cluster',
    rowDeleteStateCapturedByBackup: false,
    rowDeletesMayPersist: true
  });
  assert.equal(Object.hasOwn(projected, 'source'), false);
  const serialized = JSON.stringify(projected);
  for (const privateValue of [
    'private-source-deployment-fingerprint', 'private-source-capability-fingerprint', 'private-role-fingerprint',
    'private-artifact-deployment-fingerprint', 'private-artifact-capability-fingerprint', 'private-enterprise-token',
    'secret-enterprise-token', 'enterprise-private.internal', 'C:\\private\\enterprise', '/private/enterprise/data',
    '/private/enterprise/provider-media', 'private/enterprise/native-backup-metadata.json'
  ]) assert.equal(serialized.includes(privateValue), false, `RecoveryPoint leaked ${privateValue}`);

  records.source[0].physicalExecution.tier = 'legacy-filesystem';
  page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.influxdb3Enterprise, null);
  assert.equal(projected.backupMethod, 'logical');
});

test('projects only bounded CockroachDB native recovery evidence without native ownership or destination details', async () => {
  const { service, records, latestPoint } = fixture();
  records.source[0] = {
    ...records.source[0],
    name: 'Production CockroachDB',
    sourceType: 'database',
    adapterId: 'deployerx.database.cockroachdb',
    connectionId: 'connection-cockroachdb',
    physicalExecution: {
      engine: 'cockroachdb',
      destination: { externalConnectionName: 'private_archive', uri: 'external://private_archive/private-prefix' },
      binding: { deploymentFingerprint: 'private-source-deployment' }
    }
  };
  latestPoint.type = 'incremental';
  latestPoint.consistency = 'application';
  records.artifact.push({
    id: 'artifact-cockroachdb', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id,
    repositoryId: 'repo-primary', kind: 'metadata', locator: 'private/cockroachdb/backup-metadata.json',
    metadata: {
      kind: 'cockroachdb-native-backup', adapterId: 'deployerx.database.cockroachdb', engine: 'cockroachdb',
      productVersion: '25.2.3', clusterVersion: '25.2', backupMethod: 'physical', backupMode: 'incremental',
      asOfTimestamp: '2026-08-05T02:00:00.000Z', revisionHistory: true, externalNativeMedia: true,
      publicationReady: true, restoreSupported: true,
      selection: {
        scope: 'table',
        tables: [{ database: 'app', schema: 'public', name: 'events' }, { database: 'app', schema: 'audit', name: 'changes' }],
        fingerprint: `sha256:${'1'.repeat(64)}`
      },
      binding: {
        clusterId: '11111111-1111-4111-8111-111111111111',
        deploymentFingerprint: 'private-artifact-deployment', topologyFingerprint: 'private-topology', inventoryFingerprint: 'private-inventory'
      },
      destination: {
        type: 'external-connection', localityAware: true, bindingCount: 2,
        destinationFingerprint: 'private-destination-fingerprint', localityFingerprint: 'private-locality-fingerprint',
        localities: [{ locality: 'region=us-east1', externalConnectionName: 'private_archive' }],
        uri: 'external://private_archive/private-prefix'
      },
      nativeChain: {
        rootExecutionId: 'private-root-execution', headExecutionId: 'private-head-execution', incrementalCount: 3,
        destinationFingerprint: 'private-destination-fingerprint', localityFingerprint: 'private-locality-fingerprint'
      },
      chain: { parentRecoveryPointId: 'private-parent-id', chainRootRecoveryPointId: 'private-root-id', ancestorRecoveryPointIds: ['private-root-id'] },
      job: {
        status: 'succeeded', startedAt: '2026-08-05T01:59:30.000Z', finishedAt: '2026-08-05T02:00:03.000Z',
        nativeJobId: 'private-native-job-id', statement: 'BACKUP INTO private'
      },
      ownershipFingerprint: 'private-ownership-fingerprint',
      completedAt: '2026-08-05T02:00:03.000Z',
      privateCredential: 'private-cockroach-password'
    }
  });

  let page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  let projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.deepEqual(projected.cockroachdb, {
    productVersion: '25.2.3',
    clusterVersion: '25.2',
    clusterId: '11111111-1111-4111-8111-111111111111',
    backupMode: 'incremental',
    asOfTimestamp: '2026-08-05T02:00:00.000Z',
    revisionHistory: true,
    selection: {
      scope: 'table', database: null,
      tables: [{ database: 'app', schema: 'public', name: 'events' }, { database: 'app', schema: 'audit', name: 'changes' }],
      tableCount: 2
    },
    destination: { type: 'external-connection', localityAware: true, bindingCount: 2 },
    incrementalCount: 3,
    jobStatus: 'succeeded',
    startedAt: '2026-08-05T01:59:30.000Z',
    completedAt: '2026-08-05T02:00:03.000Z',
    consistencyLevel: 'application',
    restoreSupported: true,
    alternateTargetOnly: true,
    externalNativeMedia: true,
    nativeMediaDeletionSupported: false
  });
  assert.deepEqual(projected.physical, {
    backupMode: 'incremental', fromLsn: null, toLsn: null, serverVersion: '25.2.3', datadir: null, engine: 'cockroachdb', timeline: null,
    database: null, databaseUniqueName: null, recoveryModel: null, backupSetGuid: null, recoveryForkId: null, tail: false, tailMode: null,
    dbid: null, incarnation: null, resetlogsChange: null, checkpointScn: null, fromScn: null, toScn: null, firstSequence: null,
    lastSequence: null, controlFileIncluded: false, spfileIncluded: false
  });
  const serialized = JSON.stringify(projected);
  for (const privateValue of [
    'private_archive', 'external://', 'private-prefix', 'private-source-deployment', 'private-artifact-deployment',
    'private-topology', 'private-inventory', 'private-destination-fingerprint', 'private-locality-fingerprint',
    'private-root-execution', 'private-head-execution', 'private-parent-id', 'private-root-id', 'private-native-job-id',
    'BACKUP INTO private', 'private-ownership-fingerprint', 'private-cockroach-password', 'private/cockroachdb/backup-metadata.json'
  ]) assert.equal(serialized.includes(privateValue), false, `RecoveryPoint leaked ${privateValue}`);

  records.source[0].physicalExecution.engine = 'postgresql';
  page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.cockroachdb, null);
  assert.equal(projected.backupMethod, 'logical');
});

test('projects PostgreSQL base-backup and terminal WAL bounds without repository locators', async () => {
  const { service, records, latestPoint, oldPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.postgresql.logical', connectionId: 'connection-postgresql' };
  oldPoint.type = 'full';
  oldPoint.chainRootId = oldPoint.id;
  latestPoint.type = 'log';
  latestPoint.chainRootId = oldPoint.id;
  records.artifact.push(
    { id: 'artifact-postgresql-anchor', workspaceId: WORKSPACE_ID, recoveryPointId: oldPoint.id, repositoryId: 'repo-primary', kind: 'physical-backup', metadata: { kind: 'postgresql-basebackup', engine: 'postgresql', backupMode: 'full', server: { version: '16.4', dataDirectory: '/var/lib/postgresql/data' }, wal: { timeline: 1, startLsn: '0/2000000', endLsn: '0/3000000' }, locator: 'private/base.tar' } },
    { id: 'artifact-postgresql-wal', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'transaction-log', metadata: { kind: 'postgresql-wal', engine: 'postgresql', backupMode: 'incremental', server: { version: '16.4', dataDirectory: '/var/lib/postgresql/data' }, wal: { timeline: 1, startLsn: '0/3000000', endLsn: '0/6000000', firstSegment: '000000010000000000000004', lastSegment: '000000010000000000000005' }, locator: 'private/wal.tar' } }
  );
  const listed = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = listed.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.deepEqual(projected.pointInTime, { type: 'postgresql-wal', earliest: oldPoint.capturedTo, latest: latestPoint.capturedTo, timeline: 1, startLsn: '0/2000000', endLsn: '0/6000000', firstSegment: '000000010000000000000004', lastSegment: '000000010000000000000005' });
  assert.equal(projected.physical.engine, 'postgresql');
  assert.equal(JSON.stringify(projected).includes('private/'), false);
});

test('projects Cassandra commit-log UTC bounds without archive paths, segment names, or repository locators', async () => {
  const { service, records, latestPoint, oldPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.cassandra-scylla', connectionId: 'connection-cassandra' };
  oldPoint.type = 'full';
  oldPoint.chainRootId = oldPoint.id;
  latestPoint.type = 'log';
  latestPoint.chainRootId = oldPoint.id;
  latestPoint.pointInTime = { version: 1, type: 'cassandra-commit-log', earliest: '2026-08-01T01:00:00.000Z', latest: '2026-08-03T00:59:59.000Z', precision: 'MICROSECONDS', gaps: [] };
  records.artifact.push({
    id: 'artifact-cassandra-log', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'metadata', locator: 'private/cassandra/cluster-manifest.json',
    metadata: {
      kind: 'cassandra-commit-log', engine: 'cassandra-scylla', backupMode: 'native', cluster: { product: 'cassandra', name: 'production-ring' },
      commitLog: { precision: 'MICROSECONDS', recoveryWindow: { earliest: '2026-08-01T01:00:00.000Z', previous: '2026-08-02T01:00:00.000Z', latest: '2026-08-03T00:59:59.000Z' }, cursor: { safeThrough: '2026-08-03T00:59:59.000Z', nodes: [{ hostId: 'node-a', archiveDirectory: '/private/archive', segments: [{ name: 'CommitLog-7-1000.log' }] }] }, gaps: [] }
    }
  });
  const listed = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = listed.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.deepEqual(projected.pointInTime, { type: 'cassandra-commit-log', earliest: '2026-08-01T01:00:00.000Z', latest: '2026-08-03T00:59:59.000Z', precision: 'MICROSECONDS', safeThrough: '2026-08-03T00:59:59.000Z', gaps: [] });
  assert.equal(projected.physical.engine, 'cassandra-scylla');
  assert.equal(JSON.stringify(projected).includes('/private/'), false);
  assert.equal(JSON.stringify(projected).includes('CommitLog-'), false);
});

test('projects SQL Server native backup identity and LSN metadata for Recovery', async () => {
  const { service, records, latestPoint, oldPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.sqlserver.native', connectionId: 'connection-sqlserver' };
  oldPoint.type = 'full';
  oldPoint.chainRootId = oldPoint.id;
  latestPoint.type = 'log';
  latestPoint.chainRootId = oldPoint.id;
  latestPoint.pointInTime = { version: 1, type: 'sql-server-lsn', firstLsn: '190', lastLsn: '300', recoveryForkId: 'fork-a', hasBulkLoggedData: false };
  records.artifact.push({
    id: 'artifact-sqlserver-log', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'transaction-log',
    metadata: {
      kind: 'sqlserver-native', engine: 'sqlserver', backupMode: 'incremental',
      server: { version: '16.0.4175.1' }, database: { name: 'orders', recoveryModel: 'FULL' },
      backup: { type: 'log', firstLsn: '190', lastLsn: '300', backupSetGuid: 'backup-a', recoveryForkId: 'fork-a', hasBulkLoggedData: false }
    }
  });
  const page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.equal(projected.pointInTime.type, 'sql-server-lsn');
  assert.equal(projected.pointInTime.database, 'orders');
  assert.equal(projected.physical.engine, 'sqlserver');
  assert.equal(projected.physical.database, 'orders');
  assert.equal(projected.physical.recoveryModel, 'FULL');
  assert.equal(projected.physical.fromLsn, '190');
  assert.equal(projected.physical.toLsn, '300');
  assert.equal(projected.physical.recoveryForkId, 'fork-a');
});

test('projects Oracle RMAN DBID, incarnation, SCN, redo, control-file, and SPFILE evidence', async () => {
  const { service, records, latestPoint, oldPoint } = fixture();
  records.source[0] = { ...records.source[0], sourceType: 'database', adapterId: 'deployerx.database.oracle.rman', connectionId: 'connection-oracle' };
  oldPoint.type = 'full';
  oldPoint.chainRootId = oldPoint.id;
  latestPoint.type = 'log';
  latestPoint.chainRootId = oldPoint.id;
  latestPoint.pointInTime = { version: 1, type: 'oracle-scn', dbid: '1234567890', incarnation: 7, resetlogsChange: '900', checkpointScn: '1000', startScn: '1000', endScn: '1200', firstSequence: 44, lastSequence: 45 };
  records.artifact.push({
    id: 'artifact-oracle-redo', workspaceId: WORKSPACE_ID, recoveryPointId: latestPoint.id, repositoryId: 'repo-primary', kind: 'transaction-log',
    metadata: {
      kind: 'oracle-rman', engine: 'oracle', consistency: { backupMode: 'native' }, server: { version: '19.24.0.0.0' },
      database: { dbid: '1234567890', name: 'ORDERS', uniqueName: 'orders_prod', incarnation: 7, resetlogsChange: '900', logMode: 'ARCHIVELOG' },
      backup: { type: 'archived-redo', checkpointScn: '1000' }, archivedRedo: { startScn: '1000', endScn: '1200', firstSequence: 44, lastSequence: 45, startedAt: '2026-08-04T10:00:00.000Z', completedAt: '2026-08-04T12:00:00.000Z' },
      restore: { controlFileIncluded: true, spfileIncluded: false }, artifact: { path: 'private/oracle.tar' }
    }
  });
  const page = await service.listRecoveryPoints(WORKSPACE_ID, { pageSize: 10 });
  const projected = page.items.find((item) => item.id === latestPoint.id);
  assert.equal(projected.backupMethod, 'physical');
  assert.equal(projected.pointInTime.type, 'oracle-scn');
  assert.equal(projected.pointInTime.databaseUniqueName, 'orders_prod');
  assert.equal(projected.pointInTime.endScn, '1200');
  assert.equal(projected.pointInTime.earliest, '2026-08-04T10:00:00.000Z');
  assert.equal(projected.pointInTime.latest, '2026-08-04T12:00:00.000Z');
  assert.equal(projected.physical.engine, 'oracle');
  assert.equal(projected.physical.dbid, '1234567890');
  assert.equal(projected.physical.incarnation, 7);
  assert.equal(projected.physical.controlFileIncluded, true);
  assert.equal(projected.physical.spfileIncluded, false);
  assert.equal(JSON.stringify(projected).includes('private/oracle.tar'), false);
});

test('browses a virtual filesystem with bounded pages and repository-copy failover', async () => {
  const { service, middlePoint, openedRepositories } = fixture();
  const root = await service.browse(WORKSPACE_ID, { recoveryPointId: middlePoint.id, path: '', pageSize: 2 });
  assert.deepEqual(new Set(root.items.map((entry) => entry.path)), new Set(['/', '//fileserver/share']));
  assert.ok(root.nextCursor);
  const rootTail = await service.browse(WORKSPACE_ID, { recoveryPointId: middlePoint.id, path: '', pageSize: 2, cursor: root.nextCursor });
  assert.deepEqual(rootTail.items.map((entry) => entry.path), ['C:']);
  const posixRoot = await service.browse(WORKSPACE_ID, { recoveryPointId: middlePoint.id, path: '/' });
  assert.deepEqual(posixRoot.items.map((entry) => entry.path), ['/srv']);
  const application = await service.browse(WORKSPACE_ID, { recoveryPointId: middlePoint.id, path: '/srv/app' });
  assert.deepEqual(application.items.map((entry) => entry.name), ['metadata.txt', 'new.txt', 'report.txt']);
  assert.deepEqual(openedRepositories.slice(0, 2), ['repo-primary', 'repo-copy']);
  assert.equal(application.repositoryCopy.repositoryId, 'repo-copy');
  await assert.rejects(service.browse(WORKSPACE_ID, { recoveryPointId: middlePoint.id, path: '/missing' }), (error) => error.code === 'SNAPSHOT_DIRECTORY_NOT_FOUND');
});

test('searches authenticated snapshot paths with type filters and scoped cursors', async () => {
  const { service, middlePoint } = fixture();
  const result = await service.search(WORKSPACE_ID, { recoveryPointId: middlePoint.id, query: 'REPORT', type: 'file' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].path, '/srv/app/report.txt');
  assert.equal(result.items[0].sizeBytes, 7);
  assert.equal(result.items[0].modifiedAt, '2026-08-02T00:00:00.000Z');
  await assert.rejects(service.search(WORKSPACE_ID, { recoveryPointId: middlePoint.id, query: 'report', type: 'device' }), (error) => error.code === 'SNAPSHOT_SEARCH_TYPE_INVALID');
});

test('classifies added, modified, and deleted file versions across the job chain', async () => {
  const { service, middlePoint } = fixture();
  const result = await service.fileVersions(WORKSPACE_ID, { recoveryPointId: middlePoint.id, path: '/srv/app/report.txt' });
  assert.equal(result.examinedRecoveryPoints, 3);
  assert.deepEqual(result.versions.map((version) => [version.recoveryPointId, version.exists, version.change]), [
    ['point-latest', false, 'deleted'],
    ['point-middle', true, 'modified'],
    ['point-old', true, 'added']
  ]);
  assert.equal(result.versions[1].entry.sizeBytes, 7);
});

test('distinguishes metadata-only changes from unchanged file content', async () => {
  const { service, latestPoint } = fixture();
  const result = await service.fileVersions(WORKSPACE_ID, { recoveryPointId: latestPoint.id, path: '/srv/app/metadata.txt' });
  assert.deepEqual(result.versions.map((version) => version.change), ['unchanged', 'metadata-changed', 'added']);
});
