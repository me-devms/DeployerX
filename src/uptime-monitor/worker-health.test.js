const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_STALE_AFTER_MS, evaluateWorkerHeartbeat, workerHealthEvent } = require('./worker-health');

const NOW = Date.parse('2026-08-04T12:00:30.000Z');

test('classifies fresh, stale, stopped, and absent worker heartbeats', () => {
  const fresh = { probeId: 'probe-fresh', state: 'active', heartbeatAt: new Date(NOW - DEFAULT_STALE_AFTER_MS).toISOString() };
  const stale = { probeId: 'probe-stale', state: 'active', heartbeatAt: new Date(NOW - DEFAULT_STALE_AFTER_MS - 1).toISOString() };
  const stopped = { probeId: 'probe-stopped', state: 'stopping', heartbeatAt: new Date(NOW - 1000).toISOString() };
  assert.equal(evaluateWorkerHeartbeat([stale, fresh], { now: NOW }).heartbeat.probeId, 'probe-fresh');
  assert.equal(evaluateWorkerHeartbeat([fresh], { now: NOW }).active, true);
  assert.equal(evaluateWorkerHeartbeat([stale], { now: NOW }).stale, true);
  assert.equal(evaluateWorkerHeartbeat([stopped], { now: NOW }).stale, false);
  assert.deepEqual(evaluateWorkerHeartbeat([], { now: NOW }), { heartbeat: null, heartbeatMs: null, ageMs: null, active: false, stale: false });
});

test('creates an idempotent, secret-free stale-worker notification event', () => {
  const heartbeat = { probeId: 'local-windows:test', state: 'active', heartbeatAt: '2026-08-04T11:59:00.000Z', lastError: 'private failure detail' };
  const event = workerHealthEvent(heartbeat, NOW);
  assert.equal(event.type, 'uptime.worker-health');
  assert.equal(event.eventKey, 'uptime.worker-health:stale:local-windows:test:2026-08-04T11:59:00.000Z');
  assert.equal(event.occurredAt, '2026-08-04T12:00:30.000Z');
  assert.equal(JSON.stringify(event).includes('private failure detail'), false);
});
