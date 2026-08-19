const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('wires About navigation, version metadata, and allowlisted external destinations', async () => {
  const [html, renderer, styles, preload, main] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, 'styles.css'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')
  ]);

  assert.match(html, /data-settings-tab="about"/);
  assert.match(html, /data-settings-panel="about"/);
  assert.match(html, /id="aboutAppVersion"/);
  assert.doesNotMatch(html, /data-settings-tab="database"/);
  const backupPanel = html.match(/id="settingsBackupPanel"[\s\S]*?(?=<section id="settingsDatabasePanel")/)?.[0] || '';
  const aboutPanel = html.match(/id="settingsAboutPanel"[\s\S]*?(?=<\/div>\s*<\/section>\s*<\/div>\s*<\/div>\s*<button id="logoutButton")/)?.[0] || '';
  assert.ok(backupPanel.indexOf('backup-history-card') < backupPanel.indexOf('backup-account-card'));
  assert.match(styles, /\.backup-settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(360px, 440px\)/s);
  assert.doesNotMatch(backupPanel, /id="appUpdateOpenReleasesButton"/);
  assert.match(aboutPanel, /class="settings-card app-update-card about-update-card"/);
  assert.match(aboutPanel, /id="appUpdateOpenReleasesButton"/);
  assert.match(aboutPanel, /id="appUpdateCheckButton"/);
  assert.match(renderer, /'theme', 'about'/);
  assert.match(renderer, /openExternalUrl\(button\.dataset\.aboutExternal\)/);
  assert.match(preload, /app:open-external-url/);
  assert.match(main, /https:\/\/everythingx\.in\//);
  assert.match(main, /mailto:info@everythingx\.in/);
  assert.match(html, /everythingx-logo-transparent\.png/);
  assert.match(html, /\+91 789 789 2129/);
  assert.match(main, /https:\/\/wa\.me\/917897892129/);
});

test('renders responsive product and company information in Settings', async (context) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-about-settings-'));
  context.after(async () => { await fs.rm(outputDirectory, { recursive: true, force: true }); });
  const fixturePath = path.join(__dirname, 'about-settings-ui-fixture.js');
  const { stdout } = await execFileAsync(require('electron'), [fixturePath, outputDirectory], { windowsHide: true, timeout: 30000 });
  const results = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.deepEqual(results.map((result) => result.viewport), [{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
  for (const result of results) {
    const bytes = await fs.readFile(result.outputPath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${result.name} screenshot format`);
    assert.ok(bytes.length > 10000, `${result.name} screenshot should contain rendered UI`);
    assert.equal(result.panelVisible, true, `${result.name} About panel visible`);
    assert.equal(result.aboutNavActive, true, `${result.name} About navigation active`);
    assert.equal(result.productName, 'DeployerX');
    assert.equal(result.companyName, 'EverythingX');
    assert.equal(result.versionVisible, true, `${result.name} version visible`);
    assert.equal(result.headerInsideViewport, true, `${result.name} product header clipped`);
    assert.equal(result.cardsInsideViewport, true, `${result.name} cards clipped`);
    assert.equal(result.buttonsInsideViewport, true, `${result.name} actions clipped`);
    assert.equal(result.cardOverlap, false, `${result.name} cards overlap`);
    assert.equal(result.documentOverflowX, false, `${result.name} horizontal overflow`);
  }
});

test('keeps Theme and About panels inside the live Settings content region', async (context) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-settings-runtime-'));
  context.after(async () => { await fs.rm(outputDirectory, { recursive: true, force: true }); });
  const fixturePath = path.join(__dirname, 'settings-runtime-fixture.js');
  const { stdout } = await execFileAsync(require('electron'), [fixturePath, outputDirectory], { windowsHide: true, timeout: 30000 });
  const { result, consoleMessages } = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.deepEqual(consoleMessages, []);
  assert.deepEqual(result.contentChildren.slice(-2), ['settingsThemePanel', 'settingsAboutPanel']);
  for (const panel of [result.theme, result.about]) {
    assert.equal(panel.teamHidden, false);
    assert.equal(panel.activeNav, 1);
    assert.equal(panel.activePanels, 1);
    assert.equal(panel.display, 'block');
    assert.equal(panel.visibility, 'visible');
    assert.ok(panel.textLength > 0);
    assert.ok(panel.rect.x > 0);
    assert.ok(panel.rect.y >= 0);
    assert.ok(panel.rect.width > 0);
    assert.ok(panel.rect.height > 0);
    assert.equal(panel.parentChain[1], 'div#.settings-content');
  }
});
