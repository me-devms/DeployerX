const { runMonitorCheck } = require('./check-engine');
const { UptimeDailyRollupService, maintenanceApplies } = require('./reporting');

const DEFAULT_MAXIMUM_CONCURRENCY = 8;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

async function executeUptimeMonitorCheck({
  controlDatabase,
  incidentPolicy,
  workspaceId,
  actorId = 'uptime-worker',
  monitor,
  secretResolver = null,
  checkRunner = runMonitorCheck,
  clock = () => new Date().toISOString(),
  probeId = 'local-windows',
  scheduledAt = null
} = {}) {
  if (!controlDatabase || !incidentPolicy) throw new TypeError('Uptime control database and incident policy are required.');
  if (!workspaceId) throw new TypeError('Workspace ID is required.');
  if (!monitor?.id) throw new TypeError('Monitor is required.');
  const checkScheduledAt = scheduledAt || monitor.nextCheckAt || clock();
  const maintenanceWindows = await controlDatabase.listMaintenanceWindows(workspaceId, { activeAt: clock(), limit: 1000 });
  const maintenance = maintenanceWindows.some((window) => maintenanceApplies(window, monitor));
  const result = await checkRunner(monitor, { secretResolver });
  return incidentPolicy.processCheck(workspaceId, actorId, monitor, { ...result, scheduledAt: checkScheduledAt, probeId }, { maintenance });
}

class UptimeRetentionService {
  constructor({ controlDatabase, now = () => Date.now(), rawCheckDays = 90, rollupMonths = 13 } = {}) {
    if (!controlDatabase) throw new TypeError('Uptime control database is required.');
    this.controlDatabase = controlDatabase;
    this.now = now;
    this.rawCheckDays = Number(rawCheckDays);
    this.rollupMonths = Number(rollupMonths);
    if (!Number.isInteger(this.rawCheckDays) || this.rawCheckDays < 1 || this.rawCheckDays > 3650) throw new TypeError('Raw-check retention days are invalid.');
    if (!Number.isInteger(this.rollupMonths) || this.rollupMonths < 1 || this.rollupMonths > 120) throw new TypeError('Rollup retention months are invalid.');
  }

  async run(workspaceId) {
    const now = new Date(this.now());
    const rawCutoff = new Date(now.getTime() - this.rawCheckDays * 86400000).toISOString();
    const rollupCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - this.rollupMonths, 1)).toISOString().slice(0, 10);
    const [checksDeleted, rollupsDeleted] = await Promise.all([
      this.controlDatabase.pruneChecksBefore(workspaceId, rawCutoff),
      this.controlDatabase.pruneDailyRollupsBefore(workspaceId, rollupCutoff)
    ]);
    return { workspaceId, completedAt: now.toISOString(), rawCutoff, rollupCutoff, checksDeleted, rollupsDeleted };
  }
}

class ScheduledUptimeWorkerService {
  constructor({
    controlDatabase,
    incidentPolicy,
    secretResolver = null,
    checkRunner = runMonitorCheck,
    retentionService = null,
    rollupService = null,
    clock = () => new Date().toISOString(),
    now = () => Date.now(),
    probeId = 'local-windows',
    processId = process.pid,
    maximumConcurrency = DEFAULT_MAXIMUM_CONCURRENCY,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    onTransition = null
  } = {}) {
    if (!controlDatabase || !incidentPolicy) throw new TypeError('Uptime control database and incident policy are required.');
    this.controlDatabase = controlDatabase;
    this.incidentPolicy = incidentPolicy;
    this.secretResolver = secretResolver;
    this.checkRunner = checkRunner;
    this.retentionService = retentionService || new UptimeRetentionService({ controlDatabase, now });
    this.rollupService = rollupService || new UptimeDailyRollupService({ controlDatabase });
    this.clock = clock;
    this.now = now;
    this.probeId = String(probeId || 'local-windows');
    this.processId = Number(processId);
    this.maximumConcurrency = Number(maximumConcurrency);
    this.pollIntervalMs = Number(pollIntervalMs);
    this.heartbeatIntervalMs = Number(heartbeatIntervalMs);
    this.onTransition = typeof onTransition === 'function' ? onTransition : null;
    if (!Number.isInteger(this.maximumConcurrency) || this.maximumConcurrency < 1 || this.maximumConcurrency > 100) throw new TypeError('Uptime worker concurrency is invalid.');
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 100 || this.pollIntervalMs > 60000) throw new TypeError('Uptime worker poll interval is invalid.');
    this.workspaceId = '';
    this.actorId = '';
    this.timer = null;
    this.activeMonitorIds = new Set();
    this.runningTasks = new Set();
    this.tickPromise = null;
    this.lastHeartbeatMs = 0;
    this.lastRetentionDate = '';
    this.lastError = null;
    this.startedAt = null;
  }

  async start(workspaceId, actorId = 'uptime-worker') {
    if (this.timer) return this.status();
    this.workspaceId = String(workspaceId || '').trim();
    this.actorId = String(actorId || 'uptime-worker').trim();
    if (!this.workspaceId) throw new TypeError('Workspace ID is required.');
    this.startedAt = this.clock();
    await this.#heartbeat('starting');
    await this.tick();
    this.timer = setInterval(() => this.tick().catch((error) => { this.lastError = error; }), this.pollIntervalMs);
    return this.status();
  }

  async stop({ drain = true } = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (drain) await Promise.allSettled([...this.runningTasks]);
    if (this.workspaceId) await this.#heartbeat('stopping').catch(() => {});
    return this.status();
  }

  status() {
    return {
      active: Boolean(this.timer),
      workspaceId: this.workspaceId,
      probeId: this.probeId,
      processId: this.processId,
      startedAt: this.startedAt,
      activeChecks: this.activeMonitorIds.size,
      maximumConcurrency: this.maximumConcurrency,
      lastHeartbeatAt: this.lastHeartbeatMs ? new Date(this.lastHeartbeatMs).toISOString() : null,
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null
    };
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.#tick().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  async runNow(monitorId) {
    const monitor = await this.controlDatabase.getMonitor(this.workspaceId, monitorId);
    if (!monitor) throw Object.assign(new Error('Monitor was not found.'), { code: 'UPTIME_MONITOR_NOT_FOUND' });
    if (this.activeMonitorIds.has(monitor.id)) return { queued: false, running: true, monitorId: monitor.id };
    if (this.runningTasks.size >= this.maximumConcurrency) return { queued: false, capacityReached: true, monitorId: monitor.id };
    const task = this.#runMonitor(monitor);
    this.#track(task, monitor.id);
    await task;
    return { queued: true, completed: true, monitorId: monitor.id };
  }

  async #tick() {
    const nowIso = this.clock();
    if (this.now() - this.lastHeartbeatMs >= this.heartbeatIntervalMs) await this.#heartbeat('active');
    const today = nowIso.slice(0, 10);
    if (today !== this.lastRetentionDate) {
      this.lastRetentionDate = today;
      const previousDate = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
      await this.rollupService.run(this.workspaceId, previousDate).catch((error) => { this.lastError = error; });
      await this.retentionService.run(this.workspaceId).catch((error) => { this.lastError = error; });
    }
    const capacity = Math.max(0, this.maximumConcurrency - this.runningTasks.size);
    if (!capacity) return this.status();
    const due = await this.controlDatabase.listMonitors(this.workspaceId, { dueBefore: nowIso, limit: capacity * 4 });
    const selected = due.filter((monitor) => !this.activeMonitorIds.has(monitor.id)).slice(0, capacity);
    for (const monitor of selected) {
      const task = this.#runMonitor(monitor);
      this.#track(task, monitor.id);
    }
    return this.status();
  }

  #track(task, monitorId) {
    this.activeMonitorIds.add(monitorId);
    this.runningTasks.add(task);
    task.catch((error) => { this.lastError = error; }).finally(() => {
      this.activeMonitorIds.delete(monitorId);
      this.runningTasks.delete(task);
    });
  }

  async #runMonitor(monitor) {
    const transition = await executeUptimeMonitorCheck({
      controlDatabase: this.controlDatabase,
      incidentPolicy: this.incidentPolicy,
      workspaceId: this.workspaceId,
      actorId: this.actorId,
      monitor,
      secretResolver: this.secretResolver,
      checkRunner: this.checkRunner,
      clock: this.clock,
      probeId: this.probeId
    });
    if (this.onTransition) await this.onTransition(transition);
    return transition;
  }

  async #heartbeat(state) {
    const heartbeatAt = this.clock();
    this.lastHeartbeatMs = Date.parse(heartbeatAt);
    await this.controlDatabase.recordWorkerHeartbeat(this.workspaceId, this.probeId, {
      state,
      heartbeatAt,
      processId: this.processId,
      startedAt: this.startedAt,
      activeChecks: this.activeMonitorIds.size,
      maximumConcurrency: this.maximumConcurrency,
      lastError: this.lastError ? String(this.lastError.message || this.lastError).slice(0, 500) : null
    });
  }
}

module.exports = {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAXIMUM_CONCURRENCY,
  DEFAULT_POLL_INTERVAL_MS,
  ScheduledUptimeWorkerService,
  UptimeRetentionService,
  executeUptimeMonitorCheck,
  maintenanceApplies
};
