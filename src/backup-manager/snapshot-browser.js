const crypto = require('crypto');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_RECOVERY_POINTS = 1000;
const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_VERSION_POINTS = 100;
const ALLOWED_ENTRY_TYPES = new Set(['all', 'file', 'directory', 'symlink']);
const INFLUXDB3_CORE_ARTIFACT_POLICIES = Object.freeze({
  'influxdb3-core-filesystem-full': Object.freeze({ objectStore: 'file', restoreSupported: true }),
  'influxdb3-core-s3-full': Object.freeze({ objectStore: 's3', restoreSupported: true }),
  'influxdb3-core-azure-full': Object.freeze({ objectStore: 'azure', restoreSupported: true }),
  'influxdb3-core-gcs-full': Object.freeze({ objectStore: 'google', restoreSupported: true })
});
const INFLUXDB3_CORE_COPY_PHASES = Object.freeze(['snapshots', 'dbs', 'wal', 'catalog', '_catalog_checkpoint']);
const INFLUXDB3_ENTERPRISE_ADAPTER_ID = 'deployerx.database.influxdb3-enterprise';
const COCKROACHDB_ADAPTER_ID = 'deployerx.database.cockroachdb';

class SnapshotBrowserError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SnapshotBrowserError';
    this.code = code;
    this.category = options.category || 'snapshot';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new SnapshotBrowserError('SNAPSHOT_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function pageSize(value) {
  const size = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) throw new SnapshotBrowserError('SNAPSHOT_PAGE_SIZE_INVALID', `Page size must be between 1 and ${MAX_PAGE_SIZE}.`, { category: 'validation' });
  return size;
}

function normalizeArchivePath(value, options = {}) {
  const text = String(value ?? '').trim().replace(/\\/g, '/');
  if (!text && options.allowVirtualRoot) return '';
  const unc = text.startsWith('//');
  const segments = (unc ? text.slice(2) : text).split('/');
  if (!text || text.includes('\0') || text.length > 8192 || (unc ? text.slice(2).includes('//') : text.includes('//'))
    || segments.includes('..') || segments.includes('.') || (unc && (segments.length < 2 || !segments[0] || !segments[1]))) {
    throw new SnapshotBrowserError('SNAPSHOT_PATH_INVALID', 'Snapshot path is invalid.', { category: 'validation' });
  }
  if (!text.startsWith('/') && !/^[A-Za-z]:($|\/)/.test(text)) throw new SnapshotBrowserError('SNAPSHOT_PATH_INVALID', 'Snapshot path must be absolute.', { category: 'validation' });
  if (text === '/') return '/';
  return text.replace(/\/+$/, '');
}

function pathPrefixes(value) {
  const normalized = normalizeArchivePath(value);
  if (normalized === '/') return ['/'];
  if (normalized.startsWith('//')) {
    const segments = normalized.slice(2).split('/');
    const root = `//${segments[0]}/${segments[1]}`;
    return [root, ...segments.slice(2).map((_segment, index) => `${root}/${segments.slice(2, index + 3).join('/')}`)];
  }
  if (normalized.startsWith('/')) {
    const segments = normalized.slice(1).split('/');
    return ['/', ...segments.map((_segment, index) => `/${segments.slice(0, index + 1).join('/')}`)];
  }
  const segments = normalized.split('/');
  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
}

function parentPath(value) {
  const prefixes = pathPrefixes(value);
  return prefixes.length > 1 ? prefixes[prefixes.length - 2] : '';
}

function baseName(value) {
  if (value === '/') return '/';
  if (/^\/\/[^/]+\/[^/]+$/.test(value)) return value;
  const index = value.lastIndexOf('/');
  return index < 0 ? value : value.slice(index + 1);
}

function cursorSignature(scope, offset) {
  return crypto.createHash('sha256').update(`deployerx-snapshot-cursor-v1\0${scope}\0${offset}`).digest('hex').slice(0, 24);
}

function encodeCursor(scope, offset) {
  return Buffer.from(JSON.stringify({ version: 1, offset, signature: cursorSignature(scope, offset) }), 'utf8').toString('base64url');
}

function decodeCursor(value, scope) {
  if (!value) return 0;
  try {
    const encoded = requiredText(value, 'Page cursor', 2048);
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('invalid');
    const parsed = JSON.parse(decoded.toString('utf8'));
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.signature !== cursorSignature(scope, parsed.offset)) throw new Error('invalid');
    return parsed.offset;
  } catch {
    throw new SnapshotBrowserError('SNAPSHOT_CURSOR_INVALID', 'Snapshot page cursor is invalid.', { category: 'validation' });
  }
}

function metadataSummary(metadata) {
  const value = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const modifiedAt = value.timestamps?.modifiedAt || value.timestamps?.mtime || value.modifiedAt || null;
  const mode = value.permissions?.mode || value.mode || null;
  const owner = value.ownership && typeof value.ownership === 'object'
    ? { user: value.ownership.user || null, group: value.ownership.group || null, uid: value.ownership.uid ?? null, gid: value.ownership.gid ?? null }
    : null;
  return { modifiedAt, mode, owner };
}

function publicEntry(entry, options = {}) {
  const path = normalizeArchivePath(entry.path);
  const metadata = metadataSummary(entry.metadata);
  return {
    path,
    parentPath: parentPath(path),
    name: baseName(path),
    type: entry.type,
    sizeBytes: Number(entry.sizeBytes || 0),
    modifiedAt: metadata.modifiedAt,
    mode: metadata.mode,
    owner: metadata.owner,
    synthetic: Boolean(options.synthetic)
  };
}

function entryIdentity(entry) {
  if (!entry) return null;
  const metadata = metadataSummary(entry.metadata);
  const metadataDigest = entry.metadata?.digest || crypto.createHash('sha256').update(JSON.stringify(entry.metadata ?? null)).digest('hex');
  if (entry.type === 'file') return JSON.stringify({ type: entry.type, digest: entry.contentDigest?.digest || null, sizeBytes: Number(entry.sizeBytes || 0), metadataDigest, metadata });
  return JSON.stringify({ type: entry.type, metadataDigest, metadata });
}

function compareEntries(left, right) {
  const typeOrder = { directory: 0, file: 1, symlink: 2 };
  return (typeOrder[left.type] ?? 9) - (typeOrder[right.type] ?? 9)
    || left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base' })
    || left.path.localeCompare(right.path, 'en-US');
}

function corePhaseNames(value) {
  const values = Array.isArray(value) ? value : [];
  return INFLUXDB3_CORE_COPY_PHASES.filter((phase) => values.includes(phase));
}

function corePhaseEvidence(value) {
  const records = Array.isArray(value) ? value.slice(0, INFLUXDB3_CORE_COPY_PHASES.length) : [];
  return INFLUXDB3_CORE_COPY_PHASES.flatMap((phase) => {
    const record = records.find((item) => item && typeof item === 'object' && item.phase === phase);
    if (!record) return [];
    const digest = typeof record.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(record.digest)
      ? record.digest
      : typeof record.sourceInventoryDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(record.sourceInventoryDigest)
        ? record.sourceInventoryDigest
        : null;
    const fileCount = Number(record.fileCount);
    const directoryCount = Number(record.directoryCount);
    const totalBytes = Number(record.totalBytes);
    return [{
      phase,
      digest,
      fileCount: Number.isSafeInteger(fileCount) && fileCount >= 0 ? fileCount : 0,
      directoryCount: Number.isSafeInteger(directoryCount) && directoryCount >= 0 ? directoryCount : 0,
      totalBytes: Number.isSafeInteger(totalBytes) && totalBytes >= 0 ? totalBytes : 0
    }];
  });
}

function coreNonnegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function coreFingerprint(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}

function publicRecoveryPoint(point, context = {}) {
  const copies = Array.isArray(point.repositoryCopies) ? point.repositoryCopies : [];
  const repositories = context.repositories || new Map();
  const source = context.sources?.get(point.sourceId);
  const anchorPoint = context.points?.get(point.chainRootId);
  const pointArtifacts = context.artifacts?.get(point.id) || [];
  const anchorArtifacts = context.artifacts?.get(point.chainRootId) || [];
  const physicalArtifact = pointArtifacts.find((artifact) => artifact.kind === 'physical-backup' && ['mysql-xtrabackup', 'postgresql-basebackup'].includes(artifact.metadata?.kind));
  const sqlServerArtifact = pointArtifacts.find((artifact) => ['physical-backup', 'transaction-log'].includes(artifact.kind) && artifact.metadata?.kind === 'sqlserver-native');
  const oracleArtifact = pointArtifacts.find((artifact) => ['physical-backup', 'transaction-log'].includes(artifact.kind) && artifact.metadata?.kind === 'oracle-rman');
  const postgresqlWalArtifact = pointArtifacts.find((artifact) => artifact.kind === 'transaction-log' && artifact.metadata?.kind === 'postgresql-wal');
  const postgresqlAnchorArtifact = anchorArtifacts.find((artifact) => artifact.kind === 'physical-backup' && artifact.metadata?.kind === 'postgresql-basebackup');
  const mongoDbOplogArtifact = pointArtifacts.find((artifact) => artifact.kind === 'transaction-log' && artifact.metadata?.kind === 'mongodb-oplog');
  const mongoDbAnchorArtifact = anchorArtifacts.find((artifact) => artifact.kind === 'database-dump' && artifact.metadata?.kind === 'mongodb-logical-anchor');
  const searchSnapshotArtifact = pointArtifacts.find((artifact) => artifact.metadata?.kind === 'search-native-snapshot');
  const scyllaManagerArtifact = pointArtifacts.find((artifact) => artifact.kind === 'metadata' && artifact.metadata?.kind === 'scylla-manager-backup' && artifact.metadata?.adapterId === 'deployerx.database.scylla-manager');
  const neo4jArtifact = pointArtifacts.find((artifact) => ['database-dump', 'physical-backup'].includes(artifact.kind) && ['neo4j-offline-dump', 'neo4j-enterprise-backup'].includes(artifact.metadata?.kind) && artifact.metadata?.adapterId === 'deployerx.database.neo4j');
  const clickHouseArtifact = pointArtifacts.find((artifact) => artifact.kind === 'metadata' && artifact.metadata?.kind === 'clickhouse-native-backup' && artifact.metadata?.adapterId === 'deployerx.database.clickhouse');
  const influxDbArtifact = pointArtifacts.find((artifact) => artifact.kind === 'metadata' && artifact.metadata?.kind === 'influxdb-oss-v2-native-backup' && artifact.metadata?.adapterId === 'deployerx.database.influxdb');
  const influxDb3CoreArtifact = pointArtifacts.find((artifact) => artifact.kind === 'metadata' && INFLUXDB3_CORE_ARTIFACT_POLICIES[artifact.metadata?.kind] && artifact.metadata?.adapterId === 'deployerx.database.influxdb3-core');
  const influxDb3CorePolicy = influxDb3CoreArtifact ? INFLUXDB3_CORE_ARTIFACT_POLICIES[influxDb3CoreArtifact.metadata.kind] : null;
  const influxDb3EnterpriseArtifact = source?.adapterId === INFLUXDB3_ENTERPRISE_ADAPTER_ID && source?.physicalExecution?.tier === 'upgraded-native'
    ? pointArtifacts.find((artifact) => artifact.kind === 'metadata'
      && artifact.metadata?.kind === 'influxdb3-enterprise-native-backup'
      && artifact.metadata?.adapterId === INFLUXDB3_ENTERPRISE_ADAPTER_ID
      && artifact.metadata?.engine === 'influxdb3-enterprise'
      && artifact.metadata?.source?.storageEngine === 'upgraded'
      && artifact.metadata?.operation?.backupName)
    : null;
  const cockroachDbArtifact = source?.adapterId === COCKROACHDB_ADAPTER_ID && source?.physicalExecution?.engine === 'cockroachdb'
    ? pointArtifacts.find((artifact) => artifact.kind === 'metadata'
      && artifact.metadata?.kind === 'cockroachdb-native-backup'
      && artifact.metadata?.adapterId === COCKROACHDB_ADAPTER_ID
      && artifact.metadata?.engine === 'cockroachdb'
      && artifact.metadata?.backupMethod === 'physical'
      && ['full', 'incremental'].includes(artifact.metadata?.backupMode)
      && artifact.metadata?.externalNativeMedia === true
      && artifact.metadata?.publicationReady === true)
    : null;
  const cassandraArtifact = pointArtifacts.find((artifact) => artifact.kind === 'metadata' && artifact.metadata?.engine === 'cassandra-scylla' && artifact.metadata?.commitLog?.cursor);
  const selectedPhysicalArtifact = physicalArtifact || postgresqlWalArtifact || sqlServerArtifact || oracleArtifact || cassandraArtifact || scyllaManagerArtifact || neo4jArtifact || clickHouseArtifact || influxDbArtifact || influxDb3CoreArtifact || influxDb3EnterpriseArtifact || cockroachDbArtifact;
  const terminalBinaryLog = point.pointInTime?.endCoordinate
    ? point.pointInTime
    : pointArtifacts.find((artifact) => artifact.kind === 'transaction-log' && artifact.metadata?.binaryLog?.endCoordinate)?.metadata?.binaryLog;
  const anchorBinaryLog = anchorPoint?.pointInTime?.anchorCoordinate
    ? anchorPoint.pointInTime
    : anchorArtifacts.find((artifact) => artifact.kind === 'database-dump' && artifact.metadata?.binaryLog?.anchorCoordinate)?.metadata?.binaryLog;
  const pointInTime = cassandraArtifact
    ? {
        type: 'cassandra-commit-log',
        earliest: cassandraArtifact.metadata.commitLog.recoveryWindow?.earliest || point.pointInTime?.earliest || null,
        latest: cassandraArtifact.metadata.commitLog.recoveryWindow?.latest || point.pointInTime?.latest || null,
        precision: cassandraArtifact.metadata.commitLog.precision || point.pointInTime?.precision || null,
        safeThrough: cassandraArtifact.metadata.commitLog.cursor?.safeThrough || null,
        gaps: structuredClone(cassandraArtifact.metadata.commitLog.gaps || [])
      }
    : mongoDbOplogArtifact && mongoDbAnchorArtifact
    ? {
        type: 'mongodb-oplog',
        earliest: mongoDbAnchorArtifact.metadata.binaryLog?.anchorCoordinate?.capturedAt || anchorPoint?.capturedTo || null,
        latest: mongoDbOplogArtifact.metadata.binaryLog?.endCoordinate?.capturedAt || point.capturedTo || null,
        replicaSetId: mongoDbOplogArtifact.metadata.binaryLog?.endCoordinate?.replicaSetId || mongoDbAnchorArtifact.metadata.binaryLog?.anchorCoordinate?.replicaSetId || null,
        earliestCoordinate: structuredClone(mongoDbAnchorArtifact.metadata.binaryLog?.anchorCoordinate || null),
        latestCoordinate: structuredClone(mongoDbOplogArtifact.metadata.binaryLog?.endCoordinate || null)
      }
    : sqlServerArtifact
    ? {
        ...structuredClone(point.pointInTime || {}),
        type: 'sql-server-lsn',
        database: sqlServerArtifact.metadata.database?.name || null,
        recoveryModel: sqlServerArtifact.metadata.database?.recoveryModel || null,
        backupType: sqlServerArtifact.metadata.backup?.type || point.type,
        backupSetGuid: sqlServerArtifact.metadata.backup?.backupSetGuid || null,
        firstLsn: sqlServerArtifact.metadata.backup?.firstLsn || point.pointInTime?.firstLsn || null,
        lastLsn: sqlServerArtifact.metadata.backup?.lastLsn || point.pointInTime?.lastLsn || null,
        recoveryForkId: sqlServerArtifact.metadata.backup?.recoveryForkId || point.pointInTime?.recoveryForkId || null,
        hasBulkLoggedData: Boolean(sqlServerArtifact.metadata.backup?.hasBulkLoggedData || point.pointInTime?.hasBulkLoggedData)
      }
    : oracleArtifact
    ? {
        ...structuredClone(point.pointInTime || {}),
        type: 'oracle-scn',
        database: oracleArtifact.metadata.database?.name || null,
        databaseUniqueName: oracleArtifact.metadata.database?.uniqueName || null,
        dbid: oracleArtifact.metadata.database?.dbid || point.pointInTime?.dbid || null,
        incarnation: oracleArtifact.metadata.database?.incarnation || point.pointInTime?.incarnation || null,
        resetlogsChange: oracleArtifact.metadata.database?.resetlogsChange || point.pointInTime?.resetlogsChange || null,
        backupType: oracleArtifact.metadata.backup?.type || point.type,
        checkpointScn: oracleArtifact.metadata.backup?.checkpointScn || point.pointInTime?.checkpointScn || null,
        startScn: oracleArtifact.metadata.archivedRedo?.startScn || point.pointInTime?.startScn || null,
        endScn: oracleArtifact.metadata.archivedRedo?.endScn || point.pointInTime?.endScn || null,
        firstSequence: oracleArtifact.metadata.archivedRedo?.firstSequence || point.pointInTime?.firstSequence || null,
        lastSequence: oracleArtifact.metadata.archivedRedo?.lastSequence || point.pointInTime?.lastSequence || null,
        earliest: oracleArtifact.metadata.archivedRedo?.startedAt || point.pointInTime?.earliest || null,
        latest: oracleArtifact.metadata.archivedRedo?.completedAt || point.pointInTime?.latest || null
      }
    : point.type === 'log' && postgresqlWalArtifact && postgresqlAnchorArtifact
    ? {
        type: 'postgresql-wal',
        earliest: anchorPoint?.capturedTo || anchorPoint?.capturedFrom || null,
        latest: point.capturedTo || null,
        timeline: postgresqlWalArtifact.metadata.wal?.timeline || null,
        startLsn: postgresqlAnchorArtifact.metadata.wal?.startLsn || null,
        endLsn: postgresqlWalArtifact.metadata.wal?.endLsn || postgresqlAnchorArtifact.metadata.wal?.endLsn || null,
        firstSegment: postgresqlWalArtifact.metadata.wal?.firstSegment || null,
        lastSegment: postgresqlWalArtifact.metadata.wal?.lastSegment || null
      }
    : point.type === 'log' && terminalBinaryLog && anchorBinaryLog
    ? {
        earliest: anchorBinaryLog.anchorCoordinate.capturedAt,
        latest: terminalBinaryLog.endCoordinate.capturedAt,
        earliestCoordinate: structuredClone(anchorBinaryLog.anchorCoordinate),
        latestCoordinate: structuredClone(terminalBinaryLog.endCoordinate)
      }
    : null;
  return {
    id: point.id,
    jobId: point.jobId,
    jobName: context.jobs?.get(point.jobId)?.name || 'Unavailable job',
    sourceId: point.sourceId,
    sourceName: source?.name || 'Unavailable source',
    sourceConnectionId: source?.connectionId || null,
    sourceType: source?.sourceType || null,
    sourceAdapterId: source?.adapterId || null,
    runId: point.runId,
    type: point.type,
    consistency: point.consistency,
    chainRootId: point.chainRootId,
    parentRecoveryPointId: point.parentRecoveryPointId || null,
    capturedFrom: point.capturedFrom,
    capturedTo: point.capturedTo,
    pointInTime,
    backupMethod: searchSnapshotArtifact || scyllaManagerArtifact ? 'native' : selectedPhysicalArtifact ? 'physical' : 'logical',
    searchSnapshot: searchSnapshotArtifact ? {
      product: searchSnapshotArtifact.metadata.product || null,
      serverVersion: searchSnapshotArtifact.metadata.serverVersion || null,
      clusterUuid: searchSnapshotArtifact.metadata.clusterUuid || null,
      clusterName: searchSnapshotArtifact.metadata.clusterName || null,
      repositoryName: searchSnapshotArtifact.metadata.repository?.repositoryName || null,
      snapshotName: searchSnapshotArtifact.metadata.snapshot?.name || null,
      snapshotUuid: searchSnapshotArtifact.metadata.snapshot?.uuid || null,
      snapshotState: searchSnapshotArtifact.metadata.snapshot?.state || null,
      shards: structuredClone(searchSnapshotArtifact.metadata.snapshot?.shards || null),
      startedAt: Number.isSafeInteger(searchSnapshotArtifact.metadata.snapshot?.startTimeMs) ? new Date(searchSnapshotArtifact.metadata.snapshot.startTimeMs).toISOString() : null,
      completedAt: Number.isSafeInteger(searchSnapshotArtifact.metadata.snapshot?.endTimeMs) ? new Date(searchSnapshotArtifact.metadata.snapshot.endTimeMs).toISOString() : null,
      resources: (searchSnapshotArtifact.metadata.selectedResources || []).map((resource) => ({ kind: resource.kind, name: resource.name, uuid: resource.uuid, primaryShards: resource.primaryShards })),
      featureStates: [...(searchSnapshotArtifact.metadata.featureStates || [])],
      includeGlobalState: Boolean(searchSnapshotArtifact.metadata.includeGlobalState)
    } : null,
    scyllaManager: scyllaManagerArtifact ? {
      managerVersion: scyllaManagerArtifact.metadata.managerVersion || null,
      managedClusterId: scyllaManagerArtifact.metadata.managedClusterId || null,
      clusterFingerprint: scyllaManagerArtifact.metadata.clusterFingerprint || null,
      topologyFingerprint: scyllaManagerArtifact.metadata.topologyFingerprint || null,
      scyllaVersions: [...(scyllaManagerArtifact.metadata.scyllaVersions || [])],
      taskId: scyllaManagerArtifact.metadata.taskId || null,
      runId: scyllaManagerArtifact.metadata.runId || null,
      snapshotTag: scyllaManagerArtifact.metadata.snapshotTag || null,
      locations: (scyllaManagerArtifact.metadata.target?.locations || []).map((item) => ({ location: item.location, scheme: item.scheme, locationFingerprint: item.locationFingerprint })),
      units: (scyllaManagerArtifact.metadata.target?.units || []).map((item) => ({ keyspace: item.keyspace, tables: [...(item.tables || [])], allTables: Boolean(item.allTables) })),
      dataCenters: [...(scyllaManagerArtifact.metadata.target?.dataCenters || [])],
      retention: scyllaManagerArtifact.metadata.target?.retention ?? null,
      retentionDays: scyllaManagerArtifact.metadata.progress?.retentionDays ?? scyllaManagerArtifact.metadata.target?.retentionDays ?? null,
      retentionLockMode: scyllaManagerArtifact.metadata.progress?.retentionLockMode || scyllaManagerArtifact.metadata.target?.retentionLockMode || null,
      sizeBytes: Number(scyllaManagerArtifact.metadata.progress?.size || 0),
      uploadedBytes: Number(scyllaManagerArtifact.metadata.progress?.uploaded || 0),
      skippedBytes: Number(scyllaManagerArtifact.metadata.progress?.skipped || 0),
      completedAt: scyllaManagerArtifact.metadata.completedAt || null
    } : null,
    neo4j: neo4jArtifact ? {
      edition: neo4jArtifact.metadata.edition || null,
      productVersion: neo4jArtifact.metadata.productVersion || null,
      databaseName: neo4jArtifact.metadata.database?.name || null,
      databaseId: neo4jArtifact.metadata.database?.databaseId || null,
      deploymentFingerprint: neo4jArtifact.metadata.source?.deploymentFingerprint || null,
      topologyFingerprint: neo4jArtifact.metadata.source?.topologyFingerprint || null,
      backupMode: neo4jArtifact.metadata.backupMode || point.type,
      storeFormat: neo4jArtifact.metadata.artifact?.storeFormat || null,
      artifactKind: neo4jArtifact.metadata.artifact?.nativeKind || neo4jArtifact.metadata.artifact?.kind || neo4jArtifact.kind,
      nativeFileName: neo4jArtifact.metadata.artifact?.nativeFileName || null,
      sizeBytes: Number(neo4jArtifact.metadata.artifact?.sizeBytes || neo4jArtifact.sizeBytes || 0),
      lowestTransactionId: Number.isSafeInteger(neo4jArtifact.metadata.transactionRange?.lowestTransactionId) ? neo4jArtifact.metadata.transactionRange.lowestTransactionId : null,
      highestTransactionId: Number.isSafeInteger(neo4jArtifact.metadata.transactionRange?.highestTransactionId) ? neo4jArtifact.metadata.transactionRange.highestTransactionId : null,
      metadataScope: neo4jArtifact.metadata.metadataScope || null,
      includesRbac: neo4jArtifact.metadata.metadataScope === 'database-store-and-rbac',
      aggregated: Boolean(neo4jArtifact.metadata.aggregation),
      sourceRecoveryPointIds: [...(neo4jArtifact.metadata.aggregation?.sourceRecoveryPointIds || [])],
      sourceMediaPreserved: neo4jArtifact.metadata.aggregation?.sourceMediaPreserved === true
    } : null,
    clickhouse: clickHouseArtifact ? {
      productVersion: clickHouseArtifact.metadata.productVersion || null,
      databaseName: clickHouseArtifact.metadata.selection?.database?.name || null,
      databaseUuid: clickHouseArtifact.metadata.selection?.database?.uuid || null,
      deploymentFingerprint: clickHouseArtifact.metadata.deploymentFingerprint || null,
      topologyFingerprint: clickHouseArtifact.metadata.topologyFingerprint || null,
      backupMode: clickHouseArtifact.metadata.backupMode || point.type,
      wholeDatabase: clickHouseArtifact.metadata.selection?.wholeDatabase === true,
      tables: (clickHouseArtifact.metadata.selection?.tables || []).map((table) => ({ database: table.database, name: table.name, uuid: table.uuid, engine: table.engine })),
      tableCount: (clickHouseArtifact.metadata.selection?.tables || []).length,
      rowCount: (clickHouseArtifact.metadata.selection?.statistics || []).reduce((sum, item) => sum + Number(item.rowCount || 0), 0),
      partCount: (clickHouseArtifact.metadata.selection?.statistics || []).reduce((sum, item) => sum + Number(item.partCount || 0), 0),
      partitionCount: (clickHouseArtifact.metadata.selection?.statistics || []).reduce((sum, item) => sum + Number(item.partitionCount || 0), 0),
      diskName: clickHouseArtifact.metadata.destination?.diskName || null,
      destinationFingerprint: clickHouseArtifact.metadata.destination?.destinationFingerprint || null,
      operationId: clickHouseArtifact.metadata.operation?.id || null,
      operationStatus: clickHouseArtifact.metadata.operation?.status || null,
      files: Number(clickHouseArtifact.metadata.operation?.files || 0),
      entries: Number(clickHouseArtifact.metadata.operation?.entries || 0),
      totalBytes: Number(clickHouseArtifact.metadata.operation?.totalBytes || 0),
      baseOperationId: clickHouseArtifact.metadata.chain?.baseOperationId || null,
      restoreSupported: clickHouseArtifact.metadata.restoreSupported === true
    } : null,
    influxdb: influxDbArtifact ? {
      productVersion: influxDbArtifact.metadata.source?.productVersion || null,
      cliVersion: influxDbArtifact.metadata.source?.cliVersion || null,
      deploymentFingerprint: influxDbArtifact.metadata.source?.deploymentFingerprint || null,
      inventoryFingerprint: influxDbArtifact.metadata.source?.inventoryFingerprint || null,
      backupMode: influxDbArtifact.metadata.backupMode || point.type,
      scope: influxDbArtifact.metadata.scope?.type || null,
      organizationId: influxDbArtifact.metadata.scope?.organizationId || null,
      organizationName: influxDbArtifact.metadata.scope?.organizationName || null,
      bucketId: influxDbArtifact.metadata.scope?.bucketId || null,
      bucketName: influxDbArtifact.metadata.scope?.bucketName || null,
      buckets: (influxDbArtifact.metadata.scope?.buckets || []).map((bucket) => ({ id: bucket.id, name: bucket.name, type: bucket.type, schemaType: bucket.schemaType || null, retentionRules: structuredClone(bucket.retentionRules || []) })),
      bucketCount: (influxDbArtifact.metadata.scope?.buckets || []).length,
      fileCount: Number(influxDbArtifact.metadata.nativeMedia?.fileCount || 0),
      totalBytes: Number(influxDbArtifact.metadata.nativeMedia?.totalBytes || 0),
      mediaFingerprint: influxDbArtifact.metadata.nativeMedia?.mediaFingerprint || null,
      tokenRecovery: influxDbArtifact.metadata.tokenRecovery || null,
      restoreSupported: influxDbArtifact.metadata.artifact?.restoreSupported === true
    } : null,
    influxdb3Core: influxDb3CoreArtifact ? {
      artifactKind: influxDb3CoreArtifact.metadata.kind,
      productVersion: influxDb3CoreArtifact.metadata.source?.productVersion || null,
      nodeId: influxDb3CoreArtifact.metadata.source?.nodeId || null,
      objectStore: influxDb3CorePolicy.objectStore,
      deploymentFingerprint: influxDb3CoreArtifact.metadata.source?.deploymentFingerprint || null,
      storageFingerprint: influxDb3CoreArtifact.metadata.source?.storageFingerprint || null,
      backupMode: influxDb3CoreArtifact.metadata.backupMode || point.type,
      consistencyMode: influxDb3CoreArtifact.metadata.capture?.consistencyMode || null,
      achievedConsistency: influxDb3CoreArtifact.metadata.capture?.achievedConsistency || point.consistency,
      copyOrder: corePhaseNames(influxDb3CoreArtifact.metadata.capture?.copyOrder),
      excluded: Array.isArray(influxDb3CoreArtifact.metadata.capture?.excluded) && influxDb3CoreArtifact.metadata.capture.excluded.includes('table-snapshots/') ? ['table-snapshots/'] : [],
      phaseEvidence: corePhaseEvidence(influxDb3CoreArtifact.metadata.capture?.phaseEvidence),
      sourceDriftPhases: corePhaseNames(influxDb3CoreArtifact.metadata.capture?.sourceDriftPhases),
      fileCount: coreNonnegativeInteger(influxDb3CoreArtifact.metadata.nativeMedia?.fileCount),
      directoryCount: coreNonnegativeInteger(influxDb3CoreArtifact.metadata.nativeMedia?.directoryCount),
      totalBytes: coreNonnegativeInteger(influxDb3CoreArtifact.metadata.nativeMedia?.totalBytes),
      mediaFingerprint: coreFingerprint(influxDb3CoreArtifact.metadata.nativeMedia?.mediaFingerprint),
      directoryFingerprint: coreFingerprint(influxDb3CoreArtifact.metadata.nativeMedia?.directoryFingerprint),
      restoreSupported: influxDb3CorePolicy.restoreSupported
        && influxDb3CoreArtifact.metadata.source?.objectStore === influxDb3CorePolicy.objectStore
        && influxDb3CoreArtifact.metadata.artifact?.restoreSupported === true,
      automaticStartup: false,
      ownershipReviewRequired: influxDb3CoreArtifact.metadata.source?.objectStore === 'file',
      operatorReviewRequired: true
    } : null,
    influxdb3Enterprise: influxDb3EnterpriseArtifact ? {
      tier: 'upgraded-native',
      productVersion: influxDb3EnterpriseArtifact.metadata.source?.productVersion || null,
      clusterId: influxDb3EnterpriseArtifact.metadata.source?.clusterId || null,
      storageEngine: 'upgraded',
      backupMode: influxDb3EnterpriseArtifact.metadata.backupMode || point.type,
      backupName: influxDb3EnterpriseArtifact.metadata.operation?.backupName || null,
      backupType: influxDb3EnterpriseArtifact.metadata.operation?.backupType || point.type,
      backupStatus: influxDb3EnterpriseArtifact.metadata.operation?.status || null,
      backupWatermark: influxDb3EnterpriseArtifact.metadata.operation?.watermark || influxDb3EnterpriseArtifact.metadata.consistency?.persistedDataWatermark || null,
      createdAt: influxDb3EnterpriseArtifact.metadata.operation?.createdAt || point.capturedFrom || null,
      completedAt: influxDb3EnterpriseArtifact.metadata.operation?.completedAt || point.capturedTo || null,
      consistencyLevel: influxDb3EnterpriseArtifact.metadata.consistency?.level || point.consistency,
      restoreMode: 'in-place',
      destructive: true,
      liveCluster: true,
      wholeCluster: true,
      rollbackAvailable: false,
      providerRestoreConflictScope: 'cluster',
      rowDeleteStateCapturedByBackup: false,
      rowDeletesMayPersist: true
    } : null,
    cockroachdb: cockroachDbArtifact ? {
      productVersion: cockroachDbArtifact.metadata.productVersion || null,
      clusterVersion: cockroachDbArtifact.metadata.clusterVersion || null,
      clusterId: cockroachDbArtifact.metadata.binding?.clusterId || null,
      backupMode: cockroachDbArtifact.metadata.backupMode,
      asOfTimestamp: cockroachDbArtifact.metadata.asOfTimestamp || point.capturedTo || null,
      revisionHistory: cockroachDbArtifact.metadata.revisionHistory === true,
      selection: {
        scope: cockroachDbArtifact.metadata.selection?.scope || null,
        database: cockroachDbArtifact.metadata.selection?.scope === 'database' ? cockroachDbArtifact.metadata.selection.database || null : null,
        tables: cockroachDbArtifact.metadata.selection?.scope === 'table'
          ? (cockroachDbArtifact.metadata.selection.tables || []).slice(0, 100).map((table) => ({ database: table.database, schema: table.schema, name: table.name }))
          : [],
        tableCount: cockroachDbArtifact.metadata.selection?.scope === 'table' ? Math.min((cockroachDbArtifact.metadata.selection.tables || []).length, 100) : 0
      },
      destination: {
        type: cockroachDbArtifact.metadata.destination?.type === 'external-connection' ? 'external-connection' : null,
        localityAware: cockroachDbArtifact.metadata.destination?.localityAware === true,
        bindingCount: Number.isSafeInteger(cockroachDbArtifact.metadata.destination?.bindingCount) ? cockroachDbArtifact.metadata.destination.bindingCount : 0
      },
      incrementalCount: Number.isSafeInteger(cockroachDbArtifact.metadata.nativeChain?.incrementalCount) ? cockroachDbArtifact.metadata.nativeChain.incrementalCount : 0,
      jobStatus: cockroachDbArtifact.metadata.job?.status || null,
      startedAt: cockroachDbArtifact.metadata.job?.startedAt || null,
      completedAt: cockroachDbArtifact.metadata.completedAt || point.capturedTo || null,
      consistencyLevel: point.consistency,
      restoreSupported: cockroachDbArtifact.metadata.restoreSupported === true,
      alternateTargetOnly: true,
      externalNativeMedia: true,
      nativeMediaDeletionSupported: false
    } : null,
    physical: selectedPhysicalArtifact ? {
      backupMode: selectedPhysicalArtifact.metadata.backupMode || selectedPhysicalArtifact.metadata.consistency?.backupMode || null,
      fromLsn: sqlServerArtifact?.metadata.backup?.firstLsn || physicalArtifact?.metadata.checkpoints?.fromLsn || postgresqlAnchorArtifact?.metadata.wal?.startLsn || null,
      toLsn: sqlServerArtifact?.metadata.backup?.lastLsn || physicalArtifact?.metadata.checkpoints?.toLsn || postgresqlWalArtifact?.metadata.wal?.lastSegment || physicalArtifact?.metadata.wal?.endLsn || null,
      serverVersion: selectedPhysicalArtifact.metadata.server?.version || selectedPhysicalArtifact.metadata.cluster?.version || cockroachDbArtifact?.metadata.productVersion || null,
      datadir: selectedPhysicalArtifact.metadata.server?.datadir || selectedPhysicalArtifact.metadata.server?.dataDirectory || null,
      engine: selectedPhysicalArtifact.metadata.engine || null,
      timeline: selectedPhysicalArtifact.metadata.wal?.timeline || null,
      database: sqlServerArtifact?.metadata.database?.name || oracleArtifact?.metadata.database?.name || null,
      databaseUniqueName: oracleArtifact?.metadata.database?.uniqueName || null,
      recoveryModel: sqlServerArtifact?.metadata.database?.recoveryModel || oracleArtifact?.metadata.database?.logMode || null,
      backupSetGuid: sqlServerArtifact?.metadata.backup?.backupSetGuid || null,
      recoveryForkId: sqlServerArtifact?.metadata.backup?.recoveryForkId || null,
      tail: Boolean(sqlServerArtifact?.metadata.backup?.tail),
      tailMode: sqlServerArtifact?.metadata.backup?.tailMode || null,
      dbid: oracleArtifact?.metadata.database?.dbid || null,
      incarnation: oracleArtifact?.metadata.database?.incarnation || null,
      resetlogsChange: oracleArtifact?.metadata.database?.resetlogsChange || null,
      checkpointScn: oracleArtifact?.metadata.backup?.checkpointScn || null,
      fromScn: oracleArtifact?.metadata.archivedRedo?.startScn || null,
      toScn: oracleArtifact?.metadata.archivedRedo?.endScn || null,
      firstSequence: oracleArtifact?.metadata.archivedRedo?.firstSequence || null,
      lastSequence: oracleArtifact?.metadata.archivedRedo?.lastSequence || null,
      controlFileIncluded: Boolean(oracleArtifact?.metadata.restore?.controlFileIncluded),
      spfileIncluded: Boolean(oracleArtifact?.metadata.restore?.spfileIncluded)
    } : null,
    verification: structuredClone(point.verification || null),
    retention: structuredClone(point.retention || null),
    repositoryCopies: copies.map((copy) => ({
      repositoryId: copy.repositoryId,
      repositoryName: repositories.get(copy.repositoryId)?.name || 'Unavailable repository',
      state: copy.state,
      immutableUntil: copy.immutableUntil || null
    })),
    availableCopyCount: copies.filter((copy) => copy.state === 'available').length,
    totalCopyCount: copies.length
  };
}

class SnapshotBrowserService {
  constructor({ controlDatabase, openRepository } = {}) {
    if (!controlDatabase || typeof openRepository !== 'function') throw new TypeError('Control database and repository opener are required.');
    this.controlDatabase = controlDatabase;
    this.openRepository = openRepository;
  }

  async listRecoveryPoints(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const limit = pageSize(input.pageSize);
    const jobId = input.jobId ? requiredText(input.jobId, 'Job ID', 200) : null;
    const sourceId = input.sourceId ? requiredText(input.sourceId, 'Source ID', 200) : null;
    const [points, jobs, sources, repositories, artifacts] = await Promise.all([
      this.controlDatabase.repository('recoveryPoint').list(tenant, { limit: MAX_RECOVERY_POINTS }),
      this.controlDatabase.repository('backupJob').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('source').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('repository').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('artifact').list(tenant, { limit: 10000 })
    ]);
    const filtered = points.filter((point) => (!jobId || point.jobId === jobId) && (!sourceId || point.sourceId === sourceId));
    const scope = `points:${tenant}:${jobId || '*'}:${sourceId || '*'}`;
    const offset = decodeCursor(input.cursor, scope);
    const context = {
      jobs: new Map(jobs.map((record) => [record.id, record])),
      sources: new Map(sources.map((record) => [record.id, record])),
      points: new Map(points.map((record) => [record.id, record])),
      repositories: new Map(repositories.map((record) => [record.id, record])),
      artifacts: artifacts.reduce((byPoint, artifact) => {
        if (!byPoint.has(artifact.recoveryPointId)) byPoint.set(artifact.recoveryPointId, []);
        byPoint.get(artifact.recoveryPointId).push(artifact);
        return byPoint;
      }, new Map())
    };
    return {
      items: filtered.slice(offset, offset + limit).map((point) => publicRecoveryPoint(point, context)),
      nextCursor: offset + limit < filtered.length ? encodeCursor(scope, offset + limit) : null,
      total: filtered.length
    };
  }

  async browse(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recoveryPointId = requiredText(input.recoveryPointId, 'Recovery point ID', 200);
    const directory = normalizeArchivePath(input.path, { allowVirtualRoot: true });
    const limit = pageSize(input.pageSize);
    const opened = await this.#openById(tenant, recoveryPointId);
    const manifestEntries = opened.manifest.files;
    if (directory) {
      const exact = manifestEntries.find((entry) => normalizeArchivePath(entry.path) === directory);
      const hasDescendant = manifestEntries.some((entry) => pathPrefixes(entry.path).slice(0, -1).includes(directory));
      if ((exact && exact.type !== 'directory') || (!exact && !hasDescendant)) throw new SnapshotBrowserError('SNAPSHOT_DIRECTORY_NOT_FOUND', 'The requested directory is not present in this recovery point.', { category: 'not-found' });
    }
    const children = new Map();
    for (const entry of manifestEntries) {
      const prefixes = pathPrefixes(entry.path);
      const directoryIndex = directory ? prefixes.indexOf(directory) : -1;
      const childIndex = directory ? directoryIndex + 1 : 0;
      if ((directory && directoryIndex < 0) || childIndex >= prefixes.length) continue;
      const childPath = prefixes[childIndex];
      const direct = childPath === normalizeArchivePath(entry.path);
      const candidate = direct ? publicEntry(entry) : publicEntry({ path: childPath, type: 'directory', sizeBytes: 0, metadata: null }, { synthetic: true });
      const existing = children.get(childPath);
      if (existing && existing.type !== 'directory' && candidate.type === 'directory') throw new SnapshotBrowserError('SNAPSHOT_HIERARCHY_INVALID', 'The snapshot contains an invalid path hierarchy.', { category: 'integrity' });
      if (!existing || (existing.synthetic && !candidate.synthetic)) children.set(childPath, candidate);
    }
    const items = [...children.values()].sort(compareEntries);
    const scope = `browse:${tenant}:${recoveryPointId}:${directory}`;
    const offset = decodeCursor(input.cursor, scope);
    return {
      recoveryPoint: await this.#pointSummary(tenant, opened.point),
      path: directory,
      parentPath: directory ? parentPath(directory) : null,
      breadcrumbs: directory ? pathPrefixes(directory).map((path) => ({ path, name: baseName(path) })) : [],
      items: items.slice(offset, offset + limit),
      nextCursor: offset + limit < items.length ? encodeCursor(scope, offset + limit) : null,
      total: items.length,
      repositoryCopy: { repositoryId: opened.copy.repositoryId, state: opened.copy.state }
    };
  }

  async search(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recoveryPointId = requiredText(input.recoveryPointId, 'Recovery point ID', 200);
    const query = requiredText(input.query, 'Search query', MAX_SEARCH_QUERY_LENGTH).toLocaleLowerCase('en-US');
    const type = String(input.type || 'all');
    if (!ALLOWED_ENTRY_TYPES.has(type)) throw new SnapshotBrowserError('SNAPSHOT_SEARCH_TYPE_INVALID', 'Snapshot search type is invalid.', { category: 'validation' });
    const limit = pageSize(input.pageSize);
    const opened = await this.#openById(tenant, recoveryPointId);
    const matches = opened.manifest.files.map((entry) => publicEntry(entry))
      .filter((entry) => (type === 'all' || entry.type === type) && entry.path.toLocaleLowerCase('en-US').includes(query))
      .sort(compareEntries);
    const scope = `search:${tenant}:${recoveryPointId}:${type}:${query}`;
    const offset = decodeCursor(input.cursor, scope);
    return {
      recoveryPoint: await this.#pointSummary(tenant, opened.point),
      query: String(input.query).trim(),
      type,
      items: matches.slice(offset, offset + limit),
      nextCursor: offset + limit < matches.length ? encodeCursor(scope, offset + limit) : null,
      total: matches.length,
      repositoryCopy: { repositoryId: opened.copy.repositoryId, state: opened.copy.state }
    };
  }

  async fileVersions(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recoveryPointId = requiredText(input.recoveryPointId, 'Recovery point ID', 200);
    const targetPath = normalizeArchivePath(input.path);
    const anchor = await this.controlDatabase.repository('recoveryPoint').get(tenant, recoveryPointId);
    if (!anchor) throw new SnapshotBrowserError('RECOVERY_POINT_NOT_FOUND', 'The recovery point was not found.', { category: 'not-found' });
    const [allPoints, repositories, artifacts] = await Promise.all([
      this.controlDatabase.repository('recoveryPoint').list(tenant, { limit: MAX_RECOVERY_POINTS }),
      this.controlDatabase.repository('repository').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('artifact').list(tenant, { limit: 1000 })
    ]);
    const points = allPoints.filter((point) => point.jobId === anchor.jobId && point.sourceId === anchor.sourceId)
      .sort((left, right) => String(left.capturedTo).localeCompare(String(right.capturedTo)))
      .slice(-MAX_VERSION_POINTS);
    const versions = [];
    let previousEntry = null;
    let previousKnown = false;
    for (const point of points) {
      try {
        const opened = await this.#openPoint(tenant, point, repositories, artifacts);
        const entry = opened.manifest.files.find((candidate) => normalizeArchivePath(candidate.path) === targetPath) || null;
        const identity = entryIdentity(entry);
        let change = 'unchanged';
        if (!previousKnown) change = entry ? 'added' : 'absent';
        else if (!previousEntry && entry) change = 'added';
        else if (previousEntry && !entry) change = 'deleted';
        else if (entryIdentity(previousEntry) !== identity) {
          const sameContent = previousEntry?.type === 'file' && entry?.type === 'file'
            && previousEntry.contentDigest?.digest === entry.contentDigest?.digest && Number(previousEntry.sizeBytes) === Number(entry.sizeBytes);
          change = sameContent ? 'metadata-changed' : 'modified';
        }
        versions.push({
          recoveryPointId: point.id,
          capturedTo: point.capturedTo,
          recoveryPointType: point.type,
          availability: 'available',
          exists: Boolean(entry),
          change,
          entry: entry ? publicEntry(entry) : null,
          repositoryId: opened.copy.repositoryId
        });
        previousEntry = entry;
        previousKnown = true;
      } catch (error) {
        versions.push({
          recoveryPointId: point.id,
          capturedTo: point.capturedTo,
          recoveryPointType: point.type,
          availability: 'unavailable',
          exists: null,
          change: 'unknown',
          entry: null,
          repositoryId: null
        });
      }
    }
    return {
      recoveryPointId,
      jobId: anchor.jobId,
      sourceId: anchor.sourceId,
      path: targetPath,
      versions: versions.reverse(),
      examinedRecoveryPoints: points.length,
      truncated: allPoints.filter((point) => point.jobId === anchor.jobId && point.sourceId === anchor.sourceId).length > MAX_VERSION_POINTS
    };
  }

  async openAuthenticatedSnapshot(workspaceId, recoveryPointId, options = {}) {
    return this.#openById(
      requiredText(workspaceId, 'Workspace ID', 200),
      requiredText(recoveryPointId, 'Recovery point ID', 200),
      { repositoryId: options.repositoryId ? requiredText(options.repositoryId, 'Repository ID', 200) : null }
    );
  }

  async #pointSummary(workspaceId, point) {
    const [jobs, sources, repositories] = await Promise.all([
      this.controlDatabase.repository('backupJob').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('source').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('repository').list(workspaceId, { limit: 1000 })
    ]);
    return publicRecoveryPoint(point, {
      jobs: new Map(jobs.map((record) => [record.id, record])),
      sources: new Map(sources.map((record) => [record.id, record])),
      repositories: new Map(repositories.map((record) => [record.id, record]))
    });
  }

  async #openById(workspaceId, recoveryPointId, options = {}) {
    const point = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, recoveryPointId);
    if (!point) throw new SnapshotBrowserError('RECOVERY_POINT_NOT_FOUND', 'The recovery point was not found.', { category: 'not-found' });
    const [repositories, artifacts] = await Promise.all([
      this.controlDatabase.repository('repository').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 })
    ]);
    return this.#openPoint(workspaceId, point, repositories, artifacts, options);
  }

  async #openPoint(workspaceId, point, repositories, artifacts, options = {}) {
    const repositoryIds = new Set(repositories.map((repository) => repository.id));
    const pointArtifacts = artifacts.filter((artifact) => artifact.recoveryPointId === point.id && artifact.kind === 'manifest');
    const copies = (point.repositoryCopies || []).filter((copy) => copy.state === 'available' && repositoryIds.has(copy.repositoryId)
      && (!options.repositoryId || copy.repositoryId === options.repositoryId));
    for (const copy of copies) {
      try {
        const artifact = pointArtifacts.find((candidate) => candidate.repositoryId === copy.repositoryId);
        if (!artifact) throw new SnapshotBrowserError('SNAPSHOT_CATALOG_INCOMPLETE', 'The recovery point manifest catalog is incomplete.', { category: 'integrity' });
        const openedRepository = await this.openRepository(workspaceId, copy.repositoryId);
        const opened = await openedRepository.engine.openSnapshot({}, {
          repositoryId: copy.repositoryId,
          snapshotId: copy.engineSnapshotId,
          masterKey: openedRepository.masterKey
        });
        const expectedLocator = copy.manifestLocator || artifact.locator;
        const expectedChecksum = copy.manifestChecksum?.digest || artifact.checksum?.digest;
        if (opened.summary.manifestKey !== expectedLocator || opened.summary.manifestChecksum?.digest !== expectedChecksum
          || artifact.locator !== opened.summary.manifestKey || artifact.checksum?.digest !== opened.summary.manifestChecksum?.digest) {
          throw new SnapshotBrowserError('SNAPSHOT_CATALOG_MISMATCH', 'The recovery point catalog does not match its repository manifest.', { category: 'integrity' });
        }
        return {
          point,
          copy,
          manifest: opened.manifest,
          summary: opened.summary,
          engine: openedRepository.engine,
          masterKey: openedRepository.masterKey
        };
      } catch {
        // Try another independently cataloged copy before reporting the point unavailable.
      }
    }
    throw new SnapshotBrowserError('SNAPSHOT_COPY_UNAVAILABLE', 'No authenticated repository copy is currently available for this recovery point.', { category: 'repository', retryable: true });
  }
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_RECOVERY_POINTS,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_VERSION_POINTS,
  SnapshotBrowserError,
  SnapshotBrowserService,
  decodeCursor,
  encodeCursor,
  normalizeArchivePath,
  pathPrefixes,
  publicEntry,
  publicRecoveryPoint
};
