const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-ai-deployment-'));
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    backgroundColor: '#11111b',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  let exitCode = 0;

  try {
    await window.loadFile(path.join(__dirname, 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      document.querySelectorAll('.toast').forEach((toast) => toast.classList.remove('visible'));
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.documentElement.dataset.theme = 'catppuccin-mocha';
      activeThemeId = 'catppuccin-mocha';
      state.setup.mode = 'offline';
      state.setup.complete = true;
      state.projects = [
        { id: 'server-1', name: 'Production API', group: 'Production', serverType: 'ubuntu', ssh: { host: '192.0.2.10', port: 22, username: 'deploy' }, ftp: {}, commands: [] },
        { id: 'server-2', name: 'Staging Worker', group: 'Staging', serverType: 'ubuntu', ssh: { host: '192.0.2.11', port: 22, username: 'deploy' }, ftp: {}, commands: [] }
      ];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        getGithubIntegration: async () => ({ connected: true, login: 'test-user' }),
        listGithubRepositories: async () => { throw new Error("Error invoking remote method 'github-integration:repositories': Error: Repository access denied"); },
        listAiDeployments: async () => [
          { id: 'dep-1', name: 'Production release', projectId: 'server-1', localPath: 'C:\\projects\\api', remotePath: '/srv/api', agentId: 'codex', prompt: 'Deploy the latest verified release.', instructions: 'Run smoke tests.', createRollback: true, status: 'successful', lastRunAt: '2026-09-14T08:00:00.000Z', log: '[2026-09-14T08:00:00.000Z] INFO Deployment started.\\n[2026-09-14T08:02:00.000Z] SUCCESS Deployment completed.', runs: [
            { id: 'run-2', startedAt: '2026-09-14T08:00:00.000Z', completedAt: '2026-09-14T08:02:00.000Z', status: 'successful', message: 'Deployment completed.', log: '[2026-09-14T08:00:00.000Z] INFO Deployment started.\\n[2026-09-14T08:02:00.000Z] SUCCESS Deployment completed.' },
            { id: 'run-1', startedAt: '2026-09-13T07:00:00.000Z', completedAt: '2026-09-13T07:01:00.000Z', status: 'failed', message: 'Health check failed.', log: '[2026-09-13T07:00:00.000Z] INFO Deployment started.\\n[2026-09-13T07:01:00.000Z] ERROR Health check failed.' }
          ] },
          { id: 'dep-2', name: 'Worker staging', projectId: 'server-2', localPath: 'C:\\projects\\worker', remotePath: '/srv/worker', agentId: 'claude-code', prompt: 'Deploy staging.', instructions: '', createRollback: true, status: 'never-run', lastRunAt: '' }
        ],
        listLocalAgents: async () => [
          { id: 'codex', name: 'Codex', installed: true, connected: true, runnable: true },
          { id: 'claude-code', name: 'Claude Code', installed: true, connected: true, runnable: true }
        ],
        saveAiDeployment: async (deployment) => deployment,
        selectAiDeploymentTemporaryFiles: async () => [
          { path: 'C:/temp/release-notes.txt', name: 'release-notes.txt', size: 2048 },
          { path: 'C:/temp/runtime.env', name: 'runtime.env', size: 512 }
        ],
        runAiDeployment: async (id, options) => {
          window.__lastAiDeploymentRun = { id, options };
          const deployment = state.aiDeployments.items.find((item) => item.id === id);
          return { runId: 'run-test', deployment: { ...deployment, status: 'running' } };
        },
        ftpConnect: async (payload) => {
          window.__lastAiDeploymentFolderConnection = payload;
          return { ok: true };
        },
        ftpList: async ({ path }) => ({ path, parentPath: path === '/' ? '' : '/', items: [{ name: 'releases', path: path === '/' ? '/releases' : path + '/releases', type: 'directory' }] }),
        ftpDisconnect: async () => true
      }});
      showView('ai-deployments');
      while (state.aiDeployments.loading) await new Promise((resolve) => setTimeout(resolve, 10));
      document.querySelector('[data-ai-deployment-log="dep-1"]').click();
      const deploymentLogHistory = {
        open: document.getElementById('aiDeploymentLogDialog').open,
        heading: document.getElementById('aiDeploymentLogHeading').textContent,
        meta: document.getElementById('aiDeploymentLogMeta').textContent,
        count: document.querySelectorAll('[data-ai-deployment-log-run]').length,
        firstText: document.querySelector('[data-ai-deployment-log-run]')?.textContent
      };
      document.querySelector('[data-ai-deployment-log-run="run-2"]').click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const deploymentLogDetail = {
        open: document.getElementById('aiDeploymentLogDetailDialog').open,
        heading: document.getElementById('aiDeploymentLogDetailHeading').textContent,
        meta: document.getElementById('aiDeploymentLogDetailMeta').textContent,
        content: document.getElementById('aiDeploymentLogContent').textContent,
        focused: document.activeElement === document.getElementById('aiDeploymentLogContent')
      };
      document.getElementById('aiDeploymentLogDetailDoneButton').click();
      return {
        view: state.currentView,
        sidebarCollapsed: document.querySelector('.app-shell').classList.contains('sidebar-collapsed'),
        rows: document.querySelectorAll('#aiDeploymentTableBody tr').length,
        actionLabels: [...document.querySelectorAll('#aiDeploymentTableBody button')].map((button) => button.getAttribute('aria-label')),
        tableVisible: !document.getElementById('aiDeploymentTableWrap').classList.contains('hidden'),
        refreshRemoved: !document.getElementById('aiDeploymentRefreshButton'),
        deploymentLogHistory,
        deploymentLogDetail,
        historyOpenAfterDetail: document.getElementById('aiDeploymentLogDialog').open,
        searchInput: (() => {
          const style = getComputedStyle(document.getElementById('aiDeploymentSearch'));
          return { background: style.backgroundColor, borderWidth: style.borderWidth, boxShadow: style.boxShadow };
        })(),
        filterUi: (() => {
          const button = document.getElementById('aiDeploymentFilterButton');
          button.click();
          const panel = document.getElementById('aiDeploymentFilterPanel');
          const serverCheckbox = panel.querySelector('[data-ai-deployment-server-filter][value="server-1"]');
          const statusCheckbox = panel.querySelector('[data-ai-deployment-status-filter][value="successful"]');
          serverCheckbox.click();
          statusCheckbox.click();
          const selectedCount = document.getElementById('aiDeploymentFilterCount').textContent;
          const filteredRows = document.querySelectorAll('#aiDeploymentTableBody tr').length;
          document.getElementById('aiDeploymentClearFiltersButton').click();
          return {
            open: !panel.classList.contains('hidden'),
            groups: panel.querySelectorAll('fieldset').length,
            selectedCount,
            filteredRows,
            rowsAfterClear: document.querySelectorAll('#aiDeploymentTableBody tr').length,
            countHiddenAfterClear: document.getElementById('aiDeploymentFilterCount').classList.contains('hidden'),
            serialHeader: document.querySelector('#aiDeploymentTableWrap th')?.textContent.trim(),
            firstSerial: document.querySelector('#aiDeploymentTableBody td')?.textContent.trim(),
            statsInline: document.querySelector('.ai-deployment-stats')?.parentElement.classList.contains('ai-deployment-toolbar'),
            legacyHeadingRemoved: !document.getElementById('aiExternalDeploymentsHeading'),
            viewToggleRemoved: !document.getElementById('aiDeploymentTableViewButton') && !document.getElementById('aiDeploymentListViewButton')
          };
        })()
      };
    })()`);

    await new Promise((resolve) => setTimeout(resolve, 80));
    window.webContents.invalidate();
    const logHistoryPath = path.join(captureRoot, 'deployment-log-history.png');
    await fs.writeFile(logHistoryPath, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript("document.getElementById('aiDeploymentLogDoneButton').click()");
    window.webContents.invalidate();
    await window.webContents.capturePage();
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const listPath = path.join(captureRoot, 'deployment-list.png');
    await fs.writeFile(listPath, (await window.webContents.capturePage()).toPNG());

    const runDialog = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-ai-deployment-run="dep-1"]').click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const focused = document.activeElement === document.getElementById('aiDeploymentTemporaryPrompt');
      document.getElementById('aiDeploymentAttachFilesButton').click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        open: document.getElementById('aiDeploymentRunDialog').open,
        heading: document.getElementById('aiDeploymentRunHeading').textContent,
        inheritedPrompt: document.getElementById('aiDeploymentTemporaryPrompt').value,
        attachmentCount: document.querySelectorAll('#aiDeploymentTemporaryFilesList li').length,
        focused
      };
    })()`);
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const runDialogPath = path.join(captureRoot, 'deployment-run-dialog.png');
    await fs.writeFile(runDialogPath, (await window.webContents.capturePage()).toPNG());
    const runExecution = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('aiDeploymentTemporaryPrompt').value += ' Also warm the cache.';
      document.getElementById('aiDeploymentRunForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      while (state.aiDeployments.runSubmitting) await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        dialogClosed: !document.getElementById('aiDeploymentRunDialog').open,
        request: window.__lastAiDeploymentRun,
        savedPrompt: state.aiDeployments.items.find((item) => item.id === 'dep-1').prompt
      };
    })()`);

    const empty = await window.webContents.executeJavaScript(`(() => {
      window.__aiDeploymentItems = state.aiDeployments.items;
      state.aiDeployments.items = [];
      renderAiDeploymentFilters();
      renderAiDeployments();
      const panel = document.querySelector('.ai-deployment-panel').getBoundingClientRect();
      const emptyState = document.getElementById('aiDeploymentEmpty').getBoundingClientRect();
      return { panelHeight: panel.height, emptyHeight: emptyState.height, panelBottom: panel.bottom, viewportHeight: innerHeight };
    })()`);
    window.webContents.invalidate();
    await window.webContents.capturePage();
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const emptyPath = path.join(captureRoot, 'deployment-empty.png');
    await fs.writeFile(emptyPath, (await window.webContents.capturePage()).toPNG());

    const form = await window.webContents.executeJavaScript(`(async () => {
      state.aiDeployments.items = window.__aiDeploymentItems;
      state.aiDeployments.items.find((item) => item.id === 'dep-1').status = 'successful';
      renderAiDeploymentFilters();
      renderAiDeployments();
      document.querySelector('[data-ai-deployment-edit="dep-1"]').click();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const editPrompt = document.getElementById('aiDeploymentPrompt').value;
      const editInstructions = document.getElementById('aiDeploymentInstructions').value;
      closeAiDeploymentForm();
      document.getElementById('aiDeploymentStartButton').click();
      const serverDropdown = document.querySelector('[data-select-id="aiDeploymentProject"]');
      serverDropdown.querySelector('.workspace-switcher-trigger').click();
      const serverSearch = serverDropdown.querySelector('[data-project-dropdown-search-input]');
      serverSearch.value = 'staging';
      serverSearch.dispatchEvent(new Event('input', { bubbles: true }));
      const visibleServers = [...serverDropdown.querySelectorAll('.workspace-switcher-option:not([hidden]) span')].map((option) => option.textContent);
      serverDropdown.querySelector('.workspace-switcher-option:not([hidden])').click();
      const defaultPrompt = document.getElementById('aiDeploymentPrompt').value;
      const defaultInstructions = document.getElementById('aiDeploymentInstructions').value;
      await openAiDeploymentRemoteFolderBrowser();
      const folderProtocol = window.__lastAiDeploymentFolderConnection?.protocol;
      await loadAiDeploymentFolder('/releases');
      document.getElementById('aiDeploymentFolderSelectButton').click();
      document.getElementById('aiDeploymentSavedPrompt').value = 'dep-1';
      document.getElementById('aiDeploymentSavedPrompt').dispatchEvent(new Event('change', { bubbles: true }));
      const loadedPrompt = document.getElementById('aiDeploymentPrompt').value;
      const loadedInstructions = document.getElementById('aiDeploymentInstructions').value;
      const deleteEnabled = !document.getElementById('aiDeploymentDeletePromptButton').disabled;
      document.getElementById('aiDeploymentClearPromptButton').click();
      const promptAfterClear = document.getElementById('aiDeploymentPrompt').value;
      const instructionsAfterPromptClear = document.getElementById('aiDeploymentInstructions').value;
      document.getElementById('aiDeploymentClearInstructionsButton').click();
      document.getElementById('aiDeploymentSavedPrompt').value = 'dep-1';
      document.getElementById('aiDeploymentSavedPrompt').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('aiDeploymentDeletePromptButton').click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const deleteConfirmationVisible = !document.getElementById('confirmModal').classList.contains('hidden');
      document.getElementById('confirmModalConfirmButton').click();
      for (let attempt = 0; attempt < 100 && state.aiDeployments.items.find((item) => item.id === 'dep-1')?.promptReusable !== false; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const sameRow = (...ids) => {
        const tops = ids.map((id) => document.getElementById(id).closest('.field').getBoundingClientRect().top);
        return Math.max(...tops) - Math.min(...tops) < 2;
      };
      const targetControl = document.getElementById('aiDeploymentProject').closest('.field').querySelector('.project-dropdown').getBoundingClientRect();
      const localControl = document.getElementById('aiDeploymentLocalPath').getBoundingClientRect();
      const remoteControl = document.getElementById('aiDeploymentRemotePath').getBoundingClientRect();
      const browseControl = document.getElementById('aiDeploymentBrowseButton').getBoundingClientRect();
      const remoteBrowseControl = document.getElementById('aiDeploymentRemoteBrowseButton').getBoundingClientRect();
      const connectionFields = ['aiDeploymentProject', 'aiDeploymentLocalPath', 'aiDeploymentRemotePath']
        .map((id) => document.getElementById(id).closest('.field').getBoundingClientRect());
      return {
        visible: !document.getElementById('aiDeploymentFormPage').classList.contains('hidden'),
        heading: document.getElementById('aiDeploymentFormHeading').textContent,
        editPrompt,
        editInstructions,
        folderProtocol,
        remotePathOptional: !document.getElementById('aiDeploymentRemotePath').required,
        compactHeader: document.querySelector('.ai-deployment-form-header').getBoundingClientRect().height <= 80,
        iconOnlyBack: !document.getElementById('aiDeploymentBackButton').textContent.trim(),
        iconOnlyDelete: !document.getElementById('aiDeploymentDeletePromptButton').textContent.trim(),
        connectionFieldsAligned: sameRow('aiDeploymentProject', 'aiDeploymentLocalPath', 'aiDeploymentRemotePath'),
        connectionControlsAligned: Math.max(targetControl.top, localControl.top, remoteControl.top) - Math.min(targetControl.top, localControl.top, remoteControl.top) < 2
          && Math.max(targetControl.bottom, localControl.bottom, remoteControl.bottom) - Math.min(targetControl.bottom, localControl.bottom, remoteControl.bottom) < 2,
        browseButtonsAligned: Math.abs(localControl.top - browseControl.top) < 2
          && Math.abs(localControl.bottom - browseControl.bottom) < 2
          && Math.abs(remoteControl.top - remoteBrowseControl.top) < 2
          && Math.abs(remoteControl.bottom - remoteBrowseControl.bottom) < 2,
        connectionColumnsEqual: Math.max(...connectionFields.map((rect) => rect.width)) - Math.min(...connectionFields.map((rect) => rect.width)) < 2,
        identityFieldsAligned: sameRow('aiDeploymentName', 'aiDeploymentSavedPrompt'),
        promptFieldsAligned: sameRow('aiDeploymentPrompt', 'aiDeploymentInstructions'),
        serverOptions: document.getElementById('aiDeploymentProject').options.length,
        serverSearchPlaceholder: serverSearch.placeholder,
        visibleServers,
        selectedServer: document.getElementById('aiDeploymentProject').value,
        summaryServer: document.getElementById('aiDeploymentSummaryServer').textContent,
        remotePath: document.getElementById('aiDeploymentRemotePath').value,
        summaryRemotePath: document.getElementById('aiDeploymentSummaryRemotePath').textContent,
        agentOptions: document.getElementById('aiDeploymentAgent').options.length,
        defaultPrompt,
        defaultInstructions,
        loadedPrompt,
        loadedInstructions,
        deleteEnabled,
        deleteConfirmationVisible,
        promptDeleted: state.aiDeployments.items.find((item) => item.id === 'dep-1')?.promptReusable === false,
        deploymentPreserved: state.aiDeployments.items.some((item) => item.id === 'dep-1'),
        deletedPromptOptionRemoved: ![...document.getElementById('aiDeploymentSavedPrompt').options].some((option) => option.value === 'dep-1'),
        fieldsClearedAfterDelete: !document.getElementById('aiDeploymentPrompt').value && !document.getElementById('aiDeploymentInstructions').value,
        promptAfterClear,
        instructionsAfterPromptClear,
        instructionsAfterClear: document.getElementById('aiDeploymentInstructions').value,
        projectInvalid: document.getElementById('aiDeploymentProject').getAttribute('aria-invalid')
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const formPath = path.join(captureRoot, 'deployment-form.png');
    await fs.writeFile(formPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`(async () => {
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const source = els.aiDeploymentSourceType;
      const button = els.aiDeploymentFetchRepositoriesButton;
      const status = els.aiDeploymentRepositoriesStatus;
      check(state.githubIntegration.connected, 'Repository failure must preserve the connected integration');
      check(!source.querySelector('option[value="github"]').disabled, 'Connected GitHub must remain selectable');
      check(status.textContent.includes('Repository access denied'), 'Repository failure must be visible');
      check(!status.textContent.includes('Error invoking remote method'), 'Repository errors must omit the IPC wrapper');
      source.value = 'github';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      check(!button.classList.contains('hidden'), 'GitHub source must show the fetch button');
      check(els.aiDeploymentSummaryFolder.textContent === 'Not selected', 'Empty repository must not count as a selected source');
      let finish;
      let calls = 0;
      window.deployerx.listGithubRepositories = () => {
        calls += 1;
        return new Promise((resolve) => { finish = resolve; });
      };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      check(button.disabled && button.getAttribute('aria-busy') === 'true', 'Fetching must show a busy button');
      await fetchAiDeploymentGithubRepositories();
      check(calls === 1, 'Duplicate fetch must be ignored');
      finish([{ fullName: 'team/app', defaultBranch: 'develop', private: true }]);
      while (button.disabled) await new Promise((resolve) => setTimeout(resolve, 5));
      check(els.aiDeploymentGithubRepo.options.length === 2, 'Fetch must populate repositories');
      els.aiDeploymentGithubRepo.value = 'team/app';
      els.aiDeploymentGithubRepo.dispatchEvent(new Event('change', { bubbles: true }));
      check(els.aiDeploymentGithubBranch.value === 'develop', 'Selection must use the default branch');
      els.aiDeploymentGithubBranch.value = 'release';
      els.aiDeploymentPrompt.value = 'Keep this prompt';
      const project = els.aiDeploymentProject.value;
      window.deployerx.listGithubRepositories = async () => [
        { fullName: 'team/app', defaultBranch: 'develop', private: true },
        { fullName: 'team/new', defaultBranch: 'main', private: false }
      ];
      await fetchAiDeploymentGithubRepositories();
      check(els.aiDeploymentGithubRepo.value === 'team/app' && els.aiDeploymentGithubBranch.value === 'release', 'Refresh must preserve repository and branch');
      check(els.aiDeploymentPrompt.value === 'Keep this prompt' && els.aiDeploymentProject.value === project, 'Refresh must preserve form fields');
      await loadGithubIntegration();
      check(state.githubRepositories.length === 2, 'Loading settings must preserve repository cache');
      window.deployerx.listGithubRepositories = async () => { throw new Error('Network unavailable'); };
      await fetchAiDeploymentGithubRepositories();
      check(state.githubIntegration.connected && els.aiDeploymentGithubRepo.value === 'team/app', 'Failed refresh must preserve connection and selection');
      check(!button.disabled && status.textContent.includes('Network unavailable'), 'Failed refresh must allow retry');
      window.deployerx.listGithubRepositories = async () => [];
      await fetchAiDeploymentGithubRepositories();
      check(status.textContent.includes('No repositories available'), 'Empty fetch must explain repository access');
      state.githubIntegration = { connected: false };
      openAiDeploymentForm();
      check(source.querySelector('option[value="github"]').disabled, 'Disconnected GitHub must be disabled');
      await loadGithubIntegration();
      await new Promise((resolve) => setTimeout(resolve, 0));
      check(!source.querySelector('option[value="github"]').disabled, 'Late connection state must enable an open form');
      const sourceDropdown = source.closest('.project-dropdown');
      sourceDropdown.querySelector('.workspace-switcher-trigger').click();
      const githubOption = sourceDropdown.querySelector('[data-project-dropdown-value="github"]');
      check(!githubOption.disabled, 'Enhanced GitHub option must also be enabled');
      githubOption.click();
      check(source.value === 'github', 'Clicking the GitHub option must select it');
      window.deployerx.listGithubRepositories = async () => [{ fullName: 'team/app', defaultBranch: 'main', private: true }];
      await fetchAiDeploymentGithubRepositories();
      els.aiDeploymentGithubRepo.value = 'team/app';
      els.aiDeploymentGithubBranch.value = 'release';
      window.deployerx.getGithubIntegration = async () => ({ connected: false, needsReconnect: true, error: 'Saved credential unavailable. Reconnect GitHub.' });
      let failedCredentialRequests = 0;
      window.deployerx.listGithubRepositories = async () => { failedCredentialRequests += 1; return []; };
      await fetchAiDeploymentGithubRepositories();
      check(failedCredentialRequests === 0, 'Locked credentials must not make a repository request');
      check(els.githubIntegrationStatus.textContent === 'Reconnect required', 'Settings must not claim a locked token is connected');
      check(!els.aiDeploymentReconnectGithubButton.classList.contains('hidden'), 'Deployment must offer credential recovery');
      check(status.textContent.includes('Reconnect GitHub'), 'Locked credentials must explain recovery');
      els.aiDeploymentReconnectGithubButton.click();
      check(els.githubIntegrationDialog.open, 'Reconnect must open the existing credential dialog');
      window.deployerx.connectGithubIntegration = async () => {
        window.deployerx.getGithubIntegration = async () => ({ connected: true, login: 'test-user' });
        return window.deployerx.getGithubIntegration();
      };
      window.deployerx.listGithubRepositories = async () => [{ fullName: 'team/app', defaultBranch: 'main', private: true }];
      els.githubIntegrationToken.value = 'test-token';
      await submitGithubIntegration({ preventDefault() {} });
      check(!els.githubIntegrationDialog.open && els.githubIntegrationToken.value === '', 'Reconnect must close the dialog and clear its token');
      check(els.githubIntegrationStatus.textContent === 'Connected', 'Reconnected credentials must update settings');
      check(els.aiDeploymentReconnectGithubButton.classList.contains('hidden'), 'Successful reconnection must hide recovery');
      check(status.textContent === '1 repository available.', 'Reconnect must fetch repositories automatically');
      check(els.aiDeploymentGithubRepo.value === 'team/app' && els.aiDeploymentGithubBranch.value === 'release', 'Reconnect must preserve the deployment source');
    })()`);
    const githubFormPath = path.join(captureRoot, 'deployment-github.png');
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fs.writeFile(githubFormPath, (await window.webContents.capturePage()).toPNG());

    const valid = result.view === 'ai-deployments'
      && result.sidebarCollapsed
      && result.rows === 2
      && result.tableVisible
      && result.refreshRemoved
      && result.deploymentLogHistory.open
      && result.deploymentLogHistory.heading === 'Production release logs'
      && result.deploymentLogHistory.meta.includes('Production API')
      && result.deploymentLogHistory.count === 2
      && result.deploymentLogHistory.firstText.includes('Successful')
      && result.deploymentLogDetail.open
      && result.deploymentLogDetail.heading === 'Production release session'
      && result.deploymentLogDetail.meta.includes('Successful')
      && result.deploymentLogDetail.content.includes('Deployment completed.')
      && result.deploymentLogDetail.focused
      && result.historyOpenAfterDetail
      && result.searchInput.background === 'rgba(0, 0, 0, 0)'
      && result.searchInput.borderWidth === '0px'
      && result.searchInput.boxShadow === 'none'
      && result.filterUi.open
      && result.filterUi.groups === 2
      && result.filterUi.selectedCount === '2'
      && result.filterUi.filteredRows === 1
      && result.filterUi.rowsAfterClear === 2
      && result.filterUi.countHiddenAfterClear
      && result.filterUi.serialHeader === '#'
      && result.filterUi.firstSerial === '1'
      && result.filterUi.statsInline
      && result.filterUi.legacyHeadingRemoved
      && result.filterUi.viewToggleRemoved
      && runDialog.open
      && runDialog.heading === 'Run Production release'
      && runDialog.inheritedPrompt === 'Deploy the latest verified release.'
      && runDialog.attachmentCount === 2
      && runDialog.focused
      && runExecution.dialogClosed
      && runExecution.request.id === 'dep-1'
      && runExecution.request.options.temporaryPrompt.endsWith('Also warm the cache.')
      && runExecution.request.options.temporaryFiles.length === 2
      && runExecution.savedPrompt === 'Deploy the latest verified release.'
      && empty.panelHeight >= 400
      && empty.emptyHeight >= 250
      && empty.panelBottom <= empty.viewportHeight
      && ['Run Production release', 'Edit Production release', 'Duplicate Production release', 'Delete Production release'].every((label) => result.actionLabels.includes(label))
      && form.visible
      && form.heading === 'Start Deployment'
      && form.editPrompt === 'Deploy the latest verified release.'
      && form.editInstructions === 'Run smoke tests.'
      && form.folderProtocol === 'sftp'
      && form.remotePathOptional
      && form.compactHeader
      && form.iconOnlyBack
      && form.iconOnlyDelete
      && form.connectionFieldsAligned
      && form.connectionControlsAligned
      && form.browseButtonsAligned
      && form.connectionColumnsEqual
      && form.identityFieldsAligned
      && form.promptFieldsAligned
      && form.serverOptions === 3
      && form.serverSearchPlaceholder === 'Search servers...'
      && form.visibleServers.length === 1
      && form.visibleServers[0] === 'Staging Worker'
      && form.selectedServer === 'server-2'
      && form.summaryServer === 'Staging Worker'
      && form.remotePath === '/releases'
      && form.summaryRemotePath === '/releases'
      && form.agentOptions === 3
      && form.defaultPrompt === ''
      && form.defaultInstructions === ''
      && form.loadedPrompt === 'Deploy the latest verified release.'
      && form.loadedInstructions === 'Run smoke tests.'
      && form.deleteEnabled
      && form.deleteConfirmationVisible
      && form.promptDeleted
      && form.deploymentPreserved
      && form.deletedPromptOptionRemoved
      && form.fieldsClearedAfterDelete
      && form.promptAfterClear === ''
      && form.instructionsAfterPromptClear === 'Run smoke tests.'
      && form.instructionsAfterClear === '';
    process.stdout.write(`${JSON.stringify({ ok: valid, result, runDialog, runExecution, empty, form, logHistoryPath, listPath, runDialogPath, emptyPath, formPath, githubFormPath })}\n`);
    if (!valid) exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
