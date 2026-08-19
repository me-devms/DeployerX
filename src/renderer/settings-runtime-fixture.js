const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

function stubSource() {
  return `(() => {
    const responses = {
      getSetup: { setupComplete: true, mode: 'offline', firebase: null },
      getAppMetadata: { version: '0.2.4' },
      getUpdateState: {},
      listProjects: { projects: [], templates: [] }
    };
    const eventMethods = new Set([
      'onAppUpdateEvent', 'onDeploymentEvent', 'onTerminalEvent', 'onMcpTerminalEvent',
      'onServerMonitoringEvent', 'onRdpEvent', 'onVncEvent', 'onVncFullscreenChanged',
      'onServerMonitoringFullscreenChanged', 'onUptimeEvent', 'onUptimeNavigate',
      'onDatabaseManagerEvent'
    ]);
    window.deployerx = new Proxy({}, {
      get(_target, property) {
        if (property === 'getTheme') return () => 'deployerx-light';
        if (eventMethods.has(property)) return () => () => {};
        return (...args) => Promise.resolve(responses[property] ?? []);
      }
    });
    window.addEventListener('error', (event) => {
      console.error('[fixture:error]', event.error?.stack || event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      console.error('[fixture:unhandledrejection]', event.reason?.stack || event.reason);
    });
  })();`;
}

async function prepareHtml(outputDirectory) {
  let html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  html = html.replace('./styles.css', pathToFileURL(path.join(__dirname, 'styles.css')).href);
  html = html.replaceAll('../../assets/deployerx-logo.png', pathToFileURL(path.join(__dirname, '..', '..', 'assets', 'deployerx-logo.png')).href);
  html = html.replaceAll('assets/everythingx-logo-transparent.png', pathToFileURL(path.join(__dirname, 'assets', 'everythingx-logo-transparent.png')).href);
  html = html.replaceAll('../../node_modules/', pathToFileURL(path.join(__dirname, '..', '..', 'node_modules')).href + '/');
  html = html.replaceAll('../database-manager/', pathToFileURL(path.join(__dirname, '..', 'database-manager')).href + '/');
  html = html.replace('./renderer.js', pathToFileURL(path.join(__dirname, 'renderer.js')).href);
  await fs.writeFile(path.join(outputDirectory, 'deployerx-test-stub.js'), stubSource(), 'utf8');
  html = html.replace('</head>', '<script src="./deployerx-test-stub.js"></script></head>');
  const htmlPath = path.join(outputDirectory, 'settings-runtime.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}

async function main() {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('Settings runtime fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const htmlPath = await prepareHtml(outputDirectory);
  await app.whenReady();
  const browserWindow = new BrowserWindow({ show: false, width: 1280, height: 800 });
  const consoleMessages = [];
  browserWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    consoleMessages.push({ message, line, sourceId });
  });
  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    consoleMessages.push({ message: `render-process-gone:${details.reason}` });
  });
  try {
    await browserWindow.loadFile(htmlPath);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await browserWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('teamButton')?.click();
      const parentChain = (element) => {
        const chain = [];
        for (let current = element; current && chain.length < 8; current = current.parentElement) {
          chain.push(current.tagName.toLowerCase() + '#' + current.id + '.' + current.className);
        }
        return chain;
      };
      const inspect = (tab) => {
        document.querySelector('[data-settings-tab="' + tab + '"]')?.click();
        const panel = document.querySelector('[data-settings-panel="' + tab + '"]');
        const rect = panel?.getBoundingClientRect();
        const style = panel ? getComputedStyle(panel) : null;
        return {
          tab,
          activeNav: document.querySelectorAll('[data-settings-tab].active').length,
          activePanels: document.querySelectorAll('[data-settings-panel].active').length,
          panelClass: panel?.className || '',
          parentChain: parentChain(panel),
          display: style?.display || '',
          visibility: style?.visibility || '',
          rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          textLength: panel?.innerText?.length || 0,
          bodyTextLength: document.body.innerText.length,
          teamHidden: document.getElementById('teamView')?.classList.contains('hidden') || false,
          teamRect: (() => { const value = document.getElementById('teamView')?.getBoundingClientRect(); return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null; })(),
          layoutRect: (() => { const value = document.querySelector('.settings-layout')?.getBoundingClientRect(); return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null; })(),
          navRect: (() => { const value = document.querySelector('.settings-nav')?.getBoundingClientRect(); return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null; })(),
          contentRect: (() => { const value = document.querySelector('.settings-content')?.getBoundingClientRect(); return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null; })()
          ,contentStyle: (() => { const element = document.querySelector('.settings-content'); const style = element ? getComputedStyle(element) : null; return style ? { display: style.display, position: style.position, gridColumn: style.gridColumn, gridRow: style.gridRow, height: style.height, overflow: style.overflow } : null; })()
          ,layoutStyle: (() => { const element = document.querySelector('.settings-layout'); const style = element ? getComputedStyle(element) : null; return style ? { display: style.display, position: style.position, gridTemplateRows: style.gridTemplateRows, gridAutoRows: style.gridAutoRows, alignItems: style.alignItems, height: style.height, overflow: style.overflow } : null; })()
          ,panelLayout: panel ? (() => { const style = getComputedStyle(panel); return { offsetTop: panel.offsetTop, offsetParent: panel.offsetParent?.className || panel.offsetParent?.id || '', position: style.position, marginTop: style.marginTop, paddingTop: style.paddingTop, transform: style.transform, alignSelf: style.alignSelf, gridRow: style.gridRow, top: style.top }; })() : null
        };
      };
      return {
        theme: inspect('theme'),
        about: inspect('about'),
        contentChildren: [...document.querySelector('.settings-content')?.children || []].map((element) => element.id || element.dataset.settingsPanel || element.className),
        integrationParent: parentChain(document.getElementById('settingsIntegrationsPanel'))
      };
    })()`);
    process.stdout.write(`${JSON.stringify({ result, consoleMessages })}\n`);
  } finally {
    browserWindow.destroy();
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
