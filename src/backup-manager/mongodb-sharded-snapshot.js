const {
  compareOplogTimestamps,
  deploymentFingerprint,
  normalizeConfig,
  oplogCoordinate,
  oplogTimestamp,
  shardedTopologyFingerprint
} = require('./mongodb');
const { MongoDbSnapshotError, selectReplicaSetMember } = require('./mongodb-snapshot');

const MAXIMUM_COMPONENTS = 1001;

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function sameStrings(left, right) {
  const a = [...new Set(left || [])].sort();
  const b = [...new Set(right || [])].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function topology(identity) {
  if (identity?.topology !== 'sharded' || !identity.clusterId || !identity.shardedTopology) throw new MongoDbSnapshotError('MONGODB_SHARDED_TOPOLOGY_MISSING', 'The router did not return authenticated sharded-cluster topology evidence.', { category: 'integrity' });
  if (!identity.shardedTopology.operationTime) throw new MongoDbSnapshotError('MONGODB_SHARDED_OPERATION_TIME_MISSING', 'The router did not return an authenticated cluster operation time.', { category: 'integrity' });
  return identity.shardedTopology;
}

function normalizeComponentRequests(routerIdentity, input = []) {
  if (!Array.isArray(input) || !input.length || input.length > MAXIMUM_COMPONENTS) throw new TypeError('MongoDB sharded component paths are invalid.');
  const routerTopology = topology(routerIdentity);
  const expected = [
    { componentId: 'config-server', role: 'config-server', shardId: null, setName: routerTopology.configServer.setName, hosts: routerTopology.configServer.hosts },
    ...routerTopology.shards.map((shard) => ({ componentId: `shard:${shard.shardId}`, role: 'shard', shardId: shard.shardId, setName: shard.setName, hosts: shard.hosts }))
  ];
  const normalized = input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('MongoDB sharded component path must be an object.');
    const role = requiredText(item.role, 'MongoDB component role', 40).toLowerCase();
    if (!['config-server', 'shard'].includes(role)) throw new TypeError('MongoDB component role is invalid.');
    const shardId = role === 'shard' ? requiredText(item.shardId, 'MongoDB shard ID', 200) : null;
    const componentId = role === 'config-server' ? 'config-server' : `shard:${shardId}`;
    const match = expected.find((candidate) => candidate.componentId === componentId);
    if (!match) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_EXTRA', 'A component path does not belong to the authenticated shard map.', { category: 'integrity' });
    const connection = normalizeConfig(item.connection);
    if (connection.expectedTopology !== 'replica-set' || connection.replicaSet !== match.setName) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_SET_MISMATCH', 'A component path does not name its authenticated replica set exactly.', { category: 'integrity' });
    return {
      componentId, role, shardId, expectedSetName: match.setName, expectedHosts: match.hosts,
      expectedReplicaSetId: requiredText(item.replicaSetId, 'MongoDB component replica-set ID', 200),
      expectedFingerprint: requiredText(item.serverIdentityFingerprint, 'MongoDB component deployment fingerprint', 200),
      request: { ...item, connection, shardId, role }
    };
  });
  if (new Set(normalized.map((item) => item.componentId)).size !== normalized.length) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_DUPLICATE', 'MongoDB sharded component paths contain a duplicate.', { category: 'integrity' });
  const missing = expected.filter((item) => !normalized.some((candidate) => candidate.componentId === item.componentId));
  if (missing.length) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_MISSING', 'The config server or one or more authenticated shards has no tested component path.', { category: 'consistency' });
  return expected.map((item) => normalized.find((candidate) => candidate.componentId === item.componentId));
}

function validateComponentIdentity(component, identity) {
  if (identity?.topology !== 'replica-set' || identity.setName !== component.expectedSetName) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_SET_MISMATCH', 'A MongoDB component path reached a different replica set.', { category: 'integrity' });
  if (identity.replicaSetId !== component.expectedReplicaSetId || deploymentFingerprint(identity) !== component.expectedFingerprint) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_IDENTITY_CHANGED', 'A MongoDB component replica-set identity changed after enrollment.', { category: 'integrity' });
  if (identity.replicaRole !== component.role) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_ROLE_MISMATCH', 'A MongoDB component path reached the wrong config-server or shard role.', { category: 'integrity' });
  if (!sameStrings(identity.members, component.expectedHosts)) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_MEMBERSHIP_CHANGED', 'MongoDB component membership differs from the authenticated router map.', { category: 'integrity' });
  selectReplicaSetMember(identity, component.request.memberPolicy);
  if (!identity.oplog?.earliest?.ts || !identity.oplog?.latest?.ts) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_OPLOG_MISSING', 'A MongoDB component did not return authenticated oplog bounds.', { category: 'consistency' });
  return identity;
}

function componentOplogRange(component) {
  const context = { serverIdentityFingerprint: component.expectedFingerprint, replicaSetId: component.expectedReplicaSetId };
  const start = oplogCoordinate(component.identity.oplog.earliest, context);
  const end = oplogCoordinate(component.identity.oplog.latest, context);
  if (compareOplogTimestamps(start.timestamp, end.timestamp) >= 0) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_RANGE_EMPTY', 'A MongoDB component has no non-empty authenticated oplog range.', { category: 'consistency' });
  return { componentId: component.componentId, replicaSetId: component.expectedReplicaSetId, start, end };
}

function commonOplogIntersection(components) {
  if (!Array.isArray(components) || !components.length) throw new TypeError('MongoDB sharded oplog components are required.');
  const ranges = components.map(componentOplogRange);
  const start = ranges.reduce((current, range) => compareOplogTimestamps(range.start.timestamp, current.start.timestamp) > 0 ? range : current).start.timestamp;
  const end = ranges.reduce((current, range) => compareOplogTimestamps(range.end.timestamp, current.end.timestamp) < 0 ? range : current).end.timestamp;
  if (compareOplogTimestamps(start, end) >= 0) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMMON_RANGE_EMPTY', 'The config server and shards have no common recoverable MongoDB time interval.', { category: 'consistency' });
  return { start, end, recoveryTime: end, components: ranges };
}

function proveRecoveryTime(component, recoveryTime) {
  const earliest = component.identity.oplog?.earliest?.ts;
  const latest = component.identity.oplog?.latest?.ts;
  if (!earliest || !latest || compareOplogTimestamps(earliest, recoveryTime) > 0 || compareOplogTimestamps(latest, recoveryTime) < 0) throw new MongoDbSnapshotError('MONGODB_SHARDED_RECOVERY_TIME_UNCOVERED', 'A MongoDB component no longer covers the selected cluster recovery time.', { category: 'consistency' });
}

async function discardPrepared(prepared, reason) {
  for (const item of [...prepared].reverse()) {
    try { await item.handle.release(reason); }
    catch (_error) {}
  }
}

function normalizeGateLease(raw, expectedOwner) {
  if (!raw || typeof raw !== 'object' || raw.active === false) throw new MongoDbSnapshotError('MONGODB_SHARDED_WRITE_GATE_UNPROVEN', 'The application maintenance gate did not prove that writes are blocked.', { category: 'consistency' });
  const leaseId = requiredText(raw.leaseId, 'MongoDB write-gate lease ID', 500);
  const leaseOwner = raw.leaseOwner ? requiredText(raw.leaseOwner, 'MongoDB write-gate lease owner', 500) : null;
  if (expectedOwner && leaseOwner !== expectedOwner) throw new MongoDbSnapshotError('MONGODB_SHARDED_WRITE_GATE_OWNER_MISMATCH', 'The application maintenance gate did not confirm the exact coordination owner.', { category: 'integrity' });
  return { ...structuredClone(raw), leaseId, leaseOwner, active: true };
}

function gateCleanupProven(raw, expectedOwner) {
  return raw?.released === true && raw.leaseOwner === expectedOwner;
}

class MongoDbShardedSnapshotCoordinator {
  constructor({ adapter, componentSnapshotService, writeGate, clock = () => new Date().toISOString() } = {}) {
    if (!adapter || typeof adapter.readIdentity !== 'function' || typeof adapter.setBalancerState !== 'function') throw new TypeError('MongoDB sharded coordinator adapter dependencies are required.');
    if (!componentSnapshotService || typeof componentSnapshotService.prepare !== 'function') throw new TypeError('MongoDB sharded component snapshot service is required.');
    if (!writeGate || typeof writeGate.enter !== 'function' || typeof writeGate.release !== 'function') throw new TypeError('An approved MongoDB application write gate is required.');
    this.adapter = adapter;
    this.componentSnapshotService = componentSnapshotService;
    this.writeGate = writeGate;
    this.clock = clock;
  }

  async prepare(context = {}, request = {}) {
    const routerConnection = normalizeConfig(request.routerConnection);
    if (routerConnection.expectedTopology !== 'sharded' || routerConnection.replicaSet) throw new MongoDbSnapshotError('MONGODB_SHARDED_ROUTER_CONFIG_INVALID', 'MongoDB sharded coordination requires an explicit mongos connection.', { category: 'validation' });
    const enrolledRouterFingerprint = requiredText(request.serverIdentityFingerprint, 'MongoDB sharded deployment fingerprint', 200);
    const enrolledClusterId = requiredText(request.clusterId, 'MongoDB sharded cluster ID', 200);
    const enrolled = await this.adapter.readIdentity(context, routerConnection, { operation: 'sharded topology enrollment recheck' });
    const enrolledTopology = topology(enrolled);
    if (deploymentFingerprint(enrolled) !== enrolledRouterFingerprint || enrolled.clusterId !== enrolledClusterId) throw new MongoDbSnapshotError('MONGODB_SHARDED_DEPLOYMENT_CHANGED', 'The MongoDB sharded deployment changed after Source enrollment.', { category: 'integrity' });
    const componentRequests = normalizeComponentRequests(enrolled, request.components);
    const authenticated = await Promise.all(componentRequests.map(async (component) => ({
      ...component,
      identity: validateComponentIdentity(component, await this.adapter.readIdentity(context, component.request.connection, { operation: `sharded ${component.componentId} preflight` }))
    })));
    const initialIntersection = commonOplogIntersection(authenticated);
    const topologyFingerprint = shardedTopologyFingerprint(enrolled);
    const leaseOwner = request.leaseOwner ? requiredText(request.leaseOwner, 'MongoDB sharded coordination owner', 500) : null;
    let coordinationLease = leaseOwner ? {
      version: 1, kind: 'mongodb-sharded-coordination', ownerId: leaseOwner, clusterId: enrolled.clusterId,
      serverIdentityFingerprint: enrolledRouterFingerprint, topologyFingerprint,
      writeGate: { leaseId: null, state: 'acquiring' },
      balancer: { wasRunning: null, state: 'unchecked' }, components: [], state: 'acquiring', acquiredAt: this.clock(), updatedAt: this.clock()
    } : null;
    const publishLease = async (changes = {}) => {
      if (!coordinationLease) return null;
      coordinationLease = { ...coordinationLease, ...structuredClone(changes), updatedAt: this.clock() };
      if (typeof context.onLease === 'function') await context.onLease(structuredClone(coordinationLease));
      return coordinationLease;
    };
    if (coordinationLease) await publishLease();
    let gateLease = null;
    let resumeBalancer = false;
    let prepared = [];
    let result = null;
    let failure = null;
    try {
      gateLease = normalizeGateLease(await this.writeGate.enter({ leaseOwner, clusterId: enrolled.clusterId, topologyFingerprint, signal: context.signal, configuration: structuredClone(request.writeGateConfiguration || {}) }), leaseOwner);
      await publishLease({ writeGate: { leaseId: gateLease.leaseId, state: 'active' }, state: 'active' });
      const status = await this.adapter.setBalancerState(context, routerConnection, 'status');
      resumeBalancer = status.running || status.inBalancerRound;
      await publishLease({ balancer: { wasRunning: resumeBalancer, state: resumeBalancer ? 'stopping' : 'already-stopped' } });
      if (resumeBalancer) {
        await this.adapter.setBalancerState(context, routerConnection, 'stop');
        await publishLease({ balancer: { wasRunning: true, state: 'stopped' } });
      }
      const beforeCapture = await this.adapter.readIdentity(context, routerConnection, { operation: 'sharded topology capture preflight' });
      const captureTopology = topology(beforeCapture);
      if (beforeCapture.clusterId !== enrolled.clusterId || deploymentFingerprint(beforeCapture) !== enrolledRouterFingerprint || shardedTopologyFingerprint(beforeCapture) !== shardedTopologyFingerprint(enrolled)) throw new MongoDbSnapshotError('MONGODB_SHARDED_TOPOLOGY_CHANGED', 'MongoDB sharded topology changed before component capture.', { category: 'integrity' });
      if (captureTopology.balancer.running || captureTopology.balancer.inBalancerRound) throw new MongoDbSnapshotError('MONGODB_SHARDED_BALANCER_ACTIVE', 'MongoDB balancing was not stopped before component capture.', { category: 'consistency' });
      for (const component of authenticated) {
        const componentContext = coordinationLease ? {
          ...context,
          onLease: async (componentLease) => {
            const components = (coordinationLease.components || []).filter((item) => item.componentId !== component.componentId);
            components.push({ componentId: component.componentId, providerLease: structuredClone(componentLease) });
            components.sort((left, right) => left.componentId.localeCompare(right.componentId, 'en-US'));
            await publishLease({ components });
          }
        } : context;
        const handle = await this.componentSnapshotService.prepare(componentContext, { ...component.request, serverIdentityFingerprint: component.expectedFingerprint });
        if (!handle || typeof handle.release !== 'function' || typeof handle.content !== 'function' || !handle.metadata) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_CAPTURE_INVALID', 'A MongoDB component snapshot did not return exportable authenticated media.', { category: 'integrity' });
        prepared.push({ component, handle });
        if (handle.metadata.deployment?.replicaSetId !== component.expectedReplicaSetId || handle.metadata.deployment?.setName !== component.expectedSetName) throw new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_CAPTURE_MISMATCH', 'A MongoDB component snapshot belongs to a different replica set.', { category: 'integrity' });
      }
      const afterCapture = await this.adapter.readIdentity(context, routerConnection, { operation: 'sharded topology capture postcheck' });
      if (afterCapture.clusterId !== enrolled.clusterId || deploymentFingerprint(afterCapture) !== enrolledRouterFingerprint || shardedTopologyFingerprint(afterCapture) !== shardedTopologyFingerprint(beforeCapture)) throw new MongoDbSnapshotError('MONGODB_SHARDED_TOPOLOGY_CHANGED', 'MongoDB sharded topology changed during component capture.', { category: 'integrity' });
      const finalComponents = await Promise.all(authenticated.map(async (component) => ({
        ...component,
        identity: validateComponentIdentity(component, await this.adapter.readIdentity(context, component.request.connection, { operation: `sharded ${component.componentId} postcheck` }))
      })));
      for (const component of finalComponents) proveRecoveryTime(component, initialIntersection.recoveryTime);
      result = {
        metadata: {
          version: 1, kind: 'mongodb-sharded-coordinated-snapshot', adapterId: 'deployerx.database.mongodb.native', engine: 'mongodb',
          consistency: { requestedLevel: 'application', achievedLevel: 'application', method: 'mongodb-sharded-coordinated-snapshot', backupMethod: 'physical', backupMode: 'full', proven: true },
          cluster: { clusterId: enrolled.clusterId, serverIdentityFingerprint: enrolledRouterFingerprint, topologyFingerprint: shardedTopologyFingerprint(beforeCapture), operationTime: captureTopology.operationTime },
          commonRecoveryInterval: initialIntersection,
          components: prepared.map(({ component, handle }) => ({ componentId: component.componentId, role: component.role, shardId: component.shardId, replicaSetId: component.expectedReplicaSetId, setName: component.expectedSetName, artifactPath: handle.artifactPath, metadata: structuredClone(handle.metadata) })),
          coordination: { writeGateProven: true, balancerStopped: true, balancerResumed: resumeBalancer, capturedAt: this.clock() }
        },
        coordinationLease: null,
        components: prepared.map(({ component, handle }) => ({ componentId: component.componentId, artifactPath: handle.artifactPath, content: () => handle.content() })),
        async release(reason = 'export-complete') {
          await discardPrepared(prepared, reason);
          return true;
        }
      };
    } catch (error) {
      failure = context.signal?.aborted
        ? new MongoDbSnapshotError('MONGODB_SHARDED_CAPTURE_CANCELED', 'MongoDB sharded-cluster capture was canceled.', { category: 'canceled' })
        : error instanceof MongoDbSnapshotError ? error : new MongoDbSnapshotError('MONGODB_SHARDED_COMPONENT_CAPTURE_FAILED', 'MongoDB could not capture every sharded-cluster component.', { category: 'execution', retryable: true });
    } finally {
      let cleanupFailed = false;
      if (resumeBalancer) {
        try {
          await this.adapter.setBalancerState({ ...context, signal: undefined }, routerConnection, 'start');
          await publishLease({ balancer: { wasRunning: true, state: 'restored' } });
        }
        catch (_error) { cleanupFailed = true; }
      }
      if (gateLease || coordinationLease) {
        try {
          const released = await this.writeGate.release({ lease: gateLease || { leaseId: coordinationLease.writeGate.leaseId, leaseOwner }, leaseOwner, clusterId: enrolled.clusterId, signal: undefined });
          if (leaseOwner && !gateCleanupProven(released, leaseOwner)) throw new Error('write-gate cleanup unproven');
          await publishLease({ writeGate: { leaseId: gateLease?.leaseId || coordinationLease?.writeGate?.leaseId || null, state: 'released' }, state: cleanupFailed ? 'cleanup-unproven' : 'released', releasedAt: this.clock() });
        }
        catch (_error) { cleanupFailed = true; }
      }
      if (cleanupFailed) {
        await publishLease({ state: 'cleanup-unproven' }).catch(() => {});
        failure = new MongoDbSnapshotError('MONGODB_SHARDED_CLEANUP_FAILED', 'MongoDB could not prove balancer and application write-gate cleanup; all component snapshots were discarded.', { category: 'consistency', retryable: true });
      }
      if (failure) await discardPrepared(prepared, 'cluster-capture-failed');
    }
    if (failure) throw failure;
    if (result) result.coordinationLease = coordinationLease ? structuredClone(coordinationLease) : null;
    return result;
  }

  async reconcile(context = {}, request = {}) {
    const lease = request.lease;
    if (!lease || lease.kind !== 'mongodb-sharded-coordination' || !['acquiring', 'active', 'cleanup-unproven'].includes(lease.state)) return { applicable: false, proven: true, lease: lease || null };
    const expectedOwner = requiredText(request.leaseOwner, 'MongoDB sharded reconciliation owner', 500);
    if (lease.ownerId !== expectedOwner || !lease.clusterId || !lease.serverIdentityFingerprint || !lease.topologyFingerprint) return { applicable: true, proven: false, lease };
    if (typeof this.writeGate.inspect !== 'function') return { applicable: true, proven: false, lease };
    try {
      const gate = await this.writeGate.inspect({ leaseId: lease.writeGate?.leaseId || null, leaseOwner: expectedOwner, clusterId: lease.clusterId, signal: undefined });
      if (!gate || gate.leaseOwner !== expectedOwner || (gate.leaseId || null) !== (lease.writeGate?.leaseId || null)) return { applicable: true, proven: false, lease };
      const routerConnection = normalizeConfig(request.routerConnection);
      const identity = await this.adapter.readIdentity({ ...context, signal: undefined }, routerConnection, { operation: 'sharded coordination restart reconciliation' });
      if (identity.clusterId !== lease.clusterId || deploymentFingerprint(identity) !== lease.serverIdentityFingerprint || shardedTopologyFingerprint(identity) !== lease.topologyFingerprint) return { applicable: true, proven: false, lease };
      let balancer = { ...(lease.balancer || {}) };
      if (balancer.wasRunning === true) {
        const status = await this.adapter.setBalancerState({ ...context, signal: undefined }, routerConnection, 'status');
        if (!status.running || status.inBalancerRound) await this.adapter.setBalancerState({ ...context, signal: undefined }, routerConnection, 'start');
        balancer = { wasRunning: true, state: 'restored' };
      }
      if (gate.active !== false) {
        const released = await this.writeGate.release({ lease: { leaseId: gate.leaseId || null, leaseOwner: expectedOwner }, leaseOwner: expectedOwner, clusterId: lease.clusterId, signal: undefined });
        if (!gateCleanupProven(released, expectedOwner)) return { applicable: true, proven: false, lease };
      }
      const releasedAt = this.clock();
      return { applicable: true, proven: true, lease: { ...lease, balancer, writeGate: { leaseId: gate.leaseId || null, state: 'released' }, state: 'released', releasedAt, updatedAt: releasedAt } };
    } catch (_error) {
      return { applicable: true, proven: false, lease };
    }
  }
}

module.exports = {
  MongoDbShardedSnapshotCoordinator,
  commonOplogIntersection,
  normalizeComponentRequests,
  validateComponentIdentity
};
