const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DatabaseAdapterError,
  DatabaseAdapterRegistry,
  assertSecretRefOnlyCredentials,
  normalizeDatabaseSelector,
  resolveConsistencyPlan
} = require('./database-adapter');

function manifest(overrides = {}) {
  return {
    apiVersion: 1,
    adapterId: 'deployerx.database.test.logical',
    adapterVersion: '1.2.3',
    displayName: 'TestDB logical',
    engine: 'testdb',
    serverVersionRange: '>=10 <20',
    restoreVersionRange: '>=10 <21',
    capabilities: {
      backupMethods: ['logical'],
      backupModes: ['full'],
      selection: { database: true, schema: true, table: true, globalObjects: true },
      consistencyStrategies: [
        { id: 'transaction-snapshot', produces: 'application', backupMethods: ['logical'], lockScope: 'none', capturesCoordinates: true },
        { id: 'storage-snapshot', produces: 'crash', backupMethods: ['logical'], lockScope: 'instance', capturesCoordinates: false }
      ],
      transactionLogs: { supported: true, type: 'test-log', pointInTimeRecovery: false, granularitySeconds: null },
      streaming: { backup: true, restore: true, compression: true, encryption: false },
      restore: { alternateTarget: true, nativeValidation: true },
      replicaAware: true
    },
    requiredTools: [{ name: 'testdump', versionRange: '>=10 <20', operations: ['backup', 'restore'] }],
    requiredPrivileges: [{ id: 'read-data', operations: ['backup'], required: true, safeDescription: 'Read selected data.' }],
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    checkedAt: '2026-08-03T12:00:00.000Z',
    serverVersion: '15.2',
    serverVersionSupported: true,
    serverIdentityFingerprint: 'sha256:server-identity',
    consistency: [{ method: 'transaction-snapshot', verified: true, produces: 'application' }],
    tools: [{ name: 'testdump', version: '15.2', compatible: true, executableFingerprint: 'sha256:tool' }],
    privileges: [{ id: 'read-data', allowed: true, evidence: 'Read-only privilege probe succeeded.' }],
    coordinateCaptureVerified: true,
    warnings: [],
    ...overrides
  };
}

function adapter(overrides = {}) {
  return {
    manifest,
    async testConnection() { return { status: 'success' }; },
    async *discover() { yield { items: [] }; },
    async preflight() { return evidence(); },
    async planBackup(_context, request) { return { artifactKinds: ['database-dump', 'metadata'], method: request.consistency.method }; },
    async executeBackup() { return { status: 'succeeded' }; },
    async planRestore() { return {}; },
    async executeRestore() { return { status: 'succeeded' }; },
    async validateRestore() { return { valid: true }; },
    ...overrides
  };
}

test('registers only complete, version-compatible database adapters', () => {
  const registry = new DatabaseAdapterRegistry([adapter()]);
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].adapterId, 'deployerx.database.test.logical');
  assert.equal(Object.isFrozen(registry.manifest(listed[0].adapterId)), true);
  assert.throws(() => registry.register(adapter()), (error) => error.code === 'DATABASE_ADAPTER_DUPLICATE');
  assert.throws(() => new DatabaseAdapterRegistry([adapter({ executeBackup: undefined })]), (error) => error.code === 'DATABASE_ADAPTER_INVALID');
  assert.throws(() => new DatabaseAdapterRegistry([adapter({ manifest: () => manifest({ apiVersion: 2 }) })]), (error) => error.code === 'DATABASE_ADAPTER_API_INCOMPATIBLE');
});

test('normalizes explicit database object selection and produces a stable digest', () => {
  const registry = new DatabaseAdapterRegistry([adapter()]);
  const capabilities = registry.manifest('deployerx.database.test.logical').capabilities;
  const input = {
    allDatabases: false,
    databases: { include: [{ name: 'orders' }, { name: 'accounts' }, { name: 'orders' }], exclude: [{ name: 'archive' }] },
    schemas: { include: [{ database: 'orders', name: 'public' }] },
    tables: { exclude: [{ database: 'orders', schema: 'public', name: 'temporary' }] },
    includeGlobalObjects: true
  };
  const first = normalizeDatabaseSelector(input, capabilities);
  const second = normalizeDatabaseSelector(input, capabilities);
  assert.deepEqual(first.databases.include.map((item) => item.name), ['accounts', 'orders']);
  assert.equal(first.kind, 'database-objects');
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.throws(() => normalizeDatabaseSelector({ databases: { include: [] } }, capabilities), (error) => error.code === 'DATABASE_SELECTION_EMPTY');
  assert.throws(() => normalizeDatabaseSelector({ allDatabases: true, databases: { include: [{ name: 'same' }], exclude: [{ name: 'same' }] } }, capabilities), (error) => error.code === 'DATABASE_SELECTION_CONFLICT');
  assert.throws(() => normalizeDatabaseSelector({ allDatabases: true, databases: { include: [{ name: 'orders' }] } }, capabilities), (error) => error.code === 'DATABASE_SELECTION_CONFLICT');
  assert.throws(() => normalizeDatabaseSelector({ databases: { include: [{ name: 'orders' }] }, schemas: { include: [{ database: 'accounts', name: 'public' }] } }, capabilities), (error) => error.code === 'DATABASE_SELECTION_CONFLICT');
});

test('refuses child-object rules beneath all-database selection', () => {
  const capabilities = { selection: { database: true, schema: true, table: true, globalObjects: false } };
  assert.throws(() => normalizeDatabaseSelector({
    allDatabases: true,
    tables: { include: [{ database: 'orders', schema: 'public', name: 'invoices' }] }
  }, capabilities), (error) => error.code === 'DATABASE_SELECTION_CONFLICT');
});

test('fails closed unless server, tools, privileges, and requested consistency are proven', () => {
  const normalizedManifest = new DatabaseAdapterRegistry([adapter()]).manifest('deployerx.database.test.logical');
  const request = { requestedLevel: 'application', method: 'auto', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true };
  const plan = resolveConsistencyPlan(normalizedManifest, request, evidence());
  assert.equal(plan.proven, true);
  assert.equal(plan.method, 'transaction-snapshot');
  assert.equal(plan.achievedLevel, 'application');
  assert.equal(plan.evidence.nativeTools[0].executableFingerprint, 'sha256:tool');
  assert.throws(() => resolveConsistencyPlan(normalizedManifest, request, evidence({ consistency: [] })), (error) => error.code === 'DATABASE_CONSISTENCY_UNPROVEN');
  assert.throws(() => resolveConsistencyPlan(normalizedManifest, request, evidence({ tools: [] })), (error) => error.code === 'DATABASE_NATIVE_TOOL_UNAVAILABLE');
  assert.throws(() => resolveConsistencyPlan(normalizedManifest, request, evidence({ privileges: [] })), (error) => error.code === 'DATABASE_PRIVILEGE_MISSING');
  assert.throws(() => resolveConsistencyPlan(normalizedManifest, request, evidence({ coordinateCaptureVerified: false })), (error) => error.code === 'DATABASE_COORDINATE_CAPTURE_UNPROVEN');
});

test('requires explicit policy before accepting a proven weaker consistency level', () => {
  const normalizedManifest = new DatabaseAdapterRegistry([adapter()]).manifest('deployerx.database.test.logical');
  const crashEvidence = evidence({
    consistency: [{ method: 'storage-snapshot', verified: true, produces: 'crash' }],
    coordinateCaptureVerified: false
  });
  const request = { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full' };
  assert.throws(() => resolveConsistencyPlan(normalizedManifest, request, crashEvidence), (error) => error.code === 'DATABASE_CONSISTENCY_DOWNGRADE_REFUSED');
  const downgraded = resolveConsistencyPlan(normalizedManifest, { ...request, allowDowngrade: true }, crashEvidence);
  assert.equal(downgraded.achievedLevel, 'crash');
  assert.equal(downgraded.requestedLevel, 'application');
});

test('rejects plaintext credential fields and accepts SecretRef-only configuration', () => {
  assert.doesNotThrow(() => assertSecretRefOnlyCredentials({ username: 'backup', credentialSecretRefId: 'sec_12345678' }));
  assert.throws(() => assertSecretRefOnlyCredentials({ password: 'plaintext' }), (error) => error.code === 'DATABASE_PLAINTEXT_CREDENTIAL_REFUSED');
  assert.throws(() => assertSecretRefOnlyCredentials({ credentialSecretRefId: 'not-a-secret-ref' }), (error) => error.code === 'DATABASE_SECRET_REF_INVALID');
});

test('prepares an immutable plan only after adapter-owned runtime preflight', async () => {
  let preflightCalls = 0;
  const registry = new DatabaseAdapterRegistry([adapter({ async preflight() { preflightCalls += 1; return evidence(); } })]);
  const plan = await registry.prepareBackup('deployerx.database.test.logical', {}, {
    connection: { endpoint: { host: 'db.example.com' }, credentialSecretRefId: 'sec_12345678' },
    selector: { databases: { include: [{ name: 'orders' }] } },
    consistency: { requestedLevel: 'application', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
  });
  assert.equal(preflightCalls, 1);
  assert.equal(plan.consistency.proven, true);
  assert.equal(plan.adapterPlan.method, 'transaction-snapshot');
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(plan), true);
});

test('database adapter errors expose only stable safe fields', () => {
  const error = new DatabaseAdapterError('DATABASE_TEST', 'Safe message', { category: 'consistency', details: { reason: 'bounded' } });
  assert.deepEqual({ code: error.code, message: error.message, category: error.category, retryable: error.retryable, details: error.details }, {
    code: 'DATABASE_TEST', message: 'Safe message', category: 'consistency', retryable: false, details: { reason: 'bounded' }
  });
});

module.exports = { adapter, evidence, manifest };
