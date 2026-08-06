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
  for (const id of ['serverMonitoringView', 'serverMonitoringTrendChart', 'serverMonitoringNetworkChart', 'serverMonitoringStorageTable', 'serverMonitoringProcessTable']) {
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

test('keeps breathing room above the live monitoring dashboard', () => {
  assert.match(styles, /\.server-monitoring-header\s*\{[^}]*padding-block:\s*14px 12px;/s);
  assert.match(styles, /\.server-monitoring-workspace\s*\{[^}]*padding:\s*16px 28px 34px;/s);
});
