const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('places real-time monitoring immediately before Uptime and renders the fleet board', () => {
  const monitoringButton = html.indexOf('id="serverMonitoringButton"');
  const uptimeButton = html.indexOf('id="uptimeButton"');
  assert.ok(monitoringButton > 0 && monitoringButton < uptimeButton);
  for (const id of ['serverMonitoringView', 'serverMonitoringStatus', 'serverMonitoringConnectAllButton', 'serverMonitoringEmpty', 'serverMonitoringBoard']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('binds monitoring navigation, sidebar selection, preload APIs, and main-process handlers', () => {
  assert.match(renderer, /showView\('server-monitoring'\)/);
  assert.match(renderer, /function openSidebarProject/);
  assert.match(renderer, /onServerMonitoringEvent/);
  assert.match(preload, /startServerMonitoring/);
  assert.match(preload, /server-monitoring:event/);
  assert.match(main, /ipcMain\.handle\('server-monitoring:start'/);
  assert.match(main, /serverMonitoringSessionManager\.stopAll\(\)/);
});

test('connects each card through an independent persistent monitoring SSH connection', () => {
  assert.match(renderer, /getConnectedTerminalSession/);
  assert.match(renderer, /monitoringProject\.ssh = \{ \.\.\.monitoringProject\.ssh, \.\.\.selectedUser \}/);
  assert.match(renderer, /data-monitor-connect/);
  assert.match(renderer, /connectServerMonitoringSsh\(project\.id, \{ restart: Boolean\(terminalSession\) \}\)/);
  assert.match(renderer, /async function connectAllServerMonitoring\(\)[\s\S]*state\.serverMonitoring\.order[\s\S]*connectServerMonitoringSsh\(project\.id, \{ useDefaultUser: true \}\)/);
  assert.match(styles, /\.server-monitoring-card-connect/);
  assert.match(main, /connectionConfig: toConnectionConfig\(project\)/);
  assert.match(main, /keepaliveInterval: 15000/);
  assert.doesNotMatch(main, /activeTerminals\.get\(terminalSessionId\)/);
});

test('Connect All bypasses the user prompt and selects each default SSH user', () => {
  assert.match(renderer, /function defaultTerminalUser\(project\)[\s\S]*project\?\.ssh\?\.defaultUserId[\s\S]*users\[0\] \|\| null/);
  assert.match(renderer, /connectServerMonitoringSsh\(project\.id, \{ useDefaultUser: true \}\)/);
  assert.match(renderer, /async function connectTerminal[^{]*options = \{\}\) \{/);
  assert.match(renderer, /const selectedUser = options\.useDefaultUser\s*\? defaultTerminalUser\(project\)\s*:\s*await promptForTerminalUser\(project, terminalSession\)/);
});

test('renders only SSH servers and routes monitoring events by project', () => {
  assert.match(renderer, /function serverMonitoringProjects\(\) \{\s*return state\.projects\.filter\(\(project\) => !isVncServerType\(project\.serverType\)\);\s*\}/);
  assert.match(renderer, /function reconcileServerMonitoringEntries\(\)[\s\S]*const projects = serverMonitoringProjects\(\)[\s\S]*state\.serverMonitoring\.entries/);
  assert.match(renderer, /function renderServerMonitoring\(\)[\s\S]*monitoring\.order[\s\S]*renderServerMonitoringCard/);
  assert.doesNotMatch(renderer, /Add SSH credentials to monitor this server/);
  assert.match(renderer, /function resolveServerMonitoringProject\(\)[\s\S]*groupProjects\(\)\.flatMap\(\(group\) => group\.items\)[\s\S]*state\.serverMonitoring\.selectedProjectId[\s\S]*state\.activeProject\?\.id[\s\S]*getConnectedTerminalSession\(project\.id\)[\s\S]*!isVncServerType\(project\.serverType\)/);
  assert.match(renderer, /function syncServerMonitoringProjectSelection\(\)[\s\S]*state\.serverMonitoring\.selectedProjectId = project \? String\(project\.id\) : ''/);
  assert.match(renderer, /function handleServerMonitoringEvent\(event = \{\}\)[\s\S]*event\.sessionId === entry\.sessionId/);
  assert.match(renderer, /async function refreshProjectsAndTemplates\(\)[\s\S]*const monitoringProject = syncServerMonitoringProjectSelection\(\);[\s\S]*state\.currentView === 'server-monitoring'[\s\S]*await selectServerForMonitoring\(monitoringProject\.id\)/);
});

test('opens the SSH workspace when a server is selected from the sidebar', () => {
  assert.match(renderer, /async function openSidebarProject\(projectId\) \{\s*await openProject\(projectId\);\s*if \(!isVncServerType\(state\.activeProject\?\.serverType\)\) setProjectTab\('ssh'\);\s*\}/);
  assert.match(renderer, /const isActiveProject = state\.currentView === 'project' && state\.activeProject\?\.id === project\.id/);
});

test('persists drag ordering for monitoring cards', () => {
  assert.match(renderer, /SERVER_MONITORING_ORDER_STORAGE_KEY/);
  assert.match(renderer, /card\.draggable = true/);
  assert.match(renderer, /addEventListener\('dragstart'/);
  assert.match(renderer, /addEventListener\('drop'[\s\S]*persistServerMonitoringOrder\(\)/);
  assert.match(styles, /\.server-monitoring-card\.is-dragging/);
  assert.match(styles, /\.server-monitoring-card\.is-drag-target/);
});

test('renders connected servers before connecting and disconnected servers', () => {
  assert.match(renderer, /function serverMonitoringConnectionRank\(project, entry\)[\s\S]*entry\?\.status === 'live'[\s\S]*getConnectedTerminalSession\(project\?\.id\)[\s\S]*return 0/);
  assert.match(renderer, /const displayOrder = monitoring\.order[\s\S]*serverMonitoringConnectionRank\(first\.project, monitoring\.entries\[first\.projectId\]\)[\s\S]*first\.savedIndex - second\.savedIndex/);
  assert.match(renderer, /for \(const \{ projectId, project \} of displayOrder\)/);
});

test('keeps the server sidebar user-controlled during monitoring', () => {
  assert.match(renderer, /function syncSidebarForView[\s\S]*sidebarToggleButton\.disabled = false[\s\S]*const prefersCollapsed = sidebarCollapsedPreference\(\)[\s\S]*setSidebarCollapsed\(prefersCollapsed, \{ persist: false \}\)/);
  assert.doesNotMatch(renderer, /Sidebar is required for real-time monitoring/);
});

test('uses a responsive four-column monitoring board with locked card bodies', () => {
  assert.match(styles, /\.server-monitoring-header\s*\{[^}]*padding-block:\s*14px 12px;/s);
  assert.match(styles, /\.server-monitoring-workspace\s*\{[^}]*padding:\s*16px 28px 34px;/s);
  assert.match(styles, /\.server-monitoring-board\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /\.server-monitoring-card\.is-locked \.server-monitoring-card-content\s*\{[^}]*filter:\s*blur\(4px\);/s);
  assert.match(styles, /\.server-monitoring-card-lock\s*\{[^}]*place-items:\s*center;/s);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.server-monitoring-board,\s*\.server-monitoring-group-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
});

test('uses full-width stacked rows for CPU, memory, storage, and uptime', () => {
  assert.match(renderer, /server-monitoring-card-metrics[\s\S]*monitoringMetric\('CPU'[\s\S]*monitoringMetric\('Memory'[\s\S]*monitoringMetric\('Storage'[\s\S]*monitoringMetric\('Uptime'/);
  assert.doesNotMatch(renderer, /server-monitoring-card-data|server-monitoring-card-insights|server-monitoring-uptime/);
  assert.doesNotMatch(renderer, /server-monitoring-processes|monitoringProcessRows/);
  assert.doesNotMatch(renderer, /server-monitoring-card-details/);
  assert.match(styles, /\.server-monitoring-card-metrics\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  assert.match(styles, /\.server-monitoring-card-metric\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto;/s);
  assert.match(styles, /\.server-monitoring-card-metric > strong\s*\{[^}]*grid-column:\s*3;[^}]*justify-self:\s*end;/s);
  assert.match(styles, /\.server-monitoring-card-metric > small\s*\{[^}]*grid-column:\s*2;[^}]*text-align:\s*right;/s);
  assert.match(styles, /\.server-monitoring-card-body\s*\{[^}]*min-height:\s*224px;/s);
});
