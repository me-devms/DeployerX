const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Server } = require('ssh2');
const { BackupControlDatabase } = require('./control-database');
const { BackupSecretStore } = require('./secrets');
const {
  ADAPTER_ID,
  LinuxSshConnectionAdapter,
  SshConnectionService,
  fingerprintHostKey
} = require('./ssh-connection');

const HOST_KEY = Buffer.from('ssh-test-host-key-material');
const OTHER_HOST_KEY = Buffer.from('different-ssh-host-key');

class FakeStream extends EventEmitter {
  constructor(output = 'Linux\n', exitCode = 0) {
    super();
    this.output = output;
    this.exitCode = exitCode;
    this.stderr = new EventEmitter();
  }

  start() {
    queueMicrotask(() => {
      if (this.output) this.emit('data', Buffer.from(this.output));
      this.emit('close', this.exitCode);
    });
  }
}

class FakeClient extends EventEmitter {
  constructor({ hostKey = HOST_KEY, authFailure = false, hangAfterHostKey = false, platform = 'Linux\n', sftpFailure = false, sftpEntries = [], sftpReadFailure = null, sftpReadlinks = {}, events = [] } = {}) {
    super();
    this.hostKey = hostKey;
    this.authFailure = authFailure;
    this.hangAfterHostKey = hangAfterHostKey;
    this.platform = platform;
    this.sftpFailure = sftpFailure;
    this.sftpEntries = sftpEntries;
    this.sftpReadFailure = sftpReadFailure;
    this.sftpReadlinks = sftpReadlinks;
    this.events = events;
    this.connectConfig = null;
  }

  connect(config) {
    this.connectConfig = config;
    queueMicrotask(() => {
      this.events.push('host-verifier');
      const accepted = config.hostVerifier(this.hostKey);
      if (!accepted) {
        if (config.authHandler) this.emit('error', Object.assign(new Error('host rejected'), { level: 'handshake' }));
        return;
      }
      if (this.hangAfterHostKey) return;
      config.authHandler(null, null, (auth) => {
        this.events.push('auth-callback');
        this.auth = auth;
        if (!auth || this.authFailure) this.emit('error', Object.assign(new Error('auth failed'), { level: 'client-authentication' }));
        else this.emit('ready');
      });
    });
  }

  exec(command, callback) {
    assert.equal(command, 'uname -s');
    const stream = new FakeStream(this.platform);
    callback(null, stream);
    stream.start();
  }

  sftp(callback) {
    if (this.sftpFailure) callback(new Error('disabled'));
    else callback(null, {
      end() {},
      readdir: (remotePath, done) => {
        this.events.push(`sftp-readdir:${remotePath}`);
        if (this.sftpReadFailure) done(this.sftpReadFailure);
        else done(null, this.sftpEntries);
      },
      readlink: (remotePath, done) => {
        this.events.push(`sftp-readlink:${remotePath}`);
        const target = this.sftpReadlinks[remotePath];
        if (target === undefined) done(new Error('missing link'));
        else done(null, target);
      }
    });
  }

  end() {}
}

function queueClientFactory(scenarios) {
  const clients = [];
  return {
    clients,
    factory: () => {
      const client = new FakeClient(scenarios.shift() || {});
      clients.push(client);
      return client;
    }
  };
}

function fakeSecureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  };
}

async function serviceFixture(context, scenarios = [{}, {}]) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-ssh-connection-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const controlDatabase = new BackupControlDatabase({ rootPath });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const secretStore = new BackupSecretStore({
    rootPath,
    secureStorage: fakeSecureStorage(),
    isReferenced: async ({ workspaceId, id }) => {
      const connections = await controlDatabase.repository('connection').list(workspaceId, { includeDeleted: true, limit: 1000 });
      return connections.some((connection) => !connection.deletedAt && connection.secretRefIds?.includes(id));
    }
  });
  await secretStore.initialize();
  const queued = queueClientFactory(scenarios);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory, clock: () => '2026-08-03T12:00:00.000Z' });
  const service = new SshConnectionService({ controlDatabase, secretStore, deviceId: 'device_test', adapter });
  return { rootPath, controlDatabase, secretStore, adapter, service, clients: queued.clients };
}

test('scans a host key without configuring or transmitting credentials', async () => {
  const queued = queueClientFactory([{}]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  const result = await adapter.scanHostKey({}, { host: 'Example.COM', port: 22, timeoutMs: 1000 });
  assert.equal(result.status, 'success');
  assert.equal(result.host, 'example.com');
  assert.equal(result.fingerprint, fingerprintHostKey(HOST_KEY));
  const config = queued.clients[0].connectConfig;
  assert.equal(Object.hasOwn(config, 'password'), false);
  assert.equal(Object.hasOwn(config, 'privateKey'), false);
  assert.equal(Object.hasOwn(config, 'authHandler'), false);
});

test('resolves password only after the approved host key matches', async () => {
  const events = [];
  const queued = queueClientFactory([{ events }]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  const result = await adapter.testConnection({
    resolveSecret: async (id) => {
      events.push(`resolve:${id}`);
      return 'password-value';
    }
  }, {
    host: 'server.example.com', port: 22, username: 'backup', authType: 'password',
    credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(events, ['host-verifier', 'resolve:sec_password', 'auth-callback']);
  assert.equal(queued.clients[0].auth.password, 'password-value');
  assert.equal(result.remotePlatform.os, 'linux');
});

test('rejects a changed host key before resolving any SecretRef', async () => {
  let resolutions = 0;
  const queued = queueClientFactory([{ hostKey: OTHER_HOST_KEY }]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  const result = await adapter.testConnection({
    resolveSecret: async () => { resolutions += 1; return 'must-not-resolve'; }
  }, {
    host: 'server.example.com', port: 22, username: 'backup', authType: 'password',
    credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000
  });
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'SSH_HOST_KEY_MISMATCH');
  assert.equal(result.error.details.observedFingerprint, fingerprintHostKey(OTHER_HOST_KEY));
  assert.equal(resolutions, 0);
});

test('supports encrypted private keys and returns bounded diagnostics', async () => {
  const queued = queueClientFactory([{}, { authFailure: true }, { platform: 'FreeBSD\n' }, { sftpFailure: true }]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  const base = {
    host: 'server.example.com', port: 22, username: 'backup', authType: 'private-key',
    credentialSecretRefId: 'sec_key', passphraseSecretRefId: 'sec_passphrase',
    hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000
  };
  const successful = await adapter.testConnection({ resolveSecret: async (id) => id === 'sec_key' ? 'PRIVATE KEY' : 'key-passphrase' }, base);
  assert.equal(successful.status, 'success');
  assert.equal(queued.clients[0].auth.type, 'publickey');
  assert.equal(queued.clients[0].auth.passphrase, 'key-passphrase');
  const authentication = await adapter.testConnection({ resolveSecret: async () => 'wrong' }, base);
  assert.equal(authentication.error.code, 'SSH_AUTHENTICATION_FAILED');
  const platform = await adapter.testConnection({ resolveSecret: async () => 'key' }, base);
  assert.equal(platform.error.code, 'SSH_NOT_LINUX');
  const sftp = await adapter.testConnection({ resolveSecret: async () => 'key' }, base);
  assert.equal(sftp.error.code, 'SSH_SFTP_UNAVAILABLE');
  assert.equal(JSON.stringify([authentication, platform, sftp]).includes('wrong'), false);
});

test('bounds stalled tests and handles cancellation without resolving secrets', async () => {
  let resolutions = 0;
  const queued = queueClientFactory([{ hangAfterHostKey: true }, {}]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  const config = {
    host: 'server.example.com', port: 22, username: 'backup', authType: 'password',
    credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000
  };
  const timeout = await adapter.testConnection({ resolveSecret: async () => { resolutions += 1; return 'secret'; } }, config);
  assert.equal(timeout.error.code, 'SSH_CONNECTION_TIMEOUT');
  assert.equal(resolutions, 0);

  const controller = new AbortController();
  controller.abort();
  const canceled = await adapter.testConnection({ signal: controller.signal, resolveSecret: async () => { resolutions += 1; return 'secret'; } }, config);
  assert.equal(canceled.error.code, 'SSH_TEST_CANCELED');
  assert.equal(resolutions, 0);
  assert.equal(queued.clients[1].connectConfig, null);
});

test('lazily browses SFTP directories after host-key verification and paginates stable entries', async () => {
  const events = [];
  const sftpEntries = [
    { filename: 'z.txt', longname: '-rw-r--r--', attrs: { mode: 0o100644, size: 8, mtime: 1785758400 } },
    { filename: 'configs', longname: 'drwxr-xr-x', attrs: { mode: 0o040755, size: 0, mtime: 1785758400 } },
    { filename: 'current', longname: 'lrwxrwxrwx', attrs: { mode: 0o120777, size: 7, mtime: 1785758400 } },
    { filename: '.env', longname: '-rw-------', attrs: { mode: 0o100600, size: 20, mtime: 1785758400 } }
  ];
  const scenario = { events, sftpEntries, sftpReadlinks: { '/srv/data/current': 'configs' } };
  const queued = queueClientFactory([scenario, scenario]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  const config = {
    host: 'server.example.com', port: 22, username: 'backup', authType: 'password',
    credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000,
    path: '/srv/data', pageSize: 3
  };
  const first = await adapter.browse({ resolveSecret: async (id) => { events.push(`resolve:${id}`); return 'password'; } }, config);
  const second = await adapter.browse({ resolveSecret: async () => 'password' }, { ...config, cursor: first.nextCursor });
  assert.deepEqual(events.slice(0, 3), ['host-verifier', 'resolve:sec_password', 'auth-callback']);
  assert.equal(first.path, '/srv/data');
  assert.equal(first.items[0].type, 'directory');
  assert.equal(first.items.length, 3);
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.id)).size, 4);
  const symbolicLink = [...first.items, ...second.items].find((entry) => entry.name === 'current');
  assert.equal(symbolicLink.metadata.links.symbolic.target, 'configs');
  assert.equal(symbolicLink.metadata.links.hard, null);
  assert.equal(Object.hasOwn(symbolicLink, 'sourceAttributes'), false);
});

test('rejects changed SSH host keys before SFTP browsing resolves secrets', async () => {
  let resolutions = 0;
  const queued = queueClientFactory([{ hostKey: OTHER_HOST_KEY }]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  await assert.rejects(adapter.browse({ resolveSecret: async () => { resolutions += 1; return 'secret'; } }, {
    host: 'server.example.com', port: 22, username: 'backup', authType: 'password',
    credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000,
    path: '/srv'
  }), (error) => error.code === 'SSH_HOST_KEY_MISMATCH');
  assert.equal(resolutions, 0);
});

test('cancels SFTP browsing before connecting or resolving secrets', async () => {
  let resolutions = 0;
  const queued = queueClientFactory([{}]);
  const adapter = new LinuxSshConnectionAdapter({ clientFactory: queued.factory });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.browse({ signal: controller.signal, resolveSecret: async () => { resolutions += 1; return 'secret'; } }, {
    host: 'server.example.com', port: 22, username: 'backup', authType: 'password',
    credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000,
    path: '/srv'
  }), (error) => error.code === 'DISCOVERY_CANCELED');
  assert.equal(resolutions, 0);
  assert.equal(queued.clients[0].connectConfig, null);
});

test('creates only after re-scanning the approved fingerprint and persists SecretRef IDs', async (context) => {
  const fixture = await serviceFixture(context);
  const connection = await fixture.service.create('local', 'tester', {
    name: 'Production server', host: 'prod.example.com', port: 22, username: 'backup',
    authType: 'password', credential: 'plain-ssh-password',
    hostKeyApproved: true,
    hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000
  });
  assert.equal(connection.adapterId, ADAPTER_ID);
  assert.equal(connection.secretRefIds.length, 1);
  assert.equal(connection.scope, 'device');
  assert.deepEqual(connection.workerAffinity, ['device:device_test']);
  assert.equal(Object.hasOwn(connection.endpoint, 'password'), false);
  assert.equal(connection.trust.fingerprint, fingerprintHostKey(HOST_KEY));
  assert.equal((await fixture.controlDatabase.repository('secretRef').list('local')).length, 1);
  assert.equal((await fixture.service.list('local')).length, 1);
  const listing = await fixture.service.browse('local', connection.id, { path: '/', pageSize: 10 });
  assert.equal(listing.path, '/');
  assert.equal(listing.endpointIdentity.host, 'prod.example.com');

  const rawSecrets = await fs.readFile(path.join(fixture.rootPath, 'secrets.json'), 'utf8');
  const rawDatabase = await fs.readFile(path.join(fixture.rootPath, 'control.db'));
  assert.equal(rawSecrets.includes('plain-ssh-password'), false);
  assert.equal(rawDatabase.includes(Buffer.from('plain-ssh-password')), false);
});

test('tests a persisted connection and updates SecretRef validation metadata', async (context) => {
  const fixture = await serviceFixture(context);
  const connection = await fixture.service.create('workspace-a', 'tester', {
    name: 'Linux files', host: 'files.example.com', username: 'backup', authType: 'private-key',
    credential: 'PRIVATE KEY MATERIAL', passphrase: 'key-secret',
    hostKeyApproved: true,
    hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000
  });
  const tested = await fixture.service.test('workspace-a', connection.id, 'tester');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.revision, 2);
  for (const secretRefId of connection.secretRefIds) {
    const secureMetadata = (await fixture.secretStore.list('workspace-a')).find((ref) => ref.id === secretRefId);
    const controlMetadata = await fixture.controlDatabase.repository('secretRef').get('workspace-a', secretRefId);
    assert.match(controlMetadata.lastValidatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(controlMetadata.lastValidatedAt, secureMetadata.lastValidatedAt);
  }
});

test('does not create secrets when the approved fingerprint is stale', async (context) => {
  const fixture = await serviceFixture(context, [{}]);
  await assert.rejects(fixture.service.create('local', 'tester', {
    name: 'Changed server', host: 'changed.example.com', username: 'backup', authType: 'password',
    credential: 'must-not-persist', hostKeyApproved: true, hostKeyFingerprint: fingerprintHostKey(OTHER_HOST_KEY), timeoutMs: 1000
  }), /host key changed/);
  assert.deepEqual(await fixture.secretStore.list('local'), []);
  assert.deepEqual(await fixture.service.list('local'), []);
});

test('refuses direct service creation without explicit host-key approval', async (context) => {
  const fixture = await serviceFixture(context, []);
  await assert.rejects(fixture.service.create('local', 'tester', {
    name: 'Unapproved server', host: 'server.example.com', username: 'backup', authType: 'password',
    credential: 'must-not-persist', hostKeyFingerprint: fingerprintHostKey(HOST_KEY), timeoutMs: 1000
  }), /Explicit SSH host-key approval/);
  assert.deepEqual(await fixture.secretStore.list('local'), []);
});

test('enforces host-key verification against a real loopback SSH protocol', async (context) => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' });
  let authenticationAttempts = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (auth) => {
      authenticationAttempts += 1;
      if (auth.method === 'password' && auth.username === 'backup' && auth.password === 'correct-password') auth.accept();
      else auth.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          if (info.command === 'uname -s') stream.write('Linux\n');
          stream.exit(info.command === 'uname -s' ? 0 : 1);
          stream.end();
        });
        session.on('sftp', (acceptSftp) => acceptSftp());
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const adapter = new LinuxSshConnectionAdapter();

  const scan = await adapter.scanHostKey({}, { host: '127.0.0.1', port, timeoutMs: 3000 });
  assert.equal(scan.status, 'success');
  assert.match(scan.fingerprint, /^SHA256:/);
  assert.equal(authenticationAttempts, 0);

  const authenticated = await adapter.testConnection({ resolveSecret: async () => 'correct-password' }, {
    host: '127.0.0.1', port, username: 'backup', authType: 'password', credentialSecretRefId: 'sec_password',
    hostKeyFingerprint: scan.fingerprint, hostKeyAlgorithm: scan.algorithm, timeoutMs: 3000
  });
  assert.equal(authenticated.status, 'success');
  assert.equal(authenticationAttempts, 1);

  let mismatchResolutions = 0;
  const mismatch = await adapter.testConnection({ resolveSecret: async () => { mismatchResolutions += 1; return 'correct-password'; } }, {
    host: '127.0.0.1', port, username: 'backup', authType: 'password', credentialSecretRefId: 'sec_password',
    hostKeyFingerprint: fingerprintHostKey(OTHER_HOST_KEY), timeoutMs: 3000
  });
  assert.equal(mismatch.error.code, 'SSH_HOST_KEY_MISMATCH');
  assert.equal(mismatchResolutions, 0);
  assert.equal(authenticationAttempts, 1);
});
