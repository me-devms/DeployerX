const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { accessHarness, mainFunction } = require('./workspace-access-test-helpers');
const { ADMIN_DEFAULT_PERMISSIONS } = require('./workspace-permissions');

function fixture(actor = {}) {
  const members = new Map([
    ['owner', { uid:'owner', role:'owner' }],
    ['actor', { uid:'actor', role:'member', permissions:['server.view'], visibleModules:['hosts','ssh'], serverIds:['server-a'], ...actor }],
    ['target', { uid:'target', role:'member', permissions:['server.view'], visibleModules:['hosts'], serverIds:['server-a'], email:'target@example.test', id:'target', extra:'keep' }]
  ]);
  const effects = [];
  const projects = [{id:'server-a',name:'A'}, {id:'server-b',name:'B'}];
  const harness = accessHarness({
    requireAuthSession: async () => ({uid:'actor',idToken:'test-token'}),
    getDoc: async segments => segments.length === 2 ? {ownerUid:'owner'} : members.get(segments[3]),
    readCurrentStore: async () => { throw new Error('Unscoped workspace read'); },
    readCloudStoreForMember: async member => ({projects:projects.filter(p => member.serverIds.includes('*') || member.serverIds.includes(p.id))}),
    normalizeStoredProject: p => p,
    ensureActiveTeamUnlocked: async () => 'workspace',
    prepareCloudProjectForSave: p => p,
    pruneRemovedMonitorArtifacts: async () => {},
    emitUptimeEvent: () => {},
    deleteProjectFromCurrentStore: async id => effects.push(['delete',id]),
    startTerminal: async project => effects.push(['terminal', project.id]),
    connectFtp: async project => { effects.push(['ftp',project.id]); return {sessionId:'ftp-test'}; },
    executeDeployment: async project => effects.push(['run',project.id]),
    deleteDoc: async segments => effects.push(['remove',segments.at(-1)]),
    removeUserTeamRef: async () => {},
    firestoreFetch: async (segments, options) => {
      effects.push(['write',segments,options]);
      return {name:segments.join('/'),fields:JSON.parse(options.body).fields};
    }
  });
  return {...harness, members, effects};
}

test('view-only user can view an assigned server but cannot edit, delete, connect, or run commands', async () => {
  const f = fixture();
  assert.equal((await f.context.ensureActiveWorkspacePermission('server.view')).uid, 'actor');
  for (const [channel,payload] of [
    ['projects:save',{id:'server-a',name:'Changed'}], ['projects:delete','server-a'],
    ['terminal:start',{project:{id:'server-a'}}], ['deployment:run',{project:{id:'server-a',commands:['uptime']}}]
  ]) await assert.rejects(() => f.call(channel,payload), /permission/);
  const ftp = await f.call('ftp:connect',{project:{id:'server-a'}});
  assert.equal(ftp.ok,false);
  assert.equal(f.effects.length,0);
});

test('single-server editor saves the assigned server without an unscoped workspace read', async () => {
  const f = fixture({permissions:['server.view','server.update']});
  const saved = await f.call('projects:save',{id:'server-a',name:'Updated'});
  assert.equal(saved.name,'Updated');
  assert.equal(f.effects.length,1);
  await assert.rejects(() => f.call('projects:save',{id:'server-b'}), /permission|access/);
  await assert.rejects(() => f.call('projects:delete','server-a'), /permission/);
  assert.equal(f.effects.length,1);
});

test('each granted server operation works only on assigned servers', async () => {
  const f = fixture({permissions:ADMIN_DEFAULT_PERMISSIONS});
  for (const [channel,payload] of [
    ['projects:delete','server-a'], ['terminal:start',{project:{id:'server-a'}}],
    ['deployment:run',{project:{id:'server-a',commands:['uptime']}}]
  ]) await f.call(channel,payload);
  assert.equal((await f.call('ftp:connect',{project:{id:'server-a'}})).ok,true);
  const count = f.effects.length;
  for (const [channel,payload] of [
    ['projects:delete','server-b'], ['terminal:start',{project:{id:'server-b'}}],
    ['deployment:run',{project:{id:'server-b',commands:['uptime']}}]
  ]) await assert.rejects(() => f.call(channel,payload), /access to this server/);
  assert.equal((await f.call('ftp:connect',{project:{id:'server-b'}})).ok,false);
  assert.equal(f.effects.length,count);
});

test('empty server scope denies every operation even with all action permissions', async () => {
  const f = fixture({permissions:ADMIN_DEFAULT_PERMISSIONS,serverIds:[]});
  for (const [channel,payload] of [
    ['projects:save',{id:'server-a'}], ['projects:delete','server-a'],
    ['terminal:start',{project:{id:'server-a'}}], ['deployment:run',{project:{id:'server-a',commands:['uptime']}}]
  ]) await assert.rejects(() => f.call(channel,payload), /access/);
  assert.equal(f.effects.length,0);
});

test('fresh membership is checked after suspension, revocation, or permission removal', async () => {
  const f = fixture({permissions:['server.view','server.delete']});
  await f.call('projects:delete','server-a');
  const actor = f.members.get('actor');
  actor.suspended = true;
  await assert.rejects(() => f.call('projects:delete','server-a'), /suspended/);
  actor.suspended = false;
  actor.permissions = ['server.view'];
  await assert.rejects(() => f.call('projects:delete','server-a'), /permission/);
  f.members.delete('actor');
  await assert.rejects(() => f.call('projects:delete','server-a'), /permission/);
  assert.equal(f.effects.length,1);
});

test('saved-command restrictions reject exact blocked commands and allow permitted commands', async () => {
  const f = fixture({permissions:['server.view','server.command.execute'],blockedCommands:['reboot']});
  await f.call('workspace:commands:validate',{projectId:'server-a',commands:['uptime']});
  await assert.rejects(() => f.call('deployment:run',{project:{id:'server-a',commands:[' uptime ',' reboot ']}}), /command is blocked/);
  assert.equal(f.effects.length,0);
});

test('MCP command execution checks server scope before opening a connection', async () => {
  const f = fixture({permissions:['server.view','server.command.execute']});
  const reachedConnection = new Error('Authorized connection boundary reached');
  Object.assign(f.context, {
    validateConnectionProject: () => '',
    managedMcpSshConnection: async () => { throw reachedConnection; }
  });
  vm.runInContext(mainFunction('executeManagedMcpSshCommand'),f.context);
  await assert.rejects(() => f.context.executeManagedMcpSshCommand({id:'server-a'},'uptime',1000), error => error === reachedConnection);
  await assert.rejects(() => f.context.executeManagedMcpSshCommand({id:'server-b'},'uptime',1000), /access to this server/);
});

test('delegated managers cannot expand permission, module, server, or command access', async () => {
  const f = fixture({role:'admin',permissions:['server.view','members.update'],blockedCommands:['reboot']});
  const payload = {uid:'target',role:'member',permissions:['server.view'],visibleModules:['hosts'],serverIds:['server-a'],blockedCommands:['reboot']};
  await f.call('teams:updateMember',payload);
  for (const extra of [
    {permissions:['server.delete']}, {visibleModules:['*']}, {serverIds:['*']},
    {blockedCommands:[]}, {role:'admin'}, {uid:'actor'}
  ]) await assert.rejects(() => f.call('teams:updateMember',{...payload,...extra}), /cannot/);
  f.members.get('target').role='admin';
  await assert.rejects(() => f.call('teams:updateMember',payload), /cannot change an admin/);
  assert.equal(f.effects.length,1);
});

test('ownerUid protects the owner even if the stored member role is stale', async () => {
  const f = fixture({role:'admin',permissions:ADMIN_DEFAULT_PERMISSIONS,visibleModules:['*'],serverIds:['*']});
  f.members.get('owner').role='member';
  await assert.rejects(() => f.call('teams:updateMember',{uid:'owner',role:'member'}), /Owner permissions/);
  await assert.rejects(() => f.call('teams:removeMember',{uid:'owner'}), /Owner cannot be removed/);
  assert.equal(f.effects.length,0);
});

test('access PATCH sends repeated update masks and preserves unrelated document fields', async () => {
  const f = fixture({role:'admin',permissions:ADMIN_DEFAULT_PERMISSIONS,visibleModules:['*'],serverIds:['*']});
  let sent;
  Object.assign(f.context, {
    firestoreBaseUrl: async () => 'https://example.test/documents',
    encodePath: segments => segments.join('/'),
    fetchJson: async (url,options) => { sent={url,options}; return {fields:JSON.parse(options.body).fields}; }
  });
  vm.runInContext(mainFunction('firestoreFetch'),f.context);
  await f.call('teams:updateMember',{uid:'target',role:'member',permissions:['server.view'],visibleModules:['hosts'],serverIds:['server-a']});
  const url=new URL(sent.url);
  const mask=url.searchParams.getAll('updateMask.fieldPaths');
  assert.deepEqual(mask.sort(),['blockedCommands','permissions','role','serverIds','suspended','updatedAt','visibleModules']);
  assert.equal(url.searchParams.get('currentDocument.exists'),'true');
  const fields=JSON.parse(sent.options.body).fields;
  assert.equal('id' in fields,false);
  assert.equal('email' in fields,false);
  assert.equal('extra' in fields,false);
});

test('renderer permission controls agree with server scope and suspended roles', () => {
  const renderer=fs.readFileSync(path.join(__dirname,'renderer/renderer.js'),'utf8');
  const state={setup:{mode:'cloud'},teams:{activeTeam:null},activeProject:{id:'server-a'}};
  const context=vm.createContext({state});
  for (const name of ['workspaceAccessCan','activeWorkspaceCan','workspaceAccessCanServer','activeWorkspaceCanServer','activeWorkspaceCanUseServer','activeWorkspaceCanCreateServer']) {
    const start=renderer.indexOf(`function ${name}(`);
    assert.ok(start>=0);
    vm.runInContext(renderer.slice(start,renderer.indexOf('\n}',start)+2),context);
  }
  state.teams.activeTeam={role:'member',permissions:['server.view'],serverIds:['server-a']};
  assert.equal(context.activeWorkspaceCanUseServer('server.view','server-a'),true);
  assert.equal(context.activeWorkspaceCanUseServer('server.update','server-a'),false);
  assert.equal(context.activeWorkspaceCanUseServer('server.view','server-b'),false);
  state.teams.activeTeam.suspended=true;
  assert.equal(context.activeWorkspaceCanUseServer('server.view','server-a'),false);
  state.teams.activeTeam={role:'owner'};
  assert.equal(context.activeWorkspaceCanUseServer('server.delete','server-b'),true);
});

test('server catalog follows every Firestore page without truncating large workspaces', async () => {
  const requests=[];
  const context=vm.createContext({
    fromFirestoreDocument: document=>document,
    firestoreFetch: async (segments,{query})=>{
      requests.push({segments,query});
      const offset=query.pageToken ? 60 : 0;
      return {documents:Array.from({length:offset ? 40 : 60},(_,i)=>({id:`server-${offset+i}`})),nextPageToken:offset ? '' : 'next-page'};
    }
  });
  vm.runInContext(mainFunction('listCollection'),context);
  const result=await context.listCollection(['teams','workspace','projects']);
  assert.equal(result.length,100);
  assert.equal(result.at(-1).id,'server-99');
  assert.equal(requests.length,2);
  assert.equal(requests[1].query.pageToken,'next-page');
});

test('scoped server catalog fetches only assigned IDs, including explicit empty scope', async () => {
  const calls=[];
  const context=vm.createContext({
    ensureActiveTeamUnlocked:async ()=>'workspace',
    getDoc:async segments=>{calls.push(segments.at(-1));return {id:segments.at(-1)};},
    listCollection:async segments=>{assert.equal(segments.at(-1),'templates');return [];},
    prepareCloudProjectForRead:project=>project,
    prepareCloudTemplateForRead:template=>template,
    canReadWorkspaceProjectSecrets:()=>true,
    readCloudStore:async ()=>{throw new Error('Unexpected unscoped read');}
  });
  vm.runInContext(mainFunction('readCloudStoreForMember'),context);
  const single=await context.readCloudStoreForMember({role:'member',serverIds:['server-99']});
  assert.equal(single.projects.length,1);
  assert.deepEqual(calls,['server-99']);
  const empty=await context.readCloudStoreForMember({role:'member',serverIds:[]});
  assert.equal(empty.projects.length,0);
  assert.equal(calls.length,1);
});
