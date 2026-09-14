const { spawn } = require('child_process');
const path = require('path');
const { readFileSync } = require('fs');
const { createInterface } = require('readline');

const KEYS = {
  91: [0xffeb, 'MetaLeft'], 92: [0xffec, 'MetaRight'],
  44: [0xff61, 'PrintScreen'], 9: [0xff09, 'Tab'],
  115: [0xffc1, 'F4'], 27: [0xff1b, 'Escape'], 32: [0x20, 'Space']
};

function createVncKeyboard(window, { onKey, onError, spawnProcess = spawn } = {}) {
  let child = null;
  let enabled = false;
  let ready = false;
  let failed = false;
  let startupTimer;
  const pressed = new Map();
  const release = () => {
    for (const value of pressed.values()) onKey({ keysym: value[0], code: value[1], down: false });
    pressed.clear();
  };
  const write = () => {
    if (child?.stdin.writable) child.stdin.write(enabled && window.isFocused() ? 'on\n' : 'off\n');
  };
  return {
    setEnabled(value) {
      enabled = Boolean(value);
      window.webContents.setIgnoreMenuShortcuts(enabled);
      if (!enabled) release();
      if (enabled && !child && !failed && process.platform === 'win32') {
        const handle = window.getNativeWindowHandle();
        const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
        // Read via Electron's filesystem so packaged app.asar paths work too.
        const script = `& {\n${readFileSync(path.join(__dirname, 'vnc-keyboard.ps1'), 'utf8')}\n} -WindowHandle ${hwnd}`;
        child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const report = () => {
          if (failed) return;
          failed = true;
          clearTimeout(startupTimer);
          child?.kill();
          release();
          onError?.('Windows shortcut capture is unavailable. Restart DeployerX to retry.');
        };
        child.on('error', report);
        child.stdin.on('error', report);
        child.stderr.resume();
        startupTimer = setTimeout(report, 10000);
        createInterface({ input: child.stdout }).on('line', (line) => {
          if (failed) return;
          if (line === 'ready') { ready = true; clearTimeout(startupTimer); write(); return; }
          const match = /^(\d+):([01])$/.exec(line);
          if (!match || !ready) return;
          const key = Number(match[1]);
          const value = KEYS[key];
          const down = match[2] === '1';
          if (!value || (down && (!enabled || !window.isFocused()))) return;
          if (down) pressed.set(key, value);
          else if (!pressed.delete(key)) return;
          onKey({ keysym: value[0], code: value[1], down });
        });
        child.on('exit', report);
      }
      write();
    },
    close() {
      enabled = false;
      failed = true;
      clearTimeout(startupTimer);
      release();
      child?.kill();
      child = null;
    }
  };
}

module.exports = { createVncKeyboard, KEYS };
