const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const accessPreloadSource = fs.readFileSync(path.join(__dirname, 'access-preload.js'), 'utf8');

function ipcHandlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} handler must exist`);
  const end = mainSource.indexOf('\nipcMain.handle(', start + marker.length);
  return mainSource.slice(start, end === -1 ? mainSource.length : end);
}

test('constructs DB Access Manager with packaged and staged development path inputs', () => {
  assert.match(mainSource, /new DatabaseAccessCompanionService\(\{/);
  assert.match(mainSource, /resolveDatabaseAccessCompanionExecutablePath\(\{[\s\S]*isPackaged: app\.isPackaged,[\s\S]*resourcesPath: process\.resourcesPath,[\s\S]*appPath: app\.getAppPath\(\)/);
});

test('requires a ready supported profile and resolves a separate runtime connection', () => {
  assert.match(mainSource, /async function requireReadyDatabaseAccessProfile\(context, profileId\)/);
  assert.match(mainSource, /SUPPORTED_ACCESS_DRIVERS\.includes\(profile\.driverId\)/);
  assert.match(mainSource, /profile\.ssl\?\.clientCertificateRequired[\s\S]*DATABASE_ACCESS_CLIENT_CERTIFICATE_UNSUPPORTED/);
  assert.match(mainSource, /getDatabaseConnectionService\(\)\.status\(context\.workspaceId, context\.actorId, id\)/);
  assert.match(mainSource, /status\.state !== 'ready'/);
  assert.match(mainSource, /prepareConnection: async \(\{ workspaceId, actorId, profileId \}\) => \{[\s\S]*const context = Object\.freeze\(\{ workspaceId, actorId \}\)/);
  assert.match(mainSource, /resolveRuntimeConnection\(\{[\s\S]*workspaceId: context\.workspaceId,[\s\S]*profile,[\s\S]*secretStore: getBackupSecretStore\(\),[\s\S]*localResourceResolver:[\s\S]*tunnelProvider: databaseTunnelService/);
  assert.match(mainSource, /cleanupConnection: async \(prepared\) => releaseRuntimeConnection\(prepared\.connection\)/);
});

test('hands off only approved metadata and registers the narrow IPC request', () => {
  assert.match(mainSource, /profileName: profile\.name,[\s\S]*driverId: profile\.driverId,[\s\S]*readOnly: profile\.accessMode === 'read-only',[\s\S]*themeId: readThemePreferenceSync\(\),[\s\S]*connection/);
  assert.match(mainSource, /ipcMain\.handle\('database-manager:access:open', wrapDatabaseManagerIpc/);
  assert.match(mainSource, /requireReadyDatabaseAccessProfile\(context, payload\.profileId\)/);
  assert.match(mainSource, /const companion = getDatabaseAccessCompanionService\(\);[\s\S]*companion\.isAvailable\(\)[\s\S]*companion\.open\(\{ \.\.\.context, profileId: profile\.id \}\)/);
  assert.match(mainSource, /onStateChange: \(\{ workspaceId, profileId, state, reason \}\)[\s\S]*sendDatabaseManagerEvent\(workspaceId, 'access-manager-state'/);
});

test('opens a scoped Electron access window only when the native companion is missing', () => {
  const handler = ipcHandlerSource('database-manager:access:open');
  const initializeAppStart = rendererSource.indexOf('async function initializeApp()');
  const initializeAppSource = rendererSource.slice(initializeAppStart, rendererSource.indexOf('\nfunction createModalSshUser', initializeAppStart));
  assert.match(handler, /if \(companion\.isAvailable\(\)\) \{[\s\S]*return companion\.open/);
  assert.match(handler, /return await openDatabaseAccessFallbackWindow\(context, profile\)/);
  assert.match(mainSource, /async function openDatabaseAccessFallbackWindow\(context, profile\)/);
  assert.match(mainSource, /databaseAccessProfileId: profileId/);
  assert.match(mainSource, /preload: path\.join\(__dirname, 'database-manager', 'access-preload\.js'\)/);
  assert.match(mainSource, /contextIsolation: true,[\s\S]*nodeIntegration: false,[\s\S]*sandbox: true/);
  assert.doesNotMatch(accessPreloadSource, /getSetup:/);
  assert.match(initializeAppSource, /if \(IS_DATABASE_ACCESS_WINDOW\) \{[\s\S]*state\.setup\.complete = true;[\s\S]*state\.setup\.mode = 'database-access';[\s\S]*return;[\s\S]*\}/);
  assert.ok(
    initializeAppSource.indexOf('if (IS_DATABASE_ACCESS_WINDOW)') < initializeAppSource.indexOf('window.deployerx.getSetup()'),
    'the restricted access window must bypass the main-window startup IPC contract'
  );
  assert.match(rendererSource, /IS_DATABASE_ACCESS_WINDOW[\s\S]*DATABASE_ACCESS_WINDOW_PROFILE_ID/);
  assert.match(rendererSource, /views\.includes|view !== 'database'/);
  assert.match(rendererSource, /els\.databaseQueryProfile\.disabled = IS_DATABASE_ACCESS_WINDOW/);
  assert.match(stylesSource, /data-database-access-window="true"[\s\S]*\.app-topbar,[\s\S]*\.sidebar[\s\S]*display: none/);
});

test('disposes companion sessions during initialization failure and application shutdown', () => {
  assert.match(mainSource, /await databaseAccessCompanionService\?\.dispose\(\)\.catch\(\(\) => \{\}\);[\s\S]*databaseAccessCompanionService = null;/);
  assert.match(mainSource, /app\.on\('before-quit',[\s\S]*databaseAccessCompanionService\?\.dispose\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(mainSource, /app\.on\('before-quit',[\s\S]*disposeDatabaseAccessFallbackWindows\(\)/);
});

test('closes stale companion sessions on profile and connection lifecycle changes', () => {
  for (const channel of [
    'database-manager:profiles:update',
    'database-manager:profiles:delete',
    'database-manager:connections:open',
    'database-manager:connections:close'
  ]) {
    const handler = mainSource.slice(mainSource.indexOf(`ipcMain.handle('${channel}'`));
    assert.match(handler.slice(0, 1600), /databaseAccessCompanionService\?\.close\(\{ \.\.\.context, profileId: payload\.id \}\)\.catch\(\(\) => \{\}\)/);
    assert.match(handler.slice(0, 1600), /closeDatabaseAccessFallbackWindow\(context, payload\.id\)/);
  }
});

test('awaits companion disposal before database ownership context transitions', () => {
  assert.match(
    mainSource,
    /async function withDatabaseAccessContextTransition\(action\) \{[\s\S]*await databaseAccessCompanionService\?\.dispose\(\)\.catch\(\(\) => \{\}\);[\s\S]*return await action\(\);[\s\S]*\}/
  );

  for (const channel of [
    'setup:setMode',
    'auth:logout',
    'teams:create',
    'teams:switch',
    'teams:acceptInvite'
  ]) {
    const handler = ipcHandlerSource(channel);
    assert.match(
      handler,
      /return withDatabaseAccessContextTransition\(async \(\) => \{/,
      `${channel} must use the DB Access Manager context transition guard`
    );
  }

  const teamSnapshotStart = mainSource.indexOf('async function teamSnapshot(');
  const teamSnapshotSource = mainSource.slice(teamSnapshotStart, mainSource.indexOf('\nfunction emptyTeamSnapshot', teamSnapshotStart));
  assert.match(
    teamSnapshotSource,
    /if \(activeTeamId !== settings\.activeTeamId\) \{[\s\S]*await withDatabaseAccessContextTransition\(async \(\) => \{[\s\S]*await writeSettings\(/
  );

  const cacheTeamSnapshotStart = mainSource.indexOf('async function cacheTeamSnapshot(');
  const cacheTeamSnapshotSource = mainSource.slice(
    cacheTeamSnapshotStart,
    mainSource.indexOf('\nasync function safeTeamSnapshot', cacheTeamSnapshotStart)
  );
  assert.match(
    cacheTeamSnapshotSource,
    /snapshotContextStillCurrent = String\(latestSettings\.auth\?\.uid[\s\S]*String\(latestSettings\.activeTeamId[\s\S]*\.\.\.\(snapshotContextStillCurrent \? \{/
  );
  assert.doesNotMatch(
    cacheTeamSnapshotSource,
    /await writeSettings\(\{\s*\.\.\.latestSettings,\s*activeTeamId: snapshot\.activeTeamId/
  );

  const finishCloudAuthStart = mainSource.indexOf('async function finishCloudAuth(');
  const finishCloudAuthSource = mainSource.slice(
    finishCloudAuthStart,
    mainSource.indexOf('\nfunction isDatabaseManagerPackagedSmokeMode', finishCloudAuthStart)
  );
  assert.match(finishCloudAuthSource, /return withDatabaseAccessContextTransition\(async \(\) => \{/);
  assert.match(finishCloudAuthSource, /savedWorkspaceBelongsToActor[\s\S]*activeTeamId: '',[\s\S]*activeTeamUid: ''/);

  const deleteTeamHandler = ipcHandlerSource('teams:delete');
  assert.match(
    deleteTeamHandler,
    /return settings\.activeTeamId === teamId[\s\S]*\? withDatabaseAccessContextTransition\(deleteTeam\)[\s\S]*: deleteTeam\(\)/
  );
});

test('keeps the Access button synchronized with companion lifecycle events', () => {
  assert.match(rendererSource, /profile\.ssl\?\.clientCertificateRequired[\s\S]*Client-certificate database profiles are not supported/);
  assert.match(rendererSource, /event\.type === 'access-manager-state'/);
  assert.match(rendererSource, /\['active', 'focused'\]\.includes\(payload\.state\)[\s\S]*accessStates\.set\(payload\.profileId, 'active'\)/);
  assert.match(rendererSource, /payload\.state === 'launching'[\s\S]*accessStates\.set\(payload\.profileId, 'launching'\)/);
  assert.match(rendererSource, /\['closed', 'exited'\]\.includes\(payload\.state\)[\s\S]*accessStates\.delete\(payload\.profileId\)/);
  assert.match(rendererSource, /payload\.state === 'failed'[\s\S]*accessStates\.set\(payload\.profileId, 'failed'\)/);
});
