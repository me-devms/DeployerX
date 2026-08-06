const assert = require('node:assert/strict');
const test = require('node:test');
const { BackupObjectiveStatusService, restoreMeasurement, rpoStatus, rtoStatus } = require('./objectives');

const WORKSPACE_ID = 'local';
const NOW = '2026-08-03T12:00:00.000Z';

function database(records) {
  return {
    repository(type) {
      return { async list(workspaceId, options = {}) { return (records[type] || []).filter((record) => record.workspaceId === workspaceId).slice(0, options.limit || 100).map((record) => structuredClone(record)); } };
    }
  };
}

function fixture() {
  const policies = [
    { id: 'policy-healthy', workspaceId: WORKSPACE_ID, enabled: true, objectives: { rpoMinutes: 60, rtoMinutes: 30 } },
    { id: 'policy-critical', workspaceId: WORKSPACE_ID, enabled: true, objectives: { rpoMinutes: 60, rtoMinutes: 15 } },
    { id: 'policy-pending', workspaceId: WORKSPACE_ID, enabled: true, objectives: { rpoMinutes: 60, rtoMinutes: 45 } },
    { id: 'policy-none', workspaceId: WORKSPACE_ID, enabled: true, objectives: { rpoMinutes: null, rtoMinutes: null } },
    { id: 'policy-inactive', workspaceId: WORKSPACE_ID, enabled: false, objectives: { rpoMinutes: 60, rtoMinutes: 30 } }
  ];
  const jobs = [
    { id: 'job-healthy', workspaceId: WORKSPACE_ID, name: 'Healthy workload', state: 'enabled', policyId: 'policy-healthy', createdAt: '2026-08-03T08:00:00.000Z', nextRunAt: '2026-08-03T12:30:00.000Z' },
    { id: 'job-critical', workspaceId: WORKSPACE_ID, name: 'Critical workload', state: 'enabled', policyId: 'policy-critical', createdAt: '2026-08-03T08:00:00.000Z' },
    { id: 'job-pending', workspaceId: WORKSPACE_ID, name: 'New workload', state: 'enabled', policyId: 'policy-pending', createdAt: '2026-08-03T11:30:00.000Z' },
    { id: 'job-none', workspaceId: WORKSPACE_ID, name: 'Unmonitored workload', state: 'enabled', policyId: 'policy-none', createdAt: '2026-08-03T08:00:00.000Z' },
    { id: 'job-inactive', workspaceId: WORKSPACE_ID, name: 'Disabled workload', state: 'enabled', policyId: 'policy-inactive', createdAt: '2026-08-03T08:00:00.000Z' }
  ];
  const runs = [
    { id: 'run-healthy', workspaceId: WORKSPACE_ID, jobId: 'job-healthy', state: 'succeeded', finishedAt: '2026-08-03T11:30:00.000Z' },
    { id: 'run-critical', workspaceId: WORKSPACE_ID, jobId: 'job-critical', state: 'succeeded', finishedAt: '2026-08-03T10:00:00.000Z' },
    { id: 'run-failed-newer', workspaceId: WORKSPACE_ID, jobId: 'job-critical', state: 'failed', finishedAt: '2026-08-03T11:55:00.000Z' }
  ];
  const recoveryPoint = [
    { id: 'point-healthy', workspaceId: WORKSPACE_ID, jobId: 'job-healthy' },
    { id: 'point-critical', workspaceId: WORKSPACE_ID, jobId: 'job-critical' },
    { id: 'point-pending', workspaceId: WORKSPACE_ID, jobId: 'job-pending' }
  ];
  const restoreRun = [
    {
      id: 'restore-healthy', workspaceId: WORKSPACE_ID, recoveryPointIds: ['point-healthy'], state: 'succeeded', mode: 'alternate',
      target: { destinationPath: 'C:\\secret-target', selectedPaths: ['/private/data'] },
      progress: { startedAt: '2026-08-03T11:00:00.000Z' }, result: { restoredItems: 4, bytesRestored: 1024, completedAt: '2026-08-03T11:20:00.000Z' }
    },
    {
      id: 'restore-critical', workspaceId: WORKSPACE_ID, recoveryPointIds: ['point-critical'], state: 'warning', mode: 'original',
      progress: { startedAt: '2026-08-03T11:30:00.000Z' }, result: { restoredItems: 8, bytesRestored: 2048, completedAt: '2026-08-03T11:50:00.000Z' }
    },
    { id: 'restore-failed', workspaceId: WORKSPACE_ID, recoveryPointIds: ['point-pending'], state: 'failed', progress: { startedAt: '2026-08-03T11:40:00.000Z' }, result: { completedAt: '2026-08-03T11:41:00.000Z' } }
  ];
  return { backupJob: jobs, policy: policies, run: runs, recoveryPoint, restoreRun };
}

test('reports workspace RPO and observed RTO status without restore targets', async () => {
  const service = new BackupObjectiveStatusService({ controlDatabase: database(fixture()), clock: () => NOW });
  const report = await service.report(WORKSPACE_ID);
  const healthy = report.jobs.find((job) => job.jobId === 'job-healthy');
  const critical = report.jobs.find((job) => job.jobId === 'job-critical');
  const pending = report.jobs.find((job) => job.jobId === 'job-pending');
  const none = report.jobs.find((job) => job.jobId === 'job-none');
  const inactive = report.jobs.find((job) => job.jobId === 'job-inactive');

  assert.equal(healthy.overallState, 'healthy');
  assert.equal(healthy.rpo.state, 'healthy');
  assert.equal(healthy.rpo.ageMinutes, 30);
  assert.equal(healthy.rto.state, 'within-target');
  assert.equal(healthy.rto.measurement.observedMinutes, 20);
  assert.equal(healthy.recoveryPointCount, 1);
  assert.equal(critical.overallState, 'critical');
  assert.equal(critical.rpo.state, 'overdue');
  assert.equal(critical.rpo.lastSuccessfulRunId, 'run-critical');
  assert.equal(critical.rto.state, 'over-target');
  assert.equal(pending.overallState, 'warning');
  assert.equal(pending.rpo.state, 'pending-first-backup');
  assert.equal(pending.rto.state, 'unmeasured');
  assert.equal(none.overallState, 'not-configured');
  assert.equal(inactive.overallState, 'inactive');
  assert.deepEqual(report.summary, {
    totalJobs: 5, monitoredJobs: 3, healthyJobs: 1, warningJobs: 1, criticalJobs: 1,
    rpoConfiguredJobs: 3, rpoOverdueJobs: 1, rtoConfiguredJobs: 3, rtoOverTargetJobs: 1, rtoUnmeasuredJobs: 1, recoveryPointCount: 3
  });
  assert.equal(JSON.stringify(report).includes('secret-target'), false);
  assert.equal(JSON.stringify(report).includes('/private/data'), false);
});

test('uses the 80 percent RPO warning boundary and preserves warning restore evidence', () => {
  const job = { id: 'job', state: 'enabled', createdAt: '2026-08-03T09:00:00.000Z' };
  const policy = { enabled: true, objectives: { rpoMinutes: 100, rtoMinutes: 30 } };
  const rpo = rpoStatus(job, policy, [{ id: 'run', state: 'succeeded', finishedAt: '2026-08-03T10:40:00.000Z' }], Date.parse(NOW));
  const rto = rtoStatus(policy, [{ id: 'restore', state: 'warning', mode: 'alternate', progress: { startedAt: '2026-08-03T11:30:00.000Z' }, result: { completedAt: '2026-08-03T11:50:00.000Z' } }]);
  assert.equal(rpo.state, 'at-risk');
  assert.equal(rpo.consumptionPercent, 80);
  assert.equal(rto.state, 'within-target-warning');
  assert.equal(rto.measurement.coverage, 'observed-file-restore');
});

test('rejects invalid report time and ignores invalid restore duration', async () => {
  assert.equal(restoreMeasurement({ id: 'restore', state: 'succeeded', progress: { startedAt: NOW }, result: { completedAt: 'invalid' } }), null);
  const service = new BackupObjectiveStatusService({ controlDatabase: database(fixture()), clock: () => 'invalid' });
  await assert.rejects(service.report(WORKSPACE_ID), /report time/);
});
