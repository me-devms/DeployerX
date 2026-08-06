const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { FileSourceReaderService, globRegex, selectionFilter } = require('./file-source-reader');

async function fixture(context) {
  const rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'deployerx-file-reader-test-'));
  const sourcePath = path.join(rootPath, 'source');
  await fsPromises.mkdir(path.join(sourcePath, 'nested'), { recursive: true });
  await fsPromises.mkdir(path.join(sourcePath, '.hidden'));
  await fsPromises.writeFile(path.join(sourcePath, 'keep.txt'), 'alpha');
  await fsPromises.writeFile(path.join(sourcePath, 'skip.log'), 'skip');
  await fsPromises.writeFile(path.join(sourcePath, 'nested', 'data.txt'), 'beta');
  await fsPromises.writeFile(path.join(sourcePath, '.hidden', 'secret.txt'), 'hidden');
  const database = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
  await database.initialize();
  context.after(async () => { await database.close(); await fsPromises.rm(rootPath, { recursive: true, force: true }); });
  const connection = await database.repository('connection').create({ workspaceId: 'local', name: 'Local', kind: 'local', adapterId: 'deployerx.connection.local', adapterVersion: '1.0.0', endpoint: { platform: process.platform === 'win32' ? 'windows' : 'linux' }, workerAffinity: ['device:test-device'], lastTest: { status: 'success' } });
  const source = await database.repository('source').create({
    workspaceId: 'local', name: 'Files', connectionId: connection.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true,
    selector: { kind: 'file-paths', roots: [{ path: sourcePath, type: 'directory' }], includePatterns: ['**/*.txt'], excludePatterns: ['nested/ignored/**'], options: { includeHidden: false, crossMounts: false }, metadataPolicy: { preserve: { permissions: true, ownership: true, timestamps: true, symbolicLinks: true, hardLinks: true } }, digest: 'selector-digest' },
    platform: { os: process.platform === 'win32' ? 'windows' : 'linux', metadataCapabilities: { permissions: true, ownership: true, timestamps: true, symbolicLinks: true, hardLinks: true } }
  });
  return { database, source, sourcePath, service: new FileSourceReaderService({ controlDatabase: database, secretStore: { resolve: async () => { throw new Error('not used'); } }, deviceId: 'test-device' }) };
}

test('matches the supported bounded glob subset', () => {
  assert.equal(globRegex('**/*.txt').test('one/two.txt'), true);
  assert.equal(globRegex('**/*.txt').test('root.txt'), true);
  assert.equal(globRegex('logs/[ab]?.log').test('logs/a1.log'), true);
  assert.equal(selectionFilter({ includePatterns: ['**/*.txt'], excludePatterns: ['tmp/**'] }).include('a.txt', 'file'), true);
  assert.equal(selectionFilter({ excludePatterns: ['tmp/**'] }).exclude('tmp', 'directory'), true);
});

test('streams selected local files with canonical paths, metadata, filters, and progress', async (context) => {
  const { service, source, sourcePath } = await fixture(context);
  const progress = [];
  const plan = await service.files('local', source.id, { onProgress: async (event) => progress.push(event) });
  const entries = [];
  for await (const entry of plan.create()) {
    const body = [];
    if (entry.content) for await (const part of entry.content) body.push(part);
    entries.push({ path: entry.path, type: entry.type, metadata: entry.metadata, body: Buffer.concat(body).toString() });
  }
  assert.equal(plan.manifest.selectionDigest, 'selector-digest');
  assert.deepEqual(entries.filter((entry) => entry.type === 'file').map((entry) => path.posix.basename(entry.path)), ['keep.txt', 'data.txt']);
  assert.deepEqual(entries.filter((entry) => entry.type === 'file').map((entry) => entry.body), ['alpha', 'beta']);
  assert.equal(entries.some((entry) => entry.path.includes('.hidden')), false);
  assert.equal(entries[0].path, sourcePath.replace(/\\/g, '/'));
  assert.equal(entries.every((entry) => entry.metadata?.digest), true);
  assert.equal(progress.reduce((total, event) => total + (event.bytesRead || 0), 0), 9);
});

test('paces every local payload chunk through the supplied run limiter', async (context) => {
  const { service, source } = await fixture(context);
  const consumed = [];
  const progress = [];
  const plan = await service.files('local', source.id, {
    bandwidthLimiter: { consume: async (bytes) => { consumed.push(bytes); return { limitBytesPerSecond: 65536, waitedMilliseconds: 25 }; } },
    onProgress: async (event) => progress.push(event)
  });
  for await (const entry of plan.create()) if (entry.content) for await (const _part of entry.content) { /* consume */ }
  assert.equal(consumed.reduce((total, bytes) => total + bytes, 0), 9);
  assert.equal(progress.filter((event) => event.bytesRead).every((event) => event.bandwidthLimitBytesPerSecond === 65536), true);
  assert.equal(progress.filter((event) => event.bytesRead).reduce((total, event) => total + event.throttleWaitMilliseconds, 0), consumed.length * 25);
});

test('rejects other-device and unhealthy source connections', async (context) => {
  const { database, service, source } = await fixture(context);
  const connection = await database.repository('connection').get('local', source.connectionId);
  await database.repository('connection').update('local', connection.id, { workerAffinity: ['device:other'] }, { expectedRevision: connection.revision });
  await assert.rejects(service.plan('local', source.id), /another device/);
});

test('streams an SSH file source through a bounded SFTP session', async (context) => {
  const rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'deployerx-ssh-file-reader-test-'));
  const database = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
  await database.initialize();
  context.after(async () => { await database.close(); await fsPromises.rm(rootPath, { recursive: true, force: true }); });
  const connection = await database.repository('connection').create({
    workspaceId: 'local', name: 'Linux server', kind: 'ssh', adapterId: 'deployerx.connection.ssh', adapterVersion: '1.0.0',
    endpoint: { host: 'server.example.com', port: 22, username: 'backup' }, secretRefIds: [],
    trust: { fingerprint: 'SHA256:test', algorithm: 'ssh-ed25519' }, workerAffinity: ['device:test-device'], lastTest: { status: 'success' }
  });
  const source = await database.repository('source').create({
    workspaceId: 'local', name: 'Server files', connectionId: connection.id, sourceType: 'files', adapterId: 'deployerx.files.ssh', enabled: true,
    selector: { kind: 'file-paths', roots: [{ path: '/srv/app', type: 'directory' }], includePatterns: ['**/*.txt'], excludePatterns: [], options: { includeHidden: false, crossMounts: false }, metadataPolicy: { preserve: {} }, digest: 'ssh-selector-digest' },
    platform: { os: 'linux', metadataCapabilities: {} }
  });
  const body = Buffer.from('remote payload');
  const directory = { mode: 0o040755, size: 0, mtime: 100, atime: 100 };
  const file = { mode: 0o100640, size: body.length, mtime: 200, atime: 200 };
  let closed = false;
  const session = {
    sftp: {},
    lstat: async (remotePath) => remotePath === '/srv/app' ? directory : remotePath === '/srv/app/config.txt' ? file : null,
    readdir: async () => [
      { filename: 'config.txt', longname: '-rw-r-----', attrs: file },
      { filename: '.ignored.txt', longname: '-rw-r-----', attrs: file }
    ],
    open: async (remotePath) => remotePath,
    read: async (_handle, buffer, offset, length, position) => {
      const part = body.subarray(position, position + length);
      part.copy(buffer, offset);
      return part.length;
    },
    closeHandle: async () => {},
    close: () => { closed = true; }
  };
  const service = new FileSourceReaderService({
    controlDatabase: database,
    secretStore: { resolve: async () => '' },
    deviceId: 'test-device',
    openRemoteSession: async () => session
  });
  const progress = [];
  const consumed = [];
  const planned = await service.files('local', source.id, {
    bandwidthLimiter: { consume: async (bytes) => { consumed.push(bytes); return { limitBytesPerSecond: 131072, waitedMilliseconds: 10 }; } },
    onProgress: async (event) => progress.push(event)
  });
  const entries = [];
  for await (const entry of planned.create()) {
    const parts = [];
    if (entry.content) for await (const part of entry.content) parts.push(part);
    entries.push({ path: entry.path, type: entry.type, body: Buffer.concat(parts).toString('utf8') });
  }
  assert.deepEqual(entries.map((entry) => entry.path), ['/srv/app', '/srv/app/config.txt']);
  assert.equal(entries[1].body, 'remote payload');
  assert.equal(progress.reduce((total, event) => total + Number(event.bytesRead || 0), 0), body.length);
  assert.deepEqual(consumed, [body.length]);
  assert.equal(progress.find((event) => event.bytesRead)?.bandwidthLimitBytesPerSecond, 131072);
  assert.equal(closed, true);
});
