const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { normalizeAiDeployment, validateAiDeployment } = require('./ai-deployment');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const sample = (id, projectId, workspaceId = '') => normalizeAiDeployment({
  id, name: id || 'New deployment', projectId, workspaceId, localPath: '/project', agentId: 'codex', prompt: 'Deploy'
});

function fixture() {
  let settings = { mode: 'cloud', activeTeamId: 'fresh', aiDeployments: [
    sample('legacy-a', 'server-a'), sample('owned-a', 'shared-server', 'a'), sample('owned-b', 'server-b', 'b')
  ] };
  const projects = { fresh: [], a: ['server-a', 'shared-server'], b: ['server-b', 'shared-server'], local: [] };
  const context = vm.createContext({
    normalizeAiDeployment, validateAiDeployment, activeAiDeployments: new Map(),
    readSettings: async () => structuredClone(settings),
    writeSettings: async (next) => { settings = structuredClone(next); },
    readCurrentStore: async () => ({ projects: projects[settings.activeTeamId].map((id) => ({ id })) }),
    nowIso: () => new Date().toISOString(), createId: () => 'new-deployment'
  });
  vm.runInContext(source.slice(source.indexOf('function aiDeploymentsFromSettings('), source.indexOf('function workspaceControlCloudRecord(')), context);
  return { context, settings: () => settings, switchTo: (id) => { settings.activeTeamId = id; } };
}

test('fresh workspace is empty and legacy records migrate only with their server', async () => {
  const f = fixture();
  assert.equal((await f.context.listAiDeployments()).length, 0);
  assert.equal(f.settings().aiDeployments.length, 3);
  assert.equal(f.settings().aiDeployments[0].workspaceId, '');
  f.switchTo('a');
  assert.deepEqual(Array.from(await f.context.listAiDeployments(), (item) => item.id), ['legacy-a', 'owned-a']);
  assert.equal(f.settings().aiDeployments[0].workspaceId, 'a');
  f.switchTo('b');
  assert.deepEqual(Array.from(await f.context.listAiDeployments(), (item) => item.id), ['owned-b']);
  f.switchTo('fresh');
  assert.equal((await f.context.listAiDeployments()).length, 0);
  assert.equal(f.settings().aiDeployments.length, 3);
});

test('workspace ownership is enforced for edits, new deployments and deletion', async () => {
  const f = fixture();
  f.switchTo('b');
  await assert.rejects(f.context.saveAiDeployment(sample('owned-a', 'server-b', 'b')), /not found in this workspace/);
  await assert.rejects(f.context.deleteAiDeployment('owned-a'), /not found in this workspace/);
  await assert.rejects(f.context.saveAiDeployment(sample('', 'server-a')), /server is not available in this workspace/);
  const saved = await f.context.saveAiDeployment(sample('', 'server-b', 'a'));
  assert.equal(saved.workspaceId, 'b', 'The backend must assign the active workspace, ignoring supplied ownership');
  await f.context.deleteAiDeployment('owned-b');
  assert.ok(f.settings().aiDeployments.some((item) => item.id === 'owned-a'));
  f.switchTo('a');
  assert.ok(!(await f.context.listAiDeployments()).some((item) => item.id === saved.id));
});

test('switching workspaces during a read does not migrate or return records', async () => {
  const f = fixture();
  f.switchTo('a');
  f.context.readCurrentStore = async () => { f.switchTo('fresh'); return { projects: [{ id: 'server-a' }] }; };
  await assert.rejects(f.context.listAiDeployments(), /Workspace changed/);
  assert.equal(f.settings().aiDeployments[0].workspaceId, '');
});

test('background run updates retain ownership and events stay in their workspace', async () => {
  const f = fixture();
  f.switchTo('b');
  await f.context.updateAiDeploymentStatus('owned-a', 'successful', 'Done', 'private log', 'run-a');
  assert.equal(f.settings().aiDeployments.find((item) => item.id === 'owned-a').workspaceId, 'a');
  assert.ok(!(await f.context.listAiDeployments()).some((item) => item.id === 'owned-a'));
  const events = [];
  f.context.settingsCache = { mode: 'cloud', activeTeamId: 'b' };
  f.context.mainWindow = { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } };
  f.context.activeAiDeployments.set('run-a', { workspaceId: 'a' });
  const start = source.indexOf('function emitAiDeployment(');
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), f.context);
  f.context.emitAiDeployment('run-a', 'log', { message: 'private log' });
  f.context.emitAiDeployment('run-a', 'done', { deployment: sample('owned-a', 'server-a', 'a') });
  assert.equal(events.length, 0);
  f.context.settingsCache.activeTeamId = 'a';
  f.context.emitAiDeployment('run-a', 'log', { message: 'private log' });
  assert.equal(events.length, 1);
});
