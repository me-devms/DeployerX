const fs = require('node:fs/promises');
const { app, BrowserWindow } = require('electron');
const { buildUptimeReport, uptimeReportHtml } = require('./reporting');

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('PDF fixture requires an output path.');
  await app.whenReady();

  const monitor = {
    id: 'monitor-pdf',
    workspaceId: 'local',
    name: 'PDF acceptance target',
    type: 'http',
    group: 'Production',
    projectId: null,
    enabled: true,
    createdAt: '2026-08-04T00:00:00.000Z'
  };
  const report = buildUptimeReport({
    monitors: [monitor],
    checksByMonitor: {
      [monitor.id]: [{
        monitorId: monitor.id,
        scheduledAt: '2026-08-04T11:59:00.000Z',
        startedAt: '2026-08-04T11:59:00.000Z',
        completedAt: '2026-08-04T11:59:00.100Z',
        outcome: 'up',
        latencyMs: 100
      }]
    },
    incidents: [],
    maintenance: [],
    from: '2026-08-04T11:58:00.000Z',
    to: '2026-08-04T12:00:00.000Z',
    filters: { group: 'Production', slaTargetPct: 99.9 }
  });

  const reportWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(uptimeReportHtml(report))}`);
    const bytes = await reportWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fs.writeFile(outputPath, bytes);
    process.stdout.write(`${JSON.stringify({ byteLength: bytes.length })}\n`);
  } finally {
    reportWindow.destroy();
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
