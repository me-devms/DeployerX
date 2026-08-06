const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const readiness = {
  checkedAt: '2026-08-03T12:00:00.000Z',
  sources: [{ id: 'source-1', name: 'Production files', connectionName: 'Production server', rootCount: 2, readiness: { ready: true, message: 'Ready' } }],
  repositories: [{ id: 'repository-1', name: 'Primary archive', adapterId: 'deployerx.repository.local-folder', location: { path: 'D:\\Backups' }, capacity: { freeBytes: 536870912000 }, readiness: { ready: true, message: 'Ready' } }]
};
const readinessEncoded = Buffer.from(JSON.stringify(readiness)).toString('base64');

async function prepare(window) {
  return window.webContents.executeJavaScript(`
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    window.__notificationPayloads = [];
    window.__updatedNotificationPayloads = [];
    window.__deletedNotificationPayloads = [];
    window.__jobPayload = null;
    window.__notificationSequence = 1;
    window.__notificationRoutes = [{
      id: 'route-existing', revision: 1, name: 'Operations desktop', type: 'desktop', enabled: true,
      events: ['backup.failed', 'backup.rpo-overdue'], config: { silent: false }, hasSecret: false,
      deliveryCount: 0, lastDelivery: null, createdAt: '2026-08-03T11:00:00.000Z', updatedAt: '2026-08-03T11:00:00.000Z'
    }];
    window.__notificationDeliveries = [];
    Object.defineProperty(window, 'deployerx', { configurable: true, value: {
      listBackupNotificationRoutes: async () => structuredClone(window.__notificationRoutes),
      listBackupNotificationDeliveries: async () => structuredClone(window.__notificationDeliveries),
      createBackupNotificationRoute: async (payload) => {
        window.__notificationPayloads.push(structuredClone(payload));
        const config = payload.type === 'desktop' ? { silent: payload.silent }
          : payload.type === 'email' ? { host: payload.smtpHost, port: payload.smtpPort, secure: payload.smtpSecure, username: payload.smtpUsername || null, from: payload.from, recipients: payload.to.split(',').map((value) => value.trim()) }
            : { destinationHost: new URL(payload.webhookUrl).host, allowInsecure: payload.allowInsecure };
        const route = { id: 'route-' + window.__notificationSequence++, revision: 1, name: payload.name, type: payload.type, enabled: true, events: payload.events, config, hasSecret: payload.type !== 'desktop', deliveryCount: 0, lastDelivery: null, createdAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-03T12:00:00.000Z' };
        window.__notificationRoutes.push(route);
        return structuredClone(route);
      },
      updateBackupNotificationRoute: async (payload) => {
        window.__updatedNotificationPayloads.push(structuredClone(payload));
        const route = window.__notificationRoutes.find((candidate) => candidate.id === payload.id);
        Object.assign(route, { enabled: payload.enabled, revision: route.revision + 1 });
        return structuredClone(route);
      },
      testBackupNotificationRoute: async (id) => {
        const route = window.__notificationRoutes.find((candidate) => candidate.id === id);
        const delivery = { id: 'delivery-1', routeId: id, routeName: route.name, routeType: route.type, eventType: 'notification.test', eventKey: 'test-1', title: 'DeployerX notification test', status: 'succeeded', attempt: 1, attemptedAt: '2026-08-03T12:01:00.000Z', deliveredAt: '2026-08-03T12:01:00.000Z' };
        window.__notificationDeliveries = [delivery];
        Object.assign(route, { revision: route.revision + 1, deliveryCount: 1, lastDelivery: delivery });
        return structuredClone(delivery);
      },
      deleteBackupNotificationRoute: async (id, revision) => {
        window.__deletedNotificationPayloads.push({ id, revision });
        window.__notificationRoutes = window.__notificationRoutes.filter((route) => route.id !== id);
        return { id, deleted: true };
      },
      getBackupJobReadiness: async () => JSON.parse(atob('${readinessEncoded}')),
      createBackupJob: async (payload) => { window.__jobPayload = structuredClone(payload); return { job: { id: 'job-1' }, policy: {} }; },
      listBackupJobs: async () => [], listBackupRuns: async () => [], getBackupWorkerStatus: async () => null
    }});
    showView('backup');
    setBackupManagerTab('policies');
    true;
  `);
}

async function createRoutes(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const selectEvents = (...events) => els.backupNotificationEvents.forEach((input) => { input.checked = events.includes(input.value); });
    openBackupNotificationRouteModal();
    els.backupNotificationRouteName.value = 'Desktop failures';
    selectEvents('backup.failed');
    await createBackupNotificationRoute(new Event('submit', { cancelable: true }));

    openBackupNotificationRouteModal();
    els.backupNotificationRouteName.value = 'Deployment webhook';
    els.backupNotificationRouteType.value = 'webhook';
    syncBackupNotificationRouteFields();
    const webhookVisible = !els.backupNotificationWebhookFields.classList.contains('hidden') && els.backupNotificationEmailFields.classList.contains('hidden');
    els.backupNotificationWebhookUrl.value = 'https://hooks.example.com/deployerx';
    els.backupNotificationAllowInsecure.checked = false;
    selectEvents('backup.failed', 'backup.rpo-overdue');
    await createBackupNotificationRoute(new Event('submit', { cancelable: true }));

    openBackupNotificationRouteModal();
    els.backupNotificationRouteName.value = 'On-call email';
    els.backupNotificationRouteType.value = 'email';
    syncBackupNotificationRouteFields();
    const emailVisible = !els.backupNotificationEmailFields.classList.contains('hidden') && els.backupNotificationWebhookFields.classList.contains('hidden');
    els.backupNotificationSmtpHost.value = 'smtp.example.com';
    els.backupNotificationSmtpPort.value = '587';
    els.backupNotificationSmtpSecure.checked = false;
    els.backupNotificationSmtpUsername.value = 'backup-bot';
    els.backupNotificationSmtpPassword.value = 'write-only-password';
    els.backupNotificationFrom.value = 'backups@example.com';
    els.backupNotificationTo.value = 'ops@example.com, oncall@example.com';
    selectEvents('backup.warning', 'backup.failed', 'recovery-test.failed');
    await createBackupNotificationRoute(new Event('submit', { cancelable: true }));
    return { webhookVisible, emailVisible, payloads: structuredClone(window.__notificationPayloads) };
  })()`);
}

async function exerciseActionsAndJob(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const toggle = document.querySelector('[data-backup-notification-toggle="route-existing"]');
    toggle.checked = false;
    await toggleBackupNotificationRoute('route-existing', false);
    await testBackupNotificationRoute('route-existing', document.querySelector('[data-backup-notification-test="route-existing"]'));
    confirmDangerousAction = async () => true;
    await deleteBackupNotificationRoute('route-2');
    showView('team');
    setSettingsTab('notifications');
    await loadBackupNotifications();
    const notificationsText = document.getElementById('settingsNotificationsPanel').innerText;

    showView('backup');
    setBackupManagerTab('policies');
    await openBackupJobModal();
    els.backupJobName.value = 'Production protection';
    state.backupJobWizard.sourceId = 'source-1';
    state.backupJobWizard.repositoryIds = ['repository-1'];
    state.backupJobWizard.step = 3;
    renderBackupJobStep();
    els.backupJobRpoMinutes.value = '60';
    els.backupJobRtoMinutes.value = '30';
    const selectedRoute = document.querySelector('[data-backup-job-notification-route][value="route-3"]');
    selectedRoute.checked = true;
    state.backupJobWizard.step = 4;
    renderBackupJobStep();
    const reviewText = els.backupJobReview.innerText;
    await createBackupJob(new Event('submit', { cancelable: true }));
    return {
      notificationsText, reviewText, jobPayload: structuredClone(window.__jobPayload),
      updates: structuredClone(window.__updatedNotificationPayloads), deletes: structuredClone(window.__deletedNotificationPayloads),
      routeCount: window.__notificationRoutes.length, deliveryCount: window.__notificationDeliveries.length
    };
  })()`);
}

async function measure(window, modal = false) {
  const targetId = modal ? 'backupNotificationRouteModal' : 'settingsNotificationsPanel';
  return window.webContents.executeJavaScript(`(() => {
    const target = document.getElementById(${JSON.stringify(targetId)});
    const boundsTarget = ${modal ? 'true' : 'false'} ? target : (target.querySelector('.settings-card') || target);
    const bounds = boundsTarget.getBoundingClientRect();
    const rows = [...target.querySelectorAll('.backup-notification-route-row, .backup-notification-delivery-row')].map((row) => {
      const rect = row.getBoundingClientRect(); return { left: rect.left, right: rect.right };
    });
    const card = ${modal ? 'true' : 'false'} ? target.querySelector('.modal-card').getBoundingClientRect() : null;
    const controls = ${modal ? 'true' : 'false'} ? [...target.querySelectorAll('input, select, button')].filter((control) => control.getBoundingClientRect().width > 0).map((control) => { const rect = control.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }) : [];
    const layout = ${modal ? 'null' : `Object.fromEntries([
      ['appShell', document.querySelector('.app-shell')],
      ['workspace', document.querySelector('.workspace')],
      ['settingsView', document.getElementById('teamView')],
      ['settingsLayout', document.querySelector('#teamView .settings-layout')],
      ['settingsContent', document.querySelector('#teamView .settings-content')],
      ['settingsPanel', target],
      ['settingsBody', target.querySelector('.settings-panel-body')],
      ['settingsCard', target.querySelector('.settings-card')]
    ].map(([name, element]) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [name, { left: rect.left, right: rect.right, width: rect.width, display: style.display, gridTemplateColumns: style.gridTemplateColumns }];
    }))`};
    return { viewport: { width: innerWidth, height: innerHeight }, bounds: { left: bounds.left, right: bounds.right }, rows,
      card: card ? { left: card.left, right: card.right, top: card.top, bottom: card.bottom } : null, controls, layout,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-notifications-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f7f8fb', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`));
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepare(window);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const routes = await createRoutes(window);
    const actions = await exerciseActionsAndJob(window);
    await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.querySelectorAll('.modal').forEach((item) => item.classList.add('hidden'));
      document.getElementById('toast')?.classList.remove('visible');
      showView('team'); setSettingsTab('notifications'); await loadBackupNotifications();
    })()`);
    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const desktop = await measure(window);
    const desktopPath = path.join(captureRoot, 'backup-notifications-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await measure(window);
    const mobilePagePath = path.join(captureRoot, 'backup-notifications-mobile.png');
    await fs.writeFile(mobilePagePath, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`
      document.getElementById('toast')?.classList.remove('visible');
      openBackupNotificationRouteModal();
      els.backupNotificationRouteType.value = 'email';
      syncBackupNotificationRouteFields();
      els.backupNotificationRouteModal.classList.remove('hidden');
    `);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const modal = await measure(window, true);
    const mobileModalPath = path.join(captureRoot, 'backup-notifications-modal-mobile.png');
    await fs.writeFile(mobileModalPath, (await window.webContents.capturePage()).toPNG());

    const [desktopPayload, webhookPayload, emailPayload] = routes.payloads;
    const valid = routes.webhookVisible && routes.emailVisible
      && JSON.stringify(desktopPayload) === JSON.stringify({ name: 'Desktop failures', type: 'desktop', events: ['backup.failed'], silent: false })
      && webhookPayload.name === 'Deployment webhook' && webhookPayload.type === 'webhook' && webhookPayload.webhookUrl === 'https://hooks.example.com/deployerx' && webhookPayload.allowInsecure === false
      && JSON.stringify(webhookPayload.events) === JSON.stringify(['backup.failed', 'backup.rpo-overdue'])
      && emailPayload.type === 'email' && emailPayload.smtpHost === 'smtp.example.com' && emailPayload.smtpPort === 587 && emailPayload.smtpSecure === false
      && emailPayload.smtpUsername === 'backup-bot' && emailPayload.smtpPassword === 'write-only-password' && emailPayload.from === 'backups@example.com' && emailPayload.to === 'ops@example.com, oncall@example.com'
      && JSON.stringify(emailPayload.events) === JSON.stringify(['backup.warning', 'backup.failed', 'recovery-test.failed'])
      && actions.updates[0].id === 'route-existing' && actions.updates[0].revision === 1 && actions.updates[0].enabled === false
      && actions.deletes[0].id === 'route-2' && actions.deliveryCount === 1 && actions.notificationsText.includes('Delivered')
      && actions.reviewText.includes('60 minutes') && actions.reviewText.includes('30 minutes') && actions.reviewText.includes('On-call email')
      && actions.jobPayload.rpoMinutes === 60 && actions.jobPayload.rtoMinutes === 30 && JSON.stringify(actions.jobPayload.notificationRouteIds) === JSON.stringify(['route-3'])
      && [desktop, mobile].every((result) => !result.overflow && result.rows.every((row) => row.left >= result.bounds.left && row.right <= result.bounds.right + 1))
      && !modal.overflow && modal.card.left >= 0 && modal.card.right <= modal.viewport.width && modal.card.top >= 0 && modal.card.bottom <= modal.viewport.height
      && modal.controls.every((control) => control.left >= modal.card.left && control.right <= modal.card.right + 1);
    process.stdout.write(`${JSON.stringify({ ok: valid, routes, actions, desktop, mobile, modal, screenshots: { desktopPath, mobilePagePath, mobileModalPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
