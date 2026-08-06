const { MAX_QUERY_HISTORY_ITEMS, normalizeNotebookInput, normalizeQueryHistoryInput, normalizeSavedQueryInput } = require('./domain');

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw new TypeError(`${label} is invalid.`);
  return text;
}

function optionalText(value, label, maximumLength = 200) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function workspaceError(message, code) {
  return Object.assign(new Error(message), { code, category: 'database-manager', retryable: false });
}

function mapSavedQueryPersistenceError(error) {
  if (/UNIQUE constraint failed: database_saved_queries\.workspace_id, database_saved_queries\.profile_id, database_saved_queries\.name/i.test(String(error?.message || ''))) {
    return workspaceError('A saved query with this name already exists for the connection.', 'DATABASE_MANAGER_SAVED_QUERY_NAME_EXISTS');
  }
  return error;
}

function mapNotebookPersistenceError(error) {
  if (/UNIQUE constraint failed: database_notebooks\.workspace_id, database_notebooks\.profile_id, database_notebooks\.name/i.test(String(error?.message || ''))) {
    return workspaceError('A notebook with this name already exists for the connection.', 'DATABASE_MANAGER_NOTEBOOK_NAME_EXISTS');
  }
  return error;
}

class DatabaseQueryWorkspaceStore {
  constructor({ controlDatabase, historyLimit = MAX_QUERY_HISTORY_ITEMS } = {}) {
    if (!controlDatabase?.repository || !controlDatabase?.transaction || !controlDatabase?.read) {
      throw new TypeError('DatabaseQueryWorkspaceStore requires the shared control database.');
    }
    const retained = Number(historyLimit);
    if (!Number.isInteger(retained) || retained < 1 || retained > MAX_QUERY_HISTORY_ITEMS) throw new TypeError('Database query history limit is invalid.');
    this.controlDatabase = controlDatabase;
    this.historyLimit = retained;
  }

  async listSavedQueries(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const profileId = optionalText(options.profileId, 'Database profile ID');
    const search = String(options.search || '').trim().toLowerCase().slice(0, 200);
    const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
    const records = await this.controlDatabase.repository('databaseSavedQuery').list(tenant, { limit: 1000 });
    return records.filter((record) => (!profileId || record.profileId === profileId)
      && (!search || [record.name, record.description, record.query, ...(record.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(search)))
      .slice(0, limit);
  }

  getSavedQuery(workspaceId, id) {
    return this.controlDatabase.repository('databaseSavedQuery').get(requiredText(workspaceId, 'Workspace ID'), requiredText(id, 'Saved query ID'));
  }

  async createSavedQuery(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const savedQuery = normalizeSavedQueryInput(input);
    try {
      return await this.controlDatabase.transaction((transaction) => {
        this.#requireProfile(transaction, tenant, savedQuery.profileId);
        return transaction.create('databaseSavedQuery', { workspaceId: tenant, actorId: actor, ...savedQuery });
      });
    } catch (error) {
      throw mapSavedQueryPersistenceError(error);
    }
  }

  async updateSavedQuery(workspaceId, actorId, id, input = {}, expectedRevision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const savedQueryId = requiredText(id, 'Saved query ID');
    try {
      return await this.controlDatabase.transaction((transaction) => {
        const current = transaction.get('databaseSavedQuery', tenant, savedQueryId);
        if (!current) throw workspaceError('Saved query was not found.', 'DATABASE_MANAGER_SAVED_QUERY_NOT_FOUND');
        const savedQuery = normalizeSavedQueryInput({ ...current, ...input, profileId: current.profileId });
        this.#requireProfile(transaction, tenant, current.profileId);
        return transaction.update('databaseSavedQuery', tenant, savedQueryId, savedQuery, { expectedRevision: Number(expectedRevision), actorId: actor });
      });
    } catch (error) {
      throw mapSavedQueryPersistenceError(error);
    }
  }

  deleteSavedQuery(workspaceId, actorId, id, expectedRevision) {
    return this.controlDatabase.repository('databaseSavedQuery').softDelete(
      requiredText(workspaceId, 'Workspace ID'),
      requiredText(id, 'Saved query ID'),
      { expectedRevision: Number(expectedRevision), actorId: requiredText(actorId || 'system', 'Actor ID') }
    );
  }

  async listHistory(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const profileId = optionalText(options.profileId, 'Database profile ID');
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), this.historyLimit);
    const records = await this.controlDatabase.repository('databaseQueryHistory').list(tenant, { limit: this.historyLimit });
    return records.filter((record) => !profileId || record.profileId === profileId).slice(0, limit);
  }

  recordHistory(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const history = normalizeQueryHistoryInput(input);
    return this.controlDatabase.transaction((transaction) => {
      this.#requireProfile(transaction, tenant, history.profileId);
      const record = transaction.create('databaseQueryHistory', { workspaceId: tenant, actorId: actor, ...history });
      transaction.pruneDatabaseQueryHistory(tenant, this.historyLimit);
      return record;
    });
  }

  clearHistory(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const profileId = optionalText(options.profileId, 'Database profile ID');
    return this.controlDatabase.transaction((transaction) => Object.freeze({ deletedCount: transaction.clearDatabaseQueryHistory(tenant, profileId), profileId }));
  }

  async listNotebooks(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const profileId = optionalText(options.profileId, 'Database profile ID');
    const search = String(options.search || '').trim().toLowerCase().slice(0, 200);
    const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
    const records = await this.controlDatabase.repository('databaseNotebook').list(tenant, { limit: 1000 });
    return records.filter((record) => (!profileId || record.profileId === profileId)
      && (!search || [record.name, record.description, ...(record.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(search)))
      .slice(0, limit);
  }

  getNotebook(workspaceId, id) {
    return this.controlDatabase.repository('databaseNotebook').get(requiredText(workspaceId, 'Workspace ID'), requiredText(id, 'Notebook ID'));
  }

  async createNotebook(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const notebook = normalizeNotebookInput(input);
    try {
      return await this.controlDatabase.transaction((transaction) => {
        this.#requireProfile(transaction, tenant, notebook.profileId);
        return transaction.create('databaseNotebook', { workspaceId: tenant, actorId: actor, ...notebook });
      });
    } catch (error) {
      throw mapNotebookPersistenceError(error);
    }
  }

  async updateNotebook(workspaceId, actorId, id, input = {}, expectedRevision) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const notebookId = requiredText(id, 'Notebook ID');
    try {
      return await this.controlDatabase.transaction((transaction) => {
        const current = transaction.get('databaseNotebook', tenant, notebookId);
        if (!current) throw workspaceError('Notebook was not found.', 'DATABASE_MANAGER_NOTEBOOK_NOT_FOUND');
        const notebook = normalizeNotebookInput({ ...current, ...input, profileId: current.profileId });
        this.#requireProfile(transaction, tenant, current.profileId);
        return transaction.update('databaseNotebook', tenant, notebookId, notebook, { expectedRevision: Number(expectedRevision), actorId: actor });
      });
    } catch (error) {
      throw mapNotebookPersistenceError(error);
    }
  }

  deleteNotebook(workspaceId, actorId, id, expectedRevision) {
    return this.controlDatabase.repository('databaseNotebook').softDelete(
      requiredText(workspaceId, 'Workspace ID'),
      requiredText(id, 'Notebook ID'),
      { expectedRevision: Number(expectedRevision), actorId: requiredText(actorId || 'system', 'Actor ID') }
    );
  }

  #requireProfile(transaction, workspaceId, profileId) {
    const profile = transaction.get('databaseProfile', workspaceId, profileId);
    if (!profile) throw workspaceError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    return profile;
  }
}

module.exports = {
  DatabaseQueryWorkspaceStore,
  mapNotebookPersistenceError,
  mapSavedQueryPersistenceError
};
