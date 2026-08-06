const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { BackupNotificationService, normalizeRouteInput, webhookPayload } = require('./notifications');

const WORKSPACE_ID = 'local';
const ACTOR_ID = 'tester';

class MemorySecretStore {
  constructor() {
    this.values = new Map();
    this.deleted = [];
    this.sequence = 0;
  }

  async create(input) {
    this.sequence += 1;
    const id = `sec_notification_${this.sequence}`;
    const ref = {
      id, workspaceId: input.workspaceId, name: input.name, provider: 'electron-safe-storage', scope: input.scope || 'device',
      providerKey: `notification/${id}`, secretType: input.secretType, version: 1, revision: 1,
      createdAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-03T12:00:00.000Z', createdBy: input.actorId, updatedBy: input.actorId,
      expiresAt: null, lastValidatedAt: null
    };
    this.values.set(`${input.workspaceId}:${id}`, input.value);
    return ref;
  }

  async resolve({ workspaceId, id }) {
    if (!this.values.has(`${workspaceId}:${id}`)) throw new Error('Secret not found.');
    return this.values.get(`${workspaceId}:${id}`);
  }

  async delete({ workspaceId, id }) {
    this.deleted.push(id);
    this.values.delete(`${workspaceId}:${id}`);
  }
}

async function fixture(context, options = {}) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-notifications-test-'));
  let currentMs = Date.parse(options.now || '2026-08-03T12:00:00.000Z');
  const clock = () => new Date(currentMs).toISOString();
  const database = new BackupControlDatabase({ rootPath, clock });
  await database.initialize();
  context.after(async () => {
    await database.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });
  const secretStore = new MemorySecretStore();
  const deliveries = [];
  const email = { configurations: [], messages: [] };
  const service = new BackupNotificationService({
    controlDatabase: database,
    secretStore,
    clock,
    now: () => currentMs,
    randomUUID: () => 'test-delivery-id',
    fetchImpl: options.fetchImpl || (async (url, request) => { deliveries.push({ url, request }); return { status: 204 }; }),
    desktopNotifier: async (message) => deliveries.push({ desktop: message }),
    mailerFactory: (configuration) => {
      email.configurations.push(configuration);
      return { sendMail: async (message) => { email.messages.push(message); return { messageId: 'smtp-message-id' }; } };
    }
  });
  return { database, secretStore, service, deliveries, email, clock, now: () => currentMs, advance: (milliseconds) => { currentMs += milliseconds; } };
}

async function createRouteAndJob(fixtureValues, routeInput, policyChanges = {}) {
  const { database, service } = fixtureValues;
  const route = await service.createRoute(WORKSPACE_ID, ACTOR_ID, routeInput);
  const connection = await database.repository('connection').create({
    workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, name: `Local ${route.id}`, kind: 'local', adapterId: 'deployerx.connection.local', secretRefIds: [], workerAffinity: ['device:test'], lastTest: { status: 'success' }
  });
  const source = await database.repository('source').create({
    workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, name: `Source ${route.id}`, connectionId: connection.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true
  });
  const repository = await database.repository('repository').create({
    workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, name: `Repository ${route.id}`, connectionId: null, adapterId: 'deployerx.repository.local', engineId: 'deployerx.file-repository', secretRefIds: [], workerAffinity: ['device:test']
  });
  const policy = await database.repository('policy').create({
    workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, name: `Policy ${route.id}`, enabled: true, backupMode: 'incremental',
    schedule: { type: 'manual' }, notificationRouteIds: [route.id], objectives: { rpoMinutes: null }, ...policyChanges
  });
  const job = await database.repository('backupJob').create({
    workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, name: `Job ${route.id}`, sourceId: source.id, policyId: policy.id, state: 'enabled',
    repositoryBindings: [{ repositoryId: repository.id, role: 'primary', order: 0 }], lastSuccessfulRunId: null, nextRunAt: null
  });
  return { route, connection, source, repository, policy, job };
}

test('normalizes secret-safe desktop, SMTP, and webhook route configurations', () => {
  assert.deepEqual(normalizeRouteInput({ name: 'Desktop', type: 'desktop', events: ['backup.failed'] }).config, { silent: false });
  const email = normalizeRouteInput({ name: 'Email', type: 'email', smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecure: false, smtpUsername: 'alerts', smtpPassword: 'secret', from: 'alerts@example.test', to: 'one@example.test, two@example.test', events: ['backup.failed'] });
  assert.equal(email.config.host, 'smtp.example.test');
  assert.deepEqual(email.config.recipients, ['one@example.test', 'two@example.test']);
  assert.equal(email.secrets[0].value, 'secret');
  const webhook = normalizeRouteInput({ name: 'Hook', type: 'webhook', webhookUrl: 'https://hooks.example.test/private?token=secret', events: ['backup.failed'] });
  assert.deepEqual(webhook.config, { destinationHost: 'hooks.example.test', allowInsecure: false });
  assert.equal(JSON.stringify(webhook.config).includes('secret'), false);
  assert.throws(() => normalizeRouteInput({ name: 'Bad', type: 'webhook', webhookUrl: 'http://example.test/hook', events: ['backup.failed'] }), /HTTPS/);
});

test('delivers a backup event once and persists bounded public delivery evidence', async (context) => {
  const values = await fixture(context);
  const { route, job } = await createRouteAndJob(values, { name: 'Operations webhook', type: 'webhook', webhookUrl: 'https://hooks.example.test/private?token=secret', events: ['backup.succeeded'] });
  const run = { id: 'run_success', jobId: job.id, state: 'succeeded', attempt: 1, finishedAt: values.clock(), result: { recoveryPointIds: ['point_success'], warnings: [] } };
  await values.service.notifyBackupRun(WORKSPACE_ID, run);
  await values.service.notifyBackupRun(WORKSPACE_ID, run);

  assert.equal(values.deliveries.length, 1);
  assert.equal(values.deliveries[0].url, 'https://hooks.example.test/private?token=secret');
  assert.equal(values.deliveries[0].request.headers['x-deployerx-event'], 'backup.succeeded');
  const sentPayload = JSON.parse(values.deliveries[0].request.body);
  assert.equal(sentPayload.resource.runId, run.id);
  assert.equal(JSON.stringify(sentPayload).includes('token=secret'), false);
  const [listed] = await values.service.listRoutes(WORKSPACE_ID);
  assert.equal(listed.id, route.id);
  assert.equal(listed.lastDelivery.status, 'succeeded');
  assert.equal(listed.hasSecret, true);
  assert.equal(JSON.stringify(listed).includes('token=secret'), false);
  const history = await values.service.listDeliveries(WORKSPACE_ID);
  assert.equal(history.length, 1);
  assert.equal(history[0].eventType, 'backup.succeeded');
});

test('defers failed delivery retries and succeeds after the bounded retry time', async (context) => {
  let calls = 0;
  const values = await fixture(context, { fetchImpl: async () => { calls += 1; return { status: calls === 1 ? 503 : 204 }; } });
  const { job } = await createRouteAndJob(values, { name: 'Retry webhook', type: 'webhook', webhookUrl: 'https://hooks.example.test/retry', events: ['backup.failed'] });
  const event = { type: 'backup.failed', eventKey: 'retry-event', title: 'Backup failed', body: 'Safe failure.', jobId: job.id, runId: 'run_failed' };
  const [first] = await values.service.dispatchEvent(WORKSPACE_ID, event);
  assert.equal(first.status, 'failed');
  assert.equal(first.attempt, 1);
  assert.ok(first.nextAttemptAt);
  await values.service.dispatchEvent(WORKSPACE_ID, event);
  assert.equal(calls, 1);
  values.advance(5 * 60 * 1000 + 1);
  const [second] = await values.service.dispatchEvent(WORKSPACE_ID, event);
  assert.equal(calls, 2);
  assert.equal(second.status, 'succeeded');
  assert.equal(second.attempt, 2);
});

test('delivers desktop and authenticated SMTP notifications without projecting secrets', async (context) => {
  const values = await fixture(context);
  const desktop = await createRouteAndJob(values, { name: 'Desktop alerts', type: 'desktop', events: ['backup.succeeded'] });
  const emailRoute = await values.service.createRoute(WORKSPACE_ID, ACTOR_ID, {
    name: 'Email alerts', type: 'email', smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecure: true,
    smtpUsername: 'backup-alerts', smtpPassword: 'smtp-secret', from: 'alerts@example.test', to: ['oncall@example.test'], events: ['backup.succeeded']
  });
  const policy = await values.database.repository('policy').get(WORKSPACE_ID, desktop.policy.id);
  await values.database.repository('policy').update(WORKSPACE_ID, policy.id, { notificationRouteIds: [desktop.route.id, emailRoute.id] }, { expectedRevision: policy.revision, actorId: ACTOR_ID });
  await values.service.notifyBackupRun(WORKSPACE_ID, { id: 'run_channels', jobId: desktop.job.id, state: 'succeeded', attempt: 1, finishedAt: values.clock(), result: { warnings: [] } });

  assert.equal(values.deliveries.filter((entry) => entry.desktop).length, 1);
  assert.equal(values.email.configurations[0].auth.user, 'backup-alerts');
  assert.equal(values.email.configurations[0].auth.pass, 'smtp-secret');
  assert.equal(values.email.messages[0].to, 'oncall@example.test');
  const listed = await values.service.listRoutes(WORKSPACE_ID);
  assert.equal(JSON.stringify(listed).includes('smtp-secret'), false);
});

test('emits one overdue RPO event per successful-backup baseline', async (context) => {
  const values = await fixture(context, { now: '2026-08-03T12:00:00.000Z' });
  const seeded = await createRouteAndJob(values, { name: 'RPO desktop', type: 'desktop', events: ['backup.rpo-overdue'] }, { objectives: { rpoMinutes: 30 } });
  values.advance(31 * 60 * 1000);
  const first = await values.service.evaluateOverdueRpo(WORKSPACE_ID);
  const duplicate = await values.service.evaluateOverdueRpo(WORKSPACE_ID);
  assert.equal(first.length, 1);
  assert.equal(first[0].eventType, 'backup.rpo-overdue');
  assert.equal(duplicate.length, 1);
  assert.equal(values.deliveries.filter((entry) => entry.desktop).length, 1);
  assert.match(first[0].body, /30-minute recovery point objective/);
  assert.equal(first[0].jobId, seeded.job.id);
});

test('notifies recovery-test results and deletes routes with policy and SecretRef cleanup', async (context) => {
  const values = await fixture(context);
  const seeded = await createRouteAndJob(values, { name: 'Recovery test hook', type: 'slack', webhookUrl: 'https://hooks.slack.test/private', events: ['recovery-test.warning'] });
  await values.service.notifyVerificationRun(WORKSPACE_ID, {
    id: 'verification_warning', state: 'warning', mode: 'checksum', recoveryPointId: null, repositoryId: seeded.repository.id,
    completedAt: values.clock(), progress: { filesVerified: 3, bytesVerified: 1024 }, result: { filesVerified: 3, bytesVerified: 1024 }
  });
  assert.equal(values.deliveries.length, 1);
  const slack = webhookPayload({ type: 'slack' }, { title: 'Title', body: 'Body' });
  assert.equal(slack.text, 'Title\nBody');

  const routeRecord = await values.database.repository('notificationRoute').get(WORKSPACE_ID, seeded.route.id);
  const [secretId] = routeRecord.secretRefIds;
  const deleted = await values.service.deleteRoute(WORKSPACE_ID, ACTOR_ID, seeded.route.id, routeRecord.revision);
  assert.equal(deleted.deleted, true);
  const policy = await values.database.repository('policy').get(WORKSPACE_ID, seeded.policy.id);
  assert.deepEqual(policy.notificationRouteIds, []);
  assert.equal(await values.database.repository('notificationRoute').get(WORKSPACE_ID, seeded.route.id), null);
  assert.equal(await values.database.repository('secretRef').get(WORKSPACE_ID, secretId), null);
  assert.ok(values.secretStore.deleted.includes(secretId));
});

test('delivers Uptime events only to explicitly assigned compatible routes', async (context) => {
  const values = await fixture(context);
  const uptimeRoute = await values.service.createRoute(WORKSPACE_ID, ACTOR_ID, {
    name: 'Uptime desktop', type: 'desktop', events: ['uptime.incident.opened', 'uptime.incident.resolved']
  });
  const backupRoute = await values.service.createRoute(WORKSPACE_ID, ACTOR_ID, {
    name: 'Backup-only desktop', type: 'desktop', events: ['backup.failed']
  });
  const event = {
    type: 'uptime.incident.opened',
    eventKey: 'uptime-incident:incident-1:opened',
    occurredAt: values.clock(),
    title: 'Down: Production API',
    body: 'HTTP 503 was outside the expected status range.',
    monitorId: 'monitor-1',
    incidentId: 'incident-1',
    projectId: 'project-1',
    details: { failureCategory: 'http-status', statusCode: 503 }
  };
  const first = await values.service.dispatchEventToRoutes(WORKSPACE_ID, [uptimeRoute.id, backupRoute.id], event);
  const duplicate = await values.service.dispatchEventToRoutes(WORKSPACE_ID, [uptimeRoute.id, backupRoute.id], event);
  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 1);
  assert.equal(values.deliveries.filter((entry) => entry.desktop).length, 1);
  assert.equal(first[0].monitorId, 'monitor-1');
  assert.equal(first[0].incidentId, 'incident-1');
  assert.equal(first[0].projectId, 'project-1');
  assert.equal((await values.service.listDeliveries(WORKSPACE_ID, { monitorId: 'monitor-1' })).length, 1);
  assert.equal((await values.service.listDeliveries(WORKSPACE_ID, { incidentId: 'incident-1' })).length, 1);
  assert.equal((await values.service.listDeliveries(WORKSPACE_ID, { projectId: 'project-1' })).length, 1);
  assert.equal((await values.service.listDeliveries(WORKSPACE_ID, { monitorId: 'monitor-2' })).length, 0);
});

test('delivers every supported Uptime lifecycle event through a subscribed route', async (context) => {
  const values = await fixture(context);
  const eventTypes = [
    'uptime.warning',
    'uptime.incident.opened',
    'uptime.incident.escalated',
    'uptime.incident.acknowledged',
    'uptime.incident.resolved',
    'uptime.tls-expiry',
    'uptime.worker-health'
  ];
  const route = await values.service.createRoute(WORKSPACE_ID, ACTOR_ID, { name: 'All Uptime events', type: 'desktop', events: eventTypes });
  for (const [index, type] of eventTypes.entries()) {
    const deliveries = await values.service.dispatchEventToRoutes(WORKSPACE_ID, [route.id], {
      type,
      eventKey: `uptime-lifecycle:${index}`,
      occurredAt: values.clock(),
      title: type,
      body: 'Safe lifecycle evidence.',
      monitorId: type === 'uptime.worker-health' ? null : 'monitor-all-events',
      incidentId: type.includes('incident.') ? 'incident-all-events' : null
    });
    assert.equal(deliveries.length, 1, type);
    assert.equal(deliveries[0].eventType, type);
  }
  assert.equal(values.deliveries.filter((entry) => entry.desktop).length, eventTypes.length);
  assert.deepEqual((await values.service.listDeliveries(WORKSPACE_ID)).map((delivery) => delivery.eventType).sort(), [...eventTypes].sort());
});
