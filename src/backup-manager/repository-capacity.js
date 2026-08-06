const MAX_CAPACITY_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_MINIMUM_BACKUP_BYTES = 64 * 1024 * 1024;

class RepositoryCapacityError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage);
    this.name = 'RepositoryCapacityError';
    this.code = code;
    this.category = 'validation';
    this.retryable = false;
  }
}

function safeTimestamp(value, fallback) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}

function normalizedBytes(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_CAPACITY_BYTES ? number : null;
}

function normalizeCapacity(input, measuredAt) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const timestamp = safeTimestamp(source.measuredAt, measuredAt);
  if (source.reporting === 'exact') {
    const totalBytes = normalizedBytes(source.totalBytes);
    const freeBytes = normalizedBytes(source.freeBytes);
    const usedBytes = normalizedBytes(source.usedBytes);
    if (totalBytes !== null && freeBytes !== null && usedBytes !== null && freeBytes <= totalBytes && usedBytes <= totalBytes && freeBytes + usedBytes === totalBytes) {
      return { reporting: 'exact', totalBytes, freeBytes, usedBytes, quotaBytes: null, measuredAt: timestamp };
    }
  }
  if (source.reporting === 'quota-only') {
    const quotaBytes = normalizedBytes(source.quotaBytes);
    const usedBytes = normalizedBytes(source.usedBytes);
    if (quotaBytes !== null && usedBytes !== null && usedBytes <= quotaBytes) return { reporting: 'quota-only', totalBytes: null, freeBytes: quotaBytes - usedBytes, usedBytes, quotaBytes, measuredAt: timestamp };
  }
  return { reporting: 'unavailable', totalBytes: null, freeBytes: null, usedBytes: null, quotaBytes: null, measuredAt: timestamp };
}

function bytes(value, label, { nullable = false, minimum = 0 } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new RepositoryCapacityError('REPOSITORY_STORAGE_POLICY_INVALID', `${label} is invalid.`);
  return number;
}

function percent(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new RepositoryCapacityError('REPOSITORY_STORAGE_POLICY_INVALID', `${label} is invalid.`);
  return number;
}

function normalizeStoragePolicy(input = {}) {
  const policy = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const warningPercent = percent(policy.warningPercent ?? 15, 'Repository capacity warning threshold', 1, 100);
  const criticalPercent = percent(policy.criticalPercent ?? 5, 'Repository capacity critical threshold', 0, 99);
  if (criticalPercent >= warningPercent) throw new RepositoryCapacityError('REPOSITORY_STORAGE_POLICY_INVALID', 'Repository critical capacity must be below its warning threshold.');
  return {
    version: 1,
    quotaBytes: bytes(policy.quotaBytes, 'Repository quota', { nullable: true, minimum: 1 }),
    reserveBytes: bytes(policy.reserveBytes ?? 0, 'Repository byte reserve'),
    reservePercent: percent(policy.reservePercent ?? 5, 'Repository percentage reserve', 0, 99),
    warningPercent,
    criticalPercent,
    minimumBackupBytes: bytes(policy.minimumBackupBytes ?? DEFAULT_MINIMUM_BACKUP_BYTES, 'Repository minimum backup allowance'),
    requireCapacityProof: policy.requireCapacityProof === true
  };
}

function evaluateRepositoryCapacity(capacityInput, policyInput = {}, projectedWriteBytes = 0, measuredAt = new Date().toISOString()) {
  const policy = normalizeStoragePolicy(policyInput);
  const capacity = normalizeCapacity(capacityInput, measuredAt);
  const projected = bytes(projectedWriteBytes, 'Projected repository write');
  if (capacity.reporting === 'unavailable') {
    return {
      status: policy.requireCapacityProof ? 'blocked' : 'unavailable', allowed: !policy.requireCapacityProof,
      reason: policy.requireCapacityProof ? 'capacity-proof-required' : 'capacity-unavailable', capacity, policy,
      effectiveTotalBytes: null, effectiveFreeBytes: null, reserveBytes: null, projectedWriteBytes: projected, remainingBytes: null
    };
  }
  const providerTotal = capacity.reporting === 'exact' ? capacity.totalBytes : capacity.quotaBytes;
  const effectiveTotalBytes = policy.quotaBytes === null ? providerTotal : Math.min(providerTotal, policy.quotaBytes);
  const quotaFree = Math.max(0, effectiveTotalBytes - capacity.usedBytes);
  const effectiveFreeBytes = Math.min(capacity.freeBytes, quotaFree);
  const reserveBytes = Math.max(policy.reserveBytes, Math.ceil(effectiveTotalBytes * policy.reservePercent / 100));
  const remainingBytes = effectiveFreeBytes - projected;
  const remainingPercent = effectiveTotalBytes === 0 ? 0 : Math.max(0, remainingBytes) / effectiveTotalBytes * 100;
  const allowed = remainingBytes >= reserveBytes;
  let status = 'healthy';
  let reason = null;
  if (!allowed) { status = 'blocked'; reason = 'reserve-would-be-breached'; }
  else if (remainingPercent <= policy.criticalPercent) { status = 'critical'; reason = 'critical-capacity'; }
  else if (remainingPercent <= policy.warningPercent) { status = 'warning'; reason = 'low-capacity'; }
  return { status, allowed, reason, capacity, policy, effectiveTotalBytes, effectiveFreeBytes, reserveBytes, projectedWriteBytes: projected, remainingBytes };
}

module.exports = { DEFAULT_MINIMUM_BACKUP_BYTES, RepositoryCapacityError, evaluateRepositoryCapacity, normalizeCapacity, normalizeStoragePolicy };
