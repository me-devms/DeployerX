const crypto = require('node:crypto');

const SHARED_CONTROL_ENTITY_TYPES = Object.freeze([
  'connection',
  'source',
  'repository',
  'notificationRoute',
  'policy',
  'backupJob'
]);

const SHARED_CONTROL_ENTITY_SET = new Set(SHARED_CONTROL_ENTITY_TYPES);

function clone(value) {
  return structuredClone(value);
}

function removeLocalPathFields(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(removeLocalPathFields);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['path', 'rootPath', 'databasePath', 'stagingPath', 'temporaryPath', 'socketPath'].includes(key))
    .map(([key, nested]) => [key, removeLocalPathFields(nested)]));
}

function projectWorkspaceControlRecord(type, input) {
  if (!SHARED_CONTROL_ENTITY_SET.has(type)) return null;
  const record = clone(input);
  if (type === 'connection') {
    record.secretRefIds = [];
    record.workerAffinity = [];
    delete record.lastTest;
    if (record.scope === 'device' || String(record.adapterId || '').includes('.local')) {
      record.endpoint = removeLocalPathFields(record.endpoint);
    }
  } else if (type === 'repository') {
    record.secretRefIds = [];
    record.encryptionKeyRefId = null;
    record.workerAffinity = [];
    delete record.lastVerification;
    if (String(record.adapterId || '').includes('.local')) record.location = removeLocalPathFields(record.location);
  } else if (type === 'source') {
    if (String(record.adapterId || '').includes('.local')) {
      record.selector = { ...(removeLocalPathFields(record.selector) || {}), roots: [] };
      record.localSelectionRequired = true;
    }
    delete record.lastDiscovery;
  } else if (type === 'notificationRoute') {
    record.secretRefIds = [];
    delete record.deliveryHistory;
  } else if (type === 'backupJob') {
    record.workerId = null;
    record.workerAffinity = [];
    record.lastSuccessfulRunId = null;
    delete record.scheduleState;
  }
  return record;
}

function mergeWorkspaceControlRecord(type, local, remote) {
  if (!local) return clone(remote);
  const merged = { ...clone(remote) };
  if (type === 'connection') {
    merged.secretRefIds = clone(local.secretRefIds || []);
    merged.workerAffinity = clone(local.workerAffinity || []);
    if (local.lastTest !== undefined) merged.lastTest = clone(local.lastTest);
    if (local.scope === 'device' || String(local.adapterId || '').includes('.local')) {
      merged.endpoint = { ...(remote.endpoint || {}), ...(local.endpoint || {}) };
    }
  } else if (type === 'repository') {
    merged.secretRefIds = clone(local.secretRefIds || []);
    merged.encryptionKeyRefId = local.encryptionKeyRefId || null;
    merged.workerAffinity = clone(local.workerAffinity || []);
    if (local.lastVerification !== undefined) merged.lastVerification = clone(local.lastVerification);
    if (String(local.adapterId || '').includes('.local')) merged.location = { ...(remote.location || {}), ...(local.location || {}) };
  } else if (type === 'source') {
    if (String(local.adapterId || '').includes('.local')) {
      merged.selector = clone(local.selector);
      merged.localSelectionRequired = false;
    }
    if (local.lastDiscovery !== undefined) merged.lastDiscovery = clone(local.lastDiscovery);
  } else if (type === 'notificationRoute') {
    merged.secretRefIds = clone(local.secretRefIds || []);
    if (local.deliveryHistory !== undefined) merged.deliveryHistory = clone(local.deliveryHistory);
  } else if (type === 'backupJob') {
    merged.workerId = local.workerId || null;
    merged.workerAffinity = clone(local.workerAffinity || []);
    merged.lastSuccessfulRunId = local.lastSuccessfulRunId || null;
    if (local.scheduleState !== undefined) merged.scheduleState = clone(local.scheduleState);
  }
  return merged;
}

function workspaceControlRecordTimestamp(record) {
  return Date.parse(record?.updatedAt || record?.createdAt || '') || 0;
}

function workspaceControlChangeIsShared(type, previous, record) {
  const projected = projectWorkspaceControlRecord(type, record);
  if (!projected) return false;
  if (!previous) return true;
  const previousProjected = projectWorkspaceControlRecord(type, previous);
  if (!previousProjected || Boolean(previousProjected.deletedAt) !== Boolean(projected.deletedAt)) return true;
  const withoutChangeMetadata = (value) => {
    const copy = clone(value);
    for (const key of ['revision', 'updatedAt', 'updatedBy']) delete copy[key];
    return copy;
  };
  return JSON.stringify(withoutChangeMetadata(previousProjected)) !== JSON.stringify(withoutChangeMetadata(projected));
}

function workspaceControlRecordsEquivalent(type, left, right) {
  const leftProjected = projectWorkspaceControlRecord(type, left);
  const rightProjected = projectWorkspaceControlRecord(type, right);
  if (!leftProjected || !rightProjected) return false;
  for (const record of [leftProjected, rightProjected]) {
    for (const key of ['revision', 'updatedAt', 'updatedBy']) delete record[key];
  }
  return JSON.stringify(leftProjected) === JSON.stringify(rightProjected);
}

function compareWorkspaceControlRecords(left, right) {
  const timestampDifference = workspaceControlRecordTimestamp(left) - workspaceControlRecordTimestamp(right);
  if (timestampDifference) return timestampDifference;
  const revisionDifference = (Number(left?.revision) || 0) - (Number(right?.revision) || 0);
  if (revisionDifference) return revisionDifference;
  return JSON.stringify(left || {}).localeCompare(JSON.stringify(right || {}), 'en-US');
}

function workspaceControlDocumentId(type, id) {
  const identity = `${String(type)}:${String(id)}`;
  return `${String(type).slice(0, 30)}_${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

module.exports = {
  SHARED_CONTROL_ENTITY_TYPES,
  compareWorkspaceControlRecords,
  mergeWorkspaceControlRecord,
  projectWorkspaceControlRecord,
  workspaceControlChangeIsShared,
  workspaceControlRecordsEquivalent,
  workspaceControlDocumentId
};
