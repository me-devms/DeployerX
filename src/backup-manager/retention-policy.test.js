const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateRetention, normalizeRetentionPolicy } = require('./retention-policy');

function point(id, capturedTo) { return { id, capturedTo }; }

test('normalizes bounded GFS retention policy in an IANA timezone', () => {
  assert.deepEqual(normalizeRetentionPolicy({ keepLast: 7, hourly: 24, daily: 14, weekly: 8, monthly: 12, yearly: 7, timezone: 'Asia/Kolkata' }), {
    version: 1, timezone: 'Asia/Kolkata', keepLast: 7, hourly: 24, daily: 14, weekly: 8, monthly: 12, yearly: 7, legalHold: false
  });
});

test('selects the newest point in each hourly, daily, weekly, monthly, and yearly bucket', () => {
  const decisions = evaluateRetention([
    point('p1', '2026-01-01T00:10:00Z'), point('p2', '2026-01-01T00:50:00Z'),
    point('p3', '2026-01-01T01:10:00Z'), point('p4', '2026-01-02T01:10:00Z'),
    point('p5', '2026-01-09T01:10:00Z'), point('p6', '2026-02-09T01:10:00Z'),
    point('p7', '2027-02-09T01:10:00Z')
  ], { keepLast: 1, hourly: 2, daily: 2, weekly: 2, monthly: 2, yearly: 2, timezone: 'UTC' }, '2027-02-10T00:00:00Z');
  const byId = new Map(decisions.map((decision) => [decision.id, decision.retention]));
  assert.deepEqual(byId.get('p7').ruleMatches, ['last-n', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']);
  assert.deepEqual(byId.get('p6').ruleMatches, ['hourly', 'daily', 'weekly', 'monthly', 'yearly']);
  assert.equal(byId.get('p5').deletionEligible, true);
  assert.equal(byId.get('p5').expireAt, '2027-02-10T00:00:00.000Z');
});

test('uses local calendar buckets across UTC day and year boundaries', () => {
  const decisions = evaluateRetention([
    point('before-midnight', '2025-12-31T18:20:00Z'),
    point('after-midnight', '2025-12-31T18:40:00Z')
  ], { keepLast: 1, daily: 2, yearly: 2, timezone: 'Asia/Kolkata' }, '2026-01-01T00:00:00Z');
  const byId = new Map(decisions.map((decision) => [decision.id, decision.retention.ruleMatches]));
  assert.deepEqual(byId.get('after-midnight'), ['last-n', 'daily', 'yearly']);
  assert.deepEqual(byId.get('before-midnight'), ['daily', 'yearly']);
});

test('keeps repeated daylight-saving hours as distinct hourly buckets', () => {
  const decisions = evaluateRetention([
    point('first-offset', '2026-11-01T05:30:00Z'),
    point('second-offset', '2026-11-01T06:30:00Z')
  ], { keepLast: 1, hourly: 2, timezone: 'America/New_York' }, '2026-11-02T00:00:00Z');
  assert.equal(decisions.every((decision) => decision.retention.ruleMatches.includes('hourly')), true);
});

test('legal hold prevents every recovery point from becoming eligible', () => {
  const decisions = evaluateRetention([
    point('old', '2025-01-01T00:00:00Z'), point('new', '2026-01-01T00:00:00Z')
  ], { keepLast: 1, legalHold: true }, '2026-02-01T00:00:00Z');
  assert.equal(decisions.every((decision) => !decision.retention.deletionEligible && decision.retention.ruleMatches.includes('legal-hold')), true);
});

test('rejects invalid counts, timezone, points, and evaluation time', () => {
  assert.throws(() => normalizeRetentionPolicy({ keepLast: 0 }), /between 1 and 10000/);
  assert.throws(() => normalizeRetentionPolicy({ daily: 10001 }), /between 0 and 10000/);
  assert.throws(() => normalizeRetentionPolicy({ timezone: 'Not/A_Zone' }), /valid IANA/);
  assert.throws(() => evaluateRetention([{ id: 'bad', capturedTo: 'not-a-time' }], {}), /capture time/);
  assert.throws(() => evaluateRetention([], {}, 'not-a-time'), /evaluation time/);
});
