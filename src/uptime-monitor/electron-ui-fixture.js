const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const VIEWPORTS = [
  { name: 'large', width: 1440, height: 900, panel: 'overview' },
  { name: 'default', width: 1180, height: 780, panel: 'monitors' },
  { name: 'filters', width: 1180, height: 780, panel: 'monitors', filtersOpen: true, filterSelectOpen: true },
  { name: 'filters', width: 1180, height: 780, panel: 'incidents', incidentFiltersOpen: true },
  { name: 'large', width: 1440, height: 900, panel: 'reports' },
  { name: 'default', width: 1180, height: 780, panel: 'maintenance' }
];

async function prepareAcceptanceHtml(outputDirectory) {
  const rendererDirectory = path.join(__dirname, '..', 'renderer');
  let html = await fs.readFile(path.join(rendererDirectory, 'index.html'), 'utf8');
  html = html.replace('./styles.css', pathToFileURL(path.join(rendererDirectory, 'styles.css')).href);
  html = html.replace(/\s*<script[^>]+src="[^"]+"[^>]*><\/script>/g, '');
  const htmlPath = path.join(outputDirectory, 'uptime-ui-acceptance.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}

function sampleMarkupScript() {
  return `(() => {
    document.documentElement.dataset.theme = 'light';
    document.getElementById('startupLoader')?.classList.add('hidden');
    const shell = document.querySelector('.app-shell');
    shell?.classList.remove('hidden');
    document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden'));
    document.getElementById('uptimeView')?.classList.remove('hidden');
    document.getElementById('dashboardButton')?.classList.remove('active');
    document.getElementById('uptimeButton')?.classList.add('active');
    document.getElementById('uptimeWorkerBadge')?.classList.add('is-online');
    document.getElementById('uptimeWorkerBadge').lastChild.textContent = ' Worker Online';
    document.getElementById('uptimeAvailabilityValue').textContent = '99.982%';
    document.getElementById('uptimeCoverageValue').textContent = '98.7%';
    document.getElementById('uptimeLatencyValue').textContent = '184 ms';
    document.getElementById('uptimeHealthyCount').textContent = '7 / 8';
    document.getElementById('uptimeFleetMeta').textContent = '8 Enabled Monitors';
    document.getElementById('uptimeAttentionCount').textContent = '1';
    document.getElementById('uptimeIncidentBadge').textContent = '1';
    document.getElementById('uptimeIncidentBadge').classList.remove('hidden');
    document.getElementById('projectList').innerHTML = '<button class="project-item"><span>Production API</span></button><button class="project-item"><span>Customer portal</span></button>';
    document.getElementById('uptimeFleetList').innerHTML = [
      ['status-up', 'Public API', 'https://api.example.com/health', '99.99%', '142 ms'],
      ['status-up', 'Customer portal', 'https://app.example.com', '99.98%', '218 ms'],
      ['status-warning', 'Billing webhook', 'https://billing.example.com/webhook', '99.91%', '891 ms'],
      ['status-up', 'PostgreSQL gateway', 'db.example.com:5432', '100%', '34 ms']
    ].map((item) => '<button class="uptime-fleet-row"><span class="uptime-health-dot '+item[0]+'"></span><span><strong>'+item[1]+'</strong><small>'+item[2]+'</small></span><span>'+item[3]+'</span><span>'+item[4]+'</span></button>').join('');
    document.getElementById('uptimeRecentIncidentList').innerHTML = '<div class="uptime-timeline-row"><strong>Billing webhook latency</strong><span>Warning threshold exceeded</span><small>8 minutes ago</small></div><div class="uptime-timeline-row"><strong>Customer portal recovered</strong><span>Resolved after 3 minutes</span><small>Yesterday</small></div>';
    document.getElementById('uptimeMonitorListMeta').textContent = 'Track endpoint availability and response performance';
    document.getElementById('uptimeMonitorTableBody').innerHTML = '';
    document.getElementById('uptimeMonitorTableCard').classList.add('is-empty');
    document.getElementById('uptimeMonitorsEmpty').classList.remove('hidden');
    document.getElementById('uptimeMonitorsEmptyCopy').textContent = 'Create a monitor to begin tracking availability.';
    for (const name of ['State', 'Type', 'Sort']) {
      const select = document.getElementById('uptime'+name+'Filter');
      const label = document.getElementById('uptime'+name+'FilterLabel');
      const menu = document.getElementById('uptime'+name+'FilterMenu');
      const selected = select.options[select.selectedIndex];
      label.textContent = selected.textContent;
      menu.innerHTML = Array.from(select.options).map((option) => '<button class="workspace-switcher-option" type="button" role="option" aria-selected="'+(option.value === select.value)+'" tabindex="-1"><span>'+option.textContent+'</span>'+(option.value === select.value ? '<svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-check"></use></svg>' : '')+'</button>').join('');
    }
    const incidentStateSelect = document.getElementById('uptimeIncidentStateFilter');
    const incidentStateLabel = document.getElementById('uptimeIncidentStateFilterLabel');
    const incidentStateMenu = document.getElementById('uptimeIncidentStateFilterMenu');
    incidentStateLabel.textContent = incidentStateSelect.options[incidentStateSelect.selectedIndex].textContent;
    incidentStateMenu.innerHTML = Array.from(incidentStateSelect.options).map((option) => '<button class="workspace-switcher-option" type="button" role="option" aria-selected="'+(option.value === incidentStateSelect.value)+'" tabindex="-1"><span>'+option.textContent+'</span>'+(option.value === incidentStateSelect.value ? '<svg class="button-icon" viewBox="0 0 24 24"><use href="#icon-check"></use></svg>' : '')+'</button>').join('');
    document.getElementById('uptimeIncidentsEmpty').classList.remove('hidden');
    document.getElementById('uptimeMaintenanceEmpty').classList.remove('hidden');
    document.getElementById('uptimeReportAvailability').textContent = '99.982%';
    document.getElementById('uptimeReportCoverage').textContent = '98.7%';
    document.getElementById('uptimeReportDowntime').textContent = '7m 46s';
    document.getElementById('uptimeReportP95').textContent = '184 ms';
    document.getElementById('uptimeReportPeriod').textContent = 'Last 30 days · Production';
    document.getElementById('uptimeReportChart').innerHTML = Array.from({ length: 30 }, (_, index) => '<div class="uptime-chart-day"><span style="height:'+(65 + index % 8 * 4)+'%"><i style="height:'+(92 + index % 5)+'%"></i></span><small>'+(index + 1)+'</small></div>').join('');
    document.getElementById('uptimeReportMonitorTable').innerHTML = '<div class="uptime-incident-entry"><span class="uptime-health-dot status-up"></span><span><strong>Public API</strong><small>99.99% availability · 99.8% coverage</small></span><span>142 ms</span><span>0 incidents</span></div><div class="uptime-incident-entry"><span class="uptime-health-dot status-warning"></span><span><strong>Billing webhook</strong><small>99.91% availability · 97.4% coverage</small></span><span>891 ms</span><span>1 incident</span></div>';
    document.getElementById('uptimeReportMethodology').textContent = 'Availability excludes paused, maintenance, and unknown periods. Coverage is reported separately.';
  })()`;
}

function panelScript(viewport) {
  const { panel, filtersOpen = false, filterSelectOpen = false, incidentFiltersOpen = false } = viewport;
  return `(() => {
    document.querySelectorAll('[data-uptime-tab]').forEach((tab) => tab.classList.toggle('active', tab.dataset.uptimeTab === '${panel}'));
    document.querySelectorAll('[data-uptime-panel]').forEach((item) => item.classList.toggle('active', item.dataset.uptimePanel === '${panel}'));
    document.getElementById('uptimeMonitorFilterPanel').classList.toggle('hidden', ${!filtersOpen});
    document.getElementById('uptimeMonitorFilterButton').setAttribute('aria-expanded', '${filtersOpen}');
    document.getElementById('uptimeStateFilterMenu').classList.toggle('hidden', ${!filterSelectOpen});
    document.getElementById('uptimeStateFilterButton').setAttribute('aria-expanded', '${filterSelectOpen}');
    document.getElementById('uptimeStateFilterDropdown').classList.toggle('is-open', ${filterSelectOpen});
    document.getElementById('uptimeIncidentFilterPanel').classList.toggle('hidden', ${!incidentFiltersOpen});
    document.getElementById('uptimeIncidentFilterButton').setAttribute('aria-expanded', '${incidentFiltersOpen}');
    document.querySelector('.workspace').scrollTop = 0;
  })()`;
}

function measurementScript(panel, filtersOpen = false, filterSelectOpen = false, incidentFiltersOpen = false) {
  return `(() => {
    const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const overlaps = (left, right) => {
      if (!visible(left) || !visible(right)) return false;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    };
    const header = document.querySelector('.uptime-view-header');
    const createButton = document.getElementById('uptimeAddMonitorButton');
    const panelHeading = document.querySelector('[data-uptime-panel="${panel}"] > .uptime-panel-heading');
    const panelAction = panelHeading?.lastElementChild;
    const filterBar = document.querySelector('[data-uptime-panel="${panel}"] > .uptime-filter-bar, [data-uptime-panel="${panel}"] > .uptime-report-filters');
    const filterChildren = filterBar ? [...filterBar.children].filter(visible) : [];
    const emptyState = document.querySelector('[data-uptime-panel="${panel}"] .uptime-empty-state:not(.hidden)');
    const emptyMonitorCount = document.getElementById('uptimeMonitorListMeta');
    const emptyMonitorTable = document.getElementById('uptimeMonitorTableWrap');
    const emptyMonitorActions = document.getElementById('uptimeMonitorBulkActions');
    const emptyMonitorActionButtons = [...emptyMonitorActions.querySelectorAll('button')];
    const monitorTableCard = document.getElementById('uptimeMonitorTableCard');
    const monitorSearch = document.querySelector('[data-uptime-panel="monitors"] .uptime-search');
    const monitorFilterButton = document.getElementById('uptimeMonitorFilterButton');
    const monitorFilterPanel = document.getElementById('uptimeMonitorFilterPanel');
    const monitorFilterSelects = [...monitorFilterPanel.querySelectorAll('select')];
    const monitorFilterSelectTriggers = [...monitorFilterPanel.querySelectorAll('.uptime-filter-select > .workspace-switcher-trigger')];
    const monitorStateFilterMenu = document.getElementById('uptimeStateFilterMenu');
    const monitorStateFilterDropdown = document.getElementById('uptimeStateFilterDropdown');
    const monitorSelectAll = document.getElementById('uptimeSelectAllMonitors');
    const monitorTableHeader = document.querySelector('#uptimeMonitorTableWrap thead');
    const incidentTableCard = document.getElementById('uptimeIncidentTableCard');
    const incidentTableWrap = document.getElementById('uptimeIncidentTableWrap');
    const incidentSearch = document.getElementById('uptimeIncidentSearchInput').closest('.uptime-search');
    const incidentFilterButton = document.getElementById('uptimeIncidentFilterButton');
    const incidentFilterPanel = document.getElementById('uptimeIncidentFilterPanel');
    const incidentStateSelect = document.getElementById('uptimeIncidentStateFilter');
    const incidentStateTrigger = document.getElementById('uptimeIncidentStateFilterButton');
    const incidentTableHeader = document.querySelector('#uptimeIncidentTableWrap thead');
    const maintenanceTableCard = document.querySelector('[data-uptime-panel="maintenance"] .uptime-maintenance-card');
    const cards = [...document.querySelectorAll('[data-uptime-panel="${panel}"] .uptime-summary-card, [data-uptime-panel="${panel}"] .uptime-report-kpis > div')].filter(visible);
    const cardOverlap = cards.some((card, index) => cards.slice(index + 1).some((other) => overlaps(card, other)));
    const clippedText = [...document.querySelectorAll('[data-uptime-panel="${panel}"] h2, [data-uptime-panel="${panel}"] h3, [data-uptime-panel="${panel}"] .button')]
      .filter(visible)
      .filter((element) => element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflowX !== 'auto')
      .map((element) => element.textContent.trim()).filter(Boolean);
    return {
      panel: '${panel}',
      viewport: { width: innerWidth, height: innerHeight },
      bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      headerOverlap: overlaps(header?.firstElementChild, header?.querySelector('.header-actions')),
      createButtonWraps: createButton ? getComputedStyle(createButton).whiteSpace !== 'nowrap' || createButton.scrollWidth > createButton.clientWidth + 2 : true,
      panelActionTooWide: visible(panelAction) && ['BUTTON', 'SELECT'].includes(panelAction.tagName) ? panelAction.getBoundingClientRect().width > 260 : false,
      panelActionOutsideViewport: visible(panelAction) ? panelAction.getBoundingClientRect().right > innerWidth + 1 : false,
      filtersUseMultipleRows: filterChildren.length > 1 && Math.max(...filterChildren.map((item) => item.getBoundingClientRect().bottom)) - Math.min(...filterChildren.map((item) => item.getBoundingClientRect().bottom)) > 3,
      emptyStateTooTall: visible(emptyState) && !emptyState.closest('.uptime-table-area, .uptime-maintenance-card') ? emptyState.getBoundingClientRect().height > 160 : false,
      monitorDescriptionMissing: '${panel}' === 'monitors' && (!visible(emptyMonitorCount) || emptyMonitorCount.textContent.trim() !== 'Track endpoint availability and response performance'),
      emptyMonitorTableVisible: '${panel}' === 'monitors' && visible(emptyMonitorTable),
      emptyMonitorActionsVisible: '${panel}' === 'monitors' && visible(emptyMonitorActions),
      emptyMonitorActionsDisabled: '${panel}' !== 'monitors' || emptyMonitorActionButtons.every((button) => button.disabled),
      emptyMonitorSelectionVisible: '${panel}' === 'monitors' && visible(monitorSelectAll),
      monitorToolbarIntegrated: '${panel}' !== 'monitors' || (monitorTableCard.contains(monitorSearch) && monitorTableCard.contains(monitorFilterButton)),
      monitorSearchTooWide: '${panel}' === 'monitors' && monitorSearch.getBoundingClientRect().width > 322,
      monitorTableTooShort: '${panel}' === 'monitors' && monitorTableCard.getBoundingClientRect().height < 360,
      monitorTableCardHeight: '${panel}' === 'monitors' ? monitorTableCard.getBoundingClientRect().height : 0,
      monitorHeaderNotSticky: '${panel}' === 'monitors' && getComputedStyle(monitorTableHeader).position !== 'sticky',
      monitorFilterPanelStateWrong: '${panel}' === 'monitors' && visible(monitorFilterPanel) !== ${filtersOpen},
      monitorFilterPanelNotOverlay: '${panel}' === 'monitors' && ${filtersOpen} && getComputedStyle(monitorFilterPanel).position !== 'absolute',
      monitorFilterUsesNativeSelects: '${panel}' === 'monitors' && ${filtersOpen} && (monitorFilterSelects.some(visible) || monitorFilterSelectTriggers.length !== 3 || monitorFilterSelectTriggers.some((trigger) => !visible(trigger))),
      monitorFilterSelectMenuStateWrong: '${panel}' === 'monitors' && visible(monitorStateFilterMenu) !== ${filterSelectOpen},
      monitorFilterSelectStackingWrong: '${panel}' === 'monitors' && ${filterSelectOpen} && Number(getComputedStyle(monitorStateFilterDropdown).zIndex) < 2,
      incidentTableVisible: '${panel}' !== 'incidents' || visible(incidentTableWrap),
      incidentToolbarIntegrated: '${panel}' !== 'incidents' || (incidentTableCard.contains(incidentSearch) && incidentTableCard.contains(incidentFilterButton)),
      incidentSearchTooWide: '${panel}' === 'incidents' && incidentSearch.getBoundingClientRect().width > 322,
      incidentTableTooShort: '${panel}' === 'incidents' && incidentTableCard.getBoundingClientRect().height < 360,
      incidentHeaderNotSticky: '${panel}' === 'incidents' && getComputedStyle(incidentTableHeader).position !== 'sticky',
      incidentFilterPanelStateWrong: '${panel}' === 'incidents' && visible(incidentFilterPanel) !== ${incidentFiltersOpen},
      incidentFilterPanelNotOverlay: '${panel}' === 'incidents' && ${incidentFiltersOpen} && getComputedStyle(incidentFilterPanel).position !== 'absolute',
      incidentFilterUsesNativeSelect: '${panel}' === 'incidents' && ${incidentFiltersOpen} && (visible(incidentStateSelect) || !visible(incidentStateTrigger)),
      maintenanceTableTooShort: '${panel}' === 'maintenance' && maintenanceTableCard.getBoundingClientRect().height < 360,
      cardOverlap,
      clippedText
    };
  })()`;
}

async function main() {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) throw new Error('UI fixture requires an output directory.');
  await fs.mkdir(outputDirectory, { recursive: true });
  const htmlPath = await prepareAcceptanceHtml(outputDirectory);
  await app.whenReady();

  const window = new BrowserWindow({ show: false, width: 1440, height: 900, backgroundColor: '#f6f7fb' });
  try {
    await window.loadFile(htmlPath);
    await window.webContents.executeJavaScript(sampleMarkupScript());
    const results = [];
    for (const viewport of VIEWPORTS) {
      window.setContentSize(viewport.width, viewport.height);
      await window.webContents.executeJavaScript(panelScript(viewport));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const measurement = await window.webContents.executeJavaScript(measurementScript(viewport.panel, viewport.filtersOpen, viewport.filterSelectOpen, viewport.incidentFiltersOpen));
      const outputPath = path.join(outputDirectory, `uptime-${viewport.name}-${viewport.panel}.png`);
      const image = await window.webContents.capturePage();
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
