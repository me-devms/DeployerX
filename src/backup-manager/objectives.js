const MAX_RECORDS = 1000;
const MINUTE_MS = 60 * 1000;
const AT_RISK_RATIO = 0.8;

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is required.`);
  return text;
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function objectiveMinutes(value) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 525600 ? minutes : null;
}

function newest(records, timeSelector) {
  return records.slice().sort((left, right) => (timeSelector(right) ?? 0) - (timeSelector(left) ?? 0))[0] || null;
}

function rpoStatus(job, policy, successfulRuns, nowMs) {
  const targetMinutes = objectiveMinutes(policy?.objectives?.rpoMinutes);
  if (!targetMinutes) return { state: 'not-configured', targetMinutes: null, ageMinutes: null, consumptionPercent: null, baselineAt: null, deadlineAt: null, remainingMinutes: null, lastSuccessfulRunId: null };
  const latest = newest(successfulRuns, (run) => timestamp(run.finishedAt || run.updatedAt || run.createdAt));
  const successAtMs = latest ? timestamp(latest.finishedAt || latest.updatedAt || latest.createdAt) : null;
  const baselineMs = successAtMs ?? timestamp(job.createdAt) ?? nowMs;
  const ageMs = Math.max(0, nowMs - baselineMs);
  const targetMs = targetMinutes * MINUTE_MS;
  const deadlineMs = baselineMs + targetMs;
  const consumptionPercent = Math.round((ageMs / targetMs) * 1000) / 10;
  const state = nowMs > deadlineMs ? 'overdue' : !latest ? 'pending-first-backup' : ageMs >= targetMs * AT_RISK_RATIO ? 'at-risk' : 'healthy';
  return {
    state,
    targetMinutes,
    ageMinutes: Math.round(ageMs / MINUTE_MS),
    consumptionPercent,
    baselineAt: iso(baselineMs),
    deadlineAt: iso(deadlineMs),
    remainingMinutes: Math.ceil((deadlineMs - nowMs) / MINUTE_MS),
    lastSuccessfulRunId: latest?.id || null
  };
}

function restoreMeasurement(restore) {
  const startedMs = timestamp(restore.progress?.startedAt || restore.startedAt || restore.createdAt);
  const completedMs = timestamp(restore.result?.completedAt || restore.completedAt || restore.updatedAt);
  if (startedMs === null || completedMs === null || completedMs < startedMs) return null;
  return {
    restoreRunId: restore.id,
    observedAt: iso(completedMs),
    observedMinutes: Math.round(((completedMs - startedMs) / MINUTE_MS) * 10) / 10,
    resultState: restore.state,
    mode: restore.mode || null,
    restoredItems: Number.isFinite(Number(restore.result?.restoredItems)) ? Number(restore.result.restoredItems) : null,
    bytesRestored: Number.isFinite(Number(restore.result?.bytesRestored)) ? Number(restore.result.bytesRestored) : null,
    coverage: 'observed-file-restore'
  };
}

function rtoStatus(policy, restores) {
  const targetMinutes = objectiveMinutes(policy?.objectives?.rtoMinutes);
  if (!targetMinutes) return { state: 'not-configured', targetMinutes: null, consumptionPercent: null, measurement: null };
  const candidates = restores.map(restoreMeasurement).filter(Boolean);
  const measurement = newest(candidates, (item) => timestamp(item.observedAt));
  if (!measurement) return { state: 'unmeasured', targetMinutes, consumptionPercent: null, measurement: null };
  const consumptionPercent = Math.round((measurement.observedMinutes / targetMinutes) * 1000) / 10;
  return {
    state: measurement.observedMinutes > targetMinutes ? 'over-target' : measurement.resultState === 'warning' ? 'within-target-warning' : 'within-target',
    targetMinutes,
    consumptionPercent,
    measurement
  };
}

function overallStatus(job, policy, rpo, rto) {
  if (job.state !== 'enabled' || policy?.enabled === false) return 'inactive';
  if (rpo.state === 'overdue' || rto.state === 'over-target') return 'critical';
  if (['pending-first-backup', 'at-risk'].includes(rpo.state) || ['unmeasured', 'within-target-warning'].includes(rto.state)) return 'warning';
  if (rpo.state !== 'not-configured' || rto.state !== 'not-configured') return 'healthy';
  return 'not-configured';
}

class BackupObjectiveStatusService {
  constructor({ controlDatabase, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase) throw new TypeError('Control database is required.');
    this.controlDatabase = controlDatabase;
    this.clock = clock;
  }

  async report(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const checkedAt = this.clock();
    const nowMs = timestamp(checkedAt);
    if (nowMs === null) throw new TypeError('Objective report time is invalid.');
    const [jobs, policies, runs, recoveryPoints, restoreRuns] = await Promise.all([
      this.controlDatabase.repository('backupJob').list(tenant, { limit: MAX_RECORDS }),
      this.controlDatabase.repository('policy').list(tenant, { limit: MAX_RECORDS }),
      this.controlDatabase.repository('run').list(tenant, { limit: MAX_RECORDS }),
      this.controlDatabase.repository('recoveryPoint').list(tenant, { limit: MAX_RECORDS }),
      this.controlDatabase.repository('restoreRun').list(tenant, { limit: MAX_RECORDS })
    ]);
    const policiesById = new Map(policies.map((policy) => [policy.id, policy]));
    const pointsById = new Map(recoveryPoints.map((point) => [point.id, point]));
    const successfulRunsByJob = new Map();
    for (const run of runs) {
      if (run.state !== 'succeeded') continue;
      if (!successfulRunsByJob.has(run.jobId)) successfulRunsByJob.set(run.jobId, []);
      successfulRunsByJob.get(run.jobId).push(run);
    }
    const restoresByJob = new Map();
    for (const restore of restoreRuns) {
      if (!['succeeded', 'warning'].includes(restore.state)) continue;
      const jobIds = [...new Set((restore.recoveryPointIds || []).map((id) => pointsById.get(id)?.jobId).filter(Boolean))];
      for (const jobId of jobIds) {
        if (!restoresByJob.has(jobId)) restoresByJob.set(jobId, []);
        restoresByJob.get(jobId).push(restore);
      }
    }
    const pointCounts = new Map();
    for (const point of recoveryPoints) pointCounts.set(point.jobId, Number(pointCounts.get(point.jobId) || 0) + 1);

    const reportedJobs = jobs.map((job) => {
      const policy = policiesById.get(job.policyId) || null;
      const rpo = rpoStatus(job, policy, successfulRunsByJob.get(job.id) || [], nowMs);
      const rto = rtoStatus(policy, restoresByJob.get(job.id) || []);
      return {
        jobId: job.id,
        jobName: job.name,
        jobState: job.state,
        policyId: policy?.id || null,
        policyEnabled: Boolean(policy?.enabled),
        nextRunAt: job.nextRunAt || null,
        recoveryPointCount: Number(pointCounts.get(job.id) || 0),
        overallState: overallStatus(job, policy, rpo, rto),
        rpo,
        rto
      };
    }).sort((left, right) => {
      const rank = { critical: 0, warning: 1, healthy: 2, inactive: 3, 'not-configured': 4 };
      return (rank[left.overallState] ?? 5) - (rank[right.overallState] ?? 5) || left.jobName.localeCompare(right.jobName, 'en-US');
    });

    const summary = {
      totalJobs: reportedJobs.length,
      monitoredJobs: reportedJobs.filter((job) => !['not-configured', 'inactive'].includes(job.overallState)).length,
      healthyJobs: reportedJobs.filter((job) => job.overallState === 'healthy').length,
      warningJobs: reportedJobs.filter((job) => job.overallState === 'warning').length,
      criticalJobs: reportedJobs.filter((job) => job.overallState === 'critical').length,
      rpoConfiguredJobs: reportedJobs.filter((job) => job.overallState !== 'inactive' && job.rpo.state !== 'not-configured').length,
      rpoOverdueJobs: reportedJobs.filter((job) => job.overallState !== 'inactive' && job.rpo.state === 'overdue').length,
      rtoConfiguredJobs: reportedJobs.filter((job) => job.overallState !== 'inactive' && job.rto.state !== 'not-configured').length,
      rtoOverTargetJobs: reportedJobs.filter((job) => job.overallState !== 'inactive' && job.rto.state === 'over-target').length,
      rtoUnmeasuredJobs: reportedJobs.filter((job) => job.overallState !== 'inactive' && job.rto.state === 'unmeasured').length,
      recoveryPointCount: recoveryPoints.length
    };
    return { checkedAt, summary, jobs: reportedJobs };
  }
}

module.exports = {
  AT_RISK_RATIO,
  BackupObjectiveStatusService,
  objectiveMinutes,
  restoreMeasurement,
  rpoStatus,
  rtoStatus
};
