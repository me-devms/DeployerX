(function exposeDatabaseQueryTabs(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DatabaseQueryTabs = api;
})(typeof globalThis === 'object' ? globalThis : this, function createDatabaseQueryTabsApi() {
  'use strict';

  const QUERY_TAB_SESSION_VERSION = 1;
  const MAX_QUERY_TABS = 12;
  const MAX_QUERY_TAB_TITLE_LENGTH = 80;
  const MAX_QUERY_TAB_BYTES = 2 * 1024 * 1024;
  const MAX_QUERY_TAB_SESSION_BYTES = 4 * 1024 * 1024;
  const ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/;

  function byteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    return Buffer.byteLength(text, 'utf8');
  }

  function sessionError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function normalizeTitle(value, fallback = 'Query') {
    const title = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_TAB_TITLE_LENGTH);
    return title || fallback;
  }

  function normalizeQuery(value) {
    const query = String(value ?? '');
    if (byteLength(query) > MAX_QUERY_TAB_BYTES) {
      throw sessionError('A query tab cannot exceed 2 MiB.', 'DATABASE_QUERY_TAB_QUERY_TOO_LARGE');
    }
    return query;
  }

  function normalizeId(value, idFactory) {
    const candidate = String(value ?? '');
    if (ID_PATTERN.test(candidate)) return candidate;
    const generated = String(idFactory());
    if (!ID_PATTERN.test(generated)) throw sessionError('The query tab ID is invalid.', 'DATABASE_QUERY_TAB_ID_INVALID');
    return generated;
  }

  function normalizePageSize(value) {
    const size = Number(value);
    return Number.isInteger(size) && size >= 1 && size <= 5000 ? size : 100;
  }

  function normalizeSelection(value, maximum) {
    const position = Number(value);
    if (!Number.isInteger(position) || position < 0) return 0;
    return Math.min(position, maximum);
  }

  function defaultIdFactory() {
    if (globalThis.crypto?.randomUUID) return `dbtab_${globalThis.crypto.randomUUID()}`;
    return `dbtab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function createTab(input = {}, options = {}) {
    const idFactory = options.idFactory || defaultIdFactory;
    const query = normalizeQuery(input.query);
    const selectionStart = normalizeSelection(input.selectionStart, query.length);
    const selectionEnd = Math.max(selectionStart, normalizeSelection(input.selectionEnd, query.length));
    return {
      id: normalizeId(input.id, idFactory),
      title: normalizeTitle(input.title, options.fallbackTitle || 'Query'),
      query,
      profileId: String(input.profileId ?? '').slice(0, 160),
      pageSize: normalizePageSize(input.pageSize),
      selectionStart,
      selectionEnd,
      savedQueryId: String(input.savedQueryId ?? '').slice(0, 160),
      dirty: input.dirty === true,
      page: Number.isInteger(Number(input.page)) && Number(input.page) > 0 ? Number(input.page) : 1,
      resultIndex: Number.isInteger(Number(input.resultIndex)) && Number(input.resultIndex) >= 0 && Number(input.resultIndex) < 100 ? Number(input.resultIndex) : 0,
      lastRequest: input.lastRequest && typeof input.lastRequest === 'object' ? input.lastRequest : null,
      execution: input.execution && typeof input.execution === 'object' ? input.execution : null
    };
  }

  function nextTitle(tabs) {
    const titles = new Set(tabs.map((tab) => tab.title.toLocaleLowerCase()));
    for (let number = 1; number <= MAX_QUERY_TABS + 1; number += 1) {
      const title = `Query ${number}`;
      if (!titles.has(title.toLocaleLowerCase())) return title;
    }
    return 'Query';
  }

  function createSession(input = {}, options = {}) {
    const idFactory = options.idFactory || defaultIdFactory;
    const sourceTabs = Array.isArray(input.tabs) ? input.tabs.slice(0, MAX_QUERY_TABS) : [];
    const tabs = [];
    const seen = new Set();
    for (const source of sourceTabs) {
      try {
        const tab = createTab(source, { idFactory, fallbackTitle: nextTitle(tabs) });
        if (seen.has(tab.id)) tab.id = normalizeId('', idFactory);
        seen.add(tab.id);
        tabs.push(tab);
      } catch {
        // A malformed recovery entry must not prevent the remaining tabs from opening.
      }
    }
    if (!tabs.length) tabs.push(createTab({}, { idFactory, fallbackTitle: 'Query 1' }));
    const requestedActiveId = String(input.activeTabId ?? '');
    return {
      version: QUERY_TAB_SESSION_VERSION,
      activeTabId: tabs.some((tab) => tab.id === requestedActiveId) ? requestedActiveId : tabs[0].id,
      tabs
    };
  }

  function activeTab(session) {
    return session.tabs.find((tab) => tab.id === session.activeTabId) || session.tabs[0] || null;
  }

  function addTab(session, input = {}, options = {}) {
    if (session.tabs.length >= MAX_QUERY_TABS) {
      throw sessionError(`Only ${MAX_QUERY_TABS} query tabs can be open at once.`, 'DATABASE_QUERY_TAB_LIMIT_REACHED');
    }
    const tab = createTab(input, {
      idFactory: options.idFactory || defaultIdFactory,
      fallbackTitle: nextTitle(session.tabs)
    });
    if (session.tabs.some((item) => item.id === tab.id)) {
      throw sessionError('The query tab ID already exists.', 'DATABASE_QUERY_TAB_ID_EXISTS');
    }
    session.tabs.push(tab);
    session.activeTabId = tab.id;
    return tab;
  }

  function activateTab(session, tabId) {
    if (!session.tabs.some((tab) => tab.id === tabId)) return null;
    session.activeTabId = tabId;
    return activeTab(session);
  }

  function updateTab(session, tabId, patch = {}) {
    const index = session.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return null;
    const current = session.tabs[index];
    const next = createTab({ ...current, ...patch, id: current.id }, { idFactory: () => current.id, fallbackTitle: current.title });
    session.tabs[index] = next;
    return next;
  }

  function renameTab(session, tabId, title) {
    const tab = session.tabs.find((item) => item.id === tabId);
    if (!tab) return null;
    tab.title = normalizeTitle(title, tab.title);
    return tab;
  }

  function closeTab(session, tabId, options = {}) {
    const index = session.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return null;
    const [closed] = session.tabs.splice(index, 1);
    if (!session.tabs.length) {
      const replacement = createTab({}, { idFactory: options.idFactory || defaultIdFactory, fallbackTitle: 'Query 1' });
      session.tabs.push(replacement);
    }
    if (session.activeTabId === tabId) {
      session.activeTabId = session.tabs[Math.min(index, session.tabs.length - 1)].id;
    }
    return closed;
  }

  function serializeSession(session) {
    const value = {
      version: QUERY_TAB_SESSION_VERSION,
      activeTabId: session.activeTabId,
      tabs: session.tabs.slice(0, MAX_QUERY_TABS).map((tab) => ({
        id: tab.id,
        title: tab.title,
        query: tab.query,
        profileId: tab.profileId,
        pageSize: tab.pageSize,
        selectionStart: tab.selectionStart,
        selectionEnd: tab.selectionEnd,
        savedQueryId: tab.savedQueryId,
        dirty: tab.dirty
      }))
    };
    const serialized = JSON.stringify(value);
    if (byteLength(serialized) > MAX_QUERY_TAB_SESSION_BYTES) {
      throw sessionError('The query tab recovery session is too large to save.', 'DATABASE_QUERY_TAB_SESSION_TOO_LARGE');
    }
    return serialized;
  }

  function restoreSession(serialized, options = {}) {
    try {
      const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
      if (!value || value.version !== QUERY_TAB_SESSION_VERSION) return createSession({}, options);
      return createSession(value, options);
    } catch {
      return createSession({}, options);
    }
  }

  return Object.freeze({
    QUERY_TAB_SESSION_VERSION,
    MAX_QUERY_TABS,
    MAX_QUERY_TAB_BYTES,
    MAX_QUERY_TAB_SESSION_BYTES,
    activeTab,
    activateTab,
    addTab,
    closeTab,
    createSession,
    createTab,
    renameTab,
    restoreSession,
    serializeSession,
    updateTab
  });
});
