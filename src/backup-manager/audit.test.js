const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupAuditStore, StructuredLogStore, sanitizeForLog } = require('./audit');

async function temporaryDirectory(prefix) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { rootPath, cleanup: () => fs.rm(rootPath, { recursive: true, force: true }) };
}

async function readOnlyJsonlFile(rootPath) {
  const names = await fs.readdir(rootPath, { recursive: true });
  const fileName = names.find((name) => name.endsWith('.jsonl'));
  if (!fileName) throw new Error('JSONL output was not created.');
  return { path: path.join(rootPath, fileName), raw: await fs.readFile(path.join(rootPath, fileName), 'utf8') };
}

test('recursively redacts secret fields and credential-shaped strings', () => {
  const sanitized = sanitizeForLog({
    password: 'plain-password',
    nested: {
      authorization: 'Bearer abc.def.ghi',
      url: 'https://example.test/object?X-Amz-Signature=signature-value&part=1',
      connection: 'postgres://admin:database-password@example.test/db',
      message: 'token=visible-token',
      secretRefId: 'sec_safe_reference',
      providerKey: 'sec_provider_key'
    }
  });

  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.nested.authorization, '[REDACTED]');
  assert.match(sanitized.nested.url, /\[REDACTED\]/);
  assert.match(sanitized.nested.connection, /\[REDACTED\]@/);
  assert.match(sanitized.nested.message, /token=\[REDACTED\]/);
  assert.equal(sanitized.nested.secretRefId, 'sec_safe_reference');
  assert.equal(sanitized.nested.providerKey, 'sec_provider_key');
});

test('writes structured logs without plaintext secrets', async (context) => {
  const fixture = await temporaryDirectory('deployerx-log-test-');
  context.after(fixture.cleanup);
  const store = new StructuredLogStore({ rootPath: fixture.rootPath });
  const logger = store.logger({ workspaceId: 'local', component: 'test', correlationId: 'run-test' });
  await logger.error('Repository failed with password=message-secret', {
    password: 'field-secret',
    authorization: 'Bearer bearer-secret',
    secretRefId: 'sec_reference'
  });

  const output = await readOnlyJsonlFile(fixture.rootPath);
  assert.equal(output.raw.includes('message-secret'), false);
  assert.equal(output.raw.includes('field-secret'), false);
  assert.equal(output.raw.includes('bearer-secret'), false);
  assert.equal(output.raw.includes('sec_reference'), true);
  await store.append({ workspaceId: 'local', component: 'other', correlationId: 'run-other', level: 'info', message: 'other run' });
  const listed = await store.list('local', { correlationId: 'run-test', component: 'test', levels: ['error'], limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].correlationId, 'run-test');
  assert.equal(listed[0].level, 'error');
  assert.equal(JSON.stringify(listed).includes('message-secret'), false);
});

test('prunes structured log files beyond the configured retention window', async (context) => {
  const fixture = await temporaryDirectory('deployerx-log-retention-test-');
  context.after(fixture.cleanup);
  let currentTime = '2026-08-01T00:00:00.000Z';
  const store = new StructuredLogStore({
    rootPath: fixture.rootPath,
    clock: () => currentTime,
    retentionDays: 2
  });
  await store.append({ workspaceId: 'local', component: 'test', level: 'info', message: 'old' });
  currentTime = '2026-08-04T00:00:00.000Z';
  await store.append({ workspaceId: 'local', component: 'test', level: 'info', message: 'current' });

  const workspaceDirectory = path.join(fixture.rootPath, (await fs.readdir(fixture.rootPath))[0]);
  assert.deepEqual(await fs.readdir(workspaceDirectory), ['2026-08-04.jsonl']);
});

test('creates and verifies a sequential tamper-evident audit chain', async (context) => {
  const fixture = await temporaryDirectory('deployerx-audit-test-');
  context.after(fixture.cleanup);
  const store = new BackupAuditStore({ rootPath: fixture.rootPath });
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.append({
        workspaceId: 'local',
        actor: { type: 'user', id: 'tester' },
        action: 'secret.rotate',
        resource: { type: 'secret-ref', id: `sec_${index}` },
        outcome: 'success',
        details: { index, token: `token-${index}` }
      })
    )
  );

  const verification = await store.verify('local');
  assert.deepEqual(verification.error, null);
  assert.equal(verification.valid, true);
  assert.equal(verification.count, 8);
  const events = await store.list('local');
  assert.deepEqual(events.map((event) => event.sequence), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(JSON.stringify(events).includes('token-'), false);
});

test('detects audit event tampering', async (context) => {
  const fixture = await temporaryDirectory('deployerx-audit-tamper-test-');
  context.after(fixture.cleanup);
  const store = new BackupAuditStore({ rootPath: fixture.rootPath });
  await store.append({
    workspaceId: 'workspace-a',
    actor: { type: 'user', id: 'tester' },
    action: 'secret.create',
    resource: { type: 'secret-ref', id: 'sec_1' },
    outcome: 'success'
  });
  const output = await readOnlyJsonlFile(fixture.rootPath);
  await fs.writeFile(output.path, output.raw.replace('secret.create', 'secret.delete'), 'utf8');

  const verification = await store.verify('workspace-a');
  assert.equal(verification.valid, false);
  assert.equal(verification.error, 'event-hash-mismatch');
});

test('keeps workspace audit streams isolated', async (context) => {
  const fixture = await temporaryDirectory('deployerx-audit-workspace-test-');
  context.after(fixture.cleanup);
  const store = new BackupAuditStore({ rootPath: fixture.rootPath });
  await store.append({
    workspaceId: 'workspace-a', actor: { type: 'user', id: 'a' }, action: 'job.create', outcome: 'attempt'
  });
  await store.append({
    workspaceId: 'workspace-b', actor: { type: 'user', id: 'b' }, action: 'job.create', outcome: 'attempt'
  });

  assert.equal((await store.list('workspace-a')).length, 1);
  assert.equal((await store.list('workspace-b')).length, 1);
  assert.equal((await store.list('workspace-a'))[0].actor.id, 'a');
});
