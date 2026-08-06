const assert = require('node:assert/strict');
const test = require('node:test');
const { describeSchedule, nextOccurrence, normalizeSchedule } = require('./schedule');

const NOW = '2026-08-03T12:34:56.000Z';

test('normalizes manual and interval schedules with a stable UTC anchor', () => {
  assert.deepEqual(normalizeSchedule({ type: 'on-demand' }), {
    version: 1, type: 'manual', timezone: 'UTC',
    dstBehavior: { nonexistentTime: 'not-applicable', ambiguousTime: 'not-applicable' }, expression: null
  });
  const interval = normalizeSchedule({ type: 'interval', intervalMinutes: 15 }, { now: NOW });
  assert.equal(interval.anchorAt, NOW);
  assert.equal(nextOccurrence(interval, NOW), '2026-08-03T12:49:56.000Z');
  assert.equal(nextOccurrence(interval, '2026-08-03T13:05:00.000Z'), '2026-08-03T13:19:56.000Z');
});

test('calculates hourly, daily, weekly, and monthly UTC occurrences', () => {
  assert.equal(nextOccurrence({ type: 'hourly', minute: 10 }, NOW), '2026-08-03T13:10:00.000Z');
  assert.equal(nextOccurrence({ type: 'daily', time: '12:34' }, NOW), '2026-08-04T12:34:00.000Z');
  assert.equal(nextOccurrence({ type: 'weekly', daysOfWeek: [1, 5], time: '13:00' }, NOW), '2026-08-03T13:00:00.000Z');
  assert.equal(nextOccurrence({ type: 'weekly', daysOfWeek: [1, 5], time: '13:00' }, '2026-08-03T13:00:00.000Z'), '2026-08-07T13:00:00.000Z');
  assert.equal(nextOccurrence({ type: 'monthly', dayOfMonth: 31, time: '04:15' }, '2026-08-31T04:15:00.000Z'), '2026-10-31T04:15:00.000Z');
});

test('validates five-field cron and returns a strictly later occurrence', () => {
  const schedule = normalizeSchedule({ type: 'cron', expression: '*/15 8-18 * * 1-5' }, { now: NOW });
  assert.equal(schedule.expression, '*/15 8-18 * * 1-5');
  assert.equal(nextOccurrence(schedule, NOW), '2026-08-03T12:45:00.000Z');
  assert.equal(describeSchedule(schedule), 'Cron */15 8-18 * * 1-5 UTC');
  assert.throws(() => normalizeSchedule({ type: 'cron', expression: '* * * *' }), /five-field/);
  assert.throws(() => normalizeSchedule({ type: 'cron', expression: '70 * * * *' }), /five-field/);
});

test('rejects invalid bounds, timezone, and empty weekly selections', () => {
  assert.throws(() => normalizeSchedule({ type: 'interval', intervalMinutes: 0 }), /between 1 and 525600/);
  assert.throws(() => normalizeSchedule({ type: 'daily', time: '24:00' }), /between 0 and 23/);
  assert.throws(() => normalizeSchedule({ type: 'weekly', daysOfWeek: [], time: '09:00' }), /weekday/);
  assert.throws(() => normalizeSchedule({ type: 'monthly', dayOfMonth: 32, time: '09:00' }), /between 1 and 31/);
  assert.throws(() => normalizeSchedule({ type: 'daily', time: '09:00', timezone: 'Mars\/Olympus' }), /valid IANA timezone/);
  assert.throws(() => normalizeSchedule({
    type: 'daily', time: '09:00', timezone: 'America/New_York',
    dstBehavior: { nonexistentTime: 'invent-time', ambiguousTime: 'first' }
  }), /daylight-saving behavior/);
});

test('calculates calendar schedules in an IANA timezone', () => {
  const schedule = normalizeSchedule({ type: 'daily', time: '09:00', timezone: 'Asia/Calcutta' });
  assert.equal(nextOccurrence(schedule, '2026-08-03T00:00:00.000Z'), '2026-08-03T03:30:00.000Z');
  assert.equal(describeSchedule(schedule), 'Daily at 09:00 Asia/Calcutta');
});

test('applies explicit nonexistent-time behavior across a spring DST gap', () => {
  const common = { type: 'daily', time: '02:30', timezone: 'America/New_York' };
  const shifted = { ...common, dstBehavior: { nonexistentTime: 'shift-forward', ambiguousTime: 'first' } };
  const skipped = { ...common, dstBehavior: { nonexistentTime: 'skip', ambiguousTime: 'first' } };
  assert.equal(nextOccurrence(shifted, '2026-03-07T08:00:00.000Z'), '2026-03-08T07:30:00.000Z');
  assert.equal(nextOccurrence(skipped, '2026-03-07T08:00:00.000Z'), '2026-03-09T06:30:00.000Z');
});

test('selects the first, second, or both offsets across a fall DST overlap', () => {
  const common = { type: 'daily', time: '01:30', timezone: 'America/New_York' };
  const behavior = (ambiguousTime) => ({ ...common, dstBehavior: { nonexistentTime: 'shift-forward', ambiguousTime } });
  const first = nextOccurrence(behavior('first'), '2026-10-31T08:00:00.000Z');
  const second = nextOccurrence(behavior('second'), '2026-10-31T08:00:00.000Z');
  const both = nextOccurrence(behavior('both'), '2026-10-31T08:00:00.000Z');
  assert.equal(first, '2026-11-01T05:30:00.000Z');
  assert.equal(second, '2026-11-01T06:30:00.000Z');
  assert.equal(both, first);
  assert.equal(nextOccurrence(behavior('both'), both), second);
});

test('applies DST gap and overlap policy to cron occurrences', () => {
  const commonGap = { type: 'cron', expression: '30 2 * * *', timezone: 'America/New_York' };
  assert.equal(nextOccurrence({ ...commonGap, dstBehavior: { nonexistentTime: 'shift-forward', ambiguousTime: 'first' } }, '2026-03-07T08:00:00Z'), '2026-03-08T07:30:00.000Z');
  assert.equal(nextOccurrence({ ...commonGap, dstBehavior: { nonexistentTime: 'skip', ambiguousTime: 'first' } }, '2026-03-07T08:00:00Z'), '2026-03-09T06:30:00.000Z');
  const overlap = { type: 'cron', expression: '30 1 * * *', timezone: 'America/New_York', dstBehavior: { nonexistentTime: 'shift-forward', ambiguousTime: 'both' } };
  const first = nextOccurrence(overlap, '2026-10-31T08:00:00Z');
  assert.equal(first, '2026-11-01T05:30:00.000Z');
  assert.equal(nextOccurrence(overlap, first), '2026-11-01T06:30:00.000Z');
});
