const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800, modal: false, query: false },
  { name: 'desktop-query', width: 1280, height: 800, modal: false, query: true, library: 'schema' },
  { name: 'desktop-schema-action', width: 1280, height: 800, modal: false, query: true, library: 'schema', schemaAction: true },
  { name: 'desktop-principal-action', width: 1280, height: 800, modal: false, query: true, library: 'schema', principalAction: true },
  { name: 'desktop-query-selection', width: 1280, height: 800, modal: false, query: true, library: 'schema', selection: true },
  { name: 'desktop-query-tabs', width: 1280, height: 800, modal: false, query: true, library: 'schema', tabs: true },
  { name: 'desktop-query-batch', width: 1280, height: 800, modal: false, query: true, library: 'schema', batchResults: true },
  { name: 'desktop-query-grid', width: 1280, height: 800, modal: false, query: true, library: 'schema', virtualRows: true },
  { name: 'desktop-saved-queries', width: 1280, height: 800, modal: false, query: true, library: 'saved' },
  { name: 'mobile', width: 390, height: 844, modal: true, query: false },
  { name: 'mobile-query', width: 390, height: 844, modal: false, query: true, library: 'schema' },
  { name: 'mobile-schema-action', width: 390, height: 844, modal: false, query: true, library: 'schema', schemaAction: true },
  { name: 'mobile-principal-action', width: 390, height: 844, modal: false, query: true, library: 'schema', principalAction: true },
  { name: 'mobile-query-selection', width: 390, height: 844, modal: false, query: true, library: 'schema', selection: true },
  { name: 'mobile-query-tabs', width: 390, height: 844, modal: false, query: true, library: 'schema', tabs: true },
  { name: 'mobile-query-batch', width: 390, height: 844, modal: false, query: true, library: 'schema', batchResults: true },
  { name: 'mobile-query-history', width: 390, height: 844, modal: false, query: true, library: 'history' },
  { name: 'mobile-saved-query-modal', width: 390, height: 844, modal: false, query: true, library: 'saved', savedModal: true },
  { name: 'mobile-query-approval', width: 390, height: 844, modal: false, query: true, library: 'schema', approval: true },
  { name: 'mobile-query-batch-approval', width: 390, height: 844, modal: false, query: true, library: 'schema', approval: true, batchApproval: true },
  { name: 'mobile-query-inspector', width: 390, height: 844, modal: false, query: true, library: 'schema', virtualRows: true, inspector: true },
  { name: 'desktop-query-monaco', width: 1280, height: 800, modal: false, query: true, library: 'schema', monaco: true },
  { name: 'mobile-query-monaco', width: 390, height: 844, modal: false, query: true, library: 'schema', monaco: true }
];

async function prepareHtml(outputDirectory) {
  const rendererDirectory = path.join(__dirname, '..', 'renderer');
  let html = await fs.readFile(path.join(rendererDirectory, 'index.html'), 'utf8');
  html = html.replace('./styles.css', pathToFileURL(path.join(rendererDirectory, 'styles.css')).href);
  html = html.replace(/\s*<script[^>]+src="[^"]+"[^>]*><\/script>/g, '');
  const fixtureScripts = [
    path.join(__dirname, '..', '..', 'node_modules', 'sql-formatter', 'dist', 'sql-formatter.min.js'),
    path.join(__dirname, '..', '..', 'node_modules', 'monaco-editor', 'min', 'vs', 'loader.js'),
    path.join(__dirname, 'query-editor-tools.js'),
    path.join(__dirname, 'result-grid.js')
  ].map((scriptPath) => `<script src="${pathToFileURL(scriptPath).href}"></script>`).join('');
  html = html.replace('</body>', `${fixtureScripts}</body>`);
  const htmlPath = path.join(outputDirectory, 'database-manager-ui.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}

function prepareScript() {
  return `(() => {
    document.documentElement.dataset.theme = 'light';
    document.getElementById('startupLoader')?.classList.add('hidden');
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden'));
    document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
    document.getElementById('databaseManagerView').classList.remove('hidden');
    document.getElementById('dashboardButton').classList.remove('active');
    document.getElementById('topDatabasesButton').classList.add('active');
    document.getElementById('databaseProfileCount').textContent = '3';
    document.getElementById('databaseProductionCount').textContent = '1';
    document.getElementById('databaseReadOnlyCount').textContent = '1';
    document.getElementById('databaseProfilesEmpty').classList.add('hidden');
    const rows = [
      ['profile-postgres', 'Production PostgreSQL', 'PostgreSQL', 'db.example.com:5432', 'orders', 'production', 'Read only'],
      ['profile-mysql', 'Staging commerce', 'MySQL / MariaDB', 'mysql.staging.example.com:3306', 'commerce', 'staging', 'Read and write'],
      ['profile-sqlite', 'Local analytics', 'SQLite', 'Local file', 'Local file', 'development', 'Read and write']
    ];
    const list = document.getElementById('databaseProfileList');
    list.classList.remove('hidden');
    list.innerHTML = '<div class="database-profile-table-header" aria-hidden="true"><span>Profile</span><span>Database</span><span>Environment</span><span>Access</span><span>Actions</span></div>' + rows.map((item) => '<div class="database-profile-row" data-database-profile-id="'+item[0]+'"><div class="database-profile-identity"><span class="database-profile-driver-icon"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-database"></use></svg></span><div><strong>'+item[1]+'</strong><small>'+item[2]+' · '+item[3]+'</small></div></div><span class="database-profile-cell" data-label="Database">'+item[4]+'</span><span class="database-environment-badge '+item[5]+'">'+item[5]+'</span><span class="database-access-badge">'+item[6]+'</span><div class="database-profile-actions"><button class="button outline compact icon-only" aria-label="Choose local database file"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-folder-open"></use></svg></button><button class="button outline compact icon-only" aria-label="Protect with Backup Manager"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-save"></use></svg></button><button class="button outline compact icon-only" aria-label="Test profile"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-check"></use></svg></button><button class="button outline compact icon-only" aria-label="Edit profile"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-edit"></use></svg></button><button class="button outline danger compact icon-only" aria-label="Delete profile"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button></div></div>').join('');
    const conflictRow = document.querySelector('[data-database-profile-id="profile-postgres"]');
    conflictRow.querySelector('.database-access-badge').textContent = 'Sync conflict';
    conflictRow.querySelector('.database-profile-actions').innerHTML = '<button class="button outline compact icon-only" aria-label="Keep this device metadata"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-save"></use></svg></button><button class="button outline compact icon-only" aria-label="Use cloud metadata"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-cloud"></use></svg></button>';
  })()`;
}

function modalScript(visible) {
  return `(() => {
    const modal = document.getElementById('databaseProfileModal');
    modal.classList.toggle('hidden', ${visible ? 'false' : 'true'});
    if (${visible ? 'true' : 'false'}) {
      document.getElementById('databaseProfileName').value = 'Production PostgreSQL';
      document.getElementById('databaseProfileHost').value = 'db.example.com';
      document.getElementById('databaseProfileDatabase').value = 'orders';
    }
  })()`;
}

function queryScript(visible, selection = false, tabs = false, batchResults = false, virtualRows = false) {
  const tabMarkup = tabs
    ? '<div class="database-query-tab active dirty"><button class="database-query-tab-main" role="tab" aria-selected="true">Recent orders</button><button class="database-query-tab-close" aria-label="Close Recent orders"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-x"></use></svg></button></div><div class="database-query-tab"><button class="database-query-tab-main" role="tab" aria-selected="false">Customer lookup</button><button class="database-query-tab-close" aria-label="Close Customer lookup"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-x"></use></svg></button></div><div class="database-query-tab"><button class="database-query-tab-main" role="tab" aria-selected="false">Revenue by region</button><button class="database-query-tab-close" aria-label="Close Revenue by region"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-x"></use></svg></button></div>'
    : '<div class="database-query-tab active"><button class="database-query-tab-main" role="tab" aria-selected="true">Query 1</button><button class="database-query-tab-close" aria-label="Close Query 1"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-x"></use></svg></button></div>';
  return `(() => {
    const active = ${visible ? 'true' : 'false'};
    window.__databaseManagerFixtureGrid?.destroy();
    window.__databaseManagerFixtureGrid = null;
    window.__databaseManagerFixtureGridRowCount = 0;
    document.getElementById('databaseConnectionsPanel').classList.toggle('hidden', active);
    document.getElementById('databaseQueryPanel').classList.toggle('hidden', !active);
    document.getElementById('databaseConnectionsTab').classList.toggle('active', !active);
    document.getElementById('databaseQueryTab').classList.toggle('active', active);
    if (active) {
      document.getElementById('databaseQueryProfile').innerHTML = '<option>Production PostgreSQL - PostgreSQL</option>';
      document.getElementById('databaseQueryProfileBadge').textContent = 'production - Read only';
      document.getElementById('databaseQueryProfileBadge').classList.add('production');
      document.getElementById('databaseQueryRunButton').disabled = false;
      document.getElementById('databaseQueryFormatButton').disabled = false;
      document.getElementById('databaseQuerySaveButton').disabled = false;
      document.getElementById('databaseQueryRunLabel').textContent = ${selection ? "'Run selection'" : "'Run'"};
      document.getElementById('databaseQueryRunAllButton').classList.toggle('hidden', ${selection ? 'false' : 'true'});
      document.getElementById('databaseQueryRunAllButton').disabled = false;
      document.getElementById('databaseQueryTabs').innerHTML = ${JSON.stringify(tabMarkup)};
      document.getElementById('databaseQueryEditor').value = ${batchResults ? "'SELECT COUNT(*) FROM orders;\\nSELECT id, customer_email, total_cents, status FROM orders ORDER BY created_at DESC;'" : "'SELECT id, customer_email, total_cents, status, created_at\\nFROM orders\\nORDER BY created_at DESC;'"};
      document.getElementById('databaseQueryResultSet').classList.toggle('hidden', ${batchResults ? 'false' : 'true'});
      document.getElementById('databaseQueryResultSet').innerHTML = ${batchResults ? "'<option>Statement 1</option><option selected>Statement 2</option>'" : "''"};
      document.getElementById('databaseQueryStatus').textContent = '3 rows';
      document.getElementById('databaseQueryTiming').textContent = '18 ms';
      document.getElementById('databaseQueryEmpty').classList.add('hidden');
      document.getElementById('databaseQueryResults').classList.remove('hidden');
      document.getElementById('databaseQueryResults').innerHTML = '<table><thead><tr><th>id<small>BIGINT</small></th><th>customer_email<small>TEXT</small></th><th>total_cents<small>INTEGER</small></th><th>status<small>TEXT</small></th><th>created_at<small>TIMESTAMP</small></th></tr></thead><tbody><tr><td>1042</td><td>ava@example.com</td><td>12900</td><td>paid</td><td>2026-08-05T12:04:11Z</td></tr><tr><td>1041</td><td>sam@example.com</td><td>8450</td><td>processing</td><td>2026-08-05T11:58:32Z</td></tr><tr><td>1040</td><td>lee@example.com</td><td>3200</td><td>paid</td><td>2026-08-05T11:41:09Z</td></tr></tbody></table>';
      if (${virtualRows ? 'true' : 'false'}) {
        const columns = [{ name: 'id', dataType: 'BIGINT' }, { name: 'customer_email', dataType: 'TEXT' }, { name: 'metadata', dataType: 'JSONB' }, { name: 'payload', dataType: 'BLOB' }];
        const rows = Array.from({ length: 1000 }, (_item, index) => [10000 + index, 'user' + index + '@example.com', { status: index % 2 ? 'paid' : 'processing', attempt: index + 1 }, { type: 'binary', byteLength: 64 }]);
        window.__databaseManagerFixtureGrid = DatabaseResultGrid.createVirtualizedGrid({
          container: document.getElementById('databaseQueryResults'), columns, rows,
          selection: { selectedRows: [410], cell: { row: 410, column: 2 } },
          onCellClick: () => {}, onRowClick: () => {}
        });
        window.__databaseManagerFixtureGrid.scrollToRow(410);
        window.__databaseManagerFixtureGridRowCount = rows.length;
        document.getElementById('databaseQueryStatus').textContent = '1000 rows - 1 selected';
      }
      document.getElementById('databaseQueryPagination').classList.toggle('hidden', ${batchResults ? 'true' : 'false'});
      document.getElementById('databaseQueryCopyResultsButton').disabled = false;
      document.getElementById('databaseQueryResultExportFormat').disabled = false;
      document.getElementById('databaseQueryExportResultsButton').disabled = false;
      document.getElementById('databaseSchemaStatus').textContent = '2 objects';
      document.getElementById('databaseSchemaSearch').disabled = false;
      document.getElementById('databaseSchemaEmpty').classList.add('hidden');
      document.getElementById('databaseSchemaTree').classList.remove('hidden');
      document.getElementById('databaseSchemaTree').innerHTML = '<div class="database-schema-group" role="treeitem" aria-expanded="true"><button class="database-schema-node schema" type="button"><svg class="database-schema-chevron expanded" viewBox="0 0 24 24"><use href="#icon-chevron-right"></use></svg><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-database"></use></svg><span>public</span><small>2</small></button><div class="database-schema-children" role="group"><div class="database-schema-table" role="treeitem" aria-expanded="true"><div class="database-schema-table-row"><button class="database-schema-toggle" type="button"><svg class="database-schema-chevron expanded" viewBox="0 0 24 24"><use href="#icon-chevron-right"></use></svg></button><button class="database-schema-node table" type="button"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-file"></use></svg><span>orders</span><small>table</small></button></div><div class="database-schema-columns"><button class="database-schema-column" type="button"><svg class="button-icon primary-key" viewBox="0 0 24 24"><use href="#icon-key"></use></svg><span>id</span><small>BIGINT</small></button><button class="database-schema-column" type="button"><span class="database-schema-column-spacer"></span><span>customer_email</span><small>TEXT - required</small></button><button class="database-schema-column" type="button"><span class="database-schema-column-spacer"></span><span>total_cents</span><small>INTEGER</small></button><button class="database-schema-column" type="button"><span class="database-schema-column-spacer"></span><span>created_at</span><small>TIMESTAMP</small></button></div></div><div class="database-schema-table" role="treeitem" aria-expanded="false"><div class="database-schema-table-row"><button class="database-schema-toggle" type="button"><svg class="database-schema-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-right"></use></svg></button><button class="database-schema-node table" type="button"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-eye"></use></svg><span>daily_revenue</span><small>view</small></button></div></div></div></div>';
    }
  })()`;
}

function inspectorScript(visible) {
  return `(() => {
    const modal = document.getElementById('databaseQueryInspectorModal');
    modal.classList.toggle('hidden', ${visible ? 'false' : 'true'});
    if (${visible ? 'true' : 'false'}) {
      const inspected = DatabaseResultGrid.inspectValue({ status: 'paid', attempts: 3, labels: ['priority', 'operations'] });
      document.getElementById('databaseQueryInspectorTitle').textContent = 'metadata';
      document.getElementById('databaseQueryInspectorMeta').textContent = 'Row 411 - JSONB';
      document.getElementById('databaseQueryInspectorType').textContent = inspected.label + ' - ' + inspected.byteLength + ' bytes';
      document.getElementById('databaseQueryInspectorValue').textContent = inspected.formatted;
    }
  })()`;
}

function monacoScript(visible) {
  const vsUrl = pathToFileURL(path.join(__dirname, '..', '..', 'node_modules', 'monaco-editor', 'min', 'vs')).href;
  return `new Promise((resolve) => {
    const host = document.getElementById('databaseQueryEditorHost');
    const container = document.getElementById('databaseQueryMonaco');
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (!${visible ? 'true' : 'false'}) {
      host.classList.remove('monaco-ready');
      container.classList.add('hidden');
      resolve(true);
      return;
    }
    const mount = () => {
      if (!window.__databaseManagerFixtureMonaco) {
        const model = monaco.editor.createModel('', 'sql');
        const editor = monaco.editor.create(container, {
          model, theme: 'vs-light', minimap: { enabled: false }, automaticLayout: true,
          fontFamily: "Consolas, 'Courier New', monospace", fontSize: 13, lineHeight: 21,
          lineNumbersMinChars: 3, padding: { top: 12, bottom: 12 }, scrollBeyondLastLine: false
        });
        window.__databaseManagerFixtureMonaco = { model, editor };
      }
      const instance = window.__databaseManagerFixtureMonaco;
      const formatted = DatabaseQueryEditorTools.formatDatabaseSql(document.getElementById('databaseQueryEditor').value, 'postgresql', sqlFormatter);
      instance.model.setValue(formatted);
      window.__databaseManagerFixtureCompletionCount = DatabaseQueryEditorTools.buildDatabaseSqlCompletions({ schemas: [{ name: 'public', tables: [{ name: 'orders', type: 'table', columns: [{ name: 'id', dataType: 'BIGINT' }] }] }] }, 'postgresql').length;
      container.classList.remove('hidden');
      host.classList.add('monaco-ready');
      instance.editor.setScrollTop(0);
      instance.editor.setPosition({ lineNumber: 1, column: 1 });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        instance.editor.layout();
        instance.editor.setScrollTop(0);
        resolve(true);
      }));
    };
    if (window.monaco?.editor) mount();
    else {
      require.config({ paths: { vs: ${JSON.stringify(vsUrl)} } });
      require(['vs/editor/editor.main'], mount, () => resolve(false));
    }
  })`;
}

function approvalScript(visible, batch = false) {
  return `(() => {
    const modal = document.getElementById('databaseQueryApprovalModal');
    modal.classList.toggle('hidden', ${visible ? 'false' : 'true'});
    if (${visible ? 'true' : 'false'}) {
      document.getElementById('databaseQueryApprovalTitle').textContent = ${batch ? "'Run SQL batch'" : "'Confirm production change'"};
      document.getElementById('databaseQueryApprovalProfile').textContent = 'Production PostgreSQL';
      document.getElementById('databaseQueryApprovalClassification').textContent = ${batch ? "'3 statements'" : "'destructive'"};
      document.getElementById('databaseQueryApprovalClassification').className = 'database-query-classification ${batch ? 'batch' : 'destructive'}';
      document.getElementById('databaseQueryApprovalSql').textContent = ${batch ? "'UPDATE orders SET archived = 1 WHERE created_at < date(\\\'now\\\', \\\'-1 year\\\');\\nDELETE FROM order_events WHERE created_at < date(\\\'now\\\', \\\'-1 year\\\');\\nVACUUM;'" : "'DROP TABLE archived_orders;'"};
      document.getElementById('databaseQueryApprovalTypedField').classList.toggle('hidden', ${batch ? 'true' : 'false'});
      document.getElementById('databaseQueryApprovalTypedName').value = ${batch ? "''" : "'Production PostgreSQL'"};
      document.getElementById('databaseQueryApprovalRunLabel').textContent = ${batch ? "'Run batch'" : "'Run query'"};
      document.getElementById('databaseQueryApprovalRunButton').classList.toggle('danger', true);
    }
  })()`;
}

function libraryScript(view = 'schema') {
  return `(() => {
    const active = '${view}';
    const entries = [['schema', 'databaseSchemaLibraryTab', 'databaseSchemaLibraryPanel'], ['saved', 'databaseSavedLibraryTab', 'databaseSavedLibraryPanel'], ['history', 'databaseHistoryLibraryTab', 'databaseHistoryLibraryPanel']];
    entries.forEach(([name, tabId, panelId]) => {
      document.getElementById(tabId).classList.toggle('active', name === active);
      document.getElementById(panelId).classList.toggle('hidden', name !== active);
    });
    document.getElementById('databaseHistoryClearButton').classList.toggle('hidden', active !== 'history');
    if (active === 'saved') {
      document.getElementById('databaseSchemaStatus').textContent = '2 saved queries';
      document.getElementById('databaseSavedQueryEmpty').classList.add('hidden');
      document.getElementById('databaseSavedQueryList').classList.remove('hidden');
      document.getElementById('databaseSavedQueryList').innerHTML = '<div class="database-library-item active"><button class="database-library-open"><strong>Recent paid orders</strong><span>Orders requiring operations review</span><small>operations - reporting</small></button><div class="database-library-item-actions"><button class="button outline compact icon-only" aria-label="Edit Recent paid orders"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-edit"></use></svg></button><button class="button outline danger compact icon-only" aria-label="Delete Recent paid orders"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button></div></div><div class="database-library-item"><button class="database-library-open"><strong>Daily revenue</strong><span>Revenue totals by day and currency</span><small>finance</small></button><div class="database-library-item-actions"><button class="button outline compact icon-only" aria-label="Edit Daily revenue"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-edit"></use></svg></button><button class="button outline danger compact icon-only" aria-label="Delete Daily revenue"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button></div></div>';
    }
    if (active === 'history') {
      document.getElementById('databaseSchemaStatus').textContent = '3 history items';
      document.getElementById('databaseQueryHistoryEmpty').classList.add('hidden');
      document.getElementById('databaseQueryHistoryList').classList.remove('hidden');
      document.getElementById('databaseQueryHistoryList').innerHTML = '<div class="database-library-item history succeeded"><button class="database-library-open"><strong>SELECT * FROM orders ORDER BY created_at DESC</strong><span><span class="database-history-status succeeded">succeeded</span> read - 18 ms</span><small>05/08/2026, 12:04:11</small></button></div><div class="database-library-item history failed"><button class="database-library-open"><strong>SELECT * FROM missing_table</strong><span><span class="database-history-status failed">failed</span> read - 4 ms</span><small>05/08/2026, 11:58:32 - Query failed.</small></button></div><div class="database-library-item history succeeded"><button class="database-library-open"><strong>SELECT COUNT(*) FROM customers</strong><span><span class="database-history-status succeeded">succeeded</span> read - 9 ms</span><small>05/08/2026, 11:41:09</small></button></div>';
    }
  })()`;
}

function savedQueryModalScript(visible) {
  return `(() => {
    const modal = document.getElementById('databaseSavedQueryModal');
    modal.classList.toggle('hidden', ${visible ? 'false' : 'true'});
    if (${visible ? 'true' : 'false'}) {
      document.getElementById('databaseSavedQueryModalTitle').textContent = 'Update saved query';
      document.getElementById('databaseSavedQueryModalProfile').textContent = 'Production PostgreSQL';
      document.getElementById('databaseSavedQueryName').value = 'Recent paid orders';
      document.getElementById('databaseSavedQueryDescription').value = 'Orders requiring operations review';
      document.getElementById('databaseSavedQueryTags').value = 'operations, reporting';
    }
  })()`;
}

function schemaActionScript(visible) {
  return `(() => {
    const modal = document.getElementById('databaseSchemaActionModal');
    modal.classList.toggle('hidden', ${visible ? 'false' : 'true'});
    if (${visible ? 'true' : 'false'}) {
      document.getElementById('databaseSchemaActionProfile').textContent = 'Production PostgreSQL - PostgreSQL';
      document.getElementById('databaseSchemaAction').innerHTML = '<option selected>Create table</option><option>Rename table</option><option>Add column</option>';
      document.getElementById('databaseSchemaActionSchema').value = 'public';
      document.getElementById('databaseSchemaActionTable').value = 'audit_events';
      document.getElementById('databaseSchemaColumnsSection').classList.remove('hidden');
      document.getElementById('databaseSchemaColumns').innerHTML = '<div class="database-schema-column-editor"><label class="field"><span>Name</span><input value="id"></label><label class="field"><span>Data type</span><input value="BIGINT"></label><label class="database-schema-column-option"><input type="checkbox"> Nullable</label><label class="database-schema-column-option"><input type="checkbox" checked> Primary key</label><label class="database-schema-column-option"><input type="checkbox"> Unique</label><button class="button outline danger compact icon-only" type="button" aria-label="Remove column"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button></div><div class="database-schema-column-editor"><label class="field"><span>Name</span><input value="created_at"></label><label class="field"><span>Data type</span><input value="TIMESTAMP"></label><label class="database-schema-column-option"><input type="checkbox" checked> Nullable</label><label class="database-schema-column-option"><input type="checkbox"> Primary key</label><label class="database-schema-column-option"><input type="checkbox"> Unique</label><button class="button outline danger compact icon-only" type="button" aria-label="Remove column"><svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-trash"></use></svg></button></div>';
    }
  })()`;
}

function principalActionScript(visible) {
  return `(() => {
    const modal = document.getElementById('databasePrincipalModal');
    modal.classList.toggle('hidden', ${visible ? 'false' : 'true'});
    if (${visible ? 'true' : 'false'}) {
      document.getElementById('databasePrincipalProfile').textContent = 'Production PostgreSQL - PostgreSQL';
      document.getElementById('databasePrincipalAction').innerHTML = '<option selected>Create user or role</option><option>Grant privileges</option><option>Drop user or role</option>';
      document.getElementById('databasePrincipalNameLabel').textContent = 'Role';
      document.getElementById('databasePrincipalName').value = 'operations_reporter';
      document.getElementById('databasePrincipalPasswordField').classList.remove('hidden');
      document.getElementById('databasePrincipalPassword').innerHTML = '<option selected>Operations reporting password</option>';
      document.getElementById('databasePrincipalValidUntilField').classList.remove('hidden');
      document.getElementById('databasePrincipalValidUntil').value = '2027-12-31T23:59';
      document.getElementById('databasePrincipalRoleOptions').classList.remove('hidden');
      document.getElementById('databasePrincipalGrantInventoryStatus').textContent = '3 visible grants';
      document.getElementById('databasePrincipalGrantInventory').innerHTML = '<div class="database-principal-grant-row"><strong>SELECT</strong><span>analytics.daily_revenue</span><small>table</small></div><div class="database-principal-grant-row"><strong>USAGE</strong><span>analytics.reporting_sequence</span><small>sequence - grantable</small></div><div class="database-principal-grant-row"><strong>MEMBER</strong><span>reporting</span><small>role</small></div>';
    }
  })()`;
}

function measurementScript(modalVisible, queryVisible, approvalVisible, savedModalVisible, inspectorVisible, schemaActionVisible, principalActionVisible) {
  return `(() => {
    const visible = (element) => element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const overlaps = (left, right) => {
      if (!visible(left) || !visible(right)) return false;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    };
    const header = document.querySelector('.database-manager-view-header');
    const list = document.getElementById('databaseProfileList').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.database-profile-row')].map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const clippedText = [...document.querySelectorAll('.database-manager-view h1, .database-manager-view .button, .database-profile-row strong')]
      .filter(visible)
      .filter((element) => element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).textOverflow !== 'ellipsis')
      .map((element) => element.textContent.trim()).filter(Boolean);
    const modal = document.querySelector('#databaseProfileModal .modal-card');
    const modalRect = ${modalVisible ? 'modal.getBoundingClientRect()' : 'null'};
    const queryWorkspace = document.querySelector('.database-query-workspace');
    const queryRect = ${queryVisible ? 'queryWorkspace.getBoundingClientRect()' : 'null'};
    const schemaExplorer = document.getElementById('databaseSchemaExplorer');
    const editorPane = document.querySelector('.database-query-editor-pane');
    const resultsPane = document.querySelector('.database-query-results-pane');
    const workspaceRegions = ${queryVisible ? '[schemaExplorer, editorPane, resultsPane]' : '[]'};
    const queryControls = [...document.querySelectorAll('.database-query-toolbar > *')].filter(visible);
    const queryActionControls = [...document.querySelectorAll('.database-query-actions > *')].filter(visible);
    const resultActionControls = [...document.querySelectorAll('.database-query-result-actions > *')].filter(visible);
    const queryTabStrip = document.querySelector('.database-query-tab-strip');
    const queryTabList = document.getElementById('databaseQueryTabs');
    const queryTabNew = document.getElementById('databaseQueryNewTabButton');
    const queryEditor = document.getElementById('databaseQueryEditor');
    const approvalModal = document.querySelector('#databaseQueryApprovalModal .modal-card');
    const approvalRect = ${approvalVisible ? 'approvalModal.getBoundingClientRect()' : 'null'};
    const savedQueryModal = document.querySelector('#databaseSavedQueryModal .modal-card');
    const savedQueryModalRect = ${savedModalVisible ? 'savedQueryModal.getBoundingClientRect()' : 'null'};
    const inspectorModal = document.querySelector('#databaseQueryInspectorModal .modal-card');
    const inspectorModalRect = ${inspectorVisible ? 'inspectorModal.getBoundingClientRect()' : 'null'};
    const schemaActionModal = document.querySelector('#databaseSchemaActionModal .modal-card');
    const schemaActionModalRect = ${schemaActionVisible ? 'schemaActionModal.getBoundingClientRect()' : 'null'};
    const principalActionModal = document.querySelector('#databasePrincipalModal .modal-card');
    const principalActionModalRect = ${principalActionVisible ? 'principalActionModal.getBoundingClientRect()' : 'null'};
    const principalGrantList = document.getElementById('databasePrincipalGrantInventory');
    const principalGrantRows = ${principalActionVisible ? "[...principalGrantList.querySelectorAll('.database-principal-grant-row')]" : '[]'};
    return {
      viewport: { width: innerWidth, height: innerHeight },
      bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      headerOverlap: overlaps(header?.firstElementChild, header?.querySelector('.header-actions')),
      rowsInsideList: rows.every((row) => row.left >= list.left - 1 && row.right <= list.right + 1),
      rowsOverlap: rows.some((row, index) => rows.slice(index + 1).some((other) => Math.min(row.bottom, other.bottom) - Math.max(row.top, other.top) > 1)),
      clippedText,
      modalFits: modalRect ? modalRect.left >= 0 && modalRect.right <= innerWidth && modalRect.top >= 0 && modalRect.bottom <= innerHeight : true,
      queryControlsOverlap: queryControls.some((control, index) => queryControls.slice(index + 1).some((other) => overlaps(control, other))),
      queryActionsOverlap: queryActionControls.some((control, index) => queryActionControls.slice(index + 1).some((other) => overlaps(control, other))),
      resultActionsOverlap: resultActionControls.some((control, index) => resultActionControls.slice(index + 1).some((other) => overlaps(control, other))),
      queryTabControlsOverlap: overlaps(queryTabList, queryTabNew),
      queryTabStripFits: ${queryVisible ? '(() => { const strip = queryTabStrip.getBoundingClientRect(); const pane = editorPane.getBoundingClientRect(); return strip.left >= pane.left - 1 && strip.right <= pane.right + 1 && strip.top >= pane.top - 1 && strip.bottom <= pane.bottom + 1; })()' : 'true'},
      queryTabEditorOverlap: ${queryVisible ? 'overlaps(queryTabStrip, queryEditor)' : 'false'},
      queryWorkspaceFits: queryRect ? queryRect.left >= 0 && queryRect.right <= innerWidth : true,
      queryRegionsInsideWorkspace: queryRect ? workspaceRegions.every((region) => { const rect = region.getBoundingClientRect(); return rect.left >= queryRect.left - 1 && rect.right <= queryRect.right + 1 && rect.top >= queryRect.top - 1 && rect.bottom <= queryRect.bottom + 1; }) : true,
      queryRegionsOverlap: workspaceRegions.some((region, index) => workspaceRegions.slice(index + 1).some((other) => overlaps(region, other))),
      approvalFits: approvalRect ? approvalRect.left >= 0 && approvalRect.right <= innerWidth && approvalRect.top >= 0 && approvalRect.bottom <= innerHeight : true,
      savedQueryModalFits: savedQueryModalRect ? savedQueryModalRect.left >= 0 && savedQueryModalRect.right <= innerWidth && savedQueryModalRect.top >= 0 && savedQueryModalRect.bottom <= innerHeight : true
      ,inspectorFits: inspectorModalRect ? inspectorModalRect.left >= 0 && inspectorModalRect.right <= innerWidth && inspectorModalRect.top >= 0 && inspectorModalRect.bottom <= innerHeight : true
      ,schemaActionFits: schemaActionModalRect ? schemaActionModalRect.left >= 0 && schemaActionModalRect.right <= innerWidth && schemaActionModalRect.top >= 0 && schemaActionModalRect.bottom <= innerHeight : true
      ,principalActionFits: principalActionModalRect ? principalActionModalRect.left >= 0 && principalActionModalRect.right <= innerWidth && principalActionModalRect.top >= 0 && principalActionModalRect.bottom <= innerHeight : true
      ,principalGrantRowsFit: principalGrantRows.every((row) => row.scrollWidth <= row.clientWidth + 1)
      ,resultGridRenderedRowCount: document.querySelectorAll('.database-result-data-row').length
      ,resultGridRowCount: Number(window.__databaseManagerFixtureGridRowCount || 0)
      ,resultGridScrollable: window.__databaseManagerFixtureGrid ? document.getElementById('databaseQueryResults').scrollHeight > document.getElementById('databaseQueryResults').clientHeight : true
      ,monacoVisible: ${queryVisible ? "document.getElementById('databaseQueryEditorHost').classList.contains('monaco-ready') ? visible(document.querySelector('.monaco-editor')) : true" : 'true'}
      ,monacoHasText: ${queryVisible ? "document.getElementById('databaseQueryEditorHost').classList.contains('monaco-ready') ? document.querySelector('.monaco-editor .view-lines')?.textContent.includes('SELECT') === true : true" : 'true'}
      ,monacoInsideHost: ${queryVisible ? "document.getElementById('databaseQueryEditorHost').classList.contains('monaco-ready') ? (() => { const editor = document.querySelector('.monaco-editor').getBoundingClientRect(); const host = document.getElementById('databaseQueryEditorHost').getBoundingClientRect(); return editor.left >= host.left - 1 && editor.right <= host.right + 1 && editor.top >= host.top - 1 && editor.bottom <= host.bottom + 1; })() : true" : 'true'}
      ,monacoGeometry: ${queryVisible ? "document.getElementById('databaseQueryEditorHost').classList.contains('monaco-ready') ? (() => { const host = document.getElementById('databaseQueryEditorHost').getBoundingClientRect(); const editor = document.querySelector('.monaco-editor').getBoundingClientRect(); const lines = document.querySelector('.monaco-editor .view-lines')?.getBoundingClientRect(); const textarea = document.getElementById('databaseQueryEditor').getBoundingClientRect(); return { host: { top: host.top, bottom: host.bottom, height: host.height }, editor: { top: editor.top, bottom: editor.bottom, height: editor.height }, lines: lines ? { top: lines.top, bottom: lines.bottom, height: lines.height } : null, textarea: { top: textarea.top, bottom: textarea.bottom, height: textarea.height }, scrollY: window.scrollY, textareaVisibility: getComputedStyle(document.getElementById('databaseQueryEditor')).visibility }; })() : null" : 'null'}
      ,monacoTextFramed: ${queryVisible ? "document.getElementById('databaseQueryEditorHost').classList.contains('monaco-ready') ? (() => { const editor = document.querySelector('.monaco-editor').getBoundingClientRect(); const firstLine = document.querySelector('.monaco-editor .view-line')?.getBoundingClientRect(); return Boolean(firstLine && firstLine.top >= editor.top - 2 && firstLine.top < editor.bottom && firstLine.bottom <= editor.bottom + 2); })() : true" : 'true'}
      ,monacoCompletionCount: Number(window.__databaseManagerFixtureCompletionCount || 0)
    };
  })()`;
}

async function main() {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('Database Manager UI fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const htmlPath = await prepareHtml(outputDirectory);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f6f7fb' });
  try {
    await window.loadFile(htmlPath);
    await window.webContents.executeJavaScript(prepareScript());
    const results = [];
    for (const viewport of VIEWPORTS) {
      window.setContentSize(viewport.width, viewport.height);
      await window.webContents.executeJavaScript(queryScript(viewport.query, viewport.selection, viewport.tabs, viewport.batchResults, viewport.virtualRows));
      await window.webContents.executeJavaScript(libraryScript(viewport.library || 'schema'));
      await window.webContents.executeJavaScript(modalScript(viewport.modal));
      await window.webContents.executeJavaScript(approvalScript(viewport.approval, viewport.batchApproval));
      await window.webContents.executeJavaScript(savedQueryModalScript(viewport.savedModal));
      await window.webContents.executeJavaScript(inspectorScript(viewport.inspector));
      await window.webContents.executeJavaScript(schemaActionScript(viewport.schemaAction));
      await window.webContents.executeJavaScript(principalActionScript(viewport.principalAction));
      await window.webContents.executeJavaScript(monacoScript(viewport.monaco));
      if ((viewport.tabs || viewport.batchResults || viewport.monaco || viewport.virtualRows) && viewport.width <= 680) {
        await window.webContents.executeJavaScript("document.querySelector('.database-query-editor-pane').scrollIntoView({ block: 'start' })");
      }
      await window.webContents.executeJavaScript(`${viewport.width > 680 ? "document.documentElement.scrollTop = 0; document.body.scrollTop = 0;" : ''} new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const measurement = await window.webContents.executeJavaScript(measurementScript(viewport.modal, viewport.query, viewport.approval, viewport.savedModal, viewport.inspector, viewport.schemaAction, viewport.principalAction));
      const image = await window.webContents.capturePage();
      const outputPath = path.join(outputDirectory, `database-manager-${viewport.name}.png`);
      await fs.writeFile(outputPath, image.toPNG());
      results.push({ name: viewport.name, ...measurement, outputPath, byteLength: image.toPNG().length });
    }
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
