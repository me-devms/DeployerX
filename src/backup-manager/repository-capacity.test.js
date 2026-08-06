const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateRepositoryCapacity, normalizeStoragePolicy } = require('./repository-capacity');

const NOW = '2026-08-03T12:00:00.000Z';

test('normalizes bounded quota, reserve, warning, and capacity-proof policy', () => {
  assert.deepEqual(normalizeStoragePolicy({ quotaBytes: 1000, reserveBytes: 100, reservePercent: 10, warningPercent: 20, criticalPercent: 5, minimumBackupBytes: 50, requireCapacityProof: true }), {
    version: 1, quotaBytes: 1000, reserveBytes: 100, reservePercent: 10, warningPercent: 20, criticalPercent: 5, minimumBackupBytes: 50, requireCapacityProof: true
  });
  assert.throws(() => normalizeStoragePolicy({ warningPercent: 5, criticalPercent: 5 }), (error) => error.code === 'REPOSITORY_STORAGE_POLICY_INVALID');
  assert.throws(() => normalizeStoragePolicy({ quotaBytes: 0 }), (error) => error.code === 'REPOSITORY_STORAGE_POLICY_INVALID');
});

test('uses the stricter provider capacity, configured quota, reserve, and projected write', () => {
  const healthy = evaluateRepositoryCapacity(
    { reporting: 'exact', totalBytes: 2000, usedBytes: 500, freeBytes: 1500, measuredAt: NOW },
    { quotaBytes: 1000, reserveBytes: 100, reservePercent: 5, warningPercent: 20, criticalPercent: 5, minimumBackupBytes: 50 },
    300, NOW
  );
  assert.equal(healthy.effectiveFreeBytes, 500);
  assert.equal(healthy.remainingBytes, 200);
  assert.equal(healthy.status, 'warning');
  assert.equal(healthy.allowed, true);

  const blocked = evaluateRepositoryCapacity(
    { reporting: 'quota-only', quotaBytes: 1000, usedBytes: 850, measuredAt: NOW },
    { reserveBytes: 100, reservePercent: 0, warningPercent: 20, criticalPercent: 5, minimumBackupBytes: 100 },
    100, NOW
  );
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'reserve-would-be-breached');
  assert.equal(blocked.allowed, false);
});

test('allows unknown provider capacity only when policy does not require proof', () => {
  assert.equal(evaluateRepositoryCapacity({ reporting: 'unavailable' }, { requireCapacityProof: false }, 1, NOW).allowed, true);
  const blocked = evaluateRepositoryCapacity({ reporting: 'unavailable' }, { requireCapacityProof: true }, 1, NOW);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'capacity-proof-required');
});
