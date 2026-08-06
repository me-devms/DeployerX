const assert = require('node:assert/strict');
const test = require('node:test');
const { uptimeWindowCloseDisposition } = require('./window-lifecycle');

test('keeps a normal Windows window close in the tray and requests one notice', () => {
  assert.deepEqual(uptimeWindowCloseDisposition({ platform: 'win32', hasTray: true }), {
    preventClose: true,
    hideWindow: true,
    hideDock: false,
    showTrayNotice: true
  });
  assert.equal(uptimeWindowCloseDisposition({ platform: 'win32', hasTray: true, hasShownTrayNotice: true }).showTrayNotice, false);
});

test('allows explicit application quit to destroy the window', () => {
  assert.deepEqual(uptimeWindowCloseDisposition({ isAppQuitting: true, platform: 'win32', hasTray: true }), {
    preventClose: false,
    hideWindow: false,
    hideDock: false,
    showTrayNotice: false
  });
});

test('hides the macOS dock without requesting a Windows tray balloon', () => {
  const disposition = uptimeWindowCloseDisposition({ platform: 'darwin', hasTray: true });
  assert.equal(disposition.preventClose, true);
  assert.equal(disposition.hideDock, true);
  assert.equal(disposition.showTrayNotice, false);
});
