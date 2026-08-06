const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { FileSourceService, LOCAL_FILE_ADAPTER_ID, SSH_FILE_ADAPTER_ID, normalizeFileSelector } = require('./file-selection');

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-file-selection-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => '2026-08-03T12:00:00.000Z' });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const localConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Local', kind: 'local',
    adapterId: 'deployerx.connection.local', endpoint: { platform: 'windows', architecture: 'x64' }
  });
  const sshConnection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'SSH', kind: 'ssh',
    adapterId: 'deployerx.connection.ssh', endpoint: { host: 'example.com' }
  });
  return { controlDatabase, localConnection, sshConnection, service: new FileSourceService({ controlDatabase, clock: () => '2026-08-03T12:00:00.000Z' }) };
}

test('normalizes roots, removes redundant descendants, and produces a stable digest', () => {
  const input = {
    roots: [
      { path: 'C:\\Data\\Projects', type: 'directory' },
      { path: 'c:\\data\\projects\\nested.txt', type: 'file' },
      { path: 'C:\\Data\\Other.txt', type: 'file' }
    ],
    includePatterns: ['**/*.sql', '**/*.sql'],
    excludePatterns: ['**/node_modules/**', '**/*.tmp'],
    options: { includeHidden: true, crossMounts: false }
  };
  const first = normalizeFileSelector(input, { platform: 'windows' });
  const second = normalizeFileSelector(input, { platform: 'windows' });
  assert.equal(first.roots.length, 2);
  assert.deepEqual(first.includePatterns, ['**/*.sql']);
  assert.equal(first.options.includeHidden, true);
  assert.equal(first.options.crossMounts, false);
  assert.deepEqual(first.metadataPolicy.preserve, {
    permissions: false,
    ownership: false,
    timestamps: true,
    acl: false,
    extendedAttributes: false,
    symbolicLinks: true,
    hardLinks: true,
    sparseFiles: false
  });
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
});

test('derives truthful metadata policies and includes them in the selection digest', () => {
  const roots = [{ path: '/srv/data', type: 'directory' }];
  const local = normalizeFileSelector({ roots }, { platform: 'posix', connectionKind: 'local' });
  const ssh = normalizeFileSelector({ roots }, { platform: 'posix', connectionKind: 'ssh' });
  const reduced = normalizeFileSelector({
    roots,
    metadataPolicy: { fields: { hardLinks: true, acl: true, timestamps: false }, onUnsupported: 'warn' }
  }, { platform: 'posix', connectionKind: 'ssh' });

  assert.equal(local.metadataPolicy.preserve.hardLinks, true);
  assert.equal(local.metadataPolicy.preserve.permissions, true);
  assert.equal(local.metadataPolicy.preserve.ownership, true);
  assert.equal(ssh.metadataPolicy.preserve.hardLinks, false);
  assert.equal(ssh.metadataPolicy.requested.hardLinks, false);
  assert.deepEqual(reduced.metadataPolicy.reductions, [
    { field: 'acl', reasonCode: 'METADATA_ACL_UNSUPPORTED' },
    { field: 'hardLinks', reasonCode: 'METADATA_HARD_LINKS_UNSUPPORTED' }
  ]);
  assert.equal(reduced.metadataPolicy.preserve.timestamps, false);
  assert.notEqual(reduced.digest, ssh.digest);
});

test('rejects relative roots and ambiguous or unsafe glob syntax', () => {
  assert.throws(() => normalizeFileSelector({ roots: [{ path: 'relative', type: 'file' }] }, { platform: 'posix' }), /absolute/);
  const base = { roots: [{ path: '/srv/data', type: 'directory' }] };
  for (const pattern of ['/absolute/**', '../escape', '!negated', 'bad\\pattern', 'bad/[class']) {
    assert.throws(() => normalizeFileSelector({ ...base, excludePatterns: [pattern] }, { platform: 'posix' }));
  }
});

test('creates and lists workspace-scoped local and SSH file sources', async (context) => {
  const { service, localConnection, sshConnection } = await fixture(context);
  const local = await service.save('workspace-a', 'tester', {
    name: 'Local projects', connectionId: localConnection.id,
    selector: { roots: [{ path: 'C:\\Data', type: 'directory' }], includePatterns: ['**/*'], excludePatterns: [], options: { includeHidden: false, crossMounts: false } }
  });
  const ssh = await service.save('workspace-a', 'tester', {
    name: 'Server configuration', connectionId: sshConnection.id,
    selector: { roots: [{ path: '/etc', type: 'directory' }], includePatterns: [], excludePatterns: ['**/*.tmp'], options: { includeHidden: true, crossMounts: true } }
  });
  assert.equal(local.adapterId, LOCAL_FILE_ADAPTER_ID);
  assert.equal(ssh.adapterId, SSH_FILE_ADAPTER_ID);
  assert.equal(local.platform.metadataCapabilities.hardLinks, true);
  assert.equal(local.platform.metadataCapabilities.permissions, false);
  assert.equal(ssh.platform.metadataCapabilities.hardLinks, false);
  assert.equal(ssh.selector.metadataPolicy.preserve.hardLinks, false);
  assert.deepEqual(ssh.lastDiscovery.metadataReductions, []);
  assert.equal((await service.list('workspace-a')).length, 2);
  assert.deepEqual(await service.list('workspace-b'), []);
  assert.equal((await service.list('workspace-a', { connectionId: sshConnection.id }))[0].id, ssh.id);
});

test('edits with optimistic revisions and soft-deletes file sources', async (context) => {
  const { service, localConnection } = await fixture(context);
  const created = await service.save('workspace-a', 'tester', {
    name: 'Documents', connectionId: localConnection.id,
    selector: { roots: [{ path: 'C:\\Users\\Test\\Documents', type: 'directory' }] }
  });
  const updated = await service.save('workspace-a', 'tester', {
    id: created.id, revision: created.revision, name: 'Documents and reports', connectionId: localConnection.id,
    selector: { roots: [{ path: 'C:\\Users\\Test\\Documents', type: 'directory' }], excludePatterns: ['**/*.tmp'] }
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.selector.excludePatterns, ['**/*.tmp']);
  await assert.rejects(service.save('workspace-a', 'tester', {
    id: created.id, revision: 1, name: 'Stale', connectionId: localConnection.id,
    selector: { roots: [{ path: 'C:\\Users\\Test', type: 'directory' }] }
  }), /revision conflict/);
  const deleted = await service.remove('workspace-a', 'tester', updated.id, updated.revision);
  assert.equal(deleted.revision, 3);
  assert.deepEqual(await service.list('workspace-a'), []);
});
