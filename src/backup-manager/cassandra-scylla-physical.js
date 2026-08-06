const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');
const { ADAPTER_ID, CassandraScyllaAdapter, cqlshrcContents, normalizeConfig, parseSnapshotNames, stableDigest } = require('./cassandra-scylla');
const {
  COMMIT_LOG_PATTERN,
  commitLogCursor,
  compareCommitLogCursors,
  evidenceDigest: commitLogEvidenceDigest,
  flattenCommitLogCursor,
  normalizeSegments,
  textDigest,
  validateCommitLogArchiveProperties
} = require('./cassandra-commit-log');

const ARCHIVE_MAGIC = Buffer.from('DXCSNP01', 'ascii');
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 100000;
const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024 * 1024 * 1024;
const MAX_STREAM_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const INCREMENTAL_CURSOR_VERSION = 1;
const MAX_INCREMENTAL_CURSOR_BYTES = 24 * 1024 * 1024;

class CassandraScyllaPhysicalError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CassandraScyllaPhysicalError';
    this.code = code;
    this.category = options.category || 'physical-backup';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function evidenceDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function parseNetstatsActivity(value) {
  const text = String(value || '');
  const mode = text.match(/^Mode:\s*([^\r\n]+)$/im)?.[1]?.trim() || null;
  if (!mode) throw new CassandraScyllaPhysicalError('CASSANDRA_NETSTATS_INVALID', 'Cassandra/Scylla streaming-state evidence is incomplete.', { category: 'integrity' });
  const activeTransfers = [...text.matchAll(/(?:Receiving|Sending)\s+(\d+)\s+files?/gi)].reduce((total, match) => total + Number(match[1]), 0);
  return { mode, activeTransfers, idle: /^normal$/i.test(mode) && activeTransfers === 0 };
}

function safeDataDirectory(value) {
  const directory = path.posix.normalize(requiredText(value, 'Cassandra/Scylla data directory', 4096));
  if (!directory.startsWith('/') || directory === '/' || directory.includes('//') || directory.split('/').includes('..')) throw new CassandraScyllaPhysicalError('CASSANDRA_DATA_DIRECTORY_INVALID', 'A Cassandra/Scylla data directory is unsafe.', { category: 'validation' });
  return directory.replace(/\/$/, '');
}

function snapshotTag(ownerId, hostId, keyspace, table) {
  const digest = crypto.createHash('sha256').update(`${ownerId}\0${hostId}\0${keyspace}\0${table}`).digest('hex').slice(0, 32);
  return `dx-${digest}`;
}

function parseNullFields(value, width, label) {
  const fields = String(value || '').split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % width !== 0) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_LISTING_INVALID', `${label} returned malformed filesystem evidence.`, { category: 'integrity' });
  const rows = [];
  for (let index = 0; index < fields.length; index += width) rows.push(fields.slice(index, index + width));
  return rows;
}

function parseSnapshotFileListing(value, snapshotDirectory, logicalPrefix) {
  return parseNullFields(value, 3, 'Snapshot enumeration').map(([sizeValue, modifiedValue, name]) => {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_PATH_INVALID', 'A native snapshot contains an unsafe filename.', { category: 'integrity' });
    const sizeBytes = Number(sizeValue);
    const modifiedSeconds = Number(modifiedValue);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_SNAPSHOT_FILE_BYTES || !Number.isFinite(modifiedSeconds) || modifiedSeconds < 0) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_FILE_INVALID', 'A native snapshot file returned invalid size or timestamp evidence.', { category: 'integrity' });
    return {
      name,
      sourcePath: path.posix.join(snapshotDirectory, name),
      archivePath: `${logicalPrefix}/${encodeURIComponent(name)}`,
      sizeBytes,
      modifiedAt: new Date(Math.floor(modifiedSeconds * 1000)).toISOString(),
      sha256: null
    };
  });
}

async function validateSstableMembership(files, readText) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const tocFiles = files.filter((file) => file.name.endsWith('-TOC.txt'));
  const componentFiles = files.filter((file) => !['manifest.json', 'schema.cql'].includes(file.name));
  if (componentFiles.length && !tocFiles.length) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_TOC_MISSING', 'A native snapshot contains SSTable components without a TOC.', { category: 'integrity' });
  for (const toc of tocFiles) {
    const descriptor = toc.name.slice(0, -'-TOC.txt'.length);
    const entries = String(await readText(toc.sourcePath)).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!entries.length || entries.length > 1000 || new Set(entries).size !== entries.length) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_TOC_INVALID', 'An SSTable TOC is empty, duplicated, or exceeds the component limit.', { category: 'integrity' });
    const expectedNames = entries.map((entry) => entry.startsWith(`${descriptor}-`) ? entry : `${descriptor}-${entry}`);
    if (expectedNames.some((name) => !byName.has(name)) || !expectedNames.some((name) => name.endsWith('-Data.db')) || !expectedNames.some((name) => name.endsWith('-Statistics.db'))) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_COMPONENT_MISSING', 'An SSTable TOC references missing required components.', { category: 'integrity' });
  }
  return true;
}

async function describeSstableSets(files, readText) {
  await validateSstableMembership(files, readText);
  const byName = new Map(files.map((file) => [file.name, file]));
  const assigned = new Set();
  const sets = [];
  for (const toc of files.filter((file) => file.name.endsWith('-TOC.txt')).sort((left, right) => left.name.localeCompare(right.name, 'en-US'))) {
    const descriptor = toc.name.slice(0, -'-TOC.txt'.length);
    const format = descriptor.split('-', 1)[0];
    if (!/^[A-Za-z0-9_]{1,16}$/.test(format)) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_FORMAT_INVALID', 'An incremental SSTable has an unsupported format identifier.', { category: 'compatibility' });
    const entries = String(await readText(toc.sourcePath)).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (new Set(entries).size !== entries.length) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_TOC_INVALID', 'An SSTable TOC contains duplicate component entries.', { category: 'integrity' });
    const names = [...new Set(entries.map((entry) => entry.startsWith(`${descriptor}-`) ? entry : `${descriptor}-${entry}`))].sort((left, right) => left.localeCompare(right, 'en-US'));
    const components = names.map((name) => byName.get(name));
    if (components.some((file) => !file) || !components.includes(toc)) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_COMPONENT_MISSING', 'An SSTable TOC does not describe one complete component set.', { category: 'integrity' });
    if (names.some((name) => assigned.has(name))) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_COMPONENT_DUPLICATE', 'An SSTable component belongs to more than one TOC-defined set.', { category: 'integrity' });
    for (const name of names) assigned.add(name);
    const evidence = components.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, sha256: file.sha256 }));
    sets.push({ descriptor, format, setDigest: evidenceDigest({ descriptor, format, components: evidence }), components: evidence, files: components });
  }
  const unassigned = files.filter((file) => !['manifest.json', 'schema.cql'].includes(file.name) && !assigned.has(file.name));
  if (unassigned.length) throw new CassandraScyllaPhysicalError('CASSANDRA_SSTABLE_COMPONENT_ORPHANED', 'An incremental backup directory contains components not owned by one complete TOC-defined SSTable set.', { category: 'integrity' });
  return sets;
}

function incrementalCursor(nodes) {
  const cursor = {
    version: INCREMENTAL_CURSOR_VERSION,
    nodes: nodes.map((node) => ({
      hostId: node.binding.hostId,
      tables: node.incrementalTables.map((table) => ({
        dataRootIndex: table.dataRootIndex, keyspace: table.keyspace, table: table.table, tableId: table.tableId,
        sets: table.sets.map((set) => ({ descriptor: set.descriptor, format: set.format, setDigest: set.setDigest, components: set.components }))
      }))
    }))
  };
  cursor.digest = evidenceDigest(cursor);
  if (Buffer.byteLength(canonicalJson(cursor), 'utf8') > MAX_INCREMENTAL_CURSOR_BYTES) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_LIMIT', 'The incremental cursor exceeds the supported authenticated metadata limit and requires a new full baseline after native-media cleanup.', { category: 'capacity' });
  return cursor;
}

function flattenIncrementalCursor(cursor, label) {
  if (!cursor || cursor.version !== INCREMENTAL_CURSOR_VERSION || !Array.isArray(cursor.nodes) || cursor.digest !== evidenceDigest({ ...cursor, digest: undefined })) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_INVALID', `${label} incremental cursor is invalid.`, { category: 'integrity' });
  const tables = new Map();
  const sets = new Map();
  let setCount = 0;
  for (const node of cursor.nodes) {
    const hostId = requiredText(node?.hostId, `${label} cursor host ID`, 100);
    if (!Array.isArray(node.tables)) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_INVALID', `${label} incremental cursor tables are invalid.`, { category: 'integrity' });
    for (const table of node.tables) {
      const dataRootIndex = Number(table?.dataRootIndex);
      const keyspace = requiredText(table?.keyspace, `${label} cursor keyspace`, 255);
      const tableName = requiredText(table?.table, `${label} cursor table`, 255);
      const tableId = requiredText(table?.tableId, `${label} cursor table ID`, 100);
      if (!Number.isInteger(dataRootIndex) || dataRootIndex < 0 || !Array.isArray(table.sets)) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_INVALID', `${label} incremental cursor table evidence is invalid.`, { category: 'integrity' });
      const tableKey = `${hostId}\0${dataRootIndex}\0${keyspace}\0${tableName}\0${tableId}`;
      if (tables.has(tableKey)) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_INVALID', `${label} incremental cursor contains duplicate table evidence.`, { category: 'integrity' });
      const formats = new Set();
      tables.set(tableKey, { table, formats });
      for (const set of table.sets) {
        const descriptor = requiredText(set?.descriptor, `${label} cursor SSTable descriptor`, 512);
        const format = requiredText(set?.format, `${label} cursor SSTable format`, 16);
        const setDigest = requiredText(set?.setDigest, `${label} cursor SSTable digest`, 100);
        if (!/^sha256:[0-9a-f]{64}$/.test(setDigest) || !Array.isArray(set.components) || !set.components.length) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_INVALID', `${label} incremental SSTable evidence is invalid.`, { category: 'integrity' });
        const setKey = `${tableKey}\0${descriptor}`;
        if (sets.has(setKey)) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_INVALID', `${label} incremental cursor contains duplicate SSTable evidence.`, { category: 'integrity' });
        sets.set(setKey, set);
        formats.add(format);
        setCount += 1;
        if (setCount > MAX_SNAPSHOT_FILES) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_CURSOR_LIMIT', 'The incremental SSTable cursor exceeds the supported limit and requires a new full baseline.', { category: 'capacity' });
      }
    }
  }
  return { tables, sets, setCount };
}

function compareIncrementalCursors(previousCursor, currentCursor) {
  const previous = flattenIncrementalCursor(previousCursor, 'Previous');
  const current = flattenIncrementalCursor(currentCursor, 'Current');
  if (previous.tables.size !== current.tables.size || [...previous.tables.keys()].some((key) => !current.tables.has(key))) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_SCOPE_CHANGED', 'Incremental node, data-root, or table scope changed and requires a new full baseline.', { category: 'integrity' });
  for (const [key, previousSet] of previous.sets) {
    const currentSet = current.sets.get(key);
    if (!currentSet) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_GAP', 'A previously recorded incremental SSTable set is missing and the chain cannot advance.', { category: 'integrity' });
    if (currentSet.setDigest !== previousSet.setDigest) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_MEDIA_CHANGED', 'A previously recorded incremental SSTable set changed and the chain cannot advance.', { category: 'integrity' });
  }
  const added = new Set();
  for (const [key, currentSet] of current.sets) {
    if (previous.sets.has(key)) continue;
    const tableKey = key.slice(0, key.lastIndexOf('\0'));
    const previousFormats = previous.tables.get(tableKey).formats;
    if (previousFormats.size && !previousFormats.has(currentSet.format)) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_FORMAT_CHANGED', 'The SSTable format changed and requires a new full baseline.', { category: 'compatibility' });
    added.add(key);
  }
  return { added, previousSetCount: previous.setCount, currentSetCount: current.setCount };
}

function localStream(executable, args, options = {}) {
  if (options.signal?.aborted) return Promise.reject(new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_CANCELED', 'Cassandra/Scylla snapshot execution was canceled.', { category: 'cancellation' }));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stderr = [];
    let stderrBytes = 0;
    let timedOut = false;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
    const onAbort = () => child.kill();
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= (options.stderrLimitBytes || MAX_COMMAND_OUTPUT_BYTES)) stderr.push(Buffer.from(chunk));
    });
    let settled = false;
    const completion = new Promise((complete, fail) => {
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener?.('abort', onAbort);
        if (error) fail(error); else complete(result);
      };
      child.once('error', () => finish(new CassandraScyllaPhysicalError('CASSANDRA_COMMAND_FAILED', 'A Cassandra/Scylla native command could not start.', { category: 'connectivity', retryable: true })));
      child.once('close', (code) => {
        if (timedOut) return finish(new CassandraScyllaPhysicalError('CASSANDRA_COMMAND_TIMEOUT', 'A Cassandra/Scylla native command exceeded its execution deadline.', { category: 'execution', retryable: true }));
        if (options.signal?.aborted) return finish(new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_CANCELED', 'Cassandra/Scylla snapshot execution was canceled.', { category: 'cancellation' }));
        if (stderrBytes > (options.stderrLimitBytes || MAX_COMMAND_OUTPUT_BYTES)) return finish(new CassandraScyllaPhysicalError('CASSANDRA_COMMAND_OUTPUT_LIMIT', 'A Cassandra/Scylla native command exceeded its diagnostic limit.', { category: 'capacity' }));
        if (code !== 0) return finish(new CassandraScyllaPhysicalError('CASSANDRA_COMMAND_FAILED', 'A Cassandra/Scylla native command failed.', { category: 'execution', retryable: true }));
        finish(null, { exitCode: 0, stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
    completion.catch(() => {});
    resolve({ stdout: child.stdout, completion, close: () => child.kill() });
  });
}

async function localRun(executable, args, options = {}) {
  const opened = await localStream(executable, args, options);
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of opened.stdout) {
      bytes += chunk.length;
      if (bytes > (options.stdoutLimitBytes || MAX_COMMAND_OUTPUT_BYTES)) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMAND_OUTPUT_LIMIT', 'A Cassandra/Scylla native command exceeded its output limit.', { category: 'capacity' });
      chunks.push(Buffer.from(chunk));
    }
    const completion = await opened.completion;
    return { ...completion, stdout: Buffer.concat(chunks).toString('utf8') };
  } catch (error) {
    opened.close();
    throw error;
  }
}

class CassandraScyllaNodeRuntimeFactory {
  constructor({ controlDatabase, secretStore, deviceId, sessionFactory = openSshExecutionSession } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Cassandra/Scylla runtime dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.sessionFactory = sessionFactory;
  }

  async open(workspaceId, connection, signal) {
    const mode = connection.endpoint?.executionMode;
    const commandTimeoutMs = Math.max(1000, Math.min(MAX_STREAM_TIMEOUT_MS, Number(connection.endpoint?.timeoutMs) || 30000));
    if (mode === 'local') return {
      mode,
      run: (executable, args, options = {}) => localRun(executable, args, { ...options, timeoutMs: options.timeoutMs || commandTimeoutMs, signal: options.ignoreAbort ? undefined : signal }),
      stream: (executable, args, options = {}) => localStream(executable, args, { ...options, timeoutMs: options.timeoutMs || MAX_STREAM_TIMEOUT_MS, signal: options.ignoreAbort ? undefined : signal }),
      writeFile: async (target, contents, options = {}) => {
        if (!contents || typeof contents[Symbol.asyncIterator] !== 'function') return fsPromises.writeFile(target, contents, { mode: options.mode || 0o600, flag: 'wx' });
        await pipeline(Readable.from(contents), fs.createWriteStream(target, { mode: options.mode || 0o600, flags: 'wx' }));
      },
      close() {}
    };
    if (mode !== 'ssh') throw new CassandraScyllaPhysicalError('CASSANDRA_EXECUTION_MODE_INVALID', 'Cassandra/Scylla snapshot execution mode is invalid.', { category: 'validation' });
    const sshConnection = await this.controlDatabase.repository('connection').get(workspaceId, connection.endpoint.sshConnectionId);
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success' || !sshConnection.trust?.fingerprint) throw new CassandraScyllaPhysicalError('CASSANDRA_SSH_UNAVAILABLE', 'A paired tested SSH connection is unavailable.', { category: 'connectivity', retryable: true });
    if (!(sshConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new CassandraScyllaPhysicalError('CASSANDRA_SSH_OTHER_DEVICE', 'A paired SSH connection belongs to another device.', { category: 'authorization' });
    const session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
    return {
      mode,
      run: (executable, args, options = {}) => session.run(commandFromArgs(executable, args), { ...options, timeoutMs: options.timeoutMs || commandTimeoutMs }),
      stream: (executable, args, options = {}) => session.stream(commandFromArgs(executable, args), { ...options, timeoutMs: options.timeoutMs || MAX_STREAM_TIMEOUT_MS }),
      writeFile: (target, contents, options) => session.writeFile(target, contents, options),
      close: () => session.close()
    };
  }
}

async function setupCqlAuthentication(runtime, config, workspaceId, secretStore) {
  if (!config.cqlPasswordSecretRefId) return { cqlshrcPath: null, cleanup: async () => {} };
  const password = await secretStore.resolve({ workspaceId, id: config.cqlPasswordSecretRefId });
  let localDirectory = null;
  const target = runtime.mode === 'ssh'
    ? `/tmp/deployerx-cassandra-backup-${crypto.randomBytes(16).toString('hex')}.rc`
    : path.join(localDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-backup-')), 'cqlshrc');
  await runtime.writeFile(target, cqlshrcContents(config.cqlUsername, password), { mode: 0o600 });
  return {
    cqlshrcPath: target,
    cleanup: async () => {
      if (runtime.mode === 'ssh') await runtime.run('rm', ['-f', '--', target], { ignoreAbort: true, stdoutLimitBytes: 1024 });
      else await fsPromises.rm(localDirectory, { recursive: true, force: true });
    }
  };
}

function cqlArgs(config, cqlshrcPath, statement) {
  return [config.contactHost, String(config.nativePort), ...(cqlshrcPath ? ['--cqlshrc', cqlshrcPath] : []), '--execute', statement];
}

async function sha256File(runtime, filePath) {
  const result = await runtime.run('sha256sum', ['--zero', '--', filePath], { stdoutLimitBytes: 8192 });
  const match = /^([0-9a-f]{64})\s/.exec(result.stdout);
  if (!match || !result.stdout.endsWith('\0')) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_CHECKSUM_INVALID', 'sha256sum returned invalid snapshot-file evidence.', { category: 'integrity' });
  return match[1];
}

async function* streamNodeArchive(runtime, nodeManifest, options = {}) {
  yield ARCHIVE_MAGIC;
  for (const file of nodeManifest.files) {
    if (options.signal?.aborted) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_CANCELED', 'Cassandra/Scylla snapshot transfer was canceled.', { category: 'cancellation' });
    const header = Buffer.from(JSON.stringify({ version: 1, path: file.archivePath, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, sha256: file.sha256 }), 'utf8');
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
    yield size; yield header;
    const opened = await runtime.stream('cat', ['--', file.sourcePath], { stderrLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
    const hash = crypto.createHash('sha256');
    let read = 0;
    try {
      for await (const raw of opened.stdout) {
        const chunk = Buffer.from(raw);
        read += chunk.length;
        if (read > file.sizeBytes) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_FILE_CHANGED', 'A native snapshot file grew during transfer.', { category: 'integrity' });
        hash.update(chunk);
        const paced = options.bandwidthLimiter ? await options.bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await options.onProgress?.({ phase: 'transferring', path: file.archivePath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
      await opened.completion;
    } catch (error) { opened.close(); throw error; }
    if (read !== file.sizeBytes || hash.digest('hex') !== file.sha256) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_FILE_CHANGED', 'A native snapshot file changed after immutable membership was recorded.', { category: 'integrity' });
  }
  yield Buffer.alloc(4);
}

class CassandraScyllaPhysicalBackupService {
  constructor({ controlDatabase, secretStore, deviceId, adapter = new CassandraScyllaAdapter(), runtimeFactory = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Cassandra/Scylla physical backup dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.runtimeFactory = runtimeFactory || new CassandraScyllaNodeRuntimeFactory({ controlDatabase, secretStore, deviceId });
    this.clock = clock;
  }

  async #publish(prepared, changes = {}) {
    prepared.lease = { ...prepared.lease, ...structuredClone(changes), updatedAt: this.clock() };
    await prepared.onSourceLease?.(structuredClone(prepared.lease));
  }

  async #discover(runtime, config, cqlshrcPath, signal) {
    const pages = [];
    for await (const page of this.adapter.discover({ signal, cqlshrcPath, runNativeCommand: ({ executable, args, timeoutMs }) => runtime.run(executable, args, { timeoutMs, stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES, stderrLimitBytes: MAX_COMMAND_OUTPUT_BYTES }) }, { connection: config, kind: 'all' })) pages.push(page);
    if (pages.length !== 1) throw new CassandraScyllaPhysicalError('CASSANDRA_PREFLIGHT_INVALID', 'Cassandra/Scylla preflight returned incomplete discovery evidence.', { category: 'integrity' });
    return pages[0];
  }

  #verifyDiscovery(execution, binding, connection, page) {
    const inventory = connection.clusterInventory;
    if (!inventory || connection.revision !== binding.connectionRevision || connection.trust?.fingerprint !== binding.serverIdentityFingerprint || page.identity?.localHostId !== binding.hostId) throw new CassandraScyllaPhysicalError('CASSANDRA_NODE_IDENTITY_CHANGED', `Cassandra/Scylla node ${binding.hostId} identity changed after enrollment.`, { category: 'integrity' });
    if (page.clusterFingerprint !== execution.clusterFingerprint || page.topologyFingerprint !== execution.topologyFingerprint || page.coverage?.ringFingerprint !== execution.ringFingerprint || page.identity?.schemaVersion !== execution.schemaVersion || page.identity?.schemaAgreement !== true || page.coverage?.mode !== 'vnode-ring') throw new CassandraScyllaPhysicalError('CASSANDRA_CLUSTER_CHANGED', 'Cassandra/Scylla cluster topology, ring, or schema changed after enrollment.', { category: 'integrity' });
    if ((page.topology || []).some((node) => node.status !== 'up' || node.state !== 'normal') || page.identity?.nativeTransportActive !== true || page.identity?.gossipActive !== true) throw new CassandraScyllaPhysicalError('CASSANDRA_CLUSTER_UNHEALTHY', 'Every Cassandra/Scylla node must be up and normal with gossip and native transport active.', { category: 'consistency', retryable: true });
    const coverage = page.coverage.nodeCoverage.find((node) => node.hostId === binding.hostId);
    if (!coverage || coverage.tokenCount !== binding.tokenCount || coverage.tokenDigest !== binding.tokenDigest) throw new CassandraScyllaPhysicalError('CASSANDRA_TOKEN_COVERAGE_CHANGED', `Cassandra/Scylla node ${binding.hostId} token ownership changed.`, { category: 'integrity' });
    for (const selected of execution.tables) {
      const table = page.tables.find((item) => item.keyspace === selected.database && item.name === selected.name);
      if (!table || !table.selectable || table.tableId?.toLowerCase() !== selected.tableId) throw new CassandraScyllaPhysicalError('CASSANDRA_TABLE_ID_CHANGED', `Cassandra/Scylla table ${selected.database}.${selected.name} changed after enrollment.`, { category: 'integrity' });
    }
  }

  async #enumerateIncrementalTables(node, execution) {
    const tables = [];
    let fileCount = 0;
    const dataDirectories = node.binding.dataDirectories.map(safeDataDirectory);
    for (const table of execution.tables) {
      const tableDirectory = `${table.name}-${table.tableId.replace(/-/g, '')}`;
      for (let rootIndex = 0; rootIndex < dataDirectories.length; rootIndex += 1) {
        const backupDirectory = path.posix.join(dataDirectories[rootIndex], table.database, tableDirectory, 'backups');
        let exists = true;
        try { await node.runtime.run('test', ['-e', backupDirectory], { stdoutLimitBytes: 1024 }); }
        catch { exists = false; }
        if (!exists) {
          tables.push({ dataRootIndex: rootIndex, keyspace: table.database, table: table.name, tableId: table.tableId, backupDirectory, sets: [] });
          continue;
        }
        await node.runtime.run('test', ['-d', backupDirectory], { stdoutLimitBytes: 1024 });
        await node.runtime.run('test', ['-r', backupDirectory], { stdoutLimitBytes: 1024 });
        const foreign = await node.runtime.run('find', [backupDirectory, '-xdev', '-mindepth', '1', '-maxdepth', '1', '!', '-type', 'f', '-print0'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
        if (foreign.stdout) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_SPECIAL_FILE', 'An incremental backup directory contains a non-regular file or nested directory.', { category: 'integrity' });
        const listed = await node.runtime.run('find', [backupDirectory, '-xdev', '-mindepth', '1', '-maxdepth', '1', '-type', 'f', '-printf', '%s\0%T@\0%f\0'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
        const logicalPrefix = `nodes/${node.binding.hostId}/incremental/data-${rootIndex}/${encodeURIComponent(table.database)}/${encodeURIComponent(table.name)}`;
        const files = parseSnapshotFileListing(listed.stdout, backupDirectory, logicalPrefix);
        fileCount += files.length;
        if (fileCount > MAX_SNAPSHOT_FILES) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_FILE_LIMIT', 'The incremental backup inventory exceeds the supported file limit and requires a new full baseline.', { category: 'capacity' });
        for (const file of files) file.sha256 = await sha256File(node.runtime, file.sourcePath);
        const tocCache = new Map();
        const sets = await describeSstableSets(files, async (filePath) => {
          if (!tocCache.has(filePath)) tocCache.set(filePath, (await node.runtime.run('cat', ['--', filePath], { stdoutLimitBytes: 1024 * 1024 })).stdout);
          return tocCache.get(filePath);
        });
        tables.push({ dataRootIndex: rootIndex, keyspace: table.database, table: table.name, tableId: table.tableId, backupDirectory, sets });
      }
    }
    return tables;
  }

  async #enumerateCommitLogs(node) {
    const enrollment = node.binding.commitLogArchive;
    if (!enrollment || node.page?.product !== 'cassandra') throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_NOT_ENROLLED', `Cassandra node ${node.binding.hostId} does not have an enrolled commit-log archive.`, { category: 'validation' });
    const directory = safeDataDirectory(enrollment.directory);
    const propertiesPath = safeDataDirectory(enrollment.propertiesPath);
    await node.runtime.run('test', ['-d', directory], { stdoutLimitBytes: 1024 });
    await node.runtime.run('test', ['-r', directory], { stdoutLimitBytes: 1024 });
    const markerPath = path.posix.join(directory, '.deployerx-owner');
    await node.runtime.run('test', ['-f', markerPath], { stdoutLimitBytes: 1024 });
    const marker = await node.runtime.run('cat', ['--', markerPath], { stdoutLimitBytes: 4096 });
    if (textDigest(marker.stdout) !== enrollment.ownershipMarkerDigest) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_OWNERSHIP_CHANGED', `Cassandra node ${node.binding.hostId} archive ownership does not match Source enrollment.`, { category: 'integrity' });
    await node.runtime.run('test', ['-f', propertiesPath], { stdoutLimitBytes: 1024 });
    const properties = await node.runtime.run('cat', ['--', propertiesPath], { stdoutLimitBytes: 64 * 1024 });
    const configuration = validateCommitLogArchiveProperties(properties.stdout, enrollment);
    const foreign = await node.runtime.run('find', [directory, '-xdev', '-mindepth', '1', '-maxdepth', '1', '!', '-type', 'f', '-print0'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
    if (foreign.stdout) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_SPECIAL_FILE', 'A Cassandra commit-log archive contains a nested or special file.', { category: 'integrity' });
    const listed = await node.runtime.run('find', [directory, '-xdev', '-mindepth', '1', '-maxdepth', '1', '-type', 'f', '-printf', '%s\0%T@\0%f\0'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
    const files = parseSnapshotFileListing(listed.stdout, directory, `nodes/${node.binding.hostId}/commitlog`).filter((file) => file.name !== '.deployerx-owner');
    if (files.some((file) => !COMMIT_LOG_PATTERN.test(file.name))) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_FILE_INVALID', 'A Cassandra commit-log archive contains an unexpected file.', { category: 'integrity' });
    for (const file of files) file.sha256 = await sha256File(node.runtime, file.sourcePath);
    const segments = normalizeSegments(files);
    const sourceByName = new Map(files.map((file) => [file.name, file]));
    const clockResult = await node.runtime.run('date', ['-u', '+%Y-%m-%dT%H:%M:%S.%3NZ'], { stdoutLimitBytes: 4096 });
    const clockObservedAt = String(clockResult.stdout || '').trim();
    const controllerObservedAt = this.clock();
    const clockOffsetMilliseconds = Date.parse(clockObservedAt) - Date.parse(controllerObservedAt);
    const clockSkewMilliseconds = Math.abs(clockOffsetMilliseconds);
    if (!Number.isFinite(clockSkewMilliseconds) || clockSkewMilliseconds > enrollment.maximumClockSkewSeconds * 1000) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_CLOCK_SKEW', `Cassandra node ${node.binding.hostId} clock exceeds the enrolled PITR skew limit.`, { category: 'consistency', retryable: true });
    return {
      hostId: node.binding.hostId,
      archiveDirectoryDigest: commitLogEvidenceDigest({ directory }),
      propertiesDigest: configuration.propertiesDigest,
      archiveCommandDigest: configuration.archiveCommandDigest,
      ownershipMarkerDigest: enrollment.ownershipMarkerDigest,
      precision: configuration.precision,
      clockObservedAt: new Date(Date.parse(clockObservedAt)).toISOString(),
      clockOffsetMilliseconds,
      clockSkewMilliseconds,
      segments,
      files: segments.map((segment) => ({ ...sourceByName.get(segment.name), version: segment.version, segmentId: segment.segmentId }))
    };
  }

  async #previousIncrementalManifest(workspaceId, plan, options) {
    const point = options.previousRecoveryPoint;
    const requiredRepositoryIds = new Set(options.repositoryIds || []);
    const pointCopies = new Map((point?.repositoryCopies || []).map((copy) => [copy.repositoryId, copy]));
    if (!point || !['full', 'incremental'].includes(point.type) || point.sourceId !== plan.source.id || point.jobId !== options.jobId || point.verification?.state !== 'succeeded' || point.retention?.deletionEligible === true || !(point.repositoryCopies || []).length || point.repositoryCopies.some((copy) => copy.state !== 'available') || [...requiredRepositoryIds].some((id) => pointCopies.get(id)?.state !== 'available')) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_PARENT_INVALID', 'Incremental backup requires one retained verified parent with an available copy in every configured repository.', { category: 'integrity' });
    const recoveryPoints = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 });
    const root = recoveryPoints.find((candidate) => candidate.id === (point.chainRootId || point.id));
    const rootCopies = new Map((root?.repositoryCopies || []).map((copy) => [copy.repositoryId, copy]));
    if (!root || root.type !== 'full' || root.jobId !== point.jobId || root.sourceId !== point.sourceId || root.verification?.state !== 'succeeded' || root.retention?.deletionEligible === true || [...requiredRepositoryIds].some((id) => rootCopies.get(id)?.state !== 'available')) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_ROOT_INVALID', 'The incremental chain root is missing, unverified, expired, or unavailable in a configured repository.', { category: 'integrity' });
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 });
    const candidates = artifacts.filter((artifact) => artifact.recoveryPointId === point.id && artifact.kind === 'metadata' && artifact.metadata?.engine === 'cassandra-scylla');
    const digests = new Set(candidates.map((artifact) => artifact.metadata?.manifestDigest).filter(Boolean));
    if (!candidates.length || digests.size !== 1) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_PARENT_AMBIGUOUS', 'The parent RecoveryPoint does not contain one unambiguous authenticated Cassandra/Scylla cluster manifest.', { category: 'integrity' });
    const metadata = candidates[0].metadata;
    const execution = plan.source.physicalExecution;
    if (!['cassandra-scylla-native-full', 'cassandra-scylla-native-incremental'].includes(metadata.kind)
      || metadata.publication?.state !== 'sealed' || metadata.source?.sourceId !== plan.source.id || metadata.source?.sourceRevision !== plan.source.revision || metadata.source?.jobId !== options.jobId
      || metadata.selectionDigest !== execution.selectionFingerprint || metadata.cluster?.clusterFingerprint !== execution.clusterFingerprint
      || metadata.cluster?.topologyFingerprint !== execution.topologyFingerprint || metadata.cluster?.ringFingerprint !== execution.ringFingerprint
      || metadata.cluster?.schemaVersion !== execution.schemaVersion || !metadata.incremental?.cursor) {
      throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_PARENT_MISMATCH', 'The parent RecoveryPoint does not match the current Source, Job, selection, cluster, topology, ring, schema, and incremental cursor.', { category: 'integrity' });
    }
    if (point.type === 'incremental' && (metadata.chain?.parentRecoveryPointId !== point.parentRecoveryPointId || metadata.chain?.chainRootRecoveryPointId !== root.id)) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_LINEAGE_INVALID', 'The parent RecoveryPoint lineage does not match its authenticated cluster manifest.', { category: 'integrity' });
    flattenIncrementalCursor(metadata.incremental.cursor, 'Parent');
    return { point, metadata };
  }

  async #previousCommitLogManifest(workspaceId, plan, options) {
    const point = options.previousRecoveryPoint;
    const requiredRepositoryIds = new Set(options.repositoryIds || []);
    const pointCopies = new Map((point?.repositoryCopies || []).map((copy) => [copy.repositoryId, copy]));
    if (!point || !['full', 'log'].includes(point.type) || point.sourceId !== plan.source.id || point.jobId !== options.jobId || point.verification?.state !== 'succeeded' || point.retention?.deletionEligible === true || !(point.repositoryCopies || []).length || point.repositoryCopies.some((copy) => copy.state !== 'available') || [...requiredRepositoryIds].some((id) => pointCopies.get(id)?.state !== 'available')) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_PARENT_INVALID', 'Cassandra commit-log capture requires one retained verified parent in every configured repository.', { category: 'integrity' });
    const recoveryPoints = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 });
    const root = recoveryPoints.find((candidate) => candidate.id === (point.chainRootId || point.id));
    const rootCopies = new Map((root?.repositoryCopies || []).map((copy) => [copy.repositoryId, copy]));
    if (!root || root.type !== 'full' || root.jobId !== point.jobId || root.sourceId !== point.sourceId || root.verification?.state !== 'succeeded' || root.retention?.deletionEligible === true || [...requiredRepositoryIds].some((id) => rootCopies.get(id)?.state !== 'available')) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_ROOT_INVALID', 'The Cassandra commit-log full anchor is unavailable, unverified, or deletion-eligible.', { category: 'integrity' });
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 });
    const candidates = artifacts.filter((artifact) => artifact.recoveryPointId === point.id && artifact.kind === 'metadata' && artifact.metadata?.engine === 'cassandra-scylla');
    const digests = new Set(candidates.map((artifact) => artifact.metadata?.manifestDigest).filter(Boolean));
    if (!candidates.length || digests.size !== 1) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_PARENT_AMBIGUOUS', 'The Cassandra commit-log parent does not contain one unambiguous authenticated cluster manifest.', { category: 'integrity' });
    const metadata = candidates[0].metadata;
    const execution = plan.source.physicalExecution;
    if (!['cassandra-scylla-native-full', 'cassandra-commit-log'].includes(metadata.kind)
      || metadata.publication?.state !== 'sealed' || metadata.source?.sourceId !== plan.source.id || metadata.source?.sourceRevision !== plan.source.revision || metadata.source?.jobId !== options.jobId
      || metadata.selectionDigest !== execution.selectionFingerprint || metadata.cluster?.product !== 'cassandra' || metadata.cluster?.clusterFingerprint !== execution.clusterFingerprint
      || metadata.cluster?.topologyFingerprint !== execution.topologyFingerprint || metadata.cluster?.ringFingerprint !== execution.ringFingerprint
      || metadata.cluster?.schemaVersion !== execution.schemaVersion || !metadata.commitLog?.cursor || !metadata.commitLog?.recoveryWindow?.latest) {
      throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_PARENT_MISMATCH', 'The Cassandra commit-log parent does not match the Source, Job, selection, cluster, topology, ring, schema, and archive cursor.', { category: 'integrity' });
    }
    if (point.type === 'log' && (metadata.chain?.parentRecoveryPointId !== point.parentRecoveryPointId || metadata.chain?.chainRootRecoveryPointId !== root.id)) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_LINEAGE_INVALID', 'The Cassandra commit-log parent lineage does not match its authenticated manifest.', { category: 'integrity' });
    flattenCommitLogCursor(metadata.commitLog.cursor, 'Cassandra commit-log parent');
    return { point, root, metadata };
  }

  async #prepareCommitLog(workspaceId, plan, options, prepared) {
    const execution = plan.source.physicalExecution;
    const predecessor = await this.#previousCommitLogManifest(workspaceId, plan, options);
    await this.#publish(prepared, { state: 'active', mode: 'commit-log', nodes: prepared.nodes.map((node) => ({ hostId: node.binding.hostId, connectionId: node.binding.connectionId, tags: [] })) });
    for (const node of prepared.nodes) node.commitLog = await this.#enumerateCommitLogs(node);
    const cursor = commitLogCursor(prepared.nodes.map((node) => node.commitLog));
    const comparison = compareCommitLogCursors(predecessor.metadata.commitLog.cursor, cursor);
    const previousBoundary = predecessor.metadata.commitLog.recoveryWindow.latest;
    const currentBoundary = cursor.safeThrough;
    const boundaryAdvanced = Boolean(currentBoundary) && Date.parse(currentBoundary) > Date.parse(previousBoundary);
    let newSegmentCount = 0;
    for (const node of prepared.nodes) {
      node.files = node.commitLog.files.filter((file) => comparison.added.has(`${node.binding.hostId}\0${file.name}`));
      newSegmentCount += node.files.length;
    }
    const noChange = !boundaryAdvanced || newSegmentCount === 0;
    const nodeManifests = prepared.nodes.map((node) => ({
      version: 1,
      hostId: node.binding.hostId,
      connectionId: node.binding.connectionId,
      connectionRevision: node.connection.revision,
      serverIdentityFingerprint: node.connection.trust.fingerprint,
      tokenCount: node.binding.tokenCount,
      tokenDigest: node.binding.tokenDigest,
      files: node.files.map(({ sourcePath: _sourcePath, ...file }) => file),
      fileCount: node.files.length,
      sourceBytes: node.files.reduce((total, file) => total + file.sizeBytes, 0),
      commitLog: {
        previousSegmentCount: predecessor.metadata.commitLog.cursor.nodes.find((item) => item.hostId === node.binding.hostId)?.segments.length || 0,
        currentSegmentCount: node.commitLog.segments.length,
        newSegmentCount: node.files.length,
        safeThrough: node.commitLog.segments.at(-1)?.modifiedAt || null,
        clockObservedAt: node.commitLog.clockObservedAt,
        clockOffsetMilliseconds: node.commitLog.clockOffsetMilliseconds,
        clockSkewMilliseconds: node.commitLog.clockSkewMilliseconds
      }
    }));
    for (const manifest of nodeManifests) manifest.manifestDigest = stableDigest(manifest);
    const clusterManifest = {
      version: 1,
      kind: 'cassandra-commit-log',
      adapterId: ADAPTER_ID,
      adapterVersion: plan.manifest.adapterVersion,
      engine: 'cassandra-scylla',
      backupMethod: 'physical',
      backupMode: 'native',
      selection: plan.source.selector,
      selectionDigest: execution.selectionFingerprint,
      consistency: { requestedLevel: 'crash', achievedLevel: 'crash', method: 'cassandra-commit-log', backupMethod: 'physical', backupMode: 'native', captureCoordinates: true, proven: true },
      cluster: { product: execution.product, version: execution.productVersion, partitioner: execution.partitioner, name: execution.clusterName, clusterFingerprint: execution.clusterFingerprint, topologyFingerprint: execution.topologyFingerprint, ringFingerprint: execution.ringFingerprint, schemaVersion: execution.schemaVersion, coverageMode: execution.coverageMode, tokenCount: execution.tokenCount },
      source: { sourceId: plan.source.id, sourceRevision: plan.source.revision, jobId: options.jobId, ownerId: prepared.ownerId },
      keyspaces: execution.keyspaces,
      tables: execution.tables,
      rebuildObjects: execution.rebuildObjects,
      nodes: nodeManifests,
      chain: { parentRecoveryPointId: predecessor.point.id, chainRootRecoveryPointId: predecessor.root.id },
      commitLog: {
        cursor,
        previousCursorDigest: predecessor.metadata.commitLog.cursor.digest,
        previousSegmentCount: comparison.previousSegmentCount,
        currentSegmentCount: comparison.currentSegmentCount,
        newSegmentCount,
        precision: predecessor.metadata.commitLog.precision,
        recoveryWindow: { earliest: predecessor.metadata.commitLog.recoveryWindow.earliest, previous: previousBoundary, latest: boundaryAdvanced ? currentBoundary : previousBoundary },
        gaps: []
      },
      noChange,
      snapshotWindow: { startedAt: prepared.lease.acquiredAt, membershipCapturedAt: this.clock() },
      cleanup: { ownership: 'read-only-operator-archive', state: 'not-required', deleteSourceMedia: false }
    };
    clusterManifest.manifestDigest = stableDigest(clusterManifest);
    const artifacts = noChange ? [] : prepared.nodes.filter((node) => node.files.length).map((node) => ({
      componentId: node.binding.hostId,
      artifactPath: `cassandra-scylla/commitlog/${node.binding.hostId}.dxcsnapshot`,
      artifactKind: 'transaction-log',
      content: () => streamNodeArchive(node.runtime, { files: node.files }, options)
    }));
    artifacts.push({ componentId: 'cluster-manifest', artifactPath: 'cassandra-scylla/cluster-manifest.json', artifactKind: 'metadata', content: async function* clusterManifestContent() { await this.seal(prepared, options); yield Buffer.from(JSON.stringify(prepared.databaseManifest), 'utf8'); }.bind(this) });
    clusterManifest.artifacts = artifacts.map((artifact) => ({ componentId: artifact.componentId, kind: artifact.artifactKind, path: artifact.artifactPath }));
    prepared.databaseManifest = clusterManifest;
    prepared.artifacts = artifacts;
    return prepared;
  }

  async #prepareIncremental(workspaceId, plan, options, prepared, schemaBytes) {
    const execution = plan.source.physicalExecution;
    const predecessor = await this.#previousIncrementalManifest(workspaceId, plan, options);
    await this.#publish(prepared, { state: 'active', mode: 'incremental', nodes: prepared.nodes.map((node) => ({ hostId: node.binding.hostId, connectionId: node.binding.connectionId, tags: [] })) });
    for (const node of prepared.nodes) node.incrementalTables = await this.#enumerateIncrementalTables(node, execution);
    const cursor = incrementalCursor(prepared.nodes);
    const comparison = compareIncrementalCursors(predecessor.metadata.incremental.cursor, cursor);
    let newSetCount = 0;
    for (const node of prepared.nodes) {
      node.files = [];
      for (const table of node.incrementalTables) {
        const tableKey = `${node.binding.hostId}\0${table.dataRootIndex}\0${table.keyspace}\0${table.table}\0${table.tableId}`;
        table.newSets = table.sets.filter((set) => comparison.added.has(`${tableKey}\0${set.descriptor}`));
        newSetCount += table.newSets.length;
        for (const set of table.newSets) node.files.push(...set.files.map((file) => ({ ...file, keyspace: table.keyspace, table: table.table, tableId: table.tableId, descriptor: set.descriptor, format: set.format, setDigest: set.setDigest, dataRootIndex: table.dataRootIndex })));
      }
    }
    const nodeManifests = prepared.nodes.map((node) => ({
      version: 1, hostId: node.binding.hostId, connectionId: node.binding.connectionId, connectionRevision: node.connection.revision,
      serverIdentityFingerprint: node.connection.trust.fingerprint, tokenCount: node.binding.tokenCount, tokenDigest: node.binding.tokenDigest,
      files: node.files.map(({ sourcePath: _sourcePath, ...file }) => file), fileCount: node.files.length,
      sourceBytes: node.files.reduce((total, file) => total + file.sizeBytes, 0),
      incremental: { previousSetCount: predecessor.metadata.incremental.cursor.nodes.find((item) => item.hostId === node.binding.hostId)?.tables.reduce((total, table) => total + table.sets.length, 0) || 0, currentSetCount: node.incrementalTables.reduce((total, table) => total + table.sets.length, 0), newSetCount: node.incrementalTables.reduce((total, table) => total + table.newSets.length, 0) }
    }));
    for (const manifest of nodeManifests) manifest.manifestDigest = stableDigest(manifest);
    const clusterManifest = {
      version: 1, kind: 'cassandra-scylla-native-incremental', adapterId: ADAPTER_ID, adapterVersion: plan.manifest.adapterVersion, engine: 'cassandra-scylla',
      backupMethod: 'physical', backupMode: 'incremental', selection: plan.source.selector, selectionDigest: execution.selectionFingerprint,
      consistency: { requestedLevel: 'crash', achievedLevel: 'crash', method: 'cassandra-native-snapshot', backupMethod: 'physical', backupMode: 'incremental', captureCoordinates: true, proven: true },
      cluster: { product: execution.product, version: execution.productVersion, partitioner: execution.partitioner, name: execution.clusterName, clusterFingerprint: execution.clusterFingerprint, topologyFingerprint: execution.topologyFingerprint, ringFingerprint: execution.ringFingerprint, schemaVersion: execution.schemaVersion, coverageMode: execution.coverageMode, tokenCount: execution.tokenCount },
      source: { sourceId: plan.source.id, sourceRevision: plan.source.revision, jobId: options.jobId, ownerId: prepared.ownerId },
      keyspaces: execution.keyspaces, tables: execution.tables, rebuildObjects: execution.rebuildObjects,
      nodes: nodeManifests,
      schema: { path: 'cassandra-scylla/schema/schema.cql', sizeBytes: schemaBytes.length, sha256: crypto.createHash('sha256').update(schemaBytes).digest('hex'), scope: 'selected-keyspaces', selectionDigest: execution.selectionFingerprint },
      chain: { parentRecoveryPointId: predecessor.point.id, chainRootRecoveryPointId: predecessor.point.chainRootId || predecessor.point.id },
      incremental: { cursor, previousCursorDigest: predecessor.metadata.incremental.cursor.digest, previousSetCount: comparison.previousSetCount, currentSetCount: comparison.currentSetCount, newSetCount },
      noChange: newSetCount === 0,
      snapshotWindow: { startedAt: prepared.lease.acquiredAt, membershipCapturedAt: this.clock() },
      cleanup: { ownership: 'read-only-incremental-media', state: 'not-required', deleteSourceMedia: false }
    };
    clusterManifest.manifestDigest = stableDigest(clusterManifest);
    const artifacts = prepared.nodes.map((node, index) => ({ componentId: node.binding.hostId, artifactPath: `cassandra-scylla/nodes/${node.binding.hostId}-incremental.dxcsnapshot`, artifactKind: 'physical-backup', content: () => streamNodeArchive(node.runtime, { ...nodeManifests[index], files: node.files }, options) }));
    artifacts.push({ componentId: 'schema', artifactPath: clusterManifest.schema.path, artifactKind: 'schema', content: async function* schemaContent() { yield schemaBytes; } });
    artifacts.push({ componentId: 'cluster-manifest', artifactPath: 'cassandra-scylla/cluster-manifest.json', artifactKind: 'metadata', content: async function* clusterManifestContent() { await this.seal(prepared, options); yield Buffer.from(JSON.stringify(prepared.databaseManifest), 'utf8'); }.bind(this) });
    clusterManifest.artifacts = artifacts.map((artifact) => ({ componentId: artifact.componentId, kind: artifact.artifactKind, path: artifact.artifactPath }));
    prepared.databaseManifest = clusterManifest;
    prepared.artifacts = artifacts;
    return prepared;
  }

  async prepare(workspaceId, executionId, plan, options = {}) {
    const execution = plan.source.physicalExecution;
    if (!execution || execution.engine !== 'cassandra-scylla' || execution.topology !== 'cluster' || plan.source.consistency?.backupMethod !== 'physical' || !['full', 'incremental', 'native'].includes(options.backupMode)) throw new CassandraScyllaPhysicalError('CASSANDRA_SOURCE_INVALID', 'Cassandra/Scylla backup requires an enabled physical cluster Source and a supported Job mode.', { category: 'validation' });
    const incrementalRequested = options.backupMode === 'incremental' || options.requestedBackupMode === 'incremental';
    const commitLogRequested = options.backupMode === 'native' || options.requestedBackupMode === 'native';
    if (commitLogRequested && (execution.product !== 'cassandra' || execution.commitLogPitrEnabled !== true || !execution.nodes?.every((node) => Boolean(node.commitLogArchive)))) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_NOT_ENROLLED', 'Cassandra commit-log PITR requires complete per-node archive enrollment.', { category: 'validation' });
    const ownerId = `cassandra-scylla-snapshot:${workspaceId}:${requiredText(executionId, 'Execution ID', 200)}`;
    const prepared = {
      physical: true,
      ownerId,
      onSourceLease: options.onSourceLease,
      lease: { version: 1, kind: 'cassandra-scylla-native-snapshot', ownerId, sourceId: plan.source.id, clusterFingerprint: execution.clusterFingerprint, selectionFingerprint: execution.selectionFingerprint, state: 'acquiring', nodes: [], acquiredAt: this.clock(), updatedAt: this.clock() },
      nodes: [],
      sealed: false,
      released: false
    };
    await this.#publish(prepared);
    try {
      for (const binding of execution.nodes) {
        const connection = await this.controlDatabase.repository('connection').get(workspaceId, binding.connectionId);
        if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new CassandraScyllaPhysicalError('CASSANDRA_NODE_UNAVAILABLE', `Cassandra/Scylla node ${binding.hostId} is unavailable or unhealthy.`, { category: 'connectivity', retryable: true });
        const runtime = await this.runtimeFactory.open(workspaceId, connection, options.signal);
        const config = normalizeConfig({ ...connection.endpoint, cqlPasswordSecretRefId: connection.secretRefIds?.[0] || null });
        const authentication = await setupCqlAuthentication(runtime, config, workspaceId, this.secretStore);
        const page = await this.#discover(runtime, config, authentication.cqlshrcPath, options.signal);
        this.#verifyDiscovery(execution, binding, connection, page);
        if (incrementalRequested && page.identity?.incrementalBackupsEnabled !== true) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_DISABLED', `Native incremental backups are not enabled on Cassandra/Scylla node ${binding.hostId}.`, { category: 'consistency' });
        if (incrementalRequested) {
          const activity = parseNetstatsActivity((await runtime.run(config.nodetoolPath, ['netstats'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES })).stdout);
          if (!activity.idle) throw new CassandraScyllaPhysicalError('CASSANDRA_INCREMENTAL_STREAMING_ACTIVE', `Cassandra/Scylla node ${binding.hostId} is not in idle normal streaming state; create a new full baseline after streaming completes.`, { category: 'consistency', retryable: true });
        }
        for (const directory of binding.dataDirectories || []) {
          const safeDirectory = safeDataDirectory(directory);
          await runtime.run('test', ['-d', safeDirectory], { stdoutLimitBytes: 1024 });
          await runtime.run('test', ['-r', safeDirectory], { stdoutLimitBytes: 1024 });
        }
        prepared.nodes.push({ binding, connection, runtime, config, authentication, page, tags: [], files: [] });
      }
      const seed = prepared.nodes.find((node) => node.binding.connectionId === plan.connection.id) || prepared.nodes[0];
      const schemaChunks = [];
      for (const keyspace of execution.keyspaces) {
        if (!/^[A-Za-z0-9_]+$/.test(keyspace.name)) throw new CassandraScyllaPhysicalError('CASSANDRA_SCHEMA_CAPTURE_INVALID', 'Cassandra/Scylla schema capture requires a safe selected keyspace name.', { category: 'integrity' });
        const result = await seed.runtime.run(seed.config.cqlshPath, cqlArgs(seed.config, seed.authentication.cqlshrcPath, `DESCRIBE KEYSPACE ${keyspace.name};`), { stdoutLimitBytes: MAX_SCHEMA_BYTES });
        if (!result.stdout.includes(`KEYSPACE ${keyspace.name}`) && !result.stdout.includes(`KEYSPACE "${keyspace.name}"`)) throw new CassandraScyllaPhysicalError('CASSANDRA_SCHEMA_CAPTURE_INVALID', `CQL schema capture is missing selected keyspace ${keyspace.name}.`, { category: 'integrity' });
        schemaChunks.push(result.stdout.trimEnd());
      }
      const schemaBytes = Buffer.from(`${schemaChunks.join('\n\n')}\n`, 'utf8');
      if (!schemaBytes.length || schemaBytes.length > MAX_SCHEMA_BYTES) throw new CassandraScyllaPhysicalError('CASSANDRA_SCHEMA_CAPTURE_INVALID', 'CQL schema capture is empty or exceeds the supported size.', { category: 'integrity' });
      if (options.backupMode === 'incremental') return await this.#prepareIncremental(workspaceId, plan, options, prepared, schemaBytes);
      if (options.backupMode === 'native') return await this.#prepareCommitLog(workspaceId, plan, options, prepared);

      for (const node of prepared.nodes) {
        for (const table of execution.tables) {
          const tag = snapshotTag(ownerId, node.binding.hostId, table.database, table.name);
          await node.runtime.run(node.config.nodetoolPath, ['snapshot', '-t', tag, '-cf', table.name, table.database], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
          node.tags.push({ tag, keyspace: table.database, table: table.name, tableId: table.tableId });
          const leaseNodes = prepared.nodes.map((item) => ({ hostId: item.binding.hostId, connectionId: item.binding.connectionId, tags: item.tags.map((entry) => ({ ...entry })) }));
          await this.#publish(prepared, { state: 'active', nodes: leaseNodes });
        }
      }

      for (const node of prepared.nodes) {
        const dataDirectories = node.binding.dataDirectories.map(safeDataDirectory);
        for (const tag of node.tags) {
          const tableDirectory = `${tag.table}-${tag.tableId.replace(/-/g, '')}`;
          let found = false;
          for (let rootIndex = 0; rootIndex < dataDirectories.length; rootIndex += 1) {
            const snapshotDirectory = path.posix.join(dataDirectories[rootIndex], tag.keyspace, tableDirectory, 'snapshots', tag.tag);
            try {
              await node.runtime.run('test', ['-d', snapshotDirectory], { stdoutLimitBytes: 1024 });
              await node.runtime.run('test', ['-r', snapshotDirectory], { stdoutLimitBytes: 1024 });
            }
            catch { continue; }
            found = true;
            const foreign = await node.runtime.run('find', [snapshotDirectory, '-xdev', '-mindepth', '1', '-maxdepth', '1', '!', '-type', 'f', '-print0'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
            if (foreign.stdout) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_SPECIAL_FILE', 'A native snapshot contains a non-regular file or nested directory.', { category: 'integrity' });
            const listed = await node.runtime.run('find', [snapshotDirectory, '-xdev', '-mindepth', '1', '-maxdepth', '1', '-type', 'f', '-printf', '%s\0%T@\0%f\0'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
            const logicalPrefix = `nodes/${node.binding.hostId}/data-${rootIndex}/${encodeURIComponent(tag.keyspace)}/${encodeURIComponent(tag.table)}/${tag.tag}`;
            const files = parseSnapshotFileListing(listed.stdout, snapshotDirectory, logicalPrefix);
            if (node.files.length + files.length > MAX_SNAPSHOT_FILES) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_FILE_LIMIT', 'The native snapshot exceeds the file-count limit.', { category: 'capacity' });
            await validateSstableMembership(files, async (filePath) => (await node.runtime.run('cat', ['--', filePath], { stdoutLimitBytes: 1024 * 1024 })).stdout);
            for (const file of files) file.sha256 = await sha256File(node.runtime, file.sourcePath);
            node.files.push(...files.map((file) => ({ ...file, keyspace: tag.keyspace, table: tag.table, tableId: tag.tableId, tag: tag.tag, dataRootIndex: rootIndex })));
          }
          if (!found) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_DIRECTORY_MISSING', `Native snapshot ${tag.keyspace}.${tag.table} is missing beneath every approved data root on node ${node.binding.hostId}.`, { category: 'integrity' });
        }
      }

      if (incrementalRequested) for (const node of prepared.nodes) node.incrementalTables = await this.#enumerateIncrementalTables(node, execution);
      const baselineCursor = incrementalRequested ? incrementalCursor(prepared.nodes) : null;
      if (commitLogRequested) for (const node of prepared.nodes) node.commitLog = await this.#enumerateCommitLogs(node);
      const commitLogBaselineCursor = commitLogRequested ? commitLogCursor(prepared.nodes.map((node) => node.commitLog)) : null;
      const commitLogPrecisions = commitLogRequested ? new Set(prepared.nodes.map((node) => node.commitLog.precision)) : new Set();
      if (commitLogPrecisions.size > 1) throw new CassandraScyllaPhysicalError('CASSANDRA_COMMIT_LOG_PRECISION_MISMATCH', 'Every Cassandra node must use the same commit-log timestamp precision.', { category: 'integrity' });
      const membershipCapturedAt = this.clock();

      const nodeManifests = prepared.nodes.map((node) => ({
        version: 1, hostId: node.binding.hostId, connectionId: node.binding.connectionId, connectionRevision: node.connection.revision,
        serverIdentityFingerprint: node.connection.trust.fingerprint, tokenCount: node.binding.tokenCount, tokenDigest: node.binding.tokenDigest,
        tags: node.tags.map((item) => ({ ...item })),
        files: node.files.map(({ sourcePath: _sourcePath, ...file }) => file),
        fileCount: node.files.length,
        sourceBytes: node.files.reduce((total, file) => total + file.sizeBytes, 0)
      }));
      for (const manifest of nodeManifests) manifest.manifestDigest = stableDigest(manifest);
      const clusterManifest = {
        version: 1, kind: 'cassandra-scylla-native-full', adapterId: ADAPTER_ID, adapterVersion: plan.manifest.adapterVersion, engine: 'cassandra-scylla',
        backupMethod: 'physical', backupMode: 'full', selection: plan.source.selector, selectionDigest: execution.selectionFingerprint,
        consistency: { requestedLevel: 'crash', achievedLevel: 'crash', method: 'cassandra-native-snapshot', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true, proven: true },
        cluster: { product: execution.product, version: execution.productVersion, partitioner: execution.partitioner, name: execution.clusterName, clusterFingerprint: execution.clusterFingerprint, topologyFingerprint: execution.topologyFingerprint, ringFingerprint: execution.ringFingerprint, schemaVersion: execution.schemaVersion, coverageMode: execution.coverageMode, tokenCount: execution.tokenCount },
        source: { sourceId: plan.source.id, sourceRevision: plan.source.revision, jobId: options.jobId, ownerId },
        keyspaces: execution.keyspaces, tables: execution.tables, rebuildObjects: execution.rebuildObjects,
        nodes: nodeManifests,
        schema: { path: 'cassandra-scylla/schema/schema.cql', sizeBytes: schemaBytes.length, sha256: crypto.createHash('sha256').update(schemaBytes).digest('hex'), scope: 'selected-keyspaces', selectionDigest: execution.selectionFingerprint },
        chain: { parentRecoveryPointId: null, chainRootRecoveryPointId: null },
        incremental: baselineCursor ? { cursor: baselineCursor, previousCursorDigest: null, previousSetCount: 0, currentSetCount: flattenIncrementalCursor(baselineCursor, 'Baseline').setCount, newSetCount: 0, baseline: true, rolloverReason: options.baselineReason || (options.requestedBackupMode === 'incremental' ? 'initial-baseline' : null) } : null,
        commitLog: commitLogBaselineCursor ? {
          cursor: commitLogBaselineCursor,
          previousCursorDigest: null,
          previousSegmentCount: 0,
          currentSegmentCount: flattenCommitLogCursor(commitLogBaselineCursor, 'Cassandra commit-log baseline').segmentCount,
          newSegmentCount: 0,
          baseline: true,
          precision: prepared.nodes[0].commitLog.precision,
          recoveryWindow: { earliest: membershipCapturedAt, previous: null, latest: membershipCapturedAt },
          archiveSafeThrough: commitLogBaselineCursor.safeThrough,
          gaps: [],
          rolloverReason: options.baselineReason || (options.requestedBackupMode === 'native' ? 'initial-baseline' : null)
        } : null,
        snapshotWindow: { startedAt: prepared.lease.acquiredAt, membershipCapturedAt },
        cleanup: { ownership: 'exact-native-tags', state: 'pending-publication', requiredAfterPublication: true }
      };
      clusterManifest.manifestDigest = stableDigest(clusterManifest);
      const artifacts = prepared.nodes.map((node, index) => ({
        componentId: node.binding.hostId,
        artifactPath: `cassandra-scylla/nodes/${node.binding.hostId}.dxcsnapshot`,
        artifactKind: 'physical-backup',
        content: () => streamNodeArchive(node.runtime, { ...nodeManifests[index], files: node.files }, options)
      }));
      artifacts.push({ componentId: 'schema', artifactPath: clusterManifest.schema.path, artifactKind: 'schema', content: async function* schemaContent() { yield schemaBytes; } });
      artifacts.push({
        componentId: 'cluster-manifest', artifactPath: 'cassandra-scylla/cluster-manifest.json', artifactKind: 'metadata',
        content: async function* clusterManifestContent() {
          await this.seal(prepared, options);
          yield Buffer.from(JSON.stringify(prepared.databaseManifest), 'utf8');
        }.bind(this)
      });
      clusterManifest.artifacts = artifacts.map((item) => ({ componentId: item.componentId, kind: item.artifactKind, path: item.artifactPath }));
      prepared.databaseManifest = clusterManifest;
      prepared.artifacts = artifacts;
      return prepared;
    } catch (error) {
      try { await this.release(prepared, 'prepare-failed'); } catch { /* the active lease preserves unproven cleanup */ }
      if (error instanceof CassandraScyllaPhysicalError) throw error;
      throw new CassandraScyllaPhysicalError(error?.code || 'CASSANDRA_SNAPSHOT_FAILED', error?.message || 'Cassandra/Scylla native snapshot preparation failed.', { category: error?.category, retryable: error?.retryable });
    }
  }

  async seal(prepared, options = {}) {
    if (!prepared || prepared.released) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_SEAL_INVALID', 'The Cassandra/Scylla native snapshot cannot be sealed after cleanup.', { category: 'integrity' });
    if (prepared.sealed) return false;
    for (const node of prepared.nodes || []) {
      const page = await this.#discover(node.runtime, node.config, node.authentication.cqlshrcPath, options.signal);
      this.#verifyDiscovery({
        clusterFingerprint: prepared.databaseManifest.cluster.clusterFingerprint,
        topologyFingerprint: prepared.databaseManifest.cluster.topologyFingerprint,
        ringFingerprint: prepared.databaseManifest.cluster.ringFingerprint,
        schemaVersion: prepared.databaseManifest.cluster.schemaVersion,
        tables: prepared.databaseManifest.tables
      }, node.binding, node.connection, page);
      if (prepared.databaseManifest.commitLog?.cursor) {
        const currentNode = await this.#enumerateCommitLogs(node);
        const currentCursor = commitLogCursor(prepared.nodes.map((item) => item.binding.hostId === node.binding.hostId ? currentNode : item.commitLog));
        compareCommitLogCursors(prepared.databaseManifest.commitLog.cursor, currentCursor);
      }
      if (node.tags.length) {
        const listed = await node.runtime.run(node.config.nodetoolPath, ['listsnapshots'], { stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
        const activeTags = new Set(parseSnapshotNames(listed.stdout));
        if (node.tags.some((tag) => !activeTags.has(tag.tag))) throw new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_OWNERSHIP_CHANGED', `An owned native snapshot is missing on node ${node.binding.hostId} before publication.`, { category: 'integrity' });
      }
    }
    const sealedAt = this.clock();
    prepared.sealed = true;
    prepared.databaseManifest.publication = { state: 'sealed', sealedAt, postflight: { topology: 'verified', ring: 'verified', schema: 'verified', nativeTags: prepared.nodes.some((node) => node.tags.length) ? 'verified' : 'not-applicable', commitLogArchive: prepared.databaseManifest.commitLog?.cursor ? 'verified' : 'not-applicable' } };
    prepared.databaseManifest.snapshotWindow.postflightVerifiedAt = sealedAt;
    prepared.databaseManifest.manifestDigest = stableDigest({ ...prepared.databaseManifest, manifestDigest: undefined });
    await this.#publish(prepared, { postflightVerifiedAt: sealedAt });
    return true;
  }

  async release(prepared, reason = 'repository-committed') {
    if (!prepared || prepared.released) return false;
    let cleanupError = null;
    for (const node of prepared.nodes || []) {
      for (const tag of node.tags || []) {
        try { await node.runtime.run(node.config.nodetoolPath, ['clearsnapshot', '-t', tag.tag, tag.keyspace], { ignoreAbort: true, stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES }); }
        catch { cleanupError = new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_CLEANUP_UNPROVEN', `Cleanup of an owned native snapshot on node ${node.binding.hostId} could not be proven.`, { category: 'consistency' }); }
      }
      if (!cleanupError && node.tags?.length) {
        try {
          const listed = await node.runtime.run(node.config.nodetoolPath, ['listsnapshots'], { ignoreAbort: true, stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
          const remaining = new Set(parseSnapshotNames(listed.stdout));
          if (node.tags.some((tag) => remaining.has(tag.tag))) throw new Error('tag remains');
        } catch { cleanupError = new CassandraScyllaPhysicalError('CASSANDRA_SNAPSHOT_CLEANUP_UNPROVEN', `An owned native snapshot remains on node ${node.binding.hostId}.`, { category: 'consistency' }); }
      }
      try { await node.authentication?.cleanup(); } catch { cleanupError ||= new CassandraScyllaPhysicalError('CASSANDRA_CREDENTIAL_CLEANUP_FAILED', 'Temporary CQL credential cleanup could not be proven.', { category: 'integrity' }); }
      node.runtime?.close();
    }
    if (cleanupError) throw cleanupError;
    prepared.released = true;
    await this.#publish(prepared, { state: 'released', releasedAt: this.clock(), releaseReason: reason });
    return true;
  }

  async reconcile(workspaceId, run) {
    const lease = run?.sourceLease;
    const expectedOwner = `cassandra-scylla-snapshot:${workspaceId}:${run?.id}`;
    if (!lease || lease.kind !== 'cassandra-scylla-native-snapshot' || !['acquiring', 'active'].includes(lease.state)) return { applicable: false, proven: true, sourceLease: lease || null };
    if (lease.ownerId !== expectedOwner || !lease.sourceId || !Array.isArray(lease.nodes)) return { applicable: true, proven: false, sourceLease: lease };
    try {
      const source = await this.controlDatabase.repository('source').get(workspaceId, lease.sourceId);
      if (!source || source.physicalExecution?.clusterFingerprint !== lease.clusterFingerprint || source.physicalExecution?.selectionFingerprint !== lease.selectionFingerprint) return { applicable: true, proven: false, sourceLease: lease };
      for (const leaseNode of lease.nodes) {
        const binding = source.physicalExecution.nodes.find((item) => item.hostId === leaseNode.hostId && item.connectionId === leaseNode.connectionId);
        const connection = binding ? await this.controlDatabase.repository('connection').get(workspaceId, binding.connectionId) : null;
        if (!connection || connection.adapterId !== ADAPTER_ID || connection.clusterInventory?.localHostId !== binding.hostId || connection.clusterInventory?.clusterFingerprint !== lease.clusterFingerprint) return { applicable: true, proven: false, sourceLease: lease };
        const runtime = await this.runtimeFactory.open(workspaceId, connection, undefined);
        try {
          const config = normalizeConfig({ ...connection.endpoint, cqlPasswordSecretRefId: connection.secretRefIds?.[0] || null });
          for (const tag of leaseNode.tags || []) await runtime.run(config.nodetoolPath, ['clearsnapshot', '-t', requiredText(tag.tag, 'Owned snapshot tag', 80), requiredText(tag.keyspace, 'Owned snapshot keyspace', 255)], { ignoreAbort: true, stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
          const listed = await runtime.run(config.nodetoolPath, ['listsnapshots'], { ignoreAbort: true, stdoutLimitBytes: MAX_COMMAND_OUTPUT_BYTES });
          const remaining = new Set(parseSnapshotNames(listed.stdout));
          if ((leaseNode.tags || []).some((tag) => remaining.has(tag.tag))) return { applicable: true, proven: false, sourceLease: lease };
        } finally { runtime.close(); }
      }
      const releasedAt = this.clock();
      return { applicable: true, proven: true, sourceLease: { ...lease, state: 'released', releasedAt, releaseReason: 'process-interrupted', updatedAt: releasedAt } };
    } catch { return { applicable: true, proven: false, sourceLease: lease }; }
  }
}

module.exports = {
  ARCHIVE_MAGIC,
  CassandraScyllaNodeRuntimeFactory,
  CassandraScyllaPhysicalBackupService,
  CassandraScyllaPhysicalError,
  INCREMENTAL_CURSOR_VERSION,
  MAX_INCREMENTAL_CURSOR_BYTES,
  MAX_SNAPSHOT_FILES,
  compareIncrementalCursors,
  describeSstableSets,
  incrementalCursor,
  parseNetstatsActivity,
  parseSnapshotFileListing,
  safeDataDirectory,
  snapshotTag,
  streamNodeArchive,
  validateSstableMembership
};
