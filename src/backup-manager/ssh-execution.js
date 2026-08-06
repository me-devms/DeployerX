const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Client } = require('ssh2');
const {
  ADAPTER_ID: SSH_CONNECTION_ADAPTER_ID,
  LinuxSshConnectionAdapter,
  fingerprintHostKey
} = require('./ssh-connection');

const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAX_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

class SshExecutionError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SshExecutionError';
    this.code = code;
    this.category = options.category || 'execution';
    this.retryable = Boolean(options.retryable);
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function shellQuote(value) {
  const text = String(value ?? '');
  if (text.includes('\0') || text.length > 16384) throw new TypeError('Remote command argument is invalid.');
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function commandFromArgs(executable, args = [], options = {}) {
  const binary = requiredText(executable, 'Remote executable', 512);
  if (!/^(?:\/[A-Za-z0-9._+/-]+|[A-Za-z0-9._+-]+)$/.test(binary) || binary.includes('..')) throw new TypeError('Remote executable is invalid.');
  if (!Array.isArray(args) || args.length > 256) throw new TypeError('Remote command arguments are invalid.');
  const command = [shellQuote(binary), ...args.map(shellQuote)].join(' ');
  const runAsUser = options.runAsUser === undefined || options.runAsUser === null || options.runAsUser === '' ? null : requiredText(options.runAsUser, 'Remote execution user', 32);
  if (runAsUser && !/^[a-z_][a-z0-9_-]{0,30}\$?$/.test(runAsUser)) throw new TypeError('Remote execution user is invalid.');
  if (options.privilegeMode === 'sudo-noninteractive') return runAsUser ? `'sudo' '-n' '-u' ${shellQuote(runAsUser)} '--' ${command}` : `'sudo' '-n' '--' ${command}`;
  if (runAsUser) throw new TypeError('A remote execution user requires non-interactive sudo mode.');
  if (options.privilegeMode && options.privilegeMode !== 'direct') throw new TypeError('Remote privilege mode is invalid.');
  return command;
}

function outputLimit(value) {
  const limit = Number(value ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTPUT_LIMIT_BYTES) throw new TypeError('SSH output limit is invalid.');
  return limit;
}

function appendBounded(state, chunk, limit) {
  const value = Buffer.from(chunk);
  state.bytes += value.length;
  if (state.bytes > limit) {
    state.overflow = true;
    return;
  }
  state.chunks.push(value);
}

function connectionConfigFromRecord(connection) {
  if (!connection || connection.adapterId !== SSH_CONNECTION_ADAPTER_ID) throw new TypeError('A saved SSH connection is required.');
  const [credentialSecretRefId, passphraseSecretRefId = null] = connection.secretRefIds || [];
  return new LinuxSshConnectionAdapter().normalizeConfig({
    ...connection.endpoint,
    credentialSecretRefId,
    passphraseSecretRefId,
    hostKeyFingerprint: connection.trust?.fingerprint,
    hostKeyAlgorithm: connection.trust?.algorithm
  });
}

function classifyConnectionError(error, flags = {}) {
  if (flags.hostKeyMismatch) return new SshExecutionError('SSH_HOST_KEY_MISMATCH', 'The server host key does not match the approved fingerprint.', { category: 'integrity' });
  if (flags.canceled || error?.code === 'ABORT_ERR') return new SshExecutionError('SSH_EXECUTION_CANCELED', 'The remote operation was canceled.', { category: 'canceled' });
  if (error?.code === 'ETIMEDOUT' || error?.level === 'client-timeout') return new SshExecutionError('SSH_EXECUTION_TIMEOUT', 'The SSH server did not respond before the timeout.', { category: 'timeout', retryable: true });
  if (error?.level === 'client-authentication') return new SshExecutionError('SSH_AUTHENTICATION_FAILED', 'SSH authentication failed.', { category: 'authentication' });
  return new SshExecutionError('SSH_EXECUTION_CONNECT_FAILED', 'DeployerX could not establish the SSH execution session.', { category: 'connectivity', retryable: true });
}

function sftpSession(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
}

class SshExecutionSession {
  constructor(client, options = {}) {
    this.client = client;
    this.signal = options.signal || null;
    this.closed = false;
  }

  async run(command, options = {}) {
    const opened = await this.stream(command, options);
    const stdout = { chunks: [], bytes: 0, overflow: false };
    try {
      for await (const chunk of opened.stdout) appendBounded(stdout, chunk, outputLimit(options.stdoutLimitBytes));
      const completion = await opened.completion;
      if (stdout.overflow) throw new SshExecutionError('SSH_EXECUTION_OUTPUT_LIMIT', 'The remote command returned more output than allowed.', { category: 'capacity' });
      return { stdout: Buffer.concat(stdout.chunks).toString('utf8'), stderr: completion.stderr, exitCode: completion.exitCode };
    } catch (error) {
      opened.close();
      throw error;
    }
  }

  stream(command, options = {}) {
    const remoteCommand = requiredText(command, 'Remote command', 65536);
    const stderrLimit = outputLimit(options.stderrLimitBytes || DEFAULT_OUTPUT_LIMIT_BYTES);
    const signal = options.ignoreAbort ? null : this.signal;
    if (signal?.aborted) return Promise.reject(new SshExecutionError('SSH_EXECUTION_CANCELED', 'The remote operation was canceled.', { category: 'canceled' }));
    return new Promise((resolve, reject) => {
      this.client.exec(remoteCommand, (error, stream) => {
        if (error) return reject(new SshExecutionError('SSH_COMMAND_START_FAILED', 'The remote command could not be started.', { retryable: true }));
        const stderr = { chunks: [], bytes: 0, overflow: false };
        stream.stderr?.on('data', (chunk) => appendBounded(stderr, chunk, stderrLimit));
        const onAbort = () => stream.destroy(Object.assign(new Error('Canceled'), { code: 'ABORT_ERR' }));
        signal?.addEventListener?.('abort', onAbort, { once: true });
        let settled = false;
        const completion = new Promise((complete, fail) => {
          const finish = (failure, result) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener?.('abort', onAbort);
            if (failure) fail(failure);
            else complete(result);
          };
          stream.once('error', (streamError) => finish(streamError?.code === 'ABORT_ERR'
            ? new SshExecutionError('SSH_EXECUTION_CANCELED', 'The remote operation was canceled.', { category: 'canceled' })
            : new SshExecutionError('SSH_COMMAND_STREAM_FAILED', 'The SSH command stream failed.', { retryable: true })));
          stream.once('close', (code) => {
            const stderrText = Buffer.concat(stderr.chunks).toString('utf8');
            if (stderr.overflow) return finish(new SshExecutionError('SSH_EXECUTION_OUTPUT_LIMIT', 'The remote command returned more diagnostic output than allowed.', { category: 'capacity' }));
            if (code !== 0) return finish(new SshExecutionError('SSH_COMMAND_FAILED', 'The remote command failed.', { exitCode: Number.isInteger(code) ? code : null }));
            finish(null, { exitCode: 0, stderr: stderrText });
          });
        });
        completion.catch(() => {});
        resolve({ stdout: stream, completion, close: () => stream.destroy() });
      });
    });
  }

  consume(command, content, options = {}) {
    const remoteCommand = requiredText(command, 'Remote command', 65536);
    const stderrLimit = outputLimit(options.stderrLimitBytes || DEFAULT_OUTPUT_LIMIT_BYTES);
    const stdoutLimit = outputLimit(options.stdoutLimitBytes || DEFAULT_OUTPUT_LIMIT_BYTES);
    if (!content || typeof content[Symbol.asyncIterator] !== 'function') throw new TypeError('Remote command input must be an async iterable.');
    if (this.signal?.aborted) return Promise.reject(new SshExecutionError('SSH_EXECUTION_CANCELED', 'The remote operation was canceled.', { category: 'canceled' }));
    return new Promise((resolve, reject) => {
      this.client.exec(remoteCommand, (error, stream) => {
        if (error) return reject(new SshExecutionError('SSH_COMMAND_START_FAILED', 'The remote command could not be started.', { retryable: true }));
        const stderr = { chunks: [], bytes: 0, overflow: false };
        const stdout = { chunks: [], bytes: 0, overflow: false };
        stream.stderr?.on('data', (chunk) => appendBounded(stderr, chunk, stderrLimit));
        stream.on('data', (chunk) => appendBounded(stdout, chunk, stdoutLimit));
        const onAbort = () => stream.destroy(Object.assign(new Error('Canceled'), { code: 'ABORT_ERR' }));
        this.signal?.addEventListener?.('abort', onAbort, { once: true });
        let completionSettled = false;
        const completion = new Promise((complete, fail) => {
          const finish = (failure, result) => {
            if (completionSettled) return;
            completionSettled = true;
            if (failure) fail(failure);
            else complete(result);
          };
          stream.once('error', (streamError) => finish(streamError?.code === 'ABORT_ERR'
            ? new SshExecutionError('SSH_EXECUTION_CANCELED', 'The remote operation was canceled.', { category: 'canceled' })
            : new SshExecutionError('SSH_COMMAND_STREAM_FAILED', 'The SSH command stream failed.', { retryable: true })));
          stream.once('close', (code) => {
            if (stderr.overflow || stdout.overflow) return finish(new SshExecutionError('SSH_EXECUTION_OUTPUT_LIMIT', 'The remote command returned more output than allowed.', { category: 'capacity' }));
            if (code !== 0) return finish(new SshExecutionError('SSH_COMMAND_FAILED', 'The remote command failed.', { exitCode: Number.isInteger(code) ? code : null }));
            finish(null, { exitCode: 0 });
          });
        });
        completion.catch(() => {});
        Promise.all([
          pipeline(Readable.from(content), stream, { signal: this.signal || undefined }),
          completion
        ]).then(() => {
          resolve({ stdout: Buffer.concat(stdout.chunks).toString('utf8'), stderr: Buffer.concat(stderr.chunks).toString('utf8'), exitCode: 0 });
        }).catch((executionError) => {
          try { stream.destroy(); } catch {}
          reject(executionError?.name === 'AbortError'
            ? new SshExecutionError('SSH_EXECUTION_CANCELED', 'The remote operation was canceled.', { category: 'canceled' })
            : executionError);
        }).finally(() => {
          this.signal?.removeEventListener?.('abort', onAbort);
        });
      });
    });
  }

  async writeFile(remotePath, content, options = {}) {
    const target = requiredText(remotePath, 'Remote file path', 4096);
    if (!target.startsWith('/')) throw new TypeError('Remote file path must be absolute.');
    const sftp = await sftpSession(this.client).catch(() => { throw new SshExecutionError('SSH_SFTP_UNAVAILABLE', 'SSH connected, but SFTP is unavailable.', { category: 'compatibility' }); });
    try {
      const output = sftp.createWriteStream(target, { flags: 'wx', mode: options.mode || 0o600, autoClose: true });
      const chunks = content && typeof content[Symbol.asyncIterator] === 'function' ? content : [Buffer.from(content)];
      await pipeline(Readable.from(chunks), output, { signal: this.signal || undefined });
    } catch (error) {
      throw error?.name === 'AbortError'
        ? new SshExecutionError('SSH_EXECUTION_CANCELED', 'The remote operation was canceled.', { category: 'canceled' })
        : new SshExecutionError('SSH_UPLOAD_FAILED', 'DeployerX could not upload a protected remote configuration file.', { category: 'capacity', retryable: true });
    } finally {
      try { sftp.end(); } catch {}
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.client.end(); } catch {}
  }
}

function openSshExecutionSession({ connectionConfig, resolveSecret, clientFactory = () => new Client(), signal } = {}) {
  if (typeof resolveSecret !== 'function') throw new TypeError('SSH execution SecretRef resolver is required.');
  const config = new LinuxSshConnectionAdapter().normalizeConfig(connectionConfig);
  const client = clientFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    let authAttempted = false;
    let timer = null;
    const flags = { hostKeyMismatch: false, canceled: false, observedFingerprint: null };
    const finish = (error, session) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) {
        try { client.end(); } catch {}
        reject(error instanceof SshExecutionError ? error : classifyConnectionError(error, flags));
      } else resolve(session);
    };
    const onAbort = () => { flags.canceled = true; finish(classifyConnectionError(null, flags)); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new SshExecutionError('SSH_EXECUTION_TIMEOUT', 'The SSH server did not respond before the timeout.', { category: 'timeout', retryable: true })), config.timeoutMs);
    client.once('error', (error) => finish(error));
    client.once('ready', () => finish(null, new SshExecutionSession(client, { signal })));
    try {
      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: config.timeoutMs,
        keepaliveInterval: 10000,
        keepaliveCountMax: 2,
        hostVerifier: (key) => {
          flags.observedFingerprint = fingerprintHostKey(key);
          flags.hostKeyMismatch = flags.observedFingerprint !== config.hostKeyFingerprint;
          return !flags.hostKeyMismatch;
        },
        authHandler: (_methodsLeft, _partialSuccess, callback) => {
          if (authAttempted || !flags.observedFingerprint || flags.hostKeyMismatch) return callback(false);
          authAttempted = true;
          Promise.resolve(resolveSecret(config.credentialSecretRefId))
            .then(async (credential) => {
              if (config.authType === 'password') return callback({ type: 'password', username: config.username, password: credential });
              const passphrase = config.passphraseSecretRefId ? await resolveSecret(config.passphraseSecretRefId) : undefined;
              callback({ type: 'publickey', username: config.username, key: credential, ...(passphrase ? { passphrase } : {}) });
            })
            .catch(() => callback(false));
        }
      });
    } catch (error) { finish(error); }
  });
}

module.exports = {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  MAX_OUTPUT_LIMIT_BYTES,
  SshExecutionError,
  SshExecutionSession,
  commandFromArgs,
  connectionConfigFromRecord,
  openSshExecutionSession,
  shellQuote
};
