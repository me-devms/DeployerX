const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('renders the Database Manager catalog and profile modal without overflow or collisions', async (context) => {
  const electronPath = require('electron');
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-manager-ui-'));
  context.after(async () => { await fs.rm(outputDirectory, { recursive: true, force: true }); });
  const fixturePath = path.join(__dirname, 'electron-ui-fixture.js');
  const { stdout } = await execFileAsync(electronPath, [fixturePath, outputDirectory], { windowsHide: true, timeout: 30000 });
  const results = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(results.map((result) => [result.name, result.viewport]), [
    ['desktop', { width: 1280, height: 800 }],
    ['desktop-query', { width: 1280, height: 800 }],
    ['desktop-schema-action', { width: 1280, height: 800 }],
    ['desktop-principal-action', { width: 1280, height: 800 }],
    ['desktop-query-selection', { width: 1280, height: 800 }],
    ['desktop-query-tabs', { width: 1280, height: 800 }],
    ['desktop-query-batch', { width: 1280, height: 800 }],
    ['desktop-query-grid', { width: 1280, height: 800 }],
    ['desktop-saved-queries', { width: 1280, height: 800 }],
    ['mobile', { width: 390, height: 844 }],
    ['mobile-query', { width: 390, height: 844 }],
    ['mobile-schema-action', { width: 390, height: 844 }],
    ['mobile-principal-action', { width: 390, height: 844 }],
    ['mobile-query-selection', { width: 390, height: 844 }],
    ['mobile-query-tabs', { width: 390, height: 844 }],
    ['mobile-query-batch', { width: 390, height: 844 }],
    ['mobile-query-history', { width: 390, height: 844 }],
    ['mobile-saved-query-modal', { width: 390, height: 844 }],
    ['mobile-query-approval', { width: 390, height: 844 }],
    ['mobile-query-batch-approval', { width: 390, height: 844 }],
    ['mobile-query-inspector', { width: 390, height: 844 }],
    ['desktop-query-monaco', { width: 1280, height: 800 }],
    ['mobile-query-monaco', { width: 390, height: 844 }]
  ]);
  for (const result of results) {
    const bytes = await fs.readFile(result.outputPath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(bytes.length > 10000, 'screenshot should contain rendered UI');
    assert.equal(result.bodyOverflowX, false, 'body should not overflow horizontally');
    assert.equal(result.headerOverlap, false, 'header title and actions should not overlap');
    assert.equal(result.rowsInsideList, true, 'profile rows should stay inside the list');
    assert.equal(result.rowsOverlap, false, 'profile rows should not overlap');
    assert.deepEqual(result.clippedText, [], 'headings and commands should not be clipped');
    assert.equal(result.modalFits, true, 'profile modal should fit the viewport');
    assert.equal(result.queryControlsOverlap, false, 'query toolbar controls should not overlap');
    assert.equal(result.queryActionsOverlap, false, 'query commands should not overlap');
    assert.equal(result.resultActionsOverlap, false, 'result commands should not overlap');
    assert.equal(result.queryTabControlsOverlap, false, 'query tab list and new-tab command should not overlap');
    assert.equal(result.queryTabStripFits, true, 'query tab strip should stay inside the editor pane');
    assert.equal(result.queryTabEditorOverlap, false, 'query tabs should not overlap the editor');
    assert.equal(result.queryWorkspaceFits, true, 'query workspace should stay inside the viewport');
    assert.equal(result.queryRegionsInsideWorkspace, true, 'schema, editor, and results should stay inside the query workspace');
    assert.equal(result.queryRegionsOverlap, false, 'schema, editor, and results should not overlap');
    assert.equal(result.approvalFits, true, 'query approval should fit the viewport');
    assert.equal(result.savedQueryModalFits, true, 'saved-query modal should fit the viewport');
    assert.equal(result.inspectorFits, true, 'result value inspector should fit the viewport');
    assert.equal(result.schemaActionFits, true, 'schema action modal should fit the viewport');
    assert.equal(result.principalActionFits, true, 'user and privilege modal should fit the viewport');
    assert.equal(result.principalGrantRowsFit, true, 'visible privilege rows should fit the administration modal');
    assert.equal(result.monacoVisible, true, 'Monaco should render when its loaded state is active');
    assert.equal(result.monacoHasText, true, 'Monaco should render formatted SQL text');
    assert.equal(result.monacoInsideHost, true, 'Monaco should stay inside the editor host');
    if (result.name.endsWith('-monaco')) {
      assert.ok(result.monacoCompletionCount > 30, 'Monaco should receive schema and keyword completions');
      assert.equal(result.monacoTextFramed, true, 'Monaco first line should be visible inside the editor viewport');
    }
    if (result.name === 'desktop-query-grid' || result.name === 'mobile-query-inspector') {
      assert.equal(result.resultGridRowCount, 1000, 'virtual result fixture should retain all result rows');
      assert.ok(result.resultGridRenderedRowCount < 100, 'virtual result fixture should render only the visible row window');
      assert.equal(result.resultGridScrollable, true, 'virtual result fixture should preserve the complete scroll range');
    }
  }
});
