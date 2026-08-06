const crypto = require('crypto');
const path = require('path');

const COMMIT_LOG_CURSOR_VERSION = 1;
const MAX_COMMIT_LOG_CURSOR_BYTES = 24 * 1024 * 1024;
const MAX_COMMIT_LOG_SEGMENTS = 100000;
const COMMIT_LOG_PATTERN = /^CommitLog-([1-9][0-9]*)-([1-9][0-9]*)[.]log$/;
const PRECISIONS = new Map([
  ['SECONDS', 0],
  ['MILLISECONDS', 3],
  ['MICROSECONDS', 6]
]);

class CassandraCommitLogError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CassandraCommitLogError';
    this.code = code;
    this.category = options.category || 'commit-log';
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

function textDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(requiredText(value, 'Commit-log evidence', 16384)).digest('hex')}`;
}

function safeAbsolutePosixPath(value, label) {
  const candidate = requiredText(value, label, 4096);
  const normalized = path.posix.normalize(candidate);
  if (!candidate.startsWith('/') || normalized !== candidate.replace(/\/$/, '') || normalized === '/' || normalized.includes('//') || normalized.split('/').includes('..')) throw new TypeError(`${label} must be a normalized absolute Linux path below the filesystem root.`);
  return normalized;
}

function normalizeCommitLogArchiveEnrollment(input, label = 'Cassandra commit-log archive') {
  if (input === undefined || input === null || input === false) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} settings are invalid.`);
  const unknown = Object.keys(input).filter((key) => !['directory', 'propertiesPath', 'archiveCommand', 'ownershipMarker', 'precision', 'maximumClockSkewSeconds'].includes(key));
  if (unknown.length) throw new TypeError(`${label} contains an unknown field: ${unknown[0]}.`);
  const directory = safeAbsolutePosixPath(input.directory, `${label} directory`);
  const propertiesPath = safeAbsolutePosixPath(input.propertiesPath || '/etc/cassandra/commitlog_archiving.properties', `${label} properties path`);
  const archiveCommand = requiredText(input.archiveCommand, `${label} archive command`, 16384);
  if (!archiveCommand.includes('%path') || !archiveCommand.includes('%name') || /[\r\n]/.test(archiveCommand)) throw new TypeError(`${label} archive command must contain the Cassandra %path and %name placeholders on one line.`);
  const ownershipMarker = requiredText(input.ownershipMarker, `${label} ownership marker`, 512);
  if (!/^[A-Za-z0-9._:@+-]+$/.test(ownershipMarker)) throw new TypeError(`${label} ownership marker contains unsupported characters.`);
  const precision = String(input.precision || 'MICROSECONDS').toUpperCase();
  if (!PRECISIONS.has(precision)) throw new TypeError(`${label} precision must be SECONDS, MILLISECONDS, or MICROSECONDS.`);
  const maximumClockSkewSeconds = Number(input.maximumClockSkewSeconds ?? 5);
  if (!Number.isInteger(maximumClockSkewSeconds) || maximumClockSkewSeconds < 0 || maximumClockSkewSeconds > 60) throw new TypeError(`${label} maximum clock skew must be between 0 and 60 seconds.`);
  return Object.freeze({
    version: 1,
    directory,
    propertiesPath,
    archiveCommandDigest: textDigest(archiveCommand),
    ownershipMarkerDigest: textDigest(ownershipMarker),
    precision,
    maximumClockSkewSeconds
  });
}

function parseJavaProperties(value) {
  const logical = [];
  let current = '';
  for (const raw of String(value || '').split(/\r?\n/)) {
    current += raw;
    let slashes = 0;
    for (let index = current.length - 1; index >= 0 && current[index] === '\\'; index -= 1) slashes += 1;
    if (slashes % 2 === 1) { current = current.slice(0, -1); continue; }
    logical.push(current); current = '';
  }
  if (current) logical.push(current);
  const properties = {};
  for (const raw of logical) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    let split = -1;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index];
      if (!escaped && (character === '=' || character === ':' || /\s/.test(character))) { split = index; break; }
      escaped = !escaped && character === '\\';
      if (character !== '\\') escaped = false;
    }
    const key = (split < 0 ? raw : raw.slice(0, split)).trim().replace(/\\([ :=\\])/g, '$1');
    let remainder = split < 0 ? '' : raw.slice(split);
    remainder = remainder.replace(/^\s*[:=]?\s*/, '').replace(/\\([ :=\\])/g, '$1').trim();
    if (key && !Object.hasOwn(properties, key)) properties[key] = remainder;
  }
  return properties;
}

function validateCommitLogArchiveProperties(value, enrollment) {
  if (!enrollment) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_NOT_ENROLLED', 'Cassandra commit-log archive settings are not enrolled.', { category: 'validation' });
  const properties = parseJavaProperties(value);
  const archiveCommand = requiredText(properties.archive_command, 'Cassandra archive_command', 16384);
  if (!archiveCommand.includes('%path') || !archiveCommand.includes('%name') || textDigest(archiveCommand) !== enrollment.archiveCommandDigest) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_COMMAND_CHANGED', 'The Cassandra archive command does not match the operator-approved Source enrollment.', { category: 'integrity' });
  if (String(properties.restore_command || '').trim() || String(properties.restore_directories || '').trim() || String(properties.restore_point_in_time || '').trim()) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_SOURCE_RESTORE_ACTIVE', 'The protected Cassandra node has active commit-log restore settings.', { category: 'conflict' });
  const precision = String(properties.precision || 'MICROSECONDS').trim().toUpperCase();
  if (precision !== enrollment.precision) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_PRECISION_CHANGED', 'The Cassandra commit-log timestamp precision changed after Source enrollment.', { category: 'integrity' });
  return { archiveCommandDigest: enrollment.archiveCommandDigest, propertiesDigest: textDigest(value), precision };
}

function normalizeSegment(file) {
  const name = requiredText(file?.name, 'Cassandra commit-log segment name', 512);
  const match = COMMIT_LOG_PATTERN.exec(name);
  if (!match) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_FILE_INVALID', 'The Cassandra archive directory contains an unexpected file.', { category: 'integrity' });
  const sizeBytes = Number(file.sizeBytes);
  const modifiedAt = requiredText(file.modifiedAt, 'Cassandra commit-log segment timestamp', 100);
  const sha256 = requiredText(file.sha256, 'Cassandra commit-log segment checksum', 64);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !Number.isFinite(Date.parse(modifiedAt)) || !/^[0-9a-f]{64}$/.test(sha256)) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_FILE_INVALID', 'A Cassandra commit-log segment has invalid immutable evidence.', { category: 'integrity' });
  return { version: match[1], segmentId: match[2], name, sizeBytes, modifiedAt: new Date(Date.parse(modifiedAt)).toISOString(), sha256 };
}

function compareNumericText(left, right) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

function normalizeSegments(files) {
  if (!Array.isArray(files) || files.length > MAX_COMMIT_LOG_SEGMENTS) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_FILE_LIMIT', 'The Cassandra commit-log archive exceeds the supported segment limit.', { category: 'capacity' });
  const segments = files.map(normalizeSegment).sort((left, right) => compareNumericText(left.version, right.version) || compareNumericText(left.segmentId, right.segmentId));
  if (new Set(segments.map((segment) => segment.name)).size !== segments.length) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_DUPLICATE', 'The Cassandra commit-log archive contains duplicate segment names.', { category: 'integrity' });
  if (new Set(segments.map((segment) => segment.version)).size > 1) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_FORMAT_CHANGED', 'The Cassandra commit-log archive contains multiple segment formats and requires a new full baseline.', { category: 'compatibility' });
  for (let index = 1; index < segments.length; index += 1) {
    if (compareNumericText(segments[index - 1].segmentId, segments[index].segmentId) >= 0 || Date.parse(segments[index - 1].modifiedAt) > Date.parse(segments[index].modifiedAt)) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_ORDER_INVALID', 'Cassandra commit-log segment ordering or archive timestamps are invalid.', { category: 'integrity' });
  }
  return segments;
}

function conservativeNodeSafeThrough(node) {
  const last = node.segments.at(-1);
  if (!last) return null;
  return new Date(Date.parse(last.modifiedAt) - Math.max(0, Number(node.clockOffsetMilliseconds) || 0)).toISOString();
}

function commitLogCursor(nodes) {
  const cursor = {
    version: COMMIT_LOG_CURSOR_VERSION,
    nodes: nodes.map((node) => ({
      hostId: requiredText(node.hostId, 'Cassandra commit-log cursor host ID', 100),
      archiveDirectoryDigest: requiredText(node.archiveDirectoryDigest, 'Cassandra archive directory digest', 80),
      propertiesDigest: requiredText(node.propertiesDigest, 'Cassandra archive properties digest', 80),
      archiveCommandDigest: requiredText(node.archiveCommandDigest, 'Cassandra archive command digest', 80),
      ownershipMarkerDigest: requiredText(node.ownershipMarkerDigest, 'Cassandra archive ownership digest', 80),
      precision: requiredText(node.precision, 'Cassandra commit-log precision', 20),
      clockObservedAt: requiredText(node.clockObservedAt, 'Cassandra node clock observation', 100),
      clockOffsetMilliseconds: Number(node.clockOffsetMilliseconds),
      clockSkewMilliseconds: Number(node.clockSkewMilliseconds),
      segments: normalizeSegments(node.segments)
    })).sort((left, right) => left.hostId.localeCompare(right.hostId, 'en-US'))
  };
  if (new Set(cursor.nodes.map((node) => node.hostId)).size !== cursor.nodes.length || cursor.nodes.some((node) => !Number.isFinite(Date.parse(node.clockObservedAt)) || !Number.isFinite(node.clockOffsetMilliseconds) || !Number.isFinite(node.clockSkewMilliseconds) || node.clockSkewMilliseconds < 0 || node.clockSkewMilliseconds !== Math.abs(node.clockOffsetMilliseconds) || node.segments.some((segment) => Date.parse(segment.modifiedAt) > Date.parse(node.clockObservedAt)))) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_INVALID', 'The Cassandra commit-log cursor contains invalid node clock evidence.', { category: 'integrity' });
  cursor.safeThrough = cursor.nodes.length && cursor.nodes.every((node) => node.segments.length)
    ? cursor.nodes.map(conservativeNodeSafeThrough).sort()[0]
    : null;
  cursor.digest = evidenceDigest(cursor);
  if (Buffer.byteLength(canonicalJson(cursor), 'utf8') > MAX_COMMIT_LOG_CURSOR_BYTES) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_LIMIT', 'The Cassandra commit-log cursor exceeds the supported authenticated metadata limit.', { category: 'capacity' });
  return cursor;
}

function flattenCommitLogCursor(cursor, label = 'Commit-log') {
  if (!cursor || cursor.version !== COMMIT_LOG_CURSOR_VERSION || !Array.isArray(cursor.nodes) || cursor.digest !== evidenceDigest({ ...cursor, digest: undefined })) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_INVALID', `${label} cursor authentication failed.`, { category: 'integrity' });
  const nodes = new Map();
  const segments = new Map();
  let segmentCount = 0;
  for (const node of cursor.nodes) {
    const hostId = requiredText(node?.hostId, `${label} host ID`, 100);
    const digestsValid = ['archiveDirectoryDigest', 'propertiesDigest', 'archiveCommandDigest', 'ownershipMarkerDigest'].every((field) => /^sha256:[0-9a-f]{64}$/.test(String(node?.[field] || '')));
    if (nodes.has(hostId) || !digestsValid || !PRECISIONS.has(node?.precision) || !Array.isArray(node?.segments) || !Number.isFinite(Date.parse(node?.clockObservedAt)) || !Number.isFinite(node?.clockOffsetMilliseconds) || !Number.isFinite(node?.clockSkewMilliseconds) || node.clockSkewMilliseconds !== Math.abs(node.clockOffsetMilliseconds)) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_INVALID', `${label} cursor node evidence is invalid.`, { category: 'integrity' });
    const normalized = normalizeSegments(node.segments);
    if (normalized.some((segment) => Date.parse(segment.modifiedAt) > Date.parse(node.clockObservedAt))) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_INVALID', `${label} cursor contains a segment timestamp later than its observed node clock.`, { category: 'integrity' });
    const stableNode = { ...node, segments: normalized };
    nodes.set(hostId, stableNode);
    for (const segment of normalized) {
      const key = `${hostId}\0${segment.name}`;
      if (segments.has(key)) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_INVALID', `${label} cursor contains duplicate segment evidence.`, { category: 'integrity' });
      segments.set(key, segment);
      segmentCount += 1;
      if (segmentCount > MAX_COMMIT_LOG_SEGMENTS) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_LIMIT', `${label} cursor exceeds the supported segment limit.`, { category: 'capacity' });
    }
  }
  const calculatedSafeThrough = nodes.size && [...nodes.values()].every((node) => node.segments.length)
    ? [...nodes.values()].map(conservativeNodeSafeThrough).sort()[0]
    : null;
  if ((cursor.safeThrough || null) !== calculatedSafeThrough) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CURSOR_INVALID', `${label} cursor recovery watermark is invalid.`, { category: 'integrity' });
  return { nodes, segments, segmentCount, safeThrough: calculatedSafeThrough };
}

function compareCommitLogCursors(previousCursor, currentCursor) {
  const previous = flattenCommitLogCursor(previousCursor, 'Previous commit-log');
  const current = flattenCommitLogCursor(currentCursor, 'Current commit-log');
  if (previous.nodes.size !== current.nodes.size || [...previous.nodes.keys()].some((hostId) => !current.nodes.has(hostId))) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_SCOPE_CHANGED', 'The Cassandra commit-log node scope changed and requires a new full baseline.', { category: 'integrity' });
  for (const [hostId, oldNode] of previous.nodes) {
    const newNode = current.nodes.get(hostId);
    for (const field of ['archiveDirectoryDigest', 'propertiesDigest', 'archiveCommandDigest', 'ownershipMarkerDigest', 'precision']) {
      if (oldNode[field] !== newNode[field]) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_CONFIGURATION_CHANGED', 'Cassandra commit-log archive configuration changed and requires a new full baseline.', { category: 'integrity' });
    }
  }
  for (const [key, oldSegment] of previous.segments) {
    const currentSegment = current.segments.get(key);
    if (!currentSegment) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_GAP', 'A previously recorded Cassandra commit-log segment is missing.', { category: 'integrity' });
    if (evidenceDigest(currentSegment) !== evidenceDigest(oldSegment)) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_REWRITTEN', 'A previously recorded Cassandra commit-log segment changed.', { category: 'integrity' });
  }
  const added = new Set();
  for (const [hostId, currentNode] of current.nodes) {
    const previousNode = previous.nodes.get(hostId);
    const previousLast = previousNode.segments.at(-1);
    for (const segment of currentNode.segments) {
      const key = `${hostId}\0${segment.name}`;
      if (previous.segments.has(key)) continue;
      if (previousLast && (segment.version !== previousLast.version || compareNumericText(segment.segmentId, previousLast.segmentId) <= 0 || Date.parse(segment.modifiedAt) < Date.parse(previousLast.modifiedAt))) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_GAP', 'A Cassandra commit-log segment appeared behind the authenticated archive cursor.', { category: 'integrity' });
      added.add(key);
    }
  }
  if (previous.safeThrough && current.safeThrough && Date.parse(current.safeThrough) < Date.parse(previous.safeThrough)) throw new CassandraCommitLogError('CASSANDRA_COMMIT_LOG_TIME_REGRESSED', 'The Cassandra commit-log recovery watermark moved backward.', { category: 'integrity' });
  return { added, previousSegmentCount: previous.segmentCount, currentSegmentCount: current.segmentCount, previousSafeThrough: previous.safeThrough, currentSafeThrough: current.safeThrough };
}

function normalizeRecoveryTarget(value, precision) {
  const digits = PRECISIONS.get(precision);
  if (digits === undefined) throw new CassandraCommitLogError('CASSANDRA_PITR_PRECISION_INVALID', 'The Cassandra recovery precision is unsupported.', { category: 'compatibility' });
  const pattern = digits === 0
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/
    : new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})[.](\\d{${digits}})Z$`);
  const target = requiredText(value, 'Cassandra UTC recovery target', 100);
  const match = pattern.exec(target);
  if (!match || !Number.isFinite(Date.parse(target))) throw new CassandraCommitLogError('CASSANDRA_PITR_TARGET_INVALID', `The Cassandra recovery target must be exact UTC ${precision.toLowerCase()} precision.`, { category: 'validation' });
  const fraction = digits ? `.${match[7]}` : '';
  return { iso: target, propertyValue: `${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6]}${fraction}` };
}

function planCassandraCommitLogRestore(input = {}) {
  if (!Array.isArray(input.chain) || input.chain.length < 2 || input.chain.length > 10000) throw new CassandraCommitLogError('CASSANDRA_PITR_CHAIN_INVALID', 'Cassandra PITR requires one full anchor and at least one commit-log point.', { category: 'validation' });
  const records = input.chain.map((record) => ({ recoveryPointId: requiredText(record?.recoveryPointId, 'RecoveryPoint ID', 200), manifest: record?.manifest }));
  const root = records[0];
  if (root.manifest?.kind !== 'cassandra-scylla-native-full' || root.manifest?.cluster?.product !== 'cassandra' || !root.manifest?.commitLog?.baseline || !root.manifest.commitLog.cursor) throw new CassandraCommitLogError('CASSANDRA_PITR_ANCHOR_INVALID', 'The Cassandra PITR chain does not start with an authenticated commit-log-enabled full anchor.', { category: 'integrity' });
  flattenCommitLogCursor(root.manifest.commitLog.cursor, 'Cassandra PITR anchor');
  const precision = root.manifest.commitLog.precision;
  const target = normalizeRecoveryTarget(input.targetUtc, precision);
  const anchorTime = root.manifest.commitLog.recoveryWindow?.earliest;
  if (!anchorTime || Date.parse(target.iso) < Date.parse(anchorTime)) throw new CassandraCommitLogError('CASSANDRA_PITR_TARGET_BEFORE_ANCHOR', 'The Cassandra recovery target is earlier than the full anchor.', { category: 'validation' });
  let previous = root;
  let terminal = null;
  const selected = [root];
  for (const record of records.slice(1)) {
    const manifest = record.manifest;
    if (manifest?.kind !== 'cassandra-commit-log' || manifest.cluster?.product !== 'cassandra' || manifest.source?.sourceId !== root.manifest.source?.sourceId || manifest.source?.jobId !== root.manifest.source?.jobId || manifest.selectionDigest !== root.manifest.selectionDigest || manifest.cluster?.clusterFingerprint !== root.manifest.cluster?.clusterFingerprint || manifest.cluster?.topologyFingerprint !== root.manifest.cluster?.topologyFingerprint || manifest.cluster?.ringFingerprint !== root.manifest.cluster?.ringFingerprint || manifest.cluster?.schemaVersion !== root.manifest.cluster?.schemaVersion) throw new CassandraCommitLogError('CASSANDRA_PITR_CHAIN_MISMATCH', 'A Cassandra PITR manifest does not match the full anchor.', { category: 'integrity' });
    if (manifest.chain?.parentRecoveryPointId !== previous.recoveryPointId || manifest.chain?.chainRootRecoveryPointId !== root.recoveryPointId) throw new CassandraCommitLogError('CASSANDRA_PITR_LINEAGE_INVALID', 'The Cassandra PITR RecoveryPoint lineage is not contiguous.', { category: 'integrity' });
    compareCommitLogCursors(previous.manifest.commitLog.cursor, manifest.commitLog?.cursor);
    if (manifest.commitLog?.precision !== precision || manifest.commitLog?.gaps?.length) throw new CassandraCommitLogError('CASSANDRA_PITR_CONTINUITY_INVALID', 'The Cassandra PITR precision changed or the chain reports a gap.', { category: 'integrity' });
    selected.push(record);
    previous = record;
    if (Date.parse(manifest.commitLog.recoveryWindow?.latest) >= Date.parse(target.iso)) { terminal = record; break; }
  }
  if (!terminal) throw new CassandraCommitLogError('CASSANDRA_PITR_TARGET_UNCOVERED', 'The Cassandra commit-log chain does not cover the requested UTC target.', { category: 'validation' });
  const sourceHostIds = root.manifest.nodes.map((node) => node.hostId).sort();
  const mappings = Array.isArray(input.nodeMappings) ? input.nodeMappings.map((mapping) => ({
    sourceHostId: requiredText(mapping?.sourceHostId, 'Source host ID', 100),
    targetHostId: requiredText(mapping?.targetHostId, 'Target host ID', 100),
    restoreDirectory: safeAbsolutePosixPath(mapping?.restoreDirectory, 'Cassandra restore directory'),
    propertiesPath: safeAbsolutePosixPath(mapping?.propertiesPath, 'Cassandra restore properties path')
  })) : [];
  if (mappings.length !== sourceHostIds.length || new Set(mappings.map((mapping) => mapping.sourceHostId)).size !== mappings.length || new Set(mappings.map((mapping) => mapping.targetHostId)).size !== mappings.length || sourceHostIds.some((hostId) => !mappings.some((mapping) => mapping.sourceHostId === hostId))) throw new CassandraCommitLogError('CASSANDRA_PITR_NODE_MAPPING_INVALID', 'Cassandra PITR requires one unambiguous target mapping for every source node.', { category: 'validation' });
  const configurations = mappings.sort((left, right) => left.sourceHostId.localeCompare(right.sourceHostId, 'en-US')).map((mapping) => {
    const contents = `archive_command=\nrestore_command=cp -- %from %to\nrestore_directories=${mapping.restoreDirectory}\nrestore_point_in_time=${target.propertyValue}\nprecision=${precision}\n`;
    return { ...mapping, contents, digest: textDigest(contents), mode: 0o600 };
  });
  const plan = {
    version: 1,
    operation: 'cassandra-commit-log-offline-plan',
    chainRootRecoveryPointId: root.recoveryPointId,
    terminalRecoveryPointId: terminal.recoveryPointId,
    recoveryPointIds: selected.map((record) => record.recoveryPointId),
    targetUtc: target.iso,
    precision,
    configurations,
    serviceMutationAllowed: false,
    materializationAllowed: false
  };
  return Object.freeze({ ...plan, planDigest: evidenceDigest(plan) });
}

module.exports = {
  COMMIT_LOG_CURSOR_VERSION,
  COMMIT_LOG_PATTERN,
  MAX_COMMIT_LOG_CURSOR_BYTES,
  MAX_COMMIT_LOG_SEGMENTS,
  CassandraCommitLogError,
  commitLogCursor,
  compareCommitLogCursors,
  evidenceDigest,
  flattenCommitLogCursor,
  normalizeCommitLogArchiveEnrollment,
  normalizeRecoveryTarget,
  normalizeSegments,
  parseJavaProperties,
  planCassandraCommitLogRestore,
  safeAbsolutePosixPath,
  textDigest,
  validateCommitLogArchiveProperties
};
