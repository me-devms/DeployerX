const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('keeps a VNC session alive while navigating between servers', async () => {
  const renderer = await fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8');
  const openProject = renderer.slice(
    renderer.indexOf('async function openProject(projectId)'),
    renderer.indexOf('function openCreateModal()')
  );
  const renderStatus = renderer.slice(
    renderer.indexOf('function renderRdpStatus(status, message'),
    renderer.indexOf('function setRdpStatus(status, message)')
  );

  assert.doesNotMatch(openProject, /disconnectRdp|stopRemoteSession/, 'server navigation must not stop a remote session');
  assert.doesNotMatch(renderStatus, /state\.rdpStatus\s*=/, 'inactive server status rendering must not overwrite the retained session');
  assert.match(renderer, /if \(currentSession\) setRdpStatus\(state\.rdpStatus, message\);\s*else renderRdpStatus\('disconnected', message, \{ hasSession: false, resetDisplays: false \}\);/);
});
