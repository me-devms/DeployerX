const WORKSPACE_PERMISSION_CATALOG = Object.freeze([
  { key: 'server.view', group: 'Servers', label: 'View server details' },
  { key: 'server.create', group: 'Servers', label: 'Create servers' },
  { key: 'server.update', group: 'Servers', label: 'Change server details' },
  { key: 'server.delete', group: 'Servers', label: 'Delete servers' },
  { key: 'server.command.execute', group: 'Commands', label: 'Run saved commands' },
  { key: 'server.terminal.open', group: 'Commands', label: 'Open SSH, FTP, and remote desktop sessions' },
  { key: 'workspace.settings.update', group: 'Workspace', label: 'Change workspace settings' },
  { key: 'members.view', group: 'Users', label: 'View users and invitations' },
  { key: 'members.invite', group: 'Users', label: 'Invite users' },
  { key: 'members.create', group: 'Users', label: 'Create users with a temporary password' },
  { key: 'members.update', group: 'Users', label: 'Change user permissions' },
  { key: 'members.remove', group: 'Users', label: 'Remove users' },
  { key: 'members.promote', group: 'Users', label: 'Promote users to admin' }
]);

const WORKSPACE_MODULE_CATALOG = Object.freeze([
  { key: 'overview', label: 'Overview' },
  { key: 'deployments', label: 'Deployment' },
  { key: 'hosts', label: 'Hosts' },
  { key: 'ssh', label: 'SSH' },
  { key: 'monitoring', label: 'Real-time Monitor' },
  { key: 'uptime', label: 'Uptime' },
  { key: 'backups', label: 'Backup Manager' }
]);

const PERMISSION_KEYS = Object.freeze(WORKSPACE_PERMISSION_CATALOG.map(({ key }) => key));
const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);
const MODULE_KEY_SET = new Set(WORKSPACE_MODULE_CATALOG.map(({ key }) => key));
const MEMBER_DEFAULT_PERMISSIONS = Object.freeze(['server.view']);
const ADMIN_DEFAULT_PERMISSIONS = PERMISSION_KEYS;
const SERVER_DEPENDENT_PERMISSIONS = new Set([
  'server.create',
  'server.update',
  'server.delete',
  'server.command.execute',
  'server.terminal.open'
]);
const MEMBER_DEPENDENT_PERMISSIONS = new Set([
  'members.invite',
  'members.create',
  'members.update',
  'members.remove',
  'members.promote'
]);

function normalizeWorkspacePermissions(role, permissions) {
  if (role === 'owner') return [...PERMISSION_KEYS];
  const defaults = role === 'admin' ? ADMIN_DEFAULT_PERMISSIONS : MEMBER_DEFAULT_PERMISSIONS;
  const source = Array.isArray(permissions) ? permissions : defaults;
  const normalized = [...new Set(source.map(String).filter((permission) => PERMISSION_KEY_SET.has(permission)))];
  if (normalized.some((permission) => SERVER_DEPENDENT_PERMISSIONS.has(permission)) && !normalized.includes('server.view')) {
    normalized.unshift('server.view');
  }
  if (normalized.some((permission) => MEMBER_DEPENDENT_PERMISSIONS.has(permission)) && !normalized.includes('members.view')) {
    normalized.push('members.view');
  }
  return normalized;
}

function hasWorkspacePermission(member, permission) {
  if (!member || !PERMISSION_KEY_SET.has(permission)) return false;
  if (member.role === 'owner') return true;
  if (member.suspended) return false;
  return normalizeWorkspacePermissions(member.role, member.permissions).includes(permission);
}

function normalizeBlockedCommands(commands) {
  return [...new Set((Array.isArray(commands) ? commands : [])
    .map((command) => String(command || '').trim())
    .filter(Boolean))].slice(0, 100);
}

function normalizeWorkspaceAccessIds(values, allowedKeys = null) {
  if (!Array.isArray(values) || values.includes('*')) return ['*'];
  const allowed = allowedKeys ? new Set(allowedKeys) : null;
  return [...new Set(values.map(String).filter((value) => value && (!allowed || allowed.has(value))))];
}

function normalizeWorkspaceModules(role, modules) {
  if (role === 'owner') return ['*'];
  return normalizeWorkspaceAccessIds(modules, MODULE_KEY_SET);
}

function normalizeWorkspaceServers(role, serverIds) {
  if (role === 'owner') return ['*'];
  return normalizeWorkspaceAccessIds(serverIds);
}

function hasScopedAccess(member, values, value) {
  if (!member || !value) return false;
  if (member.role === 'owner') return true;
  if (member.suspended) return false;
  if (!Array.isArray(values) || values.includes('*')) return true;
  return values.includes(String(value));
}

function hasWorkspaceModuleAccess(member, moduleId) {
  return hasScopedAccess(member, member?.visibleModules, moduleId);
}

function hasWorkspaceServerAccess(member, serverId) {
  return hasScopedAccess(member, member?.serverIds, serverId);
}

function canReadWorkspaceProjectSecrets(member) {
  if (!member || member.role === 'owner') return true;
  if (member.suspended) return false;
  return ['server.update', 'server.command.execute', 'server.terminal.open']
    .some((permission) => hasWorkspacePermission(member, permission));
}

function redactWorkspaceProjectSecrets(project) {
  const copy = JSON.parse(JSON.stringify(project || {}));
  for (const sectionName of ['proxy', 'ssh', 'ftp', 'vnc', 'rdp']) {
    const section = copy[sectionName];
    if (!section || typeof section !== 'object') continue;
    for (const field of ['password', 'privateKey', 'passphrase']) {
      if (Object.prototype.hasOwnProperty.call(section, field)) section[field] = '';
    }
    if (Array.isArray(section.users)) {
      section.users = section.users.map((user) => ({
        ...user,
        password: '',
        privateKey: '',
        passphrase: ''
      }));
    }
  }
  return copy;
}

function resolveWorkspaceAccess(team, member, uid) {
  const userId = String(uid || '');
  const isOwner = Boolean(userId && String(team?.ownerUid || '') === userId);
  if (!member && !isOwner) return null;
  const role = isOwner ? 'owner' : member?.role === 'admin' ? 'admin' : 'member';
  return {
    ...(member || {}),
    uid: member?.uid || userId,
    role,
    suspended: role === 'owner' ? false : Boolean(member?.suspended),
    permissions: normalizeWorkspacePermissions(role, member?.permissions),
    blockedCommands: normalizeBlockedCommands(member?.blockedCommands),
    visibleModules: normalizeWorkspaceModules(role, member?.visibleModules),
    serverIds: normalizeWorkspaceServers(role, member?.serverIds)
  };
}

function canAssignWorkspaceAccess(actor, role, permissions, visibleModules = ['*'], serverIds = ['*']) {
  if (!actor || role === 'owner') return false;
  if (actor.role === 'owner') return true;
  if (role === 'admin' && !hasWorkspacePermission(actor, 'members.promote')) return false;
  const modules = normalizeWorkspaceModules(role, visibleModules);
  const servers = normalizeWorkspaceServers(role, serverIds);
  const canAssignModules = modules.includes('*')
    ? !Array.isArray(actor.visibleModules) || actor.visibleModules.includes('*')
    : modules.every((moduleId) => hasWorkspaceModuleAccess(actor, moduleId));
  const canAssignServers = servers.includes('*')
    ? !Array.isArray(actor.serverIds) || actor.serverIds.includes('*')
    : servers.every((serverId) => hasWorkspaceServerAccess(actor, serverId));
  return normalizeWorkspacePermissions(role, permissions).every((permission) => hasWorkspacePermission(actor, permission))
    && canAssignModules
    && canAssignServers;
}

module.exports = {
  WORKSPACE_PERMISSION_CATALOG,
  WORKSPACE_MODULE_CATALOG,
  MEMBER_DEFAULT_PERMISSIONS,
  ADMIN_DEFAULT_PERMISSIONS,
  normalizeWorkspacePermissions,
  normalizeBlockedCommands,
  normalizeWorkspaceModules,
  normalizeWorkspaceServers,
  resolveWorkspaceAccess,
  hasWorkspacePermission,
  hasWorkspaceModuleAccess,
  hasWorkspaceServerAccess,
  canReadWorkspaceProjectSecrets,
  redactWorkspaceProjectSecrets,
  canAssignWorkspaceAccess
};
