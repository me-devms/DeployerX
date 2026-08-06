const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  bundledWindowsDependencies,
  inspectPeImports,
  reviewedWindowsDependencies,
  signatureMatches,
  verifyAuthenticode
} = require('./windows-binary-trust');

function importFixture(name = 'KERNEL32.dll') {
  const content = Buffer.alloc(1024);
  const peOffset = 0x80;
  const optionalOffset = peOffset + 24;
  const sectionOffset = optionalOffset + 240;
  content.write('MZ', 0, 'ascii');
  content.writeUInt32LE(peOffset, 0x3c);
  content.write('PE\0\0', peOffset, 'ascii');
  content.writeUInt16LE(0x8664, peOffset + 4);
  content.writeUInt16LE(1, peOffset + 6);
  content.writeUInt16LE(240, peOffset + 20);
  content.writeUInt16LE(0x0002, peOffset + 22);
  content.writeUInt16LE(0x20b, optionalOffset);
  content.writeBigUInt64LE(0x140000000n, optionalOffset + 24);
  content.writeUInt32LE(0x200, optionalOffset + 60);
  content.writeUInt32LE(16, optionalOffset + 108);
  content.writeUInt32LE(0x1000, optionalOffset + 120);
  content.writeUInt32LE(40, optionalOffset + 124);
  content.write('.rdata', sectionOffset, 'ascii');
  content.writeUInt32LE(0x200, sectionOffset + 8);
  content.writeUInt32LE(0x1000, sectionOffset + 12);
  content.writeUInt32LE(0x200, sectionOffset + 16);
  content.writeUInt32LE(0x200, sectionOffset + 20);
  content.writeUInt32LE(0x1050, 0x200 + 12);
  content.write(name, 0x250, 'ascii');
  content[0x250 + Buffer.byteLength(name)] = 0;
  return content;
}

async function temporaryPe(context, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-pe-import-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'fixture.exe');
  await fs.writeFile(filePath, content);
  return filePath;
}

test('parses a bounded PE32+ import table and applies the reviewed dependency baseline', async (context) => {
  const filePath = await temporaryPe(context, importFixture());
  const imports = await inspectPeImports(filePath);
  assert.deepEqual(imports, ['kernel32.dll']);
  assert.equal(reviewedWindowsDependencies(imports), true);
  assert.deepEqual(bundledWindowsDependencies(['ffmpeg.dll', 'kernel32.dll']), ['ffmpeg.dll']);
  assert.equal(reviewedWindowsDependencies(['kernel32.dll', 'unreviewed.dll']), false);
  assert.equal(bundledWindowsDependencies(['unreviewed.dll']), null);
});

test('keeps the pinned Electron Windows import graph inside the reviewed baseline', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows PE acceptance runs only on the packaged target.');
    return;
  }
  const imports = await inspectPeImports(require('electron'));
  assert.equal(reviewedWindowsDependencies(imports), true);
  assert.ok(imports.includes('ffmpeg.dll'));
  assert.ok(imports.some((name) => name.startsWith('api-ms-win-')));
});

test('rejects path-bearing and unterminated dependency names', async (context) => {
  const pathBearing = await temporaryPe(context, importFixture('..\\evil.dll'));
  await assert.rejects(inspectPeImports(pathBearing), /WINDOWS_ARTIFACT_DEPENDENCY_NAME_INVALID/);
  const unterminated = importFixture('a'.repeat(129));
  const unterminatedPath = await temporaryPe(context, unterminated);
  await assert.rejects(inspectPeImports(unterminatedPath), /WINDOWS_ARTIFACT_DEPENDENCY_TABLE_INVALID/);
});

test('verifies timestamped Authenticode with a fixed script and minimal child environment', async () => {
  const signer = Buffer.from('signer certificate fixture');
  const timestamp = Buffer.from('timestamp certificate fixture');
  let invocation = null;
  const signature = await verifyAuthenticode('C:\\private\\DeployerX.exe', {
    environment: { SystemRoot: 'C:\\Windows', AWS_SECRET_ACCESS_KEY: 'must-not-pass' },
    execute: async (executable, args, options) => {
      invocation = { executable, args, options };
      return { stdout: JSON.stringify({ status: 'Valid', signerCertificate: signer.toString('base64'), timestampCertificate: timestamp.toString('base64') }) };
    }
  });
  const expectedFingerprint = crypto.createHash('sha256').update(signer).digest('hex');
  assert.equal(signatureMatches(signature, expectedFingerprint), true);
  assert.equal(invocation.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(invocation.args.join(' ').includes('C:\\private'), false);
  assert.deepEqual(Object.keys(invocation.options.env).sort(), ['ComSpec', 'DEPLOYERX_AUTHENTICODE_FILE', 'PATH', 'SystemRoot', 'WINDIR'].sort());
  assert.equal(invocation.options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, 15000);
});

test('rejects unsigned, untimestamped, malformed, and wrong-signer evidence', async () => {
  const signer = Buffer.from('signer certificate fixture').toString('base64');
  await assert.rejects(verifyAuthenticode('C:\\artifact.exe', {
    execute: async () => ({ stdout: JSON.stringify({ status: 'NotSigned', signerCertificate: '', timestampCertificate: '' }) })
  }), /WINDOWS_ARTIFACT_SIGNATURE_INVALID/);
  await assert.rejects(verifyAuthenticode('C:\\artifact.exe', {
    execute: async () => ({ stdout: JSON.stringify({ status: 'Valid', signerCertificate: signer, timestampCertificate: '' }) })
  }), /WINDOWS_ARTIFACT_SIGNATURE_INVALID/);
  await assert.rejects(verifyAuthenticode('C:\\artifact.exe', { execute: async () => ({ stdout: '{' }) }), /WINDOWS_ARTIFACT_SIGNATURE_RESPONSE_INVALID/);
  assert.equal(signatureMatches({ status: 'valid', signerCertificateSha256: 'a'.repeat(64), timestampPresent: true }, 'b'.repeat(64)), false);
});
