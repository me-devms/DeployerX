const assert = require('node:assert/strict');
const test = require('node:test');
const { cloudProfileDocument } = require('./cloud-metadata');
const { planCloudSyncOperation } = require('./cloud-sync-policy');

function profile(overrides = {}) {
  return {
    id: 'profile-a', revision: 1, name: 'Orders', driverId: 'postgresql', endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'orders', defaultSchema: 'public', environment: 'production', accessMode: 'read-write', tags: [], ssl: { mode: 'disabled' }, tunnel: { type: 'none' },
    credentialSlots: [], settings: {}, ...overrides
  };
}

test('plans create, compare-and-set update, and idempotent delete operations', () => {
  const document = cloudProfileDocument(profile(), { revision: 1 });
  assert.deepEqual(planCloudSyncOperation({ type: 'upsert', expectedRevision: 0 }, null), { action: 'upsert', actualRevision: 0, precondition: { exists: false } });
  assert.deepEqual(planCloudSyncOperation({ type: 'upsert', expectedRevision: 1 }, { ...document, __updateTime: '2026-08-05T00:00:00Z' }), { action: 'upsert', actualRevision: 1, precondition: { updateTime: '2026-08-05T00:00:00Z' } });
  assert.deepEqual(planCloudSyncOperation({ type: 'delete', expectedRevision: 0 }, null), { action: 'noop', actualRevision: 0 });
});

test('rejects stale, legacy, and non-atomic remote updates with safe conflicts', () => {
  const document = cloudProfileDocument(profile(), { revision: 3 });
  assert.throws(() => planCloudSyncOperation({ type: 'upsert', expectedRevision: 2 }, { ...document, __updateTime: 'time' }), (error) => error.code === 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT' && error.details.actualRevision === 3);
  assert.throws(() => planCloudSyncOperation({ type: 'delete', expectedRevision: null }, { ...document, __updateTime: 'time' }), (error) => error.code === 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT');
  assert.throws(() => planCloudSyncOperation({ type: 'upsert', expectedRevision: 3 }, document), (error) => error.code === 'DATABASE_MANAGER_CLOUD_PRECONDITION_UNAVAILABLE');
});
