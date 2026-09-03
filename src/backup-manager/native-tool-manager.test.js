const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { NativeToolManager, NativeToolManagerError, downloadArchive } = require('./native-tool-manager');

test('installs verified database tools privately and activates their bin directory', async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tools-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  const archive = Buffer.from('verified-client-archive');
  const environment = { PATH: 'C:\\Windows\\System32' };
  const catalog = {
    mysql: {
      label: 'MySQL',
      packageLabel: 'MySQL client tools',
      version: '8.4.6',
      platforms: {
        'win32-x64': {
          archiveName: 'mysql.zip',
          url: 'https://downloads.example.test/mysql.zip',
          sha256: crypto.createHash('sha256').update(archive).digest('hex'),
          downloadBytes: archive.length,
          binDirectory: 'mysql/bin',
          executables: ['mysql.exe', 'mysqldump.exe', 'mysqlbinlog.exe']
        }
      }
    }
  };
  const manager = new NativeToolManager({
    rootDirectory,
    platform: 'win32',
    arch: 'x64',
    environment,
    catalog,
    downloadImpl: async (_url, destination, expectedSha256) => {
      assert.equal(expectedSha256, catalog.mysql.platforms['win32-x64'].sha256);
      await fs.writeFile(destination, archive);
    },
    extractImpl: async (_archivePath, destination) => {
      const bin = path.join(destination, 'mysql', 'bin');
      await fs.mkdir(bin, { recursive: true });
      await Promise.all(catalog.mysql.platforms['win32-x64'].executables.map((name) => fs.writeFile(path.join(bin, name), name)));
    }
  });

  assert.equal((await manager.status('mysql')).installed, false);
  const installed = await manager.install('mysql');
  assert.equal(installed.installed, true);
  assert.match(environment.PATH, /native-tools.*mysql.*8\.4\.6.*mysql.*bin/i);
  assert.equal(environment.Path, environment.PATH);
});

test('coalesces concurrent installation requests', async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tools-lock-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  let downloads = 0;
  const catalog = {
    mysql: {
      label: 'MySQL', packageLabel: 'MySQL tools', version: '1',
      platforms: { 'win32-x64': { archiveName: 'a.zip', url: 'https://example.test/a.zip', sha256: 'a', downloadBytes: 1, binDirectory: 'bin', executables: ['mysql.exe'] } }
    }
  };
  const manager = new NativeToolManager({
    rootDirectory, platform: 'win32', arch: 'x64', environment: {}, catalog,
    downloadImpl: async (_url, destination) => { downloads += 1; await fs.writeFile(destination, 'a'); },
    extractImpl: async (_archive, destination) => { await fs.mkdir(path.join(destination, 'bin')); await fs.writeFile(path.join(destination, 'bin', 'mysql.exe'), 'x'); }
  });
  const [first, second] = await Promise.all([manager.install('mysql'), manager.install('mysql')]);
  assert.equal(downloads, 1);
  assert.equal(first.installed, true);
  assert.equal(second.installed, true);
});

test('exposes official installer metadata for vendor-managed database tools', async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tools-manual-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  const manager = new NativeToolManager({ rootDirectory, platform: 'linux', arch: 'x64' });
  for (const [engine, expectedUrl] of [
    ['postgresql', 'https://www.postgresql.org/download/windows/'],
    ['mariadb', 'https://mariadb.com/downloads/community/community-server/'],
    ['sqlserver', 'https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-download-install'],
    ['mongodb', 'https://www.mongodb.com/try/download/database-tools']
  ]) {
    const status = await manager.status(engine);
    assert.equal(status.supported, false);
    assert.equal(status.manual, true);
    assert.equal(status.manualUrl, expectedUrl);
  }
});

test('advertises the verified PostgreSQL Windows package for automatic setup', async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tools-postgresql-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  const manager = new NativeToolManager({ rootDirectory, platform: 'win32', arch: 'x64' });
  const status = await manager.status('postgresql');
  assert.equal(status.supported, true);
  assert.equal(status.installed, false);
  assert.equal(status.version, '18.3');
  assert.equal(status.downloadBytes, 337835847);
});

test('rejects a downloaded archive that fails its pinned checksum', async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tools-checksum-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  const destination = path.join(rootDirectory, 'client.zip');
  await assert.rejects(
    downloadArchive('https://example.test/client.zip', destination, '0'.repeat(64), {
      fetchImpl: async () => new Response(Buffer.from('tampered'), { status: 200, headers: { 'content-length': '8' } })
    }),
    (error) => error instanceof NativeToolManagerError && error.code === 'NATIVE_TOOL_CHECKSUM_FAILED'
  );
});

test('reports byte progress while downloading an archive', async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tools-progress-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  const archive = Buffer.from('progress-client-archive');
  const progress = [];
  await downloadArchive('https://example.test/client.zip', path.join(rootDirectory, 'client.zip'), crypto.createHash('sha256').update(archive).digest('hex'), {
    fetchImpl: async () => new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } }),
    onProgress: (update) => progress.push(update)
  });
  assert.equal(progress[0].receivedBytes, 0);
  assert.equal(progress.at(-1).receivedBytes, archive.length);
  assert.equal(progress.at(-1).totalBytes, archive.length);
  assert.equal(progress.at(-1).percent, 100);
});

test('turns network failures into a retryable setup message', async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-tools-network-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  await assert.rejects(
    downloadArchive('https://example.test/client.zip', path.join(rootDirectory, 'client.zip'), '0'.repeat(64), { fetchImpl: async () => { throw new Error('offline'); } }),
    (error) => error instanceof NativeToolManagerError
      && error.code === 'NATIVE_TOOL_DOWNLOAD_FAILED'
      && error.message.includes('Check your internet connection')
  );
});
