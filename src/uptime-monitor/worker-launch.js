function buildWorkerLaunchArgs({ defaultApp = false, isPackaged = true, appPath = '' } = {}) {
  if (defaultApp || !isPackaged) {
    const normalizedAppPath = String(appPath || '').trim();
    if (!normalizedAppPath) throw new TypeError('The application path is required for an unpackaged worker.');
    return [normalizedAppPath, '--uptime-worker'];
  }
  return ['--uptime-worker'];
}

function buildLoginItemSettings({ enabled, execPath, args } = {}) {
  const normalizedExecPath = String(execPath || '').trim();
  if (!normalizedExecPath) throw new TypeError('The executable path is required for worker autostart.');
  return {
    openAtLogin: Boolean(enabled),
    openAsHidden: true,
    path: normalizedExecPath,
    args: Array.isArray(args) ? args.map((argument) => String(argument)) : []
  };
}

function quoteLinuxExecArgument(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function buildLinuxAutostartEntry({ execPath, args } = {}) {
  const launch = buildLoginItemSettings({ enabled: true, execPath, args });
  const execParts = [quoteLinuxExecArgument(launch.path), ...launch.args.map(quoteLinuxExecArgument)];
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DeployerX Uptime Worker',
    'Comment=Run DeployerX uptime monitoring in the background',
    `Exec=${execParts.join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n');
}

module.exports = {
  buildLinuxAutostartEntry,
  buildLoginItemSettings,
  buildWorkerLaunchArgs,
  quoteLinuxExecArgument
};
