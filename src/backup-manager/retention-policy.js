const { DateTime, IANAZone } = require('luxon');

const RETENTION_RULES = Object.freeze(['hourly', 'daily', 'weekly', 'monthly', 'yearly']);
const MAXIMUM_RETENTION_COUNT = 10000;
const MAXIMUM_RETENTION_EVALUATION_POINTS = MAXIMUM_RETENTION_COUNT * (RETENTION_RULES.length + 1) + 1;

class RetentionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RetentionPolicyError';
    this.code = code;
    this.category = 'validation';
    this.retryable = false;
  }
}

function count(value, fallback, label, minimum = 0) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > MAXIMUM_RETENTION_COUNT) {
    throw new RetentionPolicyError('BACKUP_RETENTION_POLICY_INVALID', `${label} must be between ${minimum} and ${MAXIMUM_RETENTION_COUNT}.`);
  }
  return number;
}

function normalizeRetentionPolicy(input = {}, options = {}) {
  const timezone = String(input.timezone || options.timezone || 'UTC').trim();
  if (!timezone || timezone.length > 100 || (timezone !== 'UTC' && !IANAZone.isValidZone(timezone))) {
    throw new RetentionPolicyError('BACKUP_RETENTION_POLICY_INVALID', 'Retention timezone must be a valid IANA timezone.');
  }
  return {
    version: 1,
    timezone,
    keepLast: count(input.keepLast, 30, 'Recovery points to keep', 1),
    hourly: count(input.hourly, 0, 'Hourly recovery points'),
    daily: count(input.daily, 0, 'Daily recovery points'),
    weekly: count(input.weekly, 0, 'Weekly recovery points'),
    monthly: count(input.monthly, 0, 'Monthly recovery points'),
    yearly: count(input.yearly, 0, 'Yearly recovery points'),
    legalHold: Boolean(input.legalHold)
  };
}

function recoveryTime(point, timezone) {
  const instant = DateTime.fromISO(String(point?.capturedTo || ''), { setZone: true });
  if (!instant.isValid) throw new RetentionPolicyError('BACKUP_RETENTION_POINT_INVALID', 'Recovery point capture time is invalid.');
  return instant.setZone(timezone);
}

function bucket(rule, localTime) {
  if (rule === 'hourly') return `${localTime.toFormat('yyyy-LL-dd-HH')}-${localTime.offset}`;
  if (rule === 'daily') return localTime.toFormat('yyyy-LL-dd');
  if (rule === 'weekly') return `${localTime.weekYear}-W${String(localTime.weekNumber).padStart(2, '0')}`;
  if (rule === 'monthly') return localTime.toFormat('yyyy-LL');
  return localTime.toFormat('yyyy');
}

function evaluateRetention(points, input, evaluatedAt = new Date()) {
  const policy = normalizeRetentionPolicy(input);
  const evaluation = new Date(evaluatedAt);
  if (!Number.isFinite(evaluation.getTime())) throw new RetentionPolicyError('BACKUP_RETENTION_POLICY_INVALID', 'Retention evaluation time is invalid.');
  const normalized = (Array.isArray(points) ? points : []).map((point) => {
    const id = String(point?.id || '').trim();
    if (!id) throw new RetentionPolicyError('BACKUP_RETENTION_POINT_INVALID', 'Recovery point ID is required.');
    return { point, id, instant: recoveryTime(point, policy.timezone) };
  }).sort((left, right) => right.instant.toMillis() - left.instant.toMillis() || right.id.localeCompare(left.id, 'en-US'));
  const matches = new Map(normalized.map(({ id }) => [id, new Set()]));
  normalized.slice(0, policy.keepLast).forEach(({ id }) => matches.get(id).add('last-n'));
  for (const rule of RETENTION_RULES) {
    const limit = policy[rule];
    if (!limit) continue;
    const selectedBuckets = new Set();
    for (const item of normalized) {
      const key = bucket(rule, item.instant);
      if (selectedBuckets.has(key)) continue;
      selectedBuckets.add(key);
      matches.get(item.id).add(rule);
      if (selectedBuckets.size >= limit) break;
    }
  }
  if (policy.legalHold) normalized.forEach(({ id }) => matches.get(id).add('legal-hold'));
  return normalized.map(({ point, id }) => {
    const ruleMatches = [...matches.get(id)];
    const deletionEligible = ruleMatches.length === 0;
    return {
      id,
      retention: {
        expireAt: deletionEligible ? evaluation.toISOString() : null,
        ruleMatches,
        keepLast: policy.keepLast,
        hourly: policy.hourly,
        daily: policy.daily,
        weekly: policy.weekly,
        monthly: policy.monthly,
        yearly: policy.yearly,
        timezone: policy.timezone,
        legalHold: policy.legalHold,
        deletionEligible,
        evaluatedAt: evaluation.toISOString(),
        policyRevision: Number(point?.retention?.policyRevision || 1)
      }
    };
  });
}

module.exports = {
  MAXIMUM_RETENTION_COUNT,
  MAXIMUM_RETENTION_EVALUATION_POINTS,
  RETENTION_RULES,
  RetentionPolicyError,
  evaluateRetention,
  normalizeRetentionPolicy
};
