const { UptimeControlDatabase } = require('./control-database');
const { UptimeIncidentPolicyService } = require('./incident-policy');
const { ScheduledUptimeWorkerService } = require('./scheduled-worker');

async function main() {
  const [rootPath, baseUrl, parentPid] = process.argv.slice(2);
  if (!rootPath || !baseUrl) throw new Error('Worker fixture requires a database path and base URL.');

  const database = new UptimeControlDatabase({ rootPath });
  await database.initialize();
  try {
    const incidentPolicy = new UptimeIncidentPolicyService({ controlDatabase: database });
    for (const [name, pathname] of [['Healthy target', '/healthy'], ['Failing target', '/failing']]) {
      await database.createMonitor('local', 'process-test', {
        name,
        type: 'http',
        intervalSec: 60,
        timeoutMs: 2000,
        config: { url: `${baseUrl}${pathname}`, expectedStatusRanges: ['200-299'] }
      });
    }

    const worker = new ScheduledUptimeWorkerService({
      controlDatabase: database,
      incidentPolicy,
      probeId: `process-test:${process.pid}`,
      processId: process.pid,
      maximumConcurrency: 2,
      pollIntervalMs: 100,
      heartbeatIntervalMs: 100
    });
    await worker.start('local', 'process-test');
    await worker.stop({ drain: true });

    const monitors = await database.listMonitors('local');
    const checks = (await Promise.all(monitors.map((monitor) => database.listChecks('local', monitor.id))))
      .flat()
      .map((check) => ({ monitorId: check.monitorId, outcome: check.outcome }));
    const heartbeat = (await database.listWorkerHeartbeats('local'))[0] || null;
    process.stdout.write(`${JSON.stringify({ processId: process.pid, parentPid: Number(parentPid), checks, heartbeat })}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
