const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'src');
const electronBin = require('electron');

let appProcess = null;
let restartTimer = null;
let isRestarting = false;
let isShuttingDown = false;

function startElectron() {
  appProcess = spawn(electronBin, ['.'], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  appProcess.on('exit', (code) => {
    if (isRestarting || isShuttingDown) return;
    process.exit(code || 0);
  });
}

function stopElectron(callback) {
  if (!appProcess || appProcess.killed) {
    callback();
    return;
  }

  const currentProcess = appProcess;
  const forceKillTimer = setTimeout(() => {
    if (!currentProcess.killed) currentProcess.kill('SIGKILL');
  }, 1500);

  currentProcess.once('exit', () => {
    clearTimeout(forceKillTimer);
    callback();
  });

  currentProcess.kill();
}

function restartElectron(changedFile) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    const label = changedFile ? path.relative(rootDir, changedFile) : 'src';
    console.log(`\n[dev] ${label} changed. Restarting Electron...\n`);

    isRestarting = true;
    stopElectron(() => {
      isRestarting = false;
      startElectron();
    });
  }, 150);
}

function shutdown() {
  isShuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  stopElectron(() => process.exit(0));
}

if (typeof electronBin !== 'string' || !fs.existsSync(electronBin)) {
  console.error('[dev] Electron was not found. Run npm install first.');
  process.exit(1);
}

startElectron();

const watcher = fs.watch(sourceDir, { recursive: true }, (_eventType, filename) => {
  const changedFile = filename ? path.join(sourceDir, filename.toString()) : sourceDir;
  restartElectron(changedFile);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => watcher.close());
