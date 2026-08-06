const crypto = require('crypto');
const { DateTime, IANAZone } = require('luxon');

const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const PRIORITY_RANK = Object.freeze({ low: 0, normal: 1, high: 2, critical: 3 });
const BACKOFF_MODES = new Set(['fixed', 'linear', 'exponential']);
const RETRYABLE_CATEGORIES = new Set(['connectivity', 'timeout', 'capacity', 'source', 'repository', 'worker', 'execution']);
const MAXIMUM_RETRY_ATTEMPTS = 10;
const MAXIMUM_RETRY_DELAY_SECONDS = 604800;
const MAX_BANDWIDTH_WINDOWS = 32;
const MIN_BANDWIDTH_BYTES_PER_SECOND = 64 * 1024;
const MAX_BANDWIDTH_BYTES_PER_SECOND = 10 * 1024 * 1024 * 1024;

class ExecutionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutionPolicyError';
    this.code = code;
    this.category = 'validation';
    this.retryable = false;
  }
}

function integer(value, fallback, label, minimum, maximum) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', `${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function optionalBandwidth(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return integer(value, null, label, MIN_BANDWIDTH_BYTES_PER_SECOND, MAX_BANDWIDTH_BYTES_PER_SECOND);
}

function localTime(value, label) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', `${label} must use HH:mm.`);
  const hour = integer(match[1], null, `${label} hour`, 0, 23);
  const minute = integer(match[2], null, `${label} minute`, 0, 59);
  return { value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, totalMinutes: hour * 60 + minute };
}

function weekdays(input, label) {
  if (!Array.isArray(input) || input.length === 0) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', `${label} requires at least one weekday.`);
  return [...new Set(input.map((day) => integer(day, null, 'Weekday', 0, 6)))].sort((left, right) => left - right);
}

function timezone(value) {
  const zone = String(value || 'UTC').trim();
  if (!zone || zone.length > 100 || (zone !== 'UTC' && !IANAZone.isValidZone(zone))) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Bandwidth timezone must be a valid IANA timezone.');
  return zone;
}

function normalizeRetryPolicy(input = {}) {
  const maximumAttempts = integer(input.maximumAttempts, 3, 'Maximum retry attempts', 1, MAXIMUM_RETRY_ATTEMPTS);
  const backoff = String(input.backoff || 'exponential');
  if (!BACKOFF_MODES.has(backoff)) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Choose a supported retry backoff.');
  const initialDelaySeconds = integer(input.initialDelaySeconds, 30, 'Initial retry delay', 1, MAXIMUM_RETRY_DELAY_SECONDS);
  const maximumDelaySeconds = integer(input.maximumDelaySeconds, 3600, 'Maximum retry delay', initialDelaySeconds, MAXIMUM_RETRY_DELAY_SECONDS);
  const jitterPercent = integer(input.jitterPercent, 20, 'Retry jitter percent', 0, 100);
  const categories = input.retryableCategories === undefined
    ? [...RETRYABLE_CATEGORIES]
    : [...new Set((Array.isArray(input.retryableCategories) ? input.retryableCategories : []).map((category) => String(category)))];
  if (!categories.length || categories.some((category) => !RETRYABLE_CATEGORIES.has(category))) {
    throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Choose supported retryable categories.');
  }
  return { maximumAttempts, backoff, initialDelaySeconds, maximumDelaySeconds, jitterPercent, retryableCategories: categories.sort() };
}

function normalizeBandwidthPolicy(input = {}, options = {}) {
  const zone = timezone(input.timezone || options.timezone || 'UTC');
  const source = input.windows === undefined ? [] : input.windows;
  if (!Array.isArray(source) || source.length > MAX_BANDWIDTH_WINDOWS) {
    throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', `Bandwidth windows must contain at most ${MAX_BANDWIDTH_WINDOWS} entries.`);
  }
  const windows = source.map((window, index) => {
    const start = localTime(window?.startTime, `Bandwidth window ${index + 1} start`);
    const end = localTime(window?.endTime, `Bandwidth window ${index + 1} end`);
    if (start.totalMinutes === end.totalMinutes) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Bandwidth window start and end must differ.');
    return {
      daysOfWeek: weekdays(window?.daysOfWeek, `Bandwidth window ${index + 1}`),
      startTime: start.value,
      endTime: end.value,
      crossesMidnight: end.totalMinutes < start.totalMinutes,
      limitBytesPerSecond: optionalBandwidth(window?.limitBytesPerSecond, `Bandwidth window ${index + 1} limit`)
    };
  });
  if (windows.some((window) => window.limitBytesPerSecond === null)) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Every bandwidth window requires a limit.');
  return { timezone: zone, defaultLimitBytesPerSecond: optionalBandwidth(input.defaultLimitBytesPerSecond, 'Default bandwidth limit'), windows };
}

function normalizeExecutionPolicy(input = {}, options = {}) {
  const priority = String(input.priority || 'normal');
  if (!PRIORITIES.has(priority)) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Choose a supported backup priority.');
  return {
    priority,
    retry: normalizeRetryPolicy(input.retry || input),
    bandwidth: normalizeBandwidthPolicy(input.bandwidth || {
      timezone: options.timezone,
      defaultLimitBytesPerSecond: input.bandwidthLimitBytesPerSecond,
      windows: input.bandwidthWindows
    }, { timezone: options.timezone })
  };
}

function deterministicUnit(seed) {
  const bytes = crypto.createHash('sha256').update(String(seed || 'backup-retry')).digest();
  return bytes.readUInt32BE(0) / 0xffffffff;
}

function calculateRetrySchedule(input, completedAttempt, failedAt, seed) {
  const policy = normalizeRetryPolicy(input);
  const attempt = integer(completedAttempt, null, 'Completed attempt', 1, MAXIMUM_RETRY_ATTEMPTS);
  if (attempt >= policy.maximumAttempts) return null;
  const retryOrdinal = attempt;
  let delay = policy.initialDelaySeconds;
  if (policy.backoff === 'linear') delay *= retryOrdinal;
  if (policy.backoff === 'exponential') delay *= 2 ** (retryOrdinal - 1);
  delay = Math.min(policy.maximumDelaySeconds, delay);
  const jitterSeconds = Math.round(delay * policy.jitterPercent / 100 * deterministicUnit(`${seed}:${attempt + 1}`));
  const delaySeconds = Math.min(policy.maximumDelaySeconds, delay + jitterSeconds);
  const failedTime = new Date(failedAt);
  if (!Number.isFinite(failedTime.getTime())) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Retry failure time is invalid.');
  return {
    nextAttempt: attempt + 1,
    delaySeconds,
    notBefore: new Date(failedTime.getTime() + delaySeconds * 1000).toISOString(),
    backoff: policy.backoff,
    jitterPercent: policy.jitterPercent
  };
}

function priorityRank(value) {
  return PRIORITY_RANK[String(value || 'normal')] ?? PRIORITY_RANK.normal;
}

function windowActive(window, localNow) {
  const minute = localNow.hour * 60 + localNow.minute;
  const start = localTime(window.startTime, 'Bandwidth window start').totalMinutes;
  const end = localTime(window.endTime, 'Bandwidth window end').totalMinutes;
  const today = localNow.weekday % 7;
  if (!window.crossesMidnight) return window.daysOfWeek.includes(today) && minute >= start && minute < end;
  const yesterday = (today + 6) % 7;
  return (window.daysOfWeek.includes(today) && minute >= start) || (window.daysOfWeek.includes(yesterday) && minute < end);
}

function effectiveBandwidthLimit(input, at = new Date()) {
  const policy = normalizeBandwidthPolicy(input);
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime())) throw new ExecutionPolicyError('BACKUP_EXECUTION_POLICY_INVALID', 'Bandwidth evaluation time is invalid.');
  const localNow = DateTime.fromJSDate(instant, { zone: policy.timezone });
  const active = policy.windows.filter((window) => windowActive(window, localNow)).map((window) => window.limitBytesPerSecond);
  return active.length ? Math.min(...active) : policy.defaultLimitBytesPerSecond;
}

class BandwidthLimiter {
  constructor({ policy, now = () => Date.now(), sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    this.policy = normalizeBandwidthPolicy(policy || {});
    this.now = now;
    this.sleep = sleep;
    this.nextAvailableAt = 0;
  }

  async consume(bytes) {
    const amount = integer(bytes, null, 'Bandwidth bytes', 0, Number.MAX_SAFE_INTEGER);
    if (!amount) return { limitBytesPerSecond: effectiveBandwidthLimit(this.policy, new Date(this.now())), waitedMilliseconds: 0 };
    const current = this.now();
    const limit = effectiveBandwidthLimit(this.policy, new Date(current));
    if (limit === null) return { limitBytesPerSecond: null, waitedMilliseconds: 0 };
    const start = Math.max(current, this.nextAvailableAt);
    const duration = Math.ceil(amount / limit * 1000);
    this.nextAvailableAt = start + duration;
    const waitedMilliseconds = Math.max(0, this.nextAvailableAt - current);
    if (waitedMilliseconds) await this.sleep(waitedMilliseconds);
    return { limitBytesPerSecond: limit, waitedMilliseconds };
  }
}

module.exports = {
  BACKOFF_MODES,
  BandwidthLimiter,
  ExecutionPolicyError,
  MAXIMUM_RETRY_ATTEMPTS,
  MAX_BANDWIDTH_WINDOWS,
  PRIORITIES,
  RETRYABLE_CATEGORIES,
  calculateRetrySchedule,
  effectiveBandwidthLimit,
  normalizeBandwidthPolicy,
  normalizeExecutionPolicy,
  normalizeRetryPolicy,
  priorityRank
};
