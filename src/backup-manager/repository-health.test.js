const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRepositoryHealth, normalizeCapacity } = require('./repository-health');

const CHECKED_AT = '2026-08-03T12:00:00.000Z';

test('normalizes exact, quota-only, and unavailable repository capacity without overclaiming', () => {
  assert.deepEqual(normalizeCapacity({ reporting: 'exact', totalBytes: 1000, freeBytes: 400, usedBytes: 600, measuredAt: CHECKED_AT }, CHECKED_AT), {
    reporting: 'exact', totalBytes: 1000, freeBytes: 400, usedBytes: 600, quotaBytes: null, measuredAt: CHECKED_AT
  });
  assert.deepEqual(normalizeCapacity({ reporting: 'quota-only', quotaBytes: 1000, usedBytes: 250 }, CHECKED_AT), {
    reporting: 'quota-only', totalBytes: null, freeBytes: 750, usedBytes: 250, quotaBytes: 1000, measuredAt: CHECKED_AT
  });
  assert.deepEqual(normalizeCapacity({ reporting: 'exact', totalBytes: 1000, freeBytes: 900, usedBytes: 900 }, CHECKED_AT), {
    reporting: 'unavailable', totalBytes: null, freeBytes: null, usedBytes: null, quotaBytes: null, measuredAt: CHECKED_AT
  });
});

test('persists a bounded needs-attention state when a repository connection test fails', async () => {
  let update = null;
  let engineOpened = false;
  const repository = {
    id: 'repo-test', revision: 3, adapterId: 'deployerx.repository.test', adapterVersion: '1.0.0',
    health: { status: 'ready', checkedAt: null, repositoryFormatVersion: 1 }, immutability: { mode: 'none', enforced: false }
  };
  const controlDatabase = {
    repository: () => ({
      get: async () => repository,
      update: async (workspaceId, id, patch, options) => {
        update = { workspaceId, id, patch, options };
        return { ...repository, ...patch, revision: repository.revision + 1 };
      }
    })
  };
  const result = await checkRepositoryHealth({
    controlDatabase,
    workspaceId: 'workspace-a',
    actorId: 'tester',
    repositoryId: repository.id,
    deviceId: 'device-a',
    clock: () => CHECKED_AT,
    openRepository: async () => ({
      repository,
      masterKey: Buffer.alloc(32, 1),
      adapter: {
        testConnection: async () => ({
          status: 'failure', testedAt: CHECKED_AT, latencyMs: 20, checks: [],
          error: { code: 'REPOSITORY_ACCESS_DENIED', category: 'authorization', retryable: false, safeMessage: 'Repository access was denied.', details: { password: 'must-not-escape' } }
        }),
        getCapacity: async () => ({ reporting: 'unavailable', measuredAt: CHECKED_AT })
      },
      engine: { ensureRepository: async () => { engineOpened = true; } }
    })
  });
  assert.equal(engineOpened, false);
  assert.equal(result.repository.health.status, 'needs-attention');
  assert.equal(result.repository.health.safeErrorCode, 'REPOSITORY_ACCESS_DENIED');
  assert.equal(result.connectionTest.supportSummary.includes('must-not-escape'), false);
  assert.equal(update.options.expectedRevision, 3);
  assert.equal(update.patch.capacity.reporting, 'unavailable');
});
