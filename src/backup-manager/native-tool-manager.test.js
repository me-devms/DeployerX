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
