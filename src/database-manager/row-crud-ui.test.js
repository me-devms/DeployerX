const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('browses and mutates table rows through structured capability-gated requests', async (context) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-row-crud-ui-'));
  context.after(async () => fs.rm(outputDirectory, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(require('electron'), [path.join(__dirname, 'row-crud-ui-fixture.js'), outputDirectory], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.desktop.context.profileId, 'profile-postgresql');
  assert.equal(result.desktop.context.schema, 'public');
  assert.equal(result.desktop.context.table, 'orders');
  assert.deepEqual(result.desktop.context.primaryKeyColumns, ['id']);
  assert.equal(result.desktop.editorTitle, 'Edit row');
  assert.equal(result.desktop.binaryDisabled, true);
  assert.equal(result.desktop.primaryKeyDisabled, true);
  assert.equal(result.desktop.insertDisabled, false);
  assert.equal(result.desktop.editDisabled, false);
  assert.equal(result.desktop.startupHidden, true);
  assert.equal(result.desktop.editorVisible, true);
  assert.match(result.desktop.query, /^SELECT \* FROM "public"\."orders"$/);
  assert.equal(result.updateApproval.title, 'Confirm production change');
  assert.equal(result.updateApproval.runLabel, 'Save row');
  assert.match(result.updateApproval.summary, /UPDATE row in public\.orders/);
  assert.equal(result.deleteApproval.title, 'Delete 2 rows?');
  assert.equal(result.deleteApproval.runLabel, 'Delete rows');
  assert.match(result.deleteApproval.summary, /DELETE 2 selected rows/);
  assert.equal(result.finalState.mutations.length, 2);
  const update = result.finalState.mutations[0];
  assert.equal(update.action, 'update');
  assert.deepEqual(update.key, { id: 102 });
  assert.equal(update.values.customer, 'Lin Updated');
  assert.equal(update.approval.confirmed, true);
  assert.equal(Object.hasOwn(update, 'query'), false, 'renderer must not construct mutation SQL');
  const deletion = result.finalState.mutations[1];
  assert.equal(deletion.action, 'delete');
  assert.deepEqual(deletion.keys, [{ id: 101 }, { id: 102 }]);
  assert.equal(deletion.approval.confirmed, true);
  assert.equal(Object.hasOwn(deletion, 'query'), false, 'renderer must send row keys, not SQL');
  assert.ok(result.finalState.queryCount >= 3, 'table result should refresh after mutations');
  assert.equal(result.finalState.readOnly.disabled, true);
  assert.match(result.finalState.readOnly.reason, /read only/i);
  assert.equal(result.finalState.noPrimaryKey.disabled, true);
  assert.match(result.finalState.noPrimaryKey.reason, /primary key/i);
  assert.equal(result.mobile.bodyOverflowX, false);
  assert.ok(result.mobile.card.left >= 0 && result.mobile.card.right <= result.mobile.viewport.width);
  assert.ok(result.mobile.card.top >= 0 && result.mobile.card.bottom <= result.mobile.viewport.height);
  for (const imagePath of [result.desktopPath, result.mobilePath]) {
    const bytes = await fs.readFile(imagePath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(bytes.length > 10000);
  }
});
