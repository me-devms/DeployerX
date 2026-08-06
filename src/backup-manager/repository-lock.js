const crypto = require('crypto');

const LOCK_FORMAT_VERSION = 1;
const LOCK_MAGIC = Buffer.from('DXL1', 'ascii');
const MIN_LOCK_TTL_MS = 5000;
const MAX_LOCK_TTL_MS = 15 * 60 * 1000;
const MAX_LOCK_RECORD_BYTES = 16 * 1024;

class RepositoryLockError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'RepositoryLockError';
    this.code = code;
    this.category = options.category || 'conflict';
    this.retryable = options.retryable !== false;
  }
}

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new RepositoryLockError('REPOSITORY_LOCK_REQUEST_INVALID', `${label} is invalid.`, { category: 'validation', retryable: false });
  return text;
}

function lockTime(clock) {
  const value = requiredText(clock(), 'Repository lock clock', 64);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RepositoryLockError('REPOSITORY_LOCK_CLOCK_INVALID', 'Repository lock time is invalid.', { category: 'internal', retryable: false });
  return { value: new Date(milliseconds).toISOString(), milliseconds };
}

function normalizeLockRequest(request = {}, clock = () => new Date().toISOString(), randomUUID = crypto.randomUUID) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new RepositoryLockError('REPOSITORY_LOCK_REQUEST_INVALID', 'Repository lock request is invalid.', { category: 'validation', retryable: false });
  const repositoryId = requiredText(request.repositoryId, 'Repository ID');
  const operation = requiredText(request.operation, 'Repository lock operation', 64);
  const workerId = requiredText(request.workerId, 'Repository lock worker ID');
  const runId = requiredText(request.runId, 'Repository lock run ID');
  const scope = requiredText(request.scope || `${repositoryId}:${operation}`, 'Repository lock scope');
  const ttlMs = Number(request.ttlMs ?? 60000);
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_LOCK_TTL_MS || ttlMs > MAX_LOCK_TTL_MS) throw new RepositoryLockError('REPOSITORY_LOCK_REQUEST_INVALID', 'Repository lock duration is invalid.', { category: 'validation', retryable: false });
  const issued = lockTime(clock);
  return {
    version: LOCK_FORMAT_VERSION,
    leaseId: `lease_${randomUUID()}`,
    repositoryId,
    operation,
    scope,
    workerId,
    runId,
    issuedAt: issued.value,
    heartbeatAt: issued.value,
    expiresAt: new Date(issued.milliseconds + ttlMs).toISOString(),
    ttlMs
  };
}

function validateLease(lease = {}) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease) || lease.version !== LOCK_FORMAT_VERSION) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'Repository lease is invalid.', { category: 'integrity', retryable: false });
  const normalized = {
    version: LOCK_FORMAT_VERSION,
    leaseId: requiredText(lease.leaseId, 'Repository lease ID'),
    repositoryId: requiredText(lease.repositoryId, 'Repository ID'),
    operation: requiredText(lease.operation, 'Repository lock operation', 64),
    scope: requiredText(lease.scope, 'Repository lock scope'),
    workerId: requiredText(lease.workerId, 'Repository lock worker ID'),
    runId: requiredText(lease.runId, 'Repository lock run ID'),
    issuedAt: requiredText(lease.issuedAt, 'Repository lease issue time', 64),
    heartbeatAt: requiredText(lease.heartbeatAt, 'Repository lease heartbeat time', 64),
    expiresAt: requiredText(lease.expiresAt, 'Repository lease expiry time', 64),
    ttlMs: Number(lease.ttlMs)
  };
  for (const field of ['issuedAt', 'heartbeatAt', 'expiresAt']) {
    if (!Number.isFinite(Date.parse(normalized[field]))) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'Repository lease timestamps are invalid.', { category: 'integrity', retryable: false });
  }
  if (!Number.isInteger(normalized.ttlMs) || normalized.ttlMs < MIN_LOCK_TTL_MS || normalized.ttlMs > MAX_LOCK_TTL_MS) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'Repository lease duration is invalid.', { category: 'integrity', retryable: false });
  return normalized;
}

function renewLease(lease, clock = () => new Date().toISOString()) {
  const current = validateLease(lease);
  const heartbeat = lockTime(clock);
  if (Date.parse(current.expiresAt) <= heartbeat.milliseconds) throw new RepositoryLockError('REPOSITORY_LOCK_EXPIRED', 'The repository lease expired before it could be renewed.');
  return { ...current, heartbeatAt: heartbeat.value, expiresAt: new Date(heartbeat.milliseconds + current.ttlMs).toISOString() };
}

function lockScopeId(scope) {
  return crypto.createHash('sha256').update(requiredText(scope, 'Repository lock scope')).digest('hex');
}

function lockKey(masterKey, binding) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new RepositoryLockError('REPOSITORY_LOCK_KEY_INVALID', 'Repository lock encryption key is invalid.', { category: 'encryption', retryable: false });
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.from('deployerx-repository-lock-v1', 'utf8'), Buffer.from(requiredText(binding, 'Repository lock binding', 2048), 'utf8'), 32));
}

function encodeLockRecord(lease, masterKey, binding) {
  const record = validateLease(lease);
  const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
  if (plaintext.length > MAX_LOCK_RECORD_BYTES) throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'Repository lease record is too large.', { category: 'validation', retryable: false });
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', lockKey(masterKey, binding), nonce);
  cipher.setAAD(Buffer.from(binding, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([LOCK_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

function decodeLockRecord(value, masterKey, binding) {
  const bytes = Buffer.from(value || []);
  if (bytes.length < LOCK_MAGIC.length + 12 + 16 || bytes.length > MAX_LOCK_RECORD_BYTES + 64 || !bytes.subarray(0, LOCK_MAGIC.length).equals(LOCK_MAGIC)) {
    throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'Repository lease record is invalid.', { category: 'integrity', retryable: false });
  }
  try {
    const nonceOffset = LOCK_MAGIC.length;
    const tagOffset = nonceOffset + 12;
    const ciphertextOffset = tagOffset + 16;
    const decipher = crypto.createDecipheriv('aes-256-gcm', lockKey(masterKey, binding), bytes.subarray(nonceOffset, tagOffset));
    decipher.setAAD(Buffer.from(binding, 'utf8'));
    decipher.setAuthTag(bytes.subarray(tagOffset, ciphertextOffset));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(ciphertextOffset)), decipher.final()]);
    if (plaintext.length > MAX_LOCK_RECORD_BYTES) throw new Error('oversized');
    return validateLease(JSON.parse(plaintext.toString('utf8')));
  } catch (error) {
    if (error instanceof RepositoryLockError) throw error;
    throw new RepositoryLockError('REPOSITORY_LOCK_INVALID', 'Repository lease record could not be authenticated.', { category: 'integrity', retryable: false });
  }
}

function publicLease(lease) {
  return { ...validateLease(lease) };
}

function sameLease(left, right) {
  const first = validateLease(left);
  const second = validateLease(right);
  return first.leaseId === second.leaseId && first.repositoryId === second.repositoryId && first.scope === second.scope && first.workerId === second.workerId && first.runId === second.runId;
}

function isExpired(lease, clock = () => new Date().toISOString()) {
  return Date.parse(validateLease(lease).expiresAt) <= lockTime(clock).milliseconds;
}

module.exports = {
  LOCK_FORMAT_VERSION,
  MAX_LOCK_TTL_MS,
  MIN_LOCK_TTL_MS,
  RepositoryLockError,
  decodeLockRecord,
  encodeLockRecord,
  isExpired,
  lockScopeId,
  normalizeLockRequest,
  publicLease,
  renewLease,
  sameLease,
  validateLease
};
