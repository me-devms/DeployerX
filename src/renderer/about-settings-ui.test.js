const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('wires About navigation, version metadata, and allowlisted external destinations', async () => {
  const [html, renderer, preload, main] = await Promise.all([
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')
  ]);

  assert.match(html, /data-settings-tab="about"/);
  assert.match(html, /data-settings-panel="about"/);
  assert.match(html, /id="aboutAppVersion"/);
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
