const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { signatureMatches, verifyAuthenticode } = require('./windows-binary-trust');

const execFileAsync = promisify(execFile);
const REPORT_SCHEMA_VERSION = 1;
const MAX_PROCESS_COUNT = 64;
const MAX_MODULE_COUNT = 2048;
const MAX_MODULE_PATH_BYTES = 32767;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MODULE_QUERY_TIMEOUT_MS = 15000;
const MODULE_PATH_PATTERN = /\.(?:cpl|dll|drv|exe|node)$/i;
const POWERSHELL_MODULE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$rootProcessId=[int]$env:DEPLOYERX_RUNTIME_ROOT_PROCESS_ID',
  '$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)',
  '$children=@{}',
  'foreach($row in $rows){$parent=[int]$row.ParentProcessId;if(-not $children.ContainsKey($parent)){$children[$parent]=New-Object System.Collections.Generic.List[int]};$children[$parent].Add([int]$row.ProcessId)}',
  '$processIds=New-Object System.Collections.Generic.HashSet[int]',
  '$queue=New-Object System.Collections.Generic.Queue[int]',
  '$queue.Enqueue($rootProcessId)',
  `while($queue.Count -gt 0){$current=$queue.Dequeue();if($processIds.Add($current) -and $processIds.Count -le ${MAX_PROCESS_COUNT} -and $children.ContainsKey($current)){foreach($childId in $children[$current]){$queue.Enqueue($childId)}}}`,
  `if($processIds.Count -lt 1 -or $processIds.Count -gt ${MAX_PROCESS_COUNT}){throw 'process-count'}`,
  '$modulePaths=New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)',
  '$liveProcessCount=0',
  'foreach($processId in $processIds){$process=Get-Process -Id $processId -ErrorAction SilentlyContinue;if($null -eq $process){continue};$liveProcessCount+=1;foreach($module in $process.Modules){if($null -ne $module.FileName){[void]$modulePaths.Add([string]$module.FileName)}}}',
  `if($liveProcessCount -lt 1 -or $liveProcessCount -gt ${MAX_PROCESS_COUNT}){throw 'live-process-count'}`,
  `if($modulePaths.Count -lt 1 -or $modulePaths.Count -gt ${MAX_MODULE_COUNT}){throw 'module-count'}`,
  '$encoded=@($modulePaths | Sort-Object | ForEach-Object {[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_))})',
  `[pscustomobject]@{schemaVersion=${REPORT_SCHEMA_VERSION};processCount=$liveProcessCount;modules=$encoded}|ConvertTo-Json -Compress -Depth 3`
].join(';');

class WindowsRuntimeModuleTrustError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WindowsRuntimeModuleTrustError';
    this.code = code;
  }
}

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function decodeModulePath(value) {
  const source = String(value || '');
  if (!source || source.length > Math.ceil(MAX_MODULE_PATH_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) return null;
  const bytes = Buffer.from(source, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_MODULE_PATH_BYTES || bytes.toString('base64') !== source) return null;
  const decoded = bytes.toString('utf8');
  if (!decoded || decoded.includes('\0') || !path.isAbsolute(decoded) || !MODULE_PATH_PATTERN.test(decoded)) return null;
  return path.resolve(decoded);
}

function isolatedWindowsEnvironment(environment, rootProcessId) {
  const windowsRoot = String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows');
  return {
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    ComSpec: path.join(windowsRoot, 'System32', 'cmd.exe'),
    PATH: path.join(windowsRoot, 'System32'),
    DEPLOYERX_RUNTIME_ROOT_PROCESS_ID: String(rootProcessId)
  };
}

async function enumerateWindowsProcessModules(rootProcessId, {
  execute = execFileAsync,
  environment = process.env,
  powershellPath = null
} = {}) {
  if (!Number.isSafeInteger(rootProcessId) || rootProcessId < 1) {
    throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_PROCESS_INVALID');
  }
  const childEnvironment = isolatedWindowsEnvironment(environment, rootProcessId);
  const executable = powershellPath || path.join(childEnvironment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stdout;
  try {
    ({ stdout } = await execute(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', POWERSHELL_MODULE_SCRIPT
    ], {
      env: childEnvironment,
      windowsHide: true,
      timeout: MODULE_QUERY_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8'
    }));
  } catch {
    throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_QUERY_FAILED');
  }
  let report;
  try { report = JSON.parse(String(stdout || '').trim()); }
  catch { throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_RESPONSE_INVALID'); }
  if (!exactObject(report, ['schemaVersion', 'processCount', 'modules'])
    || report.schemaVersion !== REPORT_SCHEMA_VERSION
    || !Number.isSafeInteger(report.processCount)
    || report.processCount < 1
    || report.processCount > MAX_PROCESS_COUNT
    || !Array.isArray(report.modules)
    || report.modules.length < 1
    || report.modules.length > MAX_MODULE_COUNT) {
    throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_RESPONSE_INVALID');
  }
  const modules = report.modules.map(decodeModulePath);
  if (modules.some((modulePath) => !modulePath)
    || new Set(modules.map((modulePath) => modulePath.toLowerCase())).size !== modules.length) {
    throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_RESPONSE_INVALID');
  }
  return Object.freeze({ processCount: report.processCount, modules: Object.freeze(modules) });
}

function isInsideWindowsPath(parentPath, childPath) {
  const parent = path.resolve(parentPath).toLowerCase();
  const child = path.resolve(childPath).toLowerCase();
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function inspectWindowsRuntimeModules({
  rootProcessId,
  applicationExecutable,
  signerFingerprint = null,
  requireApplicationSignatures = true,
  enumerate = enumerateWindowsProcessModules,
  fileSystem = fs,
  signatureVerifier = verifyAuthenticode,
  environment = process.env
} = {}) {
  if (requireApplicationSignatures && !/^[0-9a-f]{64}$/.test(String(signerFingerprint || '').toLowerCase())) {
    throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_SIGNER_INVALID');
  }
  const applicationRealPath = await fileSystem.realpath(applicationExecutable);
  const applicationDirectory = path.dirname(applicationRealPath);
  const windowsDirectory = await fileSystem.realpath(String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows'));
  const evidence = await enumerate(rootProcessId, { environment });
  const applicationModules = [];
  let applicationFound = false;
  for (const modulePath of evidence.modules) {
    let entry;
    let moduleRealPath;
    try {
      entry = await fileSystem.lstat(modulePath);
      moduleRealPath = await fileSystem.realpath(modulePath);
    } catch {
      throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_INVALID');
    }
    if (!entry.isFile()) throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_INVALID');
    if (moduleRealPath.toLowerCase() === applicationRealPath.toLowerCase()) applicationFound = true;
    if (isInsideWindowsPath(windowsDirectory, moduleRealPath)) continue;
    if (!isInsideWindowsPath(applicationDirectory, moduleRealPath)) {
      throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_OUTSIDE_TRUSTED_ROOTS');
    }
    applicationModules.push(Object.freeze({ path: moduleRealPath, size: entry.size, mtimeMs: entry.mtimeMs }));
  }
  if (!applicationFound || applicationModules.length < 1) {
    throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_APPLICATION_MODULE_MISSING');
  }
  if (requireApplicationSignatures) {
    const results = await Promise.all(applicationModules.map(async (module) => {
      const signature = await signatureVerifier(module.path);
      const after = await fileSystem.lstat(module.path);
      return signatureMatches(signature, signerFingerprint)
        && after.isFile()
        && after.size === module.size
        && after.mtimeMs === module.mtimeMs;
    }));
    if (results.some((accepted) => !accepted)) {
      throw new WindowsRuntimeModuleTrustError('WINDOWS_ARTIFACT_RUNTIME_MODULE_SIGNATURE_INVALID');
    }
  }
  return Object.freeze({
    passed: true,
    processCount: evidence.processCount,
    moduleCount: evidence.modules.length,
    applicationModuleCount: applicationModules.length
  });
}

module.exports = {
  MAX_MODULE_COUNT,
  MAX_OUTPUT_BYTES,
  MAX_PROCESS_COUNT,
  MODULE_QUERY_TIMEOUT_MS,
  POWERSHELL_MODULE_SCRIPT,
  WindowsRuntimeModuleTrustError,
  decodeModulePath,
  enumerateWindowsProcessModules,
  inspectWindowsRuntimeModules,
  isolatedWindowsEnvironment,
  isInsideWindowsPath
};
