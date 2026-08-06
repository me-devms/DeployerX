const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectPluginRuntimeRequirement,
  pluginRuntimeRequirement,
  pythonVersion,
  pythonVersionSupported
} = require('./plugin-runtime-requirement');

const requirement = Object.freeze({ id: 'python', label: 'Python', minimumVersion: '3.8' });

test('accepts a bounded supported Python launcher without exposing process details', async () => {
  let invocation = null;
  const result = await inspectPluginRuntimeRequirement(requirement, {
    platform: 'win32',
    timeoutMs: 1234,
    execFileImpl: (executable, args, options, callback) => {
      invocation = { executable, args, options };
      callback(null, 'Python 3.12.13\r\n', '');
    }
  });
  assert.equal(invocation.executable, 'python.exe');
  assert.deepEqual(invocation.args, ['--version']);
  assert.equal(invocation.options.timeout, 1234);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(result.status, 'available');
  assert.equal(result.version, '3.12.13');
  assert.equal(result.reason, null);
});

test('fails closed for a missing, old, or unverifiable Python launcher', async () => {
  const missing = await inspectPluginRuntimeRequirement(requirement, {
    execFileImpl: (_executable, _args, _options, callback) => callback(Object.assign(new Error('sensitive host path'), { code: 'ENOENT' }))
  });
  const old = await inspectPluginRuntimeRequirement(requirement, {
    execFileImpl: (_executable, _args, _options, callback) => callback(null, '', 'Python 3.7.9')
  });
  const invalid = await inspectPluginRuntimeRequirement(requirement, {
    execFileImpl: (_executable, _args, _options, callback) => callback(null, 'unexpected output', '')
  });
  for (const result of [missing, old, invalid]) {
    assert.deepEqual(result, {
      id: 'python',
      label: 'Python',
      minimumVersion: '3.8',
      status: 'unavailable',
      reason: 'Python 3.8 or newer is not available on this device.'
    });
    assert.doesNotMatch(JSON.stringify(result), /sensitive host path/);
  }
});

test('parses Python versions and enforces the host minimum', () => {
  assert.deepEqual(pluginRuntimeRequirement('bin/plugin.PY'), requirement);
  assert.equal(pluginRuntimeRequirement('bin/plugin.exe'), null);
  assert.deepEqual(pluginRuntimeRequirement('tabularis-db2-plugin.exe', 'db2'), { id: 'db2-odbc', label: '64-bit IBM Db2 ODBC driver' });
  assert.deepEqual(pythonVersion('Python 3.8.0'), { display: '3.8.0', major: 3, minor: 8 });
  assert.equal(pythonVersion('launcher unavailable'), null);
  assert.equal(pythonVersionSupported(pythonVersion('Python 3.8.0')), true);
  assert.equal(pythonVersionSupported(pythonVersion('Python 4.0.0')), true);
  assert.equal(pythonVersionSupported(pythonVersion('Python 3.7.9')), false);
  assert.equal(pythonVersionSupported(pythonVersion('Python 2.7.18')), false);
});

test('detects a registered 64-bit Db2 ODBC driver with bounded registry queries', async () => {
  const invocations = [];
  const result = await inspectPluginRuntimeRequirement(pluginRuntimeRequirement('driver.exe', 'db2'), {
    platform: 'win32',
    timeoutMs: 1500,
    execFileImpl: (executable, args, options, callback) => {
      invocations.push({ executable, args, options });
      if (args[1].startsWith('HKLM')) callback(null, 'IBM DB2 ODBC DRIVER    REG_SZ    Installed', '');
      else callback(Object.assign(new Error('not found'), { code: 1 }));
    }
  });
  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((item) => item.executable === 'reg.exe' && item.args[0] === 'query' && item.options.timeout === 1500 && item.options.maxBuffer === 8192));
});

test('fails closed when no registered 64-bit Db2 ODBC driver is visible', async () => {
  const result = await inspectPluginRuntimeRequirement(pluginRuntimeRequirement('driver.exe', 'db2'), {
    platform: 'win32',
    execFileImpl: (_executable, _args, _options, callback) => callback(Object.assign(new Error('private registry detail'), { code: 1 }))
  });
  assert.deepEqual(result, {
    id: 'db2-odbc',
    label: '64-bit IBM Db2 ODBC driver',
    status: 'unavailable',
    reason: 'A 64-bit IBM Db2 ODBC driver is not available on this device.'
  });
  assert.doesNotMatch(JSON.stringify(result), /private registry detail/);
});
