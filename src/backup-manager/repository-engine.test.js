const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ENGINE_ID,
  FileRepositoryEngine,
  FORMAT_OBJECT_KEY,
  MIN_CHUNK_SIZE_BYTES,
  REPOSITORY_FORMAT_VERSION,
  RepositoryEngineError
} = require('./repository-engine');

class MemoryRepositoryAdapter {
  constructor() {
    this.objects = new Map();
    this.sessions = new Map();
    this.writes = [];
    this.aborts = [];
    this.failCommit = null;
    this.nextSession = 1;
  }

  async stat(_context, key) {
    const body = this.objects.get(key);
    return body ? { key, sizeBytes: body.length } : null;
  }

  async read(_context, request) {
    const body = this.objects.get(request.key);
    if (!body) throw new Error('missing');
    return Buffer.from(body);
  }

  async write(_context, request) {
    const session = { id: `write-${this.nextSession++}`, ...request };
    this.sessions.set(session.id, session);
    return session;
  }

  async commit(_context, session) {
    if (this.failCommit?.(session.key)) throw new Error('injected commit failure');
    this.objects.set(session.key, Buffer.from(session.body));
    this.sessions.delete(session.id);
    this.writes.push(session.key);
    return { key: session.key, sizeBytes: session.body.length, checksum: session.checksum };
  }

  async abort(_context, session) {
    this.sessions.delete(session.id);
    this.aborts.push(session.key);
  }
}

const MASTER_KEY = Buffer.alloc(32, 0x41);
const ROTATED_KEY = Buffer.alloc(32, 0x42);
const CHUNK_A = Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x61);
const CHUNK_B = Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x62);

function snapshotFiles(content = Buffer.concat([CHUNK_A, CHUNK_B, CHUNK_A])) {
  return [
    { path: '/srv/app', type: 'directory', metadata: { permissions: { mode: 0o750 } } },
    { path: '/srv/app/current', type: 'symlink', metadata: { links: { symbolic: { target: 'releases/42' } } } },
    { path: '/srv/app/secret.txt', type: 'file', metadata: { permissions: { mode: 0o640 }, ownership: { uid: 1000, gid: 1000 } }, content }
  ];
}

function createEngine(adapter, clock = () => '2026-08-03T12:00:00.000Z') {
  let nonce = 0;
  return new FileRepositoryEngine({
    adapter,
    clock,
    randomBytes: (length) => Buffer.alloc(length, ++nonce)
  });
}

test('declares the versioned encrypted deduplicated repository format', () => {
  const engine = createEngine(new MemoryRepositoryAdapter());
  const manifest = engine.manifest();
  assert.equal(manifest.engineId, ENGINE_ID);
  assert.equal(manifest.repositoryFormatVersion, REPOSITORY_FORMAT_VERSION);
  assert.equal(manifest.encryption.algorithm, 'aes-256-gcm');
  assert.equal(manifest.contentIds.algorithm, 'hmac-sha256');
  assert.equal(manifest.deduplication.plaintextVisibleToAdapter, false);
});

test('encrypts manifests and chunks, deduplicates them, and restores exact content after restart', async () => {
  const adapter = new MemoryRepositoryAdapter();
  const firstEngine = createEngine(adapter);
  const first = await firstEngine.createSnapshot({}, {
    repositoryId: 'repo-a', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'run-1', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles()
  });
  assert.equal(first.chunkCount, 3);
  assert.equal(first.uniqueChunkCount, 2);
  assert.equal(first.uploadedChunkCount, 2);
  assert.equal(first.reusedBytes, MIN_CHUNK_SIZE_BYTES);
  assert.equal(first.files, 1);
  assert.equal(first.directories, 1);
  assert.equal(first.symbolicLinks, 1);
  assert.equal(adapter.objects.size, 4);

  const persistedBytes = Buffer.concat([...adapter.objects.values()]);
  assert.equal(persistedBytes.includes(Buffer.from('/srv/app/secret.txt')), false);
  assert.equal(persistedBytes.includes(Buffer.from('releases/42')), false);
  assert.equal(persistedBytes.includes(Buffer.from('aaaaaaaaaaaaaaaa')), false);

  const restartedEngine = createEngine(adapter);
  const opened = await restartedEngine.openSnapshot({}, {
    repositoryId: 'repo-a', snapshotId: first.snapshotId, masterKey: MASTER_KEY
  });
  assert.equal(opened.manifest.files.length, 3);
  assert.equal(opened.summary.files, 1);
  assert.equal(opened.summary.directories, 1);
  assert.equal(opened.summary.symbolicLinks, 1);
  assert.equal(opened.manifest.files.find((file) => file.type === 'symlink').metadata.links.symbolic.target, 'releases/42');
  const restored = await restartedEngine.readFile({}, {
    repositoryId: 'repo-a', manifest: opened.manifest, path: '/srv/app/secret.txt', masterKey: MASTER_KEY
  });
  assert.deepEqual(restored, Buffer.concat([CHUNK_A, CHUNK_B, CHUNK_A]));

  const second = await restartedEngine.createSnapshot({}, {
    repositoryId: 'repo-a', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'run-2', parentSnapshotId: first.snapshotId,
    chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles()
  });
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal(second.parentSnapshotId, first.snapshotId);
  assert.equal(second.uploadedChunkCount, 0);
  assert.equal(second.reusedBytes, CHUNK_A.length * 2 + CHUNK_B.length);
  assert.equal([...adapter.objects.keys()].filter((key) => key.startsWith('chunks/')).length, 2);
  assert.equal([...adapter.objects.keys()].filter((key) => key.startsWith('manifests/')).length, 2);
});

test('returns an authenticated existing manifest for an idempotent retry without consuming source files', async () => {
  const adapter = new MemoryRepositoryAdapter();
  const engine = createEngine(adapter);
  const input = {
    repositoryId: 'repo-retry', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'stable-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles(CHUNK_A)
  };
  const first = await engine.createSnapshot({}, input);
  const writesBeforeRetry = adapter.writes.length;
  const retry = await engine.createSnapshot({}, {
    ...input,
    files: { [Symbol.asyncIterator]: () => { throw new Error('retry consumed source'); } }
  });
  assert.equal(retry.snapshotId, first.snapshotId);
  assert.equal(retry.idempotent, true);
  assert.equal(adapter.writes.length, writesBeforeRetry);
});

test('chunks irregular asynchronous binary streams without changing restored bytes', async () => {
  const adapter = new MemoryRepositoryAdapter();
  const engine = createEngine(adapter);
  const expected = Buffer.concat([Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x11), Buffer.alloc(MIN_CHUNK_SIZE_BYTES, 0x22), Buffer.from('tail')]);
  async function* source() {
    for (let offset = 0; offset < expected.length; offset += 10003) yield expected.subarray(offset, offset + 10003);
  }
  const snapshot = await engine.createSnapshot({}, {
    repositoryId: 'repo-stream', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'stream-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
    files: [{ path: '/stream.bin', type: 'file', metadata: null, content: source() }]
  });
  const opened = await engine.openSnapshot({}, { repositoryId: 'repo-stream', snapshotId: snapshot.snapshotId, masterKey: MASTER_KEY });
  assert.deepEqual(opened.manifest.files[0].chunks.map((chunk) => chunk.sizeBytes), [MIN_CHUNK_SIZE_BYTES, MIN_CHUNK_SIZE_BYTES, 4]);
  assert.deepEqual(await engine.readFile({}, { repositoryId: 'repo-stream', manifest: opened.manifest, path: '/stream.bin', masterKey: MASTER_KEY }), expected);
});

test('normalizes source-stream failures without committing a manifest', async () => {
  const adapter = new MemoryRepositoryAdapter();
  const engine = createEngine(adapter);
  async function* source() {
    yield Buffer.from('partial');
    throw new Error('sensitive source failure');
  }
  await assert.rejects(engine.createSnapshot({}, {
    repositoryId: 'repo-source-failure', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'source-failure', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
    files: [{ path: '/failed.bin', type: 'file', metadata: null, content: source() }]
  }), (error) => error.code === 'REPOSITORY_SOURCE_READ_FAILED' && !error.message.includes('sensitive'));
  assert.equal([...adapter.objects.keys()].some((key) => key.startsWith('manifests/')), false);
});

test('scopes chunk identity to key material and keeps rotated snapshots independently readable', async () => {
  const adapter = new MemoryRepositoryAdapter();
  const engine = createEngine(adapter);
  const first = await engine.createSnapshot({}, {
    repositoryId: 'repo-rotation', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'rotation-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles(CHUNK_A)
  });
  const rotated = await engine.createSnapshot({}, {
    repositoryId: 'repo-rotation', keyVersion: 'key-v2', masterKey: ROTATED_KEY,
    idempotencyKey: 'rotation-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles(CHUNK_A)
  });
  assert.notEqual(rotated.snapshotId, first.snapshotId);
  assert.equal([...adapter.objects.keys()].filter((key) => key.startsWith('chunks/')).length, 2);
  await engine.openSnapshot({}, { repositoryId: 'repo-rotation', snapshotId: first.snapshotId, masterKey: MASTER_KEY });
  await engine.openSnapshot({}, { repositoryId: 'repo-rotation', snapshotId: rotated.snapshotId, masterKey: ROTATED_KEY });
});

test('binds the deduplication domain to the declared key version', async () => {
  const adapter = new MemoryRepositoryAdapter();
  const engine = createEngine(adapter);
  const first = await engine.createSnapshot({}, {
    repositoryId: 'repo-versioned-key', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'same-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles(CHUNK_A)
  });
  const second = await engine.createSnapshot({}, {
    repositoryId: 'repo-versioned-key', keyVersion: 'key-v2', masterKey: MASTER_KEY,
    idempotencyKey: 'same-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles(CHUNK_A)
  });
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.equal([...adapter.objects.keys()].filter((key) => key.startsWith('chunks/')).length, 2);
});

test('fails closed for wrong keys and modified chunk ciphertext', async () => {
  const adapter = new MemoryRepositoryAdapter();
  const engine = createEngine(adapter);
  const snapshot = await engine.createSnapshot({}, {
    repositoryId: 'repo-integrity', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'integrity-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles(CHUNK_A)
  });
  await assert.rejects(
    engine.openSnapshot({}, { repositoryId: 'repo-integrity', snapshotId: snapshot.snapshotId, masterKey: ROTATED_KEY }),
    (error) => error instanceof RepositoryEngineError && error.code === 'REPOSITORY_AUTHENTICATION_FAILED'
  );

  const opened = await engine.openSnapshot({}, { repositoryId: 'repo-integrity', snapshotId: snapshot.snapshotId, masterKey: MASTER_KEY });
  const chunkKey = opened.manifest.files.find((file) => file.type === 'file').chunks[0].key;
  const corrupt = Buffer.from(adapter.objects.get(chunkKey));
  corrupt[corrupt.length - 1] ^= 0xff;
  adapter.objects.set(chunkKey, corrupt);
  await assert.rejects(
    engine.readFile({}, { repositoryId: 'repo-integrity', manifest: opened.manifest, path: '/srv/app/secret.txt', masterKey: MASTER_KEY }),
    (error) => error instanceof RepositoryEngineError && error.code === 'REPOSITORY_AUTHENTICATION_FAILED'
  );
});

test('never commits a manifest when an adapter fails during final commit', async () => {
  const adapter = new MemoryRepositoryAdapter();
  adapter.failCommit = (key) => key.startsWith('manifests/');
  const engine = createEngine(adapter);
  await assert.rejects(engine.createSnapshot({}, {
    repositoryId: 'repo-failure', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'failed-run', chunkSizeBytes: MIN_CHUNK_SIZE_BYTES, files: snapshotFiles(CHUNK_A)
  }), (error) => error instanceof RepositoryEngineError && error.code === 'REPOSITORY_WRITE_FAILED');
  assert.equal([...adapter.objects.keys()].some((key) => key.startsWith('manifests/')), false);
  assert.equal([...adapter.objects.keys()].some((key) => key.startsWith('chunks/')), true);
  assert.equal(adapter.aborts.some((key) => key.startsWith('manifests/')), true);
});

test('rejects inconsistent adapter commit evidence and normalizes streamed read failures', async () => {
  const evidenceAdapter = new MemoryRepositoryAdapter();
  evidenceAdapter.commit = async function commit(_context, session) {
    this.objects.set(session.key, Buffer.from(session.body));
    return { key: session.key, sizeBytes: session.body.length + 1, checksum: session.checksum };
  };
  await assert.rejects(createEngine(evidenceAdapter).ensureRepository({}, { repositoryId: 'repo-evidence' }), (error) => error.code === 'REPOSITORY_COMMIT_MISMATCH');

  const adapter = new MemoryRepositoryAdapter();
  const engine = createEngine(adapter);
  const snapshot = await engine.createSnapshot({}, {
    repositoryId: 'repo-read-error', keyVersion: 'key-v1', masterKey: MASTER_KEY,
    idempotencyKey: 'read-error', files: snapshotFiles(CHUNK_A)
  });
  const originalRead = adapter.read.bind(adapter);
  adapter.read = async (_context, request) => {
    if (!request.key.startsWith('manifests/')) return originalRead(_context, request);
    return (async function* brokenRead() {
      yield Buffer.from('partial');
      throw new Error('sensitive adapter stream failure');
    })();
  };
  await assert.rejects(
    engine.openSnapshot({}, { repositoryId: 'repo-read-error', snapshotId: snapshot.snapshotId, masterKey: MASTER_KEY }),
    (error) => error.code === 'REPOSITORY_READ_FAILED' && !error.message.includes('sensitive')
  );
});

test('rejects incompatible format markers, weak keys, and duplicate paths', async () => {
  const adapter = new MemoryRepositoryAdapter();
  adapter.objects.set(FORMAT_OBJECT_KEY, Buffer.from(JSON.stringify({
    magic: 'deployerx-backup-repository', repositoryFormatVersion: 999, engineId: ENGINE_ID, repositoryId: 'repo-bad'
  })));
  const engine = createEngine(adapter);
  await assert.rejects(engine.ensureRepository({}, { repositoryId: 'repo-bad' }), (error) => error.code === 'REPOSITORY_FORMAT_UNSUPPORTED');
  await assert.rejects(createEngine(new MemoryRepositoryAdapter()).createSnapshot({}, {
    repositoryId: 'repo-key', keyVersion: 'key-v1', masterKey: Buffer.alloc(16), idempotencyKey: 'run', files: []
  }), (error) => error.code === 'REPOSITORY_KEY_INVALID');
  await assert.rejects(createEngine(new MemoryRepositoryAdapter()).createSnapshot({}, {
    repositoryId: 'repo-paths', keyVersion: 'key-v1', masterKey: MASTER_KEY, idempotencyKey: 'run',
    files: [{ path: '/same', type: 'file', content: Buffer.alloc(0) }, { path: '/same', type: 'directory' }]
  }), (error) => error.code === 'REPOSITORY_INPUT_INVALID');
});
