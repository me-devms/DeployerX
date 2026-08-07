const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('renders the five-section Uptime operations shell and guided editor', async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8')
  ]);
  assert.equal(html.includes('http-equiv="Content-Security-Policy"'), true, 'renderer content security policy');
  assert.equal(html.includes("script-src 'self'"), true, 'renderer scripts exclude unsafe-eval');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
  for (const tab of ['overview', 'monitors', 'incidents', 'reports', 'maintenance']) {
    assert.equal(html.includes(`data-uptime-tab="${tab}"`), true, `${tab} tab`);
    assert.equal(html.includes(`data-uptime-panel="${tab}"`), true, `${tab} panel`);
  }
  for (const step of ['1', '2', '3']) assert.equal(html.includes(`data-uptime-monitor-step="${step}"`), true, `editor step ${step}`);
  for (const id of ['uptimeLatencyValue', 'uptimeLatencyChart', 'uptimeSelectedMonitorP95']) assert.equal(html.includes(`id="${id}"`), true, `${id} operational metric`);
  const detailLayout = styles.match(/\.uptime-monitor-detail\s*\{([^}]*)\}/)?.[1] || '';
  assert.equal(detailLayout.includes('border-top'), false, 'monitor detail omits the redundant top divider');
  assert.equal(detailLayout.includes('padding-top'), false, 'monitor detail uses the panel top spacing only');
  assert.match(styles, /\.uptime-monitor-detail \.uptime-monitor-actions \.button \{\s+height: 32px;\s+min-height: 32px;/, 'monitor detail actions share one control height');
  assert.equal(html.includes('id="uptimeDeleteMonitorButton" class="button outline danger compact icon-only"'), true, 'Delete uses the same outlined icon-button frame');
  for (const id of ['uptimeMonitorTableCard', 'uptimeMonitorFilterButton', 'uptimeMonitorFilterPanel', 'uptimeClearFiltersButton']) assert.equal(html.includes(`id="${id}"`), true, `${id} table control`);
  for (const id of ['uptimeStateFilterDropdown', 'uptimeTypeFilterDropdown', 'uptimeSortFilterDropdown']) assert.equal(html.includes(`id="${id}" class="top-workspace-switcher uptime-filter-select"`), true, `${id} shared dropdown component`);
  const monitorPanel = html.slice(html.indexOf('data-uptime-panel="monitors"'), html.indexOf('data-uptime-panel="incidents"'));
  assert.equal(monitorPanel.indexOf('class="uptime-table-toolbar"') < monitorPanel.indexOf('id="uptimeMonitorTableWrap"'), true, 'toolbar is integrated before the table area');
  assert.equal(monitorPanel.indexOf('id="uptimeStateFilter"') > monitorPanel.indexOf('id="uptimeMonitorFilterPanel"'), true, 'state filter is inside the collapsible filter panel');
  const incidentPanel = html.slice(html.indexOf('data-uptime-panel="incidents"'), html.indexOf('data-uptime-panel="reports"'));
  assert.equal(incidentPanel.includes('id="uptimeIncidentTableCard" class="uptime-table-card"'), true, 'Incidents uses the standard table card');
  assert.equal(incidentPanel.indexOf('class="uptime-table-toolbar"') < incidentPanel.indexOf('id="uptimeIncidentTableWrap"'), true, 'Incidents toolbar is integrated before the table area');
  assert.equal(incidentPanel.indexOf('id="uptimeIncidentStateFilter"') > incidentPanel.indexOf('id="uptimeIncidentFilterPanel"'), true, 'incident state is inside the Filters popover');
  assert.equal(incidentPanel.indexOf('id="uptimeIncidentsEmpty"') > incidentPanel.indexOf('class="uptime-table-area"'), true, 'incident empty state is inside the table body area');
  const editor = html.slice(html.indexOf('id="uptimeMonitorModal"'), html.indexOf('id="uptimeMaintenanceModal"'));
  assert.equal(editor.includes('JSON object'), false);
  assert.equal(editor.includes('JSON array'), false);
  assert.equal(editor.includes('id="uptimeMonitorTestButton"'), true);
  assert.equal(editor.includes('class="field-grid uptime-http-request-grid"'), true, 'HTTP request controls use their dedicated responsive grid');
  assert.equal(editor.includes('id="uptimeMonitorParentGroup"'), false, 'parent grouping is derived from Server Link');
  assert.equal(editor.indexOf('id="uptimeMonitorProject"') < editor.indexOf('id="uptimeMonitorGroup"'), true, 'Server Link precedes its monitor subgroup');
  assert.equal(html.includes('id="uptimeParentGroupCreateButton"'), false, 'manual parent-group settings are removed');
  assert.match(styles, /\.uptime-monitor-modal-card \{\s+width: min\(920px, calc\(100vw - 32px\)\);/, 'monitor modal provides enough request-field width');
  assert.match(styles, /\.uptime-http-request-grid \{\s+grid-template-columns: minmax\(0, 1fr\) minmax\(200px, 220px\);/, 'redirect selector has a stable wide column');
  assert.match(styles, /\.uptime-report-kpis \{[\s\S]*?grid-auto-rows: 34px;/, 'report KPIs match the compact action height');
  assert.match(styles, /\.uptime-report-kpis > div \{\s+display: flex;[\s\S]*?justify-content: space-between;/, 'report KPI labels and values use opposite alignment');
  assert.equal(html.includes('data-settings-tab="notifications"'), true);
  assert.equal(html.includes('data-settings-tab="monitoring"'), true);
});

test('binds V2 Uptime renderer actions without requiring legacy server selection', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  for (const call of [
    'listUptimeMonitors', 'createUptimeMonitor', 'updateUptimeMonitor', 'deleteUptimeMonitor', 'testUptimeMonitor',
    'runUptimeMonitorNow', 'listUptimeChecks', 'listUptimeIncidents', 'acknowledgeUptimeIncident',
    'listUptimeMaintenance', 'createUptimeMaintenance', 'updateUptimeMaintenance', 'deleteUptimeMaintenance',
    'getUptimeReport', 'exportUptimeCsv', 'exportUptimePdf', 'getUptimeMonitoringSettings', 'updateUptimeMonitoringSettings'
  ]) assert.equal(source.includes(`.${call}`), true, `${call} renderer binding`);
  assert.equal(source.includes("onUptimeNavigate?."), true);
  assert.equal(source.includes("state.uptime.selectedIncidentId = String(target.incidentId || '')"), true, 'notification incident selection');
  assert.equal(source.includes("selectedEntry?.scrollIntoView({ block: 'center' })"), true, 'selected incident focus');
  assert.equal(source.includes('validateUptimeMonitorTarget()'), true, 'guided target validation');
  assert.equal(source.includes('selectedReportMonitor = els.uptimeReportMonitor.value'), true, 'report monitor filter preservation');
  assert.equal(source.includes('selectedReportGroup = els.uptimeReportGroup.value'), true, 'report group filter preservation');
  assert.equal(source.includes('selectedReportProject = els.uptimeReportProject.value'), true, 'report project filter preservation');
  assert.equal(source.includes('listBackupNotificationDeliveries({ monitorId: monitor.id'), true, 'monitor delivery evidence');
  assert.equal(source.includes('uptimeResumeSelectedButton.addEventListener'), true, 'bulk resume action');
  assert.equal(source.includes('uptimeDeleteSelectedButton.addEventListener'), true, 'bulk delete action');
  assert.equal(source.includes('setUptimeMonitorFilterPanel('), true, 'collapsible monitor filter panel');
  assert.equal(source.includes('els.uptimeMonitorFilterPanel.contains(event.target)'), true, 'outside-click filter dismissal');
  assert.equal(source.includes('function renderUptimeMonitorFilterDropdown(config)'), true, 'shared custom filter dropdown rendering');
  assert.equal(source.includes('function filteredUptimeIncidents()'), true, 'incident table search and filter projection');
  assert.equal(source.includes("uptimeClearFiltersButton.addEventListener('click'"), true, 'monitor filter reset action');
  assert.equal(source.includes('function uptimeServerLinkValue(monitor = {})'), true, 'linked server identity provides the parent hierarchy key');
  assert.equal(source.includes('function uptimeGroupHierarchyKey(monitor = {})'), true, 'monitor subgroup is nested beneath the server link');
  assert.equal(source.includes("const parentGroup = projectId ? String(linkedProject?.name || existing?.parentGroup || '').trim() : '';"), true, 'saved compatibility metadata mirrors the linked server name');
});
