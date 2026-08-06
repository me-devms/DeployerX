const crypto = require('crypto');
const { CronExpressionParser } = require('cron-parser');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID, normalizeConfig, parseTsv, readDiscovery, runSqlCommand } = require('./cockroachdb');
const {
  normalizeDestination,
  normalizeSelection,
  quoteIdentifier,
  quoteSqlString
} = require('./cockroachdb-native');

const SCHEDULE_CONTROLLER_VERSION = '0.1.0';
const DEFAULT_MAXIMUM_INCREMENTALS = 48;
const COMPACTED_MAXIMUM_INCREMENTALS = 400;
const MINIMUM_INCREMENTAL_CADENCE_MS = 5 * 60 * 1000;
const SCHEDULE_MODES = new Set(['full-only', 'full-incremental']);
const PREVIOUS_RUNNING_POLICIES = new Set(['start', 'skip', 'wait']);
const EXECUTION_FAILURE_POLICIES = new Set(['retry', 'reschedule', 'pause']);
const CONTROL_OPERATIONS = new Set(['pause', 'resume']);
const MAXIMUM_SCHEDULE_ROWS = 2;
const CREATE_COLUMNS = Object.freeze(['schedule_id', 'name', 'status', 'first_run', 'schedule', 'backup_stmt']);
const RECONCILE_COLUMNS = Object.freeze([
  'schedule_id', 'label', 'schedule_status', 'next_run', 'recurrence', 'jobs_running', 'owner',
  'created', 'on_previous_running', 'on_execution_failure', 'backup_type'
]);
const POLICY_CACHE = new Map();
const MAXIMUM_POLICY_CACHE_ENTRIES = 128;

class CockroachDbNativeScheduleError extends DatabaseAdapterError {
  constructor(code, safeMessage, options = {}) {
    super(code, safeMessage, { category: options.category || 'schedule', retryable: options.retryable });
    this.name = 'CockroachDbNativeScheduleError';
  }
}

function fail(code, message, category = 'validation', retryable = false) {
  throw new CockroachDbNativeScheduleError(code, message, { category, retryable });
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function plainObject(value, label, allowedFields = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  if (allowedFields) {
    const unknown = Object.keys(value).filter((key) => !allowedFields.includes(key));
    if (unknown.length) throw new TypeError(`Unknown ${label} field: ${unknown[0]}.`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stable(value)).digest('hex')}`;
}

function fingerprint(value, label) {
  const text = requiredText(value, label, 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function timestamp(value, label, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '' || String(value).toUpperCase() === 'NULL')) return null;
  const date = new Date(requiredText(value, label, 100));
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function validateUtcCron(value, label = 'CockroachDB UTC cron') {
  const expression = requiredText(value, label, 200).replace(/\s+/g, ' ');
  if (expression.split(' ').length !== 5 || /[^\x20-\x7e]/.test(expression)) fail('COCKROACH_NATIVE_SCHEDULE_CRON_INVALID', `${label} must be a valid five-field UTC cron expression.`);
  try {
    const parser = CronExpressionParser.parse(expression, { currentDate: new Date('2026-01-01T00:00:00.000Z'), tz: 'UTC' });
    for (let index = 0; index < 4; index += 1) parser.next();
  } catch {
    fail('COCKROACH_NATIVE_SCHEDULE_CRON_INVALID', `${label} must be a valid five-field UTC cron expression.`);
  }
  return expression;
}

function cronIntervals(expression, count = 12) {
  const parser = CronExpressionParser.parse(expression, { currentDate: new Date('2026-01-01T00:00:00.000Z'), tz: 'UTC' });
  const occurrences = [];
  for (let index = 0; index <= count; index += 1) occurrences.push(parser.next().getTime());
  return occurrences.slice(1).map((value, index) => value - occurrences[index]);
}

function cronCadenceMs(expression) {
  return Math.max(...cronIntervals(expression));
}

function defaultFullCadence(recurringCron) {
  const cadence = cronCadenceMs(recurringCron);
  if (cadence <= 60 * 60 * 1000) return '0 0 * * *';
  if (cadence <= 24 * 60 * 60 * 1000) return '0 0 * * 0';
  return 'always';
}

function normalizeFirstRun(input) {
  if (input === undefined || input === null || input === '' || input === 'next') return deepFreeze({ behavior: 'next', at: null });
  if (input === 'now') return deepFreeze({ behavior: 'now', at: null });
  const raw = typeof input === 'object' && !Array.isArray(input)
    ? plainObject(input, 'CockroachDB first-run policy', ['behavior', 'at'])
    : { behavior: 'at', at: input };
  const behavior = String(raw.behavior || 'at').toLowerCase();
  if (behavior === 'next') {
    if (raw.at !== undefined && raw.at !== null) throw new TypeError('CockroachDB next-occurrence first run cannot include a timestamp.');
    return deepFreeze({ behavior: 'next', at: null });
  }
  if (behavior === 'now') {
    if (raw.at !== undefined && raw.at !== null) throw new TypeError('CockroachDB immediate first run cannot include a timestamp.');
    return deepFreeze({ behavior: 'now', at: null });
  }
  if (behavior !== 'at') throw new TypeError('CockroachDB first-run behavior is invalid.');
  return deepFreeze({ behavior: 'at', at: timestamp(raw.at, 'CockroachDB first-run timestamp') });
}

function normalizeChainLimit(input) {
  const raw = input === undefined
    ? { compactionEnabled: false, maximumIncrementals: DEFAULT_MAXIMUM_INCREMENTALS, settingFingerprint: null }
    : plainObject(input, 'CockroachDB scheduled chain-limit evidence', ['compactionEnabled', 'maximumIncrementals', 'settingFingerprint']);
  const compactionEnabled = raw.compactionEnabled === true;
  const expected = compactionEnabled ? COMPACTED_MAXIMUM_INCREMENTALS : DEFAULT_MAXIMUM_INCREMENTALS;
  const maximumIncrementals = positiveInteger(raw.maximumIncrementals ?? expected, 'CockroachDB scheduled maximum incrementals', COMPACTED_MAXIMUM_INCREMENTALS);
  if (maximumIncrementals !== expected) fail('COCKROACH_NATIVE_SCHEDULE_CHAIN_LIMIT_INVALID', 'CockroachDB scheduled chain limits must match the discovered backup-compaction setting.', 'compatibility');
  const settingFingerprint = raw.settingFingerprint === null || raw.settingFingerprint === undefined
    ? null
    : fingerprint(raw.settingFingerprint, 'CockroachDB backup-compaction setting fingerprint');
  if (compactionEnabled && !settingFingerprint) fail('COCKROACH_NATIVE_SCHEDULE_COMPACTION_UNPROVEN', 'CockroachDB backup compaction must be proven by fresh cluster-setting evidence.', 'authorization');
  return deepFreeze({ compactionEnabled, maximumIncrementals, settingFingerprint });
}

function assertScheduleChainCadence(policy) {
  if (policy.mode !== 'full-incremental') return;
  if (Math.min(...cronIntervals(policy.recurringCron, 64)) < MINIMUM_INCREMENTAL_CADENCE_MS) {
    fail('COCKROACH_NATIVE_SCHEDULE_CADENCE_INVALID', 'CockroachDB incremental schedules must be at least five minutes apart.', 'compatibility');
  }
  const fullParser = CronExpressionParser.parse(policy.fullCron, { currentDate: new Date('2026-01-01T00:00:00.000Z'), tz: 'UTC' });
  const fullTimes = [];
  for (let index = 0; index < 9; index += 1) fullTimes.push(fullParser.next().getTime());
  const counts = Array(fullTimes.length - 1).fill(0);
  const incrementalParser = CronExpressionParser.parse(policy.recurringCron, { currentDate: new Date(fullTimes[0]), tz: 'UTC' });
  let window = 0;
  for (let attempts = 0; attempts < 100000; attempts += 1) {
    const incrementalAt = incrementalParser.next().getTime();
    if (incrementalAt > fullTimes.at(-1)) break;
    while (window < counts.length - 1 && incrementalAt > fullTimes[window + 1]) window += 1;
    if (window >= counts.length) break;
    counts[window] += 1;
    if (counts[window] > policy.chainLimit.maximumIncrementals) {
      fail('COCKROACH_NATIVE_SCHEDULE_CHAIN_LIMIT', 'CockroachDB UTC cron policies exceed the discovered incremental chain limit between full backups.', 'compatibility');
    }
    if (attempts === 99999) fail('COCKROACH_NATIVE_SCHEDULE_CHAIN_SCAN_LIMIT', 'CockroachDB schedule cadence could not be proven within the bounded chain scan.', 'capacity');
  }
}

function normalizeNativeSchedulePolicy(input = {}) {
  const raw = plainObject(input, 'CockroachDB native schedule policy', [
    'mode', 'recurringCron', 'fullCron', 'revisionHistory', 'onPreviousRunning', 'onExecutionFailure',
    'firstRun', 'chainLimit'
  ]);
  const cacheKey = stable(raw);
  if (POLICY_CACHE.has(cacheKey)) return POLICY_CACHE.get(cacheKey);
  const mode = String(raw.mode || 'full-incremental').toLowerCase();
  if (!SCHEDULE_MODES.has(mode)) throw new TypeError('CockroachDB native schedule mode is invalid.');
  const recurringCron = validateUtcCron(raw.recurringCron, mode === 'full-only' ? 'CockroachDB full-backup UTC cron' : 'CockroachDB incremental UTC cron');
  let fullCron;
  if (mode === 'full-only') {
    if (raw.fullCron !== undefined && raw.fullCron !== null && raw.fullCron !== '' && String(raw.fullCron).toLowerCase() !== 'always') {
      throw new TypeError('CockroachDB full-only schedules use every recurring occurrence as a full backup.');
    }
    fullCron = 'always';
  } else {
    const requestedFull = raw.fullCron === undefined || raw.fullCron === null || raw.fullCron === ''
      ? defaultFullCadence(recurringCron)
      : String(raw.fullCron).trim().toLowerCase();
    if (requestedFull === 'always') fail('COCKROACH_NATIVE_SCHEDULE_FULL_CADENCE_REQUIRED', 'Choose an explicit full-backup UTC cron to create a full and incremental schedule pair.', 'compatibility');
    fullCron = validateUtcCron(requestedFull, 'CockroachDB full-backup UTC cron');
    if (cronCadenceMs(fullCron) < cronCadenceMs(recurringCron)) fail('COCKROACH_NATIVE_SCHEDULE_CADENCE_INVALID', 'The full-backup cadence cannot run more frequently than the incremental cadence.', 'compatibility');
  }
  const onPreviousRunning = String(raw.onPreviousRunning || 'wait').toLowerCase();
  const onExecutionFailure = String(raw.onExecutionFailure || 'reschedule').toLowerCase();
  if (!PREVIOUS_RUNNING_POLICIES.has(onPreviousRunning)) throw new TypeError('CockroachDB overlap policy is invalid.');
  if (!EXECUTION_FAILURE_POLICIES.has(onExecutionFailure)) throw new TypeError('CockroachDB execution-failure policy is invalid.');
  const normalized = {
    version: 1,
    timezone: 'UTC',
    mode,
    recurringCron,
    fullCron,
    resolvedFullCadence: mode === 'full-only' ? recurringCron : fullCron,
    revisionHistory: raw.revisionHistory !== false,
    onPreviousRunning: {
      requested: onPreviousRunning,
      full: onPreviousRunning,
      incremental: mode === 'full-incremental' ? 'wait' : null
    },
    onExecutionFailure,
    firstRun: normalizeFirstRun(raw.firstRun),
    chainLimit: normalizeChainLimit(raw.chainLimit)
  };
  assertScheduleChainCadence(normalized);
  const result = deepFreeze(normalized);
  if (POLICY_CACHE.size >= MAXIMUM_POLICY_CACHE_ENTRIES) POLICY_CACHE.delete(POLICY_CACHE.keys().next().value);
  POLICY_CACHE.set(cacheKey, result);
  return result;
}

function normalizeBinding(input = {}) {
  const raw = plainObject(input, 'CockroachDB native schedule binding', [
    'clusterId', 'deploymentFingerprint', 'topologyFingerprint', 'inventoryFingerprint', 'connectionRevision'
  ]);
  const clusterId = requiredText(raw.clusterId, 'CockroachDB schedule cluster ID', 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clusterId)) throw new TypeError('CockroachDB schedule cluster ID is invalid.');
  return deepFreeze({
    clusterId,
    deploymentFingerprint: fingerprint(raw.deploymentFingerprint, 'CockroachDB schedule deployment fingerprint'),
    topologyFingerprint: fingerprint(raw.topologyFingerprint, 'CockroachDB schedule topology fingerprint'),
    inventoryFingerprint: fingerprint(raw.inventoryFingerprint, 'CockroachDB schedule inventory fingerprint'),
    connectionRevision: positiveInteger(raw.connectionRevision, 'CockroachDB schedule connection revision')
  });
}

function normalizeScheduleRequest(input = {}) {
  const raw = plainObject(input, 'CockroachDB native schedule request', [
    'connection', 'binding', 'selection', 'destination', 'sourceId', 'policy'
  ]);
  return deepFreeze({
    connection: normalizeConfig(raw.connection),
    binding: normalizeBinding(raw.binding),
    selection: normalizeSelection(raw.selection),
    destination: normalizeDestination(raw.destination),
    sourceId: requiredText(raw.sourceId, 'CockroachDB Source ID', 200),
    policy: normalizeNativeSchedulePolicy(raw.policy)
  });
}

function destinationSql(destination) {
  const values = destination.localities.map((item) => quoteSqlString(`external://${item.externalConnectionName}`, 'CockroachDB external connection URI'));
  return values.length === 1 ? values[0] : `(${values.join(', ')})`;
}

function targetSql(selection) {
  if (selection.scope === 'cluster') return '';
  if (selection.scope === 'database') return ` DATABASE ${quoteIdentifier(selection.database, 'CockroachDB scheduled database')}`;
  return ` TABLE ${selection.tables.map((table) => [table.database, table.schema, table.name].map((part) => quoteIdentifier(part, 'CockroachDB scheduled table')).join('.')).join(', ')}`;
}

function buildCreateScheduleStatement(requestInput, labelInput) {
  const request = requestInput.connection ? requestInput : normalizeScheduleRequest(requestInput);
  const label = requiredText(labelInput, 'CockroachDB native schedule label', 128);
  if (!/^deployerx_bm411_[a-f0-9]{16,64}$/.test(label)) throw new TypeError('CockroachDB native schedule label is invalid.');
  const backupOptions = request.policy.revisionHistory ? ' WITH revision_history = true' : ' WITH revision_history = false';
  const fullClause = request.policy.mode === 'full-only'
    ? ' FULL BACKUP ALWAYS'
    : ` FULL BACKUP ${quoteSqlString(request.policy.fullCron, 'CockroachDB full-backup UTC cron')}`;
  const scheduleOptions = [
    `on_previous_running = ${quoteSqlString(request.policy.onPreviousRunning.requested, 'CockroachDB overlap policy')}`,
    `on_execution_failure = ${quoteSqlString(request.policy.onExecutionFailure, 'CockroachDB execution-failure policy')}`
  ];
  if (request.policy.firstRun.behavior === 'now') scheduleOptions.push("first_run = 'now'");
  if (request.policy.firstRun.behavior === 'at') scheduleOptions.push(`first_run = ${quoteSqlString(request.policy.firstRun.at, 'CockroachDB first-run timestamp')}`);
  return `CREATE SCHEDULE ${quoteIdentifier(label, 'CockroachDB native schedule label')} FOR BACKUP${targetSql(request.selection)} INTO ${destinationSql(request.destination)}${backupOptions} RECURRING ${quoteSqlString(request.policy.recurringCron, 'CockroachDB recurring UTC cron')}${fullClause} WITH SCHEDULE OPTIONS ${scheduleOptions.join(', ')}`;
}

function normalizeScheduleId(value, label = 'CockroachDB schedule ID') {
  const id = requiredText(value, label, 40);
  if (!/^[1-9][0-9]{0,38}$/.test(id)) throw new TypeError(`${label} must be an exact positive numeric identifier.`);
  return id;
}

function exactColumns(rows, expected, label) {
  if (!Array.isArray(rows.columns) || rows.columns.length !== expected.length || rows.columns.some((column, index) => column !== expected[index])) {
    fail('COCKROACH_NATIVE_SCHEDULE_EVIDENCE_INVALID', `${label} returned an unexpected evidence shape.`, 'integrity');
  }
}

function scheduleRoleFromStatement(statement) {
  const text = requiredText(statement, 'CockroachDB created backup statement', 32768);
  return /\bINTO\s+LATEST\s+IN\b/i.test(text) ? 'incremental' : 'full';
}

function parseCreatedSchedules(output, expected = {}) {
  const parsed = parseTsv(output, 'CockroachDB native schedule creation');
  const columns = parsed.columns?.[1] === 'label' ? ['schedule_id', 'label', 'status', 'first_run', 'schedule', 'backup_stmt'] : CREATE_COLUMNS;
  exactColumns(parsed, columns, 'CockroachDB native schedule creation');
  const expectedCount = expected.mode === 'full-incremental' ? 2 : 1;
  if (parsed.length !== expectedCount || parsed.length > MAXIMUM_SCHEDULE_ROWS) fail('COCKROACH_NATIVE_SCHEDULE_CREATE_AMBIGUOUS', 'CockroachDB did not return the exact expected native schedule set.', 'integrity');
  const rows = parsed.map((row) => {
    const id = normalizeScheduleId(row.schedule_id);
    const name = requiredText(row[columns[1]], 'CockroachDB created schedule label', 128);
    const role = scheduleRoleFromStatement(row.backup_stmt);
    const recurrence = requiredText(row.schedule, 'CockroachDB created schedule recurrence', 200).replace(/\s+/g, ' ');
    const expectedRecurrence = role === 'incremental' ? expected.recurringCron : expected.mode === 'full-only' ? expected.recurringCron : expected.fullCron;
    if (name !== expected.label || recurrence !== expectedRecurrence) fail('COCKROACH_NATIVE_SCHEDULE_CREATE_CHANGED', 'CockroachDB created a schedule with changed label or recurrence evidence.', 'integrity');
    return {
      scheduleId: id,
      role,
      recurrence,
      status: String(row.status || '').toLowerCase().startsWith('paused') ? 'paused' : 'active',
      firstRunAt: timestamp(row.first_run, 'CockroachDB created first-run time', true)
    };
  });
  if (new Set(rows.map((row) => row.scheduleId)).size !== rows.length || new Set(rows.map((row) => row.role)).size !== rows.length
    || !rows.some((row) => row.role === 'full') || expected.mode === 'full-incremental' && !rows.some((row) => row.role === 'incremental')) {
    fail('COCKROACH_NATIVE_SCHEDULE_CREATE_AMBIGUOUS', 'CockroachDB returned ambiguous full and incremental schedule ownership.', 'integrity');
  }
  return deepFreeze(rows.sort((left, right) => left.role === 'full' ? -1 : right.role === 'full' ? 1 : 0));
}

function buildScheduleReconciliationQuery(scheduleIds) {
  const ids = [...new Set(scheduleIds.map((id) => normalizeScheduleId(id)))].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
  if (ids.length < 1 || ids.length > MAXIMUM_SCHEDULE_ROWS) throw new TypeError('CockroachDB schedule reconciliation requires one exact owned schedule set.');
  return `WITH schedules AS (SHOW SCHEDULES FOR BACKUP) SELECT id::STRING AS schedule_id, label::STRING AS label, schedule_status::STRING AS schedule_status, COALESCE(next_run::STRING, '') AS next_run, recurrence::STRING AS recurrence, jobsrunning::STRING AS jobs_running, owner::STRING AS owner, created::STRING AS created, on_previous_running::STRING AS on_previous_running, on_execution_failure::STRING AS on_execution_failure, backup_type::STRING AS backup_type FROM schedules WHERE id IN (${ids.join(', ')}) ORDER BY id`;
}

function normalizeFailureEvidence(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (['retry', 'retry_soon'].includes(normalized)) return 'retry';
  if (['reschedule', 'retry_sched', 'retry_schedule'].includes(normalized)) return 'reschedule';
  if (['pause', 'pause_sched', 'pause_schedule'].includes(normalized)) return 'pause';
  return null;
}

function normalizePreviousEvidence(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return PREVIOUS_RUNNING_POLICIES.has(normalized) ? normalized : null;
}

function publicStatus(value) {
  const text = String(value || '').toLowerCase();
  if (text.startsWith('active')) return 'active';
  if (text.startsWith('paused')) return 'paused';
  return 'attention-required';
}

function parseReconciledSchedules(output, ownership) {
  const parsed = parseTsv(output, 'CockroachDB native schedule reconciliation');
  exactColumns(parsed, RECONCILE_COLUMNS, 'CockroachDB native schedule reconciliation');
  if (parsed.length > Object.values(ownership.scheduleIds).filter(Boolean).length) fail('COCKROACH_NATIVE_SCHEDULE_RECONCILE_AMBIGUOUS', 'CockroachDB returned an ambiguous native schedule set.', 'integrity');
  const rolesById = new Map(Object.entries(ownership.scheduleIds).filter(([, id]) => id).map(([role, id]) => [id, role]));
  const rows = parsed.map((row) => {
    const scheduleId = normalizeScheduleId(row.schedule_id);
    const role = rolesById.get(scheduleId);
    const backupType = String(row.backup_type || '').trim().toLowerCase();
    const labelDigest = stableDigest(requiredText(row.label, 'CockroachDB reconciled schedule label', 128));
    const recurrence = requiredText(row.recurrence, 'CockroachDB reconciled recurrence', 200).replace(/\s+/g, ' ');
    const expectedRecurrence = role === 'incremental' ? ownership.policy.recurringCron : ownership.policy.resolvedFullCadence;
    const expectedOverlap = role === 'incremental' ? 'wait' : ownership.policy.onPreviousRunning.full;
    const jobsRunning = positiveInteger(row.jobs_running, 'CockroachDB running schedule-job count', 1000000, 0);
    if (!role || backupType !== role || labelDigest !== ownership.labelDigest || row.owner !== ownership.currentUser
      || recurrence !== expectedRecurrence || normalizePreviousEvidence(row.on_previous_running) !== expectedOverlap
      || normalizeFailureEvidence(row.on_execution_failure) !== ownership.policy.onExecutionFailure) {
      fail('COCKROACH_NATIVE_SCHEDULE_OWNERSHIP_CHANGED', 'CockroachDB native schedule identity, role, owner, cadence, or policy changed.', 'integrity');
    }
    return {
      scheduleId,
      role,
      status: publicStatus(row.schedule_status),
      nextRunAt: timestamp(row.next_run, 'CockroachDB next scheduled run', true),
      recurrence,
      jobsRunning,
      createdAt: timestamp(row.created, 'CockroachDB schedule creation time')
    };
  });
  if (new Set(rows.map((row) => row.scheduleId)).size !== rows.length) fail('COCKROACH_NATIVE_SCHEDULE_RECONCILE_AMBIGUOUS', 'CockroachDB returned duplicate native schedule evidence.', 'integrity');
  return deepFreeze(rows.sort((left, right) => left.role === 'full' ? -1 : right.role === 'full' ? 1 : 0));
}

function normalizeOwnership(input = {}) {
  const raw = plainObject(input, 'CockroachDB native schedule ownership', [
    'version', 'adapterId', 'controllerVersion', 'operation', 'sourceId', 'binding', 'selectionFingerprint',
    'destinationFingerprint', 'localityFingerprint', 'policy', 'scheduleIds', 'labelDigest', 'currentUser',
    'planDigest', 'createdAt', 'ownershipFingerprint'
  ]);
  if (raw.version !== 1 || raw.adapterId !== ADAPTER_ID || raw.controllerVersion !== SCHEDULE_CONTROLLER_VERSION || raw.operation !== 'cockroachdb-native-schedule') throw new TypeError('CockroachDB native schedule ownership version is invalid.');
  const scheduleIdsInput = plainObject(raw.scheduleIds, 'CockroachDB owned schedule IDs', ['full', 'incremental']);
  const policy = normalizeNativeSchedulePolicy({
    mode: raw.policy?.mode,
    recurringCron: raw.policy?.recurringCron,
    fullCron: raw.policy?.mode === 'full-only' ? 'always' : raw.policy?.fullCron,
    revisionHistory: raw.policy?.revisionHistory,
    onPreviousRunning: raw.policy?.onPreviousRunning?.requested,
    onExecutionFailure: raw.policy?.onExecutionFailure,
    firstRun: raw.policy?.firstRun,
    chainLimit: raw.policy?.chainLimit
  });
  const scheduleIds = {
    full: normalizeScheduleId(scheduleIdsInput.full, 'CockroachDB owned full schedule ID'),
    incremental: scheduleIdsInput.incremental === null ? null : normalizeScheduleId(scheduleIdsInput.incremental, 'CockroachDB owned incremental schedule ID')
  };
  if ((policy.mode === 'full-incremental') !== Boolean(scheduleIds.incremental)) throw new TypeError('CockroachDB owned schedule roles do not match policy.');
  const normalized = {
    version: 1,
    adapterId: ADAPTER_ID,
    controllerVersion: SCHEDULE_CONTROLLER_VERSION,
    operation: 'cockroachdb-native-schedule',
    sourceId: requiredText(raw.sourceId, 'CockroachDB owned Source ID', 200),
    binding: normalizeBinding(raw.binding),
    selectionFingerprint: fingerprint(raw.selectionFingerprint, 'CockroachDB owned selection fingerprint'),
    destinationFingerprint: fingerprint(raw.destinationFingerprint, 'CockroachDB owned destination fingerprint'),
    localityFingerprint: fingerprint(raw.localityFingerprint, 'CockroachDB owned locality fingerprint'),
    policy,
    scheduleIds,
    labelDigest: fingerprint(raw.labelDigest, 'CockroachDB owned schedule-label fingerprint'),
    currentUser: requiredText(raw.currentUser, 'CockroachDB owned schedule user', 256),
    planDigest: fingerprint(raw.planDigest, 'CockroachDB native schedule plan digest'),
    createdAt: timestamp(raw.createdAt, 'CockroachDB native schedule creation time')
  };
  const ownershipFingerprint = stableDigest(normalized);
  if (raw.ownershipFingerprint !== undefined && fingerprint(raw.ownershipFingerprint, 'CockroachDB native schedule ownership fingerprint') !== ownershipFingerprint) throw new TypeError('CockroachDB native schedule ownership fingerprint changed.');
  return deepFreeze({ ...normalized, ownershipFingerprint });
}

function safePolicy(policy) {
  return deepFreeze({
    timezone: 'UTC',
    mode: policy.mode,
    recurringCron: policy.recurringCron,
    resolvedFullCadence: policy.resolvedFullCadence,
    revisionHistory: policy.revisionHistory,
    onPreviousRunning: policy.onPreviousRunning,
    onExecutionFailure: policy.onExecutionFailure,
    firstRun: policy.firstRun,
    chainLimit: policy.chainLimit
  });
}

function publicSchedulePlan(input = {}) {
  const plan = plainObject(input, 'CockroachDB native schedule plan');
  const { planDigest, ...unsigned } = plan;
  if (plan.version !== 1 || plan.adapterId !== ADAPTER_ID || plan.controllerVersion !== SCHEDULE_CONTROLLER_VERSION
    || plan.operation !== 'cockroachdb-native-schedule' || fingerprint(planDigest, 'CockroachDB native schedule plan digest') !== stableDigest(unsigned)) {
    fail('COCKROACH_NATIVE_SCHEDULE_PLAN_CHANGED', 'CockroachDB native schedule plan integrity validation failed.', 'integrity');
  }
  return deepFreeze({
    version: 1,
    operation: 'cockroachdb-native-schedule',
    sourceId: plan.request.sourceId,
    planDigest: plan.planDigest,
    createdAt: timestamp(plan.createdAt, 'CockroachDB native schedule plan creation time'),
    policy: safePolicy(plan.request.policy),
    selection: {
      scope: plan.request.selection.scope,
      tableCount: plan.request.selection.tables.length,
      selectionFingerprint: plan.request.selection.fingerprint
    },
    destination: {
      type: 'external-connection',
      localityAware: plan.request.destination.localityAware,
      bindingCount: plan.request.destination.localities.length,
      destinationFingerprint: plan.request.destination.destinationFingerprint,
      localityFingerprint: plan.request.destination.localityFingerprint
    }
  });
}

function publicScheduleProjection(input = {}) {
  const ownership = normalizeOwnership(input.ownership || input);
  const schedules = Array.isArray(input.schedules) ? input.schedules : [];
  const expectedRoles = ownership.policy.mode === 'full-incremental' ? 2 : 1;
  const state = schedules.length === 0 ? 'missing'
    : schedules.length !== expectedRoles ? 'incomplete'
      : schedules.some((schedule) => schedule.status === 'attention-required') ? 'attention-required'
        : schedules.every((schedule) => schedule.status === 'paused') ? 'paused' : 'active';
  return deepFreeze({
    version: 1,
    sourceId: ownership.sourceId,
    state,
    recreateAllowed: false,
    policy: safePolicy(ownership.policy),
    schedules: schedules.map((schedule) => ({
      role: schedule.role,
      status: schedule.status,
      nextRunAt: schedule.nextRunAt,
      recurrence: schedule.recurrence,
      jobsRunning: schedule.jobsRunning,
      createdAt: schedule.createdAt
    })),
    ownershipFingerprint: ownership.ownershipFingerprint,
    reconciledAt: input.reconciledAt ? timestamp(input.reconciledAt, 'CockroachDB schedule reconciliation time') : null
  });
}

function auditScheduleProjection(action, input = {}) {
  const projection = input.policy && input.schedules ? input : publicScheduleProjection(input);
  return deepFreeze({
    adapterId: ADAPTER_ID,
    operation: `cockroachdb-native-schedule-${requiredText(action, 'CockroachDB schedule audit action', 40)}`,
    sourceId: projection.sourceId,
    state: projection.state,
    mode: projection.policy.mode,
    timezone: 'UTC',
    fullCadence: projection.policy.resolvedFullCadence,
    incrementalCadence: projection.policy.mode === 'full-incremental' ? projection.policy.recurringCron : null,
    scheduleCount: projection.schedules.length,
    ownershipFingerprint: projection.ownershipFingerprint
  });
}

function auditSchedulePlanProjection(action, input = {}) {
  const plan = input.request ? publicSchedulePlan(input) : input;
  return deepFreeze({
    adapterId: ADAPTER_ID,
    operation: `cockroachdb-native-schedule-${requiredText(action, 'CockroachDB schedule-plan audit action', 40)}`,
    sourceId: plan.sourceId,
    planDigest: plan.planDigest,
    mode: plan.policy.mode,
    timezone: 'UTC',
    fullCadence: plan.policy.resolvedFullCadence,
    incrementalCadence: plan.policy.mode === 'full-incremental' ? plan.policy.recurringCron : null,
    destinationFingerprint: plan.destination.destinationFingerprint,
    selectionFingerprint: plan.selection.selectionFingerprint
  });
}

class CockroachDbNativeScheduleController {
  constructor({
    clock = () => new Date().toISOString(),
    labelToken = () => crypto.randomBytes(12).toString('hex'),
    discover = readDiscovery,
    runSql = runSqlCommand
  } = {}) {
    if (typeof clock !== 'function' || typeof labelToken !== 'function' || typeof discover !== 'function' || typeof runSql !== 'function') throw new TypeError('CockroachDB native schedule dependencies are invalid.');
    this.clock = clock;
    this.labelToken = labelToken;
    this.discover = discover;
    this.runSql = runSql;
  }

  async #admit(context, request, requireControl = false) {
    const discovery = await this.discover(context, request.connection);
    if (discovery.clusterId !== request.binding.clusterId || discovery.deploymentFingerprint !== request.binding.deploymentFingerprint
      || discovery.topologyFingerprint !== request.binding.topologyFingerprint || discovery.inventoryFingerprint !== request.binding.inventoryFingerprint) {
      fail('COCKROACH_NATIVE_SCHEDULE_IDENTITY_CHANGED', 'CockroachDB cluster, topology, or inventory identity changed after schedule approval.', 'integrity');
    }
    if (!discovery.capabilities?.backupIntoSyntax || !discovery.capabilities?.externalConnectionsVisible || !discovery.privileges?.visible
      || requireControl && discovery.privileges.system.CONTROLJOB !== true) {
      fail('COCKROACH_NATIVE_SCHEDULE_CAPABILITY_UNPROVEN', 'CockroachDB native schedule visibility and control capability must be proven.', 'authorization');
    }
    if (request.selection.scope === 'cluster' && discovery.privileges.system.BACKUP !== true) fail('COCKROACH_NATIVE_SCHEDULE_PRIVILEGE_MISSING', 'CockroachDB cluster BACKUP privilege is not proven.', 'authorization');
    const names = new Set((discovery.externalConnections || []).map((item) => item.name));
    if (request.destination.localities.some((item) => !names.has(item.externalConnectionName))) fail('COCKROACH_NATIVE_SCHEDULE_DESTINATION_CHANGED', 'An approved CockroachDB external connection is unavailable.', 'integrity');
    if (request.selection.scope === 'database') {
      const query = `SELECT has_database_privilege(current_user, ${quoteSqlString(request.selection.database)}, 'BACKUP')::STRING AS allowed`;
      const result = parseTsv((await this.runSql(context, request.connection, query)).stdout, 'CockroachDB scheduled database privilege');
      if (result.columns?.length !== 1 || result.columns[0] !== 'allowed' || result.length !== 1 || !['true', 't', '1'].includes(String(result[0].allowed).toLowerCase())) fail('COCKROACH_NATIVE_SCHEDULE_PRIVILEGE_MISSING', 'CockroachDB database BACKUP privilege is not proven.', 'authorization');
    }
    if (request.selection.scope === 'table') {
      for (const table of request.selection.tables) {
        const qualified = [table.database, table.schema, table.name].map((part) => quoteIdentifier(part)).join('.');
        const query = `SELECT has_table_privilege(current_user, ${quoteSqlString(qualified)}, 'BACKUP')::STRING AS allowed`;
        const result = parseTsv((await this.runSql(context, request.connection, query)).stdout, 'CockroachDB scheduled table privilege');
        if (result.columns?.length !== 1 || result.columns[0] !== 'allowed' || result.length !== 1 || !['true', 't', '1'].includes(String(result[0].allowed).toLowerCase())) fail('COCKROACH_NATIVE_SCHEDULE_PRIVILEGE_MISSING', 'CockroachDB table BACKUP privilege is not proven.', 'authorization');
      }
    }
    for (const item of request.destination.localities) await this.runSql(context, request.connection, `CHECK EXTERNAL CONNECTION ${quoteSqlString(`external://${item.externalConnectionName}`, 'CockroachDB external connection URI')}`);
    const visible = parseTsv((await this.runSql(context, request.connection, 'SELECT count(*)::STRING AS visible_schedule_count FROM [SHOW SCHEDULES FOR BACKUP]')).stdout, 'CockroachDB schedule visibility');
    if (visible.columns?.length !== 1 || visible.columns[0] !== 'visible_schedule_count' || visible.length !== 1 || !/^[0-9]+$/.test(String(visible[0].visible_schedule_count))) {
      fail('COCKROACH_NATIVE_SCHEDULE_CATALOG_UNPROVEN', 'CockroachDB backup schedule visibility is unavailable.', 'authorization');
    }
    return deepFreeze({
      currentUser: requiredText(discovery.currentUser, 'CockroachDB schedule user', 256),
      checkedAt: this.clock(),
      identityFingerprint: stableDigest({
        clusterId: discovery.clusterId,
        deploymentFingerprint: discovery.deploymentFingerprint,
        topologyFingerprint: discovery.topologyFingerprint,
        inventoryFingerprint: discovery.inventoryFingerprint
      })
    });
  }

  async plan(context = {}, input = {}) {
    const request = normalizeScheduleRequest(input);
    const admission = await this.#admit(context, request);
    const label = `deployerx_bm411_${requiredText(this.labelToken(), 'CockroachDB native schedule label token', 64)}`;
    if (!/^deployerx_bm411_[a-f0-9]{16,64}$/.test(label)) throw new TypeError('CockroachDB native schedule label token is invalid.');
    const statement = buildCreateScheduleStatement(request, label);
    const unsigned = {
      version: 1,
      adapterId: ADAPTER_ID,
      controllerVersion: SCHEDULE_CONTROLLER_VERSION,
      operation: 'cockroachdb-native-schedule',
      request,
      admission,
      label,
      labelDigest: stableDigest(label),
      statement,
      createdAt: this.clock()
    };
    return deepFreeze({ ...unsigned, planDigest: stableDigest(unsigned) });
  }

  #validatedPlan(input) {
    const plan = plainObject(input, 'CockroachDB native schedule plan');
    const { planDigest, ...unsigned } = plan;
    if (plan.version !== 1 || plan.adapterId !== ADAPTER_ID || plan.controllerVersion !== SCHEDULE_CONTROLLER_VERSION || plan.operation !== 'cockroachdb-native-schedule'
      || fingerprint(planDigest, 'CockroachDB native schedule plan digest') !== stableDigest(unsigned)
      || plan.labelDigest !== stableDigest(plan.label) || plan.statement !== buildCreateScheduleStatement(plan.request, plan.label)) {
      fail('COCKROACH_NATIVE_SCHEDULE_PLAN_CHANGED', 'CockroachDB native schedule plan integrity validation failed.', 'integrity');
    }
    return plan;
  }

  async create(context = {}, planInput = {}) {
    const plan = this.#validatedPlan(planInput);
    if (typeof context.assertNoOwnership !== 'function' || typeof context.onSubmissionPrepared !== 'function' || typeof context.onOwnership !== 'function') {
      fail('COCKROACH_NATIVE_SCHEDULE_PERSISTENCE_REQUIRED', 'Durable native schedule reservation and ownership persistence are required before creation.', 'internal');
    }
    let noOwnership;
    try { noOwnership = await context.assertNoOwnership({ sourceId: plan.request.sourceId, planDigest: plan.planDigest }); }
    catch { fail('COCKROACH_NATIVE_SCHEDULE_OWNERSHIP_CHECK_FAILED', 'Native schedule ownership could not be checked before creation.', 'integrity'); }
    if (noOwnership !== true) {
      fail('COCKROACH_NATIVE_SCHEDULE_ALREADY_OWNED', 'A native schedule reservation or ownership record already exists for this Source.', 'conflict');
    }
    await this.#admit(context, plan.request);
    try {
      await context.onSubmissionPrepared(deepFreeze({
        version: 1,
        operation: 'cockroachdb-native-schedule',
        sourceId: plan.request.sourceId,
        planDigest: plan.planDigest,
        label: plan.label,
        labelDigest: plan.labelDigest,
        preparedAt: this.clock()
      }));
    } catch {
      fail('COCKROACH_NATIVE_SCHEDULE_RESERVATION_FAILED', 'Native schedule creation could not be durably reserved before submission.', 'integrity');
    }
    const response = await this.runSql(context, plan.request.connection, plan.statement);
    const created = parseCreatedSchedules(response.stdout, {
      label: plan.label,
      mode: plan.request.policy.mode,
      recurringCron: plan.request.policy.recurringCron,
      fullCron: plan.request.policy.fullCron
    });
    const unsignedOwnership = {
      version: 1,
      adapterId: ADAPTER_ID,
      controllerVersion: SCHEDULE_CONTROLLER_VERSION,
      operation: 'cockroachdb-native-schedule',
      sourceId: plan.request.sourceId,
      binding: plan.request.binding,
      selectionFingerprint: plan.request.selection.fingerprint,
      destinationFingerprint: plan.request.destination.destinationFingerprint,
      localityFingerprint: plan.request.destination.localityFingerprint,
      policy: plan.request.policy,
      scheduleIds: {
        full: created.find((row) => row.role === 'full').scheduleId,
        incremental: created.find((row) => row.role === 'incremental')?.scheduleId || null
      },
      labelDigest: plan.labelDigest,
      currentUser: plan.admission.currentUser,
      planDigest: plan.planDigest,
      createdAt: this.clock()
    };
    const ownership = normalizeOwnership({ ...unsignedOwnership, ownershipFingerprint: stableDigest(unsignedOwnership) });
    try { await context.onOwnership(ownership); }
    catch { fail('COCKROACH_NATIVE_SCHEDULE_OWNERSHIP_PERSIST_FAILED', 'Exact CockroachDB native schedule ownership could not be durably persisted.', 'integrity'); }
    const reconciled = await this.#readOwned(context, plan.request.connection, ownership);
    return deepFreeze({ ownership, ...reconciled, public: publicScheduleProjection({ ownership, ...reconciled }) });
  }

  async #readOwned(context, connection, ownership) {
    const ids = Object.values(ownership.scheduleIds).filter(Boolean);
    const response = await this.runSql(context, connection, buildScheduleReconciliationQuery(ids));
    const schedules = parseReconciledSchedules(response.stdout, ownership);
    return deepFreeze({ schedules, reconciledAt: this.clock(), complete: schedules.length === ids.length, recreateAllowed: false });
  }

  async reconcile(context = {}, input = {}) {
    const raw = plainObject(input, 'CockroachDB native schedule reconciliation request', ['connection', 'ownership']);
    const connection = normalizeConfig(raw.connection);
    const ownership = normalizeOwnership(raw.ownership);
    const discovery = await this.discover(context, connection);
    if (discovery.clusterId !== ownership.binding.clusterId || discovery.deploymentFingerprint !== ownership.binding.deploymentFingerprint
      || discovery.topologyFingerprint !== ownership.binding.topologyFingerprint || discovery.inventoryFingerprint !== ownership.binding.inventoryFingerprint
      || discovery.currentUser !== ownership.currentUser) {
      fail('COCKROACH_NATIVE_SCHEDULE_OWNERSHIP_CHANGED', 'CockroachDB native schedule cluster, topology, inventory, or owner identity changed.', 'integrity');
    }
    const result = await this.#readOwned(context, connection, ownership);
    return deepFreeze({ ownership, ...result, public: publicScheduleProjection({ ownership, ...result }) });
  }

  async #control(context, input, operation) {
    if (!CONTROL_OPERATIONS.has(operation)) throw new TypeError('CockroachDB native schedule control operation is invalid.');
    const raw = plainObject(input, 'CockroachDB native schedule control request', ['connection', 'ownership']);
    const before = await this.reconcile(context, raw);
    if (!before.complete) fail('COCKROACH_NATIVE_SCHEDULE_CONTROL_INCOMPLETE', 'Every exact owned CockroachDB schedule must reconcile before control.', 'conflict');
    const ordered = [...before.schedules].sort((left, right) => {
      if (operation === 'pause') return left.role === 'incremental' ? -1 : right.role === 'incremental' ? 1 : 0;
      return left.role === 'full' ? -1 : right.role === 'full' ? 1 : 0;
    });
    for (const schedule of ordered) await this.runSql(context, raw.connection, `${operation.toUpperCase()} SCHEDULE ${normalizeScheduleId(schedule.scheduleId)}`);
    const after = await this.reconcile(context, raw);
    return deepFreeze({ operation, ownership: before.ownership, ...after, public: after.public });
  }

  async pause(context = {}, input = {}) { return this.#control(context, input, 'pause'); }
  async resume(context = {}, input = {}) { return this.#control(context, input, 'resume'); }
}

module.exports = {
  COMPACTED_MAXIMUM_INCREMENTALS,
  CONTROL_OPERATIONS,
  DEFAULT_MAXIMUM_INCREMENTALS,
  EXECUTION_FAILURE_POLICIES,
  MINIMUM_INCREMENTAL_CADENCE_MS,
  PREVIOUS_RUNNING_POLICIES,
  SCHEDULE_CONTROLLER_VERSION,
  SCHEDULE_MODES,
  CockroachDbNativeScheduleController,
  CockroachDbNativeScheduleError,
  assertScheduleChainCadence,
  auditSchedulePlanProjection,
  auditScheduleProjection,
  buildCreateScheduleStatement,
  buildScheduleReconciliationQuery,
  defaultFullCadence,
  normalizeNativeSchedulePolicy,
  normalizeOwnership,
  normalizeScheduleId,
  normalizeScheduleRequest,
  parseCreatedSchedules,
  parseReconciledSchedules,
  publicSchedulePlan,
  publicScheduleProjection,
  validateUtcCron
};
