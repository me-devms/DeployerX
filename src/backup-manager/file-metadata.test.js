const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FileMetadataError,
  applyLocalFileMetadata,
  buildMetadataPreservationPolicy,
  captureLocalFileMetadata,
  captureSftpFileMetadata,
  metadataCapabilitiesForConnection,
  normalizeFileMetadata
} = require('./file-metadata');

const ALL_CAPABILITIES = {
  permissions: true, ownership: true, timestamps: true, acl: true,
  extendedAttributes: true, symbolicLinks: true, hardLinks: true, sparseFiles: true
};

test('reports truthful built-in local and SFTP metadata capabilities', () => {
  const localPosix = metadataCapabilitiesForConnection('local', 'linux');
  const localWindows = metadataCapabilitiesForConnection('local', 'windows');
  const ssh = metadataCapabilitiesForConnection('ssh', 'linux');
  assert.equal(localPosix.permissions, true);
  assert.equal(localPosix.hardLinks, true);
  assert.equal(localWindows.permissions, false);
  assert.equal(localWindows.timestamps, true);
  assert.equal(ssh.symbolicLinks, true);
  assert.equal(ssh.hardLinks, false);
  assert.equal(ssh.acl, false);
  assert.equal(ssh.extendedAttributes, false);
  assert.equal(ssh.sparseFiles, false);
});

test('normalizes every canonical metadata family and produces a stable digest', () => {
  const input = {
    type: 'file', size: 1000,
    permissions: { mode: 0o2640 },
    ownership: { uid: 1000, gid: 1001, user: 'backup', group: 'ops' },
    timestamps: { accessedAt: '2026-08-03T12:00:00Z', modifiedAt: '2026-08-03T12:01:00Z', changedAt: null, createdAt: null, resolution: 'nanoseconds' },
    links: { hard: { key: '8:42', linkCount: 2 } },
    acl: [{ type: 'allow', principal: 'user:1000', permissions: ['read', 'write'], flags: ['inherited'] }],
    extendedAttributes: [{ name: 'user.comment', value: Buffer.from('hello').toString('base64') }],
    sparse: { logicalSize: 1000, allocatedSize: 200, dataRanges: [{ offset: 0, length: 100 }, { offset: 900, length: 100 }] }
  };
  const first = normalizeFileMetadata(input, ALL_CAPABILITIES);
  const second = normalizeFileMetadata(input, ALL_CAPABILITIES);
  assert.equal(first.permissions.mode, 0o2640);
  assert.equal(first.ownership.uid, 1000);
  assert.equal(first.links.hard.key, '8:42');
  assert.equal(first.acl.length, 1);
  assert.equal(first.extendedAttributes[0].encoding, 'base64');
  assert.equal(first.sparse.dataRanges.length, 2);
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
});

test('drops metadata that an adapter does not support and records policy reductions', () => {
  const capabilities = metadataCapabilitiesForConnection('ssh', 'linux');
  const normalized = normalizeFileMetadata({
    type: 'file', size: 10, permissions: { mode: 0o644 },
    links: { hard: { key: 'unsafe', linkCount: 2 } },
    acl: [{ type: 'allow', principal: 'user:1', permissions: ['read'] }],
    sparse: { logicalSize: 10, allocatedSize: 1, dataRanges: [{ offset: 0, length: 1 }] }
  }, capabilities);
  assert.equal(normalized.links.hard, null);
  assert.equal(normalized.acl, null);
  assert.equal(normalized.sparse, null);
  const policy = buildMetadataPreservationPolicy(capabilities, { fields: { hardLinks: true, acl: true, sparseFiles: true } });
  assert.equal(policy.preserve.hardLinks, false);
  assert.deepEqual(policy.reductions.map((item) => item.field), ['acl', 'hardLinks', 'sparseFiles']);
});

test('rejects malformed ACL, xattr, and sparse metadata', () => {
  const base = { type: 'file', size: 10 };
  assert.throws(() => normalizeFileMetadata({ ...base, acl: [{ type: 'allow', principal: 'u', permissions: 'read' }] }, ALL_CAPABILITIES), /ACL permission/);
  assert.throws(() => normalizeFileMetadata({ ...base, extendedAttributes: [{ name: 'user.x', value: 'not base64' }] }, ALL_CAPABILITIES), /base64/);
  assert.throws(() => normalizeFileMetadata({ ...base, sparse: { logicalSize: 10, allocatedSize: 2, dataRanges: [{ offset: 4, length: 4 }, { offset: 6, length: 2 }] } }, ALL_CAPABILITIES), /overlap/);
});

test('captures local permissions, ownership, timestamps, symbolic targets, and hard-link identity', async () => {
  const timestamp = new Date('2026-08-03T12:00:00.000Z');
  const fileStat = {
    isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
    size: 42, mode: 0o100640, uid: 1000, gid: 1001, dev: 8, ino: 99, nlink: 2,
    atime: timestamp, mtime: timestamp, ctime: timestamp, birthtime: timestamp
  };
  const file = await captureLocalFileMetadata({}, '/data/file', fileStat, metadataCapabilitiesForConnection('local', 'linux'));
  assert.equal(file.permissions.mode, 0o640);
  assert.equal(file.ownership.gid, 1001);
  assert.deepEqual(file.links.hard, { key: '8:99', linkCount: 2 });

  const linkStat = { ...fileStat, isFile: () => false, isSymbolicLink: () => true, size: 0, nlink: 1 };
  const link = await captureLocalFileMetadata({ readlink: async () => '../target' }, '/data/link', linkStat, metadataCapabilitiesForConnection('local', 'linux'));
  assert.equal(link.links.symbolic.target, '../target');
});

test('captures SFTP ownership, modes, second-resolution timestamps, and symbolic targets without hard-link claims', async () => {
  const sftp = { readlink: (_path, callback) => callback(null, '../remote-target') };
  const capabilities = metadataCapabilitiesForConnection('ssh', 'linux');
  const metadata = await captureSftpFileMetadata(sftp, '/srv/link', 'symlink', {
    mode: 0o120777, uid: 1000, gid: 1001, size: 0, atime: 1785758400, mtime: 1785758460
  }, capabilities);
  assert.equal(metadata.permissions.mode, 0o777);
  assert.equal(metadata.ownership.uid, 1000);
  assert.equal(metadata.timestamps.resolution, 'seconds');
  assert.equal(metadata.links.symbolic.target, '../remote-target');
  assert.equal(metadata.links.hard, null);
});

test('applies supported local metadata in ownership, permission, timestamp, and handler order', async () => {
  const calls = [];
  const fileSystem = {
    chown: async (...args) => calls.push(['chown', ...args]),
    chmod: async (...args) => calls.push(['chmod', ...args]),
    utimes: async (...args) => calls.push(['utimes', ...args])
  };
  const metadata = normalizeFileMetadata({
    type: 'file', size: 10, permissions: { mode: 0o640 }, ownership: { uid: 1000, gid: 1001 },
    timestamps: { accessedAt: '2026-08-03T12:00:00Z', modifiedAt: '2026-08-03T12:01:00Z' }
  }, { permissions: true, ownership: true, timestamps: true });
  const result = await applyLocalFileMetadata(fileSystem, '/restore/file', metadata, { permissions: true, ownership: true, timestamps: true });
  assert.deepEqual(calls.map((call) => call[0]), ['chown', 'chmod', 'utimes']);
  assert.deepEqual(result.applied, ['ownership', 'permissions', 'timestamps']);

  await assert.rejects(applyLocalFileMetadata({}, '/restore/file', {
    type: 'file', size: 10, acl: [{ type: 'allow', principal: 'u', permissions: ['read'] }]
  }, { acl: true }), (error) => error instanceof FileMetadataError && error.code === 'FILE_METADATA_RESTORE_HANDLER_MISSING');
});
