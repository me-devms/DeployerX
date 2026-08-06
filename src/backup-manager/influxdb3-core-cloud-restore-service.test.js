const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { ADAPTER_ID, COPY_PHASES } = require('./influxdb3-core');
const {
  ARTIFACT_KIND_TO_OBJECT_STORE,
  AZURE_RESTORE_OPERATION,
  GCS_RESTORE_OPERATION,
  InfluxDb3CoreRestoreService,
  METADATA_PATH,
  NATIVE_PREFIX,
  artifactKindForObjectStore,
  objectStoreForArtifactKind
} = require('./influxdb3-core-restore');

const WORKSPACE_ID = 'workspace-core-cloud-restore';
const DEVICE_ID = 'device-core-cloud-restore';
const NODE_ID = 'node-production-01';
const VERSION = '3.11.0';
const SOURCE_DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const SOURCE_STORAGE = `sha256:${'2'.repeat(64)}`;
const TARGET_DEPLOYMENT = `sha256:${'3'.repeat(64)}`;
const TARGET_STORAGE = `sha256:${'4'.repeat(64)}`;
const PRIVATE_SECRET_REF = 'secret-ref-must-not-project';
const PRIVATE_LOCATOR = 'private-repository-manifest-locator';

const PROVIDERS = Object.freeze({
  azure: Object.freeze({ kind: 'influxdb3-core-azure-full', operation: AZURE_RESTORE_OPERATION }),
  google: Object.freeze({ kind: 'influxdb3-core-gcs-full', operation: GCS_RESTORE_OPERATION })
});

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function contentDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function createControlDatabase(initial) {
  let sequence = 0;
  const records = Object.fromEntries(Object.entries(initial).map(([name, values]) => [name, new Map(values.map((value) => [value.id, value]))]));
  for (const name of ['recoveryPoint', 'source', 'artifact', 'connection', 'restoreRun', 'verificationRun']) if (!records[name]) records[name] = new Map();
  return {
    records,
    repository(name) {
      return {
        get: async (_workspaceId, id) => records[name].get(id) || null,
        list: async () => [...records[name].values()],
        create: async (input) => {
          const record = { ...input, id: input.id || `${name}-${++sequence}`, revision: 1 };
          records[name].set(record.id, record);
          return record;
        }
      };
    },
    transaction: async (callback) => callback({
      get: (name, _workspaceId, id) => records[name].get(id) || null,
      projectExecution: (name, _workspaceId, id, changes) => {
        const current = records[name].get(id);
        const updated = { ...current, ...changes, revision: current.revision + 1 };
        records[name].set(id, updated);
        return updated;
      }
    })
  };
}

function fixture(provider, options = {}) {
  const descriptor = PROVIDERS[provider];
  const sourceStore = options.sourceStore || provider;
  const artifactKind = options.artifactKind || descriptor.kind;
  const artifactStore = options.artifactStore || sourceStore;
  const restoreSupported = options.restoreSupported !== false;
  const bodies = new Map([
    ['_catalog_checkpoint', Buffer.from('checkpoint')],
    ['catalog/catalog.log', Buffer.from('catalog')],
    ['dbs/database/data.parquet', Buffer.from('database')],
    ['snapshots/snapshot.parquet', Buffer.from('snapshot')],
    ['wal/wal.log', Buffer.from('wal')]
  ]);
  const members = [...bodies.entries()].map(([relativePath, body]) => ({ relativePath, sizeBytes: body.length, contentDigest: contentDigest(body) })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  const directories = ['catalog', 'dbs', 'dbs/database', 'snapshots', 'wal'].sort((left, right) => left.localeCompare(right, 'en-US'));
  const source = {
    id: 'source-cloud', adapterId: ADAPTER_ID, connectionId: 'connection-source', selector: { digest: digest({ allDatabases: true }) },
    consistency: { backupMethod: 'physical' },
    physicalExecution: { objectStore: sourceStore, deploymentFingerprint: SOURCE_DEPLOYMENT, storageFingerprint: SOURCE_STORAGE }
  };
  const metadata = {
    version: 1, kind: artifactKind, adapterId: ADAPTER_ID, sourceId: source.id, selectionDigest: source.selector.digest, backupMethod: 'physical', backupMode: 'full',
    source: { product: 'influxdb3-core', productVersion: VERSION, nodeId: NODE_ID, objectStore: artifactStore, deploymentFingerprint: SOURCE_DEPLOYMENT, storageFingerprint: SOURCE_STORAGE },
    capture: { consistencyMode: 'stopped', achievedConsistency: 'application', copyOrder: COPY_PHASES.map((phase) => phase.name), excluded: ['table-snapshots/'] },
    nativeMedia: {
      fileCount: members.length, directoryCount: directories.length, totalBytes: members.reduce((sum, member) => sum + member.sizeBytes, 0),
      mediaFingerprint: digest(members), directoryFingerprint: digest(directories), directories,
      members: members.map((member) => ({ ...member, path: `${NATIVE_PREFIX}${NODE_ID}/${member.relativePath}` }))
    },
    artifact: { kind: 'metadata', path: METADATA_PATH, mediaType: 'application/json', restoreSupported }
  };
  const metadataBody = Buffer.from(JSON.stringify(metadata));
  const metadataDigest = contentDigest(metadataBody);
  const manifestFiles = [
    { type: 'file', path: METADATA_PATH, sizeBytes: metadataBody.length, contentDigest: { digest: metadataDigest }, metadata: { artifactKind: 'metadata', database: { adapterId: ADAPTER_ID } } },
    ...members.map((member) => ({ type: 'file', path: `${NATIVE_PREFIX}${NODE_ID}/${member.relativePath}`, sizeBytes: member.sizeBytes, contentDigest: { digest: member.contentDigest }, metadata: { artifactKind: 'physical-backup-member', nativeRelativePath: member.relativePath, contentDigest: member.contentDigest } }))
  ];
  const snapshot = { summary: { manifestKey: PRIVATE_LOCATOR, manifestChecksum: { digest: digest({ manifest: 1 }) } }, manifest: { files: manifestFiles } };
  const artifact = { id: 'artifact-cloud', recoveryPointId: 'point-cloud', repositoryId: 'repository-cloud', kind: 'metadata', locator: `snapshot-private#${encodeURIComponent(METADATA_PATH)}`, sizeBytes: metadataBody.length, checksum: { digest: metadataDigest }, metadata: structuredClone(metadata) };
  const point = { id: 'point-cloud', sourceId: source.id, type: 'full', consistency: 'application', verification: { state: 'succeeded' }, retention: {}, repositoryCopies: [{ repositoryId: 'repository-cloud', state: 'available', engineSnapshotId: 'snapshot-cloud', manifestLocator: PRIVATE_LOCATOR, manifestChecksum: snapshot.summary.manifestChecksum }] };
  const target = {
    id: 'connection-target', adapterId: ADAPTER_ID,
    endpoint: { objectStore: provider, nodeId: NODE_ID, expectedVersion: VERSION, expectedDeploymentFingerprint: TARGET_DEPLOYMENT, expectedStorageFingerprint: TARGET_STORAGE },
    trust: { objectStore: provider, fingerprint: TARGET_DEPLOYMENT, storageFingerprint: TARGET_STORAGE, dataRootFingerprint: null },
    workerAffinity: [`device:${DEVICE_ID}`], secretRefIds: [PRIVATE_SECRET_REF],
    lastTest: { status: 'success', endpointIdentity: { objectStore: provider, version: VERSION, nodeId: NODE_ID, deploymentFingerprint: TARGET_DEPLOYMENT, storageFingerprint: TARGET_STORAGE, dataRootFingerprint: null, restoreSupported: true } }
  };
  const controlDatabase = createControlDatabase({ recoveryPoint: [point], source: [source], artifact: [artifact], connection: [target] });
  let openCount = 0;
  const engine = {
    openSnapshot: async () => snapshot,
    readFile: async (_context, request) => {
      assert.equal(request.path, METADATA_PATH);
      return metadataBody;
    },
    streamFile: (_context, request) => {
      const prefix = `${NATIVE_PREFIX}${NODE_ID}/`;
      const body = bodies.get(String(request.path).slice(prefix.length));
      return (async function* stream() { yield body; })();
    }
  };
  const planCalls = [];
  const adapter = {
    planRestore: async (_context, request) => {
      planCalls.push(request);
      return {
        operation: descriptor.operation,
        target: { productVersion: request.targetIdentity.version, deploymentFingerprint: request.targetIdentity.deploymentFingerprint, storageFingerprint: request.targetIdentity.storageFingerprint, nodeId: request.targetIdentity.nodeId, objectStore: provider, endpointMustRemainStopped: true, nodePrefixMustBeEmpty: true }
      };
    }
  };
  const connectionService = {
    withExecution: async (_workspaceId, connection, signal, callback) => callback({ signal }, { ...connection.endpoint, objectStoreCredentialSecretRefId: PRIVATE_SECRET_REF })
  };
  const service = new InfluxDb3CoreRestoreService({
    controlDatabase, deviceId: DEVICE_ID, adapter, connectionService,
    openRepository: async () => { openCount += 1; return { engine, masterKey: Buffer.alloc(32, 7) }; }
  });
  return { artifact, controlDatabase, metadata, planCalls, point, service, source, target, get openCount() { return openCount; } };
}

test('uses an own-property-only Artifact kind and object-store mapping', () => {
  assert.equal(artifactKindForObjectStore('file'), 'influxdb3-core-filesystem-full');
  assert.equal(artifactKindForObjectStore('azure'), 'influxdb3-core-azure-full');
  assert.equal(objectStoreForArtifactKind('influxdb3-core-gcs-full'), 'google');
  assert.equal(artifactKindForObjectStore('toString'), null);
  assert.equal(objectStoreForArtifactKind('__proto__'), null);
});

test('authenticates Azure and GCS artifacts and selects only an exact same-provider alternate target', async () => {
  for (const provider of Object.keys(PROVIDERS)) {
    const value = fixture(provider);
    const authenticated = await value.service.authenticateRecoveryPoint(WORKSPACE_ID, value.point.id);
    assert.equal(ARTIFACT_KIND_TO_OBJECT_STORE[authenticated.metadata.kind], provider);
    assert.equal(authenticated.sourceEvidence.objectStore, provider);
    assert.equal(authenticated.sourceEvidence.restoreSupported, true);
    assert.equal(authenticated.members.length, 5);

    const preview = await value.service.preview(WORKSPACE_ID, { recoveryPointId: value.point.id, targetConnectionId: value.target.id });
    assert.equal(preview.objectStore, provider);
    assert.equal(preview.sourceVersion, VERSION);
    assert.equal(preview.targetVersion, VERSION);
    assert.equal(preview.nodeId, NODE_ID);
    assert.equal(preview.targetStopped, true);
    assert.equal(preview.targetNodeAbsent, true);
    assert.equal(value.planCalls.length, 1);
    assert.equal(value.planCalls[0].targetIdentity.objectStore, provider);
    assert.equal(value.planCalls[0].targetIdentity.nodeId, NODE_ID);
    assert.equal(value.planCalls[0].source.restoreSupported, true);

    const projected = JSON.stringify(preview);
    for (const privateValue of [PRIVATE_SECRET_REF, PRIVATE_LOCATOR, 'snapshot-private', 'catalog/catalog.log', `${NATIVE_PREFIX}${NODE_ID}/`]) assert.equal(projected.includes(privateValue), false, `Preview disclosed ${privateValue}.`);
  }
});

test('rejects cloud Artifact kind/store mismatches and false restore approval before repository or target access', async () => {
  for (const value of [
    fixture('azure', { artifactKind: 'influxdb3-core-gcs-full' }),
    fixture('azure', { artifactStore: 'google' }),
    fixture('google', { artifactKind: 'influxdb3-core-azure-full' }),
    fixture('google', { restoreSupported: false })
  ]) {
    await assert.rejects(value.service.authenticateRecoveryPoint(WORKSPACE_ID, value.point.id), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_ARTIFACT_INVALID');
    assert.equal(value.openCount, 0);
    assert.equal(value.planCalls.length, 0);
  }
});

test('rejects provider, deployment, version, node, storage, device, and restore-support target drift before planning', async () => {
  const variants = [
    (target) => { target.endpoint.objectStore = 'google'; target.trust.objectStore = 'google'; target.lastTest.endpointIdentity.objectStore = 'google'; },
    (target) => { target.endpoint.expectedDeploymentFingerprint = SOURCE_DEPLOYMENT; target.trust.fingerprint = SOURCE_DEPLOYMENT; target.lastTest.endpointIdentity.deploymentFingerprint = SOURCE_DEPLOYMENT; },
    (target) => { target.endpoint.expectedVersion = '3.10.0'; target.lastTest.endpointIdentity.version = '3.10.0'; },
    (target) => { target.endpoint.nodeId = 'node-other'; target.lastTest.endpointIdentity.nodeId = 'node-other'; },
    (target) => { target.lastTest.endpointIdentity.storageFingerprint = `sha256:${'9'.repeat(64)}`; },
    (target) => { target.workerAffinity = ['device:other']; },
    (target) => { target.lastTest.endpointIdentity.restoreSupported = false; }
  ];
  for (const mutate of variants) {
    const value = fixture('azure');
    mutate(value.target);
    await assert.rejects(value.service.preview(WORKSPACE_ID, { recoveryPointId: value.point.id, targetConnectionId: value.target.id }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_TARGET_CONNECTION_INVALID');
    assert.equal(value.planCalls.length, 0);
  }
});
