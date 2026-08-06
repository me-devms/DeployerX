const { DateTime } = require('luxon');
const { BackupScheduleError, nextOccurrence, normalizeSchedule } = require('./schedule');

const MISSED_RUN_BEHAVIORS = new Set(['run-latest', 'run-all', 'skip']);
const CALENDAR_BLOCK_BEHAVIORS = new Set(['defer', 'skip']);
const MAX_CALENDAR_WINDOWS = 32;
const MAX_MISSED_SCAN = 1000;
const MAX_GRACE_MINUTES = 10080;

function integer(value, fallback, label, minimum, maximum) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', `${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function isoTime(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', `${label} is invalid.`);
  return date.toISOString();
}

function localTime(value, label) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', `${label} must use HH:mm.`);
  const hour = integer(match[1], null, `${label} hour`, 0, 23);
  const minute = integer(match[2], null, `${label} minute`, 0, 59);
  return { value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, hour, minute, totalMinutes: hour * 60 + minute };
}

function normalizeDays(input, label) {
  if (!Array.isArray(input) || input.length === 0) throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', `${label} requires at least one weekday.`);
  return [...new Set(input.map((day) => integer(day, null, 'Weekday', 0, 6)))].sort((left, right) => left - right);
}

function normalizeMaintenanceWindows(input) {
  const windows = input === undefined ? [] : input;
  if (!Array.isArray(windows) || windows.length > MAX_CALENDAR_WINDOWS) {
    throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', `Maintenance windows must contain at most ${MAX_CALENDAR_WINDOWS} entries.`);
  }
  return windows.map((window, index) => {
    const start = localTime(window?.startTime, `Maintenance window ${index + 1} start`);
    const end = localTime(window?.endTime, `Maintenance window ${index + 1} end`);
    if (start.totalMinutes === end.totalMinutes) throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', 'Maintenance window start and end must differ.');
    return {
      daysOfWeek: normalizeDays(window?.daysOfWeek, `Maintenance window ${index + 1}`),
      startTime: start.value,
      endTime: end.value,
      crossesMidnight: end.totalMinutes < start.totalMinutes
    };
  });
}

function normalizeBlackouts(input) {
  const blackouts = input === undefined ? [] : input;
  if (!Array.isArray(blackouts) || blackouts.length > MAX_CALENDAR_WINDOWS) {
    throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', `Blackouts must contain at most ${MAX_CALENDAR_WINDOWS} entries.`);
  }
  return blackouts.map((blackout, index) => {
    const startsAt = isoTime(blackout?.startsAt, `Blackout ${index + 1} start`);
    const endsAt = isoTime(blackout?.endsAt, `Blackout ${index + 1} end`);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', 'Blackout end must be after its start.');
    return { startsAt, endsAt };
  }).sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

function normalizeSchedulePolicy(input = {}, options = {}) {
  const schedule = normalizeSchedule(input, options);
  const missedInput = input.missedRun && typeof input.missedRun === 'object' ? input.missedRun : {};
  let behavior = String(missedInput.behavior || input.missedRunBehavior || 'run-latest');
  if (behavior === 'pending-policy' || behavior === 'not-applicable') behavior = 'run-latest';
  if (!MISSED_RUN_BEHAVIORS.has(behavior)) throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', 'Choose supported missed-run behavior.');
  const calendarInput = input.executionCalendar && typeof input.executionCalendar === 'object' ? input.executionCalendar : {};
  const outsideMaintenanceBehavior = String(calendarInput.outsideMaintenanceBehavior || 'defer');
  const blackoutBehavior = String(calendarInput.blackoutBehavior || 'defer');
  if (!CALENDAR_BLOCK_BEHAVIORS.has(outsideMaintenanceBehavior) || !CALENDAR_BLOCK_BEHAVIORS.has(blackoutBehavior)) {
    throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', 'Choose supported calendar-block behavior.');
  }
  return {
    ...schedule,
    missedRun: {
      behavior,
      graceMinutes: integer(missedInput.graceMinutes, 15, 'Missed-run grace minutes', 0, MAX_GRACE_MINUTES)
    },
    executionCalendar: {
      maintenanceWindows: normalizeMaintenanceWindows(calendarInput.maintenanceWindows),
      outsideMaintenanceBehavior,
      blackouts: normalizeBlackouts(calendarInput.blackouts),
      blackoutBehavior
    }
  };
}

function boundary(schedule, date, time, choose) {
  const local = DateTime.fromObject({ year: date.year, month: date.month, day: date.day, hour: time.hour, minute: time.minute, second: 0, millisecond: 0 }, { zone: schedule.timezone });
  if (!local.isValid) throw new BackupScheduleError('BACKUP_SCHEDULE_POLICY_INVALID', 'A maintenance-window boundary is invalid.');
  const possible = local.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis());
  return choose === 'last' ? possible[possible.length - 1] : possible[0];
}

function maintenanceInterval(schedule, window, wallDate) {
  const startTime = localTime(window.startTime, 'Maintenance window start');
  const endTime = localTime(window.endTime, 'Maintenance window end');
  const start = boundary(schedule, wallDate, startTime, 'first');
  const endDate = window.crossesMidnight ? wallDate.plus({ days: 1 }) : wallDate;
  const end = boundary(schedule, endDate, endTime, 'last');
  return { startMs: start.toMillis(), endMs: end.toMillis() };
}

function activeMaintenanceWindow(schedule, nowMs) {
  const windows = schedule.executionCalendar.maintenanceWindows;
  if (!windows.length) return null;
  const localNow = DateTime.fromMillis(nowMs, { zone: schedule.timezone });
  const today = DateTime.utc(localNow.year, localNow.month, localNow.day);
  for (const offset of [-1, 0]) {
    const wallDate = today.plus({ days: offset });
    const weekday = wallDate.weekday % 7;
    for (const window of windows) {
      if (!window.daysOfWeek.includes(weekday)) continue;
      const interval = maintenanceInterval(schedule, window, wallDate);
      if (nowMs >= interval.startMs && nowMs < interval.endMs) return { ...window, ...interval };
    }
  }
  return null;
}

function nextMaintenanceStart(schedule, nowMs) {
  const localNow = DateTime.fromMillis(nowMs, { zone: schedule.timezone });
  const today = DateTime.utc(localNow.year, localNow.month, localNow.day);
  let earliest = null;
  for (let offset = 0; offset <= 14; offset += 1) {
    const wallDate = today.plus({ days: offset });
    const weekday = wallDate.weekday % 7;
    for (const window of schedule.executionCalendar.maintenanceWindows) {
      if (!window.daysOfWeek.includes(weekday)) continue;
      const interval = maintenanceInterval(schedule, window, wallDate);
      if (interval.startMs > nowMs && (earliest === null || interval.startMs < earliest)) earliest = interval.startMs;
    }
    if (earliest !== null) break;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

function evaluateExecutionCalendar(input, now = new Date()) {
  const schedule = normalizeSchedulePolicy(input, { now: input?.anchorAt || now });
  const evaluatedAt = isoTime(now, 'Calendar evaluation time');
  const nowMs = Date.parse(evaluatedAt);
  const activeBlackouts = schedule.executionCalendar.blackouts.filter((blackout) => Date.parse(blackout.startsAt) <= nowMs && nowMs < Date.parse(blackout.endsAt));
  if (activeBlackouts.length) {
    const retryAt = activeBlackouts.map((blackout) => blackout.endsAt).sort().at(-1);
    return {
      action: schedule.executionCalendar.blackoutBehavior,
      reasonCode: 'BLACKOUT_ACTIVE',
      evaluatedAt,
      nextDispatchAttemptAt: schedule.executionCalendar.blackoutBehavior === 'defer' ? retryAt : null
    };
  }
  if (schedule.executionCalendar.maintenanceWindows.length && !activeMaintenanceWindow(schedule, nowMs)) {
    return {
      action: schedule.executionCalendar.outsideMaintenanceBehavior,
      reasonCode: 'OUTSIDE_MAINTENANCE_WINDOW',
      evaluatedAt,
      nextDispatchAttemptAt: schedule.executionCalendar.outsideMaintenanceBehavior === 'defer' ? nextMaintenanceStart(schedule, nowMs) : null
    };
  }
  return { action: 'allow', reasonCode: null, evaluatedAt, nextDispatchAttemptAt: null };
}

function evaluateMissedRun(input, nextRunAt, now = new Date()) {
  const schedule = normalizeSchedulePolicy(input, { now: input?.anchorAt || now });
  const scheduledFor = isoTime(nextRunAt, 'Scheduled occurrence time');
  const evaluatedAt = isoTime(now, 'Missed-run evaluation time');
  const scheduledMs = Date.parse(scheduledFor);
  const nowMs = Date.parse(evaluatedAt);
  if (scheduledMs > nowMs) return { action: 'not-due', scheduledFor, nextRunAt: scheduledFor, skippedCount: 0, evaluatedAt, latenessSeconds: 0 };
  const latenessSeconds = Math.floor((nowMs - scheduledMs) / 1000);
  if (latenessSeconds <= schedule.missedRun.graceMinutes * 60 || schedule.missedRun.behavior === 'run-all') {
    return { action: 'dispatch', scheduledFor, nextRunAt: scheduledFor, skippedCount: 0, evaluatedAt, latenessSeconds };
  }

  let latest = scheduledFor;
  let dueCount = 1;
  let next = nextOccurrence(schedule, latest);
  while (next && Date.parse(next) <= nowMs && dueCount < MAX_MISSED_SCAN) {
    latest = next;
    dueCount += 1;
    next = nextOccurrence(schedule, latest);
  }
  if (next && Date.parse(next) <= nowMs) {
    return { action: 'advance', scheduledFor: null, nextRunAt: next, skippedCount: dueCount, evaluatedAt, latenessSeconds, scanLimitReached: true };
  }
  if (schedule.missedRun.behavior === 'skip') {
    return { action: 'skip', scheduledFor: null, nextRunAt: next, skippedCount: dueCount, evaluatedAt, latenessSeconds, scanLimitReached: false };
  }
  return { action: 'dispatch', scheduledFor: latest, nextRunAt: latest, skippedCount: dueCount - 1, evaluatedAt, latenessSeconds, scanLimitReached: false };
}

module.exports = {
  CALENDAR_BLOCK_BEHAVIORS,
  MAX_CALENDAR_WINDOWS,
  MAX_GRACE_MINUTES,
  MAX_MISSED_SCAN,
  MISSED_RUN_BEHAVIORS,
  activeMaintenanceWindow,
  evaluateExecutionCalendar,
  evaluateMissedRun,
  nextMaintenanceStart,
  normalizeSchedulePolicy
};
