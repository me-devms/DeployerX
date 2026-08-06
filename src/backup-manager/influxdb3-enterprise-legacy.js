const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { once } = require('events');
const { DatabaseAdapterError } = require('./database-adapter');

const MAX_FILES = 100000;
const MAX_DIRECTORIES = 50000;
const MAX_BYTES = 64 * 1024 * 1024 * 1024 * 1024;
const CONSISTENCY_CONFIRMATIONS = Object.freeze({
  stopped: 'I CONFIRM THE ENTIRE INFLUXDB 3 ENTERPRISE CLUSTER IS STOPPED',
  'atomic-snapshot': 'I CONFIRM THE SOURCE IS AN ATOMIC CLUSTER-WIDE STORAGE SNAPSHOT',
  'ordered-live-copy': 'I ACCEPT CRASH-CONSISTENT LEGACY INFLUXDB 3 ENTERPRISE BACKUP'
});
const RESTORE_CONFIRMATION = 'RESTORE LEGACY INFLUXDB 3 ENTERPRISE TO EMPTY ALTERNATE STORAGE';
const CONSISTENCY_METHODS = Object.freeze({
  stopped: 'influxdb3-enterprise-legacy-stopped-copy',
  'atomic-snapshot': 'influxdb3-enterprise-legacy-atomic-snapshot-copy',
  'ordered-live-copy': 'influxdb3-enterprise-legacy-copy'
});
const NODE_COMPONENTS = Object.freeze(['snapshots', 'dbs', 'wal']);
const COMPACTOR_COMPONENTS = Object.freeze(['cs', 'cd', 'c']);
const CLUSTER_DIRECTORY = 'catalog';
const CLUSTER_REQUIRED_FILES = Object.freeze(['_catalog_checkpoint', 'enterprise']);
const CLUSTER_LICENSE_FILES = Object.freeze(['commercial_license', 'trial_or_home_license']);

function error(code, message, options = {}) {
  return new DatabaseAdapterError(code, message, { category: options.category || 'integrity', retryable: Boolean(options.retryable), details: options.details || {} });
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeId(value, label) {
  const id = requiredText(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || id === '.' || id === '..') throw new TypeError(`${label} is invalid.`);
  return id;
}

function normalizeDataRoot(value) {
  const input = requiredText(value, 'InfluxDB 3 Enterprise legacy data root');
  if (!path.isAbsolute(input)) throw new TypeError('InfluxDB 3 Enterprise legacy data root must be absolute.');
  const resolved = path.resolve(input);
  if (resolved === path.parse(resolved).root) throw new TypeError('InfluxDB 3 Enterprise legacy data root cannot be a filesystem root.');
  return resolved;
}

function normalizeLegacyTopology(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise legacy topology must be an object.');
  const allowed = ['dataRoot', 'clusterId', 'compactorNodeId', 'dataNodeIds'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Enterprise legacy topology field: ${unknown[0]}.`);
  if (!Array.isArray(input.dataNodeIds) || !input.dataNodeIds.length || input.dataNodeIds.length > 999) throw new TypeError('InfluxDB 3 Enterprise legacy topology requires one or more data-node IDs.');
  const compactorNodeId = normalizeId(input.compactorNodeId, 'InfluxDB 3 Enterprise compactor node ID');
  const dataNodeIds = input.dataNodeIds.map((value) => normalizeId(value, 'InfluxDB 3 Enterprise data node ID')).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (new Set(dataNodeIds).size !== dataNodeIds.length || dataNodeIds.includes(compactorNodeId)) throw new TypeError('InfluxDB 3 Enterprise legacy node IDs must be unique and keep the compactor separate from data nodes.');
  const topology = {
    dataRoot: normalizeDataRoot(input.dataRoot),
    clusterId: normalizeId(input.clusterId, 'InfluxDB 3 Enterprise cluster ID'),
    compactorNodeId,
    dataNodeIds,
    allNodeIds: [...dataNodeIds, compactorNodeId]
  };
  return Object.freeze({ ...topology, dataNodeIds: Object.freeze(dataNodeIds), allNodeIds: Object.freeze(topology.allNodeIds), topologyFingerprint: stableDigest({ clusterId: topology.clusterId, compactorNodeId, dataNodeIds }) });
}

function pathSpec(relativePath, kind, required = true) {
  return Object.freeze({ relativePath, kind, required });
}

function capturePhaseDefinitions(topology) {
  const compactor = topology.compactorNodeId;
  return Object.freeze([
    ...COMPACTOR_COMPONENTS.map((component) => Object.freeze({ phase: `compactor-${component}`, paths: Object.freeze([pathSpec(`${compactor}/${component}`, 'directory')]) })),
    ...NODE_COMPONENTS.map((component) => Object.freeze({ phase: `nodes-${component}`, paths: Object.freeze(topology.allNodeIds.map((nodeId) => pathSpec(`${nodeId}/${component}`, 'directory'))) })),
    Object.freeze({ phase: 'cluster-catalog', paths: Object.freeze([pathSpec(`${topology.clusterId}/${CLUSTER_DIRECTORY}`, 'directory')]) }),
    Object.freeze({ phase: 'cluster-checkpoint', paths: Object.freeze([pathSpec(`${topology.clusterId}/_catalog_checkpoint`, 'file')]) }),
    Object.freeze({ phase: 'cluster-enterprise', paths: Object.freeze([pathSpec(`${topology.clusterId}/enterprise`, 'file')]) }),
    Object.freeze({ phase: 'cluster-licenses', paths: Object.freeze(CLUSTER_LICENSE_FILES.map((name) => pathSpec(`${topology.clusterId}/${name}`, 'file', false))) })
  ]);
}

function restorePhaseDefinitions(topology) {
  const compactor = topology.compactorNodeId;
  return Object.freeze([
    Object.freeze({ phase: 'cluster-checkpoint', paths: Object.freeze([pathSpec(`${topology.clusterId}/_catalog_checkpoint`, 'file')]) }),
    Object.freeze({ phase: 'cluster-catalog', paths: Object.freeze([pathSpec(`${topology.clusterId}/${CLUSTER_DIRECTORY}`, 'directory')]) }),
    Object.freeze({ phase: 'cluster-enterprise', paths: Object.freeze([pathSpec(`${topology.clusterId}/enterprise`, 'file')]) }),
    Object.freeze({ phase: 'cluster-licenses', paths: Object.freeze(CLUSTER_LICENSE_FILES.map((name) => pathSpec(`${topology.clusterId}/${name}`, 'file', false))) }),
    ...NODE_COMPONENTS.map((component) => Object.freeze({ phase: `nodes-${component}`, paths: Object.freeze(topology.allNodeIds.map((nodeId) => pathSpec(`${nodeId}/${component}`, 'directory'))) })),
    ...COMPACTOR_COMPONENTS.map((component) => Object.freeze({ phase: `compactor-${component}`, paths: Object.freeze([pathSpec(`${compactor}/${component}`, 'directory')]) }))
  ]);
}

function absoluteMember(root, relativePath) {
  const value = path.resolve(root, ...relativePath.split('/'));
  if (value !== root && !value.startsWith(`${root}${path.sep}`)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_PATH_INVALID', 'InfluxDB 3 Enterprise legacy storage contains an escaping path.');
  return value;
}

function safeRelativePath(value) {
  const relative = requiredText(value, 'InfluxDB 3 Enterprise legacy media path', 8192).replace(/\\/g, '/');
  if (relative.startsWith('/') || relative.endsWith('/') || relative.includes('//') || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(relative) !== relative) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery media contains an unsafe path.');
  return relative;
}

function addCounters(counters, directories, files) {
  counters.directories += directories.length;
  counters.files += files.length;
  counters.bytes += files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (counters.directories > MAX_DIRECTORIES || counters.files > MAX_FILES || counters.bytes > MAX_BYTES) throw error('INFLUXDB3_ENTERPRISE_LEGACY_STORAGE_LIMIT', 'InfluxDB 3 Enterprise legacy storage exceeds the supported backup limits.', { category: 'capacity' });
}

async function inventoryPath(root, spec, counters) {
  const absolutePath = absoluteMember(root, spec.relativePath);
  const rootStat = await fs.lstat(absolutePath).catch((caught) => caught?.code === 'ENOENT' ? null : Promise.reject(caught));
  if (!rootStat) {
    if (!spec.required) return { present: false, directories: [], files: [] };
    throw error('INFLUXDB3_ENTERPRISE_LEGACY_LAYOUT_INVALID', `InfluxDB 3 Enterprise legacy storage is missing ${spec.relativePath}.`);
  }
  if (rootStat.isSymbolicLink() || (spec.kind === 'directory' ? !rootStat.isDirectory() : !rootStat.isFile())) throw error('INFLUXDB3_ENTERPRISE_LEGACY_LAYOUT_INVALID', `InfluxDB 3 Enterprise legacy storage has an unsafe ${spec.relativePath}.`);
  const directories = [];
  const files = [];
  if (spec.kind === 'file') {
    files.push({ relativePath: spec.relativePath, absolutePath, sizeBytes: rootStat.size, mtimeMs: rootStat.mtimeMs, ctimeMs: rootStat.ctimeMs, dev: String(rootStat.dev), ino: String(rootStat.ino) });
  } else {
    directories.push(spec.relativePath);
    const pending = [{ absolutePath, relativePath: spec.relativePath }];
    while (pending.length) {
      const current = pending.pop();
      const entries = (await fs.readdir(current.absolutePath, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, 'en-US')).reverse();
      for (const entry of entries) {
        const childRelative = path.posix.join(current.relativePath, entry.name);
        const child = absoluteMember(root, childRelative);
        const stat = await fs.lstat(child);
        if (stat.isSymbolicLink()) throw error('INFLUXDB3_ENTERPRISE_LEGACY_LINK_REFUSED', 'InfluxDB 3 Enterprise legacy backup refuses symbolic links.');
        if (stat.isDirectory()) { directories.push(childRelative); pending.push({ absolutePath: child, relativePath: childRelative }); }
        else if (stat.isFile()) files.push({ relativePath: childRelative, absolutePath: child, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: String(stat.dev), ino: String(stat.ino) });
        else throw error('INFLUXDB3_ENTERPRISE_LEGACY_SPECIAL_FILE_REFUSED', 'InfluxDB 3 Enterprise legacy backup refuses special files.');
      }
    }
  }
  directories.sort((left, right) => left.localeCompare(right, 'en-US'));
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  addCounters(counters, directories, files);
  return { present: true, directories, files };
}

async function inventoryPhase(root, definition, counters = { files: 0, directories: 0, bytes: 0 }) {
  const directories = [];
  const files = [];
  const presence = [];
  for (const spec of definition.paths) {
    const inventory = await inventoryPath(root, spec, counters);
    presence.push({ relativePath: spec.relativePath, present: inventory.present });
    directories.push(...inventory.directories);
    files.push(...inventory.files);
  }
  directories.sort((left, right) => left.localeCompare(right, 'en-US'));
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  const digest = stableDigest({ presence, directories, files: files.map(({ relativePath, sizeBytes, mtimeMs, ctimeMs, dev, ino }) => ({ relativePath, sizeBytes, mtimeMs, ctimeMs, dev, ino })) });
  return Object.freeze({ phase: definition.phase, presence: Object.freeze(presence), directories: Object.freeze(directories), files: Object.freeze(files), digest });
}

async function validateSelectedRoots(topology) {
  const clusterAllowed = new Set([CLUSTER_DIRECTORY, ...CLUSTER_REQUIRED_FILES, ...CLUSTER_LICENSE_FILES]);
  const nodeAllowed = new Set([...NODE_COMPONENTS, 'table-snapshots']);
  const compactorAllowed = new Set([...nodeAllowed, ...COMPACTOR_COMPONENTS]);
  const selected = [topology.clusterId, ...topology.allNodeIds];
  for (const id of selected) {
    const root = absoluteMember(topology.dataRoot, id);
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw error('INFLUXDB3_ENTERPRISE_LEGACY_LAYOUT_INVALID', `InfluxDB 3 Enterprise legacy root ${id} is unavailable or unsafe.`, { category: 'configuration' });
    const allowed = id === topology.clusterId ? clusterAllowed : id === topology.compactorNodeId ? compactorAllowed : nodeAllowed;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const entryStat = await fs.lstat(path.join(root, entry.name));
      if (entryStat.isSymbolicLink()) throw error('INFLUXDB3_ENTERPRISE_LEGACY_LINK_REFUSED', 'InfluxDB 3 Enterprise legacy backup refuses symbolic links.');
      if (!entryStat.isFile() && !entryStat.isDirectory()) throw error('INFLUXDB3_ENTERPRISE_LEGACY_SPECIAL_FILE_REFUSED', 'InfluxDB 3 Enterprise legacy backup refuses special files.');
      if (!allowed.has(entry.name)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_LAYOUT_UNSUPPORTED', 'InfluxDB 3 Enterprise legacy storage contains an unrecognized top-level component.', { category: 'compatibility', details: { root: id, component: entry.name } });
      if (entry.name === 'table-snapshots' && !entryStat.isDirectory()) throw error('INFLUXDB3_ENTERPRISE_LEGACY_LAYOUT_INVALID', 'InfluxDB 3 Enterprise table-snapshots must be a regular directory when present.');
    }
  }
}

async function inspectLegacyClusterLayout(input) {
  const topology = normalizeLegacyTopology(input);
  const dataRootStat = await fs.lstat(topology.dataRoot).catch(() => null);
  if (!dataRootStat || !dataRootStat.isDirectory() || dataRootStat.isSymbolicLink()) throw error('INFLUXDB3_ENTERPRISE_LEGACY_LAYOUT_INVALID', 'The InfluxDB 3 Enterprise legacy data root is unavailable or unsafe.', { category: 'configuration' });
  await validateSelectedRoots(topology);
  const rootBindings = [];
  for (const id of [topology.clusterId, ...topology.allNodeIds]) {
    const stat = await fs.lstat(absoluteMember(topology.dataRoot, id));
    rootBindings.push({ id, dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: Math.trunc(stat.birthtimeMs || 0) });
  }
  const counters = { files: 0, directories: 0, bytes: 0 };
  const phases = [];
  for (const definition of capturePhaseDefinitions(topology)) phases.push(await inventoryPhase(topology.dataRoot, definition, counters));
  const excluded = [];
  for (const nodeId of topology.allNodeIds) {
    const tableSnapshots = await fs.lstat(absoluteMember(topology.dataRoot, `${nodeId}/table-snapshots`)).catch(() => null);
    if (tableSnapshots) excluded.push(`${nodeId}/table-snapshots/`);
  }
  const storageFingerprint = stableDigest({ dataRoot: topology.dataRoot, dev: String(dataRootStat.dev), ino: String(dataRootStat.ino), birthtimeMs: Math.trunc(dataRootStat.birthtimeMs || 0), topologyFingerprint: topology.topologyFingerprint, rootBindings });
  return Object.freeze({ ...topology, storageFingerprint, fileCount: counters.files, directoryCount: counters.directories, totalBytes: counters.bytes, phases: Object.freeze(phases), excluded: Object.freeze(excluded), layoutFingerprint: stableDigest(phases.map(({ phase, digest }) => ({ phase, digest }))) });
}

function normalizeBackupExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise legacy backup execution must be an object.');
  const allowed = ['consistencyMode', 'consistencyMethod', 'confirmationText', 'operatorAttestation', 'clusterId', 'compactorNodeId', 'dataNodeIds', 'topologyFingerprint', 'storageFingerprint', 'connectionRevision'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Enterprise legacy execution field: ${unknown[0]}.`);
  const consistencyMode = String(input.consistencyMode || '').toLowerCase();
  if (!CONSISTENCY_METHODS[consistencyMode]) throw new TypeError('Choose a supported InfluxDB 3 Enterprise legacy consistency mode.');
  if (input.consistencyMethod && input.consistencyMethod !== CONSISTENCY_METHODS[consistencyMode]) throw new TypeError('InfluxDB 3 Enterprise legacy consistency method does not match its proof mode.');
  if (input.confirmationText !== CONSISTENCY_CONFIRMATIONS[consistencyMode]) throw new TypeError(`InfluxDB 3 Enterprise legacy ${consistencyMode} backup requires exact operator confirmation.`);
  if (input.operatorAttestation !== undefined && input.operatorAttestation !== consistencyMode) throw new TypeError('InfluxDB 3 Enterprise legacy operator attestation does not match its proof mode.');
  const topology = normalizeLegacyTopology({ dataRoot: path.join(path.parse(process.cwd()).root, 'deployerx-topology-placeholder'), clusterId: input.clusterId, compactorNodeId: input.compactorNodeId, dataNodeIds: input.dataNodeIds });
  const connectionRevision = Number(input.connectionRevision);
  const topologyFingerprint = requiredText(input.topologyFingerprint, 'InfluxDB 3 Enterprise topology fingerprint', 80);
  const storageFingerprint = requiredText(input.storageFingerprint, 'InfluxDB 3 Enterprise storage fingerprint', 80);
  if (!Number.isInteger(connectionRevision) || connectionRevision < 1 || ![topologyFingerprint, storageFingerprint].every((value) => /^sha256:[0-9a-f]{64}$/.test(value))) throw new TypeError('InfluxDB 3 Enterprise legacy execution identity is invalid.');
  if (topology.topologyFingerprint !== topologyFingerprint) throw new TypeError('InfluxDB 3 Enterprise legacy execution topology fingerprint is invalid.');
  return Object.freeze({ consistencyMode, consistencyMethod: CONSISTENCY_METHODS[consistencyMode], confirmationText: CONSISTENCY_CONFIRMATIONS[consistencyMode], operatorAttestation: consistencyMode, clusterId: topology.clusterId, compactorNodeId: topology.compactorNodeId, dataNodeIds: topology.dataNodeIds, topologyFingerprint, storageFingerprint, connectionRevision });
}

async function assertClusterStopped(context, topology, boundary = null) {
  if (typeof context.assertClusterStopped !== 'function') throw error('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_REQUIRED', 'InfluxDB 3 Enterprise legacy stopped-cluster execution requires an active stop proof.', { category: 'configuration' });
  const proof = await context.assertClusterStopped({ clusterId: topology.clusterId, nodeIds: [...topology.allNodeIds], signal: context.signal, ...(boundary ? { boundary } : {}) });
  if (proof !== true && proof?.stopped !== true) throw error('INFLUXDB3_ENTERPRISE_LEGACY_CLUSTER_RUNNING', 'Every InfluxDB 3 Enterprise node must be stopped before this operation.', { category: 'consistency' });
  return proof;
}

async function copyFileMember(sourceRoot, destinationRoot, expected, signal, expectedContentDigest = null) {
  const source = absoluteMember(sourceRoot, expected.relativePath);
  const destination = absoluteMember(destinationRoot, expected.relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const before = await fs.lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.sizeBytes || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs || String(before.dev) !== expected.dev || String(before.ino) !== expected.ino) throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy storage changed before a member was copied.', { category: 'consistency', retryable: true });
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const output = fsSync.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  try {
    for await (const raw of fsSync.createReadStream(source, { highWaterMark: 1024 * 1024, signal })) {
      if (signal?.aborted) throw error('INFLUXDB3_ENTERPRISE_LEGACY_CANCELED', 'The InfluxDB 3 Enterprise legacy operation was canceled.', { category: 'canceled' });
      const chunk = Buffer.from(raw);
      sizeBytes += chunk.length;
      hash.update(chunk);
      if (sizeBytes > expected.sizeBytes) throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy storage changed while a member was copied.', { category: 'consistency', retryable: true });
      if (!output.write(chunk)) await once(output, 'drain');
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
  } catch (caught) {
    output.destroy();
    await fs.rm(destination, { force: true }).catch(() => {});
    throw caught;
  }
  const after = await fs.lstat(source);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || sizeBytes !== before.size) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy storage changed while a member was copied.', { category: 'consistency', retryable: true });
  }
  const contentDigest = `sha256:${hash.digest('hex')}`;
  if (expectedContentDigest && contentDigest !== expectedContentDigest) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy recovery media changed before it could be restored.', { category: 'consistency' });
  }
  return Object.freeze({ relativePath: expected.relativePath, sizeBytes, contentDigest });
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function createPhaseDirectories(destination, directories) {
  for (const relativePath of directories) await fs.mkdir(absoluteMember(destination, relativePath), { recursive: true, mode: 0o700 });
}

function phaseByName(layout, name) {
  return layout.phases.find((phase) => phase.phase === name);
}

function topologyFields(topology) {
  return { dataRoot: topology.dataRoot, clusterId: topology.clusterId, compactorNodeId: topology.compactorNodeId, dataNodeIds: topology.dataNodeIds };
}

async function captureLegacyFilesystem(context = {}, topologyInput, executionInput, destinationInput) {
  const topology = normalizeLegacyTopology(topologyInput);
  const execution = normalizeBackupExecution(executionInput);
  const destination = path.resolve(requiredText(destinationInput, 'InfluxDB 3 Enterprise legacy staging destination'));
  if (pathsOverlap(topology.dataRoot, destination) || pathsOverlap(destination, topology.dataRoot)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_DESTINATION_INVALID', 'InfluxDB 3 Enterprise legacy staging must be outside the protected data root.', { category: 'configuration' });
  if (await fs.lstat(destination).catch(() => null)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_DESTINATION_EXISTS', 'InfluxDB 3 Enterprise legacy staging destination already exists.', { category: 'conflict' });
  const before = await inspectLegacyClusterLayout(topologyFields(topology));
  if (execution.clusterId !== topology.clusterId || execution.compactorNodeId !== topology.compactorNodeId || execution.topologyFingerprint !== topology.topologyFingerprint || execution.storageFingerprint !== before.storageFingerprint || stableDigest(execution.dataNodeIds) !== stableDigest(topology.dataNodeIds)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_IDENTITY_CHANGED', 'InfluxDB 3 Enterprise legacy topology or storage identity changed before backup.', { category: 'integrity' });
  if (execution.consistencyMode === 'stopped') await assertClusterStopped(context, topology);
  const files = [];
  const drift = new Set();
  try {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    for (const definition of capturePhaseDefinitions(topology)) {
      const expected = phaseByName(before, definition.phase);
      await context.onProgress?.({ phase: 'capturing', component: definition.phase, copyOrder: capturePhaseDefinitions(topology).map((item) => item.phase) });
      await createPhaseDirectories(destination, expected.directories);
      for (const member of expected.files) files.push(await copyFileMember(topology.dataRoot, destination, member, context.signal));
      const current = await inventoryPhase(topology.dataRoot, definition);
      if (current.digest !== expected.digest) drift.add(definition.phase);
      if (drift.size && execution.consistencyMode !== 'ordered-live-copy') throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy storage changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
      if (execution.consistencyMode === 'stopped') await assertClusterStopped(context, topology);
    }
    const after = await inspectLegacyClusterLayout(topologyFields(topology));
    for (const phase of before.phases) if (phaseByName(after, phase.phase)?.digest !== phase.digest) drift.add(phase.phase);
    if (drift.size && execution.consistencyMode !== 'ordered-live-copy') throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy storage changed during an application-consistent capture.', { category: 'consistency', retryable: true, details: { driftPhases: [...drift] } });
    const members = files.map(({ relativePath, sizeBytes, contentDigest }) => ({ relativePath, sizeBytes, contentDigest })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    const directories = before.phases.flatMap((phase) => phase.directories).sort((left, right) => left.localeCompare(right, 'en-US'));
    return Object.freeze({
      product: 'influxdb3-enterprise', engine: 'legacy-parquet', objectStore: 'file', directory: destination,
      clusterId: topology.clusterId, compactorNodeId: topology.compactorNodeId, dataNodeIds: topology.dataNodeIds,
      topologyFingerprint: topology.topologyFingerprint, sourceStorageFingerprint: before.storageFingerprint,
      consistency: execution.consistencyMode === 'ordered-live-copy' ? 'crash' : 'application', consistencyMode: execution.consistencyMode,
      copyOrder: Object.freeze(capturePhaseDefinitions(topology).map((item) => item.phase)), restoreOrder: Object.freeze(restorePhaseDefinitions(topology).map((item) => item.phase)),
      excluded: before.excluded, driftPhases: Object.freeze([...drift].sort((left, right) => before.phases.findIndex((phase) => phase.phase === left) - before.phases.findIndex((phase) => phase.phase === right))),
      members: Object.freeze(members), directories: Object.freeze(directories), fileCount: members.length, directoryCount: directories.length,
      totalBytes: members.reduce((sum, member) => sum + member.sizeBytes, 0), mediaFingerprint: stableDigest(members), directoryFingerprint: stableDigest(directories),
      recoveryPoint: 'latest-included-snapshot', originalStoreClearingSupported: false, manualStartupRequired: true, licenseReviewRequired: true
    });
  } catch (caught) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw caught instanceof DatabaseAdapterError ? caught : error('INFLUXDB3_ENTERPRISE_LEGACY_CAPTURE_FAILED', 'DeployerX could not capture the InfluxDB 3 Enterprise legacy cluster.', { category: caught?.category || 'execution', retryable: Boolean(caught?.retryable) });
  }
}

function mediaPathAllowed(relativePath, topology) {
  const [root, component] = relativePath.split('/');
  if (root === topology.clusterId) return component === CLUSTER_DIRECTORY || CLUSTER_REQUIRED_FILES.includes(component) || CLUSTER_LICENSE_FILES.includes(component);
  if (!topology.allNodeIds.includes(root)) return false;
  if (NODE_COMPONENTS.includes(component)) return true;
  return root === topology.compactorNodeId && COMPACTOR_COMPONENTS.includes(component);
}

function normalizeLegacyMedia(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.product !== 'influxdb3-enterprise' || input.engine !== 'legacy-parquet' || input.objectStore !== 'file') throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'Authenticated InfluxDB 3 Enterprise legacy recovery evidence is invalid.');
  const topology = normalizeLegacyTopology({ dataRoot: path.join(path.parse(process.cwd()).root, 'deployerx-media-placeholder'), clusterId: input.clusterId, compactorNodeId: input.compactorNodeId, dataNodeIds: input.dataNodeIds });
  if (input.topologyFingerprint !== topology.topologyFingerprint) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery topology evidence is invalid.');
  const members = Array.isArray(input.members) ? input.members.map((raw) => {
    const relativePath = safeRelativePath(raw.relativePath);
    const sizeBytes = Number(raw.sizeBytes);
    const contentDigest = requiredText(raw.contentDigest, 'InfluxDB 3 Enterprise legacy member digest', 80);
    if (!mediaPathAllowed(relativePath, topology) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^sha256:[0-9a-f]{64}$/.test(contentDigest)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery member evidence is invalid.');
    return Object.freeze({ relativePath, sizeBytes, contentDigest });
  }) : [];
  const directories = Array.isArray(input.directories) ? input.directories.map((value) => safeRelativePath(value)) : [];
  if (!members.length || members.length > MAX_FILES || new Set(members.map((item) => item.relativePath)).size !== members.length || directories.length > MAX_DIRECTORIES || new Set(directories).size !== directories.length || directories.some((item) => !mediaPathAllowed(item, topology))) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery media inventory is incomplete, duplicated, or unsupported.');
  const requiredDirectories = capturePhaseDefinitions(topology).flatMap((phase) => phase.paths.filter((spec) => spec.kind === 'directory' && spec.required).map((spec) => spec.relativePath));
  const requiredFiles = capturePhaseDefinitions(topology).flatMap((phase) => phase.paths.filter((spec) => spec.kind === 'file' && spec.required).map((spec) => spec.relativePath));
  if (requiredDirectories.some((item) => !directories.includes(item)) || requiredFiles.some((item) => !members.some((member) => member.relativePath === item))) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery media is missing required cluster or node state.');
  members.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  directories.sort((left, right) => left.localeCompare(right, 'en-US'));
  const fileCount = Number(input.fileCount); const directoryCount = Number(input.directoryCount); const totalBytes = Number(input.totalBytes);
  if (fileCount !== members.length || directoryCount !== directories.length || totalBytes !== members.reduce((sum, member) => sum + member.sizeBytes, 0) || totalBytes > MAX_BYTES || input.mediaFingerprint !== stableDigest(members) || input.directoryFingerprint !== stableDigest(directories)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy aggregate recovery evidence is invalid.');
  return Object.freeze({ ...topology, members: Object.freeze(members), directories: Object.freeze(directories), fileCount, directoryCount, totalBytes, mediaFingerprint: input.mediaFingerprint, directoryFingerprint: input.directoryFingerprint, consistency: ['application', 'crash'].includes(input.consistency) ? input.consistency : 'unknown' });
}

async function authenticateLegacyFilesystem(rootInput, mediaInput) {
  const root = normalizeDataRoot(rootInput);
  const media = normalizeLegacyMedia(mediaInput);
  const layout = await inspectLegacyClusterLayout({ dataRoot: root, clusterId: media.clusterId, compactorNodeId: media.compactorNodeId, dataNodeIds: media.dataNodeIds });
  const directories = layout.phases.flatMap((phase) => phase.directories).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (directories.length !== media.directoryCount || stableDigest(directories) !== media.directoryFingerprint) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery directories failed authentication.');
  const expected = new Map(media.members.map((member) => [member.relativePath, member]));
  const files = [];
  for (const file of layout.phases.flatMap((phase) => phase.files).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'))) {
    const member = expected.get(file.relativePath);
    if (!member || member.sizeBytes !== file.sizeBytes) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery inventory failed authentication.');
    const hash = crypto.createHash('sha256'); let sizeBytes = 0;
    for await (const chunk of fsSync.createReadStream(file.absolutePath, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); sizeBytes += chunk.length; }
    const contentDigest = `sha256:${hash.digest('hex')}`;
    if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'An InfluxDB 3 Enterprise legacy recovery member failed content authentication.');
    files.push({ relativePath: file.relativePath, sizeBytes, contentDigest });
  }
  if (files.length !== media.fileCount || stableDigest(files) !== media.mediaFingerprint) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'The complete InfluxDB 3 Enterprise legacy recovery media set failed authentication.');
  return Object.freeze({ media, layout, files: Object.freeze(files), directories: Object.freeze(directories) });
}

async function authenticateRestorePhase(sourceRoot, phase, mediaMembers) {
  for (const file of phase.files) {
    const member = mediaMembers.get(file.relativePath);
    const before = await fs.lstat(file.absolutePath).catch(() => null);
    if (!member || !before || !before.isFile() || before.isSymbolicLink() || before.size !== file.sizeBytes || before.mtimeMs !== file.mtimeMs || before.ctimeMs !== file.ctimeMs || String(before.dev) !== file.dev || String(before.ino) !== file.ino) throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy recovery media changed after authentication.', { category: 'consistency' });
    const hash = crypto.createHash('sha256'); let sizeBytes = 0;
    for await (const chunk of fsSync.createReadStream(absoluteMember(sourceRoot, file.relativePath), { highWaterMark: 1024 * 1024 })) { hash.update(chunk); sizeBytes += chunk.length; }
    const after = await fs.lstat(file.absolutePath).catch(() => null);
    const contentDigest = `sha256:${hash.digest('hex')}`;
    if (!after || !after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw error('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_CHANGED', 'InfluxDB 3 Enterprise legacy recovery media changed after authentication.', { category: 'consistency' });
  }
}

async function restoreLegacyFilesystem(context = {}, sourceRootInput, mediaInput, targetInput = {}) {
  const sourceRoot = normalizeDataRoot(sourceRootInput);
  const media = normalizeLegacyMedia(mediaInput);
  const target = normalizeLegacyTopology({ dataRoot: targetInput.dataRoot, clusterId: targetInput.clusterId, compactorNodeId: targetInput.compactorNodeId, dataNodeIds: targetInput.dataNodeIds });
  if (target.topologyFingerprint !== media.topologyFingerprint) throw error('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_INVALID', 'The alternate InfluxDB 3 Enterprise topology must preserve the protected cluster and node IDs.', { category: 'compatibility' });
  if (targetInput.confirmationText !== RESTORE_CONFIRMATION) throw new TypeError('InfluxDB 3 Enterprise legacy restore requires exact destructive-operation confirmation.');
  if (pathsOverlap(sourceRoot, target.dataRoot) || pathsOverlap(target.dataRoot, sourceRoot)) throw error('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_INVALID', 'InfluxDB 3 Enterprise legacy restore source and target storage must be separate.', { category: 'configuration' });
  const targetStat = await fs.lstat(target.dataRoot).catch(() => null);
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) throw error('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_INVALID', 'The alternate InfluxDB 3 Enterprise data root is unavailable or unsafe.', { category: 'configuration' });
  if ((await fs.readdir(target.dataRoot)).length) throw error('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_NOT_EMPTY', 'The alternate InfluxDB 3 Enterprise data root must be completely empty before restore.', { category: 'conflict' });
  const authenticated = await authenticateLegacyFilesystem(sourceRoot, mediaInput);
  const mediaMembers = new Map(authenticated.media.members.map((member) => [member.relativePath, member]));
  await assertClusterStopped(context, target, 'before-restore');
  let mutated = false;
  try {
    for (const definition of restorePhaseDefinitions(target)) {
      const phase = phaseByName(authenticated.layout, definition.phase);
      if (!phase) throw error('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy recovery media is missing a restore phase.');
      await context.onProgress?.({ phase: 'restoring', component: definition.phase, restoreOrder: restorePhaseDefinitions(target).map((item) => item.phase) });
      await authenticateRestorePhase(sourceRoot, phase, mediaMembers);
      await assertClusterStopped(context, target, `before-${definition.phase}`);
      if (phase.directories.length || phase.files.length) mutated = true;
      await createPhaseDirectories(target.dataRoot, phase.directories);
      for (const file of phase.files) await copyFileMember(sourceRoot, target.dataRoot, file, context.signal, mediaMembers.get(file.relativePath)?.contentDigest);
      await assertClusterStopped(context, target, `after-${definition.phase}`);
    }
    const installed = await authenticateLegacyFilesystem(target.dataRoot, mediaInput);
    return Object.freeze({
      product: 'influxdb3-enterprise', engine: 'legacy-parquet', targetDataRoot: target.dataRoot,
      clusterId: target.clusterId, nodeIds: target.allNodeIds, fileCount: installed.media.fileCount, directoryCount: installed.media.directoryCount,
      totalBytes: installed.media.totalBytes, mediaFingerprint: installed.media.mediaFingerprint, restoreOrder: Object.freeze(restorePhaseDefinitions(target).map((item) => item.phase)),
      originalStoreCleared: false, partialStatePreservedOnFailure: true, ownershipReviewRequired: true, licenseReviewRequired: true, manualStartupRequired: true
    });
  } catch (caught) {
    if (mutated) caught.details = { partialStatePreserved: true };
    throw caught;
  }
}

module.exports = {
  CLUSTER_LICENSE_FILES,
  COMPACTOR_COMPONENTS,
  CONSISTENCY_CONFIRMATIONS,
  CONSISTENCY_METHODS,
  MAX_BYTES,
  MAX_DIRECTORIES,
  MAX_FILES,
  NODE_COMPONENTS,
  RESTORE_CONFIRMATION,
  authenticateLegacyFilesystem,
  captureLegacyFilesystem,
  capturePhaseDefinitions,
  inspectLegacyClusterLayout,
  normalizeBackupExecution,
  normalizeLegacyMedia,
  normalizeLegacyTopology,
  restoreLegacyFilesystem,
  restorePhaseDefinitions
};
