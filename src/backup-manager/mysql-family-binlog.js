const MAX_BINARY_LOG_FILES = 10000;
const MAX_GTID_SET_LENGTH = 64 * 1024;
const MIN_BINARY_LOG_POSITION = 4;

class MysqlFamilyBinlogError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MysqlFamilyBinlogError';
    this.code = code;
    this.category = options.category || 'validation';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 255) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeEngine(value) {
  const engine = String(value || '').toLowerCase();
  if (engine !== 'mysql' && engine !== 'mariadb') throw new TypeError('Binary-log engine must be MySQL or MariaDB.');
  return engine;
}

function normalizeBinaryLogName(value) {
  const name = requiredText(value, 'Binary-log file name');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new MysqlFamilyBinlogError('BINLOG_FILE_NAME_INVALID', 'The server returned an invalid binary-log file name.', { category: 'integrity' });
  const match = /^(.*?)(\d+)$/.exec(name);
  if (!match || !match[1]) throw new MysqlFamilyBinlogError('BINLOG_FILE_SEQUENCE_INVALID', 'The server binary-log file does not have a numeric sequence.', { category: 'compatibility' });
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new MysqlFamilyBinlogError('BINLOG_FILE_SEQUENCE_INVALID', 'The server binary-log sequence is invalid.', { category: 'integrity' });
  return { name, prefix: match[1], sequence, sequenceWidth: match[2].length };
}

function normalizePosition(value, label = 'Binary-log position') {
  const position = Number(value);
  if (!Number.isSafeInteger(position) || position < MIN_BINARY_LOG_POSITION) throw new MysqlFamilyBinlogError('BINLOG_POSITION_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return position;
}

function normalizeTimestamp(value, label) {
  const text = requiredText(value, label, 40);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function normalizeCoordinate(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Binary-log coordinate must be an object.');
  const file = normalizeBinaryLogName(input.file);
  const gtidSet = input.gtidSet === null || input.gtidSet === undefined || input.gtidSet === ''
    ? null
    : requiredText(input.gtidSet, 'Binary-log GTID set', MAX_GTID_SET_LENGTH);
  const coordinate = {
    version: 1,
    engine: normalizeEngine(input.engine || options.engine),
    file: file.name,
    position: normalizePosition(input.position),
    gtidSet,
    capturedAt: normalizeTimestamp(input.capturedAt || options.capturedAt, 'Binary-log capture time'),
    serverIdentityFingerprint: requiredText(input.serverIdentityFingerprint || options.serverIdentityFingerprint, 'Server identity fingerprint', 200)
  };
  return Object.freeze(coordinate);
}

function parseBinaryLogStatus(output, options = {}) {
  const line = String(output || '').split(/\r?\n/).find((item) => item.trim());
  if (!line) throw new MysqlFamilyBinlogError('BINLOG_STATUS_UNAVAILABLE', 'The server did not return a current binary-log coordinate.', { category: 'compatibility' });
  const fields = line.split('\t');
  if (fields.length < 2) throw new MysqlFamilyBinlogError('BINLOG_STATUS_INVALID', 'The server returned an invalid binary-log coordinate.', { category: 'integrity' });
  return normalizeCoordinate({
    engine: options.engine,
    file: fields[0],
    position: fields[1],
    gtidSet: fields[4] || null,
    capturedAt: options.capturedAt,
    serverIdentityFingerprint: options.serverIdentityFingerprint
  });
}

function parseBinaryLogInventory(output) {
  const lines = String(output || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new MysqlFamilyBinlogError('BINLOG_INVENTORY_EMPTY', 'The server has no available binary-log files.', { category: 'compatibility' });
  if (lines.length > MAX_BINARY_LOG_FILES) throw new MysqlFamilyBinlogError('BINLOG_INVENTORY_LIMIT_EXCEEDED', 'The server binary-log inventory exceeds the supported limit.', { category: 'capacity' });
  const unique = new Map();
  for (const line of lines) {
    const fields = line.split('\t');
    const parsedName = normalizeBinaryLogName(fields[0]);
    const sizeBytes = Number(fields[1]);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < MIN_BINARY_LOG_POSITION) throw new MysqlFamilyBinlogError('BINLOG_SIZE_INVALID', 'The server returned an invalid binary-log file size.', { category: 'integrity' });
    if (unique.has(parsedName.name)) throw new MysqlFamilyBinlogError('BINLOG_INVENTORY_DUPLICATE', 'The server returned a duplicate binary-log file.', { category: 'integrity' });
    unique.set(parsedName.name, Object.freeze({
      name: parsedName.name,
      prefix: parsedName.prefix,
      sequence: parsedName.sequence,
      sequenceWidth: parsedName.sequenceWidth,
      sizeBytes,
      encrypted: String(fields[2] || '').toLowerCase() === 'yes'
    }));
  }
  return Object.freeze([...unique.values()].sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name, 'en-US')));
}

function parseDumpCoordinate(header, options = {}) {
  const text = Buffer.isBuffer(header) || header instanceof Uint8Array ? Buffer.from(header).toString('utf8') : String(header || '');
  const bounded = text.slice(0, 2 * 1024 * 1024);
  const match = /CHANGE\s+(?:REPLICATION\s+SOURCE|MASTER)\s+TO\s+(?:SOURCE|MASTER)_LOG_FILE\s*=\s*'((?:[^'\\]|\\.)+)'\s*,\s*(?:SOURCE|MASTER)_LOG_POS\s*=\s*(\d+)/i.exec(bounded);
  if (!match) throw new MysqlFamilyBinlogError('BINLOG_ANCHOR_COORDINATE_MISSING', 'The logical dump does not contain its native binary-log anchor coordinate.', { category: 'integrity' });
  const file = match[1].replace(/\\(['\\])/g, '$1');
  return normalizeCoordinate({
    engine: options.engine,
    file,
    position: match[2],
    gtidSet: options.gtidSet || null,
    capturedAt: options.capturedAt,
    serverIdentityFingerprint: options.serverIdentityFingerprint
  });
}

function planBinaryLogSegments(input = {}) {
  const start = normalizeCoordinate(input.start, { engine: input.engine });
  const end = normalizeCoordinate(input.end, { engine: input.engine });
  if (start.engine !== end.engine) throw new MysqlFamilyBinlogError('BINLOG_ENGINE_CHANGED', 'The binary-log chain changed database engine.', { category: 'integrity' });
  if (start.serverIdentityFingerprint !== end.serverIdentityFingerprint) throw new MysqlFamilyBinlogError('BINLOG_SERVER_IDENTITY_CHANGED', 'The database server identity changed inside the binary-log chain.', { category: 'integrity' });
  if (Date.parse(end.capturedAt) < Date.parse(start.capturedAt)) throw new MysqlFamilyBinlogError('BINLOG_CAPTURE_TIME_REVERSED', 'The binary-log capture time moved backwards.', { category: 'integrity' });
  const startName = normalizeBinaryLogName(start.file);
  const endName = normalizeBinaryLogName(end.file);
  if (startName.prefix !== endName.prefix || startName.sequenceWidth !== endName.sequenceWidth || endName.sequence < startName.sequence) {
    throw new MysqlFamilyBinlogError('BINLOG_SEQUENCE_CHANGED', 'The server binary-log sequence changed unexpectedly.', { category: 'integrity' });
  }
  const inventory = Array.isArray(input.inventory) ? input.inventory.map((item) => {
    if (!item || typeof item !== 'object') throw new TypeError('Binary-log inventory entry is invalid.');
    const parsed = normalizeBinaryLogName(item.name);
    const sizeBytes = Number(item.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < MIN_BINARY_LOG_POSITION) throw new MysqlFamilyBinlogError('BINLOG_SIZE_INVALID', 'The server returned an invalid binary-log file size.', { category: 'integrity' });
    return { ...parsed, sizeBytes, encrypted: Boolean(item.encrypted) };
  }) : [];
  if (!inventory.length || inventory.length > MAX_BINARY_LOG_FILES) throw new MysqlFamilyBinlogError('BINLOG_INVENTORY_INVALID', 'A bounded binary-log inventory is required.', { category: 'integrity' });
  const bySequence = new Map(inventory.filter((item) => item.prefix === startName.prefix && item.sequenceWidth === startName.sequenceWidth).map((item) => [item.sequence, item]));
  const segments = [];
  for (let sequence = startName.sequence; sequence <= endName.sequence; sequence += 1) {
    const file = bySequence.get(sequence);
    if (!file) throw new MysqlFamilyBinlogError('BINLOG_CHAIN_GAP', 'A required binary-log file was purged or is missing.', { category: 'integrity' });
    const startPosition = sequence === startName.sequence ? start.position : MIN_BINARY_LOG_POSITION;
    const stopPosition = sequence === endName.sequence ? end.position : file.sizeBytes;
    if (startPosition > file.sizeBytes || stopPosition > file.sizeBytes || stopPosition < startPosition) {
      throw new MysqlFamilyBinlogError('BINLOG_SEGMENT_BOUNDS_INVALID', 'A binary-log segment falls outside the server-reported file bounds.', { category: 'integrity' });
    }
    if (stopPosition === startPosition) continue;
    segments.push(Object.freeze({
      version: 1,
      engine: start.engine,
      file: file.name,
      sequence,
      startPosition,
      stopPosition,
      sourceSizeBytes: file.sizeBytes,
      encryptedAtSource: file.encrypted,
      artifactPath: `${start.engine}/binary-logs/${file.name}`
    }));
  }
  return Object.freeze({
    version: 1,
    engine: start.engine,
    serverIdentityFingerprint: start.serverIdentityFingerprint,
    start,
    end,
    segments: Object.freeze(segments),
    empty: segments.length === 0
  });
}

function normalizePointInTimeTarget(input = {}, bounds = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Point-in-time target must be an object.');
  const hasTime = input.timestamp !== undefined && input.timestamp !== null && input.timestamp !== '';
  const hasCoordinate = input.coordinate !== undefined && input.coordinate !== null;
  if (hasTime === hasCoordinate) throw new MysqlFamilyBinlogError('PITR_STOP_POINT_INVALID', 'Choose exactly one recovery timestamp or native binary-log coordinate.');
  const earliest = normalizeTimestamp(bounds.earliest, 'Earliest recovery time');
  const latest = normalizeTimestamp(bounds.latest, 'Latest recovery time');
  if (Date.parse(latest) < Date.parse(earliest)) throw new TypeError('Point-in-time recovery bounds are invalid.');
  if (hasTime) {
    const timestamp = normalizeTimestamp(input.timestamp, 'Recovery timestamp');
    if (Date.parse(timestamp) < Date.parse(earliest) || Date.parse(timestamp) > Date.parse(latest)) throw new MysqlFamilyBinlogError('PITR_TIMESTAMP_OUT_OF_RANGE', 'The recovery timestamp is outside the available binary-log window.');
    return Object.freeze({ type: 'timestamp', timestamp, coordinate: null });
  }
  const coordinate = normalizeCoordinate(input.coordinate, { engine: bounds.engine });
  const earliestCoordinate = normalizeCoordinate(bounds.earliestCoordinate, { engine: bounds.engine });
  const latestCoordinate = normalizeCoordinate(bounds.latestCoordinate, { engine: bounds.engine });
  const targetName = normalizeBinaryLogName(coordinate.file);
  const firstName = normalizeBinaryLogName(earliestCoordinate.file);
  const lastName = normalizeBinaryLogName(latestCoordinate.file);
  const beforeFirst = targetName.sequence < firstName.sequence || (targetName.sequence === firstName.sequence && coordinate.position < earliestCoordinate.position);
  const afterLast = targetName.sequence > lastName.sequence || (targetName.sequence === lastName.sequence && coordinate.position > latestCoordinate.position);
  if (coordinate.serverIdentityFingerprint !== earliestCoordinate.serverIdentityFingerprint || coordinate.serverIdentityFingerprint !== latestCoordinate.serverIdentityFingerprint || targetName.prefix !== firstName.prefix || targetName.prefix !== lastName.prefix || beforeFirst || afterLast) {
    throw new MysqlFamilyBinlogError('PITR_COORDINATE_OUT_OF_RANGE', 'The recovery coordinate is outside the available binary-log chain.', { category: 'integrity' });
  }
  return Object.freeze({ type: 'coordinate', timestamp: null, coordinate });
}

module.exports = {
  MAX_BINARY_LOG_FILES,
  MAX_GTID_SET_LENGTH,
  MIN_BINARY_LOG_POSITION,
  MysqlFamilyBinlogError,
  normalizeBinaryLogName,
  normalizeCoordinate,
  normalizePointInTimeTarget,
  parseDumpCoordinate,
  parseBinaryLogInventory,
  parseBinaryLogStatus,
  planBinaryLogSegments
};
