const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const CHUNK_SIZE = 64 * 1024;

class VncLocalFiles {
  constructor() { this.files = new Map(); }
  async openUpload(filePath, sessionId) {
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Select files, not folders.');
      const id = crypto.randomUUID();
      this.files.set(id, { handle, sessionId, mode: 'read' });
      return { id, name: path.basename(filePath), size: stat.size, lastModified: stat.mtimeMs };
    } catch (error) { await handle.close(); throw error; }
  }
  async openDownload(destination, sessionId) {
    const id = crypto.randomUUID();
    const temporary = `${destination}.deployerx-${id}.part`;
    const handle = await fs.open(temporary, 'wx');
    this.files.set(id, { handle, sessionId, mode: 'write', destination, temporary });
    return { id };
  }
  get(id, sessionId, mode) {
    const file = this.files.get(id);
    if (!file || file.sessionId !== sessionId || (mode && file.mode !== mode)) throw new Error('File transfer is no longer active.');
    return file;
  }
  async read(id, sessionId, offset, length) {
    const file = this.get(id, sessionId, 'read');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > CHUNK_SIZE) throw new Error('Invalid file chunk.');
    const data = Buffer.alloc(length);
    const { bytesRead } = await file.handle.read(data, 0, length, offset);
    return data.subarray(0, bytesRead);
  }
  async write(id, sessionId, bytes) {
    const file = this.get(id, sessionId, 'write');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > CHUNK_SIZE) throw new Error('Invalid file chunk.');
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.handle.write(bytes, offset, bytes.length - offset);
      if (!bytesWritten) throw new Error('Could not write the download.');
      offset += bytesWritten;
    }
  }
  async finish(id, sessionId, commit = false) {
    const file = this.get(id, sessionId);
    this.files.delete(id);
    try {
      if (file.mode === 'write' && commit) await file.handle.sync();
    } finally { await file.handle.close(); }
    if (file.mode !== 'write') return;
    if (commit) {
      try { await fs.rename(file.temporary, file.destination); }
      catch (error) { throw new Error(`Could not save the download. Completed file retained at ${file.temporary}: ${error.message}`); }
    } else await fs.unlink(file.temporary).catch(() => {});
  }
  async closeSession(sessionId) {
    await Promise.allSettled([...this.files].filter(([, file]) => !sessionId || file.sessionId === sessionId)
      .map(([id, file]) => this.finish(id, file.sessionId)));
  }
}

function registerVncFileIpc({ ipcMain, dialog, clipboard, getWindow, getSession }) {
  const files = new VncLocalFiles();
  const session = (event) => {
    const current = getSession();
    if (event.sender !== getWindow()?.webContents || !current) throw new Error('Connect VNC first.');
    return current.id;
  };
  ipcMain.handle('vnc:download-open', async (event, name) => {
    const id = session(event);
    const selection = await dialog.showSaveDialog(getWindow(), { defaultPath: path.basename(String(name || 'download')) });
    if (selection.canceled) return null;
    if (session(event) !== id) throw new Error('VNC session changed.');
    const file = await files.openDownload(selection.filePath, id);
    if (getSession()?.id !== id) {
      await files.finish(file.id, id);
      throw new Error('VNC session changed.');
    }
    return file;
  });
  ipcMain.handle('vnc:file-read', (event, id, offset, length) => files.read(id, session(event), offset, length));
  ipcMain.handle('vnc:file-write', (event, id, bytes) => files.write(id, session(event), bytes));
  ipcMain.handle('vnc:file-finish', (event, id, commit) => files.finish(id, session(event), Boolean(commit)));
  ipcMain.handle('vnc:clipboard-files', async (event) => {
    const id = session(event);
    const image = clipboard.readImage();
    const mayContainFiles = clipboard.availableFormats().some((format) => /FileName|FileDrop|CF_HDROP/i.test(format)) ||
      (image.isEmpty() && !clipboard.readText());
    if (process.platform === 'win32' && mayContainFiles) {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList())'],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      const paths = JSON.parse(stdout.trim() || '[]');
      if (session(event) !== id) throw new Error('VNC session changed.');
      if (paths.length > 100) throw new Error('Paste up to 100 files at a time.');
      const opened = [];
      try {
        for (const filePath of paths) opened.push(await files.openUpload(filePath, id));
        if (getSession()?.id !== id) throw new Error('VNC session changed.');
        if (opened.length) return { files: opened };
      } catch (error) {
        await Promise.allSettled(opened.map((file) => files.finish(file.id, id)));
        throw error;
      }
    }
    if (!image.isEmpty()) {
      const png = image.toPNG();
      if (png.length > 32 * 1024 * 1024) throw new Error('Clipboard image exceeds 32 MB. Save it and use Upload files.');
      return { image: png };
    }
    return { files: [] };
  });
  return files;
}

module.exports = { VncLocalFiles, registerVncFileIpc };
