const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TabularisLauncher, sha256 } = require('./tabularis-launcher');

function response(payload) {
  return {
    ok: true,
    headers: { get: (name) => name === 'content-length' ? String(payload.length) : null },
    arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
  };
}

test('downloads, verifies, caches, and launches the reviewed Tabularis portable release', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-tabularis-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const payload = Buffer.from('official-tabularis-fixture');
  const release = { version: '1.2.3', filename: 'tabularis.exe', url: 'https://github.com/TabularisDB/tabularis/releases/download/v1.2.3/tabularis.exe', size: payload.length, sha256: sha256(payload) };
  const launches = [];
  let downloads = 0;
  const launcher = new TabularisLauncher({
    rootPath,
    release,
    fetchImpl: async () => { downloads += 1; return response(payload); },
    spawnImpl: (executablePath, args, options) => {
      launches.push({ executablePath, args, options, unref: false });
      const child = new EventEmitter();
      child.unref = () => { launches.at(-1).unref = true; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });

  assert.deepEqual(await launcher.launch(), { status: 'launched', version: '1.2.3', downloaded: true });
  assert.equal(downloads, 1);
  assert.equal(launches[0].executablePath, path.join(rootPath, 'v1.2.3', 'tabularis.exe'));
  assert.deepEqual(launches[0].args, []);
  assert.equal(launches[0].options.detached, true);
  assert.equal(launches[0].unref, true);

  assert.deepEqual(await launcher.launch(), { status: 'launched', version: '1.2.3', downloaded: false });
  assert.equal(downloads, 1, 'a verified cached release must not be downloaded again');
});

test('rejects a Tabularis payload that does not match the pinned release', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-tabularis-integrity-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const expected = Buffer.from('reviewed');
  const received = Buffer.from('modified');
  const launcher = new TabularisLauncher({
    rootPath,
    release: { version: '1.0.0', filename: 'tabularis.exe', url: 'https://github.com/TabularisDB/tabularis/releases/download/v1.0.0/tabularis.exe', size: received.length, sha256: sha256(expected) },
    fetchImpl: async () => response(received),
    spawnImpl: () => { throw new Error('must not launch'); }
  });

  await assert.rejects(launcher.launch(), (error) => error.code === 'TABULARIS_INTEGRITY_FAILED');
  await assert.rejects(fs.stat(launcher.executablePath()), (error) => error.code === 'ENOENT');
});

test('rejects unsupported Tabularis launcher targets before downloading', async () => {
  let downloaded = false;
  const launcher = new TabularisLauncher({
    rootPath: 'unused',
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => { downloaded = true; },
    spawnImpl: () => {}
  });
  await assert.rejects(launcher.launch(), (error) => error.code === 'TABULARIS_PLATFORM_UNSUPPORTED');
  assert.equal(downloaded, false);
});

test('routes Database Manager navigation to Tabularis instead of the custom view', async () => {
  const rootPath = path.join(__dirname, '..');
  const [mainSource, preloadSource, rendererSource] = await Promise.all([
    fs.readFile(path.join(rootPath, 'main.js'), 'utf8'),
    fs.readFile(path.join(rootPath, 'preload.js'), 'utf8'),
    fs.readFile(path.join(rootPath, 'renderer', 'renderer.js'), 'utf8')
  ]);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:tabularis:launch', wrapDatabaseManagerIpc/);
  assert.match(preloadSource, /launchTabularis: \(\) => invokeDatabaseManager\('database-manager:tabularis:launch'\)/);
  assert.match(rendererSource, /topDatabasesButton\.addEventListener\('click', async \(\) => \{[\s\S]*window\.deployerx\.launchTabularis\(\)/);
  assert.doesNotMatch(rendererSource, /topDatabasesButton\.addEventListener\('click', \(\) => showView\('database'\)\)/);
});
