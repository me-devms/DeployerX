const assert = require('node:assert/strict');
const test = require('node:test');
const { uptimeWindowCloseDisposition } = require('./window-lifecycle');

test('keeps a normal Windows window close in the background without requesting a notification', () => {
  assert.deepEqual(uptimeWindowCloseDisposition({ platform: 'win32' }), {
    preventClose: true,
    hideWindow: true,
    hideDock: false
  });
});

test('allows explicit application quit to destroy the window', () => {
  assert.deepEqual(uptimeWindowCloseDisposition({ isAppQuitting: true, platform: 'win32' }), {
    preventClose: false,
    hideWindow: false,
    hideDock: false
  });
});

test('hides the macOS dock when the window closes', () => {
  const disposition = uptimeWindowCloseDisposition({ platform: 'darwin' });
  assert.equal(disposition.preventClose, true);
  assert.equal(disposition.hideDock, true);
});
