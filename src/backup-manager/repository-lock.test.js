const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  decodeLockRecord,
  encodeLockRecord,
  normalizeLockRequest,
  renewLease
} = require('./repository-lock');

test('normalizes bounded repository lease ownership and expiry', () => {
  const lease = normalizeLockRequest({ repositoryId: 'repo-a', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 }, () => '2026-08-03T12:00:00.000Z', () => '00000000-0000-4000-8000-000000000001');
  assert.equal(lease.leaseId, 'lease_00000000-0000-4000-8000-000000000001');
  assert.equal(lease.scope, 'repo-a:backup');
  assert.equal(lease.expiresAt, '2026-08-03T12:00:05.000Z');
  assert.throws(() => normalizeLockRequest({ repositoryId: 'repo-a', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 1 }), /duration/);
});

test('encrypts and authenticates repository lease records', () => {
  const key = crypto.randomBytes(32);
  const lease = normalizeLockRequest({ repositoryId: 'repo-a', operation: 'backup', workerId: 'private-worker', runId: 'private-run', ttlMs: 5000 }, () => '2026-08-03T12:00:00.000Z');
  const encoded = encodeLockRecord(lease, key, 'binding-a');
  assert.equal(encoded.includes(Buffer.from('private-worker')), false);
  assert.equal(encoded.includes(Buffer.from('private-run')), false);
  assert.deepEqual(decodeLockRecord(encoded, key, 'binding-a'), lease);
  const tampered = Buffer.from(encoded);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => decodeLockRecord(tampered, key, 'binding-a'), /authenticated/);
  assert.throws(() => decodeLockRecord(encoded, crypto.randomBytes(32), 'binding-a'), /authenticated/);
});

test('refuses renewal after lease expiry', () => {
  const lease = normalizeLockRequest({ repositoryId: 'repo-a', operation: 'backup', workerId: 'worker-a', runId: 'run-a', ttlMs: 5000 }, () => '2026-08-03T12:00:00.000Z');
  assert.throws(() => renewLease(lease, () => '2026-08-03T12:00:05.000Z'), (error) => error.code === 'REPOSITORY_LOCK_EXPIRED');
});
