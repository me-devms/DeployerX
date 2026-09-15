// Runs only against a private, disposable emulator. No production data or credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { accessHarness } = require('./workspace-access-test-helpers');
const { ADMIN_DEFAULT_PERMISSIONS } = require('./workspace-permissions');

test('Firestore access saves and authorization matrix', { timeout: 90000 }, async (t) => {
  const java = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    'C:/Program Files/Android/Android Studio/jbr/bin/java.exe'
  ].find(candidate => candidate && fs.existsSync(candidate)) || 'java';
  const jar = process.env.FIRESTORE_EMULATOR_JAR || path.join(os.homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
  assert.ok(fs.existsSync(jar), 'Install the Firestore emulator or set FIRESTORE_EMULATOR_JAR.');
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const projectId = 'demo-deployerx-access';
  const child = spawn(java, ['-jar', jar, '--host', '127.0.0.1', '--port', String(port),
    '--project_id', projectId, '--rules', path.join(__dirname, '..', 'firestore.rules')],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-8000); });
  child.stderr.on('data', data => { output = (output + data).slice(-8000); });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const closed = once(child, 'close');
    child.kill();
    await closed;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`Emulator startup timed out: ${output}`)); }, 30000);
    const finish = error => { clearTimeout(timer); clearInterval(poll); error ? reject(error) : resolve(); };
    const poll = setInterval(() => {
      if (output.includes('Dev App Server is now running')) finish();
      else if (child.exitCode !== null) finish(new Error(`Emulator exited: ${output}`));
    }, 100);
    child.once('error', finish);
  });
  let actor = 'owner';
  const token = uid => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({alg:'none',typ:'JWT'})}.${encode({sub:uid,user_id:uid,aud:projectId,iss:`https://securetoken.google.com/${projectId}`,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,email:`${uid}@example.test`,email_verified:true,firebase:{sign_in_provider:'password'}})}.`;
  };
  const harness = accessHarness({ requireAuthSession: async () => ({ uid: actor }) });
  const base = `http://127.0.0.1:${port}/v1/projects/${projectId}/databases/(default)/documents`;
  async function request(segments, options = {}, uid = actor) {
    const pairs = Object.entries(options.query || {}).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map(item => [key, String(item)]));
    const query = new URLSearchParams(pairs).toString();
    const response = await fetch(`${base}/${segments.join('/')}${query ? `?${query}` : ''}`, {
      method: options.method || 'GET', body: options.body,
      headers: { Authorization: `Bearer ${uid === 'seed' ? 'owner' : token(uid)}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const body = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error?.message || `HTTP ${response.status}`), { status: response.status });
    return body;
  }
  harness.context.firestoreFetch = request;
  harness.context.getDoc = async segments => {
    try { return harness.context.fromFirestoreDocument(await request(segments)); }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  const memberPath = uid => ['teams', 'workspace', 'members', uid];
  const access = (extra = {}) => ({role:'member', permissions:['server.view'], blockedCommands:[], visibleModules:['*'], serverIds:['*'], suspended:false, ...extra});
  async function seed(segments, data) {
    return request(segments, {method:'PATCH', body:JSON.stringify(harness.context.toFirestoreDocument(data))}, 'seed');
  }
  async function writeAs(uid, segments, data) {
    return request(segments, {method:'PATCH', body:JSON.stringify(harness.context.toFirestoreDocument(data))}, uid);
  }
  await seed(['teams','workspace'], {ownerUid:'owner', secretSeed:'emulator-only', name:'Test'});
  await seed(memberPath('owner'), {uid:'owner', ...access({role:'owner'})});
  await seed(memberPath('target'), {uid:'target', id:'target', displayName:'Existing user', email:'target@example.test', ...access()});
  await t.test('owner saves access on a legacy member without deleting its stored id or profile fields', async () => {
    await harness.call('teams:updateMember', {uid:'target', ...access({serverIds:['server-a'], permissions:['server.view','server.update']})});
    const saved = await harness.context.getDoc(memberPath('target'));
    assert.equal(saved.id, 'target');
    assert.equal(saved.displayName, 'Existing user');
    assert.deepEqual(Array.from(saved.serverIds), ['server-a']);
  });
  await t.test('owner saves access on a member without an id field', async () => {
    await seed(memberPath('no-id'), {uid:'no-id', displayName:'New format', ...access()});
    await harness.call('teams:updateMember', {uid:'no-id', ...access({serverIds:[]})});
    const raw = await request(memberPath('no-id'));
    assert.equal('id' in raw.fields, false);
    assert.equal(raw.fields.displayName.stringValue, 'New format');
  });
  await seed(memberPath('viewer'), {uid:'viewer', ...access({serverIds:['server-a']})});
  await seed(memberPath('editor'), {uid:'editor', ...access({permissions:['server.view','server.update'], serverIds:['server-a']})});
  await seed(memberPath('none'), {uid:'none', ...access({serverIds:[]})});
  await seed(memberPath('suspended'), {uid:'suspended', ...access({role:'admin',permissions:ADMIN_DEFAULT_PERMISSIONS,suspended:true})});
  for (const id of ['server-a','server-b']) await seed(['teams','workspace','projects',id], {id,name:id});
  for (const [label, uid, method, id, allowed] of [
    ['viewer reads assigned server','viewer','GET','server-a',true],
    ['viewer cannot read other server','viewer','GET','server-b',false],
    ['viewer cannot edit','viewer','PATCH','server-a',false],
    ['viewer cannot delete','viewer','DELETE','server-a',false],
    ['editor edits assigned server','editor','PATCH','server-a',true],
    ['editor cannot edit other server','editor','PATCH','server-b',false],
    ['editor cannot delete','editor','DELETE','server-a',false],
    ['no-server member cannot read','none','GET','server-a',false],
    ['suspended admin cannot read','suspended','GET','server-a',false],
    ['stranger cannot read','stranger','GET','server-a',false]
  ]) await t.test(label, async () => {
    const action = () => request(['teams','workspace','projects',id], {method, ...(method==='PATCH' ? {body:JSON.stringify(harness.context.toFirestoreDocument({id,name:'Updated'}))} : {})},uid);
    if (allowed) await action(); else await assert.rejects(action, {status:403});
  });
  await t.test('members cannot edit access, self-promote, or change owner access', async () => {
    await assert.rejects(() => writeAs('viewer', memberPath('target'), {uid:'target', ...access()}), {status:403});
    await assert.rejects(() => writeAs('viewer', memberPath('viewer'), {uid:'viewer', ...access({role:'admin',permissions:ADMIN_DEFAULT_PERMISSIONS})}), {status:403});
    await assert.rejects(() => writeAs('owner', memberPath('owner'), {uid:'owner', ...access()}), {status:403});
  });
  await seed(memberPath('manager'), {uid:'manager', ...access({role:'admin',permissions:['server.view','members.view','members.update'],visibleModules:['hosts'],serverIds:['server-a'],blockedCommands:['reboot']})});
  await seed(memberPath('managed'), {uid:'managed', ...access({visibleModules:['hosts'],serverIds:['server-a'],blockedCommands:['reboot']})});
  for (const [label,extra,allowed] of [
    ['delegated admin saves access within their grants',{},true],
    ['delegated admin cannot expand permissions',{permissions:['server.view','server.delete']},false],
    ['delegated admin cannot expand modules',{visibleModules:['*']},false],
    ['delegated admin cannot expand servers',{serverIds:['*']},false],
    ['delegated admin cannot remove inherited command blocks',{blockedCommands:[]},false],
    ['delegated admin cannot promote without permission',{role:'admin'},false]
  ]) await t.test(label, async () => {
    const data={uid:'managed',...access({visibleModules:['hosts'],serverIds:['server-a'],blockedCommands:['reboot'],...extra})};
    if (allowed) await writeAs('manager',memberPath('managed'),data);
    else await assert.rejects(() => writeAs('manager',memberPath('managed'),data),{status:403});
  });
  await t.test('changing an existing admin requires admin management permission even when demoting', async () => {
    await seed(memberPath('managed'), {uid:'managed', ...access({role:'admin',visibleModules:['hosts'],serverIds:['server-a'],blockedCommands:['reboot']})});
    await assert.rejects(() => writeAs('manager',memberPath('managed'), {uid:'managed', ...access({visibleModules:['hosts'],serverIds:['server-a'],blockedCommands:['reboot']})}),{status:403});
  });
  await t.test('ownerUid protects an owner with a stale member role', async () => {
    await seed(memberPath('owner'), {uid:'owner',...access()});
    await seed(memberPath('full-admin'), {uid:'full-admin',...access({role:'admin',permissions:ADMIN_DEFAULT_PERMISSIONS})});
    await assert.rejects(() => writeAs('full-admin',memberPath('owner'), {uid:'owner',...access({suspended:true})}),{status:403});
    await assert.rejects(() => request(memberPath('owner'),{method:'DELETE'},'full-admin'),{status:403});
  });
  await t.test('legacy admin defaults agree with the app while explicit empty permissions stay denied', async () => {
    await seed(memberPath('legacy-admin'), {uid:'legacy-admin',role:'admin'});
    await seed(memberPath('empty-admin'), {uid:'empty-admin',...access({role:'admin',permissions:[]})});
    await request(['teams','workspace','projects','server-a'],{},'legacy-admin');
    await assert.rejects(() => request(['teams','workspace','projects','server-a'],{},'empty-admin'),{status:403});
  });
  await t.test('suspension and scope changes take effect on the next server request', async () => {
    actor='owner';
    await harness.call('teams:updateMember',{uid:'editor',...access({permissions:['server.view','server.update'],serverIds:['server-a'],suspended:true})});
    await assert.rejects(() => request(['teams','workspace','projects','server-a'],{},'editor'),{status:403});
    await harness.call('teams:updateMember',{uid:'editor',...access({permissions:['server.view','server.update'],serverIds:[],suspended:false})});
    await assert.rejects(() => request(['teams','workspace','projects','server-a'],{},'editor'),{status:403});
    await harness.call('teams:updateMember',{uid:'editor',...access({permissions:['server.view','server.update'],serverIds:['server-a'],suspended:false})});
    await request(['teams','workspace','projects','server-a'],{},'editor');
  });
  await t.test('new users can finish the required password change without changing access or injecting id', async () => {
    await seed(memberPath('new-user'),{uid:'new-user',email:'new-user@example.test',...access({mustChangePassword:true})});
    actor='new-user';
    await assert.rejects(() => request(['teams','workspace','projects','server-a']),{status:403});
    Object.assign(harness.context,{
      firebaseAuthRequest:async () => ({idToken:'test-only'}),
      normalizeAuthSession:auth => auth,
      writeSettings:async () => {}
    });
    await harness.call('auth:changePassword',{currentPassword:'temporary-test',newPassword:'new-password-test'});
    const raw=await request(memberPath('new-user'));
    assert.equal(raw.fields.mustChangePassword.booleanValue,false);
    assert.equal('id' in raw.fields,false);
    assert.equal(raw.fields.role.stringValue,'member');
    await request(['teams','workspace','projects','server-a']);
  });
});
