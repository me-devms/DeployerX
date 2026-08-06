const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runMonitorCheck, sanitizedHeaders, statusMatches } = require('./check-engine');
const { UptimeControlDatabase } = require('./control-database');
const { normalizeMonitorInput } = require('./domain');
const { UptimeIncidentPolicyService } = require('./incident-policy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function monitor(input = {}) {
  return normalizeMonitorInput({
    name: 'Production API',
    type: 'http',
    intervalSec: 60,
    timeoutMs: 2000,
    config: { url: 'https://example.test/health', method: 'GET', expectedStatusRanges: ['200-299'] },
    alertPolicy: { failureThreshold: 2, recoveryThreshold: 1 },
    ...input
  });
}

test('matches status ranges and removes sensitive response headers', () => {
  assert.equal(statusMatches(204, [{ minimum: 200, maximum: 299 }]), true);
  assert.equal(statusMatches(500, [{ minimum: 200, maximum: 299 }]), false);
  assert.deepEqual(sanitizedHeaders({ 'content-type': 'text/plain', 'set-cookie': 'session=secret', 'x-api-key': 'secret' }), { 'content-type': 'text/plain' });
});

test('runs redirected HTTP checks with secret headers and JSONPath assertions', async (context) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/health' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=secret' });
    response.end(JSON.stringify({ ok: true, service: { state: 'ready' } }));
  });
  const address = await listen(server);
  context.after(() => close(server));
  const configured = monitor({
    config: {
      url: `http://127.0.0.1:${address.port}/redirect`,
      method: 'GET',
      secretHeaderRefs: { authorization: 'secret-auth' },
      expectedStatusRanges: ['200-299'],
      assertions: [
        { target: 'jsonpath', selector: '$.ok', operator: 'equals', expected: 'true' },
        { target: 'header', selector: 'content-type', operator: 'contains', expected: 'application/json' },
        { target: 'body', operator: 'contains', expected: 'ready' }
      ]
    }
  });
  const result = await runMonitorCheck(configured, { secretResolver: async (id) => id === 'secret-auth' ? 'Bearer runtime-secret' : '' });
  assert.equal(result.outcome, 'up');
  assert.equal(result.statusCode, 200);
  assert.equal(result.details.redirects.length, 1);
  assert.equal(result.details.assertions.every((assertion) => assertion.passed), true);
  assert.equal(requests[1].authorization, 'Bearer runtime-secret');
  assert.equal(JSON.stringify(result).includes('runtime-secret'), false);
  assert.equal(JSON.stringify(result).includes('session=secret'), false);
});

test('reports HTTP status, assertion, and bounded-response failures', async (context) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/large') {
      response.writeHead(200);
      response.end('x'.repeat(2048));
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"ok":false}');
  });
  const address = await listen(server);
  context.after(() => close(server));
  const failed = await runMonitorCheck(monitor({ config: { url: `http://127.0.0.1:${address.port}/down`, expectedStatusRanges: ['200-299'] } }));
  assert.equal(failed.outcome, 'down');
  assert.equal(failed.failureCategory, 'http-status');
  const large = await runMonitorCheck(monitor({ config: { url: `http://127.0.0.1:${address.port}/large`, expectedStatusRanges: [200] } }), { maximumResponseBytes: 128 });
  assert.equal(large.outcome, 'down');
  assert.equal(large.failureCategory, 'response-size');
});

test('runs TCP checks and applies warning and critical latency policies', async (context) => {
  const server = net.createServer((socket) => socket.end());
  const address = await listen(server);
  context.after(() => close(server));
  const configured = monitor({ type: 'tcp', config: { host: '127.0.0.1', port: address.port }, alertPolicy: { failureThreshold: 2, recoveryThreshold: 1, latencyWarningMs: 120000 } });
  const result = await runMonitorCheck(configured);
  assert.equal(result.outcome, 'up');
  assert.match(result.summary, /TCP connection succeeded/);
});

test('classifies TLS certificate expiry with a fake secure socket', async () => {
  class FakeTlsSocket extends EventEmitter {
    constructor() { super(); this.authorized = true; this.authorizationError = null; }
    setTimeout() {}
    destroy() {}
    getPeerCertificate() {
      return {
        subject: { CN: 'example.test' }, issuer: { CN: 'Test CA' },
        valid_from: new Date(Date.now() - 86400000).toISOString(),
        valid_to: new Date(Date.now() + 5 * 86400000).toISOString(), fingerprint256: 'AA:BB'
      };
    }
  }
  const result = await runMonitorCheck(monitor({ type: 'tls', config: { host: 'example.test', port: 443, expiryWarningDays: 30, expiryCriticalDays: 2 } }), {
    tlsConnect: (_options, callback) => { const socket = new FakeTlsSocket(); queueMicrotask(callback); return socket; }
  });
  assert.equal(result.outcome, 'warning');
  assert.equal(result.failureCategory, 'tls-expiry');
  assert.equal(result.details.certificate.subject, 'example.test');
});

async function policyFixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-policy-test-'));
  let nowMs = Date.parse('2026-08-04T10:00:00.000Z');
  const clock = () => new Date(nowMs).toISOString();
  const database = new UptimeControlDatabase({ rootPath, clock });
  await database.initialize();
  context.after(async () => { await database.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  const events = [];
  const service = new UptimeIncidentPolicyService({ controlDatabase: database, clock, notifier: async (event) => events.push(event) });
  return { database, service, events, clock, advance(milliseconds) { nowMs += milliseconds; } };
}

function policyResult(values, outcome, summary) {
  return { id: `check-${values.clock()}-${outcome}`, probeId: 'local-windows:test', scheduledAt: values.clock(), startedAt: values.clock(), completedAt: values.clock(), outcome, latencyMs: 50, statusCode: outcome === 'down' ? 503 : 200, failureCategory: outcome === 'down' ? 'http-status' : '', summary, details: {} };
}

test('opens after two failures and resolves after one successful check', async (context) => {
  const values = await policyFixture(context);
  let stored = await values.database.createMonitor('local', 'tester', monitor({ notificationRouteIds: ['notify-desktop'] }));
  let transition = await values.service.processCheck('local', 'worker', stored, policyResult(values, 'down', 'HTTP 503'));
  assert.equal(transition.monitor.runtime.status, 'warning');
  assert.deepEqual(transition.events.map((event) => event.type), ['uptime.warning']);
  assert.equal(await values.database.getActiveIncident('local', stored.id), null);

  values.advance(60000);
  stored = transition.monitor;
  transition = await values.service.processCheck('local', 'worker', stored, policyResult(values, 'down', 'HTTP 503 again'));
  assert.equal(transition.monitor.runtime.status, 'down');
  assert.equal(transition.incident.state, 'open');
  assert.deepEqual(transition.events.map((event) => event.type), ['uptime.incident.opened']);
  assert.deepEqual(transition.events[0].routeIds, ['notify-desktop']);

  values.advance(60000);
  transition = await values.service.processCheck('local', 'worker', transition.monitor, policyResult(values, 'up', 'HTTP 200'));
  assert.equal(transition.monitor.runtime.status, 'up');
  assert.equal(transition.incident.state, 'resolved');
  assert.equal(transition.monitor.runtime.activeIncidentId, null);
  assert.deepEqual(transition.events.map((event) => event.type), ['uptime.incident.resolved']);
});

test('escalates an open warning incident when a critical failure follows', async (context) => {
  const values = await policyFixture(context);
  let stored = await values.database.createMonitor('local', 'tester', monitor({ alertPolicy: { failureThreshold: 1, recoveryThreshold: 1 } }));
  let transition = await values.service.processCheck('local', 'worker', stored, policyResult(values, 'warning', 'Latency exceeded warning threshold'));
  assert.equal(transition.incident.severity, 'warning');
  assert.deepEqual(transition.events.map((event) => event.type), ['uptime.incident.opened']);
  values.advance(60000);
  stored = transition.monitor;
  transition = await values.service.processCheck('local', 'worker', stored, policyResult(values, 'down', 'HTTP 503'));
  assert.equal(transition.incident.severity, 'critical');
  assert.deepEqual(transition.events.map((event) => event.type), ['uptime.incident.escalated']);
});

test('maintenance records checks without opening incidents or sending notifications', async (context) => {
  const values = await policyFixture(context);
  const stored = await values.database.createMonitor('local', 'tester', monitor());
  const transition = await values.service.processCheck('local', 'worker', stored, policyResult(values, 'down', 'Maintenance failure'), { maintenance: true });
  assert.equal(transition.check.outcome, 'maintenance');
  assert.equal(transition.monitor.runtime.status, 'maintenance');
  assert.equal(transition.incident, null);
  assert.deepEqual(transition.events, []);
  assert.deepEqual(values.events, []);
});

test('emits a dedicated TLS expiry event on the first certificate warning', async (context) => {
  const values = await policyFixture(context);
  const stored = await values.database.createMonitor('local', 'tester', monitor({
    type: 'tls',
    config: { host: 'example.test', port: 443, expiryWarningDays: 30, expiryCriticalDays: 7 },
    notificationRouteIds: ['notify-desktop']
  }));
  const result = { ...policyResult(values, 'warning', 'TLS certificate expires in 14 days.'), statusCode: null, failureCategory: 'tls-expiry', details: { certificate: { daysRemaining: 14 } } };
  const transition = await values.service.processCheck('local', 'worker', stored, result);
  assert.deepEqual(transition.events.map((event) => event.type), ['uptime.tls-expiry', 'uptime.warning']);
  assert.deepEqual(transition.events[0].routeIds, ['notify-desktop']);
});

test('acknowledges an active incident with an audit event', async (context) => {
  const values = await policyFixture(context);
  let stored = await values.database.createMonitor('local', 'tester', monitor());
  let transition = await values.service.processCheck('local', 'worker', stored, policyResult(values, 'down', 'First failure'));
  values.advance(60000);
  transition = await values.service.processCheck('local', 'worker', transition.monitor, policyResult(values, 'down', 'Second failure'));
  values.advance(1000);
  const acknowledged = await values.service.acknowledge('local', 'operator-1', transition.incident.id, transition.incident.revision, 'Investigating upstream.');
  assert.equal(acknowledged.state, 'acknowledged');
  assert.equal(acknowledged.events.at(-1).actorId, 'operator-1');
  assert.equal(values.events.at(-1).type, 'uptime.incident.acknowledged');
});
