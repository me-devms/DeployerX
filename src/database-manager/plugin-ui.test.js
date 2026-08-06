const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('renders plugin health, checks the runtime, and builds declarative connection fields responsively', async (context) => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-ui-'));
  context.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(require('electron'), [path.join(__dirname, 'plugin-ui-fixture.js'), outputDirectory], { windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.desktop.healthLabels.filter((label) => label === 'Ready').length, 9);
  assert.deepEqual([...new Set(result.desktop.healthLabels)], ['Ready', 'Crashed', 'Integrity failed', 'Signature required', 'Runtime unavailable']);
  assert.equal(result.desktop.unavailableReason, true);
  assert.equal(result.desktop.runtimeRequirement, true);
  assert.equal(result.desktop.runtimeUnavailableLabel, true);
  assert.equal(result.desktop.runtimeRecheckButtons, 1);
  assert.equal(result.desktop.crashEvidence, true);
  assert.equal(result.desktop.integrityWarning, true);
  assert.equal(result.desktop.signatureWarning, true);
  assert.equal(result.desktop.reinstallButtons, 1);
  assert.equal(result.desktop.signatureRequiredButtons, 1);
  assert.equal(result.desktop.checkButtons, 2);
  assert.equal(result.desktop.checkCalls, 1);
  assert.equal(result.desktop.checkedStatus, 'Ready');
  assert.equal(result.desktop.requirementCalls, 1);
  assert.equal(result.desktop.runtimeRecovered, true);
  assert.deepEqual(result.desktop.accessibilityTabs, [
    { name: 'Connections', selected: false },
    { name: 'Query', selected: false },
    { name: 'Notebooks', selected: false },
    { name: 'Tasks', selected: false },
    { name: 'Logs', selected: false }
  ]);
  assert.equal(result.desktop.unnamedInteractiveNodes, 0);
  assert.deepEqual(result.tabKeyboard.initialTabIndexes, [
    ['databaseConnectionsTab', 0],
    ['databaseQueryTab', -1],
    ['databaseNotebooksTab', -1],
    ['databaseTasksTab', -1],
    ['databaseLogsTab', -1]
  ]);
  assert.deepEqual(result.tabKeyboard.wrappedForward, { selected: 'databaseConnectionsTab', focused: 'databaseConnectionsTab' });
  assert.deepEqual(result.tabKeyboard.wrappedBackward, { selected: 'databaseLogsTab', focused: 'databaseLogsTab' });
  assert.equal(result.mobile.bodyOverflowX, false);
  assert.equal(result.mobile.rowsInsideViewport, true);
  assert.equal(result.mobile.rowsOverlap, false);
  assert.equal(result.form.modalFits, true);
  assert.equal(result.form.credentialFields, 1);
  assert.equal(result.form.settingFields, 2);
  assert.equal(result.form.networkVisible, true);
  assert.equal(result.form.usernameHidden, true);
  assert.deepEqual(result.form.chooser, { builtinsVisible: true, installedPluginsVisible: true, disabledDriverHidden: true, allStatusesInstalled: true });
  assert.equal(result.form.selectedDriver, 'vendor.elasticsearch');
  assert.equal(result.form.configureVisible, true);
  assert.equal(result.form.appShellInert, true);
  assert.deepEqual(result.form.dialogNames, ['Add database']);
  assert.equal(result.form.backgroundDatabaseNavigationHidden, true);
  assert.equal(result.form.unnamedInteractiveNodes, 0);
  assert.deepEqual(result.connectionUriForm, {
    credentialFields: 1,
    networkHidden: true,
    databaseHidden: true,
    schemaHidden: true,
    sslHidden: true,
    linkedServerDisabled: true,
    endpoint: { kind: 'none' },
    database: null,
    defaultSchema: null,
    sslMode: 'disabled',
    connectionUriPreserved: true
  });
  assert.deepEqual(result.builtinLayouts, {
    mysql: {
      tabs: ['general', 'databases', 'ssl', 'ssh', 'kubernetes', 'advanced', 'appearance'],
      networkVisible: true,
      databaseFieldsVisible: true,
      databaseFieldsParent: 'databaseProfileDatabasesPanelFields',
      schemaVisible: false,
      localResourceVisible: false,
      connectionStringVisible: true,
      credentialsVisible: true,
      username: 'root',
      port: '3306'
    },
    postgresql: {
      tabs: ['general', 'ssl', 'ssh', 'kubernetes', 'advanced', 'appearance'],
      networkVisible: true,
      databaseFieldsVisible: true,
      databaseFieldsParent: 'databaseProfileGeneralDatabaseFields',
      schemaVisible: true,
      localResourceVisible: false,
      connectionStringVisible: true,
      credentialsVisible: true,
      username: 'postgres',
      port: '5432'
    },
    sqlite: {
      tabs: ['general', 'advanced', 'appearance'],
      networkVisible: false,
      databaseFieldsVisible: false,
      databaseFieldsParent: 'databaseProfileGeneralDatabaseFields',
      schemaVisible: false,
      localResourceVisible: true,
      connectionStringVisible: false,
      credentialsVisible: false,
      username: '',
      port: ''
    }
  });
  assert.deepEqual(result.modalKeyboard, {
    initialFocus: 'databaseProfileCatalogueSearch',
    backgroundFocusBlocked: true,
    wrappedBackward: true,
    wrappedForward: true,
    closed: true,
    ariaHidden: 'true',
    appShellInertAfterClose: false,
    restoredFocus: 'databaseProfileAddButton'
  });
  for (const imagePath of result.imagePaths) {
    const bytes = await fs.readFile(imagePath);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(bytes.length > 10000);
  }
});
