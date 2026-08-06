const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Duplex, PassThrough, Readable } = require('node:stream');
const { fingerprintHostKey } = require('./ssh-connection');
const { SshExecutionSession, commandFromArgs, connectionConfigFromRecord, openSshExecutionSession, shellQuote } = require('./ssh-execution');

test('SSH command arguments are quoted as single shell arguments', () => {
  assert.equal(shellQuote("a'b;$(bad)"), `'a'"'"'b;$(bad)'`);
  assert.equal(commandFromArgs('/usr/bin/xtrabackup', ['--target-dir=/var/tmp/a b', '--backup']), "'/usr/bin/xtrabackup' '--target-dir=/var/tmp/a b' '--backup'");
  assert.equal(commandFromArgs('systemctl', ['stop', 'mysql'], { privilegeMode: 'sudo-noninteractive' }), "'sudo' '-n' '--' 'systemctl' 'stop' 'mysql'");
  assert.equal(commandFromArgs('rman', ['target', '/'], { privilegeMode: 'sudo-noninteractive', runAsUser: 'oracle' }), "'sudo' '-n' '-u' 'oracle' '--' 'rman' 'target' '/'");
  assert.throws(() => commandFromArgs('rman', [], { privilegeMode: 'direct', runAsUser: 'oracle' }), /requires non-interactive sudo/);
  assert.throws(() => commandFromArgs('rman', [], { privilegeMode: 'sudo-noninteractive', runAsUser: 'oracle;id' }), /execution user/);
  assert.throws(() => commandFromArgs('xtrabackup;id', []), /executable/);
});

test('saved SSH records retain SecretRefs and pinned trust', () => {
  const config = connectionConfigFromRecord({
    adapterId: 'deployerx.connection.ssh',
    endpoint: { host: 'db.example.com', port: 22, username: 'backup', authType: 'private-key', timeoutMs: 20000 },
    secretRefIds: ['sec_12345678', 'sec_abcdefgh'],
    trust: { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', algorithm: 'ssh-ed25519' }
  });
  assert.equal(config.credentialSecretRefId, 'sec_12345678');
  assert.equal(config.passphraseSecretRefId, 'sec_abcdefgh');
  assert.equal(config.hostKeyFingerprint, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
});

test('SSH execution resolves credentials only after the pinned host key matches', async () => {
  const hostKey = Buffer.from('approved-host-key');
  const events = [];
  class FakeClient extends EventEmitter {
    connect(config) {
      events.push('verify');
      assert.equal(config.hostVerifier(hostKey), true);
      config.authHandler([], false, (authentication) => {
        events.push('authenticate');
        assert.equal(authentication.password, 'private-password');
        this.emit('ready');
      });
    }
    end() {}
  }
  const session = await openSshExecutionSession({
    connectionConfig: { host: 'db.example.com', port: 22, username: 'backup', authType: 'password', credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(hostKey), timeoutMs: 1000 },
    resolveSecret: async () => { events.push('resolve'); return 'private-password'; }, clientFactory: () => new FakeClient()
  });
  assert.deepEqual(events, ['verify', 'resolve', 'authenticate']);
  session.close();
});

test('SSH execution rejects a changed host key without resolving credentials', async () => {
  let resolutions = 0;
  class FakeClient extends EventEmitter {
    connect(config) {
      assert.equal(config.hostVerifier(Buffer.from('changed-host-key')), false);
      config.authHandler([], false, (authentication) => assert.equal(authentication, false));
      this.emit('error', Object.assign(new Error('host key rejected'), { level: 'handshake' }));
    }
    end() {}
  }
  await assert.rejects(openSshExecutionSession({
    connectionConfig: { host: 'db.example.com', port: 22, username: 'backup', authType: 'password', credentialSecretRefId: 'sec_password', hostKeyFingerprint: fingerprintHostKey(Buffer.from('approved-host-key')), timeoutMs: 1000 },
    resolveSecret: async () => { resolutions += 1; return 'must-not-resolve'; }, clientFactory: () => new FakeClient()
  }), (error) => error.code === 'SSH_HOST_KEY_MISMATCH');
  assert.equal(resolutions, 0);
});

test('SSH stdin consumption waits for the remote exit status after upload finishes', async () => {
  let finishUpload;
  let remoteStream;
  const uploadFinished = new Promise((resolve) => { finishUpload = resolve; });
  const client = {
    exec(_command, callback) {
      remoteStream = new Duplex({
        emitClose: false,
        read() {},
        write(_chunk, _encoding, done) { done(); },
        final(done) {
          done();
          finishUpload();
        }
      });
      remoteStream.stderr = new PassThrough();
      callback(null, remoteStream);
    }
  };
  const session = new SshExecutionSession(client);
  let settled = false;
  const consumed = session.consume("'xbstream' '-x'", Readable.from([Buffer.from('artifact')]));
  consumed.finally(() => { settled = true; }).catch(() => {});

  await uploadFinished;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  remoteStream.emit('close', 0);
  assert.deepEqual(await consumed, { stdout: '', stderr: '', exitCode: 0 });
});

test('SSH stdin consumption reports the delayed remote exit code', async () => {
  let remoteStream;
  const client = {
    exec(_command, callback) {
      remoteStream = new Duplex({
        emitClose: false,
        read() {},
        write(_chunk, _encoding, done) { done(); },
        final(done) {
          done();
          setImmediate(() => remoteStream.emit('close', 7));
        }
      });
      remoteStream.stderr = new PassThrough();
      callback(null, remoteStream);
    }
  };

  await assert.rejects(
    new SshExecutionSession(client).consume("'xbstream' '-x'", Readable.from([Buffer.from('artifact')])),
    (error) => error.code === 'SSH_COMMAND_FAILED' && error.exitCode === 7
  );
});

test('SSH protected file upload streams async iterable recovery media without buffering it as one value', async () => {
  const chunks = [];
  let ended = false;
  const client = {
    sftp(callback) {
      callback(null, {
        createWriteStream(remotePath, options) {
          assert.equal(remotePath, '/tmp/recovery-media');
          assert.equal(options.flags, 'wx');
          assert.equal(options.mode, 0o600);
          const output = new PassThrough();
          output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          return output;
        },
        end() { ended = true; }
      });
    }
  };
  const content = (async function* recoveryChunks() { yield Buffer.from('first-'); yield Buffer.from('second'); })();
  await new SshExecutionSession(client).writeFile('/tmp/recovery-media', content, { mode: 0o600 });
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'first-second');
  assert.equal(ended, true);
});
