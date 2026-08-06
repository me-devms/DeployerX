const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

function axProperty(node, name) {
  return node.properties?.find((property) => property.name === name)?.value?.value;
}

async function accessibilityTree(window) {
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Accessibility.enable');
  const result = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  return result.nodes.filter((node) => !node.ignored).map((node) => ({
    role: String(node.role?.value || ''),
    name: String(node.name?.value || ''),
    selected: axProperty(node, 'selected') === true
  }));
}

async function waitFor(window, expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const outputDirectory = process.argv[2];
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: '#f6f7fb' });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(`
      document.getElementById('startupLoader')?.remove();
      document.querySelector('.app-shell')?.classList.remove('hidden');
      document.querySelector('.app-shell')?.style.setProperty('display', 'grid', 'important');
      document.getElementById('setupModal')?.classList.add('hidden');
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      window.__pluginCheckCalls = 0;
      window.__pluginRequirementCalls = 0;
      window.__fixturePlugins = [
        { pluginId: 'vendor.elasticsearch', name: 'Elasticsearch', version: '2.1.0', supported: true, installed: true, enabled: true, signature: { algorithm: 'Ed25519' }, signatureVerified: true, description: 'Search and inspect Elasticsearch data.', health: { status: 'ready', lastCheckedAt: '2026-08-05T12:00:00.000Z', crashCount: 0 }, driver: { id: 'vendor.elasticsearch', name: 'Elasticsearch', defaultPort: 9200, capabilities: { supportsSsl: true, supportsSsh: true }, credentialSlots: [{ id: 'api-token', type: 'token', label: 'API token', required: true }], settings: { fields: [{ key: 'index-pattern', label: 'Index pattern', required: true }, { key: 'include-hidden', label: 'Include hidden indexes', type: 'boolean' }] } } },
        { pluginId: 'vendor.db2', name: 'IBM Db2', version: '1.4.0', supported: true, installed: true, enabled: true, signature: { algorithm: 'Ed25519' }, signatureVerified: true, description: 'Browse IBM Db2 databases.', health: { status: 'crashed', crashCount: 2, lastErrorCode: 'DATABASE_MANAGER_DRIVER_HOST_EXITED' }, driver: { id: 'vendor.db2', name: 'IBM Db2', defaultPort: 50000, capabilities: { supportsSsl: true }, credentialSlots: [{ id: 'connection-uri', type: 'connection-uri', label: 'Connection URI', required: true }] } },
        { pluginId: 'vendor.redis', name: 'Redis', version: '1.0.0', supported: true, installed: true, enabled: false, integrityStatus: 'failed', signature: { algorithm: 'Ed25519' }, signatureVerified: true, description: 'Inspect Redis data.', health: { status: 'disabled' }, driver: { id: 'vendor.redis', name: 'Redis', defaultPort: 6379, capabilities: {}, credentialSlots: [] } },
        { pluginId: 'vendor.legacy', name: 'Legacy driver', version: '0.5.0', supported: false, unsupportedReason: 'A signed release is required before this driver can run.', installed: true, enabled: false, integrityStatus: 'verified', signature: null, signatureVerified: false, health: { status: 'disabled' }, driver: { id: 'vendor.legacy', name: 'Legacy driver', defaultPort: null, capabilities: {}, credentialSlots: [] } },
        { pluginId: 'vendor.mongo', name: 'MongoDB', version: '0.9.0', supported: false, unsupportedReason: 'No Windows x64 release is available.', installed: false, enabled: false, signature: null, health: null, runtimeRequirement: { id: 'python', label: 'Python', minimumVersion: '3.8', status: 'unavailable', reason: 'Python 3.8 or newer is not available on this device.' } },
        { pluginId: 'vendor.csv', name: 'CSV Folder', version: '1.0.3', supported: true, installed: true, enabled: false, signature: { algorithm: 'Ed25519' }, signatureVerified: true, health: { status: 'disabled' }, runtimeRequirement: { id: 'python', label: 'Python', minimumVersion: '3.8', status: 'unavailable', reason: 'Python 3.8 or newer is not available on this device.' }, driver: { id: 'vendor.csv', name: 'CSV Folder', defaultPort: null, capabilities: { schemas: true, crud: false }, credentialSlots: [] } }
      ];
      Object.defineProperty(window, 'deployerx', { configurable: true, value: {
        listDatabasePlugins: async () => structuredClone(window.__fixturePlugins),
        refreshDatabasePlugins: async () => structuredClone(window.__fixturePlugins),
        recheckDatabasePluginRequirements: async () => {
          window.__pluginRequirementCalls += 1;
          const plugin = window.__fixturePlugins.find((item) => item.pluginId === 'vendor.csv');
          plugin.runtimeRequirement = { id: 'python', label: 'Python', minimumVersion: '3.8', status: 'available', version: '3.12.13', reason: null };
          return structuredClone(window.__fixturePlugins);
        },
        checkDatabasePluginHealth: async (pluginId) => {
          window.__pluginCheckCalls += 1;
          const plugin = window.__fixturePlugins.find((item) => item.pluginId === pluginId);
          plugin.health = { status: 'ready', lastCheckedAt: '2026-08-05T12:05:00.000Z', crashCount: plugin.health?.crashCount || 0 };
          return structuredClone(plugin.health);
        },
        installDatabasePlugin: async () => ({}), enableDatabasePlugin: async () => ({}), disableDatabasePlugin: async () => ({}), removeDatabasePlugin: async () => ({})
      }});
      state.setup.mode = 'local';
      state.projects = [];
      state.databaseManager.profiles = [];
      state.databaseManager.plugins.items = structuredClone(window.__fixturePlugins);
      state.databaseManager.plugins.loading = false;
      state.databaseManager.plugins.error = '';
      showView('database');
      setDatabaseManagerTab('plugins');
      renderDatabasePlugins();
      true;
    `);
    const desktop = await window.webContents.executeJavaScript(`(() => ({
      healthLabels: [...document.querySelectorAll('.database-plugin-health')].map((item) => item.textContent.trim()),
      crashEvidence: document.getElementById('databasePluginsPanel').innerText.includes('2 recorded crashes'),
      unavailableReason: document.getElementById('databasePluginsPanel').innerText.includes('No Windows x64 release is available.'),
      runtimeRequirement: document.getElementById('databasePluginsPanel').innerText.includes('Python 3.8 or newer is not available on this device.'),
      runtimeUnavailableLabel: document.getElementById('databasePluginsPanel').innerText.includes('Runtime unavailable'),
      runtimeRecheckButtons: document.querySelectorAll('[data-database-plugin-runtime-refresh]').length,
      integrityWarning: document.getElementById('databasePluginsPanel').innerText.includes('Driver files must be reinstalled before use.'),
      signatureWarning: document.getElementById('databasePluginsPanel').innerText.includes('Install a signed release before using this driver.'),
      reinstallButtons: [...document.querySelectorAll('[data-database-plugin-install]')].filter((button) => button.textContent.trim() === 'Reinstall').length,
      signatureRequiredButtons: [...document.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Signature required' && button.disabled).length,
      checkButtons: document.querySelectorAll('[data-database-plugin-health]').length
    }))()`);
    const baseAccessibility = await accessibilityTree(window);
    desktop.accessibilityTabs = baseAccessibility.filter((node) => node.role === 'tab').map((node) => ({ name: node.name, selected: node.selected }));
    desktop.unnamedInteractiveNodes = baseAccessibility.filter((node) => ['button', 'checkbox', 'combobox', 'link', 'tab', 'textbox'].includes(node.role) && !node.name).length;
    const tabKeyboard = await window.webContents.executeJavaScript(`(async () => {
      const tabs = [...document.querySelectorAll('.database-manager-tabs [role="tab"]')];
      const initialTabIndexes = tabs.map((tab) => [tab.id, tab.tabIndex]);
      const pluginsTab = document.getElementById('databasePluginsTab');
      pluginsTab.focus();
      pluginsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const wrappedForward = {
        selected: document.querySelector('.database-manager-tabs [aria-selected="true"]')?.id,
        focused: document.activeElement?.id
      };
      document.getElementById('databaseConnectionsTab').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        initialTabIndexes,
        wrappedForward,
        wrappedBackward: {
          selected: document.querySelector('.database-manager-tabs [aria-selected="true"]')?.id,
          focused: document.activeElement?.id
        }
      };
    })()`);
    const desktopPath = path.join(outputDirectory, 'database-plugin-drivers-desktop.png');
    await fs.writeFile(desktopPath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`document.querySelector('[data-database-plugin-health="vendor.db2"]').click()`);
    await waitFor(window, `window.__pluginCheckCalls === 1 && [...document.querySelectorAll('.database-plugin-health')].some((item) => item.textContent.trim() === 'Ready')`);
    desktop.checkCalls = await window.webContents.executeJavaScript('window.__pluginCheckCalls');
    desktop.checkedStatus = await window.webContents.executeJavaScript(`document.querySelectorAll('.database-plugin-health')[1].textContent.trim()`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-database-plugin-runtime-refresh]').click()`);
    await waitFor(window, `window.__pluginRequirementCalls === 1 && [...document.querySelectorAll('[data-database-plugin-enable]')].some((item) => item.dataset.databasePluginEnable === 'vendor.csv')`);
    desktop.requirementCalls = await window.webContents.executeJavaScript('window.__pluginRequirementCalls');
    desktop.runtimeRecovered = await window.webContents.executeJavaScript(`document.getElementById('databasePluginsPanel').innerText.includes('detected 3.12.13')`);

    window.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mobile = await window.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.database-plugin-row')].map((row) => row.getBoundingClientRect());
      return {
        bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        rowsInsideViewport: rows.every((row) => row.left >= 0 && row.right <= innerWidth),
        rowsOverlap: rows.some((row, index) => index && row.top < rows[index - 1].bottom)
      };
    })()`);
    const mobilePath = path.join(outputDirectory, 'database-plugin-drivers-mobile.png');
    await fs.writeFile(mobilePath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`(() => {
      openDatabaseProfileModal();
      els.databaseProfileDriver.value = 'vendor.elasticsearch';
      syncDatabaseProfileDriver({ resetPort: true });
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const form = await window.webContents.executeJavaScript(`(() => {
      const modal = els.databaseProfileModal.querySelector('.modal-card').getBoundingClientRect();
      return {
        modalFits: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
        credentialFields: els.databaseProfilePluginCredentials.querySelectorAll('[data-database-plugin-credential]').length,
        settingFields: els.databaseProfilePluginSettings.querySelectorAll('[data-database-plugin-setting]').length,
        networkVisible: !els.databaseProfileNetworkFields.classList.contains('hidden'),
        usernameHidden: els.databaseProfileUsername.closest('.field').classList.contains('hidden')
      };
    })()`);
    const modalAccessibility = await accessibilityTree(window);
    form.appShellInert = await window.webContents.executeJavaScript(`document.querySelector('.app-shell').inert`);
    form.dialogNames = modalAccessibility.filter((node) => node.role === 'dialog').map((node) => node.name);
    form.backgroundDatabaseNavigationHidden = !modalAccessibility.some((node) => node.role === 'button' && node.name === 'Database Manager');
    form.unnamedInteractiveNodes = modalAccessibility.filter((node) => ['button', 'checkbox', 'combobox', 'link', 'tab', 'textbox'].includes(node.role) && !node.name).length;
    const formPath = path.join(outputDirectory, 'database-plugin-profile-mobile.png');
    await fs.writeFile(formPath, (await window.webContents.capturePage()).toPNG());
    const connectionUriForm = await window.webContents.executeJavaScript(`(() => {
      els.databaseProfileDriver.value = 'vendor.db2';
      syncDatabaseProfileDriver({ resetPort: true });
      const credential = els.databaseProfilePluginCredentials.querySelector('[data-database-plugin-credential="connection-uri"]');
      credential.value = 'db2://user:password@db.example.test:50000/app';
      const payload = databaseProfileFormPayload();
      return {
        credentialFields: els.databaseProfilePluginCredentials.querySelectorAll('[data-database-plugin-credential]').length,
        networkHidden: els.databaseProfileNetworkFields.classList.contains('hidden'),
        databaseHidden: els.databaseProfileDatabaseField.classList.contains('hidden'),
        schemaHidden: els.databaseProfileSchemaField.classList.contains('hidden'),
        sslHidden: els.databaseProfileSslField.classList.contains('hidden'),
        linkedServerDisabled: els.databaseProfileProject.disabled,
        endpoint: payload.endpoint,
        database: payload.database,
        defaultSchema: payload.defaultSchema,
        sslMode: payload.ssl.mode,
        connectionUriPreserved: payload.credentials['connection-uri'] === credential.value
      };
    })()`);
    const modalKeyboard = await window.webContents.executeJavaScript(`(async () => {
      const modal = document.getElementById('databaseProfileModal');
      const opener = document.getElementById('databaseProfileAddButton');
      closeDatabaseProfileModal();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      opener.focus();
      openDatabaseProfileModal();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const initialFocus = document.activeElement?.id;
      opener.focus();
      const backgroundFocusBlocked = document.activeElement?.id === initialFocus;
      const firstFocusable = databaseModalFocusableElements(modal)[0];
      const lastFocusable = databaseModalFocusableElements(modal).at(-1);
      firstFocusable.focus();
      firstFocusable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      const wrappedBackward = document.activeElement === lastFocusable;
      lastFocusable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      const wrappedForward = document.activeElement === firstFocusable;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        initialFocus,
        backgroundFocusBlocked,
        wrappedBackward,
        wrappedForward,
        closed: modal.classList.contains('hidden'),
        ariaHidden: modal.getAttribute('aria-hidden'),
        appShellInertAfterClose: document.querySelector('.app-shell').inert,
        restoredFocus: document.activeElement?.id
      };
    })()`);
    process.stdout.write(`${JSON.stringify({ desktop, tabKeyboard, mobile, form, connectionUriForm, modalKeyboard, imagePaths: [desktopPath, mobilePath, formPath] })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    app.quit();
  }
});
