const UPTIME_IPC_VERSION = 1;

function safeUptimeIpcError(error) {
  const candidate = String(error?.code || '').trim();
  const code = /^(?:UPTIME|NOTIFICATION)_[A-Z0-9_]+$/.test(candidate) ? candidate : 'UPTIME_OPERATION_FAILED';
  const message = code === 'UPTIME_OPERATION_FAILED'
    ? 'Could not complete the Uptime operation.'
    : String(error?.safeMessage || error?.message || 'Could not complete the Uptime operation.').trim().slice(0, 1000);
  return { code, message, category: String(error?.category || (code === 'UPTIME_OPERATION_FAILED' ? 'internal' : 'uptime')).slice(0, 100) };
}

function wrapUptimeIpc(handler) {
  if (typeof handler !== 'function') throw new TypeError('Uptime IPC handler is required.');
  return async (...args) => {
    try {
      return { uptimeIpcVersion: UPTIME_IPC_VERSION, ok: true, value: await handler(...args) };
    } catch (error) {
      return { uptimeIpcVersion: UPTIME_IPC_VERSION, ok: false, error: safeUptimeIpcError(error) };
    }
  };
}

function unwrapUptimeIpc(response) {
  if (!response || response.uptimeIpcVersion !== UPTIME_IPC_VERSION || typeof response.ok !== 'boolean') {
    const error = new Error('The Uptime service returned an unsupported response.');
    error.code = 'UPTIME_IPC_RESPONSE_INVALID';
    error.category = 'ipc';
    throw error;
  }
  if (response.ok) return response.value;
  const error = new Error(String(response.error?.message || 'Could not complete the Uptime operation.'));
  error.code = String(response.error?.code || 'UPTIME_OPERATION_FAILED');
  error.category = String(response.error?.category || 'uptime');
  throw error;
}

module.exports = {
  UPTIME_IPC_VERSION,
  safeUptimeIpcError,
  unwrapUptimeIpc,
  wrapUptimeIpc
};
