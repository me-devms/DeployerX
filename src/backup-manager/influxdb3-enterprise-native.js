const { createHash } = require('node:crypto');
const { DatabaseAdapterError } = require('./database-adapter');
const {
  InfluxDb3EnterpriseAdapter,
  MAX_BACKUPS,
  NATIVE_CONSISTENCY_METHOD,
  apiPath,
  parseJsonResponse,
  requireClusterHeader,
  responseText
} = require('./influxdb3-enterprise');

const BACKUP_OPERATION_KIND = NATIVE_CONSISTENCY_METHOD;
const RESTORE_OPERATION_KIND = 'influxdb3-enterprise-native-restore';
const RESTORE_CONFIRMATION = 'RESTORE INFLUXDB 3 ENTERPRISE LIVE CLUSTER';
const BACKUP_STATES = Object.freeze({ IN_PROGRESS: 'in_progress', COMPLETED: 'completed', FAILED: 'failed' });
const RESTORE_STATES = Object.freeze({ IN_PROGRESS: 'in_progress', COMPLETED: 'completed', FAILED: 'failed' });
const BACKUP_TERMINAL_STATES = Object.freeze(new Set([BACKUP_STATES.COMPLETED, BACKUP_STATES.FAILED]));
const RESTORE_TERMINAL_STATES = Object.freeze(new Set([RESTORE_STATES.COMPLETED, RESTORE_STATES.FAILED]));
const MAX_RESTORES = 1000;
const MAX_NAME_LENGTH = 128;
const MAX_ID_LENGTH = 128;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_POLL_ATTEMPTS = 86400;
const MAX_OPERATION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 60000;
const MAX_POLL_ATTEMPTS = 100000;

function nativeError(code, message, category = 'integrity', options = {}) {
  return new DatabaseAdapterError(code, message, { category, retryable: Boolean(options.retryable), details: options.details });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeBackupName(value, label = 'InfluxDB 3 Enterprise backup name') {
  const raw = typeof value === 'string' ? value : '';
  const text = raw.trim();
  if (raw !== text || !text || text.length > MAX_NAME_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_NAME_INVALID', `${label} is invalid.`, 'validation');
  }
  return text;
}

function optionalBackupName(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeBackupName(value, label);
}

function normalizeRestoreId(value) {
  const raw = typeof value === 'string' ? value : '';
  const text = raw.trim();
  if (raw !== text || !text || text.length > MAX_ID_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_ID_INVALID', 'InfluxDB 3 Enterprise restore ID is invalid.', 'validation');
  }
  return text;
}

function normalizeState(value, states, code, label) {
  if (typeof value !== 'string' || value !== value.trim() || !Object.values(states).includes(value)) {
    throw nativeError(code, `InfluxDB 3 Enterprise returned an invalid ${label} state.`);
  }
  return value;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value !== value.trim() || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_RESPONSE_INVALID', `InfluxDB 3 Enterprise returned an invalid ${label}.`);
  }
  return value;
}

function normalizeWatermark(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value === value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup watermark.');
}

function normalizeBackupGeneration(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value === value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup generation.');
}

function backupTypeAndParent(value) {
  let rawType = value.type ?? value.backup_type;
  let nestedParent = null;
  if (isPlainObject(rawType)) {
    if (isPlainObject(rawType.incremental)) {
      nestedParent = rawType.incremental.parent ?? rawType.incremental.parent_name ?? null;
      rawType = 'incremental';
    } else if (rawType.incremental === true) {
      rawType = 'incremental';
    } else if (rawType.full === true || isPlainObject(rawType.full)) {
      rawType = 'full';
    } else {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_RECORD_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup type.');
    }
  }
  const parentName = optionalBackupName(
    value.parent ?? value.parent_name ?? value.parent_backup_name ?? nestedParent,
    'InfluxDB 3 Enterprise parent backup name'
  );
  const type = rawType === undefined || rawType === null || rawType === '' ? (parentName ? 'incremental' : 'full') : rawType;
  if (!['full', 'incremental'].includes(type)) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_RECORD_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup type.');
  if ((type === 'full' && parentName) || (type === 'incremental' && !parentName)) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup parent relationship.');
  }
  return { type, parentName };
}

function normalizeBackupRecord(value) {
  if (!isPlainObject(value)) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_RECORD_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup record.');
  const name = normalizeBackupName(value.backup_name ?? value.name);
  const status = normalizeState(value.status, BACKUP_STATES, 'INFLUXDB3_ENTERPRISE_BACKUP_STATE_INVALID', 'backup');
  const { type, parentName } = backupTypeAndParent(value);
  return Object.freeze({
    name,
    type,
    parentName,
    status,
    watermark: normalizeWatermark(value.backup_watermark ?? value.wal_watermark ?? value.watermark),
    generation: normalizeBackupGeneration(value.backup_generation ?? value.backupGeneration ?? value.generation),
    createdAt: optionalTimestamp(value.created_at ?? value.createdAt, 'backup creation timestamp'),
    completedAt: optionalTimestamp(value.completed_at ?? value.completedAt, 'backup completion timestamp')
  });
}

function normalizeRestoreRecord(value) {
  if (!isPlainObject(value)) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_RECORD_INVALID', 'InfluxDB 3 Enterprise returned an invalid restore record.');
  return Object.freeze({
    id: normalizeRestoreId(value.restore_id ?? value.id),
    backupName: optionalBackupName(value.backup_name ?? value.backup ?? value.name, 'InfluxDB 3 Enterprise restore backup name'),
    status: normalizeState(value.status, RESTORE_STATES, 'INFLUXDB3_ENTERPRISE_RESTORE_STATE_INVALID', 'restore'),
    createdAt: optionalTimestamp(value.created_at ?? value.createdAt, 'restore creation timestamp'),
    completedAt: optionalTimestamp(value.completed_at ?? value.completedAt, 'restore completion timestamp')
  });
}

function normalizeCreateBackupRequest(input = {}) {
  if (!isPlainObject(input)) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_REQUEST_INVALID', 'InfluxDB 3 Enterprise backup request is invalid.', 'validation');
  const name = normalizeBackupName(input.name ?? input.backupName);
  const type = String(input.type ?? input.mode ?? 'full').toLowerCase();
  if (!['full', 'incremental'].includes(type)) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_TYPE_INVALID', 'InfluxDB 3 Enterprise backup type is invalid.', 'validation');
  const parentName = optionalBackupName(input.parentName ?? input.parentBackupName ?? input.parent, 'InfluxDB 3 Enterprise parent backup name');
  if ((type === 'full' && parentName) || (type === 'incremental' && !parentName) || name === parentName) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID', 'InfluxDB 3 Enterprise incremental backup parent is invalid.', 'validation');
  }
  return Object.freeze({ name, type, parentName });
}

function normalizeCreateRestoreRequest(input = {}) {
  if (!isPlainObject(input)) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_REQUEST_INVALID', 'InfluxDB 3 Enterprise restore request is invalid.', 'validation');
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION) {
    throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION_REQUIRED', 'Enter the exact destructive live-cluster restore confirmation.', 'conflict');
  }
  return Object.freeze({ backupName: normalizeBackupName(input.backupName ?? input.name, 'InfluxDB 3 Enterprise restore backup name') });
}

function parseBackupCollection(body) {
  if (!isPlainObject(body) || !Array.isArray(body.backups) || body.backups.length > MAX_BACKUPS) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned an invalid bounded backup collection.');
  }
  const backups = body.backups.map(normalizeBackupRecord);
  const names = new Set();
  for (const backup of backups) {
    if (names.has(backup.name)) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned duplicate backup names.');
    names.add(backup.name);
  }
  validateBackupGraph(backups);
  return Object.freeze(backups);
}

function parseRestoreCollection(body) {
  if (!isPlainObject(body) || !Array.isArray(body.restores) || body.restores.length > MAX_RESTORES) {
    throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned an invalid bounded restore collection.');
  }
  const restores = body.restores.map(normalizeRestoreRecord);
  const ids = new Set();
  for (const restore of restores) {
    if (ids.has(restore.id)) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned duplicate restore IDs.');
    ids.add(restore.id);
  }
  return Object.freeze(restores);
}

function backupMap(backups) {
  const result = new Map();
  for (const backup of backups) result.set(backup.name, backup);
  return result;
}

function reconstructBackupChain(backups, backupName, options = {}) {
  if (!Array.isArray(backups) || backups.length > MAX_BACKUPS) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID', 'InfluxDB 3 Enterprise backup chain is invalid.');
  const name = normalizeBackupName(backupName);
  const byName = backupMap(backups);
  const reverseChain = [];
  const visited = new Set();
  let current = byName.get(name);
  if (!current) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND', 'InfluxDB 3 Enterprise backup was not found.', 'not-found');
  while (current) {
    if (visited.has(current.name) || reverseChain.length >= MAX_BACKUPS) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID', 'InfluxDB 3 Enterprise returned a cyclic or oversized backup chain.');
    visited.add(current.name);
    reverseChain.push(current);
    if (options.requireCompleted === true && current.status !== BACKUP_STATES.COMPLETED) {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INCOMPLETE', 'Every backup in the InfluxDB 3 Enterprise restore chain must be completed.', 'conflict', { details: { backupName: current.name, status: current.status } });
    }
    if (current.type === 'full') break;
    current = byName.get(current.parentName);
    if (!current) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID', 'InfluxDB 3 Enterprise backup chain has a missing parent.');
  }
  if (!reverseChain.length || reverseChain[reverseChain.length - 1].type !== 'full') {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CHAIN_INVALID', 'InfluxDB 3 Enterprise backup chain has no full root.');
  }
  return Object.freeze(reverseChain.reverse());
}

function validateBackupGraph(backups) {
  for (const backup of backups) reconstructBackupChain(backups, backup.name);
  return backups;
}

function compareBackupNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function backupDeletionClosure(backups, backupName) {
  const name = normalizeBackupName(backupName);
  const target = backups.find((backup) => backup.name === name);
  if (!target) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND', 'InfluxDB 3 Enterprise backup was not found.', 'not-found');
  const depth = new Map([[name, 0]]);
  for (let pass = 0; pass < backups.length; pass += 1) {
    let changed = false;
    for (const backup of backups) {
      if (!backup.parentName || !depth.has(backup.parentName) || depth.has(backup.name)) continue;
      depth.set(backup.name, depth.get(backup.parentName) + 1);
      changed = true;
    }
    if (!changed) break;
  }
  const descendants = Object.freeze(backups
    .filter((backup) => backup.name !== name && depth.has(backup.name))
    .sort((left, right) => depth.get(right.name) - depth.get(left.name) || compareBackupNames(left.name, right.name)));
  const deletionOrder = Object.freeze([...descendants.map((backup) => backup.name), name]);
  const byName = backupMap(backups);
  const members = Object.freeze(deletionOrder.map((memberName) => byName.get(memberName)));
  return Object.freeze({ target, descendants, deletionOrder, members });
}

function backupDeletionClosureFingerprint(identity, targetName, closure) {
  const canonical = JSON.stringify({
    version: 2,
    operationKind: BACKUP_OPERATION_KIND,
    identity: {
      version: identity.version.text,
      ...operationIdentity(identity)
    },
    targetName,
    deletionOrder: closure.deletionOrder,
    members: closure.members.map((backup) => ({
      name: backup.name,
      type: backup.type,
      parentName: backup.parentName,
      status: backup.status,
      watermark: backup.watermark,
      generation: backup.generation,
      createdAt: backup.createdAt,
      completedAt: backup.completedAt
    }))
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function normalizeDeletionOrder(value, targetName) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BACKUPS) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_DELETE_REVIEW_INVALID', 'The reviewed InfluxDB 3 Enterprise backup deletion closure is invalid.', 'validation');
  }
  const deletionOrder = value.map((name) => normalizeBackupName(name, 'reviewed InfluxDB 3 Enterprise backup name'));
  if (new Set(deletionOrder).size !== deletionOrder.length || deletionOrder[deletionOrder.length - 1] !== targetName) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_DELETE_REVIEW_INVALID', 'The reviewed InfluxDB 3 Enterprise backup deletion closure is invalid.', 'validation');
  }
  return Object.freeze(deletionOrder);
}

function normalizeDeletionFingerprint(value) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_DELETE_REVIEW_INVALID', 'The reviewed InfluxDB 3 Enterprise backup deletion fingerprint is invalid.', 'validation');
  }
  return value;
}

function sameDeletionOrder(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function normalizeBackupOwnership(value, expectedName = null) {
  if (!isPlainObject(value) || value.version !== 1 || value.operationKind !== BACKUP_OPERATION_KIND) {
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID', 'InfluxDB 3 Enterprise backup ownership could not be proven.', 'authorization');
  }
  const backupName = normalizeBackupName(value.backupName);
  const clusterId = normalizeIdentityValue(value.clusterId, 'backup ownership cluster ID');
  const deploymentFingerprint = normalizeFingerprint(value.deploymentFingerprint, 'backup ownership deployment fingerprint');
  const capabilityFingerprint = normalizeFingerprint(value.capabilityFingerprint, 'backup ownership capability fingerprint');
  const storageEngine = value.storageEngine === 'upgraded' ? value.storageEngine : null;
  const nodeId = normalizeIdentityValue(value.nodeId, 'backup ownership node ID');
  const nodeCatalogId = normalizeNodeCatalogId(value.nodeCatalogId, 'backup ownership node catalog ID');
  const instanceId = normalizeIdentityValue(value.instanceId, 'backup ownership instance ID');
  const roleFingerprint = normalizeFingerprint(value.roleFingerprint, 'backup ownership role fingerprint');
  if (!storageEngine) throw nativeError('INFLUXDB3_ENTERPRISE_OPERATION_IDENTITY_INVALID', 'InfluxDB 3 Enterprise backup ownership storage engine is invalid.');
  if (expectedName && backupName !== expectedName) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID', 'InfluxDB 3 Enterprise backup ownership does not match the requested backup.', 'authorization');
  return Object.freeze({ version: 1, operationKind: BACKUP_OPERATION_KIND, backupName, clusterId, storageEngine, nodeId, nodeCatalogId, instanceId, roleFingerprint, deploymentFingerprint, capabilityFingerprint, acceptedAt: optionalTimestamp(value.acceptedAt, 'backup acceptance timestamp') });
}

function normalizeRestoreMutation(value, expectedId = null) {
  if (!isPlainObject(value) || value.version !== 1 || value.operationKind !== RESTORE_OPERATION_KIND) {
    throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_OWNERSHIP_INVALID', 'InfluxDB 3 Enterprise restore ownership could not be proven.', 'authorization');
  }
  const restoreId = normalizeRestoreId(value.restoreId);
  const backupName = normalizeBackupName(value.backupName, 'InfluxDB 3 Enterprise restore backup name');
  const clusterId = normalizeIdentityValue(value.clusterId, 'restore ownership cluster ID');
  const deploymentFingerprint = normalizeFingerprint(value.deploymentFingerprint, 'restore ownership deployment fingerprint');
  const capabilityFingerprint = normalizeFingerprint(value.capabilityFingerprint, 'restore ownership capability fingerprint');
  const storageEngine = value.storageEngine === 'upgraded' ? value.storageEngine : null;
  const nodeId = normalizeIdentityValue(value.nodeId, 'restore ownership node ID');
  const nodeCatalogId = normalizeNodeCatalogId(value.nodeCatalogId, 'restore ownership node catalog ID');
  const instanceId = normalizeIdentityValue(value.instanceId, 'restore ownership instance ID');
  const roleFingerprint = normalizeFingerprint(value.roleFingerprint, 'restore ownership role fingerprint');
  if (!storageEngine) throw nativeError('INFLUXDB3_ENTERPRISE_OPERATION_IDENTITY_INVALID', 'InfluxDB 3 Enterprise restore ownership storage engine is invalid.');
  if (expectedId && restoreId !== expectedId) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_OWNERSHIP_INVALID', 'InfluxDB 3 Enterprise restore ownership does not match the requested restore.', 'authorization');
  return Object.freeze({ version: 1, operationKind: RESTORE_OPERATION_KIND, restoreId, backupName, clusterId, storageEngine, nodeId, nodeCatalogId, instanceId, roleFingerprint, deploymentFingerprint, capabilityFingerprint, acceptedAt: optionalTimestamp(value.acceptedAt, 'restore acceptance timestamp'), targetMutationStarted: true });
}

function normalizeIdentityValue(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw nativeError('INFLUXDB3_ENTERPRISE_OPERATION_IDENTITY_INVALID', `InfluxDB 3 Enterprise ${label} is invalid.`);
  }
  return value;
}

function normalizeFingerprint(value, label) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw nativeError('INFLUXDB3_ENTERPRISE_OPERATION_IDENTITY_INVALID', `InfluxDB 3 Enterprise ${label} is invalid.`);
  return value;
}

function normalizeNodeCatalogId(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) throw nativeError('INFLUXDB3_ENTERPRISE_OPERATION_IDENTITY_INVALID', `InfluxDB 3 Enterprise ${label} is invalid.`);
  return number;
}

function operationIdentity(identity) {
  return {
    clusterId: identity.clusterId,
    storageEngine: identity.storageEngine,
    nodeId: identity.nodeId,
    nodeCatalogId: identity.nodeCatalogId,
    instanceId: identity.instanceId,
    roleFingerprint: identity.roleFingerprint,
    deploymentFingerprint: identity.deploymentFingerprint,
    capabilityFingerprint: identity.capabilityFingerprint
  };
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseNativeJson(response, invalidCode, invalidMessage) {
  try {
    return parseJsonResponse(response);
  } catch (error) {
    if (error?.code === 'INFLUXDB3_ENTERPRISE_RESPONSE_TOO_LARGE') throw error;
    throw nativeError(invalidCode, invalidMessage);
  }
}

function checkResponseStatus(response, expectedStatus, operation, options = {}) {
  try { responseText(response); }
  catch (error) {
    if (error instanceof DatabaseAdapterError) throw error;
    throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid native-operation response.');
  }
  const statusCode = Number(response?.statusCode || 0);
  if (statusCode === expectedStatus) return;
  if (statusCode === 401) throw nativeError('INFLUXDB3_ENTERPRISE_AUTHENTICATION_FAILED', `InfluxDB 3 Enterprise rejected the admin token during ${operation}.`, 'authentication');
  if (statusCode === 403) throw nativeError('INFLUXDB3_ENTERPRISE_ADMIN_REQUIRED', `InfluxDB 3 Enterprise requires an authorized admin token for ${operation}.`, 'authorization');
  if (statusCode === 404 && options.notFoundCode) throw nativeError(options.notFoundCode, options.notFoundMessage, 'not-found');
  if (statusCode === 409 && options.conflictCode) throw nativeError(options.conflictCode, options.conflictMessage, 'conflict');
  throw nativeError(options.code || 'INFLUXDB3_ENTERPRISE_NATIVE_REQUEST_REJECTED', options.message || `InfluxDB 3 Enterprise rejected ${operation}.`, statusCode >= 500 ? 'unavailable' : 'compatibility', { retryable: statusCode >= 500, details: { statusCode } });
}

function assertCluster(response, expectedClusterId) {
  try { return requireClusterHeader(response, expectedClusterId); }
  catch (error) {
    if (error?.code === 'INFLUXDB3_ENTERPRISE_CLUSTER_CHANGED') throw error;
    throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned invalid native-operation cluster identity.');
  }
}

function publicIdentity(identity) {
  return Object.freeze({
    version: identity.version.text,
    storageEngine: identity.storageEngine,
    clusterId: identity.clusterId,
    nodeId: identity.nodeId,
    nodeCatalogId: identity.nodeCatalogId,
    instanceId: identity.instanceId,
    roleFingerprint: identity.roleFingerprint,
    deploymentFingerprint: identity.deploymentFingerprint,
    capabilityFingerprint: identity.capabilityFingerprint
  });
}

function sameRestoreIdentity(before, after) {
  return before.version.text === after.version.text && before.storageEngine === after.storageEngine && before.clusterId === after.clusterId && before.nodeId === after.nodeId && before.nodeCatalogId === after.nodeCatalogId && before.instanceId === after.instanceId && before.roleFingerprint === after.roleFingerprint && before.deploymentFingerprint === after.deploymentFingerprint && before.capabilityFingerprint === after.capabilityFingerprint;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(nativeError('INFLUXDB3_ENTERPRISE_NATIVE_POLL_CANCELED', 'InfluxDB 3 Enterprise operation polling was canceled.', 'canceled'));
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(nativeError('INFLUXDB3_ENTERPRISE_NATIVE_POLL_CANCELED', 'InfluxDB 3 Enterprise operation polling was canceled.', 'canceled'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

class InfluxDb3EnterpriseNativeController {
  constructor(options = {}) {
    if (!isPlainObject(options)) throw new TypeError('InfluxDB 3 Enterprise native controller options are invalid.');
    if (options.adapter && options.transport) throw new TypeError('Provide either an InfluxDB 3 Enterprise adapter or transport, not both.');
    this.adapter = options.adapter || new InfluxDb3EnterpriseAdapter({ transport: options.transport });
    if (!this.adapter || typeof this.adapter.normalizeConfig !== 'function' || typeof this.adapter.readIdentity !== 'function' || typeof this.adapter.request !== 'function') throw new TypeError('InfluxDB 3 Enterprise native controller adapter is invalid.');
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date().toISOString();
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 0, MAX_POLL_INTERVAL_MS, 'InfluxDB 3 Enterprise poll interval');
    this.operationTimeoutMs = boundedInteger(options.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 1, MAX_OPERATION_TIMEOUT_MS, 'InfluxDB 3 Enterprise operation timeout');
    this.maxPollAttempts = boundedInteger(options.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS, 1, MAX_POLL_ATTEMPTS, 'InfluxDB 3 Enterprise maximum poll attempts');
  }

  async listBackups(context = {}, request = {}) {
    const admission = await this.#admit(context, request.connection);
    const backups = await this.#listBackups(context, admission);
    return Object.freeze({ identity: publicIdentity(admission.identity), backups });
  }

  async getBackup(context = {}, request = {}) {
    const name = normalizeBackupName(request.name ?? request.backupName);
    const admission = await this.#admit(context, request.connection);
    const backup = await this.#getBackup(context, admission, name);
    return Object.freeze({ identity: publicIdentity(admission.identity), backup });
  }

  async createBackup(context = {}, request = {}) {
    const operation = normalizeCreateBackupRequest(request);
    if (operation.type === 'incremental') throw nativeError('INFLUXDB3_ENTERPRISE_INCREMENTAL_WIRE_CONTRACT_UNAVAILABLE', 'InfluxDB 3 Enterprise incremental backup creation is disabled until the provider publishes an exact versioned HTTP request contract.', 'compatibility');
    if (typeof context.onOwnership !== 'function') throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_CALLBACK_REQUIRED', 'A durable InfluxDB 3 Enterprise backup ownership callback is required before starting a backup.', 'configuration');
    const admission = await this.#admit(context, request.connection);
    const backups = await this.#listBackups(context, admission);
    if (backups.some((backup) => backup.name === operation.name)) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_NAME_CONFLICT', 'InfluxDB 3 Enterprise backup name already exists.', 'conflict');
    const body = { force: false, name: operation.name, type: operation.type };
    const response = await this.#request(context, admission.config, 'POST', '/api/v3/enterprise/backup', body);
    checkResponseStatus(response, 202, 'native backup creation', { code: 'INFLUXDB3_ENTERPRISE_BACKUP_CREATE_REJECTED', message: 'InfluxDB 3 Enterprise rejected native backup creation.' });
    assertCluster(response, admission.identity.clusterId);
    const accepted = parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_BACKUP_ACCEPTANCE_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup acceptance response.');
    if (!isPlainObject(accepted) || normalizeBackupName(accepted.backup_name) !== operation.name || accepted.status !== BACKUP_STATES.IN_PROGRESS) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_ACCEPTANCE_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup acceptance response.');
    const ownership = Object.freeze({ version: 1, operationKind: BACKUP_OPERATION_KIND, backupName: operation.name, ...operationIdentity(admission.identity), acceptedAt: this.clock() });
    try { await context.onOwnership(ownership); }
    catch { throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_PERSIST_FAILED', 'InfluxDB 3 Enterprise accepted the backup, but durable ownership persistence failed. The remote backup was preserved for reconciliation.', 'persistence', { details: { operationAccepted: true, backupName: operation.name } }); }
    const backup = await this.#pollBackup(context, admission, operation.name);
    const chain = Object.freeze([backup]);
    return Object.freeze({ operationKind: BACKUP_OPERATION_KIND, ownership, identity: publicIdentity(admission.identity), backup, chain, consistency: 'application', nativeMediaManagedByServer: true });
  }

  async cancelBackup(context = {}, request = {}) {
    const name = normalizeBackupName(request.name ?? request.backupName);
    const ownership = normalizeBackupOwnership(request.ownership, name);
    const admission = await this.#admit(context, request.connection);
    this.#assertOwnedIdentity(ownership, admission.identity, 'backup');
    const backup = await this.#getBackup(context, admission, name);
    if (backup.status !== BACKUP_STATES.IN_PROGRESS) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_NOT_CANCELABLE', 'Only an owned in-progress InfluxDB 3 Enterprise backup can be canceled.', 'conflict');
    const response = await this.#request(context, admission.config, 'DELETE', '/api/v3/enterprise/backup', { name });
    checkResponseStatus(response, 200, 'native backup cancellation', { notFoundCode: 'INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND', notFoundMessage: 'InfluxDB 3 Enterprise backup was not found.', code: 'INFLUXDB3_ENTERPRISE_BACKUP_CANCEL_REJECTED', message: 'InfluxDB 3 Enterprise rejected native backup cancellation.' });
    assertCluster(response, admission.identity.clusterId);
    const canceled = parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_BACKUP_CANCEL_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup cancellation response.');
    if (!isPlainObject(canceled) || normalizeBackupName(canceled.backup_name) !== name) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_CANCEL_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup cancellation response.');
    return Object.freeze({ operationKind: BACKUP_OPERATION_KIND, backupName: name, cancellationAccepted: true, ownershipPreserved: true, identity: publicIdentity(admission.identity) });
  }

  async previewDeleteBackup(context = {}, request = {}) {
    const name = normalizeBackupName(request.name ?? request.backupName);
    const admission = await this.#admit(context, request.connection);
    const backups = await this.#listBackups(context, admission);
    const closure = backupDeletionClosure(backups, name);
    const closureFingerprint = backupDeletionClosureFingerprint(admission.identity, name, closure);
    const ownershipVerified = request.ownerships === undefined ? false : this.#assertDeletionOwnerships(request.ownerships, closure.deletionOrder, admission.identity);
    return Object.freeze({
      operationKind: BACKUP_OPERATION_KIND,
      identity: publicIdentity(admission.identity),
      target: closure.target,
      descendants: closure.descendants,
      deletionOrder: closure.deletionOrder,
      closureFingerprint,
      cascadeCount: closure.descendants.length,
      providerCascade: closure.descendants.length > 0,
      completedOnly: closure.members.every((backup) => backup.status === BACKUP_STATES.COMPLETED),
      ownershipVerified,
      previewOnly: true,
      deleteIssued: false
    });
  }

  async deleteBackup(context = {}, request = {}) {
    const name = normalizeBackupName(request.name ?? request.backupName);
    const expectedDeletionOrder = normalizeDeletionOrder(request.expectedDeletionOrder, name);
    const expectedClosureFingerprint = normalizeDeletionFingerprint(request.expectedClosureFingerprint);
    const admission = await this.#admit(context, request.connection);
    const backups = await this.#listBackups(context, admission);
    const closure = backupDeletionClosure(backups, name);
    const closureFingerprint = backupDeletionClosureFingerprint(admission.identity, name, closure);
    if (!sameDeletionOrder(expectedDeletionOrder, closure.deletionOrder) || expectedClosureFingerprint !== closureFingerprint) {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_DELETE_REVIEW_STALE', 'The InfluxDB 3 Enterprise backup deletion closure changed after review.', 'conflict', { details: { reviewRequired: true } });
    }
    const nonCompleted = closure.members.find((backup) => backup.status !== BACKUP_STATES.COMPLETED);
    if (nonCompleted) {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_DELETE_NOT_COMPLETED', 'Every backup in the InfluxDB 3 Enterprise deletion closure must be completed.', 'conflict', { details: { backupName: nonCompleted.name, status: nonCompleted.status } });
    }
    this.#assertDeletionOwnerships(request.ownerships, closure.deletionOrder, admission.identity);
    const response = await this.#request(context, admission.config, 'DELETE', '/api/v3/enterprise/backup', { name });
    checkResponseStatus(response, 200, 'native completed-backup deletion', { notFoundCode: 'INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND', notFoundMessage: 'InfluxDB 3 Enterprise backup was not found.', conflictCode: 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_CONFLICT', conflictMessage: 'InfluxDB 3 Enterprise could not accept the reviewed backup deletion closure.', code: 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_REJECTED', message: 'InfluxDB 3 Enterprise rejected completed-backup deletion.' });
    assertCluster(response, admission.identity.clusterId);
    const accepted = parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_BACKUP_DELETE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid completed-backup deletion response.');
    let acceptedName;
    try { acceptedName = isPlainObject(accepted) ? normalizeBackupName(accepted.backup_name) : null; }
    catch { acceptedName = null; }
    if (acceptedName !== name) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_DELETE_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid completed-backup deletion response.');
    let confirmedIdentity;
    try {
      confirmedIdentity = await this.#readIdentity(context, admission.config);
      if (!sameRestoreIdentity(admission.identity, confirmedIdentity) || !confirmedIdentity.upgradedStorageEngine || !confirmedIdentity.compactorCapable || !confirmedIdentity.nativeBackupAvailable) throw new Error('native identity changed');
      const remaining = await this.#listBackups(context, Object.freeze({ config: admission.config, identity: confirmedIdentity }));
      const remainingNames = new Set(remaining.map((backup) => backup.name));
      if (closure.deletionOrder.some((backupName) => remainingNames.has(backupName))) throw new Error('reviewed deletion member remains');
    } catch {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_DELETE_UNCONFIRMED', 'InfluxDB 3 Enterprise accepted completed-backup deletion, but the reviewed closure could not be confirmed absent.', 'integrity', { retryable: true, details: { operationAccepted: true, reconciliationRequired: true } });
    }
    return Object.freeze({
      operationKind: BACKUP_OPERATION_KIND,
      identity: publicIdentity(confirmedIdentity),
      deletionAccepted: true,
      evidence: Object.freeze({
        targetName: name,
        deletionOrder: closure.deletionOrder,
        closureFingerprint,
        memberCount: closure.members.length,
        cascadeCount: closure.descendants.length,
        providerCascade: closure.descendants.length > 0,
        completedOnly: true,
        exactOwnershipVerified: true,
        responseClusterVerified: true,
        deletionConfirmed: true,
        reconciliationRequired: false
      })
    });
  }

  async listRestores(context = {}, request = {}) {
    const admission = await this.#admit(context, request.connection);
    const restores = await this.#listRestores(context, admission);
    return Object.freeze({ identity: publicIdentity(admission.identity), restores });
  }

  async getRestore(context = {}, request = {}) {
    const restoreId = normalizeRestoreId(request.restoreId ?? request.id);
    const admission = await this.#admit(context, request.connection);
    const restore = await this.#getRestore(context, admission, restoreId);
    return Object.freeze({ identity: publicIdentity(admission.identity), restore });
  }

  async createRestore(context = {}, request = {}) {
    const operation = normalizeCreateRestoreRequest(request);
    if (typeof context.onMutationStarted !== 'function') throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_MUTATION_CALLBACK_REQUIRED', 'A durable InfluxDB 3 Enterprise restore mutation callback is required before starting a restore.', 'configuration');
    const admission = await this.#admit(context, request.connection);
    const backups = await this.#listBackups(context, admission);
    const chain = reconstructBackupChain(backups, operation.backupName, { requireCompleted: true });
    const source = chain[chain.length - 1];
    if (source.watermark === null) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_WATERMARK_UNPROVEN', 'The completed InfluxDB 3 Enterprise backup has no authenticated persisted-data watermark and cannot be restored safely.', 'integrity');
    const response = await this.#request(context, admission.config, 'POST', '/api/v3/enterprise/restore', { backup_name: operation.backupName });
    checkResponseStatus(response, 202, 'native restore creation', { conflictCode: 'INFLUXDB3_ENTERPRISE_RESTORE_CONFLICT', conflictMessage: 'Another InfluxDB 3 Enterprise restore is already running across the cluster.', code: 'INFLUXDB3_ENTERPRISE_RESTORE_CREATE_REJECTED', message: 'InfluxDB 3 Enterprise rejected native restore creation.' });
    assertCluster(response, admission.identity.clusterId);
    const accepted = parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_RESTORE_ACCEPTANCE_INVALID', 'InfluxDB 3 Enterprise returned an invalid restore acceptance response.');
    if (!isPlainObject(accepted) || accepted.status !== RESTORE_STATES.IN_PROGRESS) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_ACCEPTANCE_INVALID', 'InfluxDB 3 Enterprise returned an invalid restore acceptance response.');
    const restoreId = normalizeRestoreId(accepted.restore_id);
    const mutation = Object.freeze({ version: 1, operationKind: RESTORE_OPERATION_KIND, restoreId, backupName: operation.backupName, ...operationIdentity(admission.identity), acceptedAt: this.clock(), targetMutationStarted: true });
    try { await context.onMutationStarted(mutation); }
    catch { throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_MUTATION_PERSIST_FAILED', 'InfluxDB 3 Enterprise accepted the restore, but durable mutation persistence failed. The live cluster was preserved for reconciliation.', 'persistence', { details: { operationAccepted: true, restoreId } }); }
    const restore = await this.#pollRestore(context, admission, restoreId);
    const after = await this.#readIdentity(context, admission.config);
    if (!sameRestoreIdentity(admission.identity, after)) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_IDENTITY_CHANGED', 'InfluxDB 3 Enterprise cluster or engine identity changed during restore.', 'integrity', { details: { targetMutationStarted: true, restoreId } });
    const evidence = Object.freeze({
      restoreMode: 'live-cluster-in-place',
      effect: 'point-in-time-rollback',
      sourceBackupName: source.name,
      sourceBackupType: source.type,
      backupWatermark: source.watermark,
      backupWatermarkApplied: true,
      catalogRestored: true,
      checkpointAdvanced: true,
      walTruncatedToBackupWatermark: true,
      rowDeleteStateCapturedByBackup: false,
      rowDeletesMayPersist: true,
      compactedPostBackupFilesMayRemainUnreferenced: true,
      clusterId: after.clusterId,
      storageEngine: after.storageEngine,
      productVersion: after.version.text,
      compactorEndpoint: Object.freeze({ nodeId: after.nodeId, nodeCatalogId: after.nodeCatalogId, instanceId: after.instanceId, roleFingerprint: after.roleFingerprint }),
      deploymentFingerprint: after.deploymentFingerprint,
      capabilityFingerprint: after.capabilityFingerprint,
      identityRevalidated: true
    });
    return Object.freeze({ operationKind: RESTORE_OPERATION_KIND, mutation, identity: publicIdentity(after), restore, chain, evidence });
  }

  async cancelRestore(context = {}, request = {}) {
    const restoreId = normalizeRestoreId(request.restoreId ?? request.id);
    const mutation = normalizeRestoreMutation(request.mutation ?? request.ownership, restoreId);
    const admission = await this.#admit(context, request.connection);
    this.#assertOwnedIdentity(mutation, admission.identity, 'restore');
    const restore = await this.#getRestore(context, admission, restoreId);
    if (restore.status !== RESTORE_STATES.IN_PROGRESS) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_NOT_CANCELABLE', 'Only an owned in-progress InfluxDB 3 Enterprise restore can be canceled.', 'conflict');
    const response = await this.#request(context, admission.config, 'DELETE', `/api/v3/enterprise/restore/${encodePathSegment(restoreId)}`);
    checkResponseStatus(response, 204, 'native restore cancellation', { notFoundCode: 'INFLUXDB3_ENTERPRISE_RESTORE_NOT_FOUND', notFoundMessage: 'InfluxDB 3 Enterprise restore was not found.', code: 'INFLUXDB3_ENTERPRISE_RESTORE_CANCEL_REJECTED', message: 'InfluxDB 3 Enterprise rejected native restore cancellation.' });
    assertCluster(response, admission.identity.clusterId);
    if (responseText(response).length !== 0) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_CANCEL_RESPONSE_INVALID', 'InfluxDB 3 Enterprise returned an invalid restore cancellation response.');
    return Object.freeze({ operationKind: RESTORE_OPERATION_KIND, restoreId, cancellationAccepted: true, mutationPreserved: true, identity: publicIdentity(admission.identity) });
  }

  async #admit(context, input) {
    let config;
    try { config = this.adapter.normalizeConfig(input); }
    catch { throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_CONNECTION_INVALID', 'InfluxDB 3 Enterprise native-operation connection is invalid.', 'configuration'); }
    const fullyPinned = config.expectedVersion && config.expectedStorageEngine && config.expectedClusterId && config.expectedNodeId && config.expectedNodeCatalogId !== null && config.expectedInstanceId && config.expectedRoleFingerprint && config.expectedDeploymentFingerprint && config.expectedCapabilityFingerprint;
    if (!fullyPinned) throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_CONNECTION_UNPINNED', 'Test and pin the complete InfluxDB 3 Enterprise cluster, engine, node, role, and capability identity before native operations.', 'configuration');
    if (config.expectedStorageEngine !== 'upgraded') throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_ENGINE_REQUIRED', 'InfluxDB 3 Enterprise native backup and restore require the upgraded storage engine.', 'compatibility');
    const identity = await this.#readIdentity(context, config);
    if (!identity.upgradedStorageEngine || identity.storageEngine !== 'upgraded' || !identity.compactorCapable || !identity.nativeBackupAvailable) throw nativeError('INFLUXDB3_ENTERPRISE_NATIVE_CAPABILITY_REQUIRED', 'InfluxDB 3 Enterprise native backup and restore require a proven upgraded-engine compactor endpoint.', 'compatibility');
    return Object.freeze({ config, identity });
  }

  async #readIdentity(context, config) {
    try { return await this.adapter.readIdentity(context, config); }
    catch (error) {
      const code = /^INFLUXDB3_ENTERPRISE_[A-Z0-9_]+$/.test(String(error?.code || '')) ? error.code : 'INFLUXDB3_ENTERPRISE_NATIVE_ADMISSION_FAILED';
      throw nativeError(code, 'InfluxDB 3 Enterprise native-operation identity admission failed.', error?.category || 'integrity', { retryable: error?.retryable });
    }
  }

  async #request(context, config, method, suffix, body = null) {
    try { return await this.adapter.request(context, config, method, apiPath(config, suffix), body); }
    catch (error) {
      const code = /^INFLUXDB3_ENTERPRISE_[A-Z0-9_]+$/.test(String(error?.code || '')) ? error.code : 'INFLUXDB3_ENTERPRISE_NATIVE_REQUEST_FAILED';
      const category = error?.category || (code.endsWith('_CANCELED') ? 'canceled' : code.endsWith('_TIMEOUT') ? 'timeout' : 'connectivity');
      throw nativeError(code, 'InfluxDB 3 Enterprise native operation request failed.', category, { retryable: error?.retryable });
    }
  }

  async #listBackups(context, admission) {
    const response = await this.#request(context, admission.config, 'GET', '/api/v3/enterprise/backup');
    checkResponseStatus(response, 200, 'native backup listing', { code: 'INFLUXDB3_ENTERPRISE_BACKUP_LIST_FAILED', message: 'InfluxDB 3 Enterprise could not list native backups.' });
    assertCluster(response, admission.identity.clusterId);
    return parseBackupCollection(parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_BACKUP_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned an invalid bounded backup collection.'));
  }

  async #getBackup(context, admission, name) {
    const response = await this.#request(context, admission.config, 'GET', `/api/v3/enterprise/backup/${encodePathSegment(name)}`);
    checkResponseStatus(response, 200, 'native backup status', { notFoundCode: 'INFLUXDB3_ENTERPRISE_BACKUP_NOT_FOUND', notFoundMessage: 'InfluxDB 3 Enterprise backup was not found.', code: 'INFLUXDB3_ENTERPRISE_BACKUP_STATUS_FAILED', message: 'InfluxDB 3 Enterprise could not read native backup status.' });
    assertCluster(response, admission.identity.clusterId);
    const body = parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_BACKUP_RECORD_INVALID', 'InfluxDB 3 Enterprise returned an invalid backup status response.');
    const backup = normalizeBackupRecord(isPlainObject(body) && isPlainObject(body.backup) ? body.backup : body);
    if (backup.name !== name) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_IDENTITY_MISMATCH', 'InfluxDB 3 Enterprise returned status for a different backup.');
    return backup;
  }

  async #listRestores(context, admission) {
    const response = await this.#request(context, admission.config, 'GET', '/api/v3/enterprise/restore');
    checkResponseStatus(response, 200, 'native restore listing', { code: 'INFLUXDB3_ENTERPRISE_RESTORE_LIST_FAILED', message: 'InfluxDB 3 Enterprise could not list native restores.' });
    assertCluster(response, admission.identity.clusterId);
    return parseRestoreCollection(parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_RESTORE_COLLECTION_INVALID', 'InfluxDB 3 Enterprise returned an invalid bounded restore collection.'));
  }

  async #getRestore(context, admission, restoreId) {
    const response = await this.#request(context, admission.config, 'GET', `/api/v3/enterprise/restore/${encodePathSegment(restoreId)}`);
    checkResponseStatus(response, 200, 'native restore status', { notFoundCode: 'INFLUXDB3_ENTERPRISE_RESTORE_NOT_FOUND', notFoundMessage: 'InfluxDB 3 Enterprise restore was not found.', code: 'INFLUXDB3_ENTERPRISE_RESTORE_STATUS_FAILED', message: 'InfluxDB 3 Enterprise could not read native restore status.' });
    assertCluster(response, admission.identity.clusterId);
    const body = parseNativeJson(response, 'INFLUXDB3_ENTERPRISE_RESTORE_RECORD_INVALID', 'InfluxDB 3 Enterprise returned an invalid restore status response.');
    const restore = normalizeRestoreRecord(isPlainObject(body) && isPlainObject(body.restore) ? body.restore : body);
    if (restore.id !== restoreId) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_IDENTITY_MISMATCH', 'InfluxDB 3 Enterprise returned status for a different restore.');
    return restore;
  }

  async #pollBackup(context, admission, name) {
    const started = this.now();
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      this.#assertPollingAllowed(context, started, 'backup', { backupName: name });
      const backup = await this.#getBackup(context, admission, name);
      if (backup.status === BACKUP_STATES.COMPLETED) return backup;
      if (backup.status === BACKUP_STATES.FAILED) throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_FAILED', 'InfluxDB 3 Enterprise native backup failed. Durable ownership was preserved for inspection.', 'backup', { details: { backupName: name, ownershipPreserved: true } });
      if (attempt === this.maxPollAttempts) break;
      await this.#delay(context, 'backup', { backupName: name });
    }
    throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_POLL_LIMIT', 'InfluxDB 3 Enterprise backup did not finish within the bounded poll limit. Durable ownership was preserved.', 'timeout', { retryable: true, details: { backupName: name, ownershipPreserved: true } });
  }

  async #pollRestore(context, admission, restoreId) {
    const started = this.now();
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      this.#assertPollingAllowed(context, started, 'restore', { restoreId });
      const restore = await this.#getRestore(context, admission, restoreId);
      if (restore.status === RESTORE_STATES.COMPLETED) return restore;
      if (restore.status === RESTORE_STATES.FAILED) throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_FAILED', 'InfluxDB 3 Enterprise native restore failed after live-cluster mutation began. Durable mutation evidence was preserved.', 'restore', { details: { restoreId, targetMutationStarted: true } });
      if (attempt === this.maxPollAttempts) break;
      await this.#delay(context, 'restore', { restoreId });
    }
    throw nativeError('INFLUXDB3_ENTERPRISE_RESTORE_POLL_LIMIT', 'InfluxDB 3 Enterprise restore did not finish within the bounded poll limit. Durable mutation evidence was preserved.', 'timeout', { retryable: true, details: { restoreId, targetMutationStarted: true } });
  }

  #assertPollingAllowed(context, started, kind, details) {
    if (context.signal?.aborted) throw nativeError(`INFLUXDB3_ENTERPRISE_${kind.toUpperCase()}_POLL_CANCELED`, `InfluxDB 3 Enterprise ${kind} polling was canceled. The accepted remote operation was preserved.`, 'canceled', { details });
    const elapsed = this.now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= this.operationTimeoutMs) throw nativeError(`INFLUXDB3_ENTERPRISE_${kind.toUpperCase()}_POLL_TIMEOUT`, `InfluxDB 3 Enterprise ${kind} did not finish before the polling deadline. The accepted remote operation was preserved.`, 'timeout', { retryable: true, details });
  }

  async #delay(context, kind, details) {
    try { await this.sleep(this.pollIntervalMs, context.signal); }
    catch { throw nativeError(`INFLUXDB3_ENTERPRISE_${kind.toUpperCase()}_POLL_CANCELED`, `InfluxDB 3 Enterprise ${kind} polling was interrupted. The accepted remote operation was preserved.`, 'canceled', { details }); }
  }

  #assertOwnedIdentity(owner, identity, kind) {
    if (owner.clusterId !== identity.clusterId || owner.storageEngine !== identity.storageEngine || owner.nodeId !== identity.nodeId || owner.nodeCatalogId !== identity.nodeCatalogId || owner.instanceId !== identity.instanceId || owner.roleFingerprint !== identity.roleFingerprint || owner.deploymentFingerprint !== identity.deploymentFingerprint || owner.capabilityFingerprint !== identity.capabilityFingerprint) {
      throw nativeError(`INFLUXDB3_ENTERPRISE_${kind.toUpperCase()}_OWNERSHIP_INVALID`, `InfluxDB 3 Enterprise ${kind} ownership does not match the authenticated cluster and engine identity.`, 'authorization');
    }
  }

  #assertDeletionOwnerships(input, deletionOrder, identity) {
    if (!Array.isArray(input) || input.length !== deletionOrder.length || input.length > MAX_BACKUPS) {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID', 'Exact durable ownership is required for every backup in the InfluxDB 3 Enterprise deletion closure.', 'authorization');
    }
    const owners = new Map();
    try {
      for (const value of input) {
        const owner = normalizeBackupOwnership(value);
        if (!owner.acceptedAt || owners.has(owner.backupName)) throw new Error('invalid deletion ownership');
        this.#assertOwnedIdentity(owner, identity, 'backup');
        owners.set(owner.backupName, owner);
      }
    } catch {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID', 'Exact durable ownership is required for every backup in the InfluxDB 3 Enterprise deletion closure.', 'authorization');
    }
    if (deletionOrder.some((name) => !owners.has(name))) {
      throw nativeError('INFLUXDB3_ENTERPRISE_BACKUP_OWNERSHIP_INVALID', 'Exact durable ownership is required for every backup in the InfluxDB 3 Enterprise deletion closure.', 'authorization');
    }
    return true;
  }
}

module.exports = {
  BACKUP_OPERATION_KIND,
  BACKUP_STATES,
  BACKUP_TERMINAL_STATES,
  DEFAULT_MAX_POLL_ATTEMPTS,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  InfluxDb3EnterpriseNativeController,
  MAX_RESTORES,
  RESTORE_OPERATION_KIND,
  RESTORE_CONFIRMATION,
  RESTORE_STATES,
  RESTORE_TERMINAL_STATES,
  normalizeBackupName,
  normalizeBackupOwnership,
  normalizeBackupRecord,
  normalizeCreateBackupRequest,
  normalizeCreateRestoreRequest,
  normalizeRestoreId,
  normalizeRestoreMutation,
  normalizeRestoreRecord,
  reconstructBackupChain
};
