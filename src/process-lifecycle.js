const path = require('node:path');

function normalizeWindowsPath(value) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  return path.win32.normalize(raw).replace(/[\\/]+$/, '').toLowerCase();
}

function processExecutableName(record = {}) {
  const executablePath = String(record.executablePath || '').trim();
  const name = String(record.name || '').trim();
  return path.win32.basename(executablePath || name).toLowerCase();
}

function isDeployerXMainProcess(record = {}) {
  const pid = Number(record.pid || record.processId || 0);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const executableName = processExecutableName(record);
  const commandLine = String(record.commandLine || '').trim();
  const isDeployerXExecutable = executableName === 'deployerx.exe';
  const isElectronExecutable = executableName === 'electron.exe'
    && (/(?:^|\s)--uptime-worker(?:\s|$)/i.test(commandLine)
      || /electron\.exe"?\s+(?:"[^"\r\n]*[\\/]DeployerX"?|\.)\s*$/i.test(commandLine));
  if (!isDeployerXExecutable && !isElectronExecutable) return false;

  // Electron renderer, GPU, utility, and crash-handler processes reuse the app
  // executable name. Only the top-level process owns the app/tray lifetime.
  return !/(?:^|\s)--type(?:=|\s)|(?:^|\s)--utility-sub-type(?:=|\s)/i.test(commandLine);
}

function selectDeployerXProcesses(records = [], {
  currentPid = process.pid,
  currentExecutablePath = process.execPath,
  includeCurrentExecutable = false
} = {}) {
  const currentProcessId = Number(currentPid || 0);
  const currentExecutable = normalizeWindowsPath(currentExecutablePath);
  const candidates = (Array.isArray(records) ? records : [])
    .filter((record) => isDeployerXMainProcess(record))
    .filter((record) => Number(record.pid || record.processId || 0) !== currentProcessId);
  const candidatePids = new Set(candidates.map((record) => Number(record.pid || record.processId || 0)));
  return candidates
    .filter((record) => !candidatePids.has(Number(record.parentPid || record.parentProcessId || 0)))
    .filter((record) => {
      if (includeCurrentExecutable) return true;
      const executablePath = normalizeWindowsPath(record.executablePath);
      return !executablePath || executablePath !== currentExecutable;
    });
}

module.exports = {
  isDeployerXMainProcess,
  normalizeWindowsPath,
  processExecutableName,
  selectDeployerXProcesses
};
