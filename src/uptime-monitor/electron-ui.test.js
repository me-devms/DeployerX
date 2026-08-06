const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('renders responsive Uptime operations views without viewport overflow or collisions', async (context) => {
  const electronPath = require('electron');
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-ui-test-'));
  context.after(async () => { await fs.rm(outputDirectory, { recursive: true, force: true }); });

  const fixturePath = path.join(__dirname, 'electron-ui-fixture.js');
  const { stdout } = await execFileAsync(electronPath, [fixturePath, outputDirectory], { windowsHide: true, timeout: 30000 });
  const results = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.deepEqual(results.map((result) => result.viewport), [
    { width: 1440, height: 900 },
    { width: 1180, height: 780 },
    { width: 1180, height: 780 },
    { width: 1180, height: 780 },
    { width: 1440, height: 900 },
    { width: 1180, height: 780 }
  ]);
  assert.deepEqual(results.map((result) => result.panel), ['overview', 'monitors', 'monitors', 'incidents', 'reports', 'maintenance']);
  for (const result of results) {
    const bytes = await fs.readFile(result.outputPath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${result.panel} screenshot format`);
    assert.ok(bytes.length > 10000, `${result.panel} screenshot should contain rendered UI`);
    assert.equal(result.bodyOverflowX, false, `${result.panel} body overflow`);
    assert.equal(result.headerOverlap, false, `${result.panel} header overlap`);
    assert.equal(result.createButtonWraps, false, `${result.panel} Create Monitor wrapping`);
    assert.equal(result.panelActionTooWide, false, `${result.panel} panel action should keep an intrinsic width`);
    assert.equal(result.panelActionOutsideViewport, false, `${result.panel} panel action outside viewport`);
    assert.equal(result.filtersUseMultipleRows, false, `${result.panel} desktop filters should remain on one row`);
    assert.equal(result.emptyStateTooTall, false, `${result.panel} empty state should stay compact`);
    if (result.panel === 'monitors') {
      assert.equal(result.monitorDescriptionMissing, false, 'Monitors heading should retain its descriptive subtitle');
      assert.equal(result.emptyMonitorTableVisible, true, 'empty Monitors view should retain the fixed table area');
      assert.equal(result.emptyMonitorActionsVisible, true, 'empty Monitors view should retain bulk actions');
      assert.equal(result.emptyMonitorActionsDisabled, true, 'empty Monitors bulk actions should remain disabled');
      assert.equal(result.emptyMonitorSelectionVisible, false, 'empty Monitors view should hide select-all');
      assert.equal(result.monitorToolbarIntegrated, true, 'search and Filters should live inside the table card');
      assert.equal(result.monitorSearchTooWide, false, 'desktop Monitors search should not exceed 320px');
      assert.equal(result.monitorTableTooShort, false, 'Monitors table card should keep a fixed minimum height');
      assert.equal(result.monitorHeaderNotSticky, false, 'Monitors table header should stay sticky');
      assert.equal(result.monitorFilterPanelStateWrong, false, 'Filters panel should match its expanded state');
      assert.equal(result.monitorFilterPanelNotOverlay, false, 'Filters panel should open as an overlay');
      assert.equal(result.monitorFilterUsesNativeSelects, false, 'Filters should use the shared custom dropdown component');
      assert.equal(result.monitorFilterSelectMenuStateWrong, false, 'custom State dropdown should match its expanded state');
      assert.equal(result.monitorFilterSelectStackingWrong, false, 'custom dropdown menu should layer above lower filter controls');
    }
    if (result.panel === 'incidents') {
      assert.equal(result.incidentTableVisible, true, 'empty Incidents view should retain the fixed table area');
      assert.equal(result.incidentToolbarIntegrated, true, 'Incidents search and Filters should live inside the table card');
      assert.equal(result.incidentSearchTooWide, false, 'desktop Incidents search should not exceed 320px');
      assert.equal(result.incidentTableTooShort, false, 'Incidents table card should keep a fixed minimum height');
      assert.equal(result.incidentHeaderNotSticky, false, 'Incidents table header should stay sticky');
      assert.equal(result.incidentFilterPanelStateWrong, false, 'Incidents Filters panel should match its expanded state');
      assert.equal(result.incidentFilterPanelNotOverlay, false, 'Incidents Filters panel should open as an overlay');
      assert.equal(result.incidentFilterUsesNativeSelect, false, 'Incidents State should use the shared custom dropdown component');
    }
    if (result.panel === 'maintenance') {
      assert.equal(result.maintenanceTableTooShort, false, 'Maintenance table card should keep a fixed minimum height');
    }
    assert.equal(result.cardOverlap, false, `${result.panel} KPI overlap`);
    assert.deepEqual(result.clippedText, [], `${result.panel} clipped commands or headings`);
  }
  assert.ok(Math.abs(results[1].monitorTableCardHeight - results[2].monitorTableCardHeight) <= 1, 'Filters dropdown should not resize the Monitors table card');
});
