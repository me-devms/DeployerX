const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

async function prepareSources(window) {
  return window.webContents.executeJavaScript(`
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    const loader = document.getElementById('startupLoader');
    loader?.classList.add('hidden');
    loader?.style.setProperty('display', 'none', 'important');
    const appShell = document.querySelector('.app-shell');
    appShell?.classList.remove('hidden');
    appShell?.style.setProperty('display', 'grid', 'important');
    document.getElementById('setupModal')?.classList.add('hidden');
    state.backupLocalConnections = [{
      id: 'conn_local', name: 'This computer (WORKSTATION)', currentDevice: true,
      endpoint: { platform: 'windows', architecture: 'x64', hostname: 'WORKSTATION' },
      lastTest: {
        status: 'success', testedAt: '2026-08-03T12:00:00.000Z', latencyMs: 4,
        checks: [{ id: 'local-read-access', status: 'pass', safeMessage: 'DeployerX can read local source paths.' }],
        supportSummary: 'DeployerX Backup Manager connection diagnostic\\nOutcome: success'
      }
    }];
    state.backupSshConnections = [{
      id: 'conn_ssh', name: 'Production application server',
      endpoint: { username: 'backup', host: 'production.example.com', port: 22 },
      capabilities: { metadata: { permissions: true, ownership: true, timestamps: true, acl: false, extendedAttributes: false, symbolicLinks: true, hardLinks: false, sparseFiles: false } },
      trust: { algorithm: 'ssh-ed25519' },
      lastTest: {
        status: 'failure', testedAt: '2026-08-03T12:00:00.000Z', latencyMs: 20000,
        checks: [{ id: 'host-key', status: 'pass', safeMessage: 'Approved SSH host key matched.' }],
        error: {
          code: 'SSH_CONNECTION_TIMEOUT', category: 'timeout', retryable: true,
          safeMessage: 'The SSH server did not respond before the connection timeout.',
          nextAction: 'Confirm the host, port, firewall, and SSH service, then run the test again.'
        },
        supportSummary: 'DeployerX Backup Manager connection diagnostic\\nError: SSH_CONNECTION_TIMEOUT (timeout)'
      }
    }];
    state.backupMysqlConnections = [{
      id: 'conn_mysql', name: 'Production MySQL', currentDevice: true,
      endpoint: { username: 'backup', host: 'db.example.com', port: 3306, tlsMode: 'verify-identity' },
      lastTest: { status: 'success', testedAt: '2026-08-03T12:00:00.000Z', latencyMs: 18, remotePlatform: { engine: 'mysql', version: '8.0.36' }, checks: [{ id: 'server-identity', status: 'pass', safeMessage: 'MySQL server identity was captured.' }] }
    }];
    showView('backup');
    setBackupManagerTab('sources');
    renderBackupConnections();
    els.toast?.classList.remove('visible');
    true;
  `);
}

async function measure(window) {
  return window.webContents.executeJavaScript(`(async () => {
    if (document.getElementById('backupSourceAddButton').getAttribute('aria-expanded') !== 'true') {
      openBackupSourceAddMenu();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const panel = document.getElementById('backupPanelSources').getBoundingClientRect();
    const heading = document.querySelector('#backupPanelSources .backup-panel-heading').getBoundingClientRect();
    const trigger = document.getElementById('backupSourceAddButton').getBoundingClientRect();
    const menu = document.getElementById('backupSourceAddMenu').getBoundingClientRect();
    const menuOptions = [...document.querySelectorAll('#backupSourceAddMenu [role="menuitem"]')].filter((option) => option.getClientRects().length > 0).map((option) => {
      const rect = option.getBoundingClientRect();
      return { text: option.innerText.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, disabled: option.disabled };
    });
    const brandLogos = [...document.querySelectorAll('#backupSourceAddMenu .backup-source-brand-logo, #backupSourceAddMenu .backup-source-brand-pair img')];
    const visibleDatabaseOptions = [...document.querySelectorAll('#backupSourceAddMenu [data-backup-database-adapter-id]')].filter((option) => option.getClientRects().length > 0);
    const rows = [...document.querySelectorAll('.backup-source-row')].map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    const visibleBodyText = document.body.innerText.toLowerCase();
    const visibleText = visibleBodyText.includes('production application server') && visibleBodyText.includes('needs attention') && visibleBodyText.includes('production mysql');
    return {
      viewport: { width: innerWidth, height: innerHeight }, panel: { left: panel.left, right: panel.right },
      heading: { left: heading.left, right: heading.right, height: heading.height },
      trigger: { left: trigger.left, right: trigger.right, top: trigger.top, bottom: trigger.bottom },
      menu: { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom },
      menuOpen: document.getElementById('backupSourceAddButton').getAttribute('aria-expanded') === 'true' && !document.getElementById('backupSourceAddMenu').classList.contains('hidden'),
      menuOptions,
      brandLogoCount: brandLogos.length,
      brandLogosLoaded: brandLogos.every((logo) => logo.complete && logo.naturalWidth > 0),
      visibleDatabaseOptionsBranded: visibleDatabaseOptions.every((option) => option.querySelector('img') && !option.querySelector('svg')),
      rows, visibleText,
      toastVisible: els.toast?.classList.contains('visible') ?? false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
}

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-backup-sources-ui-'));
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    backgroundColor: '#f7f8fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prepareSources(window);
    window.setSize(1279, 800);
    window.setSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const desktop = await measure(window);
    const desktopPath = path.join(captureRoot, 'sources-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    const jobPicker = await window.webContents.executeJavaScript(`(async () => {
      closeBackupSourceAddMenu();
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      state.backupJobWizard = { ...blankBackupJobWizard(), draftActive: true };
      document.getElementById('backupJobSourcesEmpty').classList.remove('hidden');
      document.getElementById('backupJobModal').classList.remove('hidden');
      document.getElementById('backupJobAddSourceButton').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const card = document.querySelector('#backupJobModal .modal-card').getBoundingClientRect();
      const menu = document.getElementById('backupSourceAddMenu').getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        menu: { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom },
        menuOpen: !document.getElementById('backupSourceAddMenu').classList.contains('hidden'),
        menuInsideJob: document.getElementById('backupSourceAddMenu').parentElement === document.getElementById('backupJobSourcePickerBody'),
        triggerExpanded: document.getElementById('backupJobAddSourceButton').getAttribute('aria-expanded') === 'true',
        localSourceAvailable: !document.getElementById('backupAddLocalConnectionButton').disabled,
        oldActionsRemoved: !document.getElementById('backupJobCreateFileSourceButton') && !document.getElementById('backupJobCreateOtherSourceButton'),
        titleCase: {
          modal: document.getElementById('backupJobModalTitle').textContent.trim(),
          name: document.querySelector('[data-backup-job-step="0"] h3').textContent.trim(),
          source: document.querySelectorAll('[data-backup-job-step="0"] h3')[1].textContent.trim(),
          destination: document.querySelectorAll('[data-backup-job-step="0"] h3')[2].textContent.trim(),
          addSource: document.getElementById('backupJobAddSourceButton').textContent.trim(),
          picker: document.getElementById('backupJobSourcePickerTitle').textContent.trim()
        }
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const jobPickerPath = path.join(captureRoot, 'backup-job-source-picker.png');
    await fs.writeFile(jobPickerPath, (await window.webContents.capturePage()).toPNG());
    const jobPickerAction = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('backupAddMysqlConnectionButton').click();
      const result = {
        menuClosed: document.getElementById('backupSourceAddMenu').classList.contains('hidden'),
        jobSuspended: document.getElementById('backupJobModal').classList.contains('hidden'),
        dependency: state.backupJobWizard.dependency,
        mysqlModalOpen: !document.getElementById('backupMysqlModal').classList.contains('hidden')
      };
      document.getElementById('backupMysqlModal').classList.add('hidden');
      const refreshedReadiness = {
        sources: [{ id: 'source_new', name: 'New Source', sourceType: 'database', connectionName: 'Production MySQL', adapterId: 'deployerx.database.mysql.native', selection: { allDatabases: true }, readiness: { ready: true, message: 'Ready' } }],
        repositories: []
      };
      selectNewBackupJobSource(refreshedReadiness);
      state.backupJobWizard.readiness = refreshedReadiness;
      renderBackupJobChoices();
      result.newSourceSelected = state.backupJobWizard.sourceId === 'source_new'
        && document.querySelector('[data-backup-job-source]')?.dataset.backupJobSource === 'source_new'
        && !document.querySelector('#backupJobSources input[type="radio"]');
      const blockedSource = { id: 'source_blocked', name: 'Blocked Source', sourceType: 'file', connectionName: 'Offline server', rootCount: 1, readiness: { ready: false, message: 'Unavailable' } };
      const defaultSource = { id: 'source_default', name: 'Default Source', sourceType: 'file', connectionName: 'Ready server', rootCount: 1, readiness: { ready: true, message: 'Ready' } };
      state.backupJobWizard = { ...blankBackupJobWizard(), draftActive: true, readiness: { sources: [blockedSource, defaultSource], repositories: [] } };
      renderBackupJobChoices();
      result.defaultSourceSelected = state.backupJobWizard.sourceId === defaultSource.id
        && document.querySelectorAll('#backupJobSources [data-backup-job-source]').length === 1
        && document.querySelector('[data-backup-job-source]')?.dataset.backupJobSource === defaultSource.id
        && !document.querySelector('#backupJobSources input[type="radio"]');
      const oldRepository = { id: 'repository_old', name: 'Original Destination', adapterId: 'deployerx.repository.local-folder', location: { path: 'D:\\Backups' }, readiness: { ready: true, message: 'Ready' } };
      const newRepository = { id: 'repository_new', name: 'New Destination', adapterId: 'deployerx.repository.s3', location: { bucket: 'new-backups', prefix: '' }, readiness: { ready: true, message: 'Ready' } };
      state.backupJobWizard.readiness.repositories = [oldRepository];
      selectDefaultBackupJobRepository();
      renderBackupJobChoices();
      result.defaultDestinationSelected = state.backupJobWizard.repositoryIds.length === 1
        && state.backupJobWizard.repositoryIds[0] === oldRepository.id
        && document.querySelector('[data-backup-job-repository]')?.checked;
      state.backupJobWizard.repositoryIdsBeforeDependency = [oldRepository.id];
      selectNewBackupJobRepository({ sources: [], repositories: [oldRepository, newRepository] });
      result.newDestinationSelected = state.backupJobWizard.repositoryIds.includes(oldRepository.id)
        && state.backupJobWizard.repositoryIds.includes(newRepository.id);
      const oldSource = { id: 'source_old', name: 'Original Source', sourceType: 'file', connectionName: 'This computer', rootCount: 1, readiness: { ready: true, message: 'Ready' } };
      const savedSource = { id: 'source_saved', name: 'Saved Source', sourceType: 'file', connectionName: 'Saved server', rootCount: 2, readiness: { ready: true, message: 'Ready' } };
      state.backupJobWizard = { ...blankBackupJobWizard(), draftActive: true, sourceId: oldSource.id, readiness: { sources: [oldSource, savedSource], repositories: [] } };
      renderBackupJobChoices();
      document.getElementById('backupJobModal').classList.remove('hidden');
      const replaceButton = document.getElementById('backupJobReplaceSourceButton');
      const replaceBounds = replaceButton.getBoundingClientRect();
      const sourceSectionBounds = replaceButton.closest('.backup-job-resource-section').getBoundingClientRect();
      result.replaceActionVisible = !replaceButton.classList.contains('hidden');
      result.replaceActionFits = replaceBounds.left >= sourceSectionBounds.left && replaceBounds.right <= sourceSectionBounds.right;
      const originalDeployerx = window.deployerx;
      Object.defineProperty(window, 'deployerx', { configurable: true, value: { ...originalDeployerx, getBackupJobReadiness: async () => ({ sources: [oldSource, savedSource], repositories: [] }) } });
      await openBackupJobSourceTypes({ trigger: replaceButton, replacing: true });
      result.replacePickerOpen = !document.getElementById('backupJobSourcePicker').classList.contains('hidden')
        && document.getElementById('backupJobSourcePickerTitle').textContent.trim() === 'Replace Backup Source';
      result.savedSourcesVisible = document.querySelectorAll('[data-backup-job-saved-source]').length === 2;
      document.querySelector('[data-backup-job-saved-source="source_saved"]').click();
      result.savedSourceSelected = state.backupJobWizard.sourceId === savedSource.id
        && document.getElementById('backupJobSourcePicker').classList.contains('hidden')
        && document.querySelector('[data-backup-job-source]')?.dataset.backupJobSource === savedSource.id;
      await openBackupJobSourceTypes({ trigger: replaceButton, replacing: true });
      document.getElementById('backupAddMysqlConnectionButton').click();
      document.getElementById('backupMysqlModal').classList.add('hidden');
      const replacement = { id: 'source_replacement', name: 'Replacement Source', sourceType: 'database', connectionName: 'Replacement MySQL', adapterId: 'deployerx.database.mysql.native', selection: { allDatabases: true }, readiness: { ready: true, message: 'Ready' } };
      const replacementReadiness = { sources: [oldSource, savedSource, replacement], repositories: [] };
      selectNewBackupJobSource(replacementReadiness);
      state.backupJobWizard.readiness = replacementReadiness;
      renderBackupJobChoices();
      result.replacementSelected = state.backupJobWizard.sourceId === replacement.id
        && document.querySelector('[data-backup-job-source]')?.dataset.backupJobSource === replacement.id;
      Object.defineProperty(window, 'deployerx', { configurable: true, value: originalDeployerx });
      state.backupJobWizard = blankBackupJobWizard();
      return result;
    })()`);

    window.setSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await measure(window);
    const mobilePath = path.join(captureRoot, 'sources-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    const addSourceAction = await window.webContents.executeJavaScript(`(() => {
      document.getElementById('backupAddSshConnectionButton').click();
      const result = {
        menuClosed: document.getElementById('backupSourceAddMenu').classList.contains('hidden'),
        triggerCollapsed: document.getElementById('backupSourceAddButton').getAttribute('aria-expanded') === 'false',
        sshModalOpen: !document.getElementById('backupSshModal').classList.contains('hidden')
      };
      closeBackupSshModal();
      return result;
    })()`);

    const diagnostics = await window.webContents.executeJavaScript(`(() => {
      openBackupDiagnostics(allBackupConnections().find((connection) => connection.id === 'conn_ssh'));
      const card = document.querySelector('#backupDiagnosticsModal .modal-card').getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        hasGuidance: document.getElementById('backupDiagnosticsNextAction').innerText.includes('firewall'),
        hasCode: document.getElementById('backupDiagnosticsCode').innerText === 'SSH_CONNECTION_TIMEOUT',
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const diagnosticsPath = path.join(captureRoot, 'diagnostics-modal-mobile.png');
    await fs.writeFile(diagnosticsPath, (await window.webContents.capturePage()).toPNG());

    const browser = await window.webContents.executeJavaScript(`(() => {
      closeBackupDiagnostics();
      state.backupBrowser = {
        connection: allBackupConnections().find((connection) => connection.id === 'conn_ssh'),
        path: '/srv/data', parentPath: '/srv', nextCursor: 'opaque-cursor', hasMore: true, loading: false,
        sourceProfiles: [{
          id: 'src_files', revision: 2, name: 'Production data',
          selector: {
            roots: [{ path: '/srv/data/configs', type: 'directory' }],
            includePatterns: ['**/*.conf'], excludePatterns: ['**/*.tmp'],
            options: { includeHidden: false, crossMounts: false },
            metadataPolicy: { preserve: { permissions: true, ownership: true, timestamps: true, acl: false, extendedAttributes: false, symbolicLinks: true, hardLinks: false, sparseFiles: false }, reductions: [] }
          }
        }],
        editingSourceId: 'src_files', editingSourceRevision: 2, sourceName: 'Production data',
        selectedRoots: [{ path: '/srv/data/configs', type: 'directory' }],
        includePatternsText: '**/*.conf', excludePatternsText: '**/*.tmp', includeHidden: false, crossMounts: false,
        items: [
          { id: 'entry_folder', name: 'configs', path: '/srv/data/configs', type: 'directory', size: null, modifiedAt: '2026-08-03T12:00:00.000Z', accessible: true },
          { id: 'entry_file', name: 'database-backup.sql', path: '/srv/data/database-backup.sql', type: 'file', size: 2048, modifiedAt: '2026-08-03T12:00:00.000Z', accessible: true },
          { id: 'entry_hidden', name: '.secret', path: '/srv/data/.secret', type: 'file', size: 12, modifiedAt: '2026-08-03T12:00:00.000Z', hidden: true, accessible: true }
        ]
      };
      els.backupBrowserModal.classList.remove('hidden');
      renderBackupBrowser();
      const card = document.querySelector('#backupBrowserModal .modal-card').getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        rowCount: document.querySelectorAll('.backup-browser-entry').length,
        hasPath: document.getElementById('backupBrowserPath').value === '/srv/data',
        hasPagination: !document.getElementById('backupBrowserLoadMoreButton').classList.contains('hidden'),
        hasSelection: document.querySelectorAll('.backup-browser-entry-select:checked').length === 1,
        hasProfile: document.getElementById('backupBrowserSourceProfile').value === 'src_files',
        hasPatterns: document.getElementById('backupBrowserIncludePatterns').value === '**/*.conf',
        metadataFieldRemoved: !document.getElementById('backupBrowserMetadataPolicy'),
        hiddenFiltered: !document.body.innerText.includes('.secret'),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browserPath = path.join(captureRoot, 'source-browser-mobile.png');
    await fs.writeFile(browserPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`
      closeBackupBrowser();
      openBackupSshModal();
      els.backupSshHost.value = 'production.example.com';
      state.backupSshScan = { status: 'success', fingerprint: 'SHA256:0123456789012345678901234567890123456789012', algorithm: 'ssh-ed25519' };
      els.backupSshFingerprint.value = state.backupSshScan.fingerprint;
      els.backupSshHostKeyAlgorithm.textContent = state.backupSshScan.algorithm;
      els.backupSshTrustPanel.classList.remove('hidden');
      els.backupSshApproveFingerprint.checked = true;
      approveBackupSshFingerprint();
      true;
    `);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const modalPath = path.join(captureRoot, 'ssh-modal-mobile.png');
    await fs.writeFile(modalPath, (await window.webContents.capturePage()).toPNG());
    const mysql = await window.webContents.executeJavaScript(`(() => {
      closeBackupSshModal();
      openBackupMysqlModal(allBackupConnections().find((connection) => connection.id === 'conn_mysql'));
      state.backupMysqlDatabases = [{ name: 'analytics' }, { name: 'orders' }];
      renderBackupMysqlDatabases();
      const card = document.querySelector('#backupMysqlModal .modal-card').getBoundingClientRect();
      return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, databaseCount: document.querySelectorAll('[data-backup-mysql-database]').length, connectionFieldsHidden: document.getElementById('backupMysqlConnectionFields').classList.contains('hidden'), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mysqlPath = path.join(captureRoot, 'mysql-modal-mobile.png');
    await fs.writeFile(mysqlPath, (await window.webContents.capturePage()).toPNG());
    const expectedSourceOptions = ['This computer', 'Linux server', 'MySQL', 'MariaDB', 'PostgreSQL / Supabase', 'MongoDB', 'ClickHouse', 'Redis', 'SQLite'];
    const valid = [desktop, mobile].every((result) => result.visibleText && result.menuOpen && !result.toastVisible && !result.horizontalOverflow
      && result.menu.left >= 0 && result.menu.right <= result.viewport.width + 1 && result.menu.bottom <= result.viewport.height + 1
      && result.trigger.left >= result.panel.left && result.trigger.right <= result.panel.right + 1
      && JSON.stringify(result.menuOptions.map((option) => option.text)) === JSON.stringify(expectedSourceOptions)
      && result.brandLogoCount === 8 && result.brandLogosLoaded && result.visibleDatabaseOptionsBranded
      && result.menuOptions.every((option) => option.left >= result.menu.left && option.right <= result.menu.right + 1)
      && result.rows.length === 3 && result.rows.every((row) => row.left >= result.panel.left && row.right <= result.panel.right + 1 && row.height >= 60))
      && jobPicker.menuOpen && jobPicker.menuInsideJob && jobPicker.triggerExpanded && jobPicker.localSourceAvailable && jobPicker.oldActionsRemoved
      && jobPicker.menu.left >= jobPicker.card.left && jobPicker.menu.right <= jobPicker.card.right + 1
      && jobPicker.menu.top >= jobPicker.card.top && jobPicker.menu.bottom <= jobPicker.card.bottom + 1
      && JSON.stringify(jobPicker.titleCase) === JSON.stringify({ modal: 'Create Job Backup', name: 'Name This Protection Job', source: 'Choose One Source', destination: 'Choose The Backup Destination', addSource: 'Add Source', picker: 'Add Backup Source' })
      && jobPickerAction.menuClosed && jobPickerAction.jobSuspended && jobPickerAction.dependency === 'source-creator' && jobPickerAction.mysqlModalOpen && jobPickerAction.newSourceSelected && jobPickerAction.defaultSourceSelected && jobPickerAction.defaultDestinationSelected && jobPickerAction.newDestinationSelected
      && jobPickerAction.replaceActionVisible && jobPickerAction.replaceActionFits && jobPickerAction.replacePickerOpen && jobPickerAction.savedSourcesVisible && jobPickerAction.savedSourceSelected && jobPickerAction.replacementSelected
      && addSourceAction.menuClosed && addSourceAction.triggerCollapsed && addSourceAction.sshModalOpen
      && diagnostics.hasGuidance && diagnostics.hasCode && !diagnostics.horizontalOverflow
      && diagnostics.card.left >= 0 && diagnostics.card.right <= mobile.viewport.width
      && browser.rowCount === 2 && browser.hasPath && browser.hasPagination && browser.hasSelection && browser.hasProfile && browser.hasPatterns && browser.metadataFieldRemoved && browser.hiddenFiltered && !browser.horizontalOverflow
      && browser.card.left >= 0 && browser.card.right <= mobile.viewport.width
      && mysql.databaseCount === 2 && mysql.connectionFieldsHidden && !mysql.horizontalOverflow && mysql.card.left >= 0 && mysql.card.right <= mobile.viewport.width;
    process.stdout.write(`${JSON.stringify({ ok: valid, desktop, mobile, jobPicker, jobPickerAction, addSourceAction, diagnostics, browser, mysql, screenshots: { desktopPath, mobilePath, jobPickerPath, diagnosticsPath, browserPath, modalPath, mysqlPath } })}\n`);
    if (!valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
