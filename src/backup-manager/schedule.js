const { CronExpressionParser } = require('cron-parser');
const { DateTime, IANAZone } = require('luxon');

const SCHEDULE_TYPES = new Set(['manual', 'interval', 'cron', 'hourly', 'daily', 'weekly', 'monthly']);
const MAX_INTERVAL_MINUTES = 525600;
const MAX_CRON_LENGTH = 200;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NONEXISTENT_TIME_BEHAVIORS = new Set(['skip', 'shift-forward']);
const AMBIGUOUS_TIME_BEHAVIORS = new Set(['first', 'second', 'both']);

class BackupScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupScheduleError';
    this.code = code;
    this.category = 'validation';
    this.retryable = false;
  }
}

function integer(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new BackupScheduleError('BACKUP_SCHEDULE_INVALID', `${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function isoTime(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BackupScheduleError('BACKUP_SCHEDULE_INVALID', `${label} is invalid.`);
  return date.toISOString();
}

function clockTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new BackupScheduleError('BACKUP_SCHEDULE_INVALID', 'Schedule time must use HH:mm.');
  const hour = integer(match[1], 'Schedule hour', 0, 23);
  const minute = integer(match[2], 'Schedule minute', 0, 59);
  return { hour, minute, value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function normalizeTimezone(value = 'UTC') {
  const timezone = String(value || 'UTC').trim();
  if (!timezone || timezone.length > 100 || (!IANAZone.isValidZone(timezone) && timezone !== 'UTC')) {
    throw new BackupScheduleError('BACKUP_SCHEDULE_TIMEZONE_INVALID', 'Choose a valid IANA timezone.');
  }
  return timezone;
}

function normalizeDstBehavior(value, timezone) {
  if (timezone === 'UTC') return { nonexistentTime: 'not-applicable', ambiguousTime: 'not-applicable' };
  const input = value && typeof value === 'object' ? value : {};
  const nonexistentTime = String(input.nonexistentTime || 'shift-forward');
  const ambiguousTime = String(input.ambiguousTime || 'first');
  if (!NONEXISTENT_TIME_BEHAVIORS.has(nonexistentTime) || !AMBIGUOUS_TIME_BEHAVIORS.has(ambiguousTime)) {
    throw new BackupScheduleError('BACKUP_SCHEDULE_DST_INVALID', 'Choose supported daylight-saving behavior.');
  }
  return { nonexistentTime, ambiguousTime };
}

function base(type, input) {
  const timezone = normalizeTimezone(input?.timezone);
  return {
    version: 1,
    type,
    timezone,
    dstBehavior: normalizeDstBehavior(input?.dstBehavior, timezone)
  };
}

function validateCron(expression, currentDate = new Date(), timezone = 'UTC') {
  const text = String(expression || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > MAX_CRON_LENGTH || /[^\x20-\x7e]/.test(text) || text.split(' ').length !== 5) {
    throw new BackupScheduleError('BACKUP_CRON_INVALID', 'Cron must be a valid five-field expression.');
  }
  try {
    CronExpressionParser.parse(text, { currentDate, tz: timezone }).next();
  } catch {
    throw new BackupScheduleError('BACKUP_CRON_INVALID', 'Cron must be a valid five-field expression.');
  }
  return text;
}

function normalizeSchedule(input = {}, options = {}) {
  const requestedType = String(input.type || 'manual').trim().toLowerCase();
  const type = requestedType === 'on-demand' ? 'manual' : requestedType;
  if (!SCHEDULE_TYPES.has(type)) throw new BackupScheduleError('BACKUP_SCHEDULE_TYPE_INVALID', 'Choose a supported schedule type.');
  const common = base(type, input);
  if (type === 'manual') return { ...common, expression: null };
  if (type === 'interval') {
    const intervalMinutes = integer(input.intervalMinutes, 'Interval minutes', 1, MAX_INTERVAL_MINUTES);
    return { ...common, intervalMinutes, anchorAt: isoTime(input.anchorAt || options.now || new Date(), 'Interval anchor') };
  }
  if (type === 'cron') return { ...common, expression: validateCron(input.expression, new Date(options.now || Date.now()), common.timezone) };
  if (type === 'hourly') return { ...common, minute: integer(input.minute ?? 0, 'Minute', 0, 59) };
  const time = clockTime(input.time || '00:00');
  if (type === 'daily') return { ...common, time: time.value, hour: time.hour, minute: time.minute };
  if (type === 'weekly') {
    if (!Array.isArray(input.daysOfWeek) || input.daysOfWeek.length === 0) {
      throw new BackupScheduleError('BACKUP_SCHEDULE_INVALID', 'Choose at least one weekday.');
    }
    const daysOfWeek = [...new Set(input.daysOfWeek.map((day) => integer(day, 'Weekday', 0, 6)))].sort((left, right) => left - right);
    return { ...common, daysOfWeek, time: time.value, hour: time.hour, minute: time.minute };
  }
  return {
    ...common,
    dayOfMonth: integer(input.dayOfMonth, 'Day of month', 1, 31),
    time: time.value,
    hour: time.hour,
    minute: time.minute,
    absentDayBehavior: 'skip-month'
  };
}

function localInstants(schedule, components) {
  const local = DateTime.fromObject({ ...components, second: 0, millisecond: 0 }, { zone: schedule.timezone });
  if (!local.isValid) throw new BackupScheduleError('BACKUP_SCHEDULE_TIME_INVALID', 'The local schedule time is invalid.');
  const sameWallTime = ['year', 'month', 'day', 'hour', 'minute'].every((field) => local[field] === components[field]);
  if (!sameWallTime) {
    if (schedule.dstBehavior.nonexistentTime === 'skip') return [];
    return [local];
  }
  const possible = local.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis());
  if (possible.length < 2) return [local];
  if (schedule.dstBehavior.ambiguousTime === 'first') return [possible[0]];
  if (schedule.dstBehavior.ambiguousTime === 'second') return [possible[possible.length - 1]];
  return possible;
}

function firstLater(instants, afterMs) {
  const candidate = instants.find((instant) => instant.toMillis() > afterMs);
  return candidate ? candidate.toUTC().toISO() : null;
}

function nextHourly(schedule, afterMs) {
  const localAfter = DateTime.fromMillis(afterMs, { zone: schedule.timezone });
  let wallHour = DateTime.utc(localAfter.year, localAfter.month, localAfter.day, localAfter.hour);
  for (let offset = 0; offset < 72; offset += 1) {
    const wall = wallHour.plus({ hours: offset });
    const result = firstLater(localInstants(schedule, { year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: schedule.minute }), afterMs);
    if (result) return result;
  }
  throw new BackupScheduleError('BACKUP_SCHEDULE_INVALID', 'The hourly schedule has no next occurrence.');
}

function nextCalendar(schedule, afterMs, matchesDate, maximumDays) {
  const localAfter = DateTime.fromMillis(afterMs, { zone: schedule.timezone });
  let wallDate = DateTime.utc(localAfter.year, localAfter.month, localAfter.day);
  for (let offset = 0; offset <= maximumDays; offset += 1) {
    const wall = wallDate.plus({ days: offset });
    if (!matchesDate(wall)) continue;
    const result = firstLater(localInstants(schedule, { year: wall.year, month: wall.month, day: wall.day, hour: schedule.hour, minute: schedule.minute }), afterMs);
    if (result) return result;
  }
  throw new BackupScheduleError('BACKUP_SCHEDULE_INVALID', 'The calendar schedule has no next occurrence.');
}

function nextCron(schedule, afterMs) {
  if (schedule.dstBehavior.ambiguousTime === 'both') {
    const prior = CronExpressionParser.parse(schedule.expression, { currentDate: new Date(afterMs - 1), tz: schedule.timezone }).next().getTime();
    if (prior === afterMs) {
      const localAfter = DateTime.fromMillis(afterMs, { zone: schedule.timezone });
      const possible = localAfter.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis());
      const later = possible.find((candidate) => candidate.toMillis() > afterMs);
      if (later) return later.toUTC().toISO();
    }
  }
  let cursor = afterMs;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const parser = CronExpressionParser.parse(schedule.expression, { currentDate: new Date(cursor), tz: schedule.timezone });
    const parsed = parser.next();
    const parsedMs = parsed.getTime();
    const local = DateTime.fromMillis(parsedMs, { zone: schedule.timezone });
    const shiftedGap = !parser.fields.hour.values.includes(local.hour) || !parser.fields.minute.values.includes(local.minute);
    if (shiftedGap && schedule.dstBehavior.nonexistentTime === 'skip') {
      cursor = parsedMs;
      continue;
    }
    const possible = local.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis());
    if (possible.length > 1) {
      if (schedule.dstBehavior.ambiguousTime === 'second') return possible[possible.length - 1].toUTC().toISO();
      if (schedule.dstBehavior.ambiguousTime === 'both') return firstLater(possible, afterMs) || possible[possible.length - 1].toUTC().toISO();
      return possible[0].toUTC().toISO();
    }
    return new Date(parsedMs).toISOString();
  }
  throw new BackupScheduleError('BACKUP_CRON_INVALID', 'Cron has no next occurrence under the daylight-saving policy.');
}

function nextOccurrence(input, after = new Date()) {
  if (!input || ['manual', 'on-demand'].includes(input.type)) return null;
  const schedule = normalizeSchedule(input, { now: input.anchorAt || after });
  const afterIso = isoTime(after, 'Schedule cursor');
  const afterMs = Date.parse(afterIso);
  if (schedule.type === 'interval') {
    const anchorMs = Date.parse(schedule.anchorAt);
    const intervalMs = schedule.intervalMinutes * 60 * 1000;
    const steps = Math.max(0, Math.floor((afterMs - anchorMs) / intervalMs) + 1);
    return new Date(anchorMs + steps * intervalMs).toISOString();
  }
  if (schedule.type === 'cron') {
    try {
      return nextCron(schedule, afterMs);
    } catch {
      throw new BackupScheduleError('BACKUP_CRON_INVALID', 'Cron must be a valid five-field expression.');
    }
  }
  if (schedule.type === 'hourly') return nextHourly(schedule, afterMs);
  if (schedule.type === 'daily') return nextCalendar(schedule, afterMs, () => true, 3);
  if (schedule.type === 'weekly') return nextCalendar(schedule, afterMs, (date) => schedule.daysOfWeek.includes(date.weekday % 7), 14);
  return nextCalendar(schedule, afterMs, (date) => date.day === schedule.dayOfMonth, 370);
}

function describeSchedule(input) {
  const schedule = normalizeSchedule(input, { now: input?.anchorAt || new Date(0) });
  if (schedule.type === 'manual') return 'Manual only';
  if (schedule.type === 'interval') return `Every ${schedule.intervalMinutes} ${schedule.intervalMinutes === 1 ? 'minute' : 'minutes'}`;
  if (schedule.type === 'cron') return `Cron ${schedule.expression} ${schedule.timezone}`;
  if (schedule.type === 'hourly') return `Hourly at minute ${String(schedule.minute).padStart(2, '0')} ${schedule.timezone}`;
  if (schedule.type === 'daily') return `Daily at ${schedule.time} ${schedule.timezone}`;
  if (schedule.type === 'weekly') return `${schedule.daysOfWeek.map((day) => WEEKDAY_NAMES[day].slice(0, 3)).join(', ')} at ${schedule.time} ${schedule.timezone}`;
  return `Monthly on day ${schedule.dayOfMonth} at ${schedule.time} ${schedule.timezone}`;
}

module.exports = {
  BackupScheduleError,
  MAX_CRON_LENGTH,
  MAX_INTERVAL_MINUTES,
  SCHEDULE_TYPES,
  WEEKDAY_NAMES,
  AMBIGUOUS_TIME_BEHAVIORS,
  NONEXISTENT_TIME_BEHAVIORS,
  describeSchedule,
  nextOccurrence,
  normalizeSchedule,
  normalizeTimezone,
  validateCron
};
