// TightVNC 2.x wire format. Transfers use uncompressed, acknowledged chunks.
const BASE = 0xfc000100;
export const CHUNK_SIZE = 64 * 1024;
const MAX_REPLY = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function uint32(value) {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value);
  return data;
}
function uint64(value) {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, BigInt(value));
  return data;
}
function utf8(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid remote path.');
  const data = encoder.encode(value + '\0');
  if (data.length > 32768) throw new Error('Remote path is too long.');
  return [uint32(data.length), data];
}
export function remoteChild(parent, name) {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Invalid remote filename.');
  return `${parent.replace(/\/$/, '')}/${name}`;
}

export function parseFileList(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  if (bytes.length < 4) throw new Error('Invalid remote file list.');
  const count = view.getUint32(0);
  if (count > 100000 || count > (bytes.length - 4) / 22) throw new Error('Invalid remote file count.');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 22 > bytes.length) throw new Error('Incomplete remote file list.');
    const size = Number(view.getBigUint64(offset));
    const modified = Number(view.getBigUint64(offset + 8));
    const directory = Boolean(view.getUint16(offset + 16) & 1);
    const length = view.getUint32(offset + 18);
    offset += 22;
    if (length > 32768 || offset + length > bytes.length || !Number.isSafeInteger(size)) throw new Error('Invalid remote file entry.');
    const name = decoder.decode(bytes.subarray(offset, offset + length)).replace(/\0$/, '');
    remoteChild('/', name);
    entries.push({ name, size, modified, directory });
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('Invalid remote file list length.');
  return entries;
}

export class VncFileTransfer {
  constructor(socket, fail) {
    this.socket = socket;
    this.fail = fail;
    this.capabilities = new Set();
    this.pending = null;
    this.busy = false;
    this.cancelled = false;
    this.closed = false;
  }
  get supported() {
    return [2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21, 22, 25]
      .every((id) => this.capabilities.has(BASE + id));
  }
  request(id, parts = [], replies = [id + 1]) {
    if (!this.supported || this.closed) return Promise.reject(new Error('This server does not support TightVNC 2.x file transfer.'));
    if (this.pending) return Promise.reject(new Error('A file request is already running.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close('File transfer timed out. Reconnect VNC before retrying.');
        // Replies have no request IDs, so a timed-out stream cannot be reused safely.
        this.fail('File transfer timed out. Reconnect VNC before retrying.');
      }, 30000);
      this.pending = { resolve, reject, timer, replies };
      try {
        this.socket.sQpush32(BASE + id);
        for (const part of parts) this.socket.sQpushBytes(part);
        this.socket.flush();
      } catch (error) { this.close(error.message); }
    });
  }
  // Called after RFB consumes the first message byte (0xfc). Rewind on fragments.
  receive() {
    const sock = this.socket;
    if (sock.rQwait('file header', 3, 1)) return false;
    const header = sock.rQpeekBytes(3);
    if (header[0] !== 0 || header[1] !== 1) throw new Error('Unknown file transfer extension.');
    const id = header[2];
    let body = 0;
    if ([3, 15].includes(id)) {
      if (sock.rQwait('file block header', 12, 1)) return false;
      const bytes = sock.rQpeekBytes(12);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = view.getUint32(4);
      if (bytes[3] !== 0 || size !== view.getUint32(8) || size > MAX_REPLY) throw new Error('Invalid file transfer block.');
      if (id === 15 && size > CHUNK_SIZE) throw new Error('Oversized download chunk.');
      body = 9 + size;
    } else if (id === 25) {
      if (sock.rQwait('file error header', 7, 1)) return false;
      const bytes = sock.rQpeekBytes(7);
      const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3);
      if (length > 32768) throw new Error('Oversized file transfer error.');
      body = 4 + length;
    } else if (id === 16) body = 9;
    else if (![7, 9, 11, 13, 22].includes(id)) throw new Error('Unexpected file transfer reply.');
    if (sock.rQwait('file reply', 3 + body, 1)) return false;
    sock.rQskipBytes(3);
    const data = sock.rQshiftBytes(body);
    const pending = this.pending;
    if (!pending) throw new Error('Unsolicited file transfer reply.');
    this.pending = null;
    clearTimeout(pending.timer);
    if (id === 25) pending.reject(new Error(decoder.decode(data.subarray(4)).replace(/\0$/, '') || 'Remote file operation failed.'));
    else if (!pending.replies.includes(id)) {
      pending.reject(new Error('Unexpected file transfer reply.'));
      throw new Error('Unexpected file transfer reply.');
    } else pending.resolve({ id, data: [3, 15].includes(id) ? data.subarray(9) : data });
    return true;
  }
  async run(operation) {
    if (this.busy) throw new Error('Wait for the current file operation to finish.');
    this.busy = true;
    this.cancelled = false;
    try { return await operation(); } finally { this.busy = false; }
  }
  checkCancelled() { if (this.cancelled) throw new Error('Transfer cancelled.'); }
  // TightVNC has no download-cancel message; its read handle closes on the next download or disconnect.
  cancel() { this.cancelled = true; }
  list(path) {
    return this.run(async () => parseFileList((await this.request(2, [new Uint8Array([0]), ...utf8(path)])).data));
  }
  upload(path, file, progress) {
    return this.run(async () => {
      const temporary = `${path}.deployerx-${crypto.randomUUID()}.part`;
      await this.request(6, [...utf8(temporary), new Uint8Array([1]), uint64(0)]);
      let ended = false;
      try {
        progress(0, file.size);
        for (let offset = 0; offset < file.size;) {
          this.checkCancelled();
          const data = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
          if (!data.length || data.length > CHUNK_SIZE) throw new Error('Local file changed during upload.');
          this.checkCancelled();
          await this.request(8, [new Uint8Array([0]), uint32(data.length), uint32(data.length), data]);
          offset += data.length;
          progress(offset, file.size);
        }
        this.checkCancelled();
        await this.request(10, [new Uint8Array(2), uint64(file.lastModified || Date.now())]);
        ended = true;
        this.checkCancelled();
        await this.request(21, [...utf8(temporary), ...utf8(path)]);
      } catch (error) {
        if (!ended && !this.closed) await this.request(10, [new Uint8Array(2), uint64(Date.now())]).catch(() => {});
        throw new Error(`${error.message} Incomplete upload retained as ${temporary}`);
      }
    });
  }
  download(path, size, write, progress) {
    return this.run(async () => {
      await this.request(12, [...utf8(path), uint64(0)]);
      let received = 0;
      progress(0, size);
      while (true) {
        this.checkCancelled();
        const reply = await this.request(14, [new Uint8Array([0]), uint32(CHUNK_SIZE)], [15, 16]);
        this.checkCancelled();
        if (reply.id === 16) return received;
        if (!reply.data.length) throw new Error('Server returned an empty download chunk.');
        await write(reply.data);
        received += reply.data.length;
        progress(received, size);
      }
    });
  }
  close(message = 'VNC disconnected.') {
    this.closed = true;
    this.cancelled = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(message));
      this.pending = null;
    }
  }
}
