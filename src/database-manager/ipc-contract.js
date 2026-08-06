const { normalizeSafeDetails } = require('./domain');

const DATABASE_MANAGER_IPC_VERSION = 1;

function safeError(error) {
  return {
    code: String(error?.code || 'DATABASE_MANAGER_OPERATION_FAILED').slice(0, 120),
    category: String(error?.category || 'database-manager').slice(0, 80),
    retryable: Boolean(error?.retryable),
    safeMessage: String(error?.safeMessage || error?.message || 'The Database Manager operation failed.').slice(0, 1000),
    details: normalizeSafeDetails(error?.details)
  };
}

function wrapDatabaseManagerIpc(handler) {
  if (typeof handler !== 'function') throw new TypeError('Database Manager IPC handler must be a function.');
  return async (...args) => {
    try {
      return { databaseManagerIpcVersion: DATABASE_MANAGER_IPC_VERSION, ok: true, value: await handler(...args) };
    } catch (error) {
      return { databaseManagerIpcVersion: DATABASE_MANAGER_IPC_VERSION, ok: false, error: safeError(error) };
    }
  };
}

function unwrapDatabaseManagerIpc(response) {
  if (!response || response.databaseManagerIpcVersion !== DATABASE_MANAGER_IPC_VERSION || typeof response.ok !== 'boolean') {
    const error = new Error('The Database Manager returned an unsupported response.');
    error.code = 'DATABASE_MANAGER_IPC_RESPONSE_INVALID';
    error.category = 'ipc';
    error.retryable = false;
    throw error;
  }
  if (response.ok) return response.value;
  const error = new Error(String(response.error?.safeMessage || 'The Database Manager operation failed.'));
  error.code = String(response.error?.code || 'DATABASE_MANAGER_OPERATION_FAILED');
  error.category = String(response.error?.category || 'database-manager');
  error.retryable = Boolean(response.error?.retryable);
  error.details = normalizeSafeDetails(response.error?.details);
  throw error;
}

module.exports = {
  DATABASE_MANAGER_IPC_VERSION,
  safeError,
  unwrapDatabaseManagerIpc,
  wrapDatabaseManagerIpc
};
