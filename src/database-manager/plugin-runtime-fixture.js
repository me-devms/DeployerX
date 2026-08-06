const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const supportsSettings = process.env.DEPLOYERX_DATABASE_PLUGIN_ID === 'vendor.settings';
let activeSettings = {};

input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.id) {
    if (request.method === 'system.shutdown') process.exit(0);
    return;
  }
  let result;
  if (request.method === 'health') result = { status: 'ready' };
  else if (request.method === 'initialize' && supportsSettings) {
    activeSettings = structuredClone(request.params.settings || {});
    result = null;
  }
  else if (request.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
    return;
  }
  else if (request.method === 'test_connection' && supportsSettings) {
    const params = request.params.params;
    const profile = params.settings?.profile;
    const settingsMatch = activeSettings.profile === profile && activeSettings.extra_properties === `ApplicationName=${String(profile || '').toUpperCase()}`;
    const db2Match = !activeSettings.requireDb2Parts || (params.host === 'db.example.test' && params.port === 50001 && params.database === 'sample' && params.username === 'db2 user' && params.password === 'private password');
    result = settingsMatch && db2Match ? null : { success: false };
  }
  else if (request.method === 'test_connection' && request.params.params.settings?.mode === 'remote-error') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 'DATABASE_PRIVATE_TOKEN_VALUE', data: { safeMessage: `Reflected ${request.params.params.token}`, retryable: true, details: { token: request.params.params.token } } } })}\n`);
    return;
  } else if (request.method === 'test_connection' && request.params.params.settings?.requireConnectionUriDatabase
    && request.params.params.database !== request.params.params.connection_uri) result = { success: false };
  else if (request.method === 'test_connection') result = { status: 'success', latencyMs: 3, database: request.params.params.database, readOnly: false };
  else if (request.method === 'inspect_settings') result = activeSettings;
  else if (request.method === 'execute_query' && supportsSettings) result = { columns: ['id'], rows: [[1]], affected_rows: 0, pagination: { page: request.params.page, page_size: request.params.limit, total_rows: 1, has_more: false } };
  else if (request.method === 'get_schema_snapshot') result = { database: request.params.params.database, schemas: [], truncated: false, warnings: [] };
  else result = { columns: ['id'], rows: [[1]], affected_rows: 0, executionTimeMs: 1, pagination: { page: request.params.page, page_size: request.params.page_size, total_rows: 1, has_more: false } };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
