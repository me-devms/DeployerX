const { app } = require('electron');
const path = require('node:path');
const { UptimeControlDatabase } = require('./control-database');
const { UptimeIncidentPolicyService } = require('./incident-policy');
const { ScheduledUptimeWorkerService } = require('./scheduled-worker');

async function main() {
  const scriptIndex = process.argv.findIndex((argument) => path.basename(String(argument)) === path.basename(__filename));
  const [rootPath, baseUrl] = process.argv.slice(scriptIndex + 1).filter((argument) => !String(argument).startsWith('--user-data-dir='));
  if (!rootPath || !baseUrl) throw new Error('Electron worker child requires a database path and base URL.');
  await app.whenReady();
  const database = new UptimeControlDatabase({ rootPath });
  await database.initialize();
  try {
    const incidentPolicy = new UptimeIncidentPolicyService({ controlDatabase: database });
    for (const [name, pathname] of [['Window close healthy', '/healthy'], ['Window close failing', '/failing']]) {
      await database.createMonitor('local', 'electron-worker-acceptance', {
        name,
        type: 'http',
        intervalSec: 60,
        timeoutMs: 3000,
        config: { url: `${baseUrl}${pathname}`, expectedStatusRanges: ['200-299'] }
      });
    }
    const worker = new ScheduledUptimeWorkerService({
      controlDatabase: database,
      incidentPolicy,
      probeId: `electron-window-worker:${process.pid}`,
      processId: process.pid,
      maximumConcurrency: 2,
      pollIntervalMs: 100,
      heartbeatIntervalMs: 100
    });
    await worker.start('local', 'electron-worker-acceptance');
    await worker.stop({ drain: true });
    const monitors = await database.listMonitors('local');
    const checks = (await Promise.all(monitors.map((monitor) => database.listChecks('local', monitor.id))))
      .flat()
      .map((check) => ({ outcome: check.outcome, completedAt: check.completedAt }));
    process.stdout.write(`${JSON.stringify({ processId: process.pid, checks })}\n`);
  } finally {
    await database.close();
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
