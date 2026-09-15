// Current-source UI fixtures only: no app startup, accounts, cloud, or real servers.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const output = path.join(os.tmpdir(), 'deployerx-scope-ui-preview');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const args of [[path.join(__dirname, 'check-workspace-access-ui.cjs'), output], [__filename]]) {
    const child = require('node:child_process').spawnSync(require('electron'), args, { env, windowsHide:true, stdio:'inherit', timeout:60000 });
    if (child.error) console.error(child.error);
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
  console.log('WORKSPACE SCOPE UI VERIFIED');
  process.exit(0);
}
const { app, BrowserWindow } = require('electron');
const { WORKSPACE_MODULE_CATALOG, WORKSPACE_PERMISSION_CATALOG } = require('../src/workspace-permissions');
const root = path.resolve(__dirname, '..');
const timer = setTimeout(() => { console.error('Scope UI check timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const source = (await fs.readFile(path.join(root, 'src/renderer/renderer.js'), 'utf8')).replace(/\r\n/g, '\n');
  const html = await fs.readFile(path.join(root, 'src/renderer/index.html'), 'utf8');
  function definition(name) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-scope-test-'));
  const file = path.join(temporary, 'index.html');
  const win = new BrowserWindow({show:false,useContentSize:true,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_, done) => done({cancel:true}));
  try {
    await fs.mkdir(output, {recursive:true});
    await fs.writeFile(file, `<!doctype html><html data-theme="termius-dark"><head><base href="${pathToFileURL(path.join(root,'src/renderer')+path.sep).href}"><link rel="stylesheet" href="styles.css"></head><body></body></html>`);
    await win.loadFile(file);
    await win.webContents.executeJavaScript(`
      const original=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');
      const sprite=original.querySelector('svg:has(symbol)');if(sprite) document.body.append(sprite);
      document.body.append(original.getElementById('addWorkspaceUserModal'));
      const els=Object.fromEntries([...document.querySelectorAll('[id]')].map(el=>[el.id,el]));
      els.addWorkspaceUserSteps=[...document.querySelectorAll('[data-add-user-step]')];
      els.addWorkspaceUserStepIndicators=[...document.querySelectorAll('[data-add-user-step-indicator]')];
      const state={teams:{activeTeam:{role:'owner',blockedCommands:[]},moduleCatalog:${JSON.stringify(WORKSPACE_MODULE_CATALOG)},permissionCatalog:${JSON.stringify(WORKSPACE_PERMISSION_CATALOG)}},projects:Array.from({length:100},(_,i)=>({id:'server-'+i,name:'Production server '+String(i+1).padStart(3,'0')}))};
      const activeWorkspaceCan=()=>true;
      const setModalVisible=(visible,el)=>el.classList.toggle('hidden',!visible);
      let addWorkspaceUserStep=1;
      ${['escapeHtml','defaultWorkspacePermissions','renderWorkspacePermissionInputs','selectedWorkspacePermissions','blockedWorkspaceCommands','renderWorkspaceScopeInputs','refreshWorkspaceScopeInputs','selectedWorkspaceScope','syncWorkspaceScopeAll','addWorkspaceUserAccess','addWorkspaceUserMethod','showAddWorkspaceUserError','updateAddWorkspaceUserMethodFields','setAddWorkspaceUserStep','openAddWorkspaceUserModal','renderAddWorkspaceUserReview','workspaceScopeLabel','workspaceRoleLabel'].map(definition).join('\n')}
      openAddWorkspaceUserModal();setAddWorkspaceUserStep(3);
      els.addWorkspaceUserAllServers.addEventListener('change',()=>syncWorkspaceScopeAll(els.addWorkspaceUserAllServers,els.addWorkspaceUserServers));
      els.addWorkspaceUserAllModules.addEventListener('change',()=>syncWorkspaceScopeAll(els.addWorkspaceUserAllModules,els.addWorkspaceUserModules));
      const servers=els.addWorkspaceUserServers;
      const modules=els.addWorkspaceUserModules;
      const search=servers.querySelector('[data-scope-search]');
      function filter(value){search.value=value;search.dispatchEvent(new Event('input'));}
    `);
    const initial = await win.webContents.executeJavaScript(`({servers:servers.querySelectorAll('[data-workspace-server]').length,modules:[...modules.querySelectorAll('[data-workspace-module]')].map(el=>el.dataset.workspaceModule),all:addWorkspaceUserAccess().serverIds})`);
    assert.equal(initial.servers, 100);
    assert.deepEqual(initial.modules, WORKSPACE_MODULE_CATALOG.map(item=>item.key));
    assert.ok(initial.modules.includes('uptime') && initial.modules.includes('backups'));
    assert.deepEqual(initial.all, ['*']);
    const selected = await win.webContents.executeJavaScript(`
      els.addWorkspaceUserAllServers.click();servers.querySelector('[data-scope-clear]').click();
      filter('server-99');servers.querySelector('[data-scope-select]').click();
      filter('server-2');servers.querySelector('[data-scope-select]').click();
      filter('no match');
      ({ids:addWorkspaceUserAccess().serverIds,empty:servers.querySelector('[data-scope-empty]').textContent,summary:servers.querySelector('[data-scope-summary]').textContent})
    `);
    assert.equal(selected.ids.length,12); // 99, 2, 20–29; search includes IDs as well as names.
    assert.ok(selected.ids.includes('server-99'));
    assert.match(selected.empty,/No servers match/);
    assert.match(selected.summary,/12 selected.*0 of 100/);
    const none = await win.webContents.executeJavaScript(`servers.querySelector('[data-scope-clear]').click();addWorkspaceUserAccess().serverIds`);
    assert.deepEqual(none, []);
    await win.webContents.executeJavaScript(`filter('server-99');servers.querySelector('[data-scope-select]').click();filter('');els.addWorkspaceUserAllModules.click();modules.querySelector('[data-scope-clear]').click();modules.querySelector('[data-workspace-module="uptime"]').click();modules.querySelector('[data-workspace-module="backups"]').click();setAddWorkspaceUserStep(4);setAddWorkspaceUserStep(3);`);
    const payload=await win.webContents.executeJavaScript('addWorkspaceUserAccess()');
    assert.deepEqual(payload.serverIds,['server-99']);
    assert.deepEqual(payload.visibleModules,['uptime','backups']);
    assert.deepEqual(payload.permissions,['server.view']);
    for (const [width,height] of [[1200,900],[700,800]]) {
      win.setContentSize(width,height);
      await new Promise(resolve=>setTimeout(resolve,300));
      await win.webContents.executeJavaScript(`modules.closest('fieldset').scrollIntoView({block:'start',behavior:'instant'});document.fonts.ready`);
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(resolve=>setTimeout(resolve,150));
      const layout=await win.webContents.executeJavaScript(`(() => {
        const list=modules.querySelector('.workspace-scope-list');
        const body=document.querySelector('.workspace-user-modal-body');
        const footer=document.querySelector('.workspace-user-modal-footer').getBoundingClientRect();
        return {width:innerWidth,overflow:body.scrollWidth>body.clientWidth,modulesClipped:list.scrollHeight>list.clientHeight,footer:footer.bottom};
      })()`);
      assert.equal(layout.width,width);
      assert.equal(layout.overflow,false);
      assert.equal(layout.modulesClipped,false,'All modules must be shown without an inner scroll');
      assert.ok(layout.footer<=height);
      await fs.writeFile(path.join(output,`add-scope-${width}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      await win.webContents.executeJavaScript(`servers.closest('fieldset').scrollIntoView({block:'start',behavior:'instant'});`);
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(resolve=>setTimeout(resolve,150));
      await fs.writeFile(path.join(output,`add-servers-${width}.png`),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    }
    const preserved=await win.webContents.executeJavaScript(`renderWorkspaceScopeInputs(servers,[],['missing-server'],'server');syncWorkspaceScopeAll(els.addWorkspaceUserAllServers,servers);addWorkspaceUserAccess().serverIds`);
    assert.deepEqual(preserved,['missing-server']);
    const empty=await win.webContents.executeJavaScript(`renderWorkspaceScopeInputs(servers,[],[],'server');syncWorkspaceScopeAll(els.addWorkspaceUserAllServers,servers);({ids:addWorkspaceUserAccess().serverIds,text:servers.querySelector('[data-scope-empty]').textContent})`);
    assert.deepEqual(empty.ids,[]);
    assert.match(empty.text,/No servers available/);
    const restricted=await win.webContents.executeJavaScript(`state.teams.activeTeam={role:'admin',visibleModules:['uptime'],serverIds:['server-99'],blockedCommands:['reboot']};state.projects=state.projects.filter(p=>p.id==='server-99');openAddWorkspaceUserModal();({access:addWorkspaceUserAccess(),allServersDisabled:els.addWorkspaceUserAllServers.disabled,modules:[...modules.querySelectorAll('[data-workspace-module]')].map(el=>el.dataset.workspaceModule)})`);
    assert.equal(restricted.allServersDisabled,true);
    assert.deepEqual(restricted.access.serverIds,['server-99']);
    assert.deepEqual(restricted.modules,['uptime']);
    assert.deepEqual(restricted.access.blockedCommands,['reboot']);
    console.log('Add-user UI: 100 servers, all modules, search-safe selections, empty scope, unavailable IDs, restricted grants, review persistence and responsive layout passed.');
  } finally {
    win.destroy();await fs.unlink(file);await fs.rmdir(temporary);
  }
  clearTimeout(timer);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timer);app.exit(1)});
