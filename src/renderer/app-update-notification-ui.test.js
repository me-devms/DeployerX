const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('connects automatic updates to the header action and notification bell', async () => {
  const [html, renderer, styles, workflow] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', '..', '.github', 'workflows', 'build-all.yml'), 'utf8')
  ]);

  assert.match(html, /id="topUpdateButton"[\s\S]*?id="emergencyStopButton"/);
  assert.match(renderer, /renderTopUpdateAction\(\);[\s\S]*?renderTopNotificationsMenu\(\);/);
  assert.match(renderer, /\['available', 'downloading', 'downloaded', 'manual-update'\]\.includes\(update\.status\)/);
  assert.match(renderer, /topUpdateButtonLabel\.textContent = 'Update now'/);
  assert.match(renderer, /action: update\.status === 'downloaded' \? 'install-update' : 'updates'/);
  assert.match(renderer, /action === 'install-update'\) installAppUpdate\(\)/);
  assert.match(renderer, /action === 'updates'\) setSettingsTab\('about'\)/);
  assert.match(styles, /\.top-update-action\[data-status="downloading"\][\s\S]*?animation: button-spin/);
  assert.match(workflow, /-name 'latest\.yml'/);
  assert.match(workflow, /-name '\*\.exe\.blockmap'/);
});

test('keeps the update action usable without crowding topbar controls', async (context) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-update-header-'));
  context.after(async () => { await fs.rm(outputDirectory, { recursive: true, force: true }); });
  const fixturePath = path.join(__dirname, 'app-update-notification-ui-fixture.js');
  const { stdout } = await execFileAsync(require('electron'), [fixturePath, outputDirectory], {
    windowsHide: true,
    timeout: 30000
  });
  const results = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.deepEqual(results.map((result) => result.viewport.width), [1440, 1100, 880]);
  for (const result of results) {
    assert.equal(result.updateVisible, true, `${result.name} update action hidden`);
    assert.equal(result.controlsInsideViewport, true, `${result.name} topbar control clipped`);
    assert.equal(result.controlsOverlap, false, `${result.name} topbar controls overlap`);
    assert.equal(result.documentOverflowX, false, `${result.name} horizontal overflow`);
    assert.ok(result.screenshotBytes > 10000, `${result.name} screenshot should contain rendered UI`);
  }
});
