const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const vncClient = fs.readFileSync(path.join(__dirname, 'vnc-client.js'), 'utf8');
const rdpClient = fs.readFileSync(path.join(__dirname, 'rdp-client.js'), 'utf8');

test('VNC synchronizes the native clipboard before noVNC handles Ctrl+V', () => {
  const handler = vncClient.slice(
    vncClient.indexOf('handleKeyDown(event) {'),
    vncClient.indexOf('syncLocalClipboard() {')
  );

  assert.match(handler, /ctrlKey \|\| event\.metaKey/);
  assert.match(handler, /event\.code === 'KeyV'/);
  assert.match(handler, /this\.syncLocalClipboard\(\)/);
  assert.match(vncClient, /rfb\.clipboardPasteFrom\(text\)/);
});

test('RDP transfers clipboard data before sending the remote paste shortcut', () => {
  const handler = rdpClient.slice(
    rdpClient.indexOf("listen('keydown'"),
    rdpClient.indexOf("listen('keyup'")
  );
  const shortcut = rdpClient.slice(
    rdpClient.indexOf('sendPasteShortcut() {'),
    rdpClient.indexOf('async syncLocalClipboard() {')
  );

  assert.match(handler, /this\.syncLocalClipboard\(\)\.then\(\(\) => this\.sendPasteShortcut\(\)\)/);
  assert.match(shortcut, /keyPressed\(SCANCODES\.ControlLeft\)[\s\S]*keyPressed\(SCANCODES\.KeyV\)[\s\S]*keyReleased\(SCANCODES\.KeyV\)[\s\S]*keyReleased\(SCANCODES\.ControlLeft\)/);
  assert.match(rdpClient, /remoteClipboardChangedCallback[\s\S]*this\.writeClipboard\(text\)/);
});

test('remote context-menu paste refreshes the clipboard for both protocols', () => {
  assert.match(vncClient, /handleMouseDown\(event\) \{\s*if \(event\.button === 2\) this\.syncLocalClipboard\(\)/);
  assert.match(rdpClient, /listen\('mousedown',[\s\S]*if \(event\.button === 2\) this\.syncLocalClipboard\(\)/);
});
