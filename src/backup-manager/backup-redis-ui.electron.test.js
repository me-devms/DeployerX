const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const topologyFingerprint = `sha256:${'a'.repeat(64)}`;
const masters = [
  { nodeId: 'node-a', address: 'redis-a.example.com:6379', slots: ['0-8191'] },
  { nodeId: 'node-b', address: 'redis-b.example.com:6379', slots: ['8192-16383'] }
];

function redisConnection(id, name, host, nodeId, filesystemConnectionId) {
  return {
    id, name, currentDevice: true, endpoint: { host, port: 6379, username: 'backup', tlsMode: 'verify-identity', expectedTopology: 'cluster', filesystemConnectionId, redisCliExecutable: 'redis-cli', timeoutMs: 30000 },
    trust: { mode: 'verify-identity', fingerprint: `sha256:${nodeId}` },
    lastTest: {
      status: 'success', remotePlatform: { engine: 'redis', version: '8.10.0' },
      endpointIdentity: { mode: 'cluster', clusterNodeId: nodeId, clusterMasterCount: 2, coveredSlots: 16384, clusterTopologyFingerprint: topologyFingerprint, clusterMasters: masters, backupStrategy: 'sealed', deploymentFingerprint: `sha256:${nodeId}` }
    }
  };
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-redis-ui-'));
  const targetDirectory = path.join(captureRoot, 'redis-cluster-recovered');
  const connections = [
    redisConnection('connection-redis-a', 'Redis cluster A', 'redis-a.example.com', 'node-a', 'connection-ssh-a'),
    redisConnection('connection-redis-b', 'Redis cluster B', 'redis-b.example.com', 'node-b', 'connection-ssh-b')
  ];
  const encoded = Buffer.from(JSON.stringify({ connections, targetDirectory })).toString('base64');
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`));
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(`
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      document.getElementById('toast')?.classList.remove('visible');
      window.__redis = JSON.parse(atob('${encoded}'));
      window.__redisSourcePayload = null;
      window.__redisRestorePayload = null;
      window.__redisCanceled = null;
      window.__verificationPayload = null;
      window.__redisRestore = {
        id: 'restore-redis', state: 'succeeded', createdAt: '2026-08-04T13:00:00.000Z', startedAt: '2026-08-04T13:00:01.000Z', updatedAt: '2026-08-04T13:00:21.000Z', recoveryPointIds: ['point-redis'],
        target: { operation: 'alternate-directory', mode: 'alternate', engine: 'redis', targetDirectory: window.__redis.targetDirectory, targetName: 'redis-cluster-recovered' },
        progress: { phase: 'complete', itemsTotal: 2, itemsCompleted: 2, bytesWritten: 4096, startedAt: '2026-08-04T13:00:01.000Z', updatedAt: '2026-08-04T13:00:21.000Z' },
        validation: { state: 'succeeded', connectivity: 'pass', contentDigest: 'pass', expectedObjects: 'pass', nativeIntegrityValidation: true },
        result: { restoredItems: 2, bytesRestored: 4096, targetName: 'redis-cluster-recovered', recoveryTarget: { type: 'isolated-cluster-directory', path: window.__redis.targetDirectory, serviceRunning: false, masterCount: 2, coveredSlots: 16384 }, warnings: [], completedAt: '2026-08-04T13:00:21.000Z' }
      };
      const empty = async () => [];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        getSetup: async () => ({ complete: true, mode: 'offline' }),
        listBackupLocalConnections: empty,
        listBackupSshConnections: async () => [
          { id: 'connection-ssh-a', name: 'Redis A filesystem', currentDevice: true, lastTest: { status: 'success' }, endpoint: { host: 'redis-a.example.com' } },
          { id: 'connection-ssh-b', name: 'Redis B filesystem', currentDevice: true, lastTest: { status: 'success' }, endpoint: { host: 'redis-b.example.com' } }
        ],
        listBackupMysqlConnections: empty, listBackupMariadbConnections: empty, listBackupPostgresqlConnections: empty, listBackupSqlServerConnections: empty, listBackupOracleConnections: empty, listBackupMongoDbConnections: empty, listBackupSqliteConnections: empty,
        listBackupRedisConnections: async () => structuredClone(window.__redis.connections),
        testBackupRedisConnection: async (id) => { const connection = window.__redis.connections.find((item) => item.id === id); return { connection: structuredClone(connection), result: structuredClone(connection.lastTest) }; },
        discoverBackupRedisDatabases: async () => ({ items: [{ kind: 'database', name: 'db0', index: 0, keyCount: 42, expiryCount: 3, selectable: true, topology: 'cluster' }], nextCursor: null }),
        saveBackupDatabaseSource: async (payload) => { window.__redisSourcePayload = structuredClone(payload); return { id: 'source-redis', ...structuredClone(payload) }; },
        listBackupJobs: empty, listBackupRuns: empty, listBackupRestoreRuns: empty, listBackupMysqlRestoreRuns: empty, listBackupMysqlPhysicalRestoreRuns: empty, listBackupMariadbRestoreRuns: empty,
        listBackupMysqlPitrRuns: empty, listBackupMariadbPitrRuns: empty, listBackupPostgresqlRestoreRuns: empty, listBackupPostgresqlPitrRuns: empty, listBackupSqlServerRestoreRuns: empty, listBackupOracleRestoreRuns: empty, listBackupMongoDbRestoreRuns: empty, listBackupSqliteRestoreRuns: empty,
        listBackupRedisRestoreRuns: async () => [structuredClone(window.__redisRestore)],
        startBackupRedisRestore: async (payload) => { window.__redisRestorePayload = structuredClone(payload); return { id: 'restore-redis', state: 'queued', target: { operation: 'alternate-directory', mode: 'alternate', engine: 'redis' } }; },
        waitBackupRedisRestore: async () => structuredClone(window.__redisRestore),
        cancelBackupRedisRestore: async (id) => { window.__redisCanceled = id; return { id, state: 'canceled', target: { operation: 'alternate-directory', mode: 'alternate', engine: 'redis' } }; },
        listBackupVerificationRuns: empty,
        startBackupVerification: async (payload) => { window.__verificationPayload = structuredClone(payload); return { id: 'verification-redis', state: 'queued' }; },
        waitBackupVerification: async () => ({ id: 'verification-redis', state: 'succeeded', recoveryPointId: 'point-redis', result: { filesVerified: 2, bytesVerified: 4096 } })
      }});
      state.backupRedisConnections = structuredClone(window.__redis.connections);
      state.backupSshConnections = [
        { id: 'connection-ssh-a', name: 'Redis A filesystem', currentDevice: true, lastTest: { status: 'success' }, endpoint: { host: 'redis-a.example.com' } },
        { id: 'connection-ssh-b', name: 'Redis B filesystem', currentDevice: true, lastTest: { status: 'success' }, endpoint: { host: 'redis-b.example.com' } }
      ];
      showView('backup');
      setBackupManagerTab('sources');
      true;
    `);

    const source = await window.webContents.executeJavaScript(`(async () => {
      openBackupRedisModal(state.backupRedisConnections[0]);
      await discoverBackupRedis();
      const nodeB = els.backupRedisClusterMappings.querySelector('[data-backup-redis-master="node-b"]');
      nodeB.value = 'connection-redis-b';
      nodeB.dispatchEvent(new Event('change'));
      els.backupRedisSourceName.value = 'Production Redis Cluster';
      els.backupRedisMethod.value = 'aof';
      syncBackupRedisSourceReady();
      const card = els.backupRedisModal.querySelector('.modal-card').getBoundingClientRect();
      const beforeSave = { scope: els.backupRedisScopeTitle.innerText, evidence: els.backupRedisEvidence.innerText, mappingCount: els.backupRedisClusterMappings.querySelectorAll('[data-backup-redis-master]').length, saveEnabled: !els.backupRedisSaveSourceButton.disabled, card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      await saveBackupRedisSource(new Event('submit', { cancelable: true }));
      return { beforeSave, payload: window.__redisSourcePayload };
    })()`);

    const job = await window.webContents.executeJavaScript(`(() => {
      state.backupJobWizard = blankBackupJobWizard();
      state.backupJobWizard.readiness.sources = [{ id: 'source-redis', name: 'Production Redis Cluster', sourceType: 'database', adapterId: 'deployerx.database.redis.native', connectionName: 'Redis cluster A', selection: { allDatabases: true }, objectKind: 'database', objectCount: 1, requestedConsistency: { backupMethod: 'physical', method: 'redis-cluster-aof', backupMode: 'full', captureCoordinates: true }, physicalExecution: { topology: 'cluster', masters: [{ nodeId: 'node-a' }, { nodeId: 'node-b' }] }, readiness: { ready: true } }];
      state.backupJobWizard.sourceId = 'source-redis';
      syncBackupJobModeForSource();
      const incremental = els.backupJobForm.querySelector('input[name="backupJobMode"][value="incremental"]');
      const differential = els.backupJobForm.querySelector('input[name="backupJobMode"][value="differential"]');
      const full = els.backupJobForm.querySelector('input[name="backupJobMode"][value="full"]');
      return { detail: backupJobSourceDetail(state.backupJobWizard.readiness.sources[0]), incrementalDisabled: incremental.disabled, incrementalTitle: incremental.closest('label').title, differentialDisabled: differential.disabled, fullLabel: full.closest('label').innerText };
    })()`);

    const recovery = await window.webContents.executeJavaScript(`(async () => {
      state.backupRecovery = blankBackupRecovery();
      state.backupRecovery.points = [{ id: 'point-redis', jobId: 'job-redis', jobName: 'Production Redis protection', sourceId: 'source-redis', sourceName: 'Production Redis Cluster', sourceConnectionId: 'connection-redis-a', sourceType: 'database', sourceAdapterId: 'deployerx.database.redis.native', backupMethod: 'physical', type: 'full', consistency: 'crash', capturedTo: '2026-08-04T12:00:00.000Z', availableCopyCount: 1, totalCopyCount: 1, verification: { state: 'succeeded' }, repositoryCopies: [{ repositoryId: 'repository-a', repositoryName: 'Primary repository', state: 'available' }] }];
      state.backupRecovery.totalPoints = 1;
      state.backupRecovery.selectedPointId = 'point-redis';
      renderBackupRecoveryPoints(); renderBackupRecoveryEntries();
      const summary = els.backupRecoveryEntryList.innerText;
      const action = els.backupRecoveryRestoreButton.innerText;
      openBackupRedisRestore();
      els.backupRedisRestoreTargetDirectory.value = window.__redis.targetDirectory;
      els.backupRedisRestorePort.value = '26381';
      await startBackupRedisRestore(new Event('submit', { cancelable: true }));
      const status = els.backupRedisRestoreStatus.innerText;
      state.backupRecovery.activeRestore = { id: 'restore-redis-cancel', state: 'running', target: { operation: 'alternate-directory', engine: 'redis' } };
      await cancelOrCloseBackupRedisRestore();
      return { summary, action, payload: window.__redisRestorePayload, status, canceledId: window.__redisCanceled };
    })()`);

    const verification = await window.webContents.executeJavaScript(`(async () => {
      state.backupRecovery.activeRestore = null;
      openBackupVerification();
      const summary = els.backupVerificationSummary.innerText;
      await startBackupVerification(new Event('submit', { cancelable: true }));
      return { summary, payload: window.__verificationPayload, status: els.backupVerificationStatus.innerText };
    })()`);

    const activity = await window.webContents.executeJavaScript(`(async () => {
      closeBackupVerification(); closeBackupRedisRestore();
      setBackupManagerTab('activity');
      await loadBackupActivity();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await openBackupActivityDetail('restore', 'restore-redis');
      return { row: els.backupActivityList.innerText, metrics: els.backupActivityDetailMetrics.textContent };
    })()`);

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mobile = await window.webContents.executeJavaScript(`(() => {
      closeBackupActivityDetail();
      state.backupRecovery.selectedPointId = 'point-redis';
      openBackupRedisRestore();
      const card = els.backupRedisRestoreModal.querySelector('.modal-card').getBoundingClientRect();
      return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const screenshotPath = path.join(captureRoot, 'redis-recovery-mobile.png');
    await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG());
    const mobileSource = await window.webContents.executeJavaScript(`(async () => {
      closeBackupRedisRestore();
      openBackupRedisModal(state.backupRedisConnections[0]);
      await discoverBackupRedis();
      const nodeB = els.backupRedisClusterMappings.querySelector('[data-backup-redis-master="node-b"]');
      nodeB.value = 'connection-redis-b';
      nodeB.dispatchEvent(new Event('change'));
      const card = els.backupRedisModal.querySelector('.modal-card').getBoundingClientRect();
      return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const sourceScreenshotPath = path.join(captureRoot, 'redis-source-mobile.png');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(sourceScreenshotPath, (await window.webContents.capturePage()).toPNG());

    const valid = source.beforeSave.scope.includes('2 masters') && source.beforeSave.evidence.includes('Cluster topology verified') && source.beforeSave.mappingCount === 2 && source.beforeSave.saveEnabled
      && !source.beforeSave.overflow && source.beforeSave.card.left >= 0 && source.beforeSave.card.right <= source.beforeSave.viewport.width && source.beforeSave.card.top >= 0 && source.beforeSave.card.bottom <= source.beforeSave.viewport.height
      && source.payload?.selector?.allDatabases === true && source.payload?.consistency?.method === 'redis-cluster-aof' && source.payload?.consistency?.requestedLevel === 'crash' && source.payload?.consistency?.backupMethod === 'physical'
      && source.payload?.physicalExecution?.masters?.[0]?.connectionId === 'connection-redis-a' && source.payload?.physicalExecution?.masters?.[1]?.connectionId === 'connection-redis-b'
      && job.detail.includes('Redis Cluster 2 masters') && job.detail.includes('AOF recovery set') && job.incrementalDisabled && job.incrementalTitle.includes('independently recoverable') && job.differentialDisabled && job.fullLabel.includes('Native recovery point')
      && recovery.summary.includes('Complete Redis Cluster') && recovery.action.includes('Recover offline cluster') && recovery.payload?.recoveryPointId === 'point-redis' && recovery.payload?.targetDirectory === targetDirectory && recovery.payload?.port === 26381
      && recovery.status.includes('2 masters') && recovery.status.includes('16384 slots') && recovery.status.includes('stopped') && recovery.canceledId === 'restore-redis-cancel'
      && verification.summary.includes('Redis authenticated artifact test') && verification.payload?.mode === 'sample-restore' && verification.payload?.recoveryPointId === 'point-redis' && verification.status.includes('2 files')
      && activity.row.includes('Redis offline cluster recovery') && activity.metrics.includes('Covered slots') && activity.metrics.includes('16384') && activity.metrics.includes('Native validation') && activity.metrics.includes('Passed') && activity.metrics.includes('Service exposed') && activity.metrics.includes('No')
      && !mobile.overflow && mobile.card.left >= 0 && mobile.card.right <= mobile.width && mobile.card.top >= 0 && mobile.card.bottom <= mobile.height
      && !mobileSource.overflow && mobileSource.card.left >= 0 && mobileSource.card.right <= mobileSource.width && mobileSource.card.top >= 0 && mobileSource.card.bottom <= mobileSource.height;
    process.stdout.write(`${JSON.stringify({ ok: valid, source, job, recovery, verification, activity, mobile, mobileSource, screenshots: { recovery: screenshotPath, source: sourceScreenshotPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
