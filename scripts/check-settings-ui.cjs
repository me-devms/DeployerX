// Isolated current-source UI checks. No preload, renderer.js startup, backend, or network.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const pages = ['groups', 'workspace', 'notifications', 'monitoring', 'backup', 'templates', 'integrations', 'theme', 'about'];
const selected = process.argv[2] || 'all';
assert.ok(selected === 'all' || pages.includes(selected), 'Unknown settings page');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Give each page its own renderer so native-dialog focus and fixture state do not leak.
  for (const page of selected === 'all' ? pages : [selected]) {
    const child = spawnSync(require('electron'), [__filename, page], { env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
    if (child.error) console.error(child.error);
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
  process.exit(0);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const timer = setTimeout(() => { console.error('Settings UI check timed out'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  const html = await fs.readFile(path.join(root, 'src/renderer/index.html'), 'utf8');
  const ui = await fs.readFile(path.join(root, 'src/renderer/settings-ui.js'), 'utf8');
  const renderer = (await fs.readFile(path.join(root, 'src/renderer/renderer.js'), 'utf8')).replace(/\r\n/g, '\n');
  const originalIds = JSON.parse(await fs.readFile(path.join(__dirname, 'settings-ui-control-ids.json'), 'utf8'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-settings-test-'));
  const screenshots = path.join(os.tmpdir(), 'deployerx-settings-ui-preview');
  await fs.mkdir(screenshots, { recursive: true });
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 1600, height: 950, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const settle = async () => {
    await new Promise(resolve=>setTimeout(resolve,100));
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const resize = async (width,height) => {
    win.setContentSize(width,height);
    await settle();
    assert.equal(await win.webContents.executeJavaScript('innerWidth'),width,'Renderer must finish resizing before layout checks');
  };
  const screenshot = async () => {
    await settle();
    const image=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    const width=await win.webContents.executeJavaScript('innerWidth');
    assert.equal(image.getSize().width,width,'Screenshot must match current renderer width');
    return image.toPNG();
  };
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  try {
    const fixture = path.join(temporary, 'index.html');
    await fs.writeFile(fixture, `<!doctype html><html data-theme="termius-dark"><head><base href="${pathToFileURL(path.join(root, 'src/renderer') + path.sep).href}"><link rel="stylesheet" href="styles.css"></head><body style="display:block;overflow:auto"><div style="height:72px;border-bottom:1px solid var(--line);padding:24px;color:var(--muted)">DeployerX · Settings preview (isolated test data)</div><div id="fixture" class="settings-view"></div></body></html>`);
    await win.loadFile(fixture);
    const setup = await win.webContents.executeJavaScript(`(() => {
      const parsed = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
      const originalIds = ${JSON.stringify(originalIds)};
      const invalid = originalIds.filter(id => parsed.querySelectorAll('[id="' + id + '"]').length !== 1);
      const duplicate = parsed.createElement('div');duplicate.id=originalIds[0];parsed.body.append(duplicate);
      const duplicateDetected=parsed.querySelectorAll('[id="'+originalIds[0]+'"]').length!==1;
      duplicate.remove();
      const sprite = parsed.querySelector('.icon-sprite');
      document.body.prepend(sprite);
      document.getElementById('fixture').append(parsed.querySelector('.settings-layout'));
      for (const id of ['settingsBackupHistoryDialog','settingsDeliveryHistoryDialog','serverGroupModal','uptimeGroupModal','createTeamModal','backupNotificationRouteModal']) document.body.append(parsed.getElementById(id));
      return { invalid, duplicateDetected, panels: document.querySelectorAll('.settings-guide').length };
    })()`);
    assert.deepEqual(setup.invalid, [], 'Existing settings IDs must remain unique and present');
    assert.ok(setup.duplicateDetected, 'ID check must reject a known duplicate');
    assert.equal(setup.panels, pages.length);
    await win.webContents.executeJavaScript(ui);
    // Use actual list-rendering functions with synthetic data; never initialize the application.
    function definition(name) {
      const start = renderer.indexOf(`function ${name}(`);
      assert.ok(start >= 0, name);
      return renderer.slice(start, renderer.indexOf('\n}', start) + 2);
    }
    await win.webContents.executeJavaScript(`
      const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
      const state = { projects: [], backupNotificationRoutes: [], backupNotificationDeliveries: [] };
      let testGroups = [];
      const savedProjectGroups = () => testGroups;
      const normalizeServerGroupName = name => String(name || '').trim();
      const icon = name => '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-' + name + '"></use></svg>';
      const formatDateTime = () => '15 Sep 2026, 14:30';
      const BACKUP_NOTIFICATION_TYPE_LABELS = { desktop: 'Desktop', email: 'Email' };
      const BACKUP_NOTIFICATION_EVENT_LABELS = { 'backup.failed': 'Backup failed' };
      els.themeOptions=[...document.querySelectorAll('[data-theme-option]')];
      const THEMES=Object.fromEntries(els.themeOptions.map(button=>[button.dataset.themeOption,{label:button.querySelector('strong').textContent,terminal:{}}]));
      const DEFAULT_THEME_ID='deployerx-light';
      let activeThemeId=DEFAULT_THEME_ID;
      const terminal={options:{}};
      ${['escapeHtml', 'renderServerGroupsSettings', 'backupNotificationRouteDetail', 'renderBackupNotificationRoutes', 'renderBackupNotificationDeliveries', 'syncBackupNotificationRouteFields', 'applyTheme'].map(definition).join('\n')}
      window.fillSettingsFixture = count => {
        testGroups = Array.from({length:count}, (_,i) => i === 0 ? 'Production infrastructure and application services' : 'Server group ' + (i+1));
        renderServerGroupsSettings();
        els.uptimeMonitorGroupsEmpty.classList.toggle('hidden', count > 0);
        els.uptimeMonitorGroupList.innerHTML = testGroups.map(name => '<div class="monitor-group-settings-row"><span class="monitor-group-settings-copy"><strong>' + name + '</strong><small>Linked server monitors</small></span><span class="monitor-group-settings-actions"><button class="icon-button" aria-label="Edit group">' + icon('edit') + '</button></span></div>').join('');
        state.backupNotificationRoutes = testGroups.map((name,i) => ({id:'route-'+i,name,type:'desktop',enabled:true,events:['backup.failed']}));
        state.backupNotificationDeliveries = testGroups.map((name,i) => ({title:name,routeName:'Operations',routeType:'desktop',status:i%2?'failed':'succeeded'}));
        renderBackupNotificationRoutes(); renderBackupNotificationDeliveries();
      };
      document.getElementById('teamSelect').innerHTML = '<option>Example workspace (owner)</option>';
      document.getElementById('settingsWorkspaceName').value = 'Example workspace';
      document.getElementById('backupHistoryList').innerHTML = '<div class="settings-muted">No backup history yet.</div>';
      window.fillSettingsFixture(3);
      document.fonts.ready;
    `);

    for (const page of selected === 'all' ? pages : [selected]) {
      await win.webContents.executeJavaScript(`
        document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === '${page}'));
        document.querySelectorAll('[data-settings-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.settingsTab === '${page}'));
      `);
      for (const [width, height, theme] of [[1600,950,'termius-dark'],[1200,800,'deployerx-light'],[700,800,'termius-dark']]) {
        await resize(width, height);
        await win.webContents.executeJavaScript(`applyTheme('${theme}',{persist:false,announce:false});window.scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        const layout = await win.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('[data-settings-panel="${page}"]');
          const header = panel.querySelector('.settings-page-header');
          const heading = panel.querySelector('.settings-section-heading');
          const fields = [...panel.querySelectorAll('.field')].filter(el => el.getClientRects().length);
          return {
            title: header?.querySelector('h2')?.textContent,
            headerHeight: header?.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            headingPadding: heading ? [getComputedStyle(heading).paddingTop,getComputedStyle(heading).paddingBottom] : [],
            fieldsTopAligned: fields.every(el=>getComputedStyle(el).alignContent === 'start'),
            cards: [...panel.querySelectorAll('.settings-card')].filter(el=>el.getClientRects().length).map(el=>({width:el.clientWidth,scroll:el.scrollWidth})),
          };
        })()`);
        assert.ok(layout.title && layout.headerHeight < 180, `${page}/${width}: page header`);
        assert.equal(layout.overflow, false, `${page}/${width}: page horizontal overflow`);
        assert.equal(layout.fieldsTopAligned, true, `${page}/${width}: fields must top-align`);
        if (layout.headingPadding.length) assert.equal(layout.headingPadding[0],layout.headingPadding[1],`${page}: unequal heading padding`);
        assert.ok(layout.cards.every(card=>card.scroll <= card.width + 1),`${page}/${width}: card overflow`);
        await fs.writeFile(path.join(screenshots, `${page}${width === 1600 ? '' : '-'+width}.png`), await screenshot());
      }

      if (['groups','workspace','notifications'].includes(page)) {
        await resize(1200,650);
        const modalIds=page==='groups'?['serverGroupModal','uptimeGroupModal']:page==='workspace'?['createTeamModal']:['backupNotificationRouteModal'];
        for (const id of modalIds) {
          await win.webContents.executeJavaScript(`document.getElementById('${id}').classList.remove('hidden');new Promise(resolve=>requestAnimationFrame(resolve))`);
          for (const channel of page==='notifications'?['desktop','email','webhook','slack','teams']:['']) {
            const modal=await win.webContents.executeJavaScript(`(() => {
              if ('${channel}') {els.backupNotificationRouteType.value='${channel}';syncBackupNotificationRouteFields();}
              const dialog=document.getElementById('${id}');
              const footer=dialog.querySelector('.modal-footer').getBoundingClientRect();
              const body=dialog.querySelector('.modal-body');
              const fields=[...dialog.querySelectorAll('.field')].filter(el=>el.getClientRects().length);
              return {bottom:footer.bottom,top:footer.top,overflow:body.scrollWidth>body.clientWidth+1,aligned:fields.every(el=>getComputedStyle(el).alignContent==='start')};
            })()`);
            assert.ok(modal.bottom<=650 && modal.top>=0,`${id}/${channel}: footer must fit short window`);
            assert.equal(modal.overflow,false,`${id}/${channel}: form overflow`);
            assert.ok(modal.aligned,`${id}/${channel}: form alignment`);
          }
          await fs.writeFile(path.join(screenshots, `${id}.png`),await screenshot());
          await win.webContents.executeJavaScript(`document.getElementById('${id}').classList.add('hidden')`);
        }
      }

      if (page === 'groups') {
        const tabs = await win.webContents.executeJavaScript(`(() => {
          const first=document.getElementById('settingsServerGroupsTab'), last=document.getElementById('settingsMonitorGroupsTab');
          first.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
          const selected=last.getAttribute('aria-selected')==='true' && document.activeElement===last && !document.getElementById('uptimeMonitorGroupCreateButton').classList.contains('hidden');
          last.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
          return selected && first.getAttribute('aria-selected')==='true' && document.getElementById('uptimeMonitorGroupCreateButton').classList.contains('hidden');
        })()`);
        assert.ok(tabs, 'Group tabs and contextual actions must switch with keyboard');
        const permissionPreserved=await win.webContents.executeJavaScript(`(() => {
          const action=document.getElementById('uptimeMonitorGroupCreateButton');action.disabled=true;
          document.getElementById('settingsMonitorGroupsTab').click();
          const protectedAction=action.disabled;action.disabled=false;document.getElementById('settingsServerGroupsTab').click();return protectedAction;
        })()`);
        assert.ok(permissionPreserved,'Switching tabs must not enable a permission-disabled action');
      }
      if (page === 'groups' || page === 'notifications') {
        for (const count of [0,1,40]) {
          const list = await win.webContents.executeJavaScript(`(() => {
            window.fillSettingsFixture(${count});
            const card=document.querySelector('[data-settings-panel="${page}"] .settings-list-card');
            const scroll=card.querySelector('.settings-list-scroll:not(.hidden)');
            return {height:card.clientHeight,scrollHeight:scroll.clientHeight,content:scroll.scrollHeight,empty:document.getElementById('${page === 'groups' ? 'serverGroupsEmpty' : 'backupNotificationRoutesEmpty'}').classList.contains('hidden')};
          })()`);
          assert.ok(list.height >= 418 && list.height < 900, `${page}: bounded full-height list`);
          assert.equal(list.empty, count > 0);
          if (count === 40) assert.ok(list.content > list.scrollHeight, 'Long list must scroll');
        }
        await win.webContents.executeJavaScript('window.fillSettingsFixture(3)');
      }
      if (page === 'backup' || page === 'notifications') {
        const id = page === 'backup' ? 'settingsBackupHistoryDialog' : 'settingsDeliveryHistoryDialog';
        await win.webContents.executeJavaScript(`document.querySelector('[data-settings-dialog="${id}"]').click()`);
        const dialog = await win.webContents.executeJavaScript(`(() => { const d=document.getElementById('${id}');const r=d.querySelector('footer').getBoundingClientRect();return {open:d.open,focus:d.contains(document.activeElement),bottom:r.bottom};})()`);
        assert.ok(dialog.open && dialog.focus && dialog.bottom <= 800, 'Dialog opens with focus and reachable footer');
        await fs.writeFile(path.join(screenshots, `${page}-history.png`),await screenshot());
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await new Promise(resolve=>setTimeout(resolve,50));
        const closed = await win.webContents.executeJavaScript(`!document.getElementById('${id}').open && document.activeElement.dataset.settingsDialog==='${id}'`);
        assert.ok(closed, 'Escape closes dialog and returns focus');
      }
      if (page === 'templates') {
        const editor = await win.webContents.executeJavaScript(`(() => {
          document.getElementById('templateEditorEmptyState').classList.add('hidden');
          const form=document.getElementById('templatePageForm');form.classList.remove('hidden');
          const body=form.querySelector('.template-editor'),footer=form.querySelector('footer');
          return {scroll:getComputedStyle(body).overflowY,form:form.clientHeight,footer:footer.clientHeight,save:document.getElementById('templatePageSaveButton').form===form};
        })()`);
        assert.equal(editor.scroll,'auto'); assert.ok(editor.form>editor.footer && editor.save);
        await win.webContents.executeJavaScript(`document.getElementById('templatePageForm').classList.add('hidden');document.getElementById('templateEditorEmptyState').classList.remove('hidden')`);
      }
      if (page === 'theme') {
        const themes=await win.webContents.executeJavaScript(`els.themeOptions.map(button=>button.dataset.themeOption)`);
        for (const theme of themes) {
          const active=await win.webContents.executeJavaScript(`(() => {applyTheme('${theme}',{persist:false,announce:false});return els.themeOptions.filter(button=>button.getAttribute('aria-pressed')==='true').map(button=>button.dataset.themeOption);})()`);
          assert.deepEqual(active,[theme],'Exactly one theme must be selected');
        }
      }
      if (page === 'integrations') {
        const expanded=await win.webContents.executeJavaScript(`(() => {
          const details=document.querySelector('.mcp-documentation-card');details.open=true;
          document.getElementById('mcpIntegrationUrl').textContent='http://127.0.0.1:43821/mcp';
          const fields=[...details.querySelectorAll('.field')].filter(el=>el.getClientRects().length);
          return {fields:fields.length,aligned:fields.every(el=>getComputedStyle(el).alignContent==='start'),overflow:document.documentElement.scrollWidth>innerWidth+1,form:document.getElementById('mcpIntegrationStartButton').form?.id};
        })()`);
        assert.ok(expanded.fields>0 && expanded.aligned && !expanded.overflow,'Expanded integration settings must fit and align');
        assert.equal(expanded.form,'mcpIntegrationForm');
      }
      console.log(`SETTINGS UI VERIFIED: ${page}`);
    }
    console.log(`Screenshots: ${screenshots}`);
  } finally {
    win.destroy();
    await fs.unlink(path.join(temporary, 'index.html'));
    await fs.rmdir(temporary);
    clearTimeout(timer);
  }
  app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timer);app.exit(1)});
