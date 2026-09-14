const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VncLocalFiles } = require('./vnc-local-files');

test('streams files, isolates sessions, preserves destinations on cancellation and closes handles', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vnc-files-test-'));
  const destination = path.join(directory, 'download.bin');
  const files = new VncLocalFiles();
  try {
    await fs.writeFile(destination, 'original');
    const cancelled = await files.openDownload(destination, 'session');
    await files.write(cancelled.id, 'session', new Uint8Array([1, 2]));
    await assert.rejects(files.write(cancelled.id, 'other', new Uint8Array([3])), /no longer active/);
    await files.finish(cancelled.id, 'session');
    assert.equal(await fs.readFile(destination, 'utf8'), 'original');
    const completed = await files.openDownload(destination, 'session');
    await files.write(completed.id, 'session', new Uint8Array([3, 4, 5]));
    await files.finish(completed.id, 'session', true);
    assert.deepEqual([...await fs.readFile(destination)], [3, 4, 5]);
    const upload = await files.openUpload(destination, 'session');
    assert.deepEqual([...await files.read(upload.id, 'session', 1, 2)], [4, 5]);
    await assert.rejects(files.read(upload.id, 'session', 0, 65537), /Invalid/);
    await files.closeSession('session');
    assert.equal(files.files.size, 0);
    assert.deepEqual(await fs.readdir(directory), ['download.bin']);
  } finally {
    await files.closeSession();
    // The test owns this exact temporary directory and its two named files.
    for (const entry of await fs.readdir(directory)) await fs.unlink(path.join(directory, entry));
    await fs.rmdir(directory);
  }
});
