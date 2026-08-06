const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_ERROR_LIMIT = 64 * 1024;
const MAX_ARGUMENTS = 10000;
const MAX_ARGUMENT_LENGTH = 8192;

class NativeProcessError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'NativeProcessError';
    this.code = code;
    this.category = options.category || 'execution';
    this.retryable = Boolean(options.retryable);
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
    this.stderr = String(options.stderr || '').slice(0, DEFAULT_ERROR_LIMIT);
  }
}

function requiredText(value, label, maximumLength = MAX_ARGUMENT_LENGTH) {
  const text = String(value ?? '');
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function safeInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function normalizeCommand(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Native process request must be an object.');
  const executable = requiredText(input.executable, 'Native executable', 4096);
  if (!Array.isArray(input.args) || input.args.length > MAX_ARGUMENTS) throw new TypeError('Native process arguments are invalid.');
  const args = input.args.map((argument) => requiredText(argument, 'Native process argument'));
  const timeoutMs = safeInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 24 * 60 * 60 * 1000, 'Native process timeout');
  const stdoutLimitBytes = safeInteger(input.stdoutLimitBytes, DEFAULT_OUTPUT_LIMIT, 1, 64 * 1024 * 1024, 'Native stdout limit');
  const stderrLimitBytes = safeInteger(input.stderrLimitBytes, DEFAULT_ERROR_LIMIT, 1, 1024 * 1024, 'Native stderr limit');
  const cwd = input.cwd === undefined || input.cwd === null ? undefined : requiredText(input.cwd, 'Native process working directory', 4096);
  const inherited = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
  const environment = {};
  for (const key of inherited) if (process.env[key] !== undefined) environment[key] = process.env[key];
  if (input.env !== undefined) {
    if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env)) throw new TypeError('Native process environment is invalid.');
    for (const [key, value] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new TypeError('Native process environment key is invalid.');
      environment[key] = requiredText(value, 'Native process environment value', 8192);
    }
  }
  return { executable, args, timeoutMs, stdoutLimitBytes, stderrLimitBytes, cwd, environment, signal: input.signal || null };
}

function appendBounded(state, chunk, limit, code, message) {
  const bytes = Buffer.from(chunk);
  if (state.length + bytes.length > limit) throw new NativeProcessError(code, message, { category: 'capacity' });
  state.parts.push(bytes);
  state.length += bytes.length;
}

function classifySpawnError(error) {
  if (error?.code === 'ENOENT') return new NativeProcessError('NATIVE_EXECUTABLE_NOT_FOUND', 'A required native executable is not installed or is not on PATH.', { category: 'compatibility' });
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return new NativeProcessError('NATIVE_EXECUTABLE_DENIED', 'The required native executable cannot be started.', { category: 'authorization' });
  return new NativeProcessError('NATIVE_PROCESS_START_FAILED', 'The native database process could not be started.', { retryable: true });
}

function startProcess(spawnImpl, input, options = {}) {
  const command = normalizeCommand(input);
  let child;
  try {
    child = spawnImpl(command.executable, command.args, {
      cwd: command.cwd,
      env: command.environment,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    throw classifySpawnError(error);
  }
  const stderr = { parts: [], length: 0 };
  let settled = false;
  let timedOut = false;
  let canceled = false;
  let timer = null;
  const terminate = () => {
    try { child.kill('SIGTERM'); } catch {}
    const escalation = setTimeout(() => {
      if (!settled) try { child.kill('SIGKILL'); } catch {}
    }, 5000);
    escalation.unref?.();
  };
  const onAbort = () => { canceled = true; terminate(); };
  if (command.signal?.aborted) onAbort();
  else command.signal?.addEventListener?.('abort', onAbort, { once: true });
  timer = setTimeout(() => { timedOut = true; terminate(); }, command.timeoutMs);
  timer.unref?.();
  child.stderr.on('data', (chunk) => {
    if (stderr.length >= command.stderrLimitBytes) return;
    const bytes = Buffer.from(chunk).subarray(0, command.stderrLimitBytes - stderr.length);
    stderr.parts.push(bytes);
    stderr.length += bytes.length;
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(classifySpawnError(error)));
    child.once('close', (exitCode, processSignal) => {
      const safeStderr = Buffer.concat(stderr.parts, stderr.length).toString('utf8');
      if (canceled) return reject(new NativeProcessError('NATIVE_PROCESS_CANCELED', 'The native database process was canceled.', { category: 'canceled', stderr: safeStderr }));
      if (timedOut) return reject(new NativeProcessError('NATIVE_PROCESS_TIMEOUT', 'The native database process exceeded its timeout.', { category: 'timeout', retryable: true, stderr: safeStderr }));
      if (exitCode !== 0) return reject(new NativeProcessError('NATIVE_PROCESS_FAILED', 'The native database process reported a failure.', { exitCode, stderr: safeStderr }));
      resolve({ exitCode: 0, signal: processSignal || null, stderr: safeStderr });
    });
  }).finally(() => {
    settled = true;
    if (timer) clearTimeout(timer);
    command.signal?.removeEventListener?.('abort', onAbort);
  });
  completion.catch(() => {});
  return { child, command, completion, cancel: terminate };
}

async function writeInput(stream, input) {
  try {
    if (input === null || input === undefined) {
      stream.end();
      return;
    }
    const iterable = Buffer.isBuffer(input) || input instanceof Uint8Array ? [Buffer.from(input)] : input;
    if (!iterable || (typeof iterable[Symbol.iterator] !== 'function' && typeof iterable[Symbol.asyncIterator] !== 'function')) throw new TypeError('Native process input must be binary data or an iterable binary stream.');
    for await (const part of iterable) {
      if (!Buffer.isBuffer(part) && !(part instanceof Uint8Array)) throw new TypeError('Native process input streams must emit binary data.');
      if (!stream.write(Buffer.from(part))) await new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject); });
    }
    stream.end();
  } catch (error) {
    stream.destroy(error);
    throw error;
  }
}

class NativeProcessRunner {
  constructor({ spawnImpl = spawn } = {}) {
    if (typeof spawnImpl !== 'function') throw new TypeError('Native process spawn implementation is required.');
    this.spawnImpl = spawnImpl;
  }

  async run(input = {}) {
    const started = startProcess(this.spawnImpl, input);
    started.child.stdin.end();
    const stdout = { parts: [], length: 0 };
    try {
      for await (const chunk of started.child.stdout) appendBounded(stdout, chunk, started.command.stdoutLimitBytes, 'NATIVE_STDOUT_LIMIT_EXCEEDED', 'The native database process returned too much output.');
      const completed = await started.completion;
      return { ...completed, stdout: Buffer.concat(stdout.parts, stdout.length).toString('utf8') };
    } catch (error) {
      started.cancel();
      await started.completion.catch(() => {});
      throw error;
    }
  }

  stream(input = {}) {
    const started = startProcess(this.spawnImpl, input);
    started.child.stdin.end();
    return { stdout: started.child.stdout, completion: started.completion, cancel: started.cancel };
  }

  async consume(input = {}) {
    const started = startProcess(this.spawnImpl, input);
    const output = { parts: [], length: 0 };
    const readOutput = (async () => {
      for await (const chunk of started.child.stdout) appendBounded(output, chunk, started.command.stdoutLimitBytes, 'NATIVE_STDOUT_LIMIT_EXCEEDED', 'The native database process returned too much output.');
    })();
    try {
      await Promise.all([writeInput(started.child.stdin, input.stdin), readOutput, started.completion]);
      return { exitCode: 0, stdout: Buffer.concat(output.parts, output.length).toString('utf8') };
    } catch (error) {
      started.cancel();
      await started.completion.catch(() => {});
      throw error;
    }
  }
}

module.exports = {
  DEFAULT_ERROR_LIMIT,
  DEFAULT_OUTPUT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  NativeProcessError,
  NativeProcessRunner,
  normalizeCommand
};
