const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('wires workspace user management and server permission enforcement end to end', async () => {
  const [html, styles, renderer, preload, main, rules] = await Promise.all([
    fs.readFile(path.join(__dirname, 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer', 'styles.css'), 'utf8'),
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
  assert.match(main, /workspaceAccess/);
  assert.match(main, /redactWorkspaceProjectSecrets/);
  assert.match(main, /visibleModules: normalizeWorkspaceModules\(role, membership\.visibleModules\)/);
  assert.match(main, /serverIds: normalizeWorkspaceServers\(role, membership\.serverIds\)/);
  assert.match(main, /const storedMember = \{ \.\.\.member \};\s+delete storedMember\.id;/);
  assert.match(main, /ipcMain\.handle\('ftp:connect'[\s\S]*?ensureActiveWorkspacePermission\('server\.terminal\.open'\)/);
  assert.match(main, /ipcMain\.handle\('vnc:start'[\s\S]*?ensureActiveWorkspacePermission\('server\.terminal\.open'\)/);
  assert.match(main, /ipcMain\.handle\('rdp:start'[\s\S]*?ensureActiveWorkspacePermission\('server\.terminal\.open'\)/);
  assert.match(renderer, /activeWorkspaceCanUseServer/);
  assert.match(renderer, /applyWorkspaceProjectPermissionControls/);
  assert.match(html, /id="workspaceInvitesModal"/);
  assert.match(html, /id="workspaceInvitesReceivedTab"/);
  assert.match(html, /id="workspaceInvitesSentTab"/);
  assert.match(html, /class="workspace-user-modal-main"/);
  assert.match(html, /data-add-user-step-indicator="1"[^>]*aria-current="step"/);
  assert.match(styles, /\.workspace-user-fields > \.field \{\s+align-self: start;\s+align-content: start;/);
  assert.match(styles, /\.workspace-permission-fieldset \{\s+min-width: 0;\s+align-content: start;/);
  assert.match(renderer, /indicator\.setAttribute\('aria-current', 'step'\)/);
  assert.match(renderer, /toggleMemberSuspension/);
  assert.match(main, /'member\.suspended'/);
  assert.match(renderer, /await disconnectAllProjectConnections\(\);\s+const snapshot = await window\.deployerx\.switchTeam\(teamId\)/);
  assert.match(renderer, /applyTeamSnapshot\(snapshot\);\s+resetWorkspaceData\(\);\s+await enterCloudWorkspace\(\)/);
  assert.match(renderer, /Promise\.all\(projectIds\.map\(\(projectId\) => disconnectProjectConnections\(projectId\)\)\)/);
  assert.match(main, /return switchedTeamSnapshot\(nextSettings, auth, team, member\)/);
  assert.match(main, /queueWorkspaceSwitchMaintenance\(previousWorkspaceId, String\(teamId\), auth\.uid\)/);
  assert.match(preload, /workspace:commands:validate/);
  assert.match(rules, /allow delete: if hasTeamPermission\(teamId, 'server\.delete'\)/);
  assert.match(rules, /hasServerAccess\(teamId, projectId\)/);
  assert.match(rules, /function isActiveTeamMember\(teamId\)/);
  assert.match(rules, /'suspended'/);
  assert.match(rules, /resource\.data\.role != 'owner'/);
  assert.match(rules, /request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasOnly/);
});
