const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { FileSourceReaderService } = require('./file-source-reader');
const { ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID, LocalFolderRepositoryAdapter } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { ADAPTER_ID, MongoDbConnectionService, MongoDbNativeAdapter } = require('./mongodb');
const { MongoDbRestoreService, RESTORE_CONFIRMATIONS } = require('./mongodb-restore');
const { MongoDbPhysicalRestoreService, RESTORE_CONFIRMATION: PHYSICAL_RESTORE_CONFIRMATION } = require('./mongodb-physical-restore');
const { MongoDbShardedRestoreService, RESTORE_CONFIRMATION: SHARDED_RESTORE_CONFIRMATION } = require('./mongodb-sharded-restore');
const { MongoDbCoordinatedSnapshotService, MongoDbSnapshotProviderRegistry } = require('./mongodb-snapshot');
const { MongoDbSourceReaderService } = require('./mongodb-source-reader');
const { BackupSourceReaderRouter } = require('./mysql-source-reader');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');
const { BackupSecretStore } = require('./secrets');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'mongodb-device';

function secureStorage() {
  return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '') };
}

function oplogEntry(seconds, increment, term, hash) {
  return { ts: { $timestamp: { t: seconds, i: increment } }, t: term, h: hash };
}

function logicalInventory() {
  return {
    version: 1, databases: ['orders'], indexCount: 2,
    collections: [{
      database: 'orders', name: 'events', type: 'collection', uuid: { $uuid: '22222222-2222-3333-4444-555555555555' },
      options: { capped: false, validator: { tenantId: { $exists: true } } },
      indexes: [{ name: '_id_', key: { _id: 1 } }, { name: 'tenant_1', key: { tenantId: 1 }, unique: false }]
    }],
    nativeValidation: { performed: false, results: [] }
  };
}

function identity(oplog = {}) {
  return {
    topology: 'replica-set', version: '8.0.4', featureCompatibilityVersion: '8.0', setName: 'rs0',
    replicaSetId: 'ObjectId(0123456789abcdef01234567)', clusterId: null, endpointIdentity: 'mongo01.example.com:27017',
    primary: 'mongo01.example.com:27017', me: 'mongo02.example.com:27017', members: ['mongo01.example.com:27017', 'mongo02.example.com:27017'],
    storageEngine: 'wiredTiger', persistent: true, logicalSessionTimeoutMinutes: 30,
    databases: ['admin', 'config', 'local', 'orders'], authenticatedUsers: [{ user: 'backup', db: 'admin' }],
    authenticatedRoles: [{ role: 'backup', db: 'admin' }], privilegeCount: 8,
    privilegeActions: ['find', 'listCollections', 'listDatabases', 'listIndexes', 'validate', 'insert', 'createCollection', 'createIndex', 'dropCollection', 'fsync', 'replSetGetStatus'],
    logicalInventory: logicalInventory(),
    replicaStatus: {
      lastCommittedOpTime: { ts: { $timestamp: { t: 198, i: 1 } }, t: 1 },
      members: [
        { name: 'mongo01.example.com:27017', state: 'PRIMARY', health: 1, self: false, uptime: 1000, optime: { ts: { $timestamp: { t: 200, i: 1 } }, t: 1 }, arbiterOnly: false, hidden: false, secondaryDelaySecs: 0, votes: 1, priority: 1 },
        { name: 'mongo02.example.com:27017', state: 'SECONDARY', health: 1, self: true, uptime: 900, optime: { ts: { $timestamp: { t: 199, i: 1 } }, t: 1 }, syncSourceHost: 'mongo01.example.com:27017', arbiterOnly: false, hidden: false, secondaryDelaySecs: 0, votes: 1, priority: 1 }
      ]
    },
    oplog: { earliest: oplogEntry(100, 1, 1, 'first'), latest: oplogEntry(200, 1, 1, 'anchor'), ...oplog }
  };
}

class Runner {
  constructor() {
    this.currentIdentity = identity();
    this.dump = Buffer.from('encrypted-repository-mongodb-anchor');
    this.bson = Buffer.concat([Buffer.from([5, 0, 0, 0, 0]), Buffer.from([5, 0, 0, 0, 0])]);
    this.streamCalls = 0;
    this.captureCalls = 0;
    this.configFiles = [];
    this.restoreArchives = [];
    this.restoreCalls = [];
    this.validationFails = false;
    this.blockRestore = false;
    this.restoreStarted = null;
    this.blockDump = false;
    this.dumpStarted = null;
    this.dumpCanceled = false;
    this.blockOplog = false;
    this.oplogStarted = null;
    this.oplogCanceled = false;
  }

  async consume(input) {
    if (path.win32.basename(input.executable).toLowerCase().replace(/[.]exe$/, '') === 'mongorestore') {
      const chunks = [];
      for await (const chunk of input.stdin) chunks.push(Buffer.from(chunk));
      this.restoreArchives.push(Buffer.concat(chunks));
      this.restoreCalls.push({ args: input.args, config: await fs.readFile(input.args.find((argument) => argument.startsWith('--config=')).slice('--config='.length), 'utf8') });
      if (this.blockRestore) {
        this.restoreStarted?.();
        await new Promise((resolve, reject) => {
          if (input.signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'NATIVE_PROCESS_CANCELED', category: 'canceled' }));
          input.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'NATIVE_PROCESS_CANCELED', category: 'canceled' })), { once: true });
        });
      }
      return { exitCode: 0, stdout: 'restored', stderr: '' };
    }
    if (Buffer.from(input.stdin).includes(Buffer.from('DX_MONGODB_SNAPSHOT_LOCK'))) {
      const script = Buffer.from(input.stdin).toString('utf8');
      const action = script.includes('fsyncUnlock') ? 'unlock' : 'lock';
      return { exitCode: 0, stdout: `DX_MONGODB_SNAPSHOT_LOCK\x1f${JSON.stringify({ action, member: 'mongo02.example.com:27017', setName: 'rs0', lockCount: action === 'lock' ? 1 : 0, operationTime: { $timestamp: { t: 199, i: 1 } } })}\n` };
    }
    const value = structuredClone(this.currentIdentity);
    if (Buffer.from(input.stdin).includes(Buffer.from('const dxRunNativeValidation = true')) && value.logicalInventory) {
      value.logicalInventory.nativeValidation = { performed: true, results: [{ database: 'orders', name: 'events', ok: true, valid: !this.validationFails, warnings: 0, errors: this.validationFails ? 1 : 0, nIndexes: 2, nrecords: 10 }] };
    }
    return { exitCode: 0, stdout: `DX_MONGODB_ID\x1f${JSON.stringify(value)}\n` };
  }

  async run(input) {
    if (input.args.includes('--version')) return { exitCode: 0, stdout: `${path.win32.basename(input.executable)} version: 100.13.0`, stderr: '' };
    if (path.win32.basename(input.executable).toLowerCase().replace(/[.]exe$/, '') === 'mongorestore') {
      this.restoreCalls.push({ args: input.args, config: await fs.readFile(input.args.find((argument) => argument.startsWith('--config=')).slice('--config='.length), 'utf8') });
      return { exitCode: 0, stdout: 'oplog restored', stderr: '' };
    }
    const output = input.args.find((argument) => argument.startsWith('--out='));
    if (!output) return { exitCode: 0, stdout: 'mongodump version: 100.13.0', stderr: '' };
    this.captureCalls += 1;
    if (this.blockOplog && input.args.includes('--collection=oplog.rs')) {
      this.oplogStarted?.();
      await new Promise((resolve, reject) => {
        if (input.signal?.aborted) {
          this.oplogCanceled = true;
          reject(Object.assign(new Error('canceled'), { code: 'NATIVE_PROCESS_CANCELED', category: 'canceled' }));
          return;
        }
        input.signal?.addEventListener('abort', () => {
          this.oplogCanceled = true;
          reject(Object.assign(new Error('canceled'), { code: 'NATIVE_PROCESS_CANCELED', category: 'canceled' }));
        }, { once: true });
      });
    }
    const configPath = input.args.find((argument) => argument.startsWith('--config=')).slice('--config='.length);
    this.configFiles.push(await fs.readFile(configPath, 'utf8'));
    const directory = path.join(output.slice('--out='.length), 'local');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'oplog.rs.bson'), this.bson);
    return { exitCode: 0, stdout: 'done', stderr: '' };
  }

  stream(input) {
    this.streamCalls += 1;
    const configPath = input.args.find((argument) => argument.startsWith('--config=')).slice('--config='.length);
    const inspect = fs.readFile(configPath, 'utf8').then((contents) => this.configFiles.push(contents));
    if (this.blockDump) {
      const runner = this;
      const stdout = Readable.from((async function* blockedDump() {
        await inspect;
        runner.dumpStarted?.();
        await new Promise((resolve, reject) => {
          if (input.signal?.aborted) {
            runner.dumpCanceled = true;
            reject(Object.assign(new Error('canceled'), { code: 'NATIVE_PROCESS_CANCELED', category: 'canceled' }));
            return;
          }
          input.signal?.addEventListener('abort', () => {
            runner.dumpCanceled = true;
            reject(Object.assign(new Error('canceled'), { code: 'NATIVE_PROCESS_CANCELED', category: 'canceled' }));
          }, { once: true });
        });
      })());
      return { stdout, completion: inspect.then(() => ({ exitCode: 0, stderr: '' })), cancel() { runner.dumpCanceled = true; } };
    }
    return { stdout: Readable.from((async function* (runner) { await inspect; yield runner.dump; })(this)), completion: inspect.then(() => ({ exitCode: 0, stderr: '' })), cancel() {} };
  }
}

class SnapshotProvider {
  constructor() { this.export = Buffer.from('encrypted-repository-mongodb-physical-snapshot'); this.events = []; this.restored = null; this.targetOccupied = false; this.validationFails = false; this.blockRestore = false; this.restoreStarted = null; this.blockExport = false; this.exportStarted = null; this.exportCanceled = false; this.rollbackFailures = new Set(); this.discardFailures = new Set(); }
  manifest() { return { apiVersion: 1, providerId: 'test.mongodb.atomic', providerVersion: '1.0.0', displayName: 'Test MongoDB Atomic', platform: 'linux', atomic: true, supportsExport: true, supportsDiscard: true, supportsRestore: true, consistencyProtocols: ['mongodb-fsync-lock'] }; }
  async preflight(input) { this.events.push(`preflight:${input.member.name}`); return { ready: true, providerIdentity: 'provider:test', atomic: true, journalCoLocated: true, requiresFsyncLock: true, exportable: true, volumeMappings: [{ sourcePath: '/var/lib/mongodb', volumeId: 'volume-data', filesystem: 'xfs', mountPoint: '/var/lib/mongodb' }] }; }
  async createSnapshot(input) { this.events.push(`create:${input.member.name}`); return { snapshotSetId: 'mongodb-snapshot-set-1', leaseOwner: input.leaseOwner, createdAt: '2026-08-04T12:00:00.000Z', volumeSnapshots: [{ volumeId: 'volume-data', snapshotId: 'volume-snapshot-1' }], checkpointEvidence: { filesystemFrozen: true } }; }
  async openExport(input) {
    this.events.push(`export:${input.snapshotSetId}`);
    if (!this.blockExport) return Readable.from([this.export]);
    const provider = this;
    return Readable.from((async function* blockedExport() {
      provider.exportStarted?.();
      await new Promise((resolve, reject) => {
        if (input.signal?.aborted) {
          provider.exportCanceled = true;
          reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED', category: 'canceled' }));
          return;
        }
        input.signal?.addEventListener('abort', () => {
          provider.exportCanceled = true;
          reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED', category: 'canceled' }));
        }, { once: true });
      });
    })());
  }
  async discardSnapshot(input) {
    this.events.push(`discard:${input.snapshotSetId}:${input.reason}`);
    if (this.discardFailures.has(input.snapshotSetId || input.leaseOwner)) throw new Error('discard unavailable');
    return { discarded: true, leaseOwner: input.leaseOwner };
  }
  async preflightRestore(input) { this.events.push(`restore-preflight:${input.target.identity}`); return { ready: true, destinationAbsent: !this.targetOccupied, serviceStopped: true, rollbackAvailable: true, targetIdentity: input.target.identity, leaseId: `restore-lease-${input.target.identity}`, leaseOwner: input.leaseOwner, layout: input.layout }; }
  async restoreExport(input) {
    const chunks = []; for await (const chunk of input.content) chunks.push(Buffer.from(chunk));
    this.restored = Buffer.concat(chunks); this.events.push(`restore:${input.targetIdentity}`);
    if (this.blockRestore) {
      this.restoreStarted?.();
      await new Promise((resolve, reject) => {
        if (input.signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED' }));
        input.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED' })), { once: true });
      });
    }
    return { leaseId: input.leaseId, bytesWritten: this.restored.length, serviceStarted: false };
  }
  async validateRestoredMedia(input) { this.events.push(`validate:${input.targetIdentity}`); return { valid: !this.validationFails && this.restored?.equals(this.export), isolated: true, serviceExposed: false, connectivity: true, expectedObjects: true, nativeIntegrityValidation: true, checks: [{ id: 'wiredtiger', status: this.validationFails ? 'fail' : 'pass' }] }; }
  async commitRestore(input) { this.events.push(`commit:${input.targetIdentity}`); return { committed: true, leaseOwner: input.leaseOwner }; }
  async rollbackRestore(input) {
    this.events.push(`rollback:${input.leaseId}:${input.reason}`);
    if (this.rollbackFailures.has(input.leaseId)) throw new Error('rollback unavailable');
  }
}

async function fixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mongodb-backup-test-'));
  const database = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await database.initialize();
  const secretStore = new BackupSecretStore({ rootPath: path.join(root, 'secrets'), secureStorage: secureStorage(), isReferenced: async () => false });
  await secretStore.initialize();
  context.after(async () => { await database.close(); await fs.rm(root, { recursive: true, force: true }); });
  const credentialRoot = path.join(root, 'credentials');
  const dumpRoot = path.join(root, 'dumps');
  await fs.mkdir(credentialRoot);
  await fs.mkdir(dumpRoot);
  const runner = new Runner();
  const snapshotProvider = new SnapshotProvider();
  const snapshotProviderRegistry = new MongoDbSnapshotProviderRegistry([snapshotProvider]);
  const adapter = new MongoDbNativeAdapter({ processRunner: runner, temporaryRoot: credentialRoot, clock: () => new Date().toISOString(), snapshotProviderRegistry });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new MongoDbConnectionService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter });
  const created = await connections.create(WORKSPACE_ID, 'tester', { name: 'Production MongoDB', host: 'mongo01.example.com', username: 'backup', password: 'mongodb-secret-value', authSource: 'admin', replicaSet: 'rs0', expectedTopology: 'replica-set' });
  const { connection } = await connections.test(WORKSPACE_ID, created.id, 'tester');
  const source = await new DatabaseSourceService({ controlDatabase: database, adapterRegistry: registry, deviceId: DEVICE_ID }).save(WORKSPACE_ID, 'tester', {
    name: 'MongoDB replica-set', connectionId: connection.id, selector: { allDatabases: true },
    consistency: options.physical
      ? { requestedLevel: 'application', method: 'mongodb-coordinated-snapshot', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }
      : { requestedLevel: 'application', method: 'mongodb-oplog-dump', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true },
    physicalExecution: options.physical ? { providerId: 'test.mongodb.atomic', dbPath: '/var/lib/mongodb', journalPath: '/var/lib/mongodb/journal', maxLagSeconds: 5 } : undefined
  });
  const repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(repositoryRoot);
  const repository = await database.repository('repository').create({
    workspaceId: WORKSPACE_ID, actorId: 'tester', name: 'MongoDB repository', connectionId: null,
    adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null,
    encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' }, workerAffinity: [`device:${DEVICE_ID}`],
    health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const engine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  const masterKey = Buffer.alloc(32, 7);
  await engine.ensureRepository({}, { repositoryId: repository.id });
  const openedRepository = { repository, adapter: repositoryAdapter, engine, masterKey, keyVersion: 'test-key-v1' };
  const { job } = await new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', {
    name: options.physical ? 'MongoDB physical protection' : 'MongoDB PITR protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: options.physical ? 'full' : 'incremental', verifyAfterBackup: true
  });
  const snapshotCoordinator = new MongoDbCoordinatedSnapshotService({ adapter, providerRegistry: snapshotProviderRegistry });
  const mongoReader = new MongoDbSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, temporaryRoot: dumpRoot, snapshotCoordinator });
  const sourceReader = new BackupSourceReaderRouter({
    controlDatabase: database,
    fileReader: new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID }),
    databaseReaders: { [ADAPTER_ID]: mongoReader }
  });
  const openRepository = async () => openedRepository;
  const service = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'checkpoints') }), deviceId: DEVICE_ID, openRepository });
  return { root, dumpRoot, database, secretStore, runner, adapter, registry, snapshotProvider, snapshotProviderRegistry, connection, repository, openedRepository, openRepository, source, job, service };
}

class ShardedPublicationCoordinator {
  constructor() {
    this.exports = new Map([['config-server', Buffer.from('encrypted-config-server-snapshot')], ['shard:orders', Buffer.from('encrypted-orders-shard-snapshot')]]);
    this.events = [];
    this.blockExport = false;
    this.exportStarted = null;
    const provider = {
      discardSnapshot: async (input) => {
        this.events.push(`reconcile-discard:${input.snapshotSetId}`);
        return { discarded: true, leaseOwner: input.leaseOwner };
      }
    };
    this.componentSnapshotService = { providerRegistry: { get: () => ({ provider }) } };
  }

  lease(request, state = 'released', componentState = 'active') {
    return {
      version: 1, kind: 'mongodb-sharded-coordination', ownerId: request.leaseOwner, clusterId: request.clusterId,
      serverIdentityFingerprint: request.serverIdentityFingerprint, topologyFingerprint: request.topologyFingerprint,
      writeGate: { leaseId: 'gate-lease-1', state: 'released' }, balancer: { wasRunning: true, state: 'restored' }, state,
      components: request.components.map((component) => ({
        componentId: component.role === 'config-server' ? 'config-server' : `shard:${component.shardId}`,
        providerLease: { version: 1, kind: 'mongodb-snapshot-backup', providerId: component.providerId, ownerId: request.leaseOwner, snapshotSetId: `snapshot-${component.role === 'config-server' ? 'config' : component.shardId}`, targetIdentity: component.serverIdentityFingerprint, state: componentState }
      }))
    };
  }

  async prepare(context, request) {
    this.events.push('prepare');
    await context.onLease(this.lease(request));
    const coordinator = this;
    return {
      metadata: {
        version: 1, kind: 'mongodb-sharded-coordinated-snapshot',
        consistency: { requestedLevel: 'application', achievedLevel: 'application', method: 'mongodb-sharded-coordinated-snapshot', backupMethod: 'physical', backupMode: 'full', proven: true },
        cluster: { clusterId: request.clusterId, serverIdentityFingerprint: request.serverIdentityFingerprint, topologyFingerprint: request.topologyFingerprint },
        commonRecoveryInterval: { start: { $timestamp: { t: 100, i: 1 } }, end: { $timestamp: { t: 200, i: 1 } }, recoveryTime: { $timestamp: { t: 200, i: 1 } } },
        components: request.components.map((component) => {
          const componentId = component.role === 'config-server' ? 'config-server' : `shard:${component.shardId}`;
          return { componentId, role: component.role, shardId: component.shardId, replicaSetId: component.replicaSetId, setName: component.connection.replicaSet, artifactPath: `provider/${componentId}.export`, metadata: { deployment: { replicaSetId: component.replicaSetId, setName: component.connection.replicaSet } } };
        }),
        coordination: { writeGateProven: true, balancerStopped: true, capturedAt: '2026-08-04T12:00:00.000Z' }
      },
      components: request.components.map((component) => {
        const componentId = component.role === 'config-server' ? 'config-server' : `shard:${component.shardId}`;
        return {
          componentId,
          artifactPath: `provider/${componentId}.export`,
          content: async () => Readable.from((async function* stream() {
            if (coordinator.blockExport) {
              coordinator.exportStarted?.();
              await new Promise((resolve, reject) => {
                if (context.signal?.aborted) return reject(new Error('canceled'));
                context.signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
              });
            }
            yield coordinator.exports.get(componentId);
          })())
        };
      }),
      async release() {
        coordinator.events.push('release');
        await context.onLease(coordinator.lease(request, 'released', 'discarded'));
        return true;
      }
    };
  }

  async reconcile(_context, request) {
    this.events.push('reconcile');
    return { applicable: true, proven: true, lease: { ...request.lease, state: 'released', writeGate: { ...request.lease.writeGate, state: 'released' }, balancer: { ...request.lease.balancer, state: 'restored' } } };
  }
}

class ShardedRestoreProvider {
  constructor() {
    this.events = [];
    this.restored = new Map();
    this.blockTarget = null;
    this.restoreStarted = null;
    this.validationFailsFor = null;
    this.layoutMismatchFor = null;
    this.rollbackFailures = new Set();
  }

  manifest() { return { apiVersion: 1, providerId: 'test.mongodb.atomic', providerVersion: '1.0.0', displayName: 'Test MongoDB Atomic', platform: 'linux', atomic: true, supportsExport: true, supportsDiscard: true, supportsRestore: true, consistencyProtocols: ['mongodb-fsync-lock'] }; }

  async preflightRestore(input) {
    this.events.push(`preflight:${input.target.identity}`);
    const layout = this.layoutMismatchFor === input.target.identity ? { ...input.layout, dbPath: '/wrong/mongodb' } : input.layout;
    return { ready: true, destinationAbsent: true, serviceStopped: true, rollbackAvailable: true, targetIdentity: input.target.identity, leaseId: `lease-${input.target.identity}`, leaseOwner: input.leaseOwner, layout };
  }

  async restoreExport(input) {
    this.events.push(`restore:${input.targetIdentity}`);
    if (this.blockTarget === input.targetIdentity) {
      this.restoreStarted?.();
      await new Promise((resolve, reject) => {
        if (input.signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED', category: 'canceled' }));
        input.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED', category: 'canceled' })), { once: true });
      });
    }
    const chunks = [];
    for await (const chunk of input.content) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    this.restored.set(input.targetIdentity, bytes);
    return { leaseId: input.leaseId, bytesWritten: bytes.length, serviceStarted: false };
  }

  async validateRestoredMedia(input) {
    this.events.push(`validate:${input.targetIdentity}`);
    return { valid: this.validationFailsFor !== input.targetIdentity, isolated: true, serviceExposed: false, connectivity: true, expectedObjects: true, nativeIntegrityValidation: true, checks: [{ id: 'wiredtiger', status: this.validationFailsFor === input.targetIdentity ? 'fail' : 'pass' }] };
  }

  async commitRestore(input) {
    this.events.push(`commit:${input.targetIdentity}`);
    return { committed: true, leaseOwner: input.leaseOwner };
  }

  async rollbackRestore(input) {
    this.events.push(`rollback:${input.targetIdentity}:${input.reason}`);
    if (this.rollbackFailures.has(input.targetIdentity)) throw new Error('rollback unavailable');
    return { rolledBack: true, leaseOwner: input.leaseOwner };
  }
}

class ShardedRestoreController {
  constructor() { this.events = []; this.targetOccupied = false; this.validationFails = false; this.rollbackFails = false; }

  async preflightRestore(input) {
    this.events.push('preflight');
    return { ready: true, destinationAbsent: !this.targetOccupied, servicesStopped: true, isolated: true, rollbackAvailable: true, leaseOwner: input.leaseOwner, leaseId: 'cluster-restore-lease-1', targetClusterIdentity: input.target.identity };
  }

  async validateRestoredCluster(input) {
    this.events.push(`validate:${input.components.map((item) => item.componentId).join(',')}`);
    return { valid: !this.validationFails, isolated: true, serviceExposed: false, configServerReady: !this.validationFails, shardsReady: !this.validationFails, routersReady: !this.validationFails, routingMetadataMatches: !this.validationFails, componentIdentitiesMatch: !this.validationFails, commonRecoveryTimeMatches: !this.validationFails, stages: ['config-server', 'shards', 'routing-metadata', 'routers', 'validation'], connectivity: true, expectedObjects: true, nativeIntegrityValidation: true, checks: [{ id: 'routing-metadata', status: this.validationFails ? 'fail' : 'pass' }] };
  }

  async commitRestore(input) {
    this.events.push('commit');
    return { committed: true, leaseOwner: input.leaseOwner, serviceExposed: false };
  }

  async rollbackRestore(input) {
    this.events.push(`rollback:${input.reason}`);
    if (this.rollbackFails) throw new Error('cluster rollback unavailable');
    return { rolledBack: true, leaseOwner: input.leaseOwner };
  }
}

async function shardedPublicationFixture(context) {
  const base = await fixture(context, { physical: true });
  const { database, connection, registry, adapter, secretStore, snapshotProviderRegistry, repository, openRepository, root } = base;
  const topologyFingerprint = 'sha256:sharded-topology';
  const routerFingerprint = 'sha256:sharded-router';
  const componentDefinitions = [
    { componentId: 'config-server', role: 'config-server', shardId: null, host: 'config01.example.com', setName: 'cfg', replicaSetId: 'ObjectId(aaaaaaaaaaaaaaaaaaaaaaaa)', fingerprint: 'sha256:config', members: ['config01.example.com:27017'] },
    { componentId: 'shard:orders', role: 'shard', shardId: 'orders', host: 'orders01.example.com', setName: 'orders-rs', replicaSetId: 'ObjectId(bbbbbbbbbbbbbbbbbbbbbbbb)', fingerprint: 'sha256:orders', members: ['orders01.example.com:27017'] }
  ];
  const router = await database.repository('connection').update(WORKSPACE_ID, connection.id, {
    endpoint: { ...connection.endpoint, replicaSet: null, expectedTopology: 'sharded' },
    trust: { ...connection.trust, fingerprint: routerFingerprint },
    lastTest: {
      status: 'success', remotePlatform: { engine: 'mongodb', version: '8.0.4' },
      endpointIdentity: {
        deploymentFingerprint: routerFingerprint, topology: 'sharded', clusterId: 'ObjectId(cccccccccccccccccccccccc)',
        shardedTopology: { metadataFingerprint: topologyFingerprint, configServer: { setName: 'cfg', hosts: ['config01.example.com:27017'] }, shards: [{ shardId: 'orders', setName: 'orders-rs', hosts: ['orders01.example.com:27017'] }] }
      }
    }
  }, { expectedRevision: connection.revision, actorId: 'tester' });
  const components = [];
  for (const definition of componentDefinitions) {
    const saved = await database.repository('connection').create({
      workspaceId: WORKSPACE_ID, actorId: 'tester', name: definition.componentId, kind: 'database', adapterId: ADAPTER_ID, adapterVersion: '0.1.0', scope: 'device',
      endpoint: { ...connection.endpoint, host: definition.host, replicaSet: definition.setName, expectedTopology: 'replica-set' },
      secretRefIds: connection.secretRefIds.slice(), trust: { mode: 'verify-identity', fingerprint: definition.fingerprint }, workerAffinity: [`device:${DEVICE_ID}`],
      lastTest: { status: 'success', remotePlatform: { engine: 'mongodb', version: '8.0.4' }, endpointIdentity: { deploymentFingerprint: definition.fingerprint, topology: 'replica-set', setName: definition.setName, replicaSetId: definition.replicaSetId, replicaRole: definition.role, members: definition.members } }
    });
    components.push({ ...definition, connectionId: saved.id });
  }
  const sourceService = new DatabaseSourceService({ controlDatabase: database, adapterRegistry: registry, deviceId: DEVICE_ID });
  const input = {
    name: 'MongoDB sharded cluster', connectionId: router.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'mongodb-coordinated-snapshot', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true },
    physicalExecution: {
      topology: 'sharded', writeGateId: 'test.mongodb.write-gate',
      components: components.map((component) => ({ role: component.role, shardId: component.shardId, connectionId: component.connectionId, providerId: 'test.mongodb.atomic' }))
    }
  };
  await assert.rejects(() => sourceService.save(WORKSPACE_ID, 'tester', { ...input, physicalExecution: { ...input.physicalExecution, components: input.physicalExecution.components.slice(0, 1) } }), /config server and every shard component/i);
  const source = await sourceService.save(WORKSPACE_ID, 'tester', input);
  const { job } = await new BackupJobService({ controlDatabase: database, deviceId: DEVICE_ID }).create(WORKSPACE_ID, 'tester', { name: 'MongoDB sharded protection', sourceId: source.id, repositoryIds: [repository.id], backupMode: 'full', verifyAfterBackup: true });
  const shardedSnapshotCoordinator = new ShardedPublicationCoordinator();
  const snapshotCoordinator = new MongoDbCoordinatedSnapshotService({ adapter, providerRegistry: snapshotProviderRegistry });
  const mongoReader = new MongoDbSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapterRegistry: registry, adapter, snapshotCoordinator, shardedSnapshotCoordinator, shardedWriteGateId: 'test.mongodb.write-gate' });
  const sourceReader = new BackupSourceReaderRouter({ controlDatabase: database, fileReader: new FileSourceReaderService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID }), databaseReaders: { [ADAPTER_ID]: mongoReader } });
  const service = new ManualBackupService({ controlDatabase: database, sourceReader, checkpointStore: new RunCheckpointStore({ rootPath: path.join(root, 'sharded-checkpoints') }), deviceId: DEVICE_ID, openRepository });
  return { ...base, router, source, job, mongoReader, service, shardedSnapshotCoordinator };
}

function shardedRestoreRequest(fixture, recoveryPointId) {
  return {
    recoveryPointId,
    targetRouterConnectionId: fixture.router.id,
    targetProfile: {
      clusterControllerId: 'test.mongodb.cluster-controller',
      targetClusterIdentity: 'empty-sharded-cluster-01',
      components: fixture.source.physicalExecution.components.map((component) => ({
        role: component.role,
        shardId: component.shardId,
        providerId: 'test.mongodb.atomic',
        targetConnectionId: component.connectionId,
        targetIdentity: `empty-${component.componentId}`,
        layout: { dbPath: component.dbPath, journalPath: component.journalPath, keyFiles: component.keyFiles }
      }))
    },
    confirmed: true,
    confirmationText: SHARDED_RESTORE_CONFIRMATION
  };
}

function shardedRestoreService(fixture, provider, controller) {
  const providerRegistry = {
    get(providerId) {
      const manifest = provider.manifest();
      if (providerId !== manifest.providerId) throw new Error('provider unavailable');
      return { provider, manifest };
    }
  };
  return new MongoDbShardedRestoreService({
    controlDatabase: fixture.database,
    deviceId: DEVICE_ID,
    providerRegistry,
    clusterController: controller,
    clusterControllerId: 'test.mongodb.cluster-controller',
    openRepository: fixture.openRepository
  });
}

async function publishedShardedFixture(context) {
  const fixture = await shardedPublicationFixture(context);
  const run = await fixture.service.start(WORKSPACE_ID, 'tester', fixture.job.id);
  await fixture.service.wait(run.id);
  const point = (await fixture.database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 })).find((item) => item.sourceId === fixture.source.id);
  assert.ok(point);
  return { ...fixture, point };
}

test('publishes, decrypts, and restores one coordinated physical snapshot to an empty target', async (context) => {
  const { database, snapshotProvider, snapshotProviderRegistry, connection, openedRepository, openRepository, source, job, service } = await fixture(context, { physical: true });
  assert.equal(source.consistency.backupMethod, 'physical');
  assert.equal(source.physicalExecution.providerId, 'test.mongodb.atomic');
  const run = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(run.id);
  const completed = await database.repository('run').get(WORKSPACE_ID, run.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  assert.equal(completed.sourceLease.kind, 'mongodb-snapshot-backup');
  assert.equal(completed.sourceLease.ownerId, `mongodb-snapshot-backup:${WORKSPACE_ID}:${run.id}`);
  assert.equal(completed.sourceLease.snapshotSetId, 'mongodb-snapshot-set-1');
  assert.equal(completed.sourceLease.state, 'discarded');
  const points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const point = points.find((item) => item.type === 'full');
  assert.ok(point);
  assert.equal(point.consistency, 'application');
  const artifact = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).find((item) => item.recoveryPointId === point.id && item.kind === 'physical-backup');
  assert.ok(artifact);
  assert.equal(artifact.metadata.physicalSnapshot.lock.unlocked, true);
  assert.equal(artifact.metadata.physicalSnapshot.member.name, 'mongo02.example.com:27017');
  assert.equal(artifact.metadata.physicalSnapshot.provider.snapshotSetId, 'mongodb-snapshot-set-1');
  const snapshot = await openedRepository.engine.openSnapshot({}, { repositoryId: openedRepository.repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey: openedRepository.masterKey });
  const file = snapshot.manifest.files.find((item) => item.metadata?.artifactKind === 'physical-backup');
  assert.ok(file);
  const chunks = [];
  for await (const chunk of openedRepository.engine.streamFile({}, { repositoryId: openedRepository.repository.id, manifest: snapshot.manifest, masterKey: openedRepository.masterKey, path: file.path })) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).equals(snapshotProvider.export), true);
  assert.deepEqual(snapshotProvider.events, ['preflight:mongo02.example.com:27017', 'create:mongo02.example.com:27017', 'export:mongodb-snapshot-set-1', 'discard:mongodb-snapshot-set-1:export-complete']);
  assert.equal(JSON.stringify(artifact.metadata).includes('mongodb-secret-value'), false);

  const restores = new MongoDbPhysicalRestoreService({ controlDatabase: database, deviceId: DEVICE_ID, providerRegistry: snapshotProviderRegistry, openRepository });
  const restore = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, targetConnectionId: connection.id, targetProfile: { providerId: 'test.mongodb.atomic', targetIdentity: 'empty-target-01', layout: { dbPath: '/var/lib/mongodb', journalPath: '/var/lib/mongodb/journal' } }, confirmed: true, confirmationText: PHYSICAL_RESTORE_CONFIRMATION });
  const restored = await restores.wait(WORKSPACE_ID, restore.id);
  assert.equal(restored.state, 'succeeded', JSON.stringify(restored.result));
  assert.equal(restored.result.bytesRestored, snapshotProvider.export.length);
  assert.equal(restored.result.serviceExposed, false);
  assert.equal(restored.validation.nativeIntegrityValidation, true);
  assert.equal(snapshotProvider.restored.equals(snapshotProvider.export), true);
  assert.deepEqual(snapshotProvider.events.slice(-4), ['restore-preflight:empty-target-01', 'restore:empty-target-01', 'validate:empty-target-01', 'commit:empty-target-01']);
  assert.equal(restored.target.lease.state, 'committed');

  snapshotProvider.targetOccupied = true;
  const occupied = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, targetConnectionId: connection.id, targetProfile: { providerId: 'test.mongodb.atomic', targetIdentity: 'occupied-target', layout: { dbPath: '/var/lib/mongodb', journalPath: '/var/lib/mongodb/journal' } }, confirmed: true, confirmationText: PHYSICAL_RESTORE_CONFIRMATION });
  const occupiedCompleted = await restores.wait(WORKSPACE_ID, occupied.id);
  assert.equal(occupiedCompleted.state, 'failed');
  assert.equal(occupiedCompleted.result.error.code, 'MONGODB_PHYSICAL_RESTORE_TARGET_NOT_EMPTY');
  assert.equal(snapshotProvider.events.includes('restore:occupied-target'), false);

  snapshotProvider.targetOccupied = false;
  snapshotProvider.validationFails = true;
  const invalid = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, targetConnectionId: connection.id, targetProfile: { providerId: 'test.mongodb.atomic', targetIdentity: 'invalid-target', layout: { dbPath: '/var/lib/mongodb', journalPath: '/var/lib/mongodb/journal' } }, confirmed: true, confirmationText: PHYSICAL_RESTORE_CONFIRMATION });
  const invalidCompleted = await restores.wait(WORKSPACE_ID, invalid.id);
  assert.equal(invalidCompleted.state, 'failed');
  assert.equal(invalidCompleted.result.error.code, 'MONGODB_PHYSICAL_RESTORE_VALIDATION_FAILED');
  assert.equal(snapshotProvider.events.includes('rollback:restore-lease-invalid-target:restore-failed'), true);

  snapshotProvider.validationFails = false;
  snapshotProvider.blockRestore = true;
  const physicalStarted = new Promise((resolve) => { snapshotProvider.restoreStarted = resolve; });
  const canceling = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: point.id, targetConnectionId: connection.id, targetProfile: { providerId: 'test.mongodb.atomic', targetIdentity: 'cancel-target', layout: { dbPath: '/var/lib/mongodb', journalPath: '/var/lib/mongodb/journal' } }, confirmed: true, confirmationText: PHYSICAL_RESTORE_CONFIRMATION });
  await physicalStarted;
  const canceled = await restores.cancel(WORKSPACE_ID, 'tester', canceling.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.target.lease.state, 'rolled-back');
  assert.equal(canceled.result.error.code, 'MONGODB_PHYSICAL_RESTORE_CANCELED');
  assert.equal(snapshotProvider.events.includes('rollback:restore-lease-cancel-target:restore-canceled'), true);
  snapshotProvider.blockRestore = false;
  snapshotProvider.restoreStarted = null;

  const ownedId = 'restore_mongodb_owned_reconcile';
  await database.repository('restoreRun').create({
    id: ownedId, workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { operation: 'physical-empty-target', engine: 'mongodb', providerId: 'test.mongodb.atomic', targetIdentity: 'owned-reconcile-target', lease: { version: 1, providerId: 'test.mongodb.atomic', leaseId: 'lease-owned-reconcile', ownerId: `mongodb-physical-restore:${WORKSPACE_ID}:${ownedId}`, targetIdentity: 'owned-reconcile-target', state: 'active' } },
    mode: 'empty-target', conflictPolicy: 'fail', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }, validation: null, result: null
  });
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const reconciled = await database.repository('restoreRun').get(WORKSPACE_ID, ownedId);
  assert.equal(reconciled.state, 'failed');
  assert.equal(reconciled.target.lease.state, 'rolled-back');
  assert.equal(snapshotProvider.events.includes('rollback:lease-owned-reconcile:process-interrupted'), true);

  const transientId = 'restore_mongodb_transient_reconcile';
  snapshotProvider.rollbackFailures.add('lease-transient-reconcile');
  await database.repository('restoreRun').create({
    id: transientId, workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { operation: 'physical-empty-target', engine: 'mongodb', providerId: 'test.mongodb.atomic', targetIdentity: 'transient-reconcile-target', lease: { version: 1, providerId: 'test.mongodb.atomic', leaseId: 'lease-transient-reconcile', ownerId: `mongodb-physical-restore:${WORKSPACE_ID}:${transientId}`, targetIdentity: 'transient-reconcile-target', state: 'active' } },
    mode: 'empty-target', conflictPolicy: 'fail', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }, validation: null, result: null
  });
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const transientInterrupted = await database.repository('restoreRun').get(WORKSPACE_ID, transientId);
  assert.equal(transientInterrupted.state, 'interrupted');
  snapshotProvider.rollbackFailures.delete('lease-transient-reconcile');
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const transientRecovered = await database.repository('restoreRun').get(WORKSPACE_ID, transientId);
  assert.equal(transientRecovered.state, 'failed');
  assert.equal(transientRecovered.target.lease.state, 'rolled-back');

  const uncertainId = 'restore_mongodb_uncertain_reconcile';
  await database.repository('restoreRun').create({
    id: uncertainId, workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [point.id], targetConnectionId: connection.id,
    target: { operation: 'physical-empty-target', engine: 'mongodb', providerId: 'test.mongodb.atomic', targetIdentity: 'uncertain-target', lease: { version: 1, providerId: 'test.mongodb.atomic', leaseId: 'lease-uncertain', ownerId: 'different-owner', targetIdentity: 'uncertain-target', state: 'active' } },
    mode: 'empty-target', conflictPolicy: 'fail', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }, validation: null, result: null
  });
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const uncertain = await database.repository('restoreRun').get(WORKSPACE_ID, uncertainId);
  assert.equal(uncertain.state, 'interrupted');
  assert.equal(uncertain.result.error.code, 'MONGODB_PHYSICAL_RESTORE_LEASE_CLEANUP_UNPROVEN');
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const uncertainRepeated = await database.repository('restoreRun').get(WORKSPACE_ID, uncertainId);
  assert.equal(uncertainRepeated.state, 'interrupted');
  assert.equal(uncertainRepeated.revision, uncertain.revision);

  const createBackupCandidate = async (id, sourceLease) => database.transaction((transaction) => {
    const group = transaction.create('executionGroup', {
      id: `group_${id}`, workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision,
      trigger: 'manual', scheduledFor: null, idempotencyKey: `reconcile:${id}`, state: 'running', latestRunId: id, terminalRunId: null
    });
    return transaction.create('run', {
      id, workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision,
      executionGroupId: group.id, scheduledFor: null, idempotencyKey: `reconcile:${id}:attempt:1`, trigger: 'manual',
      workerId: `device:${DEVICE_ID}`, state: 'running', attempt: 1, parentRunId: null,
      configSnapshot: completed.configSnapshot, planDigest: completed.planDigest, progress: { phase: 'transferring' },
      lease: null, checkpoint: { available: false }, sourceLease, startedAt: '2026-08-04T12:00:00.000Z', finishedAt: null, result: null
    });
  });

  const acquiringId = 'run_mongodb_snapshot_acquiring';
  await createBackupCandidate(acquiringId, {
    version: 1, kind: 'mongodb-snapshot-backup', providerId: 'test.mongodb.atomic', providerVersion: '1.0.0',
    ownerId: `mongodb-snapshot-backup:${WORKSPACE_ID}:${acquiringId}`, snapshotSetId: null,
    targetIdentity: connection.trust.fingerprint, member: 'mongo02.example.com:27017', state: 'acquiring'
  });
  await service.reconcile(WORKSPACE_ID, 'tester', { force: true });
  const acquiringRecovered = await database.repository('run').get(WORKSPACE_ID, acquiringId);
  assert.equal(acquiringRecovered.state, 'failed');
  assert.equal(acquiringRecovered.sourceLease.state, 'discarded');
  assert.equal(snapshotProvider.events.includes('discard:null:process-interrupted'), true);

  const transientBackupId = 'run_mongodb_snapshot_transient';
  await createBackupCandidate(transientBackupId, {
    version: 1, kind: 'mongodb-snapshot-backup', providerId: 'test.mongodb.atomic', providerVersion: '1.0.0',
    ownerId: `mongodb-snapshot-backup:${WORKSPACE_ID}:${transientBackupId}`, snapshotSetId: 'snapshot-transient',
    targetIdentity: connection.trust.fingerprint, member: 'mongo02.example.com:27017', state: 'active'
  });
  snapshotProvider.discardFailures.add('snapshot-transient');
  await service.reconcile(WORKSPACE_ID, 'tester', { force: true });
  const transientBackupInterrupted = await database.repository('run').get(WORKSPACE_ID, transientBackupId);
  assert.equal(transientBackupInterrupted.state, 'interrupted');
  assert.equal(transientBackupInterrupted.progress.phase, 'operator-action-required');
  snapshotProvider.discardFailures.delete('snapshot-transient');
  await service.reconcile(WORKSPACE_ID, 'tester', { force: true });
  const transientBackupRecovered = await database.repository('run').get(WORKSPACE_ID, transientBackupId);
  assert.equal(transientBackupRecovered.state, 'failed');
  assert.equal(transientBackupRecovered.sourceLease.state, 'discarded');

  const uncertainBackupId = 'run_mongodb_snapshot_uncertain';
  await createBackupCandidate(uncertainBackupId, {
    version: 1, kind: 'mongodb-snapshot-backup', providerId: 'test.mongodb.atomic', providerVersion: '1.0.0',
    ownerId: 'different-backup-owner', snapshotSetId: 'snapshot-uncertain',
    targetIdentity: connection.trust.fingerprint, member: 'mongo02.example.com:27017', state: 'active'
  });
  await service.reconcile(WORKSPACE_ID, 'tester', { force: true });
  const uncertainBackup = await database.repository('run').get(WORKSPACE_ID, uncertainBackupId);
  assert.equal(uncertainBackup.state, 'interrupted');
  await service.reconcile(WORKSPACE_ID, 'tester', { force: true });
  const uncertainBackupRepeated = await database.repository('run').get(WORKSPACE_ID, uncertainBackupId);
  assert.equal(uncertainBackupRepeated.state, 'interrupted');
  assert.equal(uncertainBackupRepeated.revision, uncertainBackup.revision);
});

test('publishes every sharded component, cancels cleanly, and reconciles exact-owned cluster leases', async (context) => {
  const { database, openedRepository, source, job, service, shardedSnapshotCoordinator } = await shardedPublicationFixture(context);
  assert.equal(source.physicalExecution.topology, 'sharded');
  assert.deepEqual(source.physicalExecution.components.map((component) => component.componentId), ['config-server', 'shard:orders']);
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(started.id);
  const completed = await database.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  assert.equal(completed.sourceLease.kind, 'mongodb-sharded-coordination');
  assert.equal(completed.sourceLease.ownerId, `mongodb-sharded-backup:${WORKSPACE_ID}:${started.id}`);
  assert.equal(completed.sourceLease.components.every((component) => component.providerLease.state === 'discarded'), true);
  const [point] = (await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 })).filter((item) => item.sourceId === source.id);
  assert.ok(point);
  assert.equal(point.consistency, 'application');
  const physicalArtifacts = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).filter((artifact) => artifact.recoveryPointId === point.id && artifact.kind === 'physical-backup');
  assert.equal(physicalArtifacts.length, 2);
  const snapshot = await openedRepository.engine.openSnapshot({}, { repositoryId: openedRepository.repository.id, snapshotId: point.repositoryCopies[0].engineSnapshotId, masterKey: openedRepository.masterKey });
  const componentFiles = snapshot.manifest.files.filter((file) => file.metadata?.artifactKind === 'physical-backup');
  assert.deepEqual(componentFiles.map((file) => file.metadata.componentId).sort(), ['config-server', 'shard:orders']);
  for (const file of componentFiles) {
    const chunks = [];
    for await (const chunk of openedRepository.engine.streamFile({}, { repositoryId: openedRepository.repository.id, manifest: snapshot.manifest, masterKey: openedRepository.masterKey, path: file.path })) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).equals(shardedSnapshotCoordinator.exports.get(file.metadata.componentId)), true);
  }

  shardedSnapshotCoordinator.blockExport = true;
  const exportStarted = new Promise((resolve) => { shardedSnapshotCoordinator.exportStarted = resolve; });
  const canceling = await service.start(WORKSPACE_ID, 'tester', job.id);
  await exportStarted;
  const canceled = await service.cancel(WORKSPACE_ID, 'tester', canceling.id);
  assert.equal(canceled.state, 'canceled');
  const canceledRun = await database.repository('run').get(WORKSPACE_ID, canceling.id);
  assert.equal(canceledRun.sourceLease.components.every((component) => component.providerLease.state === 'discarded'), true);
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 })).filter((item) => item.sourceId === source.id).length, 1);
  shardedSnapshotCoordinator.blockExport = false;

  const interruptedId = 'run_mongodb_sharded_interrupted';
  await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', { id: `group_${interruptedId}`, workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision, trigger: 'manual', scheduledFor: null, idempotencyKey: `reconcile:${interruptedId}`, state: 'running', latestRunId: interruptedId, terminalRunId: null });
    transaction.create('run', {
      id: interruptedId, workspaceId: WORKSPACE_ID, actorId: 'tester', jobId: job.id, jobRevision: job.revision, executionGroupId: group.id,
      scheduledFor: null, idempotencyKey: `reconcile:${interruptedId}:attempt:1`, trigger: 'manual', workerId: `device:${DEVICE_ID}`, state: 'running', attempt: 1, parentRunId: null,
      configSnapshot: completed.configSnapshot, planDigest: completed.planDigest, progress: { phase: 'transferring' }, lease: null, checkpoint: { available: false },
      sourceLease: {
        version: 1, kind: 'mongodb-sharded-coordination', ownerId: `mongodb-sharded-backup:${WORKSPACE_ID}:${interruptedId}`, clusterId: source.physicalExecution.clusterId,
        serverIdentityFingerprint: source.physicalExecution.serverIdentityFingerprint, topologyFingerprint: source.physicalExecution.topologyFingerprint,
        writeGate: { leaseId: 'gate-interrupted', state: 'active' }, balancer: { wasRunning: true, state: 'stopped' }, state: 'active',
        components: source.physicalExecution.components.map((component) => ({ componentId: component.componentId, providerLease: { version: 1, kind: 'mongodb-snapshot-backup', providerId: component.providerId, ownerId: `mongodb-sharded-backup:${WORKSPACE_ID}:${interruptedId}`, snapshotSetId: `orphan-${component.componentId}`, targetIdentity: component.serverIdentityFingerprint, state: 'active' } }))
      },
      startedAt: '2026-08-04T12:00:00.000Z', finishedAt: null, result: null
    });
  });
  await service.reconcile(WORKSPACE_ID, 'tester', { force: true });
  const reconciled = await database.repository('run').get(WORKSPACE_ID, interruptedId);
  assert.equal(reconciled.state, 'failed');
  assert.equal(reconciled.sourceLease.components.every((component) => component.providerLease.state === 'discarded'), true);
  assert.equal(shardedSnapshotCoordinator.events.includes('reconcile-discard:orphan-config-server'), true);
  assert.equal(shardedSnapshotCoordinator.events.includes('reconcile-discard:orphan-shard:orders'), true);
});

test('restores every encrypted sharded component and commits one isolated cluster', async (context) => {
  const fixture = await publishedShardedFixture(context);
  const provider = new ShardedRestoreProvider();
  const controller = new ShardedRestoreController();
  const restores = shardedRestoreService(fixture, provider, controller);
  const request = shardedRestoreRequest(fixture, fixture.point.id);
  await assert.rejects(() => restores.start(WORKSPACE_ID, 'tester', { ...request, targetProfile: { ...request.targetProfile, components: request.targetProfile.components.slice(0, 1) } }), /config-server and every shard target/i);
  const started = await restores.start(WORKSPACE_ID, 'tester', request);
  const completed = await restores.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  assert.equal(completed.target.lease.kind, 'mongodb-sharded-restore');
  assert.equal(completed.target.lease.ownerId, `mongodb-sharded-restore:${WORKSPACE_ID}:${started.id}`);
  assert.equal(completed.target.lease.clusterController.state, 'committed');
  assert.equal(completed.target.lease.components.every((component) => component.state === 'committed'), true);
  assert.equal(completed.validation.routingMetadataMatches, true);
  assert.equal(completed.validation.componentIdentitiesMatch, true);
  assert.equal(completed.validation.commonRecoveryTimeMatches, true);
  assert.equal(completed.result.serviceExposed, false);
  assert.equal(completed.result.activationRequired, true);
  assert.equal(provider.restored.get('empty-config-server').equals(fixture.shardedSnapshotCoordinator.exports.get('config-server')), true);
  assert.equal(provider.restored.get('empty-shard:orders').equals(fixture.shardedSnapshotCoordinator.exports.get('shard:orders')), true);
  assert.deepEqual(provider.events, [
    'preflight:empty-config-server', 'restore:empty-config-server', 'validate:empty-config-server',
    'preflight:empty-shard:orders', 'restore:empty-shard:orders', 'validate:empty-shard:orders',
    'commit:empty-config-server', 'commit:empty-shard:orders'
  ]);
  assert.deepEqual(controller.events, ['preflight', 'validate:config-server,shard:orders', 'commit']);
});

test('refuses occupied or invalid sharded targets and rolls back every staged lease', async (context) => {
  const fixture = await publishedShardedFixture(context);
  const provider = new ShardedRestoreProvider();
  const controller = new ShardedRestoreController();
  const restores = shardedRestoreService(fixture, provider, controller);
  const request = shardedRestoreRequest(fixture, fixture.point.id);
  controller.targetOccupied = true;
  const occupiedRun = await restores.start(WORKSPACE_ID, 'tester', request);
  const occupied = await restores.wait(WORKSPACE_ID, occupiedRun.id);
  assert.equal(occupied.state, 'failed');
  assert.equal(occupied.result.error.code, 'MONGODB_SHARDED_RESTORE_TARGET_NOT_EMPTY');
  assert.deepEqual(provider.events, []);

  controller.targetOccupied = false;
  provider.layoutMismatchFor = 'empty-config-server';
  controller.events.length = 0;
  const mismatchedRun = await restores.start(WORKSPACE_ID, 'tester', request);
  const mismatched = await restores.wait(WORKSPACE_ID, mismatchedRun.id);
  assert.equal(mismatched.state, 'failed');
  assert.equal(mismatched.result.error.code, 'MONGODB_SHARDED_COMPONENT_LAYOUT_MISMATCH');
  assert.equal(mismatched.target.lease.clusterController.state, 'rolled-back');
  assert.equal(mismatched.target.lease.components[0].state, 'rolled-back');
  assert.equal(provider.events.includes('rollback:empty-config-server:restore-failed'), true);

  provider.layoutMismatchFor = null;
  provider.events.length = 0;
  controller.validationFails = true;
  controller.events.length = 0;
  const invalidRun = await restores.start(WORKSPACE_ID, 'tester', request);
  const invalid = await restores.wait(WORKSPACE_ID, invalidRun.id);
  assert.equal(invalid.state, 'failed');
  assert.equal(invalid.result.error.code, 'MONGODB_SHARDED_RESTORE_VALIDATION_FAILED');
  assert.equal(invalid.target.lease.state, 'rolled-back');
  assert.equal(invalid.target.lease.clusterController.state, 'rolled-back');
  assert.equal(invalid.target.lease.components.every((component) => component.state === 'rolled-back'), true);
  assert.equal(provider.events.includes('rollback:empty-shard:orders:restore-failed'), true);
  assert.equal(provider.events.includes('rollback:empty-config-server:restore-failed'), true);
  assert.equal(controller.events.includes('rollback:restore-failed'), true);
});

test('cancels sharded restore and reconciles only exact-owned cluster leases', async (context) => {
  const fixture = await publishedShardedFixture(context);
  const provider = new ShardedRestoreProvider();
  const controller = new ShardedRestoreController();
  const restores = shardedRestoreService(fixture, provider, controller);
  const request = shardedRestoreRequest(fixture, fixture.point.id);
  provider.blockTarget = 'empty-shard:orders';
  const restoreStarted = new Promise((resolve) => { provider.restoreStarted = resolve; });
  const canceling = await restores.start(WORKSPACE_ID, 'tester', request);
  await restoreStarted;
  const canceled = await restores.cancel(WORKSPACE_ID, 'tester', canceling.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.error.code, 'MONGODB_SHARDED_RESTORE_CANCELED');
  assert.equal(canceled.target.lease.clusterController.state, 'rolled-back');
  assert.equal(canceled.target.lease.components.every((component) => component.state === 'rolled-back'), true);
  assert.equal(provider.events.includes('rollback:empty-shard:orders:restore-canceled'), true);
  assert.equal(provider.events.includes('rollback:empty-config-server:restore-canceled'), true);
  provider.blockTarget = null;

  const createInterrupted = async (id, ownerId) => fixture.database.repository('restoreRun').create({
    id, workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [fixture.point.id], targetConnectionId: fixture.router.id,
    target: {
      operation: 'sharded-physical-empty-target', mode: 'empty-target', engine: 'mongodb', targetClusterIdentity: 'empty-sharded-cluster-01',
      lease: {
        version: 1, kind: 'mongodb-sharded-restore', ownerId, targetClusterIdentity: 'empty-sharded-cluster-01', state: 'active',
        clusterController: { id: 'test.mongodb.cluster-controller', leaseId: `cluster-${id}`, state: 'active' },
        components: fixture.source.physicalExecution.components.map((component) => ({ componentId: component.componentId, providerId: 'test.mongodb.atomic', leaseId: `lease-${id}-${component.componentId}`, targetIdentity: `empty-${component.componentId}`, state: 'active' }))
      }
    },
    mode: 'empty-target', conflictPolicy: 'fail', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }, validation: null, result: null
  });
  const ownedId = 'restore_mongodb_sharded_owned';
  await createInterrupted(ownedId, `mongodb-sharded-restore:${WORKSPACE_ID}:${ownedId}`);
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const owned = await fixture.database.repository('restoreRun').get(WORKSPACE_ID, ownedId);
  assert.equal(owned.state, 'failed');
  assert.equal(owned.target.lease.clusterController.state, 'rolled-back');
  assert.equal(owned.target.lease.components.every((component) => component.state === 'rolled-back'), true);

  const uncertainId = 'restore_mongodb_sharded_uncertain';
  await createInterrupted(uncertainId, 'different-owner');
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const uncertain = await fixture.database.repository('restoreRun').get(WORKSPACE_ID, uncertainId);
  assert.equal(uncertain.state, 'interrupted');
  assert.equal(uncertain.result.error.code, 'MONGODB_SHARDED_RESTORE_LEASE_CLEANUP_UNPROVEN');
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const repeated = await fixture.database.repository('restoreRun').get(WORKSPACE_ID, uncertainId);
  assert.equal(repeated.revision, uncertain.revision);
});

test('cancels an active MongoDB native dump and removes temporary media', async (context) => {
  const { dumpRoot, database, runner, job, service } = await fixture(context);
  runner.blockDump = true;
  const dumpStarted = new Promise((resolve) => { runner.dumpStarted = resolve; });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await dumpStarted;
  const canceled = await service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.safeErrorCode, 'BACKUP_RUN_CANCELED');
  assert.equal(runner.dumpCanceled, true);
  assert.deepEqual(await fs.readdir(dumpRoot), []);
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID)).length, 0);
  assert.equal((await database.repository('artifact').list(WORKSPACE_ID)).length, 0);
});

test('cancels an active MongoDB snapshot export and durably discards its owned lease', async (context) => {
  const { database, snapshotProvider, job, service } = await fixture(context, { physical: true });
  snapshotProvider.blockExport = true;
  const exportStarted = new Promise((resolve) => { snapshotProvider.exportStarted = resolve; });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await exportStarted;
  const canceled = await service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(snapshotProvider.exportCanceled, true);
  const persisted = await database.repository('run').get(WORKSPACE_ID, started.id);
  assert.equal(persisted.sourceLease.ownerId, `mongodb-snapshot-backup:${WORKSPACE_ID}:${started.id}`);
  assert.equal(persisted.sourceLease.state, 'discarded');
  assert.equal(snapshotProvider.events.includes('discard:mongodb-snapshot-set-1:export-complete'), true);
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID)).length, 0);
});

test('cancels active MongoDB native oplog capture without publishing a log point', async (context) => {
  const { dumpRoot, database, runner, job, service } = await fixture(context);
  const anchor = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(anchor.id);
  runner.currentIdentity = identity({
    earliest: oplogEntry(100, 1, 1, 'first'),
    latest: oplogEntry(220, 1, 1, 'next'),
    probe: oplogEntry(200, 1, 1, 'anchor')
  });
  runner.blockOplog = true;
  const oplogStarted = new Promise((resolve) => { runner.oplogStarted = resolve; });
  const started = await service.start(WORKSPACE_ID, 'tester', job.id);
  await oplogStarted;
  const canceled = await service.cancel(WORKSPACE_ID, 'tester', started.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(runner.oplogCanceled, true);
  assert.deepEqual(await fs.readdir(dumpRoot), []);
  const points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  assert.equal(points.length, 1);
  assert.equal(points[0].type, 'full');
});

test('exposes audited MongoDB restore cancellation through IPC and preload', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')
  ]);
  assert.equal(mainSource.includes("ipcMain.handle('backup:mongodb-restores:cancel'"), true);
  assert.equal(mainSource.includes("action: 'restore.cancel-mongodb'"), true);
  assert.equal(preloadSource.includes("cancelBackupMongoDbRestore: (restoreRunId) => ipcRenderer.invoke('backup:mongodb-restores:cancel'"), true);
});

test('publishes an encrypted MongoDB anchor, linked oplog point, and no empty point', async (context) => {
  const { root, dumpRoot, database, secretStore, runner, adapter, openedRepository, openRepository, job, service } = await fixture(context);
  const anchorRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(anchorRun.id);
  const anchorCompleted = await database.repository('run').get(WORKSPACE_ID, anchorRun.id);
  assert.equal(anchorCompleted.state, 'succeeded', JSON.stringify(anchorCompleted.result));
  let points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const anchor = points.find((point) => point.type === 'full');
  assert.ok(anchor);
  assert.deepEqual(anchor.pointInTime.anchorCoordinate.timestamp, oplogEntry(200, 1, 1, 'anchor').ts);

  const endEntry = oplogEntry(300, 2, 2, 'next');
  runner.currentIdentity = identity({ latest: endEntry, probe: oplogEntry(200, 1, 1, 'anchor') });
  const logRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(logRun.id);
  const logCompleted = await database.repository('run').get(WORKSPACE_ID, logRun.id);
  assert.equal(logCompleted.state, 'succeeded', JSON.stringify(logCompleted.result));
  points = await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 });
  const logPoint = points.find((point) => point.type === 'log');
  assert.ok(logPoint);
  assert.equal(logPoint.parentRecoveryPointId, anchor.id);
  assert.equal(logPoint.chainRootId, anchor.id);
  assert.deepEqual(logPoint.pointInTime.startCoordinate.timestamp, oplogEntry(200, 1, 1, 'anchor').ts);
  assert.deepEqual(logPoint.pointInTime.endCoordinate.timestamp, endEntry.ts);
  const logArtifact = (await database.repository('artifact').list(WORKSPACE_ID, { limit: 100 })).find((artifact) => artifact.recoveryPointId === logPoint.id && artifact.kind === 'transaction-log');
  assert.ok(logArtifact);
  assert.equal(logArtifact.metadata.kind, 'mongodb-oplog');
  const snapshot = await openedRepository.engine.openSnapshot({}, { repositoryId: openedRepository.repository.id, snapshotId: logPoint.repositoryCopies[0].engineSnapshotId, masterKey: openedRepository.masterKey });
  const logFile = snapshot.manifest.files.find((file) => file.metadata?.artifactKind === 'transaction-log');
  const chunks = [];
  for await (const chunk of openedRepository.engine.streamFile({}, { repositoryId: openedRepository.repository.id, manifest: snapshot.manifest, masterKey: openedRepository.masterKey, path: logFile.path })) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).equals(runner.bson), true);

  runner.currentIdentity = identity({ latest: endEntry, probe: endEntry });
  const noChangeRun = await service.start(WORKSPACE_ID, 'tester', job.id);
  await service.wait(noChangeRun.id);
  const noChangeCompleted = await database.repository('run').get(WORKSPACE_ID, noChangeRun.id);
  assert.equal(noChangeCompleted.state, 'succeeded', JSON.stringify(noChangeCompleted.result));
  assert.equal(noChangeCompleted.result.noChange, true);
  assert.equal((await database.repository('recoveryPoint').list(WORKSPACE_ID, { limit: 20 })).length, 2);
  assert.equal(runner.streamCalls, 1);
  assert.equal(runner.captureCalls, 1);
  assert.equal(runner.configFiles.every((contents) => contents.includes('mongodb-secret-value')), true);
  assert.equal((await fs.readFile(path.join(root, 'control', 'control.db'))).includes(Buffer.from('mongodb-secret-value')), false);
  assert.deepEqual(await fs.readdir(dumpRoot), []);

  const restoreRoot = path.join(root, 'restores');
  await fs.mkdir(restoreRoot);
  const restores = new MongoDbRestoreService({ controlDatabase: database, secretStore, deviceId: DEVICE_ID, adapter, openRepository, temporaryRoot: restoreRoot });
  const restore = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: logPoint.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  const completed = await restores.wait(WORKSPACE_ID, restore.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed.result));
  assert.equal(completed.result.fullAnchorRecoveryPointId, anchor.id);
  assert.equal(completed.result.terminalRecoveryPointId, logPoint.id);
  assert.deepEqual(completed.result.replayedRecoveryPointIds, [logPoint.id]);
  assert.equal(completed.validation.expectedObjects, 'pass');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(runner.restoreArchives.length, 1);
  assert.equal(runner.restoreArchives[0].equals(runner.dump), true);
  assert.equal(runner.restoreCalls.length, 2);
  assert.equal(runner.restoreCalls[0].args.includes('--archive'), true);
  assert.equal(runner.restoreCalls[0].args.includes('--oplogReplay'), true);
  assert.equal(runner.restoreCalls[0].args.includes('--drop'), true);
  assert.equal(runner.restoreCalls[0].args.includes('--preserveUUID'), true);
  assert.equal(runner.restoreCalls[1].args.some((argument) => argument.startsWith('--oplogFile=')), true);
  assert.equal(runner.restoreCalls.every((call) => call.config.includes('mongodb-secret-value') && !call.args.join(' ').includes('mongodb-secret-value')), true);
  assert.deepEqual(await fs.readdir(restoreRoot), []);
  assert.equal((await fs.readFile(path.join(root, 'control', 'control.db'))).includes(Buffer.from('mongodb-secret-value')), false);

  const limitedCoordinate = { ...logPoint.pointInTime.endCoordinate, timestamp: { $timestamp: { t: 250, i: 3 } }, historyFingerprint: null, term: null, hash: null };
  const limitedRestore = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: logPoint.id, mode: 'original', stop: { type: 'coordinate', coordinate: limitedCoordinate }, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  const limitedCompleted = await restores.wait(WORKSPACE_ID, limitedRestore.id);
  assert.equal(limitedCompleted.state, 'succeeded', JSON.stringify(limitedCompleted.result));
  assert.deepEqual(limitedCompleted.result.recoveryTarget.coordinate.timestamp, limitedCoordinate.timestamp);
  assert.equal(runner.restoreCalls.at(-1).args.includes('--oplogLimit=250:4'), true);
  assert.deepEqual(await fs.readdir(restoreRoot), []);

  runner.blockRestore = true;
  const restoreStarted = new Promise((resolve) => { runner.restoreStarted = resolve; });
  const canceling = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: logPoint.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  await restoreStarted;
  const canceled = await restores.cancel(WORKSPACE_ID, 'tester', canceling.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.error.code, 'MONGODB_RESTORE_CANCELED');
  assert.deepEqual(await fs.readdir(restoreRoot), []);
  runner.blockRestore = false;
  runner.restoreStarted = null;

  runner.validationFails = true;
  const invalidRestore = await restores.start(WORKSPACE_ID, 'tester', { recoveryPointId: logPoint.id, mode: 'original', confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.original });
  const invalidCompleted = await restores.wait(WORKSPACE_ID, invalidRestore.id);
  assert.equal(invalidCompleted.state, 'failed');
  assert.equal(invalidCompleted.result.error.code, 'MONGODB_RESTORE_VALIDATION_FAILED');
  assert.equal(invalidCompleted.validation.nativeIntegrityValidation, true);
  assert.equal(invalidCompleted.validation.checks.find((check) => check.id === 'native-validation').status, 'fail');
  assert.deepEqual(await fs.readdir(restoreRoot), []);

  const interruptedId = 'restore_mongodb_logical_interrupted';
  await database.repository('restoreRun').create({
    id: interruptedId, workspaceId: WORKSPACE_ID, actorId: 'tester', recoveryPointIds: [logPoint.id], targetConnectionId: completed.target.connectionId,
    target: { operation: 'point-in-time', mode: 'original', engine: 'mongodb', sourceId: anchor.sourceId, connectionId: completed.target.connectionId },
    mode: 'original', conflictPolicy: 'overwrite', workerId: `device:${DEVICE_ID}`, state: 'running', progress: { phase: 'running' }, validation: null, result: null
  });
  await restores.reconcile(WORKSPACE_ID, 'tester');
  const interrupted = await database.repository('restoreRun').get(WORKSPACE_ID, interruptedId);
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.progress.phase, 'operator-action-required');
  assert.equal(interrupted.result.error.retryable, false);
});
