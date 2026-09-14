// Isolated renderer check. Does not load the application backend or contact any server.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = process.argv[2];
const timer = setTimeout(() => { console.error('UI check timed out.'); app.exit(1); }, 20000);

app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(root, 'src/renderer/renderer.js'), 'utf8');
  const html = await fs.readFile(path.join(root, 'src/renderer/index.html'), 'utf8');
  const styles = await fs.readFile(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const fixture = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '').replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '')
    .replace('</head>', `<style>${styles}</style></head>`);
  const window = new BrowserWindow({ show: false, width: 1600, height: 950, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  window.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message); });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-ui-check-'));
  const fixturePath = path.join(temporary, 'index.html');
  await fs.writeFile(fixturePath, fixture.replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'src/renderer') + path.sep).href}">`));
  await window.loadFile(fixturePath);
  await fs.unlink(fixturePath);
  await fs.rmdir(temporary);
  function definition(name) {
    const start = source.indexOf(`function ${name}(`);
    const tail = source.slice(start + 1);
    const next = tail.search(/\n(?:async )?function /);
    return source.slice(start, start + 1 + next);
  }
  const setup = await window.webContents.executeJavaScript(`try {
    document.documentElement.dataset.theme = 'termius-dark';
    const section = document.getElementById('aiDeploymentsView');
    const sprite = document.querySelector('.icon-sprite');
    document.body.replaceChildren(sprite, section);
    section.classList.remove('hidden');
    section.style.cssText = 'height:100vh;width:100%;display:flex;flex-direction:column;';
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
    const state = { projects: [{id:'server',name:'Production'}], aiDeployments: {
      items: Array.from({length:30}, (_,i) => ({id:'deployment-'+i,name:'Deployment '+(i+1),projectId:'server',agentId:'codex',localPath:'C:/Projects/App '+(i+1),status:'running',lastRunAt:new Date().toISOString(),runs:[{id:'run-'+i,status:'running',percent:75,message:'AI agent is deploying and verifying the project…',startedAt:new Date().toISOString(),sessionId:'session-'+i,log:('[INFO] Upload complete.'+String.fromCharCode(10)+'[SSH] Checking deployed application.'+String.fromCharCode(10)).repeat(25)}]})),
      agents:[{id:'codex',name:'Codex'}], serverFilters:new Set(),statusFilters:new Set(),logDeploymentId:'deployment-0',logRunId:'run-0'
    }};
    const formatDateTime = value => new Date(value).toLocaleString();
    ${['escapeHtml','icon','aiDeploymentProject','aiDeploymentAgent','aiDeploymentStatusLabel','setAiDeploymentProgress','aiDeploymentActionButtons','filteredAiDeployments','renderAiDeployments','renderAiDeploymentLogDetail'].map(definition).join('\n')}
    renderAiDeployments();
    Object.assign(window, { els, state, renderAiDeploymentLogDetail });
    'ready';
  } catch (error) { error.stack; }`);
  assert.equal(setup, 'ready');
  const list = await window.webContents.executeJavaScript(`({
    rows: document.querySelectorAll('#aiDeploymentTableBody tr').length,
    viewButtons: document.querySelectorAll('[data-ai-deployment-view]').length,
    progressInsideSession: document.getElementById('aiDeploymentLogDetailDialog').contains(document.getElementById('aiDeploymentStatus')),
    actionsFit: [...document.querySelectorAll('.ai-deployment-actions')].every(el => el.scrollWidth <= el.clientWidth),
    labels: [...document.querySelector('.ai-deployment-actions').querySelectorAll('button')].slice(0,3).map(el => el.textContent.trim())
  })`);
  assert.equal(list.rows, 30);
  assert.equal(list.viewButtons, 30);
  assert.equal(list.progressInsideSession, true);
  assert.equal(list.actionsFit, true);
  assert.deepEqual(list.labels, ['Run', 'View', 'Logs']);
  await new Promise(resolve => setTimeout(resolve, 150));
  if (output) { await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'deployment-list.png'), (await window.webContents.capturePage()).toPNG()); }
  await window.webContents.executeJavaScript(`renderAiDeploymentLogDetail(); document.getElementById('aiDeploymentLogDetailDialog').showModal();`);
  const session = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.getElementById('aiDeploymentLogDetailDialog');
    const done = document.getElementById('aiDeploymentLogDetailDoneButton').getBoundingClientRect();
    return { inViewport: done.bottom <= innerHeight && done.top >= 0, logScrolls: els.aiDeploymentLogContent.scrollHeight > els.aiDeploymentLogContent.clientHeight, status: els.aiDeploymentProgressLabel.textContent };
  })()`);
  assert.equal(session.inViewport, true);
  assert.equal(session.logScrolls, true);
  await new Promise(resolve => setTimeout(resolve, 150));
  if (output) await fs.writeFile(path.join(output, 'deployment-session.png'), (await window.webContents.capturePage()).toPNG());
  window.setSize(900, 600);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.equal(await window.webContents.executeJavaScript(`document.getElementById('aiDeploymentLogDetailDoneButton').getBoundingClientRect().bottom <= innerHeight`), true);
  console.log('UI check passed: 30 rows, Run/View/Logs ordering, scoped progress, scrollable session, visible close button.');
  clearTimeout(timer);
  app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(timer); app.exit(1); });
