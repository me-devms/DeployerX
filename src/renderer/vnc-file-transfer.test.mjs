import test from 'node:test';
import assert from 'node:assert/strict';
import { VncFileTransfer, CHUNK_SIZE, uint32, parseFileList, remoteChild } from './vnc-file-transfer.mjs';

const join = (...parts) => new Uint8Array(Buffer.concat(parts));
const reply = (id, data = new Uint8Array()) => join(uint32(0xfc000100 + id), data);
const block = (data) => join(new Uint8Array([0]), uint32(data.length), uint32(data.length), data);
class Socket {
  data = new Uint8Array();
  index = 0;
  output = [];
  requests = [];
  sQpush32(value) { this.output.push(uint32(value)); }
  sQpushBytes(value) { this.output.push(value); }
  flush() { const data = join(...this.output); this.output = []; this.requests.push(data); this.onRequest?.(data); }
  rQwait(_label, count, back = 0) { if (this.data.length - this.index >= count) return false; this.index -= back; return true; }
  rQpeekBytes(count) { return this.data.slice(this.index, this.index + count); }
  rQskipBytes(count) { this.index += count; }
  rQshiftBytes(count) { const data = this.rQpeekBytes(count); this.index += count; return data; }
}
function setup() {
  const socket = new Socket();
  const transfer = new VncFileTransfer(socket, (message) => { throw new Error(message); });
  for (let id = 0; id <= 25; id++) transfer.capabilities.add(0xfc000100 + id);
  const receive = (data) => { socket.data = data; socket.index = 1; return transfer.receive(); };
  return { socket, transfer, receive };
}
function listing(name = 'résumé.txt', size = 42n) {
  const encoded = new TextEncoder().encode(name + '\0');
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  view.setBigUint64(0, size);
  view.setUint32(18, encoded.length);
  return join(uint32(1), header, encoded);
}

test('decodes TightVNC UTF-8 file names, 16-bit flags, and rejects malformed paths and lengths', () => {
  assert.equal(parseFileList(listing())[0].name, 'résumé.txt');
  assert.equal(parseFileList(listing())[0].size, 42);
  assert.throws(() => parseFileList(listing('../escape')), /filename/);
  assert.throws(() => parseFileList(listing().slice(0, -1)), /entry/);
  assert.throws(() => parseFileList(listing('huge', 2n ** 63n)), /entry/);
  assert.throws(() => remoteChild('/C:', '..'), /filename/);
  assert.equal(remoteChild('/C:/', 'file.txt'), '/C:/file.txt');
});

test('reassembles every possible split of a file list reply without consuming a partial header', async () => {
  const frame = reply(3, block(listing()));
  for (let split = 1; split < frame.length; split++) {
    const { socket, transfer, receive } = setup();
    const pending = transfer.list('/C:');
    assert.equal(receive(frame.slice(0, split)), false);
    assert.equal(socket.index, 0);
    assert.equal(receive(frame), true);
    assert.equal((await pending)[0].name, 'résumé.txt');
  }
});

test('rejects oversized blocks and server errors, then allows a new request', async () => {
  const { transfer, receive } = setup();
  const request = transfer.list('/missing');
  const error = new TextEncoder().encode('Access denied\0');
  receive(reply(25, join(uint32(error.length), error)));
  await assert.rejects(request, /Access denied/);
  const next = transfer.list('/C:');
  assert.throws(() => receive(reply(3, join(new Uint8Array([0]), uint32(20e6), uint32(20e6)))), /Invalid file transfer block/);
  transfer.close();
  await assert.rejects(next, /disconnected/);
});

test('uploads bounded chunks and publishes the final filename only after acknowledgement', async () => {
  const { transfer, socket, receive } = setup();
  const ids = [];
  socket.onRequest = (data) => {
    const id = data[3];
    ids.push(id);
    if (id === 8) assert.ok(data.length <= CHUNK_SIZE + 13);
    queueMicrotask(() => receive(reply(id + 1)));
  };
  const progress = [];
  const file = new File([new Uint8Array(CHUNK_SIZE + 3)], 'example.bin');
  await transfer.upload('/C:/example.bin', file, (done) => progress.push(done));
  assert.deepEqual(ids, [6, 8, 8, 10, 21]);
  assert.deepEqual(progress, [0, CHUNK_SIZE, CHUNK_SIZE + 3]);
  const start = socket.requests[0];
  const length = new DataView(start.buffer).getUint32(4);
  assert.match(new TextDecoder().decode(start.slice(8, 8 + length)), /example.bin.deployerx-.*\.part\0$/);
  assert.equal(start[8 + length], 1, 'create the unique temporary file');
});

test('cancellation finishes the temporary upload without publishing a partial destination', async () => {
  const { transfer, socket, receive } = setup();
  const ids = [];
  socket.onRequest = (data) => { ids.push(data[3]); queueMicrotask(() => receive(reply(data[3] + 1))); };
  await assert.rejects(transfer.upload('/C:/a.bin', new File([new Uint8Array(CHUNK_SIZE + 1)], 'a.bin'), (done) => {
    if (done) transfer.cancel();
  }), /cancelled.*Incomplete upload/);
  assert.deepEqual(ids, [6, 8, 10]);
});

test('downloads in bounded chunks and waits for disk writes before requesting more', async () => {
  const { transfer, socket, receive } = setup();
  let requests = 0;
  let written = 0;
  socket.onRequest = (data) => {
    if (data[3] === 12) return queueMicrotask(() => receive(reply(13)));
    assert.equal(new DataView(data.buffer).getUint32(5), CHUNK_SIZE);
    assert.equal(written, requests * 3);
    requests++;
    queueMicrotask(() => receive(requests === 1 ? reply(15, block(new Uint8Array([1, 2, 3]))) : reply(16, new Uint8Array(9))));
  };
  const bytes = await transfer.download('/C:/a.bin', 3, async (data) => { await Promise.resolve(); written += data.length; }, () => {});
  assert.equal(bytes, 3);
  assert.equal(requests, 2);
});

test('unsupported servers and concurrent operations fail without sending unsafe requests', async () => {
  const { transfer, socket, receive } = setup();
  transfer.capabilities.clear();
  await assert.rejects(transfer.list('/'), /does not support/);
  assert.equal(socket.requests.length, 0);
  for (let id = 0; id <= 25; id++) transfer.capabilities.add(0xfc000100 + id);
  const pending = transfer.list('/');
  await assert.rejects(transfer.list('/'), /current file operation/);
  receive(reply(3, block(uint32(0))));
  await pending;
});
