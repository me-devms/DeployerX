const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_QUERY_TABS,
  activeTab,
  activateTab,
  addTab,
  closeTab,
  createSession,
  renameTab,
  restoreSession,
  serializeSession,
  updateTab
} = require('./query-tabs');

function ids() {
  let next = 0;
  return () => `tab_${++next}`;
}

test('creates, activates, renames, and closes bounded query tabs', () => {
  const idFactory = ids();
  const session = createSession({}, { idFactory });
  assert.equal(activeTab(session).title, 'Query 1');
  const second = addTab(session, { query: 'SELECT 2' }, { idFactory });
  assert.equal(second.title, 'Query 2');
  assert.equal(activeTab(session).id, second.id);
  renameTab(session, second.id, '  Revenue   report  ');
  assert.equal(activeTab(session).title, 'Revenue report');
  activateTab(session, 'tab_1');
  assert.equal(activeTab(session).title, 'Query 1');
  closeTab(session, 'tab_1', { idFactory });
  assert.equal(activeTab(session).id, second.id);
});

test('preserves independent editor and runtime state for each live tab', () => {
  const idFactory = ids();
  const session = createSession({}, { idFactory });
  const first = activeTab(session);
  updateTab(session, first.id, {
    query: 'SELECT * FROM orders', profileId: 'profile-a', pageSize: 250,
    selectionStart: 7, selectionEnd: 13, savedQueryId: 'saved-a', dirty: true,
    page: 2, lastRequest: { query: 'SELECT * FROM orders' }, execution: { result: { rows: [[1]] } }
  });
  const second = addTab(session, { query: 'SELECT * FROM users', profileId: 'profile-b' }, { idFactory });
  assert.equal(second.execution, null);
  assert.deepEqual(session.tabs[0].execution, { result: { rows: [[1]] } });
  assert.equal(session.tabs[0].selectionStart, 7);
  assert.equal(session.tabs[0].savedQueryId, 'saved-a');
  updateTab(session, first.id, { resultIndex: 2 });
  assert.equal(session.tabs[0].resultIndex, 2);
});

test('serializes recoverable state without persisting query results or requests', () => {
  const idFactory = ids();
  const session = createSession({}, { idFactory });
  updateTab(session, session.activeTabId, {
    query: 'SELECT 1', dirty: true, execution: { result: { rows: [[1]] } }, lastRequest: { query: 'SELECT 1' }
  });
  const serialized = serializeSession(session);
  assert.doesNotMatch(serialized, /execution|lastRequest|rows/);
  const restored = restoreSession(serialized, { idFactory });
  assert.equal(activeTab(restored).query, 'SELECT 1');
  assert.equal(activeTab(restored).dirty, true);
  assert.equal(activeTab(restored).execution, null);
  assert.equal(activeTab(restored).lastRequest, null);
});

test('falls back safely for corrupt recovery data and enforces tab limits', () => {
  const idFactory = ids();
  assert.equal(restoreSession('{broken', { idFactory }).tabs.length, 1);
  const session = createSession({}, { idFactory });
  while (session.tabs.length < MAX_QUERY_TABS) addTab(session, {}, { idFactory });
  assert.throws(() => addTab(session, {}, { idFactory }), (error) => error.code === 'DATABASE_QUERY_TAB_LIMIT_REACHED');
});

test('rejects a query larger than the per-tab byte limit', () => {
  const session = createSession({}, { idFactory: ids() });
  assert.throws(
    () => updateTab(session, session.activeTabId, { query: 'x'.repeat((2 * 1024 * 1024) + 1) }),
    (error) => error.code === 'DATABASE_QUERY_TAB_QUERY_TOO_LARGE'
  );
});
