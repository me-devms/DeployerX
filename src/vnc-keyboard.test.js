const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { createVncKeyboard } = require('./vnc-keyboard');

test('forwards special keys only while focused and releases held keys when capture stops', { skip: process.platform !== 'win32' }, () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  let focused = true;
  const keys = [];
  const menus = [];
  const window = { isFocused: () => focused, getNativeWindowHandle: () => Buffer.alloc(8), webContents: { setIgnoreMenuShortcuts: (value) => menus.push(value) } };
  const keyboard = createVncKeyboard(window, { onKey: (key) => keys.push(key), spawnProcess: (_exe, args, options) => {
    assert.equal(args[2], '-EncodedCommand');
    assert.equal(options.windowsHide, true);
    assert.match(Buffer.from(args[3], 'base64').toString('utf16le'), /-WindowHandle 0$/);
    return child;
  } });
  keyboard.setEnabled(true);
  child.stdout.write('ready\n91:1\n');
  keyboard.setEnabled(false);
  child.stdout.write('91:0\n44:1\n');
  assert.deepEqual(keys, [
    { keysym: 0xffeb, code: 'MetaLeft', down: true },
    { keysym: 0xffeb, code: 'MetaLeft', down: false }
  ]);
  focused = false;
  keyboard.setEnabled(true);
  child.stdout.write('91:1\n');
  assert.equal(keys.length, 2);
  keyboard.close();
  assert.equal(killed, true);
  assert.deepEqual(menus, [true, false, true]);
});

test('packaged-script invocation starts and shuts down its Windows hook without capturing user input', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  let child;
  let ready;
  const started = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  const keyboard = createVncKeyboard({ isFocused: () => true, getNativeWindowHandle: () => Buffer.alloc(8), webContents: { setIgnoreMenuShortcuts() {} } }, {
    onKey: () => assert.fail('A zero window handle must never capture input'),
    onError: (message) => ready.reject(new Error(message)),
    spawnProcess: (exe, args, options) => {
      child = spawn(exe, args, options);
      child.stdout.on('data', (data) => { if (data.toString().includes('ready')) ready.resolve(); });
      return child;
    }
  });
  try {
    keyboard.setEnabled(true);
    await started;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    keyboard.close();
    await exited;
  } finally { keyboard.close(); }
});
