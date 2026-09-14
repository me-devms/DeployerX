const { app, BrowserWindow } = require('electron');
const { WebSocketServer } = require('ws');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
app.disableHardwareAcceleration();
const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
const join = (...parts) => Buffer.concat(parts);
const fileReply = (id, data = Buffer.alloc(0)) => join(u32(0xfc000100 + id), data);
const block = (data) => join(Buffer.from([0]), u32(data.length), u32(data.length), data);
const cap = (id, signature) => join(u32(0xfc000100 + id), Buffer.from('TGHT' + signature));
const capabilities = [
  [2, 'FTCFLRST'], [3, 'FTSFLRLY'], [6, 'FTCFURST'], [7, 'FTSFURLY'], [8, 'FTCUDRST'], [9, 'FTSUDRLY'],
  [10, 'FTCUERST'], [11, 'FTSUERLY'], [12, 'FTCFDRST'], [13, 'FTSFDRLY'], [14, 'FTCDDRST'], [15, 'FTSDDRLY'],
  [16, 'FTSDERLY'], [21, 'FTCFMRST'], [22, 'FTSFMRLY'], [25, 'FTLRFRLY']
];

app.whenReady().then(async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  let window;
  let selectedSecurity;
  const keys = [];
  const uploaded = [];
  const fileMessages = [];
  server.on('connection', (socket) => {
    let stage = 'version';
    let input = Buffer.alloc(0);
    socket.send(Buffer.from('RFB 003.008\n'));
    socket.on('message', (bytes) => {
      input = join(input, bytes);
      while (input.length) {
        let length;
        if (stage === 'version') {
          if (input.length < 12) return;
          length = 12; stage = 'security'; socket.send(Buffer.from([2, 1, 16]));
        } else if (stage === 'security') {
          selectedSecurity = input[0]; length = 1; stage = 'init';
          socket.send(Buffer.alloc(12)); // no tunnels, no subauth, successful security result
        } else if (stage === 'init') {
          length = 1; stage = 'messages';
          const init = Buffer.alloc(24);
          init.writeUInt16BE(800, 0); init.writeUInt16BE(500, 2);
          init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
          init.writeUInt32BE(4, 20);
          const counts = Buffer.alloc(8); counts.writeUInt16BE(capabilities.length, 0);
          socket.send(join(init, Buffer.from('Test'), counts, ...capabilities.map(([id, sig]) => cap(id, sig))));
        } else {
          const type = input[0];
          if (type === 0) length = 20;
          else if (type === 2) { if (input.length < 4) return; length = 4 + input.readUInt16BE(2) * 4; }
          else if (type === 3) length = 10;
          else if (type === 4) length = 8;
          else if (type === 5) length = 6;
          else if (type === 6) { if (input.length < 8) return; length = 8 + input.readUInt32BE(4); }
          else if (type === 252) {
            if (input.length < 9) return;
            const id = input[3];
            if (id === 2) length = 9 + input.readUInt32BE(5);
            else if (id === 6) length = 17 + input.readUInt32BE(4);
            else if (id === 8) { if (input.length < 13) return; length = 13 + input.readUInt32BE(5); }
            else if (id === 10) length = 14;
            else if (id === 21) {
              const second = 8 + input.readUInt32BE(4);
              if (input.length < second + 4) return;
              length = second + 4 + input.readUInt32BE(second);
            } else throw new Error(`Unexpected file message ${id}`);
          } else throw new Error(`Unexpected client message ${type}`);
          if (input.length < length) return;
          if (type === 4) keys.push({ down: input[1], key: input.readUInt32BE(4) });
          if (type === 252 && input[3] !== 2) {
            fileMessages.push(input[3]);
            if (input[3] === 8) uploaded.push(Buffer.from(input.subarray(13, length)));
            socket.send(fileReply(input[3] + 1));
          } else if (type === 252) {
            const name = Buffer.from('example.txt\0');
            const metadata = Buffer.alloc(22); metadata.writeBigUInt64BE(2048n); metadata.writeUInt32BE(name.length, 18);
            const reply = fileReply(3, block(join(u32(1), metadata, name)));
            // Exercise RFB dispatch with a split extension header.
            socket.send(reply.subarray(0, 2));
            setTimeout(() => socket.send(reply.subarray(2)), 5);
          }
        }
        input = input.subarray(length);
      }
    });
  });
  try {
    window = new BrowserWindow({ show: false, width: 1000, height: 720, webPreferences: { backgroundThrottling: false, offscreen: true } });
    await window.loadFile(path.join(__dirname, 'vnc-input-files.fixture.html'));
    const port = server.address().port;
    await window.webContents.executeJavaScript(`(async () => {
      window.deployerx = { setVncKeyboardFocus() {}, onVncKey(callback) { window.nativeKey = callback; return () => {}; }, readVncClipboardFiles: async () => ({ files: [] }) };
      const { createVncClient } = await import('./vnc-client.js');
      await new Promise((resolve, reject) => {
        window.client = createVncClient({ target: document.querySelector('#remote'), onConnected: resolve, onEnded: reject, onEscape: () => { window.escaped = true; return true; } });
        window.client.connect({ proxyUrl: 'ws://127.0.0.1:${port}' });
      });
      document.querySelector('.vnc-file-controls button').click();
    })()`);
    assert.equal(selectedSecurity, 16);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const timer = setInterval(() => {
        if (document.querySelector('.vnc-file-row')) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('File list did not render')); }
      }, 20);
    })`);
    const result = await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.vnc-files-panel');
      const bounds = panel.getBoundingClientRect();
      const canvas = document.querySelector('#remote canvas');
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      const plainEscapeStayedRemote = !window.escaped;
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', code: 'F12', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true }));
      window.client.keyboardFocused = true;
      window.nativeKey({ keysym: 0xffeb, code: 'MetaLeft', down: true });
      window.nativeKey({ keysym: 0xffeb, code: 'MetaLeft', down: false });
      return { supported: window.client.rfb.fileTransfer.supported, plainEscapeStayedRemote, exitShortcutWorks: window.escaped,
        filename: document.querySelector('.vnc-file-row span').textContent,
        fits: bounds.width > 300 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
        progressAccessible: Boolean(panel.querySelector('progress[aria-label]')) };
    })()`);
    assert.deepEqual(result, { supported: true, plainEscapeStayedRemote: true, exitShortcutWorks: true, filename: 'example.txt', fits: true, progressAccessible: true });
    const uploadResult = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-role="path"]').value = '/C:';
      document.querySelector('[data-action="browse"]').click();
      await new Promise((resolve) => {
        const timer = setInterval(() => { if (!document.querySelector('[data-action="browse"]').disabled) { clearInterval(timer); resolve(); } }, 20);
      });
      window.deployerx.readVncClipboardFiles = async () => ({ image: new Uint8Array([137, 80, 78, 71]) });
      await window.client.filePanel.pasteClipboard();
      return { complete: document.querySelector('progress').value === 100, message: document.querySelector('[data-role="status"]').textContent };
    })()`);
    assert.equal(uploadResult.complete, true);
    assert.match(uploadResult.message, /uploaded to \/C:/);
    assert.deepEqual(fileMessages, [6, 8, 10, 21]);
    assert.deepEqual([...Buffer.concat(uploaded)], [137, 80, 78, 71]);
    assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('[data-action=cancel]')).display"), 'none');
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      window.client.isActive = () => false;
      window.client.syncKeyboardFocus();
      const hidden = getComputedStyle(document.querySelector('.vnc-files-panel')).display === 'none' &&
        getComputedStyle(document.querySelector('.vnc-file-controls')).display === 'none';
      window.client.isActive = () => true;
      window.client.syncKeyboardFocus();
      return hidden;
    })()`), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(path.join(os.tmpdir(), 'deployerx-vnc-files-ui.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await window.webContents.executeJavaScript('window.client.disconnect()');
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.vnc-files-panel, .vnc-file-controls').length"), 0);
    assert.ok(keys.some((key) => key.key === 0xff1b && key.down === 1));
    assert.ok(keys.some((key) => key.key === 0xffeb && key.down === 1));
    console.log('VNC Electron handshake, file list, clipboard image upload, keyboard, progress, panel layout and cleanup checks passed.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    window?.destroy();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
