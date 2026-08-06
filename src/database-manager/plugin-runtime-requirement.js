const { execFile } = require('node:child_process');

const DEFAULT_RUNTIME_PROBE_TIMEOUT_MS = 2000;
const MAX_RUNTIME_PROBE_OUTPUT_BYTES = 8 * 1024;

function pluginRuntimeRequirement(entrypoint, pluginId = '') {
  if (String(entrypoint || '').toLowerCase().endsWith('.py')) return Object.freeze({ id: 'python', label: 'Python', minimumVersion: '3.8' });
  if (String(pluginId || '').toLowerCase() === 'db2') return Object.freeze({ id: 'db2-odbc', label: '64-bit IBM Db2 ODBC driver' });
  return null;
}

function pythonVersion(output) {
  const match = String(output || '').match(/\bPython\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return Object.freeze({
    display: `${Number(match[1])}.${Number(match[2])}.${Number(match[3] || 0)}`,
    major: Number(match[1]),
    minor: Number(match[2])
  });
}

function pythonVersionSupported(version, minimumVersion = '3.8') {
  const [minimumMajor, minimumMinor] = String(minimumVersion).split('.').map(Number);
  return Boolean(version && Number.isInteger(minimumMajor) && Number.isInteger(minimumMinor)
    && (version.major > minimumMajor || (version.major === minimumMajor && version.minor >= minimumMinor)));
}

function executeProbe(executable, args, { execFileImpl = execFile, timeoutMs = DEFAULT_RUNTIME_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_RUNTIME_PROBE_OUTPUT_BYTES,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(`${stdout || ''}\n${stderr || ''}`);
    });
  });
}

async function inspectPluginRuntimeRequirement(requirement, {
  platform = process.platform,
  execFileImpl = execFile,
  timeoutMs = DEFAULT_RUNTIME_PROBE_TIMEOUT_MS
} = {}) {
  if (!requirement || typeof requirement !== 'object') return requirement || null;
  if (requirement.id === 'db2-odbc') {
    const unavailable = () => Object.freeze({
      id: 'db2-odbc',
      label: '64-bit IBM Db2 ODBC driver',
      status: 'unavailable',
      reason: 'A 64-bit IBM Db2 ODBC driver is not available on this device.'
    });
    if (platform !== 'win32') return unavailable();
    const registryKeys = [
      'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers',
      'HKCU\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers'
    ];
    const results = await Promise.allSettled(registryKeys.map((key) => executeProbe('reg.exe', ['query', key], { execFileImpl, timeoutMs })));
    const found = results.some((result) => result.status === 'fulfilled' && /(?:db2|ibm[^\r\n]*(?:data|access))[^\r\n]*REG_SZ/i.test(result.value));
    return found ? Object.freeze({ id: 'db2-odbc', label: '64-bit IBM Db2 ODBC driver', status: 'available', reason: null }) : unavailable();
  }
  if (requirement.id !== 'python') return requirement;
  const label = 'Python';
  const minimumVersion = String(requirement.minimumVersion || '3.8');
  const executable = platform === 'win32' ? 'python.exe' : 'python3';
  const unavailable = () => Object.freeze({
    id: 'python',
    label,
    minimumVersion,
    status: 'unavailable',
    reason: `${label} ${minimumVersion} or newer is not available on this device.`
  });
  try {
    const version = pythonVersion(await executeProbe(executable, ['--version'], { execFileImpl, timeoutMs }));
    if (!pythonVersionSupported(version, minimumVersion)) return unavailable();
    return Object.freeze({
      id: 'python',
      label,
      minimumVersion,
      status: 'available',
      version: version.display,
      reason: null
    });
  } catch {
    return unavailable();
  }
}

module.exports = {
  DEFAULT_RUNTIME_PROBE_TIMEOUT_MS,
  inspectPluginRuntimeRequirement,
  pluginRuntimeRequirement,
  pythonVersion,
  pythonVersionSupported
};
