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

async function reveal(window) {
  await window.webContents.executeJavaScript(`(() => {
    els.startupLoader.classList.add('hidden'); els.setupModal.classList.add('hidden');
    els.appShell.classList.remove('hidden'); els.appShell.style.setProperty('display', 'grid', 'important');
    els.databaseManagerView.classList.remove('hidden');
    els.toast.style.setProperty('transition', 'none', 'important');
    els.toast.style.setProperty('opacity', '0', 'important');
    els.toast.classList.remove('visible');
  })()`);
}

app.whenReady().then(async () => {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('Notebook UI fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f6f7fb' });
  let phase = 'load';
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    phase = 'initialize';
    await window.webContents.executeJavaScript(`
      els.startupLoader.classList.add('hidden'); els.setupModal.classList.add('hidden');
      els.appShell.classList.remove('hidden'); els.appShell.style.setProperty('display', 'grid', 'important');
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      window.__notebookRecords = [];
      window.__notebookWrites = [];
      window.__notebookQueries = [];
      window.__notebookCancels = [];
      window.__databaseTaskCancels = [];
      window.__notebookProfile = {
        id: 'profile-postgresql', name: 'Production PostgreSQL', driverId: 'postgresql', environment: 'production', accessMode: 'read-write',
        endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, database: 'orders', defaultSchema: 'public'
      };
      window.__databaseTasks = [{ id: 'dbtask-import', profileId: 'profile-postgresql', type: 'import', label: 'Import customer archive', state: 'running', canCancel: true, revision: 2, createdAt: '2026-08-05T16:00:00.000Z', updatedAt: '2026-08-05T16:00:05.000Z', progress: { phase: 'loading', percent: 45, itemsTotal: 100, itemsCompleted: 45, bytesTotal: 4096, bytesCompleted: 2048, message: 'Loading customer rows' } }, { id: 'dbtask-dump', profileId: 'profile-postgresql', type: 'dump', label: 'Nightly schema dump', state: 'succeeded', canCancel: false, revision: 3, createdAt: '2026-08-05T15:00:00.000Z', updatedAt: '2026-08-05T15:00:08.000Z', progress: { phase: 'complete', percent: 100, itemsTotal: 12, itemsCompleted: 12, bytesTotal: 8192, bytesCompleted: 8192, message: 'Dump complete' } }];
      const clone = (value) => structuredClone(value);
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listDatabaseProfiles: async () => [clone(window.__notebookProfile)],
        listDatabaseNotebooks: async ({ profileId }) => clone(window.__notebookRecords.filter((item) => item.profileId === profileId)),
        getDatabaseNotebook: async (id) => clone(window.__notebookRecords.find((item) => item.id === id) || null),
        createDatabaseNotebook: async (payload) => {
          window.__notebookWrites.push(clone(payload));
          const record = { ...clone(payload), id: 'notebook-1', revision: 1, createdAt: '2026-08-05T16:00:00.000Z', updatedAt: '2026-08-05T16:00:00.000Z' };
          window.__notebookRecords.push(record); return clone(record);
        },
        updateDatabaseNotebook: async (id, revision, payload) => {
          window.__notebookWrites.push(clone(payload));
          const index = window.__notebookRecords.findIndex((item) => item.id === id);
          window.__notebookRecords[index] = { ...window.__notebookRecords[index], ...clone(payload), revision: revision + 1 };
          return clone(window.__notebookRecords[index]);
        },
        deleteDatabaseNotebook: async () => true,
        listDatabaseTasks: async ({ profileId, state } = {}) => clone(window.__databaseTasks.filter((task) => (!profileId || task.profileId === profileId) && (!state || task.state === state))),
        cancelDatabaseTask: async (id) => {
          window.__databaseTaskCancels.push(id);
          const task = window.__databaseTasks.find((item) => item.id === id);
          Object.assign(task, { state: 'canceled', canCancel: false, safeMessage: 'Canceled by user.', revision: task.revision + 1, updatedAt: '2026-08-05T16:00:06.000Z' });
          return clone(task);
        },
        executeDatabaseQuery: async (payload) => {
          window.__notebookQueries.push(clone(payload));
          if (payload.query === 'SELECT WAIT') {
            return new Promise((_resolve, reject) => { window.__notebookPendingReject = reject; });
          }
          if (payload.approval?.confirmed !== true) {
            const error = new Error('Confirm this database change before running it.');
            error.code = 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED';
            error.details = { classification: 'mutation', typedConfirmationRequired: false };
            throw error;
          }
          return { result: { columns: [{ name: 'id', dataType: 'BIGINT' }, { name: 'status', dataType: 'TEXT' }], rows: [[101, 'paid'], [102, 'processing']], affectedRows: 0, executionTimeMs: 9, warnings: [], additionalResults: [], pagination: { page: 1, pageSize: 100, hasMore: false } } };
        },
        cancelDatabaseQuery: async (requestId) => {
          window.__notebookCancels.push(requestId);
          const error = new Error('Cancelled'); error.code = 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED';
          window.__notebookPendingReject?.(error); return { requestId, cancelled: true };
        },
        saveDatabaseQueryWorkspace: async () => true
      }});
      state.setup.mode = 'local'; state.databaseManager.profiles = [window.__notebookProfile];
      showView('database'); state.databaseManager.profiles = [window.__notebookProfile];
      setDatabaseManagerTab('notebooks');
      true;
    `);
    await waitFor(window, `state.databaseManager.activeTab === 'notebooks' && state.databaseManager.notebooks.cells.length === 1`);
    phase = 'compose';
    await window.webContents.executeJavaScript(`(() => {
      els.databaseNotebookName.value = 'Daily operations'; els.databaseNotebookName.dispatchEvent(new Event('input', { bubbles: true }));
      els.databaseNotebookDescription.value = 'Production review'; els.databaseNotebookDescription.dispatchEvent(new Event('input', { bubbles: true }));
      els.databaseNotebookTags.value = 'Ops, Daily'; els.databaseNotebookTags.dispatchEvent(new Event('input', { bubbles: true }));
      state.databaseManager.notebooks.cells[0].content = 'SELECT 1;\\nUPDATE orders SET reviewed = TRUE WHERE id = 101';
      const sourceCell = state.databaseManager.notebooks.cells[0];
      state.databaseManager.notebooks.cells.push(databaseNotebookCell('chart', '', { sourceCellId: sourceCell.id, chartType: 'line', categoryColumn: 'status', valueColumn: 'id' }));
      state.databaseManager.notebooks.cells.push(databaseNotebookCell('markdown', '# Review notes\\n\\n**Owner:** Operations\\n\\n| Queue | Count |\\n| --- | ---: |\\n| Paid | 1 |\\n| Processing | 1 |\\n\\n    SELECT status\\n\\n<script>window.__markdownExecuted = true</script>'));
      renderDatabaseNotebook();
    })()`);
    phase = 'save';
    await window.webContents.executeJavaScript(`saveDatabaseNotebook()`);
    await waitFor(window, `window.__notebookWrites.length === 1 && state.databaseManager.notebooks.activeId === 'notebook-1'`);
    await waitFor(window, `databaseNotebookMonacoEditors.size === 1`);
    phase = 'collapse';
    await window.webContents.executeJavaScript(`(() => {
      const chart = document.querySelector('[data-database-notebook-collapse]');
      chart?.click();
      return true;
    })()`);
    await waitFor(window, `document.querySelector('.database-notebook-cell.collapsed') !== null`);
    await window.webContents.executeJavaScript(`document.querySelector('.database-notebook-cell.collapsed [data-database-notebook-collapse]')?.click()`);
    await waitFor(window, `document.querySelector('.database-notebook-cell.collapsed') === null`);
    await waitFor(window, `databaseNotebookMonacoEditors.size === 1`);
    await window.webContents.executeJavaScript(`state.databaseManager.notebooks.dirty = false`);
    phase = 'execute';
    await window.webContents.executeJavaScript(`(() => {
      const cell = state.databaseManager.notebooks.cells[0];
      const entry = databaseNotebookMonacoEditors.get(cell.id);
      entry.editor.setSelection(new monaco.Range(2, 1, 2, entry.model.getLineMaxColumn(2)));
      window.__notebookRunPromise = runDatabaseNotebookCell(cell.id, databaseNotebookSelectedSql(cell.id));
      return true;
    })()`);
    await waitFor(window, `!els.databaseQueryApprovalModal.classList.contains('hidden')`);
    const approval = await window.webContents.executeJavaScript(`({ title: els.databaseQueryApprovalTitle.textContent, label: els.databaseQueryApprovalRunLabel.textContent, source: window.__notebookQueries[0].source, query: window.__notebookQueries[0].query })`);
    await window.webContents.executeJavaScript(`els.databaseQueryApprovalForm.requestSubmit()`);
    await waitFor(window, `state.databaseManager.notebooks.executions.size === 1 && state.databaseManager.notebooks.runningCellId === ''`);
    await reveal(window);
    window.setContentSize(1279, 800); window.setContentSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await reveal(window);
    const desktop = await window.webContents.executeJavaScript(`(() => ({
      activeTab: state.databaseManager.activeTab,
      savedPayload: clone(window.__notebookWrites[0]),
      resultText: els.databaseNotebookCells.innerText,
      markdownText: els.databaseNotebookCells.querySelector('.database-notebook-markdown').innerText,
      markdownHtml: els.databaseNotebookCells.querySelector('.database-notebook-markdown').innerHTML,
      chartMounted: Boolean(els.databaseNotebookCells.querySelector('.database-notebook-chart-graphic svg')),
      chartText: els.databaseNotebookCells.querySelector('.database-notebook-cell.chart').innerText,
      cellCount: state.databaseManager.notebooks.cells.length,
      monacoMounted: databaseNotebookMonacoEditors.size === 1 && els.databaseNotebookCells.querySelector('.database-notebook-editor-host').classList.contains('monaco-ready'),
      visible: els.databaseNotebooksPanel.getBoundingClientRect().width > 0
    }))()`);
    const desktopPath = path.join(outputDirectory, 'database-manager-notebook-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('.database-notebook-cell.chart')?.scrollIntoView({ block: 'center' })`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const chartDesktopPath = path.join(outputDirectory, 'database-manager-notebook-chart-desktop.png');
    await fs.writeFile(chartDesktopPath, (await window.webContents.capturePage()).toPNG());
    window.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await reveal(window);
    await window.webContents.executeJavaScript(`document.querySelector('.database-notebook-cell')?.scrollIntoView({ block: 'start' })`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const panel = els.databaseNotebooksPanel.getBoundingClientRect();
      const cell = els.databaseNotebookCells.querySelector('.database-notebook-cell').getBoundingClientRect();
      return { panel: { left: panel.left, right: panel.right, top: panel.top }, cell: { left: cell.left, right: cell.right, top: cell.top }, viewport: { width: innerWidth, height: innerHeight }, bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    })()`);
    const mobilePath = path.join(outputDirectory, 'database-manager-notebook-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('.database-notebook-cell.chart')?.scrollIntoView({ block: 'start' })`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const chartMobilePath = path.join(outputDirectory, 'database-manager-notebook-chart-mobile.png');
    await fs.writeFile(chartMobilePath, (await window.webContents.capturePage()).toPNG());
    phase = 'guard';
    await window.webContents.executeJavaScript(`(() => {
      els.databaseNotebookDescription.value = 'Unsaved review';
      els.databaseNotebookDescription.dispatchEvent(new Event('input', { bubbles: true }));
      window.__notebookGuardPromise = setDatabaseManagerTab('connections');
      return true;
    })()`);
    await waitFor(window, `!els.confirmModal.classList.contains('hidden')`);
    const guardTitle = await window.webContents.executeJavaScript(`els.confirmModalTitle.textContent`);
    await window.webContents.executeJavaScript(`els.confirmModalCancelButton.click()`);
    await window.webContents.executeJavaScript(`window.__notebookGuardPromise`);
    await waitFor(window, `state.databaseManager.activeTab === 'notebooks'`);
    await window.webContents.executeJavaScript(`(() => { window.__notebookGuardStayed = true; els.databaseNotebookDescription.value = 'Production review'; state.databaseManager.notebooks.dirty = false; })()`);
    phase = 'cleanup';
    await window.webContents.executeJavaScript(`(async () => {
      const models = [...databaseNotebookMonacoEditors.values()].map((entry) => entry.model);
      await setDatabaseManagerTab('connections');
      window.__notebookMonacoCleanup = {
        editorsAfterTabChange: databaseNotebookMonacoEditors.size,
        modelsDisposed: models.length === 1 && models.every((model) => model.isDisposed())
      };
    })()`);
    await window.webContents.executeJavaScript(`(() => {
      const cell = state.databaseManager.notebooks.cells[0]; cell.content = 'SELECT WAIT';
      window.__notebookWaitPromise = runDatabaseNotebookCell(cell.id);
    })()`);
    await waitFor(window, `state.databaseManager.notebooks.runningCellId !== ''`);
    const requestId = await window.webContents.executeJavaScript(`state.databaseManager.notebooks.requestId`);
    await window.webContents.executeJavaScript(`cancelDatabaseNotebookCell()`);
    await waitFor(window, `state.databaseManager.notebooks.runningCellId === ''`);
    phase = 'tasks';
    await window.webContents.executeJavaScript(`setDatabaseManagerTab('tasks')`);
    await waitFor(window, `state.databaseManager.activeTab === 'tasks' && state.databaseManager.tasks.items.length === 2`);
    const taskProgressBeforeCancel = await window.webContents.executeJavaScript(`document.querySelector('[data-database-task-cancel="dbtask-import"]')?.closest('.database-task-item').querySelector('.database-task-progress > span').style.width`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-database-task-cancel="dbtask-import"]')?.click()`);
    await waitFor(window, `state.databaseManager.tasks.items.some((task) => task.id === 'dbtask-import' && task.state === 'canceled')`);
    window.setContentSize(1280, 800);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await reveal(window);
    const taskDesktop = await window.webContents.executeJavaScript(`(() => ({ text: els.databaseTasksList.innerText, count: els.databaseTasksList.children.length, visible: els.databaseTasksPanel.getBoundingClientRect().width > 0 }))()`);
    const taskDesktopPath = path.join(outputDirectory, 'database-manager-tasks-desktop.png');
    await fs.writeFile(taskDesktopPath, (await window.webContents.capturePage()).toPNG());
    window.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript(`(() => {
      els.toast.style.setProperty('transition', 'none', 'important');
      els.toast.style.setProperty('opacity', '0', 'important');
      els.toast.classList.remove('visible');
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const taskMobile = await window.webContents.executeJavaScript(`(() => { const panel = els.databaseTasksPanel.getBoundingClientRect(); const item = els.databaseTasksList.querySelector('.database-task-item').getBoundingClientRect(); return { panel: { left: panel.left, right: panel.right }, item: { left: item.left, right: item.right }, viewport: { width: innerWidth }, bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; })()`);
    const taskMobilePath = path.join(outputDirectory, 'database-manager-tasks-mobile.png');
    await fs.writeFile(taskMobilePath, (await window.webContents.capturePage()).toPNG());
    const finalState = await window.webContents.executeJavaScript(`({
        cancels: clone(window.__notebookCancels),
        querySources: window.__notebookQueries.map((item) => item.source),
        monacoEditorsAfterTabChange: window.__notebookMonacoCleanup.editorsAfterTabChange,
        monacoModelsDisposed: window.__notebookMonacoCleanup.modelsDisposed,
        guardTitle: ${JSON.stringify(guardTitle)},
        guardStayedInNotebook: Boolean(window.__notebookGuardStayed),
        taskCancels: clone(window.__databaseTaskCancels)
      })`);
    process.stdout.write(`${JSON.stringify({ approval, desktop, mobile, finalState, requestId, desktopPath, mobilePath, chartDesktopPath, chartMobilePath, taskProgressBeforeCancel, taskDesktop, taskMobile, taskDesktopPath, taskMobilePath })}\n`);
  } catch (error) {
    process.stderr.write(`[${phase}] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally { window.destroy(); app.quit(); }
});
