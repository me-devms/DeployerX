const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 800 },
  { name: 'laptop', width: 1100, height: 760 },
  { name: 'wrapped', width: 880, height: 760 }
];

async function prepareHtml(outputDirectory) {
  let html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  html = html.replace('./styles.css', pathToFileURL(path.join(__dirname, 'styles.css')).href);
  html = html.replaceAll('../../assets/deployerx-logo.png', pathToFileURL(path.join(__dirname, '..', '..', 'assets', 'deployerx-logo.png')).href);
  html = html.replace(/\s*<script[^>]+src="[^"]+"[^>]*><\/script>/g, '');
  const htmlPath = path.join(outputDirectory, 'app-update-header.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}

function prepareHeaderScript() {
  return `(() => {
    document.documentElement.dataset.theme = 'light';
    document.getElementById('startupLoader')?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    const update = document.getElementById('topUpdateButton');
    update?.classList.remove('hidden');
    if (update) update.dataset.status = 'downloaded';
    const label = document.getElementById('topUpdateButtonLabel');
    if (label) label.textContent = 'Update now';
  })()`;
}

function measurementScript(name) {
  return `(() => {
    const ids = ['topUpdateButton', 'emergencyStopButton', 'topWorkspaceSwitcher', 'topNotificationsButton', 'teamButton'];
    const controls = ids.map((id) => document.getElementById(id)).filter(Boolean);
    const rects = controls.map((element) => element.getBoundingClientRect());
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    return {
      name: '${name}',
      viewport: { width: innerWidth, height: innerHeight },
      updateVisible: Boolean(document.getElementById('topUpdateButton')?.getClientRects().length),
      controlsInsideViewport: rects.every((rect) => rect.left >= -1 && rect.right <= innerWidth + 1),
      controlsOverlap: rects.some((rect, index) => rects.slice(index + 1).some((other) => overlaps(rect, other))),
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()`;
}

async function main() {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('Update header fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const htmlPath = await prepareHtml(outputDirectory);
  await app.whenReady();

  const window = new BrowserWindow({ show: false, width: 1440, height: 800, backgroundColor: '#f8f9fb' });
  try {
    const results = [];
    for (const viewport of VIEWPORTS) {
      window.setContentSize(viewport.width, viewport.height);
      await window.loadFile(htmlPath);
      await window.webContents.executeJavaScript(prepareHeaderScript());
      await new Promise((resolve) => setTimeout(resolve, 60));
      const measurement = await window.webContents.executeJavaScript(measurementScript(viewport.name));
      const image = await window.webContents.capturePage();
      const outputPath = path.join(outputDirectory, `app-update-header-${viewport.name}.png`);
      const bytes = image.toPNG();
      await fs.writeFile(outputPath, bytes);
      results.push({ ...measurement, outputPath, screenshotBytes: bytes.length });
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
