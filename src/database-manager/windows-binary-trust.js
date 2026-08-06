const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MAX_PE_HEADER_OFFSET = 16 * 1024 * 1024;
const MAX_IMPORT_DIRECTORY_BYTES = 1024 * 1024;
const MAX_IMPORTS = 512;
const MAX_DLL_NAME_BYTES = 128;
const MAX_CERTIFICATE_BYTES = 1024 * 1024;
const POWERSHELL_TIMEOUT_MS = 15000;
const API_SET_PATTERN = /^(?:api|ext)-ms-win-[a-z0-9._-]+\.dll$/;
const MODULE_NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,126}\.(?:dll|drv|cpl)$/;
const BUNDLED_WINDOWS_IMPORTS = new Set(['ffmpeg.dll']);
const REVIEWED_WINDOWS_IMPORTS = new Set([
  'advapi32.dll',
  'bcrypt.dll',
  'bthprops.cpl',
  'cfgmgr32.dll',
  'comctl32.dll',
  'comdlg32.dll',
  'crypt32.dll',
  'cryptbase.dll',
  'd3d11.dll',
  'd3d12.dll',
  'dbghelp.dll',
  'dcomp.dll',
  'dhcpcsvc.dll',
  'dnsapi.dll',
  'dwmapi.dll',
  'dwrite.dll',
  'dxgi.dll',
  'ffmpeg.dll',
  'gdi32.dll',
  'hid.dll',
  'imm32.dll',
  'iphlpapi.dll',
  'kernel32.dll',
  'ktmw32.dll',
  'mf.dll',
  'mfplat.dll',
  'mfreadwrite.dll',
  'msimg32.dll',
  'msvcrt.dll',
  'ncrypt.dll',
  'netapi32.dll',
  'ntdll.dll',
  'odbc32.dll',
  'ole32.dll',
  'oleacc.dll',
  'oleaut32.dll',
  'pdh.dll',
  'powrprof.dll',
  'propsys.dll',
  'psapi.dll',
  'rpcrt4.dll',
  'secur32.dll',
  'setupapi.dll',
  'shell32.dll',
  'shlwapi.dll',
  'user32.dll',
  'userenv.dll',
  'usp10.dll',
  'uxtheme.dll',
  'uiautomationcore.dll',
  'urlmon.dll',
  'version.dll',
  'wevtapi.dll',
  'winhttp.dll',
  'wininet.dll',
  'winmm.dll',
  'winspool.drv',
  'wintrust.dll',
  'winusb.dll',
  'wlanapi.dll',
  'ws2_32.dll',
  'wtsapi32.dll'
]);
const POWERSHELL_SIGNATURE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$signature=Get-AuthenticodeSignature -LiteralPath $env:DEPLOYERX_AUTHENTICODE_FILE',
  "$signer=if($null -ne $signature.SignerCertificate){[Convert]::ToBase64String($signature.SignerCertificate.RawData)}else{''}",
  "$timestamp=if($null -ne $signature.TimeStamperCertificate){[Convert]::ToBase64String($signature.TimeStamperCertificate.RawData)}else{''}",
  "[pscustomobject]@{status=[string]$signature.Status;signerCertificate=$signer;timestampCertificate=$timestamp}|ConvertTo-Json -Compress"
].join(';');

class WindowsBinaryTrustError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WindowsBinaryTrustError';
    this.code = code;
  }
}

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

async function readExact(handle, offset, length, fileSize) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || offset + length > fileSize) {
    throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
  }
  const content = Buffer.alloc(length);
  const result = await handle.read(content, 0, length, offset);
  if (result.bytesRead !== length) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
  return content;
}

function rvaLocation(rva, sections, sizeOfHeaders, fileSize) {
  if (!Number.isInteger(rva) || rva < 0) return null;
  if (rva < sizeOfHeaders && rva < fileSize) return { offset: rva, available: Math.min(sizeOfHeaders - rva, fileSize - rva) };
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva >= section.virtualAddress + span) continue;
    const delta = rva - section.virtualAddress;
    if (delta >= section.rawSize || section.rawOffset + delta >= fileSize) return null;
    return { offset: section.rawOffset + delta, available: Math.min(section.rawSize - delta, fileSize - section.rawOffset - delta) };
  }
  return null;
}

async function readDllName(handle, rva, sections, sizeOfHeaders, fileSize) {
  const location = rvaLocation(rva, sections, sizeOfHeaders, fileSize);
  if (!location || location.available < 2) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
  const content = await readExact(handle, location.offset, Math.min(location.available, MAX_DLL_NAME_BYTES + 1), fileSize);
  const terminator = content.indexOf(0);
  if (terminator < 1 || terminator > MAX_DLL_NAME_BYTES) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
  const name = content.toString('ascii', 0, terminator).toLowerCase();
  if (!MODULE_NAME_PATTERN.test(name)) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_NAME_INVALID');
  return name;
}

async function readImportDirectory(handle, directory, descriptorBytes, nameOffset, rvaResolver, context) {
  if (directory.rva === 0 && directory.size === 0) return [];
  if (!directory.rva || directory.size < descriptorBytes || directory.size > MAX_IMPORT_DIRECTORY_BYTES) {
    throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
  }
  const location = rvaLocation(directory.rva, context.sections, context.sizeOfHeaders, context.fileSize);
  if (!location || directory.size > location.available) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
  const descriptorCount = Math.min(Math.floor(directory.size / descriptorBytes), MAX_IMPORTS + 1);
  const names = [];
  let terminated = false;
  for (let index = 0; index < descriptorCount; index += 1) {
    const descriptor = await readExact(handle, location.offset + (index * descriptorBytes), descriptorBytes, context.fileSize);
    if (descriptor.every((byte) => byte === 0)) {
      terminated = true;
      break;
    }
    const rawName = descriptor.readUInt32LE(nameOffset);
    const nameRva = rvaResolver(rawName, descriptor);
    names.push(await readDllName(handle, nameRva, context.sections, context.sizeOfHeaders, context.fileSize));
    if (names.length > MAX_IMPORTS) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_EXCESSIVE');
  }
  if (!terminated) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
  return names;
}

async function inspectPeImports(filePath, { fileSystem = fs } = {}) {
  const handle = await fileSystem.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 128) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
    const dos = await readExact(handle, 0, 64, stat.size);
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > MAX_PE_HEADER_OFFSET) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
    const coff = await readExact(handle, peOffset, 24, stat.size);
    if (coff.toString('ascii', 0, 4) !== 'PE\0\0') throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    if (sectionCount < 1 || sectionCount > 96 || optionalSize < 112 || optionalSize > 4096) {
      throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
    }
    const optional = await readExact(handle, peOffset + 24, optionalSize, stat.size);
    if (optional.readUInt16LE(0) !== 0x20b) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
    const sizeOfHeaders = optional.readUInt32LE(60);
    const directoryCount = optional.readUInt32LE(108);
    const imageBase = optional.readBigUInt64LE(24);
    const sectionTableOffset = peOffset + 24 + optionalSize;
    const sectionTable = await readExact(handle, sectionTableOffset, sectionCount * 40, stat.size);
    const sections = [];
    for (let index = 0; index < sectionCount; index += 1) {
      const offset = index * 40;
      const section = {
        virtualSize: sectionTable.readUInt32LE(offset + 8),
        virtualAddress: sectionTable.readUInt32LE(offset + 12),
        rawSize: sectionTable.readUInt32LE(offset + 16),
        rawOffset: sectionTable.readUInt32LE(offset + 20)
      };
      if (section.rawSize && section.rawOffset + section.rawSize > stat.size) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
      sections.push(section);
    }
    const directory = (index) => {
      const offset = 112 + (index * 8);
      if (directoryCount <= index || offset + 8 > optional.length) return { rva: 0, size: 0 };
      return { rva: optional.readUInt32LE(offset), size: optional.readUInt32LE(offset + 4) };
    };
    const context = { sections, sizeOfHeaders, fileSize: stat.size };
    const imports = await readImportDirectory(handle, directory(1), 20, 12, (value) => value, context);
    const delayed = await readImportDirectory(handle, directory(13), 32, 4, (value, descriptor) => {
      if ((descriptor.readUInt32LE(0) & 1) !== 0) return value;
      const address = BigInt(value) - imageBase;
      if (address < 0 || address > 0xffffffffn) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
      return Number(address);
    }, context);
    const result = [...new Set([...imports, ...delayed])].sort();
    if (result.length < 1 || result.length > MAX_IMPORTS) throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID');
    return Object.freeze(result);
  } finally {
    await handle.close();
  }
}

function reviewedWindowsDependencies(imports) {
  return Array.isArray(imports) && imports.length > 0 && imports.length <= MAX_IMPORTS
    && imports.every((name, index) => typeof name === 'string'
      && name === name.toLowerCase()
      && MODULE_NAME_PATTERN.test(name)
      && (REVIEWED_WINDOWS_IMPORTS.has(name) || API_SET_PATTERN.test(name))
      && imports.indexOf(name) === index)
    && imports.every((name, index) => index === 0 || imports[index - 1].localeCompare(name) < 0);
}

function bundledWindowsDependencies(imports) {
  if (!reviewedWindowsDependencies(imports)) return null;
  return Object.freeze(imports.filter((name) => BUNDLED_WINDOWS_IMPORTS.has(name)));
}

function decodeCertificate(value) {
  const source = String(value || '');
  if (!source || source.length > Math.ceil(MAX_CERTIFICATE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) return null;
  const bytes = Buffer.from(source, 'base64');
  return bytes.length > 0 && bytes.length <= MAX_CERTIFICATE_BYTES ? bytes : null;
}

async function verifyAuthenticode(filePath, {
  execute = execFileAsync,
  environment = process.env,
  powershellPath = null
} = {}) {
  const windowsRoot = String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows');
  const executable = powershellPath || path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const childEnvironment = {
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    ComSpec: path.join(windowsRoot, 'System32', 'cmd.exe'),
    PATH: path.join(windowsRoot, 'System32'),
    DEPLOYERX_AUTHENTICODE_FILE: filePath
  };
  let stdout;
  try {
    ({ stdout } = await execute(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', POWERSHELL_SIGNATURE_SCRIPT
    ], {
      env: childEnvironment,
      windowsHide: true,
      timeout: POWERSHELL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    }));
  } catch {
    throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_SIGNATURE_CHECK_FAILED');
  }
  let response;
  try { response = JSON.parse(String(stdout || '').trim()); }
  catch { throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_SIGNATURE_RESPONSE_INVALID'); }
  if (!exactObject(response, ['status', 'signerCertificate', 'timestampCertificate'])) {
    throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_SIGNATURE_RESPONSE_INVALID');
  }
  const signer = decodeCertificate(response.signerCertificate);
  const timestamp = decodeCertificate(response.timestampCertificate);
  if (response.status !== 'Valid' || !signer || !timestamp) {
    throw new WindowsBinaryTrustError('WINDOWS_ARTIFACT_SIGNATURE_INVALID');
  }
  return Object.freeze({
    status: 'valid',
    signerCertificateSha256: crypto.createHash('sha256').update(signer).digest('hex'),
    timestampPresent: true
  });
}

function signatureMatches(signature, expectedFingerprint) {
  return exactObject(signature, ['status', 'signerCertificateSha256', 'timestampPresent'])
    && signature.status === 'valid'
    && signature.timestampPresent === true
    && String(signature.signerCertificateSha256 || '').toLowerCase() === expectedFingerprint;
}

module.exports = {
  BUNDLED_WINDOWS_IMPORTS,
  REVIEWED_WINDOWS_IMPORTS,
  WindowsBinaryTrustError,
  bundledWindowsDependencies,
  inspectPeImports,
  reviewedWindowsDependencies,
  signatureMatches,
  verifyAuthenticode
};
