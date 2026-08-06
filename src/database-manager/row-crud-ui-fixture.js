const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

async function waitFor(window, expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

app.whenReady().then(async () => {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('Database row CRUD fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f6f7fb' });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(`
      document.getElementById('startupLoader')?.classList.add('hidden');
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      window.__rowMutations = [];
      window.__rowQueries = [];
      window.__rowProfile = {
        id: 'profile-postgresql', revision: 1, name: 'Production PostgreSQL', driverId: 'postgresql',
        endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, database: 'orders', defaultSchema: 'public',
        environment: 'production', accessMode: 'read-write', ssl: { mode: 'required' }, tunnel: { type: 'none' },
        settings: { username: 'app_user' }, credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-password' }]
      };
      window.__rowSnapshot = {
        schemas: [{ name: 'public', tables: [{ name: 'orders', type: 'table', columns: [
          { name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true, defaultValue: 'identity' },
          { name: 'customer', dataType: 'TEXT', nullable: false, primaryKey: false, defaultValue: null },
          { name: 'total_cents', dataType: 'INTEGER', nullable: false, primaryKey: false, defaultValue: '0' },
          { name: 'metadata', dataType: 'JSONB', nullable: true, primaryKey: false, defaultValue: null },
          { name: 'payload', dataType: 'BYTEA', nullable: true, primaryKey: false, defaultValue: null }
        ] }] }], truncated: false
      };
      const queryResult = () => ({
        requestId: 'query-result', profileId: window.__rowProfile.id, classification: 'read',
        result: {
          columns: [
            { name: 'id', dataType: 'BIGINT' }, { name: 'customer', dataType: 'TEXT' },
            { name: 'total_cents', dataType: 'INTEGER' }, { name: 'metadata', dataType: 'JSONB' },
            { name: 'payload', dataType: 'BYTEA' }
          ],
          rows: [
            [101, 'Ada', 4200, { plan: 'priority' }, { type: 'binary', byteLength: 8 }],
            [102, 'Lin', 2600, { plan: 'standard' }, { type: 'binary', byteLength: 4 }]
          ],
          affectedRows: 0, truncated: false, executionTimeMs: 7, warnings: [], additionalResults: [],
          pagination: { page: 1, pageSize: 100, hasMore: false }
        }
      });
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listDatabaseProfiles: async () => [structuredClone(window.__rowProfile)],
        loadDatabaseSchema: async () => ({ requestId: 'schema-result', profileId: window.__rowProfile.id, driverId: 'postgresql', snapshot: structuredClone(window.__rowSnapshot) }),
        executeDatabaseQuery: async (payload) => { window.__rowQueries.push(structuredClone(payload)); return queryResult(); },
        mutateDatabaseRows: async (payload) => {
          if (payload.action === 'update' && payload.approval?.confirmed !== true) {
            const error = new Error('Confirm this database change before running it.');
            error.code = 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED';
            error.details = { classification: 'mutation', typedConfirmationRequired: false };
            throw error;
          }
          window.__rowMutations.push(structuredClone(payload));
          return { action: payload.action, schema: payload.schema, table: payload.table, affectedRows: payload.action === 'delete' ? payload.keys.length : 1 };
        },
        listDatabaseSavedQueries: async () => [], listDatabaseQueryHistory: async () => [],
        saveDatabaseQueryWorkspace: async () => true, writeClipboard: async () => true
      }});
      state.setup.mode = 'local';
      state.databaseManager.profiles = [window.__rowProfile];
      state.databaseManager.loading = false;
      state.databaseManager.error = '';
      showView('database');
      state.databaseManager.profiles = [window.__rowProfile];
      setDatabaseManagerTab('query');
      syncDatabaseQueryProfiles(window.__rowProfile.id);
      true;
    `);
    await window.webContents.executeJavaScript(`(async () => {
      await loadDatabaseSchema({ force: true });
      await browseDatabaseTable('public', 'orders');
      updateDatabaseQueryResultSelection({ rowIndex: 1, event: {} });
      openDatabaseRowEditor('update');
    })()`);
    await waitFor(window, `!els.databaseRowEditorModal.classList.contains('hidden')`);

    await window.webContents.executeJavaScript(`(() => {
      els.startupLoader.classList.add('hidden');
      els.setupModal.classList.add('hidden');
      els.appShell.classList.remove('hidden');
      els.appShell.style.setProperty('display', 'grid', 'important');
      els.databaseManagerView.classList.remove('hidden');
      els.toast.classList.remove('visible');
    })()`);
    window.setContentSize(1279, 800);
    window.setContentSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await window.webContents.executeJavaScript(`(() => {
      els.startupLoader.classList.add('hidden');
      els.appShell.classList.remove('hidden');
      els.appShell.style.setProperty('display', 'grid', 'important');
      els.databaseManagerView.classList.remove('hidden');
      els.toast.classList.remove('visible');
    })()`);

    const desktop = await window.webContents.executeJavaScript(`(() => ({
      context: structuredClone(state.databaseManager.query.tableContext),
      editorTitle: els.databaseRowEditorTitle.textContent,
      binaryDisabled: els.databaseRowEditorFields.querySelector('[data-database-row-column="payload"] [data-database-row-value]').disabled,
      primaryKeyDisabled: els.databaseRowEditorFields.querySelector('[data-database-row-column="id"] [data-database-row-value]').disabled,
      insertDisabled: els.databaseRowInsertButton.disabled,
      editDisabled: els.databaseRowEditButton.disabled,
      query: databaseQueryEditorValue(),
      startupHidden: els.startupLoader.classList.contains('hidden'),
      editorVisible: els.databaseRowEditorModal.getBoundingClientRect().width > 0
    }))()`);
    const desktopPath = path.join(outputDirectory, 'database-manager-row-editor-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    window.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await window.webContents.executeJavaScript(`(() => {
      els.startupLoader.classList.add('hidden');
      els.setupModal.classList.add('hidden');
      els.appShell.classList.remove('hidden');
      els.appShell.style.setProperty('display', 'grid', 'important');
      els.databaseManagerView.classList.remove('hidden');
      els.toast.classList.remove('visible');
    })()`);
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const card = els.databaseRowEditorModal.querySelector('.modal-card').getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    })()`);
    const mobilePath = path.join(outputDirectory, 'database-manager-row-editor-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`(() => {
      const customer = els.databaseRowEditorFields.querySelector('[data-database-row-column="customer"] [data-database-row-value]');
      customer.value = 'Lin Updated';
      els.databaseRowEditorForm.requestSubmit();
    })()`);
    await waitFor(window, `!els.databaseQueryApprovalModal.classList.contains('hidden')`);
    const updateApproval = await window.webContents.executeJavaScript(`({ title: els.databaseQueryApprovalTitle.textContent, runLabel: els.databaseQueryApprovalRunLabel.textContent, summary: els.databaseQueryApprovalSql.textContent })`);
    await window.webContents.executeJavaScript(`els.databaseQueryApprovalForm.requestSubmit()`);
    await waitFor(window, `window.__rowMutations.length === 1 && els.databaseRowEditorModal.classList.contains('hidden')`);

    await window.webContents.executeJavaScript(`(() => {
      state.databaseManager.query.resultSelection = { selectedRows: [0, 1], cell: null };
      databaseQueryResultGrid.setSelection(state.databaseManager.query.resultSelection);
      updateDatabaseQueryControls();
      window.__deleteRowsPromise = deleteSelectedDatabaseRows();
    })()`);
    await waitFor(window, `!els.databaseQueryApprovalModal.classList.contains('hidden')`);
    const deleteApproval = await window.webContents.executeJavaScript(`({ title: els.databaseQueryApprovalTitle.textContent, runLabel: els.databaseQueryApprovalRunLabel.textContent, summary: els.databaseQueryApprovalSql.textContent })`);
    await window.webContents.executeJavaScript(`els.databaseQueryApprovalForm.requestSubmit()`);
    await waitFor(window, `window.__rowMutations.length === 2`);

    const finalState = await window.webContents.executeJavaScript(`(() => {
      const activeProfile = selectedDatabaseQueryProfile();
      activeProfile.accessMode = 'read-only';
      updateDatabaseQueryControls();
      const readOnly = { disabled: els.databaseRowInsertButton.disabled, reason: els.databaseRowInsertButton.title };
      activeProfile.accessMode = 'read-write';
      state.databaseManager.query.tableContext = { ...state.databaseManager.query.tableContext, primaryKeyColumns: [] };
      updateDatabaseQueryControls();
      const noPrimaryKey = { disabled: els.databaseRowDeleteButton.disabled, reason: els.databaseRowDeleteButton.title };
      return {
        mutations: structuredClone(window.__rowMutations),
        queryCount: window.__rowQueries.length,
        readOnly,
        noPrimaryKey
      };
    })()`);
    process.stdout.write(`${JSON.stringify({ desktop, mobile, updateApproval, deleteApproval, finalState, desktopPath, mobilePath })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
