const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { InfluxDb3CoreAzureError } = require('./influxdb3-core-azure');
const { InfluxDb3CoreGcsError } = require('./influxdb3-core-gcs');
const {
  RESTORE_CONFIRMATION,
  RESTORE_PHASES,
  InfluxDb3CoreAdapter,
  normalizeRestoreSource
} = require('./influxdb3-core');

const NODE_ID = 'node-production-01';
const SOURCE_DEPLOYMENT = `sha256:${'1'.repeat(64)}`;
const TARGET_DEPLOYMENT = `sha256:${'2'.repeat(64)}`;
const TARGET_STORAGE = `sha256:${'3'.repeat(64)}`;

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function capturedSource(context, objectStore) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `deployerx-core-${objectStore}-adapter-restore-`));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const contents = {
    'snapshots/member.bin': 'snapshot-bytes',
    'dbs/member.bin': 'database-bytes',
    'wal/member.bin': 'wal-bytes',
    'catalog/member.bin': 'catalog-bytes',
    _catalog_checkpoint: 'checkpoint-bytes'
  };
  const members = [];
  for (const [relativePath, body] of Object.entries(contents)) {
    const destination = path.join(root, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, body);
    const value = Buffer.from(body);
    members.push({ relativePath, sizeBytes: value.length, contentDigest: `sha256:${crypto.createHash('sha256').update(value).digest('hex')}` });
  }
  members.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  const directories = ['catalog', 'dbs', 'snapshots', 'wal'];
  return {
    root,
    source: {
      product: 'influxdb3-core', productVersion: '3.11.0', objectStore, nodeId: NODE_ID,
      deploymentFingerprint: SOURCE_DEPLOYMENT, consistency: 'application', restoreSupported: true,
      nativeMedia: {
        fileCount: members.length, directoryCount: directories.length,
        totalBytes: members.reduce((sum, member) => sum + member.sizeBytes, 0),
        mediaFingerprint: stableDigest(members), directoryFingerprint: stableDigest(directories), members, directories
      }
    }
  };
}

class RestoreStore {
  constructor(provider) {
    this.provider = provider;
    this.uploaded = [];
    this.assertEmptyCalls = 0;
    this.authenticateCalls = 0;
    this.occupied = false;
    this.failRelativePath = null;
    this.deleteCalls = 0;
  }

  providerError(suffix, message, category) {
    return new this.provider.ErrorType(`INFLUXDB3_CORE_${this.provider.code}_${suffix}`, message, { category });
  }

  async assertEmpty() {
    this.assertEmptyCalls += 1;
    if (this.occupied) throw this.providerError('RESTORE_TARGET_EXISTS', 'The exact cloud node prefix is occupied.', 'conflict');
    return { empty: true, bindingFingerprint: TARGET_STORAGE };
  }

  async uploadRestoreMember(_context, _sourceRoot, member) {
    if (member.relativePath === this.failRelativePath) throw this.providerError('RESTORE_WRITE_FAILED', 'The create-only provider write failed.', 'execution');
    this.uploaded.push(member);
    this.occupied = true;
    return member;
  }

  async authenticateInstalled(_context, source) {
    this.authenticateCalls += 1;
    assert.equal(source.targetStorageFingerprint, TARGET_STORAGE);
    return { files: source.nativeMedia.members, directories: source.nativeMedia.directories, totalBytes: source.nativeMedia.totalBytes, bindingFingerprint: TARGET_STORAGE };
  }
}

const PROVIDERS = [
  {
    id: 'azure', code: 'AZURE', ErrorType: InfluxDb3CoreAzureError,
    operation: 'influxdb3-core-alternate-azure-restore', factory: 'azureStoreFactory',
    connection: {
      objectStore: 'azure', azureBindingConfirmed: true, objectStoreAccountName: 'corestorageaccount',
      objectStoreBucket: 'core-restore-data', objectStorePrefix: 'alternate', objectStoreTimeoutMs: 30000,
      objectStoreCredentialSecretRefId: 'secret-core-azure-target'
    }
  },
  {
    id: 'google', code: 'GCS', ErrorType: InfluxDb3CoreGcsError,
    operation: 'influxdb3-core-alternate-gcs-restore', factory: 'gcsStoreFactory',
    connection: {
      objectStore: 'google', gcsBindingConfirmed: true, objectStoreBucket: 'deployerx-core-restore-data',
      objectStorePrefix: 'alternate', objectStoreTimeoutMs: 30000,
      objectStoreCredentialSecretRefId: 'secret-core-gcs-target'
    }
  }
];

function targetConnection(provider) {
  return {
    protocol: 'http', allowInsecureHttp: true, host: '127.0.0.2', port: 8181, nodeId: NODE_ID,
    ...provider.connection, expectedVersion: '3.11.0', expectedDeploymentFingerprint: TARGET_DEPLOYMENT,
    expectedStorageFingerprint: TARGET_STORAGE
  };
}

function targetIdentity(provider) {
  return { version: '3.11.0', nodeId: NODE_ID, objectStore: provider.id, deploymentFingerprint: TARGET_DEPLOYMENT, storageFingerprint: TARGET_STORAGE };
}

function stoppedAdapter(provider, store) {
  return new InfluxDb3CoreAdapter({
    transport: async () => { const error = new Error('stopped'); error.category = 'connectivity'; throw error; },
    [provider.factory]: () => store,
    clock: () => '2026-08-05T12:00:00.000Z'
  });
}

for (const provider of PROVIDERS) {
  test(`plans, installs, and fully authenticates a stopped alternate ${provider.id} target`, async (context) => {
    const captured = await capturedSource(context, provider.id);
    assert.throws(() => normalizeRestoreSource({ ...captured.source, restoreSupported: false }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_SOURCE_INVALID');
    const store = new RestoreStore(provider);
    const adapter = stoppedAdapter(provider, store);
    const request = {
      mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection: targetConnection(provider), source: captured.source,
      targetIdentity: targetIdentity(provider), executionId: `${provider.id}-restore-1`
    };
    await assert.rejects(adapter.planRestore({}, { ...request, targetIdentity: { ...request.targetIdentity, nodeId: 'other-node' } }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_TARGET_INVALID');
    await assert.rejects(adapter.planRestore({}, { ...request, targetIdentity: { ...request.targetIdentity, deploymentFingerprint: SOURCE_DEPLOYMENT } }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_TARGET_INVALID');
    await assert.rejects(adapter.planRestore({}, { ...request, targetIdentity: { ...request.targetIdentity, storageFingerprint: `sha256:${'4'.repeat(64)}` } }), (error) => error.code === 'INFLUXDB3_CORE_RESTORE_TARGET_CHANGED');

    const plan = await adapter.planRestore({}, request);
    assert.equal(plan.operation, provider.operation);
    assert.equal(plan.source.restoreSupported, true);
    assert.equal(plan.target.objectStore, provider.id);
    const mutations = []; const phases = [];
    const restored = await adapter.executeRestore({
      sourceDirectory: captured.root,
      onMutationStarted: (event) => mutations.push(event),
      onProgress: (event) => phases.push(event.component)
    }, plan);
    assert.deepEqual(mutations, [{ objectStore: provider.id }]);
    assert.deepEqual(phases, RESTORE_PHASES.map((phase) => phase.name));
    assert.deepEqual(store.uploaded.map((member) => member.relativePath.split('/')[0]), ['_catalog_checkpoint', 'catalog', 'wal', 'dbs', 'snapshots']);
    assert.equal(store.assertEmptyCalls, 2);
    assert.equal(store.authenticateCalls, 1);
    assert.equal(store.deleteCalls, 0);
    assert.equal(restored.validation.valid, true);
    assert.equal(restored.validation.objectStore, provider.id);
    assert.equal(restored.validation.fileCount, captured.source.nativeMedia.fileCount);
  });

  test(`preserves partial ${provider.id} target writes when restore fails after mutation`, async (context) => {
    const captured = await capturedSource(context, provider.id);
    const store = new RestoreStore(provider);
    const adapter = stoppedAdapter(provider, store);
    const plan = await adapter.planRestore({}, {
      mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection: targetConnection(provider), source: captured.source,
      targetIdentity: targetIdentity(provider), executionId: `${provider.id}-partial-restore`
    });
    store.failRelativePath = 'wal/member.bin';
    let mutationStarted = false;
    await assert.rejects(adapter.executeRestore({ sourceDirectory: captured.root, onMutationStarted: () => { mutationStarted = true; } }, plan), (error) => error.code === `INFLUXDB3_CORE_${provider.code}_RESTORE_WRITE_FAILED`);
    assert.equal(mutationStarted, true);
    assert.deepEqual(store.uploaded.map((member) => member.relativePath), ['_catalog_checkpoint', 'catalog/member.bin']);
    assert.equal(store.authenticateCalls, 0);
    assert.equal(store.deleteCalls, 0);
  });
}
