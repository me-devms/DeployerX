const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupSecretStore } = require('./secrets');

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage is unavailable on this device.');
  }

  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-secrets-electron-test-'));
  try {
    const store = new BackupSecretStore({
      rootPath,
      secureStorage: safeStorage,
      isReferenced: async () => false
    });
    const plaintext = `integration-${Date.now()}-${Math.random()}`;
    const created = await store.create({
      workspaceId: 'integration-test',
      name: 'Electron safeStorage test',
      secretType: 'token',
      value: plaintext,
      actorId: 'integration-test'
    });
    const resolved = await store.resolve({ workspaceId: 'integration-test', id: created.id });
    const rawStore = await fs.readFile(path.join(rootPath, 'secrets.json'), 'utf8');
    if (resolved !== plaintext) throw new Error('Resolved secret does not match the original value.');
    if (rawStore.includes(plaintext)) throw new Error('Secret store contains plaintext.');
    if (Object.hasOwn(created, 'value')) throw new Error('Public SecretRef contains a plaintext value field.');
    await store.delete({ workspaceId: 'integration-test', id: created.id });
    if ((await store.list('integration-test')).length !== 0) throw new Error('Deleted secret metadata remains visible.');
    process.stdout.write(JSON.stringify({ ok: true, provider: created.provider, version: created.version }));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

run()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(error?.stack || String(error));
    app.exit(1);
  });
