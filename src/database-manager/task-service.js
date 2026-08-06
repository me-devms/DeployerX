const { normalizeDatabaseTaskInput } = require('./domain');

const TASK_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'failed', 'canceled', 'interrupted']),
  running: new Set(['succeeded', 'failed', 'canceled', 'interrupted']),
  interrupted: new Set(['running', 'failed', 'canceled']),
  succeeded: new Set(),
  failed: new Set(),
  canceled: new Set()
});

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function taskError(message, code) {
  return Object.assign(new Error(message), { code, category: 'database-manager', retryable: false });
}

class DatabaseTaskStore {
  constructor({ controlDatabase } = {}) {
    if (!controlDatabase?.repository || !controlDatabase?.transaction) throw new TypeError('DatabaseTaskStore requires the shared control database.');
    this.controlDatabase = controlDatabase;
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const profileId = options.profileId ? requiredText(options.profileId, 'Database profile ID') : '';
    const state = options.state ? requiredText(options.state, 'Database task state', 40) : '';
    const type = options.type ? requiredText(options.type, 'Database task type', 40) : '';
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const records = await this.controlDatabase.repository('databaseTask').list(tenant, { limit: 1000 });
    return records.filter((record) => (!profileId || record.profileId === profileId)
      && (!state || record.state === state)
      && (!type || record.type === type)).slice(0, limit);
  }

  get(workspaceId, id) {
    return this.controlDatabase.repository('databaseTask').get(requiredText(workspaceId, 'Workspace ID'), requiredText(id, 'Database task ID'));
  }

  create(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const task = normalizeDatabaseTaskInput(input);
    if (task.state !== 'queued') throw taskError('A new database task must be queued.', 'DATABASE_MANAGER_TASK_STATE_INVALID');
    return this.controlDatabase.transaction((transaction) => {
      if (!transaction.get('databaseProfile', tenant, task.profileId)) throw taskError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
      return transaction.create('databaseTask', { workspaceId: tenant, actorId: actor, ...task });
    });
  }

  project(workspaceId, actorId, id, patch = {}, expectedRevision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const taskId = requiredText(id, 'Database task ID');
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('databaseTask', tenant, taskId);
      if (!current) throw taskError('Database task was not found.', 'DATABASE_MANAGER_TASK_NOT_FOUND');
      const nextState = patch.state === undefined ? current.state : String(patch.state).toLowerCase();
      if (nextState !== current.state && !TASK_TRANSITIONS[current.state]?.has(nextState)) {
        throw taskError(`Database task cannot transition from ${current.state} to ${nextState}.`, 'DATABASE_MANAGER_TASK_STATE_INVALID');
      }
      const normalized = normalizeDatabaseTaskInput({
        ...current,
        ...patch,
        profileId: current.profileId,
        type: current.type,
        label: patch.label === undefined ? current.label : patch.label,
        progress: patch.progress === undefined ? current.progress : { ...current.progress, ...patch.progress }
      });
      return transaction.update('databaseTask', tenant, taskId, normalized, {
        expectedRevision: Number(expectedRevision ?? current.revision),
        actorId: actor
      });
    });
  }
}

class DatabaseTaskService {
  constructor({ store, clock = () => new Date().toISOString(), onEvent = null } = {}) {
    if (!store?.list || !store?.get || !store?.create || !store?.project) throw new TypeError('DatabaseTaskService requires a task store.');
    if (onEvent !== null && typeof onEvent !== 'function') throw new TypeError('Database task event handler is invalid.');
    this.store = store;
    this.clock = clock;
    this.onEvent = onEvent;
    this.cancellations = new Map();
  }

  list(workspaceId, options) { return this.store.list(workspaceId, options); }
  get(workspaceId, id) { return this.store.get(workspaceId, id); }
  async create(workspaceId, actorId, input) {
    const task = await this.store.create(workspaceId, actorId, { ...input, state: 'queued', progress: input?.progress || { phase: 'queued', percent: 0 } });
    return this.#notify(workspaceId, task);
  }

  async start(workspaceId, actorId, id, expectedRevision) {
    const task = await this.store.project(workspaceId, actorId, id, { state: 'running', startedAt: this.clock(), progress: { phase: 'running' } }, expectedRevision);
    return this.#notify(workspaceId, task);
  }

  async reportProgress(workspaceId, actorId, id, progress, expectedRevision) {
    const current = await this.get(workspaceId, id);
    if (!current || current.state !== 'running') throw taskError('Only a running database task can report progress.', 'DATABASE_MANAGER_TASK_STATE_INVALID');
    const task = await this.store.project(workspaceId, actorId, id, { progress }, expectedRevision ?? current.revision);
    return this.#notify(workspaceId, task);
  }

  async complete(workspaceId, actorId, id, options = {}) {
    const current = await this.get(workspaceId, id);
    if (!current) throw taskError('Database task was not found.', 'DATABASE_MANAGER_TASK_NOT_FOUND');
    const task = await this.store.project(workspaceId, actorId, id, {
      state: options.state === 'failed' ? 'failed' : 'succeeded',
      canCancel: false,
      safeMessage: options.safeMessage || null,
      completedAt: this.clock(),
      progress: { ...(options.progress || {}), phase: options.state === 'failed' ? 'failed' : 'complete', percent: options.state === 'failed' ? current.progress.percent : 100 }
    }, options.expectedRevision ?? current.revision);
    return this.#notify(workspaceId, task);
  }

  registerCancellation(workspaceId, taskId, cancellation) {
    if (typeof cancellation !== 'function') throw new TypeError('Database task cancellation must be a function.');
    const key = `${requiredText(workspaceId, 'Workspace ID')}:${requiredText(taskId, 'Database task ID')}`;
    this.cancellations.set(key, cancellation);
    return () => this.cancellations.delete(key);
  }

  async cancel(workspaceId, actorId, id) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const taskId = requiredText(id, 'Database task ID');
    const current = await this.get(tenant, taskId);
    if (!current) throw taskError('Database task was not found.', 'DATABASE_MANAGER_TASK_NOT_FOUND');
    if (!['queued', 'running', 'interrupted'].includes(current.state) || !current.canCancel) throw taskError('This database task cannot be canceled.', 'DATABASE_MANAGER_TASK_NOT_CANCELLABLE');
    const key = `${tenant}:${taskId}`;
    const cancellation = this.cancellations.get(key);
    if (cancellation) await cancellation();
    this.cancellations.delete(key);
    const task = await this.store.project(tenant, actorId, taskId, {
      state: 'canceled', canCancel: false, completedAt: this.clock(), safeMessage: 'Canceled by user.', progress: { phase: 'canceled' }
    }, current.revision);
    return this.#notify(tenant, task);
  }

  async #notify(workspaceId, task) {
    if (!this.onEvent) return task;
    await Promise.resolve(this.onEvent(requiredText(workspaceId, 'Workspace ID'), task)).catch(() => {});
    return task;
  }
}

module.exports = { DatabaseTaskService, DatabaseTaskStore, TASK_TRANSITIONS };
