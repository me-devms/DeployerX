const { app } = require('electron');
const { FileRepositoryEngine, MIN_CHUNK_SIZE_BYTES } = require('./repository-engine');

class MemoryAdapter {
  constructor() {
    this.objects = new Map();
  }

  async stat(_context, key) {
    return this.objects.has(key) ? { key, sizeBytes: this.objects.get(key).length } : null;
  }

  async read(_context, request) {
    if (!this.objects.has(request.key)) throw new Error('missing');
    return Buffer.from(this.objects.get(request.key));
  }

  async write(_context, request) {
    return request;
  }

  async commit(_context, session) {
    this.objects.set(session.key, Buffer.from(session.body));
    return { key: session.key, sizeBytes: session.body.length, checksum: session.checksum };
  }

  async abort() {}
}

app.whenReady().then(async () => {
  try {
    const adapter = new MemoryAdapter();
    const engine = new FileRepositoryEngine({ adapter });
    const masterKey = Buffer.alloc(32, 0x5a);
    const plaintext = Buffer.from('electron repository engine encrypted payload');
    const sourcePath = '/srv/private/electron.txt';
    const snapshot = await engine.createSnapshot({}, {
      repositoryId: 'repo-electron', keyVersion: 'key-v1', masterKey,
      idempotencyKey: 'electron-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
      files: [{ path: sourcePath, type: 'file', metadata: { permissions: { mode: 0o600 } }, content: plaintext }]
    });
    const reopenedEngine = new FileRepositoryEngine({ adapter });
    const opened = await reopenedEngine.openSnapshot({}, { repositoryId: 'repo-electron', snapshotId: snapshot.snapshotId, masterKey });
    const restored = await reopenedEngine.readFile({}, { repositoryId: 'repo-electron', manifest: opened.manifest, path: sourcePath, masterKey });
    const persisted = Buffer.concat([...adapter.objects.values()]);
    const ok = restored.equals(plaintext)
      && snapshot.uploadedChunkCount === 1
      && !persisted.includes(plaintext)
      && !persisted.includes(Buffer.from(sourcePath));
    process.stdout.write(`${JSON.stringify({ ok, snapshotId: snapshot.snapshotId, objects: adapter.objects.size, encrypted: !persisted.includes(plaintext), restored: restored.equals(plaintext) })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
