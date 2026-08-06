const crypto = require('crypto');

const NOTIFICATION_EVENTS = Object.freeze([
  'backup.succeeded',
  'backup.warning',
  'backup.failed',
  'backup.rpo-overdue',
  'recovery-test.succeeded',
  'recovery-test.warning',
  'recovery-test.failed',
  'uptime.warning',
  'uptime.incident.opened',
  'uptime.incident.escalated',
  'uptime.incident.acknowledged',
  'uptime.incident.resolved',
  'uptime.tls-expiry',
  'uptime.worker-health'
]);
const NOTIFICATION_EVENT_SET = new Set(NOTIFICATION_EVENTS);
const ROUTE_TYPES = new Set(['desktop', 'email', 'webhook', 'slack', 'teams']);
const MAX_DELIVERY_HISTORY = 100;
const MAX_DELIVERY_LIST = 500;
const MAX_RECIPIENTS = 20;
const DELIVERY_TIMEOUT_MS = 15000;
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

class BackupNotificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'BackupNotificationError';
    this.code = code;
    this.category = options.category || 'notification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new BackupNotificationError('NOTIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function optionalText(value, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.includes('\0') || text.length > maximumLength) throw new BackupNotificationError('NOTIFICATION_INPUT_INVALID', 'Notification input is invalid.', { category: 'validation' });
  return text;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new BackupNotificationError('NOTIFICATION_INPUT_INVALID', `${label} must be between ${minimum} and ${maximum}.`, { category: 'validation' });
  return number;
}

function isoTime(value, label = 'Notification time') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BackupNotificationError('NOTIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return date.toISOString();
}

function normalizeEvents(values, fallback = NOTIFICATION_EVENTS) {
  const source = values === undefined ? fallback : values;
  if (!Array.isArray(source)) throw new BackupNotificationError('NOTIFICATION_EVENTS_INVALID', 'Notification events are invalid.', { category: 'validation' });
  const events = [...new Set(source.map((value) => String(value || '').trim()))];
  if (!events.length || events.some((event) => !NOTIFICATION_EVENT_SET.has(event))) throw new BackupNotificationError('NOTIFICATION_EVENTS_INVALID', 'Choose at least one supported notification event.', { category: 'validation' });
  return events.sort((left, right) => NOTIFICATION_EVENTS.indexOf(left) - NOTIFICATION_EVENTS.indexOf(right));
}

function normalizeRecipients(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const recipients = [...new Set(source.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean))];
  if (!recipients.length || recipients.length > MAX_RECIPIENTS || recipients.some((entry) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry) || entry.length > 254)) {
    throw new BackupNotificationError('NOTIFICATION_EMAIL_INVALID', `Email recipients must contain between 1 and ${MAX_RECIPIENTS} valid addresses.`, { category: 'validation' });
  }
  return recipients;
}

function normalizeWebhookUrl(value, allowInsecure = false) {
  let parsed;
  try { parsed = new URL(requiredText(value, 'Webhook URL', 4096)); } catch (error) {
    if (error instanceof BackupNotificationError) throw error;
    throw new BackupNotificationError('NOTIFICATION_WEBHOOK_URL_INVALID', 'Webhook URL is invalid.', { category: 'validation' });
  }
  if (parsed.username || parsed.password || parsed.hash) throw new BackupNotificationError('NOTIFICATION_WEBHOOK_URL_INVALID', 'Webhook URLs cannot contain credentials or fragments.', { category: 'validation' });
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:') && !(loopback && parsed.protocol === 'http:')) {
    throw new BackupNotificationError('NOTIFICATION_WEBHOOK_HTTPS_REQUIRED', 'Webhook destinations must use HTTPS unless insecure HTTP is explicitly allowed.', { category: 'validation' });
  }
  return parsed.toString();
}

function normalizeRouteInput(input = {}) {
  const type = requiredText(input.type, 'Route type', 40);
  if (!ROUTE_TYPES.has(type)) throw new BackupNotificationError('NOTIFICATION_ROUTE_TYPE_INVALID', 'Notification route type is invalid.', { category: 'validation' });
  const normalized = {
    name: requiredText(input.name, 'Route name', 200),
    type,
    enabled: input.enabled !== false,
    events: normalizeEvents(input.events),
    config: {},
    secrets: []
  };
  if (type === 'desktop') {
    normalized.config = { silent: Boolean(input.silent) };
    return normalized;
  }
  if (type === 'email') {
    const host = requiredText(input.smtpHost, 'SMTP host', 253).toLowerCase();
    if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.')) throw new BackupNotificationError('NOTIFICATION_EMAIL_INVALID', 'SMTP host is invalid.', { category: 'validation' });
    const username = optionalText(input.smtpUsername, 320);
    const password = String(input.smtpPassword || '');
    if (username && !password) throw new BackupNotificationError('NOTIFICATION_EMAIL_AUTH_INVALID', 'SMTP password is required when a username is configured.', { category: 'validation' });
    if (!username && password) throw new BackupNotificationError('NOTIFICATION_EMAIL_AUTH_INVALID', 'SMTP username is required when a password is configured.', { category: 'validation' });
    normalized.config = {
      host,
      port: boundedInteger(input.smtpPort, input.smtpSecure === false ? 587 : 465, 1, 65535, 'SMTP port'),
      secure: input.smtpSecure !== false,
      username,
      from: requiredText(input.from, 'Sender address', 320),
      recipients: normalizeRecipients(input.to)
    };
    if (password) normalized.secrets.push({ name: `${normalized.name} SMTP password`, secretType: 'password', value: password });
    return normalized;
  }
  const allowInsecure = Boolean(input.allowInsecure);
  const webhookUrl = normalizeWebhookUrl(input.webhookUrl, allowInsecure);
  const parsed = new URL(webhookUrl);
  normalized.config = { destinationHost: parsed.host, allowInsecure: parsed.protocol === 'http:' };
  normalized.secrets.push({ name: `${normalized.name} ${type} URL`, secretType: 'token', value: webhookUrl });
  return normalized;
}

function publicRoute(route) {
  return {
    id: route.id,
    name: route.name,
    type: route.type,
    enabled: Boolean(route.enabled),
    events: [...(route.events || [])],
    config: structuredClone(route.config || {}),
    hasSecret: Boolean(route.secretRefIds?.length),
    lastDelivery: route.lastDelivery ? structuredClone(route.lastDelivery) : null,
    deliveryCount: Array.isArray(route.deliveryHistory) ? route.deliveryHistory.length : 0,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
    revision: route.revision
  };
}

function secretMetadataInput(ref, actorId) {
  return { ...ref, actorId, id: ref.id, workspaceId: ref.workspaceId, name: ref.name, provider: ref.provider, scope: ref.scope, providerKey: ref.providerKey, secretType: ref.secretType, version: ref.version };
}

function safeDeliveryError(error) {
  const known = error instanceof BackupNotificationError;
  return {
    safeErrorCode: known ? error.code : 'NOTIFICATION_DELIVERY_FAILED',
    safeMessage: known ? String(error.message).slice(0, 300) : 'DeployerX could not deliver the notification.',
    category: known ? error.category : 'notification',
    retryable: known ? error.retryable : true
  };
}

function normalizeEvent(input = {}, clock = () => new Date().toISOString()) {
  const type = requiredText(input.type, 'Notification event', 80);
  if (!NOTIFICATION_EVENT_SET.has(type)) throw new BackupNotificationError('NOTIFICATION_EVENT_INVALID', 'Notification event is invalid.', { category: 'validation' });
  const defaultSeverity = type.endsWith('.failed') || type === 'backup.rpo-overdue' || type === 'uptime.incident.opened' || type === 'uptime.incident.escalated' || type === 'uptime.worker-health' ? 'critical' : type.endsWith('.warning') || type === 'uptime.warning' || type === 'uptime.tls-expiry' ? 'warning' : 'info';
  const severity = ['info', 'warning', 'critical'].includes(input.severity) ? input.severity : defaultSeverity;
  return {
    type,
    eventKey: requiredText(input.eventKey, 'Notification event key', 400),
    occurredAt: isoTime(input.occurredAt || clock()),
    severity,
    title: requiredText(input.title, 'Notification title', 200),
    body: requiredText(input.body, 'Notification body', 2000),
    jobId: optionalText(input.jobId, 200),
    runId: optionalText(input.runId, 200),
    verificationRunId: optionalText(input.verificationRunId, 200),
    recoveryPointId: optionalText(input.recoveryPointId, 200),
    repositoryId: optionalText(input.repositoryId, 200),
    monitorId: optionalText(input.monitorId, 200),
    incidentId: optionalText(input.incidentId, 200),
    projectId: optionalText(input.projectId, 200),
    details: input.details && typeof input.details === 'object' && !Array.isArray(input.details) ? structuredClone(input.details) : {}
  };
}

function retryDelay(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, Math.min(10, Number(attempt || 1) - 1))));
}

function webhookPayload(route, event) {
  const text = `${event.title}\n${event.body}`;
  if (route.type === 'slack') return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${event.title}*\n${event.body}` } }] };
  if (route.type === 'teams') return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', weight: 'Bolder', text: event.title }, { type: 'TextBlock', wrap: true, text: event.body }] } }] };
  return { schemaVersion: 1, source: 'DeployerX', event: event.type, eventKey: event.eventKey, occurredAt: event.occurredAt, severity: event.severity, title: event.title, body: event.body, resource: { jobId: event.jobId, runId: event.runId, verificationRunId: event.verificationRunId, recoveryPointId: event.recoveryPointId, repositoryId: event.repositoryId, monitorId: event.monitorId, incidentId: event.incidentId, projectId: event.projectId }, details: event.details };
}

class BackupNotificationService {
  constructor({ controlDatabase, secretStore, desktopNotifier = null, fetchImpl = global.fetch, mailerFactory = null, clock = () => new Date().toISOString(), now = () => Date.now(), randomUUID = crypto.randomUUID, deliveryTimeoutMs = DELIVERY_TIMEOUT_MS } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Control database and SecretRef store are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.desktopNotifier = desktopNotifier;
    this.fetchImpl = fetchImpl;
    this.mailerFactory = mailerFactory;
    this.clock = clock;
    this.now = now;
    this.randomUUID = randomUUID;
    this.deliveryTimeoutMs = boundedInteger(deliveryTimeoutMs, DELIVERY_TIMEOUT_MS, 1000, 120000, 'Notification delivery timeout');
    this.routeLocks = new Map();
  }

  async listRoutes(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    return (await this.controlDatabase.repository('notificationRoute').list(tenant, { limit: 1000 })).map(publicRoute);
  }

  async createRoute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const normalized = normalizeRouteInput(input);
    const refs = [];
    try {
      for (const secret of normalized.secrets) {
        refs.push(await this.secretStore.create({ workspaceId: tenant, actorId: actor, name: secret.name, secretType: secret.secretType, value: secret.value, scope: 'device' }));
      }
      const route = await this.controlDatabase.transaction((transaction) => {
        for (const ref of refs) transaction.create('secretRef', secretMetadataInput(ref, actor));
        return transaction.create('notificationRoute', {
          workspaceId: tenant,
          actorId: actor,
          name: normalized.name,
          type: normalized.type,
          enabled: normalized.enabled,
          config: normalized.config,
          secretRefIds: refs.map((ref) => ref.id),
          events: normalized.events,
          lastDelivery: null,
          deliveryHistory: []
        });
      });
      return publicRoute(route);
    } catch (error) {
      await Promise.allSettled(refs.map((ref) => this.secretStore.delete({ workspaceId: tenant, id: ref.id })));
      throw error;
    }
  }

  async updateRoute(workspaceId, actorId, routeId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(routeId, 'Notification route ID', 200);
    const current = await this.controlDatabase.repository('notificationRoute').get(tenant, id);
    if (!current) throw new BackupNotificationError('NOTIFICATION_ROUTE_NOT_FOUND', 'Notification route was not found.', { category: 'not-found' });
    const changes = {};
    if (input.name !== undefined) changes.name = requiredText(input.name, 'Route name', 200);
    if (input.enabled !== undefined) changes.enabled = Boolean(input.enabled);
    if (input.events !== undefined) changes.events = normalizeEvents(input.events);
    const updated = await this.controlDatabase.repository('notificationRoute').update(tenant, id, changes, { expectedRevision: Number(input.revision ?? current.revision), actorId: actor });
    return publicRoute(updated);
  }

  async deleteRoute(workspaceId, actorId, routeId, revision) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(routeId, 'Notification route ID', 200);
    const route = await this.controlDatabase.repository('notificationRoute').get(tenant, id);
    if (!route) return { id, deleted: false, absent: true };
    const expectedRevision = Number(revision ?? route.revision);
    if (expectedRevision !== route.revision) throw new BackupNotificationError('NOTIFICATION_ROUTE_REVISION_CONFLICT', 'Notification route changed before deletion.', { category: 'conflict' });
    const secretIds = [...(route.secretRefIds || [])];
    await this.controlDatabase.transaction((transaction) => {
      for (const policy of transaction.list('policy', tenant, { limit: 1000 })) {
        if (!(policy.notificationRouteIds || []).includes(id)) continue;
        transaction.update('policy', tenant, policy.id, { notificationRouteIds: policy.notificationRouteIds.filter((candidate) => candidate !== id) }, { expectedRevision: policy.revision, actorId: actor });
      }
      transaction.softDelete('notificationRoute', tenant, id, { expectedRevision, actorId: actor });
    });
    for (const secretId of secretIds) {
      await this.secretStore.delete({ workspaceId: tenant, id: secretId }).catch(() => {});
      const secret = await this.controlDatabase.repository('secretRef').get(tenant, secretId);
      if (secret) await this.controlDatabase.repository('secretRef').softDelete(tenant, secretId, { expectedRevision: secret.revision, actorId: actor }).catch(() => {});
    }
    return { id, deleted: true, absent: false };
  }

  async testRoute(workspaceId, routeId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(routeId, 'Notification route ID', 200);
    const event = normalizeEvent({
      type: 'backup.succeeded',
      eventKey: `route-test:${id}:${this.randomUUID()}`,
      occurredAt: this.clock(),
      title: 'DeployerX notification test',
      body: 'This route is configured to receive Backup Manager notifications.'
    }, this.clock);
    return this.#deliverTracked(tenant, id, event, { force: true, test: true });
  }

  async listDeliveries(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const limit = Math.max(1, Math.min(MAX_DELIVERY_LIST, Math.round(Number(options.limit) || 100)));
    const routes = await this.controlDatabase.repository('notificationRoute').list(tenant, { limit: 1000 });
    return routes.flatMap((route) => (route.deliveryHistory || []).map((delivery) => ({
      ...structuredClone(delivery),
      routeId: route.id,
      routeName: route.name,
      routeType: route.type
    }))).filter((delivery) => !options.status || delivery.status === options.status)
      .filter((delivery) => !options.monitorId || delivery.monitorId === options.monitorId)
      .filter((delivery) => !options.incidentId || delivery.incidentId === options.incidentId)
      .filter((delivery) => !options.projectId || delivery.projectId === options.projectId)
      .sort((left, right) => String(right.deliveredAt || right.attemptedAt || right.occurredAt).localeCompare(String(left.deliveredAt || left.attemptedAt || left.occurredAt)))
      .slice(0, limit);
  }

  async notifyBackupRun(workspaceId, run) {
    if (!run || !['succeeded', 'warning', 'failed'].includes(run.state)) return [];
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const job = await this.controlDatabase.repository('backupJob').get(tenant, run.jobId);
    if (!job) return [];
    const titles = { succeeded: 'Backup succeeded', warning: 'Backup completed with warnings', failed: 'Backup failed' };
    const bodies = {
      succeeded: `${job.name} completed successfully.`,
      warning: `${job.name} completed with ${Number(run.result?.warnings?.length || 0)} warning${Number(run.result?.warnings?.length || 0) === 1 ? '' : 's'}.`,
      failed: `${job.name} failed. ${String(run.result?.safeMessage || 'Review the run details in DeployerX.').slice(0, 300)}`
    };
    return this.dispatchEvent(tenant, {
      type: `backup.${run.state}`,
      eventKey: `backup-run:${run.id}:${run.state}`,
      occurredAt: run.finishedAt || run.updatedAt || this.clock(),
      title: `${titles[run.state]}: ${job.name}`,
      body: bodies[run.state],
      jobId: job.id,
      runId: run.id,
      recoveryPointId: run.result?.recoveryPointIds?.[0] || null,
      details: { state: run.state, attempt: Number(run.attempt || 1), warningCount: Number(run.result?.warnings?.length || 0) }
    });
  }

  async notifyVerificationRun(workspaceId, run) {
    if (!run || !['succeeded', 'warning', 'failed'].includes(run.state)) return [];
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    let recoveryPoint = null;
    if (run.recoveryPointId) recoveryPoint = await this.controlDatabase.repository('recoveryPoint').get(tenant, run.recoveryPointId);
    const labels = { succeeded: 'Recovery test passed', warning: 'Recovery test completed with warnings', failed: 'Recovery test failed' };
    const files = Number(run.result?.filesVerified ?? run.progress?.filesVerified ?? 0);
    const failure = run.result?.error?.safeMessage ? ` ${String(run.result.error.safeMessage).slice(0, 300)}` : '';
    return this.dispatchEvent(tenant, {
      type: `recovery-test.${run.state}`,
      eventKey: `verification-run:${run.id}:${run.state}`,
      occurredAt: run.completedAt || run.result?.completedAt || run.updatedAt || this.clock(),
      title: labels[run.state],
      body: `${run.mode === 'checksum' ? 'Repository checksum verification' : 'Sample restore verification'} ${run.state === 'failed' ? 'failed.' : `verified ${files} file${files === 1 ? '' : 's'}.`}${failure}`,
      jobId: recoveryPoint?.jobId || null,
      verificationRunId: run.id,
      recoveryPointId: run.recoveryPointId || null,
      repositoryId: run.repositoryId || null,
      details: { state: run.state, mode: run.mode, filesVerified: files, bytesVerified: Number(run.result?.bytesVerified ?? run.progress?.bytesVerified ?? 0) }
    });
  }

  async evaluateOverdueRpo(workspaceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const [jobs, policies, runs] = await Promise.all([
      this.controlDatabase.repository('backupJob').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('policy').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('run').list(tenant, { limit: 1000 })
    ]);
    const policyById = new Map(policies.map((policy) => [policy.id, policy]));
    const runById = new Map(runs.map((run) => [run.id, run]));
    const notifications = [];
    for (const job of jobs) {
      const policy = policyById.get(job.policyId);
      const rpoMinutes = Number(policy?.objectives?.rpoMinutes || 0);
      if (job.state !== 'enabled' || !policy?.enabled || !Number.isInteger(rpoMinutes) || rpoMinutes < 1) continue;
      const successful = runById.get(job.lastSuccessfulRunId);
      const baseline = isoTime(successful?.finishedAt || job.createdAt, 'RPO baseline');
      const dueAtMs = Date.parse(baseline) + rpoMinutes * 60000;
      if (this.now() <= dueAtMs) continue;
      const overdueMinutes = Math.max(1, Math.floor((this.now() - dueAtMs) / 60000));
      notifications.push(...await this.dispatchEvent(tenant, {
        type: 'backup.rpo-overdue',
        eventKey: `backup-rpo:${job.id}:${baseline}`,
        occurredAt: this.clock(),
        title: `Backup RPO overdue: ${job.name}`,
        body: `${job.name} is ${overdueMinutes} minute${overdueMinutes === 1 ? '' : 's'} beyond its ${rpoMinutes}-minute recovery point objective.`,
        jobId: job.id,
        runId: successful?.id || null,
        details: { rpoMinutes, overdueMinutes, lastSuccessfulAt: successful?.finishedAt || null, dueAt: new Date(dueAtMs).toISOString() }
      }));
    }
    return notifications;
  }

  async dispatchEvent(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const event = normalizeEvent(input, this.clock);
    const routeIds = await this.#routeIdsForEvent(tenant, event);
    const results = await Promise.all(routeIds.map((routeId) => this.#deliverTracked(tenant, routeId, event)));
    return results.filter(Boolean);
  }

  async dispatchEventToRoutes(workspaceId, routeIds, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const event = normalizeEvent(input, this.clock);
    const selectedIds = [...new Set((Array.isArray(routeIds) ? routeIds : []).map((routeId) => requiredText(routeId, 'Notification route ID', 200)))];
    if (!selectedIds.length) return [];
    const routes = await this.controlDatabase.repository('notificationRoute').list(tenant, { limit: 1000 });
    const routeById = new Map(routes.map((route) => [route.id, route]));
    const deliverable = selectedIds.filter((routeId) => {
      const route = routeById.get(routeId);
      return route?.enabled && (route.events || []).includes(event.type);
    });
    const results = await Promise.all(deliverable.map((routeId) => this.#deliverTracked(tenant, routeId, event)));
    return results.filter(Boolean);
  }

  async #routeIdsForEvent(workspaceId, event) {
    const [routes, jobs, policies, points] = await Promise.all([
      this.controlDatabase.repository('notificationRoute').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('backupJob').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('policy').list(workspaceId, { limit: 1000 }),
      event.recoveryPointId ? this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 }) : Promise.resolve([])
    ]);
    const routeById = new Map(routes.map((route) => [route.id, route]));
    const policyById = new Map(policies.map((policy) => [policy.id, policy]));
    const jobIds = new Set();
    if (event.jobId) jobIds.add(event.jobId);
    const point = points.find((candidate) => candidate.id === event.recoveryPointId);
    if (point?.jobId) jobIds.add(point.jobId);
    if (event.repositoryId && !jobIds.size) {
      for (const job of jobs) if ((job.repositoryBindings || []).some((binding) => binding.repositoryId === event.repositoryId)) jobIds.add(job.id);
    }
    const routeIds = new Set();
    for (const job of jobs) {
      if (!jobIds.has(job.id)) continue;
      for (const routeId of policyById.get(job.policyId)?.notificationRouteIds || []) routeIds.add(routeId);
    }
    return [...routeIds].filter((routeId) => {
      const route = routeById.get(routeId);
      return route?.enabled && (route.events || []).includes(event.type);
    });
  }

  #withRouteLock(routeId, operation) {
    const previous = this.routeLocks.get(routeId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tracked = current.finally(() => {
      if (this.routeLocks.get(routeId) === tracked) this.routeLocks.delete(routeId);
    });
    this.routeLocks.set(routeId, tracked);
    return tracked;
  }

  #deliverTracked(workspaceId, routeId, event, options = {}) {
    return this.#withRouteLock(routeId, async () => {
      const route = await this.controlDatabase.repository('notificationRoute').get(workspaceId, routeId);
      if (!route || (!route.enabled && !options.force)) return null;
      const previous = (route.deliveryHistory || []).find((delivery) => delivery.eventKey === event.eventKey);
      if (previous?.status === 'succeeded') return structuredClone(previous);
      if (!options.force && previous?.nextAttemptAt && Date.parse(previous.nextAttemptAt) > this.now()) return structuredClone(previous);
      const attempt = Number(previous?.attempt || 0) + 1;
      const attemptedAt = this.clock();
      let delivery;
      try {
        const provider = await this.#deliverRoute(workspaceId, route, event);
        delivery = {
          id: previous?.id || `delivery_${crypto.createHash('sha256').update(`${route.id}\0${event.eventKey}`).digest('hex').slice(0, 32)}`,
          eventKey: event.eventKey,
          eventType: options.test ? 'notification.test' : event.type,
          severity: event.severity,
          title: event.title,
          body: event.body,
          jobId: event.jobId,
          runId: event.runId,
          verificationRunId: event.verificationRunId,
          recoveryPointId: event.recoveryPointId,
          repositoryId: event.repositoryId,
          monitorId: event.monitorId,
          incidentId: event.incidentId,
          projectId: event.projectId,
          occurredAt: event.occurredAt,
          attemptedAt,
          deliveredAt: this.clock(),
          status: 'succeeded',
          attempt,
          nextAttemptAt: null,
          provider,
          error: null
        };
      } catch (error) {
        const safe = safeDeliveryError(error);
        delivery = {
          id: previous?.id || `delivery_${crypto.createHash('sha256').update(`${route.id}\0${event.eventKey}`).digest('hex').slice(0, 32)}`,
          eventKey: event.eventKey,
          eventType: options.test ? 'notification.test' : event.type,
          severity: event.severity,
          title: event.title,
          body: event.body,
          jobId: event.jobId,
          runId: event.runId,
          verificationRunId: event.verificationRunId,
          recoveryPointId: event.recoveryPointId,
          repositoryId: event.repositoryId,
          monitorId: event.monitorId,
          incidentId: event.incidentId,
          projectId: event.projectId,
          occurredAt: event.occurredAt,
          attemptedAt,
          deliveredAt: null,
          status: 'failed',
          attempt,
          nextAttemptAt: safe.retryable ? new Date(this.now() + retryDelay(attempt)).toISOString() : null,
          provider: null,
          error: safe
        };
      }
      await this.#recordDelivery(workspaceId, route.id, delivery);
      return structuredClone(delivery);
    });
  }

  async #recordDelivery(workspaceId, routeId, delivery) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.controlDatabase.repository('notificationRoute').get(workspaceId, routeId);
      if (!current) return;
      const history = [delivery, ...(current.deliveryHistory || []).filter((candidate) => candidate.eventKey !== delivery.eventKey)].slice(0, MAX_DELIVERY_HISTORY);
      try {
        await this.controlDatabase.repository('notificationRoute').update(workspaceId, routeId, { deliveryHistory: history, lastDelivery: delivery }, { expectedRevision: current.revision, actorId: 'backup-notification-worker' });
        return;
      } catch (error) {
        if (error?.code !== 'BACKUP_CONTROL_REVISION_CONFLICT' || attempt === 2) throw error;
      }
    }
  }

  async #deliverRoute(workspaceId, route, event) {
    if (route.type === 'desktop') {
      if (typeof this.desktopNotifier !== 'function') throw new BackupNotificationError('NOTIFICATION_DESKTOP_UNAVAILABLE', 'Desktop notifications are unavailable on this device.', { retryable: true });
      await this.desktopNotifier({ title: event.title, body: event.body, silent: Boolean(route.config?.silent), event });
      return { channel: 'desktop' };
    }
    if (route.type === 'email') {
      if (typeof this.mailerFactory !== 'function') throw new BackupNotificationError('NOTIFICATION_EMAIL_UNAVAILABLE', 'Email delivery is unavailable on this device.', { retryable: true });
      const password = route.secretRefIds?.[0] ? await this.secretStore.resolve({ workspaceId, id: route.secretRefIds[0] }) : null;
      const transport = this.mailerFactory({
        host: route.config.host,
        port: route.config.port,
        secure: Boolean(route.config.secure),
        ...(route.config.username ? { auth: { user: route.config.username, pass: password?.value || password } } : {})
      });
      const result = await transport.sendMail({ from: route.config.from, to: route.config.recipients.join(', '), subject: event.title, text: `${event.body}\n\nEvent: ${event.type}\nTime: ${event.occurredAt}` });
      return { channel: 'email', messageId: optionalText(result?.messageId, 500) };
    }
    if (typeof this.fetchImpl !== 'function') throw new BackupNotificationError('NOTIFICATION_WEBHOOK_UNAVAILABLE', 'Webhook delivery is unavailable on this device.', { retryable: true });
    const resolved = await this.secretStore.resolve({ workspaceId, id: route.secretRefIds?.[0] });
    const endpoint = String(resolved?.value || resolved || '');
    normalizeWebhookUrl(endpoint, Boolean(route.config?.allowInsecure));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'DeployerX-Notifications/1',
          'x-deployerx-event': event.type,
          'x-deployerx-delivery': event.eventKey
        },
        body: JSON.stringify(webhookPayload(route, event))
      });
      if (!response || response.status < 200 || response.status >= 300) throw new BackupNotificationError('NOTIFICATION_WEBHOOK_REJECTED', `Webhook destination returned HTTP ${Number(response?.status || 0)}.`, { retryable: Number(response?.status || 0) >= 500 || Number(response?.status || 0) === 429 });
      return { channel: route.type, status: response.status };
    } catch (error) {
      if (error instanceof BackupNotificationError) throw error;
      if (error?.name === 'AbortError') throw new BackupNotificationError('NOTIFICATION_DELIVERY_TIMEOUT', 'Notification delivery timed out.', { category: 'timeout', retryable: true });
      throw new BackupNotificationError('NOTIFICATION_WEBHOOK_FAILED', 'DeployerX could not reach the webhook destination.', { category: 'connectivity', retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }
}

const NotificationService = BackupNotificationService;
const NotificationError = BackupNotificationError;

module.exports = {
  BackupNotificationError,
  BackupNotificationService,
  NotificationError,
  NotificationService,
  DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_HISTORY,
  MAX_DELIVERY_LIST,
  NOTIFICATION_EVENTS,
  ROUTE_TYPES,
  normalizeEvent,
  normalizeEvents,
  normalizeRouteInput,
  publicRoute,
  retryDelay,
  safeDeliveryError,
  webhookPayload
};
