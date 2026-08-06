const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 }
];

async function prepareHtml(outputDirectory) {
  let html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  html = html.replace('./styles.css', pathToFileURL(path.join(__dirname, 'styles.css')).href);
  html = html.replaceAll('../../assets/deployerx-logo.png', pathToFileURL(path.join(__dirname, '..', '..', 'assets', 'deployerx-logo.png')).href);
  html = html.replaceAll('assets/everythingx-logo-transparent.png', pathToFileURL(path.join(__dirname, 'assets', 'everythingx-logo-transparent.png')).href);
  html = html.replace(/\s*<script[^>]+src="[^"]+"[^>]*><\/script>/g, '');
  const htmlPath = path.join(outputDirectory, 'about-settings.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}

function showAboutScript() {
  return `(() => {
    document.documentElement.dataset.theme = 'light';
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden'));
    document.getElementById('teamView').classList.remove('hidden');
    document.querySelectorAll('[data-settings-tab]').forEach((item) => item.classList.toggle('active', item.dataset.settingsTab === 'about'));
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === 'about'));
  })()`;
}

function measurementScript(name) {
  return `(() => {
    const panel = document.getElementById('settingsAboutPanel');
    const header = panel.querySelector('.about-product-header');
    const cards = [...panel.querySelectorAll('.about-details-grid > .settings-card')];
    const buttons = [...panel.querySelectorAll('.about-actions .button')];
    const visible = (element) => Boolean(element?.getClientRects().length);
    const insideViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1;
    };
    const overlaps = (left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    };
    return {
      name: '${name}',
      viewport: { width: innerWidth, height: innerHeight },
      panelVisible: visible(panel),
      aboutNavActive: document.querySelector('[data-settings-tab="about"]')?.classList.contains('active') || false,
      productName: panel.querySelector('.about-product-copy h2')?.textContent.trim(),
      companyName: panel.querySelector('.about-company-card h2')?.textContent.trim(),
      versionVisible: visible(document.getElementById('aboutAppVersion')),
      headerInsideViewport: insideViewport(header),
      cardsInsideViewport: cards.every(insideViewport),
      buttonsInsideViewport: buttons.every(insideViewport),
      cardOverlap: cards.length === 2 && overlaps(cards[0], cards[1]),
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()`;
}

async function main() {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('UI fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const htmlPath = await prepareHtml(outputDirectory);
  await app.whenReady();

  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f8f9fb' });
  try {
    const results = [];
    for (const viewport of VIEWPORTS) {
      window.setContentSize(viewport.width, viewport.height);
      await window.loadFile(htmlPath);
      await window.webContents.executeJavaScript(showAboutScript());
      await new Promise((resolve) => setTimeout(resolve, 80));
      const measurement = await window.webContents.executeJavaScript(measurementScript(viewport.name));
      const image = await window.webContents.capturePage();
      const outputPath = path.join(outputDirectory, `about-settings-${viewport.name}.png`);
      await fs.writeFile(outputPath, image.toPNG());
      results.push({ ...measurement, outputPath });
    }
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } finally {
    window.destroy();
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
