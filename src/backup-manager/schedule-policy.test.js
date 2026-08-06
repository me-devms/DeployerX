const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateExecutionCalendar, evaluateMissedRun, normalizeSchedulePolicy } = require('./schedule-policy');

test('normalizes missed-run and execution-calendar policy with bounded windows', () => {
  const schedule = normalizeSchedulePolicy({
    type: 'daily', time: '02:00', timezone: 'America/New_York',
    missedRun: { behavior: 'run-all', graceMinutes: 30 },
    executionCalendar: {
      maintenanceWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: '22:00', endTime: '04:00' }],
      outsideMaintenanceBehavior: 'defer',
      blackouts: [{ startsAt: '2026-12-24T00:00:00Z', endsAt: '2026-12-26T00:00:00Z' }],
      blackoutBehavior: 'skip'
    }
  });
  assert.equal(schedule.timezone, 'America/New_York');
  assert.equal(schedule.missedRun.behavior, 'run-all');
  assert.equal(schedule.executionCalendar.maintenanceWindows[0].crossesMidnight, true);
  assert.equal(schedule.executionCalendar.blackouts[0].startsAt, '2026-12-24T00:00:00.000Z');
});

test('coalesces, replays, or skips overdue occurrences after the grace period', () => {
  const common = { type: 'hourly', minute: 0, timezone: 'UTC', missedRun: { graceMinutes: 5 } };
  const nextRunAt = '2026-08-03T08:00:00.000Z';
  const now = '2026-08-03T12:30:00.000Z';
  const latest = evaluateMissedRun({ ...common, missedRun: { behavior: 'run-latest', graceMinutes: 5 } }, nextRunAt, now);
  const all = evaluateMissedRun({ ...common, missedRun: { behavior: 'run-all', graceMinutes: 5 } }, nextRunAt, now);
  const skipped = evaluateMissedRun({ ...common, missedRun: { behavior: 'skip', graceMinutes: 5 } }, nextRunAt, now);
  assert.deepEqual({ action: latest.action, scheduledFor: latest.scheduledFor, skippedCount: latest.skippedCount }, { action: 'dispatch', scheduledFor: '2026-08-03T12:00:00.000Z', skippedCount: 4 });
  assert.deepEqual({ action: all.action, scheduledFor: all.scheduledFor }, { action: 'dispatch', scheduledFor: nextRunAt });
  assert.deepEqual({ action: skipped.action, nextRunAt: skipped.nextRunAt, skippedCount: skipped.skippedCount }, { action: 'skip', nextRunAt: '2026-08-03T13:00:00.000Z', skippedCount: 5 });
});

test('dispatches a slightly late occurrence inside its grace period', () => {
  const result = evaluateMissedRun({ type: 'daily', time: '12:00', missedRun: { behavior: 'skip', graceMinutes: 15 } }, '2026-08-03T12:00:00Z', '2026-08-03T12:10:00Z');
  assert.equal(result.action, 'dispatch');
  assert.equal(result.skippedCount, 0);
});

test('bounds very large missed-run scans with a durable advance decision', () => {
  const result = evaluateMissedRun({ type: 'interval', intervalMinutes: 1, anchorAt: '2026-08-01T00:00:00Z', missedRun: { behavior: 'run-latest', graceMinutes: 0 } }, '2026-08-01T00:01:00Z', '2026-08-03T00:00:00Z');
  assert.equal(result.action, 'advance');
  assert.equal(result.skippedCount, 1000);
  assert.equal(result.scanLimitReached, true);
});

test('allows cross-midnight maintenance windows and defers to the next local opening', () => {
  const schedule = {
    type: 'daily', time: '23:00', timezone: 'America/New_York',
    executionCalendar: {
      maintenanceWindows: [{ daysOfWeek: [1], startTime: '22:00', endTime: '04:00' }],
      outsideMaintenanceBehavior: 'defer'
    }
  };
  assert.equal(evaluateExecutionCalendar(schedule, '2026-08-04T06:00:00Z').action, 'allow');
  const deferred = evaluateExecutionCalendar(schedule, '2026-08-04T16:00:00Z');
  assert.equal(deferred.action, 'defer');
  assert.equal(deferred.reasonCode, 'OUTSIDE_MAINTENANCE_WINDOW');
  assert.equal(deferred.nextDispatchAttemptAt, '2026-08-11T02:00:00.000Z');
});

test('applies blackout defer and skip behavior without exposing labels', () => {
  const common = {
    type: 'daily', time: '02:00',
    executionCalendar: { blackouts: [{ startsAt: '2026-08-03T00:00:00Z', endsAt: '2026-08-04T00:00:00Z' }] }
  };
  const deferred = evaluateExecutionCalendar({ ...common, executionCalendar: { ...common.executionCalendar, blackoutBehavior: 'defer' } }, '2026-08-03T12:00:00Z');
  const skipped = evaluateExecutionCalendar({ ...common, executionCalendar: { ...common.executionCalendar, blackoutBehavior: 'skip' } }, '2026-08-03T12:00:00Z');
  assert.deepEqual({ action: deferred.action, retryAt: deferred.nextDispatchAttemptAt }, { action: 'defer', retryAt: '2026-08-04T00:00:00.000Z' });
  assert.deepEqual({ action: skipped.action, retryAt: skipped.nextDispatchAttemptAt }, { action: 'skip', retryAt: null });
});

test('rejects malformed calendar policy before persistence', () => {
  assert.throws(() => normalizeSchedulePolicy({ type: 'daily', time: '02:00', missedRun: { behavior: 'eventually' } }), /missed-run behavior/);
  assert.throws(() => normalizeSchedulePolicy({ type: 'daily', time: '02:00', executionCalendar: { maintenanceWindows: [{ daysOfWeek: [1], startTime: '02:00', endTime: '02:00' }] } }), /must differ/);
  assert.throws(() => normalizeSchedulePolicy({ type: 'daily', time: '02:00', executionCalendar: { blackouts: [{ startsAt: '2026-08-04T00:00:00Z', endsAt: '2026-08-03T00:00:00Z' }] } }), /after its start/);
});
