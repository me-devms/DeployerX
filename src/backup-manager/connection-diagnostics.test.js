const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_CHECKS, MAX_LATENCY_MS, normalizeConnectionTestResult } = require('./connection-diagnostics');

const clock = () => '2026-08-03T12:00:00.000Z';

test('normalizes successful connection diagnostics and creates a stable support summary', () => {
  const input = {
    testedAt: '2026-08-03T11:59:59.000Z', latencyMs: 42,
    adapterId: 'deployerx.connection.local', adapterVersion: '1.0.0', status: 'success',
    endpointIdentity: { hostname: 'WORKSTATION', platform: 'windows' },
    checks: [{ id: 'local-read-access', status: 'pass', safeMessage: 'Local files are readable.' }],
    error: { code: 'MUST_NOT_SURVIVE' }
  };
  const first = normalizeConnectionTestResult(input, { clock });
  const second = normalizeConnectionTestResult(input, { clock });
  assert.equal(first.error, null);
  assert.equal(first.testedAt, '2026-08-03T11:59:59.000Z');
  assert.equal(first.diagnosticFingerprint, second.diagnosticFingerprint);
  assert.match(first.supportSummary, /Outcome: success/);
  assert.match(first.supportSummary, /Check local-read-access: pass/);
});

test('bounds invalid adapter output and supplies an actionable failure', () => {
  const result = normalizeConnectionTestResult({
    testedAt: 'not-a-date', latencyMs: Number.POSITIVE_INFINITY,
    adapterId: 'invalid adapter id', adapterVersion: '../bad', status: 'unknown',
    checks: Array.from({ length: 40 }, (_, index) => ({ id: `check-${index}`, status: 'unknown', safeMessage: 'x'.repeat(1000) })),
    error: { category: 'not-allowed', safeMessage: 'x'.repeat(2000), retryable: true, retryAfterSeconds: 999999 }
  }, { clock, adapterId: 'fallback.adapter', adapterVersion: '1.2.3' });
  assert.equal(result.status, 'failure');
  assert.equal(result.testedAt, clock());
  assert.equal(result.latencyMs, 0);
  assert.equal(result.adapterId, 'fallback.adapter');
  assert.equal(result.adapterVersion, '1.2.3');
  assert.equal(result.checks.length, MAX_CHECKS);
  assert.equal(result.checks[0].status, 'fail');
  assert.equal(result.checks[0].safeMessage.length, 300);
  assert.equal(result.error.code, 'CONNECTION_TEST_INVALID_RESULT');
  assert.equal(result.error.category, 'internal');
  assert.match(result.error.nextAction, /adapter output/);
});

test('redacts secret-shaped keys and values and drops structured error details', () => {
  const result = normalizeConnectionTestResult({
    status: 'failure', adapterId: 'test.adapter', adapterVersion: '1.0.0',
    endpointIdentity: { host: 'example.com', password: 'do-not-store', note: 'token=do-not-store' },
    error: {
      code: 'TEST_FAILURE', category: 'connectivity', retryable: true,
      safeMessage: 'password=do-not-store',
      details: {
        host: 'example.com', credentialValue: 'do-not-store', command: 'cat /etc/shadow',
        nested: { unsafe: true }, list: ['unsafe'], privateMaterial: '-----BEGIN PRIVATE KEY----- secret'
      }
    }
  }, { clock });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('do-not-store'), false);
  assert.equal(serialized.includes('/etc/shadow'), false);
  assert.equal(Object.hasOwn(result.error.details, 'nested'), false);
  assert.equal(Object.hasOwn(result.error.details, 'list'), false);
  assert.equal(result.endpointIdentity.password, '[redacted]');
  assert.equal(result.error.details.credentialValue, '[redacted]');
  assert.equal(result.error.safeMessage, '[redacted]');
});

test('preserves bounded retry metadata and clamps latency', () => {
  const result = normalizeConnectionTestResult({
    status: 'failure', adapterId: 'test.adapter', adapterVersion: '1.0.0', latencyMs: MAX_LATENCY_MS + 1,
    error: { code: 'TRANSIENT', category: 'timeout', retryable: true, retryAfterSeconds: 90000, safeMessage: 'Timed out.' }
  }, { clock });
  assert.equal(result.latencyMs, MAX_LATENCY_MS);
  assert.equal(result.error.retryAfterSeconds, 86400);
  assert.match(result.supportSummary, /Error: TRANSIENT \(timeout\)/);
  assert.match(result.supportSummary, /Retryable: yes/);
});

test('survives an invalid adapter timestamp and invalid fallback clock', () => {
  const result = normalizeConnectionTestResult({
    testedAt: 'invalid', status: 'success', adapterId: 'test.adapter', adapterVersion: '1.0.0'
  }, { clock: () => 'also-invalid' });
  assert.match(result.testedAt, /^\d{4}-\d{2}-\d{2}T/);
});
