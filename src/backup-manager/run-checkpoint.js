const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const CHECKPOINT_MAGIC = Buffer.from('DXC1', 'ascii');
const CHECKPOINT_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;

class RunCheckpointError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'RunCheckpointError';
    this.code = code;
    this.category = options.category || 'integrity';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new RunCheckpointError('RUN_CHECKPOINT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function safeSegment(value) {
  return crypto.createHash('sha256').update(requiredText(value, 'Checkpoint identity')).digest('hex');
}

function checkpointKey(masterKey, binding) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new RunCheckpointError('RUN_CHECKPOINT_KEY_INVALID', 'The checkpoint encryption key is invalid.', { category: 'encryption' });
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.from('deployerx-run-checkpoint-v1', 'utf8'), Buffer.from(binding, 'utf8'), 32));
}

function normalizeCheckpoint(input = {}) {
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    checkpointId: requiredText(input.checkpointId, 'Checkpoint ID'),
    workspaceId: requiredText(input.workspaceId, 'Workspace ID'),
    executionGroupId: requiredText(input.executionGroupId, 'Execution group ID'),
    runId: requiredText(input.runId, 'Run ID'),
    fencingToken: Number(input.fencingToken),
    sequence: Number(input.sequence),
    planDigest: requiredText(input.planDigest, 'Plan digest', 128),
    adapterVersions: input.adapterVersions && typeof input.adapterVersions === 'object' && !Array.isArray(input.adapterVersions) ? structuredClone(input.adapterVersions) : {},
    repositoryEngineVersion: requiredText(input.repositoryEngineVersion, 'Repository engine version', 100),
    formatVersion: Number(input.formatVersion),
    phase: requiredText(input.phase, 'Checkpoint phase', 100),
    committedArtifacts: Array.isArray(input.committedArtifacts) ? structuredClone(input.committedArtifacts) : [],
    adapterState: input.adapterState === undefined ? null : structuredClone(input.adapterState),
    progress: input.progress && typeof input.progress === 'object' && !Array.isArray(input.progress) ? structuredClone(input.progress) : {},
    createdAt: requiredText(input.createdAt, 'Checkpoint creation time', 100)
  };
  if (!Number.isSafeInteger(checkpoint.fencingToken) || checkpoint.fencingToken < 1 || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1) throw new RunCheckpointError('RUN_CHECKPOINT_INVALID', 'Checkpoint fencing or sequence is invalid.', { category: 'validation' });
  if (!/^[a-f0-9]{64}$/.test(checkpoint.planDigest) || checkpoint.formatVersion !== CHECKPOINT_VERSION || !Number.isFinite(Date.parse(checkpoint.createdAt))) throw new RunCheckpointError('RUN_CHECKPOINT_INVALID', 'Checkpoint compatibility metadata is invalid.', { category: 'validation' });
  if (checkpoint.committedArtifacts.length > 64) throw new RunCheckpointError('RUN_CHECKPOINT_INVALID', 'Checkpoint contains too many committed artifacts.', { category: 'validation' });
  for (const artifact of checkpoint.committedArtifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new RunCheckpointError('RUN_CHECKPOINT_INVALID', 'Checkpoint artifact evidence is invalid.', { category: 'validation' });
    requiredText(artifact.repositoryId, 'Checkpoint repository ID');
    requiredText(artifact.snapshotId, 'Checkpoint snapshot ID');
    requiredText(artifact.locator, 'Checkpoint artifact locator', 8192);
    if (artifact.checksum?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(artifact.checksum?.digest || '') || !Number.isSafeInteger(Number(artifact.sizeBytes)) || Number(artifact.sizeBytes) < 0) throw new RunCheckpointError('RUN_CHECKPOINT_INVALID', 'Checkpoint artifact checksum or size is invalid.', { category: 'validation' });
  }
  const bytes = Buffer.from(JSON.stringify(checkpoint), 'utf8');
  if (bytes.length > MAX_CHECKPOINT_BYTES) throw new RunCheckpointError('RUN_CHECKPOINT_TOO_LARGE', 'Checkpoint exceeds the size limit.', { category: 'capacity' });
  return checkpoint;
}

function binding(workspaceId, runId, repositoryId) {
  return `checkpoint:v1:${requiredText(workspaceId, 'Workspace ID')}:${requiredText(runId, 'Run ID')}:${requiredText(repositoryId, 'Repository ID')}`;
}

function encodeCheckpoint(checkpoint, masterKey, repositoryId) {
  const normalized = normalizeCheckpoint(checkpoint);
  const aad = binding(normalized.workspaceId, normalized.runId, repositoryId);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', checkpointKey(masterKey, aad), nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(normalized), 'utf8'), cipher.final()]);
  return Buffer.concat([CHECKPOINT_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

function decodeCheckpoint(bytes, workspaceId, runId, repositoryId, masterKey) {
  const value = Buffer.from(bytes || []);
  if (value.length < CHECKPOINT_MAGIC.length + 12 + 16 || value.length > MAX_CHECKPOINT_BYTES + 64 || !value.subarray(0, CHECKPOINT_MAGIC.length).equals(CHECKPOINT_MAGIC)) throw new RunCheckpointError('RUN_CHECKPOINT_CORRUPT', 'Checkpoint data is invalid.');
  const aad = binding(workspaceId, runId, repositoryId);
  try {
    const nonceStart = CHECKPOINT_MAGIC.length;
    const tagStart = nonceStart + 12;
    const ciphertextStart = tagStart + 16;
    const decipher = crypto.createDecipheriv('aes-256-gcm', checkpointKey(masterKey, aad), value.subarray(nonceStart, tagStart));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(value.subarray(tagStart, ciphertextStart));
    const checkpoint = normalizeCheckpoint(JSON.parse(Buffer.concat([decipher.update(value.subarray(ciphertextStart)), decipher.final()]).toString('utf8')));
    if (checkpoint.workspaceId !== workspaceId || checkpoint.runId !== runId) throw new Error('binding mismatch');
    return checkpoint;
  } catch (error) {
    if (error instanceof RunCheckpointError && error.code !== 'RUN_CHECKPOINT_INVALID') throw error;
    throw new RunCheckpointError('RUN_CHECKPOINT_CORRUPT', 'Checkpoint data could not be authenticated.');
  }
}

class RunCheckpointStore {
  constructor({ rootPath, clock = () => new Date().toISOString() } = {}) {
    this.rootPath = path.resolve(requiredText(rootPath, 'Checkpoint root path', 8192));
    this.clock = clock;
  }

  #directory(workspaceId) {
    return path.join(this.rootPath, safeSegment(workspaceId));
  }

  #file(workspaceId, runId) {
    return path.join(this.#directory(workspaceId), `${safeSegment(runId)}.dxc`);
  }

  async write(checkpoint, repositoryId, masterKey) {
    const normalized = normalizeCheckpoint(checkpoint);
    const directory = this.#directory(normalized.workspaceId);
    const target = this.#file(normalized.workspaceId, normalized.runId);
    const temporary = path.join(directory, `.${safeSegment(normalized.runId)}.${crypto.randomUUID()}.tmp`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, encodeCheckpoint(normalized, masterKey, repositoryId), { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, target); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    return normalized;
  }

  async read(workspaceId, runId, repositoryId, masterKey) {
    let bytes;
    try { bytes = await fs.readFile(this.#file(workspaceId, runId)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return decodeCheckpoint(bytes, workspaceId, runId, repositoryId, masterKey);
  }

  async remove(workspaceId, runId) {
    await fs.unlink(this.#file(workspaceId, runId)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }

  async quarantine(workspaceId, runId) {
    const source = this.#file(workspaceId, runId);
    const timestamp = String(this.clock()).replace(/[^0-9]/g, '').slice(0, 17) || 'unknown';
    const target = `${source}.quarantine-${timestamp}-${crypto.randomUUID()}`;
    try { await fs.rename(source, target); return target; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
}

module.exports = {
  CHECKPOINT_VERSION,
  MAX_CHECKPOINT_BYTES,
  RunCheckpointError,
  RunCheckpointStore,
  decodeCheckpoint,
  encodeCheckpoint,
  normalizeCheckpoint
};
