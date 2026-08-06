const test = require('node:test');
const assert = require('node:assert/strict');
const { FileDiscoveryError, MAX_DIRECTORY_ENTRIES, createDiscoveryPage } = require('./file-discovery');

function entries(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `item-${String(index).padStart(3, '0')}`,
    path: `/data/item-${String(index).padStart(3, '0')}`,
    type: index % 3 === 0 ? 'directory' : 'file',
    size: index,
    modifiedAt: '2026-08-03T12:00:00.000Z'
  }));
}

test('paginates a directory with stable IDs and path-bound opaque cursors', () => {
  const input = entries(25);
  const first = createDiscoveryPage({ adapterId: 'test.files', directoryPath: '/data', parentPath: '/', entries: input, pageSize: 10 });
  const second = createDiscoveryPage({ adapterId: 'test.files', directoryPath: '/data', parentPath: '/', entries: input, pageSize: 10, cursor: first.nextCursor });
  const third = createDiscoveryPage({ adapterId: 'test.files', directoryPath: '/data', parentPath: '/', entries: input, pageSize: 10, cursor: second.nextCursor });
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 10);
  assert.equal(third.items.length, 5);
  assert.equal(third.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size, 25);
  assert.throws(() => createDiscoveryPage({ adapterId: 'test.files', directoryPath: '/other', entries: input, pageSize: 10, cursor: first.nextCursor }), (error) => error instanceof FileDiscoveryError && error.code === 'DISCOVERY_CURSOR_INVALID');
});

test('orders directories before files and normalizes bounded metadata', () => {
  const result = createDiscoveryPage({
    adapterId: 'test.files', directoryPath: '/data', parentPath: '/', pageSize: 10,
    entries: [
      { name: 'z.txt', path: '/data/z.txt', type: 'file', size: -1, modifiedAt: 'invalid' },
      { name: 'Folder', path: '/data/Folder', type: 'directory', mode: 0o755 },
      { name: 'link', path: '/data/link', type: 'symlink', accessible: false }
    ]
  });
  assert.deepEqual(result.items.map((item) => item.type), ['directory', 'file', 'symlink']);
  assert.equal(result.items[1].size, null);
  assert.equal(result.items[1].modifiedAt, null);
  assert.equal(result.items[2].accessible, false);
});

test('rejects invalid page sizes, cursors, paths, and unbounded directories', () => {
  const base = { adapterId: 'test.files', directoryPath: '/data', entries: [] };
  assert.throws(() => createDiscoveryPage({ ...base, pageSize: 0 }), /Page size/);
  assert.throws(() => createDiscoveryPage({ ...base, cursor: 'not-a-cursor' }), /cursor is invalid/);
  assert.throws(() => createDiscoveryPage({ ...base, directoryPath: `bad\0path` }), /path is invalid/);
  assert.throws(() => createDiscoveryPage({ ...base, entries: new Array(MAX_DIRECTORY_ENTRIES + 1).fill({}) }), /more than/);
});
