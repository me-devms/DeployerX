const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { RunCheckpointStore, decodeCheckpoint, encodeCheckpoint } = require('./run-checkpoint');

function checkpoint() {
  return {
    checkpointId: 'checkpoint-1', workspaceId: 'local', executionGroupId: 'group-1', runId: 'run-1', fencingToken: 1, sequence: 1,
    planDigest: 'a'.repeat(64), adapterVersions: { source: '1.0.0', repository: '1.0.0' }, repositoryEngineVersion: '1.0.0', formatVersion: 1,
    phase: 'repository-committed', committedArtifacts: [{ repositoryId: 'repo-1', snapshotId: 'snp_123', locator: 'manifests/snp_123.dxb', checksum: { algorithm: 'sha256', digest: 'b'.repeat(64) }, sizeBytes: 100 }],
    adapterState: { selectionDigest: 'selection' }, progress: { bytesRead: 100 }, createdAt: '2026-08-03T12:00:00.000Z'
  };
}

test('encrypts, authenticates, and binds checkpoints to run and repository identities', () => {
  const key = crypto.randomBytes(32);
  const bytes = encodeCheckpoint(checkpoint(), key, 'repo-1');
  assert.equal(bytes.includes(Buffer.from('run-1')), false);
  assert.equal(decodeCheckpoint(bytes, 'local', 'run-1', 'repo-1', key).phase, 'repository-committed');
  assert.throws(() => decodeCheckpoint(bytes, 'local', 'run-2', 'repo-1', key), /authenticated/);
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => decodeCheckpoint(bytes, 'local', 'run-1', 'repo-1', key), /authenticated/);
});

test('atomically replaces, reads, removes, and quarantines checkpoint files', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-checkpoint-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const store = new RunCheckpointStore({ rootPath, clock: () => '2026-08-03T12:00:00.000Z' });
  const key = crypto.randomBytes(32);
  await store.write(checkpoint(), 'repo-1', key);
  assert.equal((await store.read('local', 'run-1', 'repo-1', key)).sequence, 1);
  await store.write({ ...checkpoint(), sequence: 2, checkpointId: 'checkpoint-2' }, 'repo-1', key);
  assert.equal((await store.read('local', 'run-1', 'repo-1', key)).sequence, 2);
  const quarantinePath = await store.quarantine('local', 'run-1');
  assert.equal(path.basename(quarantinePath).includes('.quarantine-'), true);
  assert.equal(await store.read('local', 'run-1', 'repo-1', key), null);
  await store.write(checkpoint(), 'repo-1', key);
  await store.remove('local', 'run-1');
  assert.equal(await store.read('local', 'run-1', 'repo-1', key), null);
});
