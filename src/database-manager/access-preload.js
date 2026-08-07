const { contextBridge, ipcRenderer } = require('electron');

const DATABASE_MANAGER_IPC_VERSION = 1;
const DATABASE_MANAGER_EVENT_VERSION = 1;

// Sandboxed Electron preloads cannot require local application modules.
function unwrapDatabaseManagerIpc(response) {
  if (!response || response.databaseManagerIpcVersion !== DATABASE_MANAGER_IPC_VERSION || typeof response.ok !== 'boolean') {
    const error = new Error('The Database Manager returned an unsupported response.');
    error.code = 'DATABASE_MANAGER_IPC_RESPONSE_INVALID';
    throw error;
  }
  if (response.ok) return response.value;
  const error = new Error(String(response.error?.safeMessage || 'The Database Manager operation failed.'));
  error.code = String(response.error?.code || 'DATABASE_MANAGER_OPERATION_FAILED');
  error.category = String(response.error?.category || 'database-manager');
  error.retryable = Boolean(response.error?.retryable);
  error.details = response.error?.details && typeof response.error.details === 'object' ? response.error.details : {};
  throw error;
}

async function invokeDatabaseManager(channel, ...args) {
  return unwrapDatabaseManagerIpc(await ipcRenderer.invoke(channel, ...args));
}

contextBridge.exposeInMainWorld('deployerx', {
  readClipboard: () => ipcRenderer.sendSync('clipboard:read-sync'),
  writeClipboard: (text) => ipcRenderer.sendSync('clipboard:write-sync', String(text ?? '')),
  listDatabaseProfiles: (options = {}) => invokeDatabaseManager('database-manager:profiles:list', options),
  listDatabaseConnectionStatuses: () => invokeDatabaseManager('database-manager:connections:list-status'),
  executeDatabaseQuery: (payload) => invokeDatabaseManager('database-manager:queries:execute', payload),
  cancelDatabaseQuery: (requestId) => invokeDatabaseManager('database-manager:queries:cancel', { requestId }),
  explainDatabaseQuery: (payload) => invokeDatabaseManager('database-manager:explain:execute', payload),
  cancelDatabaseExplain: (requestId) => invokeDatabaseManager('database-manager:explain:cancel', { requestId }),
  mutateDatabaseRows: (payload) => invokeDatabaseManager('database-manager:rows:mutate', payload),
  loadDatabaseSchema: (payload) => invokeDatabaseManager('database-manager:schema:load', payload),
  cancelDatabaseSchema: (requestId) => invokeDatabaseManager('database-manager:schema:cancel', { requestId }),
  serializeDatabaseQueryResults: (payload) => invokeDatabaseManager('database-manager:results:serialize', payload),
  exportDatabaseQueryResults: (payload) => invokeDatabaseManager('database-manager:results:export', payload),
  exportDatabaseQuery: (payload) => invokeDatabaseManager('database-manager:results:export-query', payload),
  cancelDatabaseQueryExport: (requestId) => invokeDatabaseManager('database-manager:results:cancel-export', { requestId }),
  onDatabaseManagerEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Database Manager event callback is invalid.');
    const handler = (_event, message) => {
      if (message?.databaseManagerEventVersion === DATABASE_MANAGER_EVENT_VERSION) callback(message);
    };
    ipcRenderer.on('database-manager:event', handler);
    return () => ipcRenderer.removeListener('database-manager:event', handler);
  }
});
