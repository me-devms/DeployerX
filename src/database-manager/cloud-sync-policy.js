const { normalizeCloudProfileDocument } = require('./cloud-metadata');

function conflict(expectedRevision, actualRevision) {
  return Object.assign(new Error('Cloud database profile metadata changed on another device.'), {
    code: 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT',
    category: 'database-cloud-sync',
    retryable: false,
    details: { expectedRevision, actualRevision }
  });
}

function planCloudSyncOperation(operation, remoteDocument) {
  if (!operation || !['upsert', 'delete'].includes(operation.type)) throw new TypeError('Database cloud sync operation is invalid.');
  const expectedRevision = operation.expectedRevision === null || operation.expectedRevision === undefined ? null : Number(operation.expectedRevision);
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new TypeError('Database cloud sync expected revision is invalid.');
  const remote = remoteDocument ? normalizeCloudProfileDocument(remoteDocument) : null;
  const actualRevision = remote ? remote.revision : 0;
  if ((remote && expectedRevision === null) || (expectedRevision !== null && actualRevision !== expectedRevision)) {
    throw conflict(expectedRevision, actualRevision);
  }
  if (operation.type === 'delete' && !remote) return Object.freeze({ action: 'noop', actualRevision });
  if (!remote) return Object.freeze({ action: 'upsert', actualRevision, precondition: Object.freeze({ exists: false }) });
  const updateTime = String(remoteDocument.__updateTime || '').trim();
  if (!updateTime) {
    throw Object.assign(new Error('Cloud database profile precondition metadata is unavailable.'), {
      code: 'DATABASE_MANAGER_CLOUD_PRECONDITION_UNAVAILABLE', category: 'database-cloud-sync', retryable: true
    });
  }
  return Object.freeze({
    action: operation.type,
    actualRevision,
    precondition: Object.freeze({ updateTime })
  });
}

module.exports = { planCloudSyncOperation };
