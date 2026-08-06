const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BandwidthLimiter, calculateRetrySchedule, effectiveBandwidthLimit,
  normalizeExecutionPolicy, priorityRank
} = require('./execution-policy');

test('normalizes priority, bounded retry backoff, and bandwidth windows', () => {
  const policy = normalizeExecutionPolicy({
    priority: 'high',
    retry: { maximumAttempts: 5, backoff: 'linear', initialDelaySeconds: 10, maximumDelaySeconds: 120, jitterPercent: 0, retryableCategories: ['connectivity', 'source'] },
    bandwidth: {
      timezone: 'America/New_York', defaultLimitBytesPerSecond: 1048576,
      windows: [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: '22:00', endTime: '04:00', limitBytesPerSecond: 262144 }]
    }
  });
  assert.equal(policy.priority, 'high');
  assert.equal(policy.retry.maximumAttempts, 5);
  assert.equal(policy.bandwidth.windows[0].crossesMidnight, true);
  assert.equal(policy.bandwidth.timezone, 'America/New_York');
});

test('calculates stable fixed, linear, exponential, capped, and jittered retries', () => {
  const at = '2026-08-03T12:00:00.000Z';
  const fixed = calculateRetrySchedule({ maximumAttempts: 4, backoff: 'fixed', initialDelaySeconds: 10, maximumDelaySeconds: 100, jitterPercent: 0 }, 2, at, 'run-1');
  const linear = calculateRetrySchedule({ maximumAttempts: 4, backoff: 'linear', initialDelaySeconds: 10, maximumDelaySeconds: 100, jitterPercent: 0 }, 2, at, 'run-1');
  const exponential = calculateRetrySchedule({ maximumAttempts: 5, backoff: 'exponential', initialDelaySeconds: 10, maximumDelaySeconds: 15, jitterPercent: 0 }, 3, at, 'run-1');
  const jitteredA = calculateRetrySchedule({ maximumAttempts: 4, backoff: 'fixed', initialDelaySeconds: 100, maximumDelaySeconds: 200, jitterPercent: 20 }, 1, at, 'stable');
  const jitteredB = calculateRetrySchedule({ maximumAttempts: 4, backoff: 'fixed', initialDelaySeconds: 100, maximumDelaySeconds: 200, jitterPercent: 20 }, 1, at, 'stable');
  assert.equal(fixed.delaySeconds, 10);
  assert.equal(linear.delaySeconds, 20);
  assert.equal(exponential.delaySeconds, 15);
  assert.deepEqual(jitteredA, jitteredB);
  assert.equal(calculateRetrySchedule({ maximumAttempts: 3 }, 3, at, 'run-1'), null);
});

test('orders critical through low priority deterministically', () => {
  assert.ok(priorityRank('critical') > priorityRank('high'));
  assert.ok(priorityRank('high') > priorityRank('normal'));
  assert.ok(priorityRank('normal') > priorityRank('low'));
  assert.equal(priorityRank('unknown'), priorityRank('normal'));
});

test('evaluates the most restrictive active bandwidth window across midnight', () => {
  const policy = {
    timezone: 'America/New_York', defaultLimitBytesPerSecond: 1048576,
    windows: [
      { daysOfWeek: [1], startTime: '22:00', endTime: '04:00', limitBytesPerSecond: 524288 },
      { daysOfWeek: [2], startTime: '00:00', endTime: '03:00', limitBytesPerSecond: 262144 }
    ]
  };
  assert.equal(effectiveBandwidthLimit(policy, '2026-08-04T06:00:00Z'), 262144);
  assert.equal(effectiveBandwidthLimit(policy, '2026-08-04T16:00:00Z'), 1048576);
});

test('shares deterministic bandwidth pacing across sequential consumers', async () => {
  let now = 0;
  const sleeps = [];
  const limiter = new BandwidthLimiter({
    policy: { timezone: 'UTC', defaultLimitBytesPerSecond: 100000, windows: [] },
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
  });
  const first = await limiter.consume(50000);
  const second = await limiter.consume(100000);
  assert.equal(first.waitedMilliseconds, 500);
  assert.equal(second.waitedMilliseconds, 1000);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('rejects unsafe retry and bandwidth policy bounds', () => {
  assert.throws(() => normalizeExecutionPolicy({ priority: 'urgent' }), /supported backup priority/);
  assert.throws(() => normalizeExecutionPolicy({ retry: { maximumAttempts: 11 } }), /between 1 and 10/);
  assert.throws(() => normalizeExecutionPolicy({ bandwidth: { timezone: 'UTC', defaultLimitBytesPerSecond: 100 } }), /between 65536/);
  assert.throws(() => normalizeExecutionPolicy({ bandwidth: { timezone: 'UTC', windows: [{ daysOfWeek: [1], startTime: '02:00', endTime: '02:00', limitBytesPerSecond: 65536 }] } }), /must differ/);
});
