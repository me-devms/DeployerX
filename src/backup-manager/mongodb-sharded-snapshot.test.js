const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { deploymentFingerprint, normalizeShardedTopology, shardedTopologyFingerprint } = require('./mongodb');
const {
  MongoDbShardedSnapshotCoordinator,
  commonOplogIntersection,
  normalizeComponentRequests,
  validateComponentIdentity
} = require('./mongodb-sharded-snapshot');

function timestamp(seconds, increment = 1) { return { $timestamp: { t: seconds, i: increment } }; }

function rawRouterTopology(overrides = {}) {
  return {
    configServer: 'configRs/cfg01.example.com:27019,cfg02.example.com:27019',
    shards: [
      { _id: 'shard-a', host: 'rsA/a01.example.com:27017,a02.example.com:27017', state: 1 },
      { _id: 'shard-b', host: 'rsB/b01.example.com:27017,b02.example.com:27017', state: 1 }
    ],
    databasePrimaries: [{ _id: 'orders', primary: 'shard-a', partitioned: true, version: { uuid: 'database-version' } }],
    collectionCount: 1,
    collections: [{ _id: 'orders.events', uuid: { $uuid: '01234567-89ab-cdef-0123-456789abcdef' }, key: { tenantId: 1 }, unique: false, timestamp: timestamp(500) }],
    chunks: {
      count: 2,
      head: [{ _id: 'chunk-a', shard: 'shard-a', min: { tenantId: 0 }, max: { tenantId: 100 } }],
      tail: [{ _id: 'chunk-b', shard: 'shard-b', min: { tenantId: 100 }, max: { tenantId: 200 } }],
      byShard: [{ _id: 'shard-a', count: 1 }, { _id: 'shard-b', count: 1 }]
    },
    balancer: { mode: 'full', inBalancerRound: false, numBalancerRounds: 8, settings: { mode: 'full' } },
    operationTime: timestamp(510),
    ...overrides
  };
}

function routerIdentity(topologyOverrides = {}) {
  const clusterId = 'ObjectId(fedcba987654321001234567)';
  return {
    topology: 'sharded', deploymentId: clusterId, clusterId, setName: null, replicaSetId: null,
    version: '8.0.4', featureCompatibilityVersion: '8.0', shardedTopology: normalizeShardedTopology(rawRouterTopology(topologyOverrides))
  };
}

const COMPONENTS = {
  configRs: { role: 'config-server', hosts: ['cfg01.example.com:27019', 'cfg02.example.com:27019'], id: 'ObjectId(000000000000000000000001)', range: [100, 420] },
  rsA: { role: 'shard', hosts: ['a01.example.com:27017', 'a02.example.com:27017'], id: 'ObjectId(000000000000000000000002)', range: [150, 400] },
  rsB: { role: 'shard', hosts: ['b01.example.com:27017', 'b02.example.com:27017'], id: 'ObjectId(000000000000000000000003)', range: [120, 450] }
};

function componentIdentity(setName, overrides = {}) {
  const spec = COMPONENTS[setName];
  const range = overrides.range || spec.range;
  return {
    topology: 'replica-set', deploymentId: spec.id, replicaSetId: spec.id, replicaRole: spec.role, setName,
    version: '8.0.4', featureCompatibilityVersion: '8.0', members: spec.hosts,
    oplog: {
      earliest: { ts: timestamp(range[0]), t: 2, h: `${setName}-first` },
      latest: { ts: timestamp(range[1]), t: 2, h: `${setName}-latest` }
    },
    replicaStatus: {
      lastCommittedOpTime: { timestamp: timestamp(range[1] - 2), term: 2 },
      members: [
        { name: spec.hosts[0], state: 'PRIMARY', health: 1, self: true, uptimeSeconds: 1000, optime: timestamp(range[1]), arbiterOnly: false, hidden: false, secondaryDelaySeconds: 0, votes: 1, priority: 1 },
        { name: spec.hosts[1], state: 'SECONDARY', health: 1, self: false, uptimeSeconds: 900, optime: timestamp(range[1] - 1), syncSourceHost: spec.hosts[0], arbiterOnly: false, hidden: false, secondaryDelaySeconds: 0, votes: 1, priority: 1 }
      ]
    },
    ...overrides
  };
}

function connection(host, replicaSet, secretRefId) {
  return { host, port: replicaSet === 'configRs' ? 27019 : 27017, username: 'backup', passwordSecretRefId: secretRefId, authSource: 'admin', replicaSet, expectedTopology: 'replica-set', tlsMode: 'verify-identity', timeoutMs: 5000 };
}

function routerConnection() {
  return { host: 'router.example.com', port: 27017, username: 'backup', passwordSecretRefId: 'secret-router', authSource: 'admin', expectedTopology: 'sharded', tlsMode: 'verify-identity', timeoutMs: 5000 };
}

function componentRequests(identities) {
  return [
    { role: 'config-server', connection: connection('cfg01.example.com', 'configRs', 'secret-config'), replicaSetId: identities.configRs.replicaSetId, serverIdentityFingerprint: deploymentFingerprint(identities.configRs), providerId: 'provider.config', layout: { dbPath: '/data/config' } },
    { role: 'shard', shardId: 'shard-a', connection: connection('a01.example.com', 'rsA', 'secret-a'), replicaSetId: identities.rsA.replicaSetId, serverIdentityFingerprint: deploymentFingerprint(identities.rsA), providerId: 'provider.a', layout: { dbPath: '/data/a' } },
    { role: 'shard', shardId: 'shard-b', connection: connection('b01.example.com', 'rsB', 'secret-b'), replicaSetId: identities.rsB.replicaSetId, serverIdentityFingerprint: deploymentFingerprint(identities.rsB), providerId: 'provider.b', layout: { dbPath: '/data/b' } }
  ];
}

function fixture(options = {}) {
  const router = routerIdentity();
  const stoppedRouter = structuredClone(router);
  stoppedRouter.shardedTopology.balancer = { ...stoppedRouter.shardedTopology.balancer, mode: 'off', running: false, inBalancerRound: false };
  const changedRouter = routerIdentity({
    chunks: {
      count: 3,
      head: [{ _id: 'chunk-a', shard: 'shard-a' }],
      tail: [{ _id: 'chunk-c', shard: 'shard-b' }],
      byShard: [{ _id: 'shard-a', count: 1 }, { _id: 'shard-b', count: 2 }]
    },
    balancer: { mode: 'off', inBalancerRound: false, numBalancerRounds: 8 }
  });
  const identities = {
    configRs: componentIdentity('configRs', options.configOverrides),
    rsA: componentIdentity('rsA', options.aOverrides),
    rsB: componentIdentity('rsB', options.bOverrides)
  };
  const secrets = { 'secret-router': 'router-password', 'secret-config': 'config-password', 'secret-a': 'shard-a-password', 'secret-b': 'shard-b-password' };
  const events = [];
  const leaseUpdates = [];
  const state = { gateActive: Boolean(options.gateInitiallyActive), gateLeaseId: options.gateLeaseId || 'write-gate-lease', gateOwner: options.gateOwner || 'mongodb-sharded-backup:local:run-test', gateReleaseFails: Boolean(options.gateReleaseFails) };
  let componentStartedResolve;
  const componentStarted = new Promise((resolve) => { componentStartedResolve = resolve; });
  let routerReads = 0;
  const adapter = {
    async readIdentity(context, config) {
      const secret = await context.resolveSecret(config.passwordSecretRefId);
      assert.equal(secret, secrets[config.passwordSecretRefId]);
      events.push(`identity:${config.replicaSet || 'router'}:${config.passwordSecretRefId}`);
      if (config.expectedTopology === 'sharded') {
        routerReads += 1;
        if (options.mutateTopology && routerReads >= 3) return structuredClone(changedRouter);
        return structuredClone(routerReads >= 2 ? stoppedRouter : router);
      }
      return structuredClone(identities[config.replicaSet]);
    },
    async setBalancerState(_context, _config, action) {
      events.push(`balancer:${action}`);
      if (options.balancerStartFails && action === 'start') throw new Error('unsafe detail');
      if (action === 'status' && options.balancerInitiallyStopped) return { action, running: false, inBalancerRound: false, mode: 'off', operationTime: timestamp(511) };
      return { action, running: action !== 'stop', inBalancerRound: false, mode: action === 'stop' ? 'off' : 'full', operationTime: timestamp(511) };
    }
  };
  const componentSnapshotService = {
    async prepare(_context, request) {
      const componentId = request.role === 'config-server' ? 'config-server' : `shard:${request.shardId}`;
      events.push(`capture:${componentId}`);
      if (options.failComponent === componentId) throw new Error('provider internals must not escape');
      if (options.blockComponent === componentId) {
        componentStartedResolve();
        await new Promise((resolve, reject) => {
          if (_context.signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED' }));
          _context.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'PROVIDER_CANCELED' })), { once: true });
        });
      }
      let released = false;
      return {
        metadata: { deployment: { replicaSetId: identities[request.connection.replicaSet].replicaSetId, setName: request.connection.replicaSet }, operationTime: timestamp(390) },
        artifactPath: `mongodb/${componentId}.snapshot`,
        async content() { return Readable.from([Buffer.from(componentId)]); },
        async release(reason) { if (released) return false; released = true; events.push(`discard:${componentId}:${reason}`); return true; }
      };
    }
  };
  const writeGate = {
    async enter(input) {
      events.push(`gate:enter:${input.clusterId}`);
      state.gateActive = true; state.gateLeaseId = 'write-gate-lease'; state.gateOwner = options.gateOwnerMismatch ? 'different-owner' : input.leaseOwner;
      return { leaseId: state.gateLeaseId, leaseOwner: state.gateOwner, active: true };
    },
    async inspect(input) {
      events.push(`gate:inspect:${input.leaseId}`);
      return { leaseId: state.gateLeaseId, leaseOwner: options.gateInspectOwnerMismatch ? 'different-owner' : state.gateOwner, active: state.gateActive };
    },
    async release(input) {
      events.push(`gate:release:${input.lease.leaseId}`);
      if (state.gateReleaseFails) throw new Error('unsafe detail');
      state.gateActive = false;
      return { released: true, leaseOwner: input.leaseOwner };
    }
  };
  const coordinator = new MongoDbShardedSnapshotCoordinator({ adapter, componentSnapshotService, writeGate, clock: () => '2026-08-04T14:00:00.000Z' });
  const request = { routerConnection: routerConnection(), serverIdentityFingerprint: deploymentFingerprint(router), clusterId: router.clusterId, leaseOwner: 'mongodb-sharded-backup:local:run-test', components: componentRequests(identities), writeGateConfiguration: { mode: 'approved-maintenance' } };
  return { coordinator, request, router, identities, events, leaseUpdates, state, componentStarted, context: { resolveSecret: async (id) => secrets[id], onLease: async (lease) => leaseUpdates.push(structuredClone(lease)) } };
}

test('requires exactly one tested config-server path and every authenticated shard path', () => {
  const value = fixture();
  assert.throws(() => normalizeComponentRequests(value.router, value.request.components.slice(0, 2)), (error) => error.code === 'MONGODB_SHARDED_COMPONENT_MISSING');
  assert.throws(() => normalizeComponentRequests(value.router, [...value.request.components, { ...value.request.components[2], shardId: 'shard-extra' }]), (error) => error.code === 'MONGODB_SHARDED_COMPONENT_EXTRA');
  const wrongSet = structuredClone(value.request.components);
  wrongSet[1].connection.replicaSet = 'rsB';
  assert.throws(() => normalizeComponentRequests(value.router, wrongSet), (error) => error.code === 'MONGODB_SHARDED_COMPONENT_SET_MISMATCH');
});

test('authenticates exact component role, set name, replica-set ID, membership, and health', () => {
  const value = fixture();
  const components = normalizeComponentRequests(value.router, value.request.components);
  assert.equal(validateComponentIdentity(components[0], value.identities.configRs).replicaRole, 'config-server');
  assert.throws(() => validateComponentIdentity(components[1], { ...value.identities.rsA, replicaSetId: 'ObjectId(changed)', deploymentId: 'ObjectId(changed)' }), (error) => error.code === 'MONGODB_SHARDED_COMPONENT_IDENTITY_CHANGED');
  assert.throws(() => validateComponentIdentity(components[1], { ...value.identities.rsA, members: ['a01.example.com:27017'] }), (error) => error.code === 'MONGODB_SHARDED_COMPONENT_MEMBERSHIP_CHANGED');
});

test('calculates only the common component oplog interval and refuses an empty intersection', () => {
  const value = fixture();
  const components = normalizeComponentRequests(value.router, value.request.components).map((component) => ({ ...component, identity: value.identities[component.expectedSetName] }));
  const common = commonOplogIntersection(components);
  assert.deepEqual(common.start, timestamp(150));
  assert.deepEqual(common.end, timestamp(400));
  const noCommon = fixture({ bOverrides: { range: [500, 600] } });
  const divergent = normalizeComponentRequests(noCommon.router, noCommon.request.components).map((component) => ({ ...component, identity: noCommon.identities[component.expectedSetName] }));
  assert.throws(() => commonOplogIntersection(divergent), (error) => error.code === 'MONGODB_SHARDED_COMMON_RANGE_EMPTY');
});

test('holds the write gate, stops balancing, captures every component, and cleans up in reverse order', async () => {
  const value = fixture();
  const prepared = await value.coordinator.prepare(value.context, value.request);
  assert.deepEqual(prepared.metadata.commonRecoveryInterval.start, timestamp(150));
  assert.deepEqual(prepared.metadata.commonRecoveryInterval.end, timestamp(400));
  assert.deepEqual(prepared.metadata.components.map((item) => item.componentId), ['config-server', 'shard:shard-a', 'shard:shard-b']);
  assert.equal(JSON.stringify(prepared.metadata).includes('password'), false);
  assert.deepEqual(value.events.filter((item) => item.startsWith('balancer:')), ['balancer:status', 'balancer:stop', 'balancer:start']);
  assert.equal(value.events.indexOf('balancer:start') < value.events.indexOf('gate:release:write-gate-lease'), true);
  assert.deepEqual(value.leaseUpdates.map((lease) => lease.state), ['acquiring', 'active', 'active', 'active', 'active', 'released']);
  assert.equal(prepared.coordinationLease.ownerId, value.request.leaseOwner);
  assert.equal(prepared.coordinationLease.balancer.state, 'restored');
  assert.equal(prepared.coordinationLease.writeGate.state, 'released');
  await prepared.release('export-complete');
  assert.deepEqual(value.events.filter((item) => item.startsWith('discard:')), ['discard:shard:shard-b:export-complete', 'discard:shard:shard-a:export-complete', 'discard:config-server:export-complete']);
});

test('refuses partial capture and always restores balancer and write-gate state', async () => {
  const value = fixture({ failComponent: 'shard:shard-b' });
  await assert.rejects(value.coordinator.prepare(value.context, value.request), (error) => error.code === 'MONGODB_SHARDED_COMPONENT_CAPTURE_FAILED' && !error.message.includes('internals'));
  assert.deepEqual(value.events.filter((item) => item.startsWith('discard:')), ['discard:shard:shard-a:cluster-capture-failed', 'discard:config-server:cluster-capture-failed']);
  assert.deepEqual(value.events.filter((item) => item.startsWith('balancer:')), ['balancer:status', 'balancer:stop', 'balancer:start']);
  assert.equal(value.events.at(-1), 'discard:config-server:cluster-capture-failed');
  assert.equal(value.events.includes('gate:release:write-gate-lease'), true);
});

test('discards all components when routing metadata changes during capture', async () => {
  const value = fixture({ mutateTopology: true });
  await assert.rejects(value.coordinator.prepare(value.context, value.request), (error) => error.code === 'MONGODB_SHARDED_TOPOLOGY_CHANGED');
  assert.equal(value.events.filter((item) => item.startsWith('capture:')).length, 3);
  assert.equal(value.events.filter((item) => item.startsWith('discard:')).length, 3);
  assert.equal(value.events.includes('balancer:start'), true);
  assert.equal(value.events.includes('gate:release:write-gate-lease'), true);
});

test('fails closed and discards all captures when balancer or write-gate cleanup is unproven', async () => {
  for (const options of [{ balancerStartFails: true }, { gateReleaseFails: true }]) {
    const value = fixture(options);
    await assert.rejects(value.coordinator.prepare(value.context, value.request), (error) => error.code === 'MONGODB_SHARDED_CLEANUP_FAILED' && !error.message.includes('detail'));
    assert.equal(value.events.filter((item) => item.startsWith('discard:')).length, 3);
    assert.equal(value.leaseUpdates.at(-1).state, 'cleanup-unproven');
  }
});

test('requires the write gate to echo the exact durable coordination owner', async () => {
  const value = fixture({ gateOwnerMismatch: true });
  await assert.rejects(value.coordinator.prepare(value.context, value.request), (error) => error.code === 'MONGODB_SHARDED_WRITE_GATE_OWNER_MISMATCH');
  assert.equal(value.events.includes('gate:release:null'), true);
  assert.equal(value.leaseUpdates.at(-1).state, 'released');
});

test('cancels cluster capture and durably restores balancer and write-gate state', async () => {
  const value = fixture({ blockComponent: 'shard:shard-a' });
  const controller = new AbortController();
  const operation = value.coordinator.prepare({ ...value.context, signal: controller.signal }, value.request);
  await value.componentStarted;
  controller.abort();
  await assert.rejects(operation, (error) => error.code === 'MONGODB_SHARDED_CAPTURE_CANCELED');
  assert.equal(value.events.includes('balancer:start'), true);
  assert.equal(value.events.includes('gate:release:write-gate-lease'), true);
  assert.equal(value.leaseUpdates.at(-1).state, 'released');
  assert.equal(value.leaseUpdates.at(-1).balancer.state, 'restored');
});

test('reconciles an exact-owned interrupted sharded gate and retries transient cleanup', async () => {
  const value = fixture({ gateInitiallyActive: true, balancerInitiallyStopped: true, gateReleaseFails: true });
  const lease = {
    version: 1, kind: 'mongodb-sharded-coordination', ownerId: value.request.leaseOwner,
    clusterId: value.request.clusterId, serverIdentityFingerprint: value.request.serverIdentityFingerprint,
    topologyFingerprint: shardedTopologyFingerprint(value.router),
    writeGate: { leaseId: 'write-gate-lease', state: 'active' },
    balancer: { wasRunning: true, state: 'stopped' }, state: 'cleanup-unproven'
  };
  const request = { lease, leaseOwner: value.request.leaseOwner, routerConnection: value.request.routerConnection };
  const first = await value.coordinator.reconcile(value.context, request);
  assert.equal(first.proven, false);
  assert.equal(first.lease.state, 'cleanup-unproven');
  value.state.gateReleaseFails = false;
  const second = await value.coordinator.reconcile(value.context, request);
  assert.equal(second.proven, true);
  assert.equal(second.lease.state, 'released');
  assert.equal(second.lease.balancer.state, 'restored');
  assert.equal(second.lease.writeGate.state, 'released');
});

test('refuses sharded cleanup when durable owner evidence does not match', async () => {
  const value = fixture({ gateInitiallyActive: true, balancerInitiallyStopped: true });
  const lease = {
    version: 1, kind: 'mongodb-sharded-coordination', ownerId: 'different-owner',
    clusterId: value.request.clusterId, serverIdentityFingerprint: value.request.serverIdentityFingerprint,
    topologyFingerprint: shardedTopologyFingerprint(value.router),
    writeGate: { leaseId: 'write-gate-lease', state: 'active' },
    balancer: { wasRunning: true, state: 'stopped' }, state: 'active'
  };
  const before = value.events.length;
  const reconciled = await value.coordinator.reconcile(value.context, { lease, leaseOwner: value.request.leaseOwner, routerConnection: value.request.routerConnection });
  assert.equal(reconciled.proven, false);
  assert.equal(reconciled.lease, lease);
  assert.equal(value.events.length, before);
});
