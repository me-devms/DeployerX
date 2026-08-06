const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { verifyAuthenticode } = require('./windows-binary-trust');

const execFileAsync = promisify(execFile);
const DEFENDER_EXECUTABLE = 'MpCmdRun.exe';
const MAX_PLATFORM_ENTRIES = 128;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFENDER_SCAN_TIMEOUT_MS = 180000;
const PLATFORM_VERSION_PATTERN = /^\d+(?:\.\d+){2,3}-\d+$/;

class WindowsDefenderScanError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WindowsDefenderScanError';
    this.code = code;
  }
}

function boundedEnvironmentValue(value, fallback = '') {
  const result = String(value || fallback).trim();
  return result && result.length <= 32767 && !result.includes('\0') ? result : fallback;
}

function isolatedDefenderEnvironment(environment) {
  const windowsRoot = boundedEnvironmentValue(environment.SystemRoot || environment.WINDIR, 'C:\\Windows');
  const systemDrive = path.parse(windowsRoot).root.replace(/[\\/]$/, '') || 'C:';
  return {
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    ComSpec: path.join(windowsRoot, 'System32', 'cmd.exe'),
    PATH: path.join(windowsRoot, 'System32'),
    ProgramData: path.join(systemDrive, 'ProgramData'),
    ProgramFiles: path.join(systemDrive, 'Program Files')
  };
}

function insideWindowsPath(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath).toLowerCase(), path.resolve(childPath).toLowerCase());
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function comparePlatformVersions(left, right) {
  const leftParts = left.match(/\d+/g).map(BigInt);
  const rightParts = right.match(/\d+/g).map(BigInt);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftValue = leftParts[index] || 0n;
    const rightValue = rightParts[index] || 0n;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

async function regularContainedExecutable(candidatePath, rootPath, fileSystem) {
  try {
    const entry = await fileSystem.lstat(candidatePath);
    if (!entry.isFile()) return null;
    const realPath = await fileSystem.realpath(candidatePath);
    return insideWindowsPath(rootPath, realPath) && path.basename(realPath).toLowerCase() === DEFENDER_EXECUTABLE.toLowerCase()
      ? realPath
      : null;
  } catch {
    return null;
  }
}

async function directDirectory(directoryPath, fileSystem) {
  try {
    const entry = await fileSystem.lstat(directoryPath);
    const realPath = await fileSystem.realpath(directoryPath);
    return entry.isDirectory() && realPath.toLowerCase() === path.resolve(directoryPath).toLowerCase() ? realPath : null;
  } catch {
    return null;
  }
}

async function resolveMicrosoftDefenderScanner({
  fileSystem = fs,
  environment = process.env,
  programDataPath = null,
  programFilesPath = null
} = {}) {
  const childEnvironment = isolatedDefenderEnvironment(environment);
  const platformRoot = path.join(programDataPath || childEnvironment.ProgramData, 'Microsoft', 'Windows Defender', 'Platform');
  try {
    const platformRealPath = await directDirectory(platformRoot, fileSystem);
    if (!platformRealPath) throw new Error('platform-root-unavailable');
    const entries = await fileSystem.readdir(platformRealPath, { withFileTypes: true });
    if (entries.length > MAX_PLATFORM_ENTRIES) throw new WindowsDefenderScanError('WINDOWS_ARTIFACT_DEFENDER_PLATFORM_EXCESSIVE');
    const versions = entries
      .filter((entry) => entry.isDirectory() && entry.name.length <= 64 && PLATFORM_VERSION_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(comparePlatformVersions)
      .reverse();
    for (const version of versions) {
      const executable = await regularContainedExecutable(path.join(platformRealPath, version, DEFENDER_EXECUTABLE), platformRealPath, fileSystem);
      if (executable) return executable;
    }
  } catch (error) {
    if (error instanceof WindowsDefenderScanError) throw error;
  }
  const legacyRoot = path.join(programFilesPath || childEnvironment.ProgramFiles, 'Windows Defender');
  const legacyRealPath = await directDirectory(legacyRoot, fileSystem);
  if (legacyRealPath) {
    const executable = await regularContainedExecutable(path.join(legacyRealPath, DEFENDER_EXECUTABLE), legacyRealPath, fileSystem);
    if (executable) return executable;
  }
  throw new WindowsDefenderScanError('WINDOWS_ARTIFACT_DEFENDER_UNAVAILABLE');
}

function trustedScannerSignature(signature) {
  return signature
    && typeof signature === 'object'
    && !Array.isArray(signature)
    && Object.keys(signature).length === 3
    && signature.status === 'valid'
    && /^[0-9a-f]{64}$/.test(String(signature.signerCertificateSha256 || '').toLowerCase())
    && signature.timestampPresent === true;
}

async function runMicrosoftDefenderScan(targetPath, {
  execute = execFileAsync,
  fileSystem = fs,
  environment = process.env,
  scannerResolver = resolveMicrosoftDefenderScanner,
  signatureVerifier = verifyAuthenticode
} = {}) {
  let targetRealPath;
  try {
    const entry = await fileSystem.lstat(targetPath);
    targetRealPath = await fileSystem.realpath(targetPath);
    if (!entry.isDirectory() || targetRealPath === path.parse(targetRealPath).root) throw new Error('unsafe-target');
  } catch {
    throw new WindowsDefenderScanError('WINDOWS_ARTIFACT_DEFENDER_TARGET_INVALID');
  }
  const scannerPath = await scannerResolver({ fileSystem, environment });
  const before = await fileSystem.lstat(scannerPath);
  const scannerRealPath = await fileSystem.realpath(scannerPath);
  if (!before.isFile() || !trustedScannerSignature(await signatureVerifier(scannerRealPath))) {
    throw new WindowsDefenderScanError('WINDOWS_ARTIFACT_DEFENDER_SCANNER_UNTRUSTED');
  }
  try {
    await execute(scannerRealPath, [
      '-Scan',
      '-ScanType', '3',
      '-File', targetRealPath,
      '-DisableRemediation'
    ], {
      env: isolatedDefenderEnvironment(environment),
      windowsHide: true,
      timeout: DEFENDER_SCAN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8'
    });
  } catch {
    throw new WindowsDefenderScanError('WINDOWS_ARTIFACT_DEFENDER_SCAN_FAILED');
  }
  const after = await fileSystem.lstat(scannerRealPath);
  if (!after.isFile()
    || await fileSystem.realpath(scannerPath) !== scannerRealPath
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs) {
    throw new WindowsDefenderScanError('WINDOWS_ARTIFACT_DEFENDER_SCANNER_CHANGED');
  }
  return true;
}

module.exports = {
  DEFENDER_EXECUTABLE,
  DEFENDER_SCAN_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  WindowsDefenderScanError,
  comparePlatformVersions,
  directDirectory,
  insideWindowsPath,
  isolatedDefenderEnvironment,
  resolveMicrosoftDefenderScanner,
  runMicrosoftDefenderScan,
  trustedScannerSignature
};
