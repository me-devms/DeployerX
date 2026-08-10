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

test('places real-time monitoring immediately before Uptime and renders its operational workspace', () => {
  const monitoringButton = html.indexOf('id="serverMonitoringButton"');
  const uptimeButton = html.indexOf('id="uptimeButton"');
  assert.ok(monitoringButton > 0 && monitoringButton < uptimeButton);
  for (const id of ['serverMonitoringView', 'serverMonitoringConnectOverlay', 'serverMonitoringConnectButton', 'serverMonitoringTrendChart', 'serverMonitoringNetworkChart', 'serverMonitoringStorageTable', 'serverMonitoringProcessTable']) {
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

test('gates telemetry behind the persistent terminal SSH connection', () => {
  assert.match(renderer, /getConnectedTerminalSession/);
  assert.match(renderer, /terminalSessionId: terminalSession\.sessionId/);
  assert.match(renderer, /connectServerMonitoringSsh/);
  assert.match(renderer, /serverMonitoringPauseButton\.classList\.toggle\('hidden', !sshConnected\)/);
  assert.match(renderer, /serverMonitoringRefreshButton\.classList\.toggle\('hidden', !sshConnected\)/);
  assert.match(styles, /#serverMonitoringDashboard\.is-ssh-locked[\s\S]*filter: blur\(4px\)/);
  assert.match(main, /activeTerminals\.get\(terminalSessionId\)/);
  assert.match(main, /connection: terminalState\.connection/);
});

test('selects an available SSH server before monitoring or connecting', () => {
  assert.match(renderer, /function resolveServerMonitoringProject\(\)[\s\S]*groupProjects\(\)\.flatMap\(\(group\) => group\.items\)[\s\S]*state\.serverMonitoring\.selectedProjectId[\s\S]*state\.activeProject\?\.id[\s\S]*getConnectedTerminalSession\(project\.id\)[\s\S]*!isVncServerType\(project\.serverType\)/);
  assert.match(renderer, /function syncServerMonitoringProjectSelection\(\)[\s\S]*state\.serverMonitoring\.selectedProjectId = project \? String\(project\.id\) : ''/);
  assert.match(renderer, /async function connectServerMonitoringSsh\(\)[\s\S]*const project = resolveServerMonitoringProject\(\);[\s\S]*await selectServerForMonitoring\(project\.id\)/);
  assert.match(renderer, /if \(isServerMonitoring\)[\s\S]*const monitoringProject = resolveServerMonitoringProject\(\);[\s\S]*selectServerForMonitoring\(monitoringProject\.id\)/);
  assert.match(renderer, /async function refreshProjectsAndTemplates\(\)[\s\S]*const monitoringProject = syncServerMonitoringProjectSelection\(\);[\s\S]*state\.currentView === 'server-monitoring'[\s\S]*await selectServerForMonitoring\(monitoringProject\.id\)/);
  assert.match(renderer, /if \(state\.currentView === 'dashboard'\) showView\('dashboard'\);/);
});

test('forces the server sidebar open and disables its toggle during monitoring', () => {
  assert.match(renderer, /function syncSidebarForView[\s\S]*sidebarToggleButton\.disabled = view === 'server-monitoring'[\s\S]*view === 'server-monitoring'[\s\S]*setSidebarCollapsed\(false, \{ persist: false \}\)/);
  assert.match(renderer, /Sidebar is required for real-time monitoring/);
});

test('keeps breathing room above the live monitoring dashboard', () => {
  assert.match(styles, /\.server-monitoring-header\s*\{[^}]*padding-block:\s*14px 12px;/s);
  assert.match(styles, /\.server-monitoring-workspace\s*\{[^}]*padding:\s*16px 28px 34px;/s);
  assert.match(styles, /\.server-monitoring-connect-overlay\s*\{[^}]*height:\s*calc\(100vh - 58px - var\(--app-header-height\) - 32px\);[^}]*max-height:\s*100%;/s);
});
