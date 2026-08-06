const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const queryTabsSource = fs.readFileSync(path.join(root, 'database-manager', 'query-tabs.js'), 'utf8');
const editorToolsSource = fs.readFileSync(path.join(root, 'database-manager', 'query-editor-tools.js'), 'utf8');
const resultGridSource = fs.readFileSync(path.join(root, 'database-manager', 'result-grid.js'), 'utf8');

test('prefers the native database host and falls back to one direct built-in runtime', () => {
  assert.match(mainSource, /const \{ DirectDatabaseDriverRuntime \} = require\('\.\/database-manager\/direct-driver-runtime'\)/);
  assert.match(mainSource, /const databaseDriverHostPath = resolveDatabaseDriverHostPath\(\{[\s\S]*const databaseDriverHostAvailable = await fs\.stat\(databaseDriverHostPath\)[\s\S]*\.catch\(\(\) => false\)/);
  assert.match(mainSource, /databaseDriverHostAvailable[\s\S]*\? new SidecarDriverRuntime\(\{ executablePath: databaseDriverHostPath \}\)[\s\S]*: new DirectDatabaseDriverRuntime\(\)/);
  assert.match(mainSource, /register\('postgresql', databaseDriverHost\)[\s\S]*register\('mysql', databaseDriverHost\)[\s\S]*register\('sqlite', databaseDriverHost\)/);
});

test('registers all profile CRUD channels behind versioned Database Manager envelopes', () => {
  for (const operation of ['list', 'get', 'create', 'update', 'delete']) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\('database-manager:profiles:${operation}', wrapDatabaseManagerIpc`));
  }
  assert.match(mainSource, /const databaseProfileStore = new DatabaseProfileStore\(\{ controlDatabase \}\)[\s\S]*new DatabaseProfileService\(\{[\s\S]*profileStore: databaseProfileStore/);
  assert.match(mainSource, /new DatabaseConnectionImportService\(\{[\s\S]*profileStore: databaseProfileStore[\s\S]*localResourceStore: databaseLocalResourceStore[\s\S]*deviceId: backupDeviceId/);
  assert.match(mainSource, /databaseConnectionImportService\.reconcile\(context\.workspaceId, context\.actorId\)/);
  assert.match(mainSource, /async function databaseManagerContext\(\)[\s\S]*activeTeamId[\s\S]*local-user/);
});

test('loads the backup device identity before constructing device-scoped services', () => {
  const deviceIdentityIndex = mainSource.indexOf('backupDeviceId = await loadOrCreateBackupDeviceId(getBackupManagerRootPath())');
  const connectionImporterIndex = mainSource.indexOf('databaseConnectionImportService = new DatabaseConnectionImportService');
  assert.notEqual(deviceIdentityIndex, -1);
  assert.notEqual(connectionImporterIndex, -1);
  assert.ok(deviceIdentityIndex < connectionImporterIndex);
});

test('preload exposes profile methods without exposing ipcRenderer', () => {
  assert.match(preloadSource, /const DATABASE_MANAGER_IPC_VERSION = 1/);
  assert.match(preloadSource, /function unwrapDatabaseManagerIpc\(/);
  assert.match(preloadSource, /listDatabaseProfiles: .*invokeDatabaseManager\('database-manager:profiles:list'/);
  assert.match(preloadSource, /createDatabaseProfile: .*invokeDatabaseManager\('database-manager:profiles:create'/);
  assert.match(preloadSource, /updateDatabaseProfile: .*invokeDatabaseManager\('database-manager:profiles:update'/);
  assert.match(preloadSource, /deleteDatabaseProfile: .*invokeDatabaseManager\('database-manager:profiles:delete'/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:profiles:resolve-cloud-conflict', wrapDatabaseManagerIpc/);
  assert.match(preloadSource, /resolveDatabaseProfileCloudConflict: .*invokeDatabaseManager\('database-manager:profiles:resolve-cloud-conflict'/);
  assert.match(mainSource, /'currentDocument\.updateTime'/);
  assert.match(mainSource, /planCloudSyncOperation\(operation, remote\)/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:connections:test', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:connections:open', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:connections:close', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:connections:status', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:connections:list-status', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:backup:prepare', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:local-resources:bind', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:queries:execute', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:queries:cancel', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:explain:execute', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:explain:cancel', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:transfer:execute', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:rows:mutate', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:schema:load', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:schema:cancel', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:schema:capabilities', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:schema:execute', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:principals:capabilities', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:principals:list', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:principals:inspect', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:principals:execute', wrapDatabaseManagerIpc/);
  assert.match(preloadSource, /testDatabaseProfile: .*invokeDatabaseManager\('database-manager:connections:test'/);
  assert.match(preloadSource, /openDatabaseConnection: .*invokeDatabaseManager\('database-manager:connections:open'/);
  assert.match(preloadSource, /closeDatabaseConnection: .*invokeDatabaseManager\('database-manager:connections:close'/);
  assert.match(preloadSource, /getDatabaseConnectionStatus: .*invokeDatabaseManager\('database-manager:connections:status'/);
  assert.match(preloadSource, /listDatabaseConnectionStatuses: .*invokeDatabaseManager\('database-manager:connections:list-status'/);
  assert.match(preloadSource, /prepareDatabaseProfileBackup: .*invokeDatabaseManager\('database-manager:backup:prepare'/);
  assert.match(preloadSource, /bindDatabaseProfileLocalResource: .*invokeDatabaseManager\('database-manager:local-resources:bind'/);
  assert.match(preloadSource, /executeDatabaseQuery: .*invokeDatabaseManager\('database-manager:queries:execute'/);
  assert.match(preloadSource, /cancelDatabaseQuery: .*invokeDatabaseManager\('database-manager:queries:cancel'/);
  assert.match(preloadSource, /explainDatabaseQuery: .*invokeDatabaseManager\('database-manager:explain:execute'/);
  assert.match(preloadSource, /cancelDatabaseExplain: .*invokeDatabaseManager\('database-manager:explain:cancel'/);
  assert.match(preloadSource, /executeDatabaseTransfer: .*invokeDatabaseManager\('database-manager:transfer:execute'/);
  assert.match(rendererSource, /databaseQueryPlan/);
  assert.match(htmlSource, /database-manager\/er-diagram\.js/);
  assert.match(preloadSource, /mutateDatabaseRows: .*invokeDatabaseManager\('database-manager:rows:mutate'/);
  assert.match(preloadSource, /loadDatabaseSchema: .*invokeDatabaseManager\('database-manager:schema:load'/);
  assert.match(preloadSource, /cancelDatabaseSchema: .*invokeDatabaseManager\('database-manager:schema:cancel'/);
  assert.match(preloadSource, /getDatabaseSchemaCapabilities: .*invokeDatabaseManager\('database-manager:schema:capabilities'/);
  assert.match(preloadSource, /executeDatabaseSchemaAction: .*invokeDatabaseManager\('database-manager:schema:execute'/);
  assert.match(preloadSource, /getDatabasePrincipalCapabilities: .*invokeDatabaseManager\('database-manager:principals:capabilities'/);
  assert.match(preloadSource, /listDatabasePrincipals: .*invokeDatabaseManager\('database-manager:principals:list'/);
  assert.match(preloadSource, /inspectDatabasePrincipal: .*invokeDatabaseManager\('database-manager:principals:inspect'/);
  assert.match(preloadSource, /executeDatabasePrincipalAction: .*invokeDatabaseManager\('database-manager:principals:execute'/);
  for (const operation of ['list', 'create', 'update', 'delete']) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\('database-manager:saved-queries:${operation}', wrapDatabaseManagerIpc`));
  }
  assert.match(mainSource, /ipcMain\.handle\('database-manager:history:list', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:history:clear', wrapDatabaseManagerIpc/);
  for (const operation of ['list', 'get', 'create', 'update', 'delete']) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\('database-manager:notebooks:${operation}', wrapDatabaseManagerIpc`));
  }
  for (const operation of ['list', 'get', 'cancel']) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\('database-manager:tasks:${operation}', wrapDatabaseManagerIpc`));
  }
  assert.match(mainSource, /ipcMain\.handle\('database-manager:logs:list', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /new DatabaseOperationalEvidenceStore\(\{ rootPath: path\.join\(getBackupManagerRootPath\(\), 'database-manager'\) \}\)/);
  assert.match(mainSource, /operationalEvidenceStore: databaseOperationalEvidenceStore/);
  assert.match(mainSource, /recordDatabaseOperationalEvidence\(workspaceId, type, payload\)/);
  assert.match(mainSource, /databaseOperationalEvidenceStore\.append\(workspaceId,/);
  assert.match(preloadSource, /listDatabaseSavedQueries: .*invokeDatabaseManager\('database-manager:saved-queries:list'/);
  assert.match(preloadSource, /createDatabaseSavedQuery: .*invokeDatabaseManager\('database-manager:saved-queries:create'/);
  assert.match(preloadSource, /updateDatabaseSavedQuery: .*invokeDatabaseManager\('database-manager:saved-queries:update'/);
  assert.match(preloadSource, /deleteDatabaseSavedQuery: .*invokeDatabaseManager\('database-manager:saved-queries:delete'/);
  assert.match(preloadSource, /listDatabaseQueryHistory: .*invokeDatabaseManager\('database-manager:history:list'/);
  assert.match(preloadSource, /clearDatabaseQueryHistory: .*invokeDatabaseManager\('database-manager:history:clear'/);
  assert.match(preloadSource, /listDatabaseNotebooks: .*invokeDatabaseManager\('database-manager:notebooks:list'/);
  assert.match(preloadSource, /getDatabaseNotebook: .*invokeDatabaseManager\('database-manager:notebooks:get'/);
  assert.match(preloadSource, /createDatabaseNotebook: .*invokeDatabaseManager\('database-manager:notebooks:create'/);
  assert.match(preloadSource, /updateDatabaseNotebook: .*invokeDatabaseManager\('database-manager:notebooks:update'/);
  assert.match(preloadSource, /deleteDatabaseNotebook: .*invokeDatabaseManager\('database-manager:notebooks:delete'/);
  assert.match(preloadSource, /listDatabaseTasks: .*invokeDatabaseManager\('database-manager:tasks:list'/);
  assert.match(preloadSource, /getDatabaseTask: .*invokeDatabaseManager\('database-manager:tasks:get'/);
  assert.match(preloadSource, /cancelDatabaseTask: .*invokeDatabaseManager\('database-manager:tasks:cancel'/);
  assert.match(preloadSource, /listDatabaseOperationalLogs: .*invokeDatabaseManager\('database-manager:logs:list'/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:results:serialize', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:results:export', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:results:export-query', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:results:cancel-export', wrapDatabaseManagerIpc/);
  assert.match(preloadSource, /serializeDatabaseQueryResults: .*invokeDatabaseManager\('database-manager:results:serialize'/);
  assert.match(preloadSource, /exportDatabaseQueryResults: .*invokeDatabaseManager\('database-manager:results:export'/);
  assert.match(preloadSource, /exportDatabaseQuery: .*invokeDatabaseManager\('database-manager:results:export-query'/);
  assert.match(preloadSource, /cancelDatabaseQueryExport: .*invokeDatabaseManager\('database-manager:results:cancel-export'/);
  assert.match(mainSource, /createDatabaseManagerEvent/);
  assert.match(mainSource, /webContents\.send\('database-manager:event', event\)/);
  assert.match(mainSource, /createInstalledPluginRuntime\(\{[\s\S]*installed,[\s\S]*beforeStart: \(\) => getDatabasePluginRegistry\(\)\.verifyInstalled\(pluginId\)/);
  assert.match(mainSource, /beforeStart: \(\) => getDatabasePluginRegistry\(\)\.verifyInstalled\(pluginId\)/);
  assert.match(mainSource, /inspectCachedPluginRuntimeRequirement\(pluginRuntimeRequirement\(installed\.entrypoint, installed\.pluginId\)\)/);
  assert.match(mainSource, /DATABASE_PLUGIN_RUNTIME_UNAVAILABLE/);
  for (const eventType of ['connection-status', 'query-progress', 'batch-completion', 'schema-change', 'task-state', 'plugin-state']) {
    assert.match(mainSource, new RegExp(`sendDatabaseManagerEvent\\([^\\n]+['"]${eventType}['"]`));
  }
  assert.match(preloadSource, /onDatabaseManagerEvent: \(callback\) =>/);
  assert.match(preloadSource, /ipcRenderer\.on\('database-manager:event', handler\)/);
  assert.match(preloadSource, /ipcRenderer\.removeListener\('database-manager:event', handler\)/);
  for (const operation of ['list', 'refresh', 'install', 'enable', 'disable', 'remove', 'health']) {
    assert.match(mainSource, new RegExp(`ipcMain\\.handle\\('database-manager:plugins:${operation}', wrapDatabaseManagerIpc`));
  }
  assert.match(mainSource, /ipcMain\.handle\('database-manager:plugins:requirements:refresh', wrapDatabaseManagerIpc/);
  assert.doesNotMatch(mainSource, /database-manager:plugins:catalog/);
  assert.doesNotMatch(preloadSource, /setDatabasePluginCatalog/);
  assert.match(preloadSource, /listDatabasePlugins: .*invokeDatabaseManager\('database-manager:plugins:list'/);
  assert.match(preloadSource, /recheckDatabasePluginRequirements: .*invokeDatabaseManager\('database-manager:plugins:requirements:refresh'/);
  assert.match(preloadSource, /installDatabasePlugin: .*invokeDatabaseManager\('database-manager:plugins:install'/);
  assert.match(preloadSource, /checkDatabasePluginHealth: .*invokeDatabaseManager\('database-manager:plugins:health'/);
  assert.match(rendererSource, /data-database-plugin-health/);
  assert.match(rendererSource, /data-database-plugin-runtime-refresh/);
  assert.match(rendererSource, /recorded crash/);
  const exposedApi = preloadSource.slice(preloadSource.indexOf("contextBridge.exposeInMainWorld('deployerx'"));
  assert.doesNotMatch(exposedApi, /\n\s*ipcRenderer\s*[,}]/);
  assert.doesNotMatch(exposedApi, /\n\s*ipcRenderer\s*:/);
});

test('hardens the renderer boundary and Database Manager keyboard accessibility', () => {
  assert.match(mainSource, /webPreferences:\s*\{[\s\S]*contextIsolation: true[\s\S]*nodeIntegration: false[\s\S]*sandbox: true/);
  assert.match(mainSource, /webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainSource, /webContents\.on\('will-navigate', \(event\) => event\.preventDefault\(\)\)/);
  assert.match(htmlSource, /Content-Security-Policy[\s\S]*object-src 'none'[\s\S]*base-uri 'none'[\s\S]*form-action 'none'/);
  for (const [tabId, panelId] of [
    ['databaseConnectionsTab', 'databaseConnectionsPanel'],
    ['databaseQueryTab', 'databaseQueryPanel'],
    ['databaseNotebooksTab', 'databaseNotebooksPanel'],
    ['databaseTasksTab', 'databaseTasksPanel'],
    ['databaseLogsTab', 'databaseLogsPanel'],
    ['databaseSchemaLibraryTab', 'databaseSchemaLibraryPanel'],
    ['databaseSavedLibraryTab', 'databaseSavedLibraryPanel'],
    ['databaseHistoryLibraryTab', 'databaseHistoryLibraryPanel']
  ]) {
    assert.match(htmlSource, new RegExp(`id="${tabId}"[^>]+role="tab"[^>]+aria-controls="${panelId}"[^>]+tabindex="(?:0|-1)"`));
  }
  for (const modalId of ['databaseProfileModal', 'databaseQueryApprovalModal', 'databaseQueryInspectorModal', 'databaseRowEditorModal', 'databaseSchemaActionModal', 'databasePrincipalModal', 'databaseSavedQueryModal']) {
    assert.match(htmlSource, new RegExp(`id="${modalId}"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+aria-hidden="true"`));
  }
  assert.match(rendererSource, /function handleDatabaseTablistKeydown\(/);
  assert.match(rendererSource, /tabElement\.tabIndex = selected \? 0 : -1/);
  assert.match(rendererSource, /function databaseModalFocusableElements\(/);
  assert.match(rendererSource, /function syncDatabaseManagerModalIsolation\(/);
  assert.match(rendererSource, /appShell\.inert = databaseManagerModalEntries\(\)\.some/);
  assert.match(rendererSource, /event\.stopImmediatePropagation\(\)[\s\S]*if \(!event\.repeat\) close\(\)/);
  assert.match(stylesSource, /\.database-manager-tab:focus-visible/);
  assert.match(stylesSource, /\.database-query-tab-main:focus-visible/);
  assert.match(htmlSource, /database-catalog-toolbar[\s\S]*database-search[\s\S]*database-summary[\s\S]*database-catalog-table-area/);
  assert.match(stylesSource, /#databaseConnectionsPanel\s*\{[\s\S]*display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden;/);
  assert.match(stylesSource, /\.database-catalog-table-area\s*\{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: hidden;/);
  assert.match(stylesSource, /\.database-profile-list\s*\{[\s\S]*overflow: auto;/);
  assert.match(stylesSource, /\.database-manager-view-header #databaseProfileAddButton\s*\{[\s\S]*max-width: none;[\s\S]*white-space: nowrap;/);
});

test('renders and routes a complete Database Manager catalog and query shell', () => {
  for (const id of ['topDatabasesButton', 'databaseManagerView', 'databaseProfileList', 'databaseProfilesEmpty', 'databaseProfileModal', 'databaseProfileForm', 'databaseConnectionsTab', 'databaseQueryTab', 'databaseNotebooksTab', 'databaseNotebooksPanel', 'databaseNotebookProfile', 'databaseNotebookSelect', 'databaseNotebookName', 'databaseNotebookTags', 'databaseNotebookCells', 'databaseNotebookSaveButton', 'databaseNotebookDuplicateButton', 'databaseNotebookRenameButton', 'databaseNotebookAddChartButton', 'databaseTasksTab', 'databaseTasksPanel', 'databaseTasksProfile', 'databaseTasksState', 'databaseTasksList', 'databaseTasksEmpty', 'databaseLogsTab', 'databaseLogsPanel', 'databaseLogsProfile', 'databaseLogsCategory', 'databaseLogsSeverity', 'databaseLogsSearch', 'databaseLogsRefreshButton', 'databaseLogsWarning', 'databaseLogsList', 'databaseLogsEmpty', 'databaseQueryPanel', 'databaseQueryProfile', 'databaseQueryTabs', 'databaseQueryNewTabButton', 'databaseQueryEditor', 'databaseQueryEditorHost', 'databaseQueryMonaco', 'databaseQueryFormatButton', 'databaseQueryExplainButton', 'databaseQueryImportButton', 'databaseQueryDumpButton', 'databaseQueryRunButton', 'databaseQueryRunAllButton', 'databaseQuerySaveButton', 'databaseQueryCancelButton', 'databaseQueryResults', 'databaseQueryPlan', 'databaseQueryResultSet', 'databaseRowInsertButton', 'databaseRowEditButton', 'databaseRowDeleteButton', 'databaseQueryCopyResultsButton', 'databaseQueryInspectButton', 'databaseQueryResultExportFormat', 'databaseQueryExportResultsButton', 'databaseQueryApprovalModal', 'databaseQueryApprovalRunLabel', 'databaseQueryInspectorModal', 'databaseQueryInspectorValue', 'databaseQueryInspectorCopyButton', 'databaseRowEditorModal', 'databaseRowEditorForm', 'databaseRowEditorFields', 'databaseSchemaExplorer', 'databaseSchemaManageButton', 'databasePrincipalManageButton', 'databaseSchemaErButton', 'databaseSchemaErPanel', 'databaseSchemaRefreshButton', 'databaseSchemaCancelButton', 'databaseSchemaSearch', 'databaseSchemaTree', 'databaseSchemaLibraryTab', 'databaseSavedLibraryTab', 'databaseHistoryLibraryTab', 'databaseSavedQueryList', 'databaseQueryHistoryList', 'databaseSavedQueryModal', 'databaseSavedQueryForm', 'databaseSchemaActionModal', 'databaseSchemaActionForm', 'databaseSchemaAction', 'databaseSchemaColumns', 'databaseSchemaActionObjectName', 'databaseSchemaActionIndexColumns', 'databaseSchemaActionReferencedTable', 'databaseSchemaActionViewQuery', 'databaseSchemaActionDefinition', 'databasePrincipalModal', 'databasePrincipalForm', 'databasePrincipalAction', 'databasePrincipalName', 'databasePrincipalPassword', 'databasePrincipalScope', 'databasePrincipalPrivileges', 'databasePrincipalInspectButton', 'databasePrincipalGrantInventory']) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(rendererSource, /const isDatabase = view === 'database'/);
  assert.match(rendererSource, /databaseManagerView\.classList\.toggle\('hidden', !isDatabase\)/);
  assert.match(rendererSource, /async function loadDatabaseProfiles\(/);
  assert.match(rendererSource, /async function saveDatabaseProfile\(/);
  assert.match(rendererSource, /async function deleteDatabaseProfile\(/);
  assert.match(rendererSource, /async function resolveDatabaseProfileCloudConflict\(/);
  assert.match(rendererSource, /data-database-profile-conflict-local=/);
  assert.match(rendererSource, /data-database-profile-conflict-cloud=/);
  assert.match(rendererSource, /async function testDatabaseProfile\(/);
  assert.match(rendererSource, /async function toggleDatabaseConnection\(/);
  assert.match(rendererSource, /data-database-profile-connection=/);
  assert.match(rendererSource, /data-database-profile-test=/);
  assert.match(rendererSource, /data-database-profile-bind=/);
  assert.match(rendererSource, /data-database-profile-backup=/);
  assert.match(rendererSource, /async function protectDatabaseProfileWithBackupManager\(/);
  assert.match(rendererSource, /state\.backupManagerTab = 'sources'/);
  assert.match(rendererSource, /openBackupMysqlModal\(connection, prepared\.driverId\)/);
  assert.match(rendererSource, /openBackupSqliteModal\(connection\)/);
  assert.match(rendererSource, /function setDatabaseManagerTab\(/);
  assert.match(rendererSource, /async function executeDatabaseQuery\(/);
  assert.match(rendererSource, /async function cancelDatabaseQuery\(/);
  assert.match(rendererSource, /function requestDatabaseQueryApproval\(/);
  assert.match(rendererSource, /async function loadDatabaseSchema\(/);
  assert.match(rendererSource, /async function cancelDatabaseSchema\(/);
  assert.match(rendererSource, /async function loadDatabaseSchemaCapabilities\(/);
  assert.match(rendererSource, /async function saveDatabaseSchemaAction\(/);
  assert.match(rendererSource, /window\.deployerx\.executeDatabaseSchemaAction\(payload\)/);
  assert.match(rendererSource, /async function loadDatabasePrincipalCapabilities\(/);
  assert.match(rendererSource, /async function openDatabasePrincipalAdministration\(/);
  assert.match(rendererSource, /async function saveDatabasePrincipalAction\(/);
  assert.match(rendererSource, /async function inspectDatabasePrincipalGrants\(/);
  assert.match(rendererSource, /window\.deployerx\.executeDatabasePrincipalAction\(payload\)/);
  assert.match(rendererSource, /function quoteDatabaseIdentifier\(/);
  assert.match(rendererSource, /function insertDatabaseIdentifier\(/);
  assert.match(rendererSource, /function setDatabaseQueryLibraryView\(/);
  assert.match(rendererSource, /async function loadDatabaseSavedQueries\(/);
  assert.match(rendererSource, /async function loadDatabaseQueryHistory\(/);
  assert.match(rendererSource, /async function saveDatabaseSavedQuery\(/);
  assert.match(rendererSource, /async function deleteDatabaseSavedQuery\(/);
  assert.match(rendererSource, /async function clearDatabaseQueryHistory\(/);
  assert.match(rendererSource, /function selectedDatabaseQueryText\(/);
  assert.match(rendererSource, /async function copyDatabaseQueryResults\(/);
  assert.match(rendererSource, /async function exportDatabaseQueryResults\(/);
  assert.match(rendererSource, /function databaseQuerySupportsFullExport\(/);
  assert.match(rendererSource, /window\.deployerx\.exportDatabaseQuery\(/);
  assert.match(rendererSource, /window\.deployerx\.cancelDatabaseQueryExport\(requestId\)/);
  assert.match(rendererSource, /pageSize: Number\(els\.databaseQueryPageSize\.value\) \|\| 100/);
  assert.match(rendererSource, /function handleDatabaseManagerEvent\(/);
  assert.match(rendererSource, /window\.deployerx\?\.onDatabaseManagerEvent\?\.\(handleDatabaseManagerEvent\)/);
  assert.match(rendererSource, /event\.workspaceId !== 'device' && event\.workspaceId !== workspaceId/);
  assert.match(rendererSource, /function ensureDatabaseQueryTabs\(/);
  assert.match(rendererSource, /function addDatabaseQueryTab\(/);
  assert.match(rendererSource, /async function closeDatabaseQueryTab\(/);
  assert.match(rendererSource, /function beginDatabaseQueryTabRename\(/);
  assert.match(rendererSource, /DATABASE_MANAGER_BATCH_REQUIRED/);
  assert.match(rendererSource, /function databaseQueryExecutionResults\(/);
  assert.match(rendererSource, /function initializeDatabaseQueryMonaco\(/);
  assert.match(rendererSource, /function formatDatabaseQueryEditor\(/);
  assert.match(rendererSource, /function databaseQueryCompletionSuggestions\(/);
  assert.match(rendererSource, /function mountDatabaseQueryResultGrid\(/);
  assert.match(rendererSource, /function updateDatabaseQueryResultSelection\(/);
  assert.match(rendererSource, /function openDatabaseQueryValueInspector\(/);
  assert.match(rendererSource, /async function browseDatabaseTable\(/);
  assert.match(rendererSource, /function databaseRowCapability\(/);
  assert.match(rendererSource, /function openDatabaseRowEditor\(/);
  assert.match(rendererSource, /async function saveDatabaseRow\(/);
  assert.match(rendererSource, /async function deleteSelectedDatabaseRows\(/);
  assert.match(rendererSource, /async function loadDatabaseNotebooks\(/);
  assert.match(rendererSource, /async function saveDatabaseNotebook\(/);
  assert.match(rendererSource, /async function runDatabaseNotebookCell\(/);
  assert.match(rendererSource, /function mountDatabaseNotebookMonacoEditors\(/);
  assert.match(rendererSource, /function disposeDatabaseNotebookMonacoEditors\(/);
  assert.match(rendererSource, /function formatDatabaseNotebookCell\(/);
  assert.match(rendererSource, /function databaseNotebookSelectedSql\(/);
  assert.match(rendererSource, /function databaseNotebookChartGraphic\(/);
  assert.match(rendererSource, /function databaseNotebookChart\(/);
  assert.match(rendererSource, /function requestDatabaseNotebookDiscard\(/);
  assert.match(rendererSource, /async function duplicateDatabaseNotebook\(/);
  assert.match(rendererSource, /function moveDatabaseNotebookCell\(/);
  assert.match(rendererSource, /async function loadDatabaseTasks\(/);
  assert.match(rendererSource, /async function cancelDatabaseTask\(/);
  assert.match(rendererSource, /function scheduleDatabaseTaskPoll\(/);
  assert.match(rendererSource, /async function loadDatabaseOperationalLogs\(/);
  assert.match(rendererSource, /function renderDatabaseOperationalLogs\(/);
  assert.match(rendererSource, /window\.deployerx\.listDatabaseOperationalLogs\(/);
  assert.match(rendererSource, /data-database-notebook-collapse/);
  assert.match(rendererSource, /databaseNotebookTags/);
  assert.match(rendererSource, /window\.DOMPurify\.sanitize\(parsed/);
  assert.match(rendererSource, /entry\.editor\.dispose\(\)[\s\S]*entry\.model\.dispose\(\)/);
  assert.match(rendererSource, /source: 'notebook'/);
  assert.match(rendererSource, /window\.deployerx\.mutateDatabaseRows\(payload\)/);
  assert.doesNotMatch(rendererSource, /mutateDatabaseRows\(\{[^}]*query:/);
  assert.match(rendererSource, /function selectedDatabaseQueryTransferResult\(/);
  assert.match(rendererSource, /Run SQL batch/);
  assert.match(htmlSource, /<script src="\.\.\/database-manager\/query-tabs\.js"><\/script>/);
  assert.match(htmlSource, /sql-formatter\/dist\/sql-formatter\.min\.js/);
  assert.match(htmlSource, /marked\/marked\.min\.js/);
  assert.match(htmlSource, /dompurify\/dist\/purify\.min\.js/);
  assert.match(htmlSource, /monaco-editor\/min\/vs\/loader\.js/);
  assert.match(htmlSource, /database-manager\/query-editor-tools\.js/);
  assert.match(htmlSource, /database-manager\/result-grid\.js/);
  assert.match(htmlSource, /worker-src 'self' blob:/);
  assert.match(queryTabsSource, /const MAX_QUERY_TABS = 12/);
  assert.match(queryTabsSource, /function serializeSession\(/);
  assert.match(rendererSource, /mode === 'all'/);
  assert.match(rendererSource, /data-database-table-name=/);
  assert.match(rendererSource, /data-database-table-browse-name=/);
  assert.match(rendererSource, /data-database-column-name=/);
  assert.match(stylesSource, /\.database-profile-table-header,[\s\S]*grid-template-columns:/);
  assert.match(stylesSource, /\.database-query-workspace[\s\S]*grid-template-rows:/);
  assert.match(stylesSource, /\.database-schema-explorer[\s\S]*grid-template-rows:/);
  assert.match(stylesSource, /\.database-library-tabs[\s\S]*grid-template-columns:/);
  assert.match(stylesSource, /\.database-library-item[\s\S]*grid-template-columns:/);
  assert.match(stylesSource, /\.database-query-result-actions[\s\S]*display: flex/);
  assert.match(stylesSource, /\.database-query-tab-strip[\s\S]*grid-template-columns:/);
  assert.match(stylesSource, /\.database-query-tabs[\s\S]*overflow-x: auto/);
  assert.match(stylesSource, /\.database-query-results table/);
  assert.match(stylesSource, /\.database-row-editor-fields[\s\S]*display: grid/);
  assert.match(stylesSource, /\.database-notebook-cells[\s\S]*display: grid/);
  assert.match(stylesSource, /\.database-notebook-chart-controls[\s\S]*grid-template-columns:/);
  assert.match(stylesSource, /\.database-task-list[\s\S]*display: grid/);
  assert.match(stylesSource, /\.database-log-toolbar[\s\S]*grid-template-columns:/);
  assert.match(stylesSource, /\.database-log-entry[\s\S]*grid-template-columns:/);
  assert.match(stylesSource, /\.database-query-editor-host\.monaco-ready \.database-query-editor/);
  assert.match(editorToolsSource, /function formatDatabaseSql\(/);
  assert.match(editorToolsSource, /function buildDatabaseSqlCompletions\(/);
  assert.match(resultGridSource, /const MAX_RENDER_ROWS = 240/);
  assert.match(resultGridSource, /function createVirtualizedGrid\(/);
  assert.match(resultGridSource, /function inspectValue\(/);
  assert.match(stylesSource, /@media \(max-width: 680px\)[\s\S]*\.database-summary/);

  const ids = [...htmlSource.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'renderer HTML must not contain duplicate IDs');
});

test('exposes bundled database plugins only from Database Manager settings', () => {
  for (const id of ['databasePluginSettingsButton', 'settingsDatabasePanel', 'databasePluginsPanel']) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /data-settings-tab="database"/);
  assert.match(htmlSource, /data-settings-panel="database"/);
  assert.doesNotMatch(htmlSource, /databasePluginsTab|settingsPluginsPanel|settingsDatabasePlugins|data-settings-tab="plugins"/);
  for (const pluginId of ['mysql', 'mariadb', 'postgresql', 'supabase', 'mongodb', 'clickhouse', 'redis', 'sqlite']) {
    assert.match(rendererSource, new RegExp(`pluginId: '${pluginId}'`));
  }
  assert.match(rendererSource, /function mergeBundledDatabasePlugins\(/);
  assert.match(rendererSource, /function renderDatabasePlugins\(/);
  assert.match(rendererSource, /databasePluginSettingsButton\?\.addEventListener\('click',[\s\S]*state\.settingsTab = 'database';[\s\S]*showView\('team'\)/);
  assert.match(rendererSource, /state\.settingsTab === 'database'\) loadDatabasePlugins/);
  assert.match(rendererSource, /const isFullPageView = isProfile \|\| isSshFile/);
  assert.match(rendererSource, /function syncSidebarForView\(view = state\.currentView\) \{\s*if \(\['profile', 'ssh-file'\]\.includes\(view\)\)/);
  assert.match(stylesSource, /\.database-plugin-list\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});
