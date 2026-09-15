const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMIN_DEFAULT_PERMISSIONS,
  normalizeWorkspacePermissions,
  normalizeBlockedCommands,
  normalizeWorkspaceModules,
  normalizeWorkspaceServers,
  resolveWorkspaceAccess,
  hasWorkspacePermission,
  hasWorkspaceModuleAccess,
  hasWorkspaceServerAccess,
  canAssignWorkspaceAccess
} = require('./workspace-permissions');

test('workspace permissions keep owner full, member restricted, and delegated admin grants bounded', () => {
  assert.equal(hasWorkspacePermission({ role: 'owner', permissions: [] }, 'server.delete'), true);
  assert.deepEqual(normalizeWorkspacePermissions('member'), ['server.view']);
  assert.equal(hasWorkspacePermission({ role: 'admin' }, 'members.promote'), true);

  const restrictedAdmin = { role: 'admin', permissions: ['server.view', 'members.update'] };
  assert.equal(canAssignWorkspaceAccess(restrictedAdmin, 'member', ['server.view']), true);
  assert.equal(canAssignWorkspaceAccess(restrictedAdmin, 'member', ['server.delete']), false);
  assert.equal(canAssignWorkspaceAccess(restrictedAdmin, 'admin', ADMIN_DEFAULT_PERMISSIONS), false);
  assert.equal(canAssignWorkspaceAccess({ role: 'owner' }, 'admin', ADMIN_DEFAULT_PERMISSIONS), true);
  assert.deepEqual(normalizeBlockedCommands([' uptime ', 'uptime', '', 'reboot']), ['uptime', 'reboot']);
});

test('module and server scopes support all access or selected access', () => {
  const selected = resolveWorkspaceAccess({}, {
    role: 'member',
    visibleModules: ['hosts', 'ssh', 'unknown'],
    serverIds: ['server-1']
  }, 'member-1');

  assert.deepEqual(normalizeWorkspaceModules('member', selected.visibleModules), ['hosts', 'ssh']);
  assert.deepEqual(normalizeWorkspaceServers('member', selected.serverIds), ['server-1']);
  assert.equal(hasWorkspaceModuleAccess(selected, 'hosts'), true);
  assert.equal(hasWorkspaceModuleAccess(selected, 'backups'), false);
  assert.equal(hasWorkspaceServerAccess(selected, 'server-1'), true);
  assert.equal(hasWorkspaceServerAccess(selected, 'server-2'), false);
  assert.equal(hasWorkspaceServerAccess({ role: 'member' }, 'server-2'), true);

  const manager = { role: 'admin', permissions: ADMIN_DEFAULT_PERMISSIONS, visibleModules: ['hosts'], serverIds: ['server-1'] };
  assert.equal(canAssignWorkspaceAccess(manager, 'member', ['server.view'], ['hosts'], ['server-1']), true);
  assert.equal(canAssignWorkspaceAccess(manager, 'member', ['server.view'], ['backups'], ['server-1']), false);
  assert.equal(canAssignWorkspaceAccess(manager, 'member', ['server.view'], ['hosts'], ['*']), false);
});

test('workspace ownerUid is authoritative when a membership role is stale', () => {
  const access = resolveWorkspaceAccess(
    { ownerUid: 'owner-1' },
    { uid: 'owner-1', role: 'member', permissions: ['server.view'] },
    'owner-1'
  );

  assert.equal(access.role, 'owner');
  assert.equal(hasWorkspacePermission(access, 'members.create'), true);
  assert.equal(hasWorkspacePermission(access, 'members.invite'), true);
});
