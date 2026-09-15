const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const permissions = require('./workspace-permissions');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function mainFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

function accessHarness(overrides = {}) {
  const handlers = new Map();
  const context = vm.createContext({
    ...permissions, URLSearchParams,
    nowIso: () => new Date().toISOString(),
    readSettings: async () => ({ mode: 'cloud', activeTeamId: 'workspace' }),
    requireAuthSession: async () => ({ uid: 'owner' }),
    teamSnapshot: async () => ({ saved: true }),
    recordWorkspaceAudit: async () => {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    ...overrides
  });
  for (const name of ['normalizeWorkspaceRole', 'toFirestoreValue', 'fromFirestoreValue',
    'toFirestoreDocument', 'fromFirestoreDocument', 'firestorePreconditionQuery', 'patchDoc',
    'currentMember', 'ensureTeamPermission', 'ensureActiveWorkspacePermission',
    'workspaceAccessForStorage', 'ensureWorkspaceServerAllowed', 'ensureWorkspaceCommandsAllowed']) {
    vm.runInContext(mainFunction(name), context);
  }
  for (const name of ['auth:changePassword', 'teams:updateMember', 'teams:removeMember', 'projects:save', 'projects:delete',
    'terminal:start', 'ftp:connect', 'deployment:run', 'workspace:commands:validate']) {
    const start = source.indexOf(`ipcMain.handle('${name}'`);
    const end = source.indexOf('\n});', start) + 4;
    if (start < 0 || end < 4) throw new Error(`Missing handler: ${name}`);
    vm.runInContext(source.slice(start, end), context);
  }
  return { context, handlers, call: (name, payload) => handlers.get(name)(null, payload) };
}

module.exports = { accessHarness, mainFunction };
