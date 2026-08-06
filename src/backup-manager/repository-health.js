const crypto = require('crypto');
const { normalizeConnectionTestResult } = require('./connection-diagnostics');
const { evaluateRepositoryCapacity, normalizeCapacity, normalizeStoragePolicy } = require('./repository-capacity');

function safeTimestamp(value, fallback) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}

function safeErrorCode(value, fallback = 'REPOSITORY_HEALTH_CHECK_FAILED') {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : fallback;
}

function safeFailure(error) {
  const safeErrorNames = new Set(['LocalRepositoryError', 'RepositoryEngineError', 'RepositoryLockError', 'S3RepositoryError', 'SftpRepositoryError']);
  return {
    code: safeErrorCode(error?.code),
    category: ['authentication', 'authorization', 'capacity', 'compatibility', 'conflict', 'connectivity', 'encryption', 'integrity', 'timeout', 'validation'].includes(error?.category) ? error.category : 'internal',
    retryable: Boolean(error?.retryable),
    safeMessage: safeErrorNames.has(error?.name) ? String(error.message).slice(0, 300) : 'DeployerX could not validate the repository.'
  };
}

async function checkRepositoryHealth({ controlDatabase, workspaceId, actorId, repositoryId, deviceId, openRepository, clock = () => new Date().toISOString() }) {
  const checkedAt = safeTimestamp(clock(), new Date().toISOString());
  const repository = await controlDatabase.repository('repository').get(workspaceId, repositoryId);
  if (!repository) throw new Error('Repository was not found.');
  let adapter = null;
  let engine = null;
  let masterKey = null;
  let capacity = normalizeCapacity(null, checkedAt);
  let connectionTest;
  let immutability = repository.immutability || { supported: false, enforced: false, mode: 'none', checkedAt };
  let lease = null;
  let lockState = { status: 'unavailable', checkedAt, safeErrorCode: null };
  let formatVersion = repository.health?.repositoryFormatVersion || null;
  let failure = null;
  try {
    ({ adapter, engine, masterKey } = await openRepository(workspaceId, repositoryId));
    const rawConnectionTest = await adapter.testConnection({});
    connectionTest = normalizeConnectionTestResult({ ...rawConnectionTest, adapterId: repository.adapterId, adapterVersion: repository.adapterVersion }, { adapterId: repository.adapterId, adapterVersion: repository.adapterVersion, clock: () => checkedAt });
    capacity = normalizeCapacity(await adapter.getCapacity({}), checkedAt);
    if (connectionTest.status !== 'success') {
      failure = connectionTest.error || { code: 'REPOSITORY_CONNECTION_FAILED', category: 'connectivity', retryable: true, safeMessage: 'DeployerX could not access the repository.' };
    } else {
      const format = await engine.ensureRepository({}, { repositoryId: repository.id });
      formatVersion = format.repositoryFormatVersion;
      immutability = await adapter.validateImmutability({});
      try {
        lease = await adapter.acquireLock({ masterKey }, {
          repositoryId: repository.id,
          operation: 'health-check',
          workerId: `device:${deviceId}`,
          runId: `health:${crypto.randomUUID()}`,
          ttlMs: 30000
        });
        lease = await adapter.renewLock({ masterKey }, lease);
        lockState = { status: 'available', checkedAt, safeErrorCode: null };
      } catch (error) {
        const lockFailure = safeFailure(error);
        if (lockFailure.code === 'REPOSITORY_LOCK_CONTENDED') lockState = { status: 'contended', checkedAt, safeErrorCode: lockFailure.code };
        else {
          lockState = { status: 'unavailable', checkedAt, safeErrorCode: lockFailure.code };
          failure = lockFailure;
        }
      }
    }
  } catch (error) {
    failure = safeFailure(error);
    connectionTest ||= normalizeConnectionTestResult({
      adapterId: repository.adapterId,
      adapterVersion: repository.adapterVersion,
      status: 'failure',
      testedAt: checkedAt,
      latencyMs: 0,
      error: failure
    }, { adapterId: repository.adapterId, adapterVersion: repository.adapterVersion, clock: () => checkedAt });
  } finally {
    if (lease) {
      try { await adapter.releaseLock({ masterKey }, lease); }
      catch (error) {
        const releaseFailure = safeFailure(error);
        lockState = { status: 'unavailable', checkedAt, safeErrorCode: releaseFailure.code };
        failure ||= releaseFailure;
      }
    }
  }
  const health = {
    status: failure ? 'needs-attention' : 'ready',
    checkedAt,
    repositoryFormatVersion: formatVersion,
    lockState,
    safeErrorCode: failure?.code || null
  };
  const storagePolicy = normalizeStoragePolicy(repository.storagePolicy || {});
  const capacityStatus = evaluateRepositoryCapacity(capacity, storagePolicy, 0, checkedAt);
  if (capacityStatus.status === 'blocked') {
    health.status = 'needs-attention';
    health.safeErrorCode = 'REPOSITORY_CAPACITY_BLOCKED';
  }
  const updatedRepository = await controlDatabase.repository('repository').update(workspaceId, repository.id, {
    capacity,
    capacityStatus,
    storagePolicy,
    immutability,
    capabilityProbe: adapter?.capabilityProbe || repository.capabilityProbe || null,
    health
  }, { expectedRevision: repository.revision, actorId });
  return { repository: updatedRepository, connectionTest, capacity, capacityStatus, immutability, lockState, error: failure };
}

module.exports = {
  checkRepositoryHealth,
  normalizeCapacity,
  safeErrorCode
};
