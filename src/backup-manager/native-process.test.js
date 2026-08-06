const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeProcessRunner } = require('./native-process');

test('runs native executables without a shell and returns bounded output', async () => {
  const runner = new NativeProcessRunner();
  const result = await runner.run({ executable: process.execPath, args: ['-e', 'process.stdout.write("native-ok")'], timeoutMs: 5000 });
  assert.equal(result.stdout, 'native-ok');
  assert.equal(result.exitCode, 0);
});

test('streams stdout and consumes binary stdin', async () => {
  const runner = new NativeProcessRunner();
  const streamed = runner.stream({ executable: process.execPath, args: ['-e', 'process.stdout.write("streamed")'], timeoutMs: 5000 });
  const chunks = [];
  for await (const chunk of streamed.stdout) chunks.push(Buffer.from(chunk));
  await streamed.completion;
  assert.equal(Buffer.concat(chunks).toString(), 'streamed');

  const consumed = await runner.consume({ executable: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: [Buffer.from('restore-bytes')], timeoutMs: 5000 });
  assert.equal(consumed.stdout, 'restore-bytes');
});

test('classifies missing executables, failures, and output overflow safely', async () => {
  const runner = new NativeProcessRunner();
  await assert.rejects(runner.run({ executable: 'deployerx-command-that-does-not-exist', args: ['--version'], timeoutMs: 5000 }), (error) => error.code === 'NATIVE_EXECUTABLE_NOT_FOUND');
  await assert.rejects(runner.run({ executable: process.execPath, args: ['-e', 'process.stderr.write("safe failure"); process.exit(7)'], timeoutMs: 5000 }), (error) => error.code === 'NATIVE_PROCESS_FAILED' && error.exitCode === 7);
  await assert.rejects(runner.run({ executable: process.execPath, args: ['-e', 'process.stdout.write("12345")'], stdoutLimitBytes: 4, timeoutMs: 5000 }), (error) => error.code === 'NATIVE_STDOUT_LIMIT_EXCEEDED');
});
