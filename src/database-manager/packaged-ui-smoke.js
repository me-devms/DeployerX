const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectWindowsRuntimeModules } = require('./windows-runtime-module-trust');

const PACKAGED_SMOKE_ARGUMENT = '--database-manager-packaged-smoke';
const PACKAGED_SMOKE_RELEASE_ARGUMENT = '--database-manager-packaged-smoke-release=';
const PACKAGED_SMOKE_SCHEMA_VERSION = 1;
const PACKAGED_SMOKE_TIMEOUT_MS = 45000;
const MAX_SMOKE_OUTPUT_BYTES = 1024 * 1024;
const SMOKE_PROCESS_LINE_PATTERN = /^DEPLOYERX_DATABASE_MANAGER_SMOKE_PROCESS_ID=([1-9][0-9]{0,9})$/;
const REQUIRED_CHECKS = Object.freeze([
  'renderer-loaded',
  'window-policy',
  'preload-bridge',
  'database-route',
  'database-tabs',
  'database-add-control',
  'renderer-node-require',
  'renderer-node-buffer',
  'renderer-process-isolation',
  'renderer-ipc-isolation'
]);

class PackagedUiSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PackagedUiSmokeError';
    this.code = code;
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function minimalWindowsEnvironment(environment) {
  const windowsRoot = String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows');
  const result = {
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    ComSpec: path.join(windowsRoot, 'System32', 'cmd.exe'),
    PATH: path.join(windowsRoot, 'System32')
  };
  for (const key of ['TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
    const value = String(environment[key] || '').trim();
    if (value && value.length <= 32767 && !value.includes('\0')) result[key] = value;
  }
  return result;
}

function parsePackagedSmokeReport(output) {
  const source = String(output || '');
  if (!source || Buffer.byteLength(source, 'utf8') > MAX_SMOKE_OUTPUT_BYTES) return null;
  const lastLine = source.trim().split(/\r?\n/).at(-1);
  let report;
  try { report = JSON.parse(lastLine); }
  catch { return null; }
  if (!exactKeys(report, ['schemaVersion', 'passed', 'checks'])
    || report.schemaVersion !== PACKAGED_SMOKE_SCHEMA_VERSION
    || report.passed !== true
    || !Array.isArray(report.checks)
    || report.checks.length !== REQUIRED_CHECKS.length) return null;
  for (let index = 0; index < REQUIRED_CHECKS.length; index += 1) {
    const check = report.checks[index];
    if (!exactKeys(check, ['name', 'status']) || check.name !== REQUIRED_CHECKS[index] || check.status !== 'passed') return null;
  }
  return Object.freeze({ passed: true });
}

async function runPackagedApplicationSmoke(executablePath, {
  execute = null,
  spawnProcess = spawn,
  runtimeModuleInspector = inspectWindowsRuntimeModules,
  signerFingerprint = null,
  fileSystem = fs,
  environment = process.env,
  temporaryRoot = os.tmpdir(),
  applicationArguments = []
} = {}) {
  const root = await fileSystem.mkdtemp(path.join(temporaryRoot, 'deployerx-packaged-smoke-'));
  const profilePath = path.join(root, 'profile');
  const releasePath = path.join(profilePath, 'release.signal');
  await fileSystem.mkdir(profilePath, { recursive: true });
  let stdout = '';
  try {
    const args = [
      ...applicationArguments,
      PACKAGED_SMOKE_ARGUMENT,
      `${PACKAGED_SMOKE_RELEASE_ARGUMENT}${releasePath}`,
      `--user-data-dir=${profilePath}`,
      '--disable-gpu',
      '--no-first-run'
    ];
    const options = {
        env: minimalWindowsEnvironment(environment),
        windowsHide: true,
        timeout: PACKAGED_SMOKE_TIMEOUT_MS,
        maxBuffer: MAX_SMOKE_OUTPUT_BYTES,
        encoding: 'utf8'
      };
    if (execute) {
      try {
        ({ stdout } = await execute(executablePath, args, options));
      } catch (error) {
        stdout = typeof error?.stdout === 'string' ? error.stdout : '';
        if (!stdout) throw new PackagedUiSmokeError('WINDOWS_ARTIFACT_APPLICATION_SMOKE_PROCESS_FAILED');
      }
      return Boolean(parsePackagedSmokeReport(stdout));
    }
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(executablePath, args, {
        env: options.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stderr = '';
      let reportSeen = false;
      let accepted = false;
      let inspection = Promise.resolve();
      let settled = false;
      const finish = (error, value = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const release = () => {
        fileSystem.writeFile(releasePath, 'release', { flag: 'wx' }).catch(() => {});
      };
      const inspectReport = () => {
        if (reportSeen) return;
        const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
        const candidate = lines.at(-1);
        if (!candidate) return;
        let report;
        try { report = JSON.parse(candidate); }
        catch { return; }
        if (report?.schemaVersion !== PACKAGED_SMOKE_SCHEMA_VERSION || !Array.isArray(report?.checks)) return;
        const processLine = lines.find((line) => SMOKE_PROCESS_LINE_PATTERN.test(line));
        const reportedProcessId = Number(processLine?.match(SMOKE_PROCESS_LINE_PATTERN)?.[1]);
        if (!Number.isSafeInteger(reportedProcessId) || reportedProcessId < 1) {
          reportSeen = true;
          inspection = Promise.resolve();
          release();
          return;
        }
        reportSeen = true;
        const uiAccepted = Boolean(parsePackagedSmokeReport(candidate));
        inspection = uiAccepted
          ? Promise.resolve(runtimeModuleInspector({
            rootProcessId: reportedProcessId,
            applicationExecutable: executablePath,
            signerFingerprint,
            requireApplicationSignatures: applicationArguments.length === 0,
            environment
          })).then((evidence) => { accepted = evidence?.passed === true; }, () => { accepted = false; })
          : Promise.resolve();
        inspection.finally(release);
      };
      const append = (stream, chunk) => {
        const value = chunk.toString('utf8');
        if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') + Buffer.byteLength(value, 'utf8') > MAX_SMOKE_OUTPUT_BYTES) {
          child.kill();
          finish(new PackagedUiSmokeError('WINDOWS_ARTIFACT_APPLICATION_SMOKE_OUTPUT_EXCESSIVE'));
          return;
        }
        if (stream === 'stdout') {
          stdout += value;
          inspectReport();
        } else {
          stderr += value;
        }
      };
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.once('error', () => finish(new PackagedUiSmokeError('WINDOWS_ARTIFACT_APPLICATION_SMOKE_PROCESS_FAILED')));
      child.once('close', (code) => {
        inspection.finally(() => finish(null, reportSeen && accepted && code === 0));
      });
      const timeout = setTimeout(() => {
        child.kill();
        finish(new PackagedUiSmokeError('WINDOWS_ARTIFACT_APPLICATION_SMOKE_TIMEOUT'));
      }, PACKAGED_SMOKE_TIMEOUT_MS);
    });
  } finally {
    await fileSystem.rm(root, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_SMOKE_OUTPUT_BYTES,
  PACKAGED_SMOKE_ARGUMENT,
  PACKAGED_SMOKE_RELEASE_ARGUMENT,
  PACKAGED_SMOKE_TIMEOUT_MS,
  SMOKE_PROCESS_LINE_PATTERN,
  PackagedUiSmokeError,
  minimalWindowsEnvironment,
  parsePackagedSmokeReport,
  runPackagedApplicationSmoke
};
