const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('wires workspace user management and server permission enforcement end to end', async () => {
  const [html, renderer, preload, main, rules] = await Promise.all([
    fs.readFile(path.join(__dirname, 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'preload.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'firestore.rules'), 'utf8')
  ]);

  for (const id of ['addWorkspaceUserButton', 'addWorkspaceUserForm', 'addWorkspaceUserPermissions', 'addWorkspaceUserModules', 'addWorkspaceUserServers', 'teamMembersList']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(renderer, /submitAddWorkspaceUser/);
  assert.match(renderer, /updateMemberAccess/);
  assert.match(preload, /teams:createUser/);
  assert.match(preload, /teams:updateMember/);
  assert.match(preload, /teams:resetMemberPassword/);
  assert.match(main, /ensureActiveWorkspacePermission\('server\.delete'\)/);
  assert.match(main, /ensureActiveWorkspacePermission\('server\.command\.execute'\)/);
  assert.match(main, /ensureWorkspaceServerAllowed/);
  assert.match(rules, /allow delete: if hasTeamPermission\(teamId, 'server\.delete'\)/);
  assert.match(rules, /hasServerAccess\(teamId, projectId\)/);
  assert.match(rules, /resource\.data\.role != 'owner'/);
});
