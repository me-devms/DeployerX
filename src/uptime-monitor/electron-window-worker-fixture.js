const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { app, BrowserWindow } = require('electron');
const { uptimeWindowCloseDisposition } = require('./window-lifecycle');

const execFileAsync = promisify(execFile);

async function main() {
  const scriptIndex = process.argv.findIndex((argument) => path.basename(String(argument)) === path.basename(__filename));
  const positional = process.argv.slice(scriptIndex + 1).filter((argument) => !String(argument).startsWith('--user-data-dir='));
  const [rootPath, baseUrl] = positional;
  if (!rootPath || !baseUrl) throw new Error('Electron lifecycle fixture requires a database path and base URL.');
  await app.whenReady();

  const window = new BrowserWindow({ show: false, width: 980, height: 640, x: -10000, y: -10000 });
  let closePrevented = false;
  window.on('close', (event) => {
    const disposition = uptimeWindowCloseDisposition({ platform: process.platform });
    if (!disposition.preventClose) return;
    event.preventDefault();
    closePrevented = true;
    if (disposition.hideWindow) window.hide();
  });
  await window.loadURL('data:text/html,<title>DeployerX lifecycle acceptance</title><main>Uptime lifecycle acceptance</main>');
  window.showInactive();

  const childPath = path.join(__dirname, 'electron-window-worker-child.js');
  const childUserData = path.join(rootPath, 'electron-worker-user-data');
  const childPromise = execFileAsync(process.execPath, [`--user-data-dir=${childUserData}`, childPath, rootPath, baseUrl], {
    detached: true,
    windowsHide: true,
    timeout: 15000
  });
  window.close();
  const closedAt = new Date().toISOString();
  const hiddenAfterClose = !window.isDestroyed() && !window.isVisible();
  const { stdout } = await childPromise;
  const childResult = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  process.stdout.write(`${JSON.stringify({
    parentProcessId: process.pid,
    childProcessId: childResult.processId,
    closePrevented,
    hiddenAfterClose,
    closedAt,
    checks: childResult.checks
  })}\n`);
  window.destroy();
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
