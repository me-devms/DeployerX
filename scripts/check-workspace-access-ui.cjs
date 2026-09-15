// Isolated rendering of the real member editor. No application backend or cloud access.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { WORKSPACE_PERMISSION_CATALOG, WORKSPACE_MODULE_CATALOG } = require('../src/workspace-permissions');
const root = path.resolve(__dirname, '..');
const timer = setTimeout(() => { console.error('Workspace editor check timed out'); app.exit(1); }, 25000);

app.whenReady().then(async () => {
  const source = (await fs.readFile(path.join(root,'src/renderer/renderer.js'),'utf8')).replace(/\r\n/g,'\n');
  const styles = await fs.readFile(path.join(root,'src/renderer/styles.css'),'utf8');
  const window = new BrowserWindow({show:false,useContentSize:true,width:1600,height:850,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'deployerx-access-ui-'));
  try {
    const file = path.join(temporary,'index.html');
    await fs.writeFile(file,`<!doctype html><html data-theme="termius-dark"><head><base href="${pathToFileURL(path.join(root,'src/renderer')+path.sep).href}"><style>${styles}</style></head><body style="display:block;padding:28px;overflow:auto"><h2>Users &amp; Permissions</h2><table class="uptime-table workspace-users-table" style="width:100%;margin-top:20px"><tbody id="teamMembersList"></tbody></table></body></html>`);
    await window.loadFile(file);
    function definition(name) {
      const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));
      assert.ok(start>=0,name);
      return source.slice(start,source.indexOf('\n}',start)+2);
    }
    const start=source.indexOf("      const editorRow = document.createElement('tr');");
    const end=source.indexOf('\n    }\n  }\n\n  const pending =',start);
    assert.ok(start>=0 && end>start);
    await window.webContents.executeJavaScript(`
      const member={uid:'sample-user',displayName:'Alex Morgan',email:'alex@example.test',role:'member',permissions:['server.view'],visibleModules:['*'],serverIds:['*'],blockedCommands:[]};
      const state={teams:{activeTeamId:'workspace',permissionCatalog:${JSON.stringify(WORKSPACE_PERMISSION_CATALOG)},moduleCatalog:${JSON.stringify(WORKSPACE_MODULE_CATALOG)}}};
      const els={teamMembersList:document.getElementById('teamMembersList')};
      const canPromoteMembers=true;
      const serverCatalog=Array.from({length:100},(_,i)=>({key:'server-'+i,label:['Production API','Staging application','Database replica','Internal services'][i%4]+' '+(i+1)}));
      const row=document.createElement('tr');
      row.innerHTML='<td><strong>Alex Morgan</strong></td><td>Member</td><td>All modules</td><td>All servers</td><td>Active</td><td><button type="button" data-edit-member="sample-user" aria-expanded="false">Edit</button></td>';
      els.teamMembersList.appendChild(row);
      window.deployerx={updateTeamMember:async payload=>{window.savedPayload=payload;return {saved:true}}};
      const withButtonLoading=async (key,button,action)=>action();
      const applyTeamSnapshot=()=>{};
      const showToast=()=>{};
      const showAlert=message=>{throw new Error(message)};
      ${['escapeHtml','defaultWorkspacePermissions','renderWorkspacePermissionInputs','selectedWorkspacePermissions','blockedWorkspaceCommands','resetWorkspacePermissionInputs','renderWorkspaceScopeInputs','refreshWorkspaceScopeInputs','selectedWorkspaceScope','syncWorkspaceScopeAll','bindMemberAccessTabs','updateMemberAccess'].map(definition).join('\n')}
      ${source.slice(start,end)}
      row.querySelector('button').click();
      document.fonts.ready;
    `);
    const output=process.argv[2];
    if(output) await fs.mkdir(output,{recursive:true});
    for(const width of [1600,1200]) {
      window.setContentSize(width,850);
      await new Promise(resolve=>setTimeout(resolve,150));
      for(const tab of ['permissions','visibility','commands']) {
        await window.webContents.executeJavaScript(`document.querySelector('[data-member-access-tab="${tab}"]').click();new Promise(resolve=>requestAnimationFrame(resolve))`);
        const layout=await window.webContents.executeJavaScript(`(() => {
          const form=document.querySelector('form');
          const body=form.querySelector('.workspace-access-editor-body');
          const footer=form.querySelector('footer').getBoundingClientRect();
          const panels=[...form.querySelectorAll('[role="tabpanel"]')].filter(el=>getComputedStyle(el).display!=='none');
          return {height:form.getBoundingClientRect().height,overflow:body.scrollWidth>body.clientWidth,footerBottom:footer.bottom,visiblePanels:panels.length,active:panels[0].dataset.memberAccessPanel};
        })()`);
        assert.equal(layout.overflow,false,`${width}/${tab}: horizontal content overflow`);
        assert.equal(layout.visiblePanels,1);
        assert.equal(layout.active,tab);
        assert.ok(layout.footerBottom<850,`${width}/${tab}: footer outside viewport`);
        assert.ok(layout.height<570,`${width}/${tab}: editor too tall`);
        if(output && width===1600) {
          await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
          await new Promise(resolve=>setTimeout(resolve,300));
          await fs.writeFile(path.join(output,`access-${tab}.png`),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
        }
      }
    }
    const keyboard=await window.webContents.executeJavaScript(`(() => {
      const first=document.querySelector('[data-member-access-tab="permissions"]');
      first.click();first.focus();first.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      return document.activeElement.dataset.memberAccessTab;
    })()`);
    assert.equal(keyboard,'visibility');
    await window.webContents.executeJavaScript(`
      document.querySelector('[data-member-all-servers]').click();
      document.querySelector('[data-workspace-server="server-2"]').checked=false;
      document.querySelector('[data-scope-search]').value='server-99';
      document.querySelector('[data-scope-search]').dispatchEvent(new Event('input'));
      document.querySelector('[data-member-access-tab="commands"]').click();
      document.querySelector('[data-member-blocked-commands]').value='reboot';
      document.querySelector('[data-member-access-tab="permissions"]').click();
      document.querySelector('[data-workspace-permission="server.update"]').checked=true;
      document.querySelector('form').requestSubmit();
      new Promise(resolve=>setTimeout(resolve,0));
    `);
    const saved=await window.webContents.executeJavaScript('window.savedPayload');
    assert.ok(saved.permissions.includes('server.update'));
    assert.deepEqual(saved.blockedCommands,['reboot']);
    assert.ok(!saved.serverIds.includes('server-2'));
    assert.equal(saved.serverIds.length,99,'Search must not discard hidden selected servers');
    await window.webContents.executeJavaScript(`document.querySelector('[data-member-access-cancel]').click();document.querySelector('[data-edit-member]').click();`);
    const reset=await window.webContents.executeJavaScript(`({commands:document.querySelector('[data-member-blocked-commands]').value,edited:document.querySelector('[data-workspace-permission="server.update"]').checked,all:document.querySelector('[data-member-all-servers]').checked})`);
    assert.deepEqual(reset,{commands:'',edited:false,all:true});
    console.log('Workspace editor UI passed: three tabs at two desktop widths, visible footer, no horizontal overflow, keyboard navigation, saved selections, cancel restores values.');
  } finally {
    await fs.unlink(path.join(temporary,'index.html'));
    await fs.rmdir(temporary);
    window.destroy();
  }
  clearTimeout(timer);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timer);app.exit(1)});
