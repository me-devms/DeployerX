const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const VIEWPORTS = [
  { name: 'large', width: 1440, height: 900, step: 1 },
  { name: 'laptop', width: 1052, height: 744, step: 1 },
  { name: 'short', width: 900, height: 520, step: 2 },
  { name: 'mobile', width: 390, height: 640, step: 3 }
];

async function prepareHtml(outputDirectory) {
  const rendererDirectory = path.join(__dirname, '..', 'renderer');
  let html = await fs.readFile(path.join(rendererDirectory, 'index.html'), 'utf8');
  html = html.replace('./styles.css', pathToFileURL(path.join(rendererDirectory, 'styles.css')).href);
  html = html.replace(/\s*<script[^>]+src="[^"]+"[^>]*><\/script>/g, '');
  const htmlPath = path.join(outputDirectory, 'uptime-monitor-modal.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}

function showModalScript(step) {
  return `(() => {
    document.documentElement.dataset.theme = 'light';
    const startupLoader = document.getElementById('startupLoader');
    startupLoader?.style.setProperty('display', 'none', 'important');
    startupLoader?.remove();
    document.querySelector('.app-shell')?.classList.remove('hidden');
    document.getElementById('uptimeMonitorModal').classList.remove('hidden');
    document.querySelectorAll('[data-uptime-monitor-step]').forEach((panel) => {
      panel.classList.toggle('hidden', Number(panel.dataset.uptimeMonitorStep) !== ${step});
    });
    document.querySelectorAll('[data-uptime-monitor-step-button]').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.uptimeMonitorStepButton) === ${step});
    });
    document.getElementById('uptimeMonitorBackButton').classList.toggle('hidden', ${step} === 1);
    document.getElementById('uptimeMonitorNextButton').classList.toggle('hidden', ${step} === 3);
    document.getElementById('uptimeMonitorSaveButton').classList.toggle('hidden', ${step} !== 3);
  })()`;
}

function measurementScript(name, step) {
  return `(() => {
    const card = document.querySelector('.uptime-monitor-modal-card');
    const body = card.querySelector('.uptime-monitor-modal-body');
    const footer = card.querySelector('.modal-footer');
    const buttons = [...footer.querySelectorAll('button')].filter((button) => !button.classList.contains('hidden'));
    const cardRect = card.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const buttonRects = buttons.map((button) => button.getBoundingClientRect());
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const insideViewport = (rect) => rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
    return {
      name: '${name}',
      step: ${step},
      viewport: { width: innerWidth, height: innerHeight },
      cardInsideViewport: insideViewport(cardRect),
      footerInsideCard: footerRect.top >= cardRect.top && footerRect.bottom <= cardRect.bottom + 1,
      footerInsideViewport: insideViewport(footerRect),
      buttonsInsideFooter: buttonRects.every((rect) => rect.left >= footerRect.left - 1 && rect.right <= footerRect.right + 1 && rect.top >= footerRect.top - 1 && rect.bottom <= footerRect.bottom + 1),
      buttonsInsideViewport: buttonRects.every(insideViewport),
      buttonOverlap: buttonRects.some((rect, index) => buttonRects.slice(index + 1).some((other) => overlaps(rect, other))),
      bodyHasUsableHeight: body.clientHeight > 80,
      bodyScrollsWhenNeeded: body.scrollHeight <= body.clientHeight + 1 || getComputedStyle(body).overflowY === 'auto',
      bodyOverflowX: body.scrollWidth > body.clientWidth + 1,
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

  const window = new BrowserWindow({ show: false, width: 1440, height: 900, backgroundColor: '#f6f7fb' });
  try {
    const results = [];
    for (const viewport of VIEWPORTS) {
      window.setContentSize(viewport.width, viewport.height);
      await window.loadFile(htmlPath);
      await window.webContents.executeJavaScript(showModalScript(viewport.step));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const measurement = await window.webContents.executeJavaScript(measurementScript(viewport.name, viewport.step));
      const image = await window.webContents.capturePage();
      const outputPath = path.join(outputDirectory, `uptime-monitor-modal-${viewport.name}.png`);
      await fs.writeFile(outputPath, image.toPNG());
      results.push({ ...measurement, outputPath, byteLength: image.toPNG().length });
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
