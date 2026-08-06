const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { deploymentFingerprint } = require('./mongodb');
const { MongoDbCoordinatedSnapshotService, MongoDbSnapshotProviderRegistry, selectReplicaSetMember } = require('./mongodb-snapshot');

const PASSWORD = 'snapshot-secret-value';

function coordinate(seconds, increment = 1) { return { $timestamp: { t: seconds, i: increment } }; }

function identity(overrides = {}) {
  const value = {
    topology: 'replica-set', deploymentId: 'ObjectId(0123456789abcdef01234567)', replicaSetId: 'ObjectId(0123456789abcdef01234567)', setName: 'rs0',
    featureCompatibilityVersion: '8.0', version: '8.0.4', me: 'mongo01.example.com:27017', primary: 'mongo01.example.com:27017',
    replicaStatus: {
      lastCommittedOpTime: { timestamp: coordinate(198), term: 2 },
      members: [
        { name: 'mongo01.example.com:27017', state: 'PRIMARY', health: 1, self: true, uptimeSeconds: 1000, optime: coordinate(200), syncSourceHost: null, arbiterOnly: false, hidden: false, secondaryDelaySeconds: 0, votes: 1, priority: 1 },
        { name: 'mongo02.example.com:27017', state: 'SECONDARY', health: 1, self: false, uptimeSeconds: 900, optime: coordinate(199), syncSourceHost: 'mongo01.example.com:27017', arbiterOnly: false, hidden: false, secondaryDelaySeconds: 0, votes: 1, priority: 1 },
        { name: 'mongo03.example.com:27017', state: 'SECONDARY', health: 1, self: false, uptimeSeconds: 900, optime: coordinate(170), syncSourceHost: 'mongo01.example.com:27017', arbiterOnly: false, hidden: false, secondaryDelaySeconds: 0, votes: 1, priority: 1 }
      ]
    }
  };
  return { ...value, ...overrides };
}

function connection() {
  return { host: 'mongo01.example.com', port: 27017, username: 'backup', passwordSecretRefId: 'secret-mongodb', authSource: 'admin', replicaSet: 'rs0', expectedTopology: 'replica-set', tlsMode: 'verify-identity', timeoutMs: 5000 };
}

class Adapter {
  constructor(value = identity()) { this.value = value; this.events = []; this.unlockFails = false; this.postIdentity = null; this.directCalls = 0; }
  async readIdentity() { this.events.push('topology'); return structuredClone(this.value); }
  async snapshotMemberIdentity(_context, _connection, member) { this.events.push(`identity:${member}`); this.directCalls += 1; return { config: connection(), identity: structuredClone(this.directCalls > 1 && this.postIdentity ? this.postIdentity : this.value) }; }
  async setSnapshotMemberLock(context, _connection, member, locked) {
    assert.equal(await context.resolveSecret('secret-mongodb'), PASSWORD);
    this.events.push(`${locked ? 'lock' : 'unlock'}:${member}`);
    if (!locked && this.unlockFails) throw new Error('unlock failed');
    return { action: locked ? 'lock' : 'unlock', member, setName: 'rs0', lockCount: locked ? 1 : 0, operationTime: coordinate(199) };
  }
}

class Provider {
  constructor() { this.events = []; this.createFails = false; this.export = Buffer.from('atomic-snapshot-export'); }
  manifest() { return { apiVersion: 1, providerId: 'test.atomic', providerVersion: '1.0.0', displayName: 'Test Atomic', platform: 'linux', atomic: true, supportsExport: true, supportsDiscard: true, consistencyProtocols: ['mongodb-fsync-lock'] }; }
  async preflight(input) {
    this.events.push(`preflight:${input.member.name}`);
    return { ready: true, providerIdentity: 'provider:test-device', atomic: true, journalCoLocated: true, requiresFsyncLock: true, exportable: true, volumeMappings: [{ sourcePath: '/var/lib/mongodb', volumeId: 'volume-data', filesystem: 'xfs', mountPoint: '/var/lib/mongodb' }, { sourcePath: '/etc/mongodb-keyfile', volumeId: 'volume-root', filesystem: 'xfs', mountPoint: '/' }] };
  }
  async createSnapshot(input) {
    this.events.push(`create:${input.member.name}`);
    if (this.createFails) throw new Error('provider internals must not escape');
    return { snapshotSetId: 'snapshot-set-1', createdAt: '2026-08-04T12:00:00.000Z', volumeSnapshots: [{ volumeId: 'volume-data', snapshotId: 'snap-data' }, { volumeId: 'volume-root', snapshotId: 'snap-root' }], checkpointEvidence: { filesystemFrozen: true } };
  }
  async openExport(input) { this.events.push(`export:${input.snapshotSetId}`); return Readable.from([this.export]); }
  async discardSnapshot(input) { this.events.push(`discard:${input.snapshotSetId}:${input.reason}`); }
}

function request(value = identity()) {
  return { connection: connection(), providerId: 'test.atomic', serverIdentityFingerprint: deploymentFingerprint(value), layout: { dbPath: '/var/lib/mongodb', journalPath: '/var/lib/mongodb/journal', keyFiles: ['/etc/mongodb-keyfile'] }, memberPolicy: { maxLagSeconds: 5 } };
}

function context() { return { resolveSecret: async () => PASSWORD }; }

test('selects a healthy current secondary and refuses unsafe preferred members', () => {
  const value = identity();
  assert.equal(selectReplicaSetMember(value, { maxLagSeconds: 5 }).name, 'mongo02.example.com:27017');
  assert.throws(() => selectReplicaSetMember(value, { maxLagSeconds: 5, preferredMember: 'mongo03.example.com:27017' }), (error) => error.code === 'MONGODB_SNAPSHOT_PREFERRED_MEMBER_UNSAFE');
  const noSecondary = identity({ replicaStatus: { ...value.replicaStatus, members: value.replicaStatus.members.map((member) => member.state === 'SECONDARY' ? { ...member, hidden: true } : member) } });
  assert.throws(() => selectReplicaSetMember(noSecondary, { maxLagSeconds: 5 }), (error) => error.code === 'MONGODB_SNAPSHOT_MEMBER_UNAVAILABLE');
  assert.equal(selectReplicaSetMember(noSecondary, { maxLagSeconds: 5, allowPrimary: true }).state, 'PRIMARY');
});

test('refuses snapshot providers without atomic export and discard guarantees', () => {
  const unsafe = new Provider();
  unsafe.manifest = () => ({ ...Provider.prototype.manifest.call(unsafe), atomic: false });
  assert.throws(() => new MongoDbSnapshotProviderRegistry([unsafe]), (error) => error.code === 'MONGODB_SNAPSHOT_PROVIDER_UNSAFE');
});

test('coordinates lock, atomic provider snapshot, unlock, export, and discard', async () => {
  const adapter = new Adapter();
  const provider = new Provider();
  let milliseconds = 0;
  const service = new MongoDbCoordinatedSnapshotService({ adapter, providerRegistry: new MongoDbSnapshotProviderRegistry([provider]), now: () => milliseconds += 25 });
  const prepared = await service.prepare(context(), request());
  assert.deepEqual(adapter.events, ['topology', 'identity:mongo02.example.com:27017', 'lock:mongo02.example.com:27017', 'unlock:mongo02.example.com:27017', 'identity:mongo02.example.com:27017']);
  assert.deepEqual(provider.events, ['preflight:mongo02.example.com:27017', 'create:mongo02.example.com:27017']);
  assert.equal(prepared.metadata.consistency.proven, true);
  assert.equal(prepared.metadata.lock.unlocked, true);
  assert.equal(prepared.metadata.provider.journalCoLocated, true);
  assert.equal(JSON.stringify(prepared.metadata).includes(PASSWORD), false);
  const chunks = [];
  for await (const chunk of await prepared.content()) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).equals(provider.export), true);
  assert.equal(await prepared.release(), true);
  assert.equal(await prepared.release(), false);
  assert.deepEqual(provider.events.slice(-2), ['export:snapshot-set-1', 'discard:snapshot-set-1:export-complete']);
});

test('always unlocks when provider creation fails and returns only a safe error', async () => {
  const adapter = new Adapter();
  const provider = new Provider();
  provider.createFails = true;
  const service = new MongoDbCoordinatedSnapshotService({ adapter, providerRegistry: new MongoDbSnapshotProviderRegistry([provider]) });
  await assert.rejects(service.prepare(context(), request()), (error) => error.code === 'MONGODB_SNAPSHOT_CREATE_FAILED' && !error.message.includes('internals'));
  assert.deepEqual(adapter.events.slice(-2), ['lock:mongo02.example.com:27017', 'unlock:mongo02.example.com:27017']);
});

test('discards a created snapshot when unlock cannot be proven', async () => {
  const adapter = new Adapter();
  adapter.unlockFails = true;
  const provider = new Provider();
  const service = new MongoDbCoordinatedSnapshotService({ adapter, providerRegistry: new MongoDbSnapshotProviderRegistry([provider]) });
  await assert.rejects(service.prepare(context(), request()), (error) => error.code === 'MONGODB_SNAPSHOT_UNLOCK_FAILED');
  assert.equal(provider.events.includes('discard:snapshot-set-1:unlock-failed'), true);
});

test('discards a snapshot when post-capture deployment identity diverges', async () => {
  const adapter = new Adapter();
  adapter.postIdentity = identity({ deploymentId: 'ObjectId(fedcba987654321001234567)', replicaSetId: 'ObjectId(fedcba987654321001234567)' });
  const provider = new Provider();
  const service = new MongoDbCoordinatedSnapshotService({ adapter, providerRegistry: new MongoDbSnapshotProviderRegistry([provider]) });
  await assert.rejects(service.prepare(context(), request()), (error) => error.code === 'MONGODB_SNAPSHOT_POSTCHECK_FAILED');
  assert.equal(provider.events.includes('discard:snapshot-set-1:postcheck-failed'), true);
});
