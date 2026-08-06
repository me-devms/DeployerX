const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessions = new Map();

function respond(request, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', protocolVersion: 1, id: request.id, result })}\n`);
}

input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.id) {
    if (request.method === 'system.shutdown') process.exit(0);
    return;
  }
  if (request.method === 'system.health') {
    respond(request, { status: 'ready', protocolVersion: 1, hostVersion: 'test' });
    return;
  }
  if (request.method === 'connection.test') {
    if (request.params.connection?.settings?.mode === 'slow') return;
    if (request.params.connection?.settings?.mode === 'remote-error') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', protocolVersion: 1, id: request.id,
        error: { code: 'DATABASE_AUTH_FAILED', message: `password=${request.params.connection.credentials.password}`, data: { safeMessage: 'Authentication failed.', retryable: false } }
      })}\n`);
      return;
    }
    respond(request, { status: 'success', latencyMs: 4, serverVersion: 'fixture-1', database: request.params.connection.database, readOnly: request.params.connection.accessMode === 'read-only' });
    return;
  }
  if (request.method === 'connection.open') {
    sessions.set(request.params.sessionId, request.params.connection);
    respond(request, {
      status: 'success',
      connectionMode: 'physical-pool',
      evidence: { status: 'success', latencyMs: 4, serverVersion: 'fixture-1', database: request.params.connection.database, readOnly: request.params.connection.accessMode === 'read-only' }
    });
    return;
  }
  if (request.method === 'connection.status') {
    const connection = sessions.get(request.params.sessionId);
    respond(request, connection?.settings?.mode === 'health-failure'
      ? { status: 'failed', connectionMode: 'physical-pool', code: 'DATABASE_FIXTURE_HEALTH_FAILED', retryable: true }
      : { status: connection ? 'ready' : 'closed', connectionMode: 'physical-pool' });
    return;
  }
  if (request.method === 'connection.close') {
    respond(request, { status: 'closed', closed: sessions.delete(request.params.sessionId) });
    return;
  }
  if (request.method === 'query.execute_session') {
    respond(request, { columns: [], rows: [[sessions.get(request.params.sessionId)?.database || null]], affectedRows: 0 });
    return;
  }
  if (request.method === 'schema.snapshot_session') {
    respond(request, { database: sessions.get(request.params.sessionId)?.database || 'main', schemas: [], truncated: false, warnings: [] });
    return;
  }
  if (request.method === 'schema.snapshot') {
    respond(request, { database: request.params.connection.database || 'main', schemas: [{ name: 'public', tables: [{ name: 'orders', type: 'table', columns: [{ name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true, defaultValue: null }] }] }], truncated: false, warnings: [] });
    return;
  }
  respond(request, { columns: [], rows: [], affectedRows: 0 });
});
