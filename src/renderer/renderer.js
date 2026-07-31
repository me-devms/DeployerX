const blankProject = () => ({
  id: '',
  name: '',
  group: '',
  serverType: 'ubuntu',
  ssh: {
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    timeout: 20000
  },
  ftp: {
    host: '',
    port: '',
    username: '',
    authType: '',
    password: '',
    privateKey: '',
    passphrase: ''
  },
  commands: [],
  variables: {},
  uptimeMonitors: []
});

function blankUptimeMonitor() {
  return {
    id: '',
    name: '',
    type: 'http',
    enabled: true,
    intervalSec: 300,
    timeoutMs: 10000,
    latencyBudgetMs: 0,
    http: {
      method: 'GET',
      url: '',
      headers: {},
      expectedStatusCodes: [200],
      bodyMustContain: [],
      bodyMustNotContain: [],
      headerAssertions: []
    },
    tcp: {
      host: '',
      port: 80
    }
  };
}

function defaultUptimeState() {
  return {
    projectId: '',
    projectName: '',
    summary: { total: 0, up: 0, degraded: 0, down: 0, paused: 0, idle: 0 },
    service: {
      active: false,
      mode: 'window',
      syncWarning: '',
      autostartEnabled: false,
      startedAt: '',
      lastHeartbeatAt: '',
      lastConfigRefreshAt: '',
      pid: 0
    },
    monitors: []
  };
}

function defaultUptimeRuntimeMonitor() {
  return {
    status: 'idle',
    consecutiveFailures: 0,
    lastCheckAt: '',
    lastSuccessAt: '',
    lastFailureAt: '',
    lastLatencyMs: null,
    lastError: '',
    nextCheckAt: '',
    activeIncidentId: '',
    incidentOpenSince: '',
    syncWarning: '',
    pausedAt: '',
    summary: '',
    checkCount: 0
  };
}

function defaultAppUpdateState() {
  return {
    enabled: false,
    status: 'idle',
    currentVersion: '0.1.0',
    availableVersion: '',
    downloadedVersion: '',
    releaseName: '',
    releaseDate: '',
    downloadPercent: 0,
    lastCheckedAt: '',
    releasePageUrl: '',
    message: '',
    error: '',
    canCheck: false,
    canInstall: false
  };
}

function normalizeAppUpdateState(update = {}) {
  return {
    ...defaultAppUpdateState(),
    ...(update && typeof update === 'object' ? update : {}),
    downloadPercent: Number(update?.downloadPercent || 0)
  };
}

const state = {
  app: {
    version: '0.1.0',
    updates: defaultAppUpdateState()
  },
  setup: {
    complete: false,
    mode: '',
    firebase: null
  },
  auth: {
    session: null,
    authMode: 'login'
  },
  currentView: 'dashboard',
  settingsTab: 'profile',
  backupHistory: [],
  teams: {
    teams: [],
    activeTeamId: '',
    activeTeam: null,
    members: [],
    teamInvites: [],
    invites: [],
    unlocked: false,
    cloudError: ''
  },
  projects: [],
  templates: [],
  activeProject: null,
  activeProjectTab: 'ssh',
  uptime: {
    project: defaultUptimeState(),
    selectedProjectId: '',
    selectedMonitorId: '',
    selectedMonitorHistory: [],
    selectedMonitorIncidents: [],
    modalMode: 'create',
    modalMonitorId: ''
  },
  activeRunId: null,
  terminalSessions: {},
  terminalSessionProjectIds: {},
  ftpSessions: {},
  activeTerminalSessionId: null,
  terminalConnected: false,
  ftpSessionId: null,
  ftpConnected: false,
  ftpLocalCurrentPath: '',
  ftpLocalParentPath: '',
  ftpLocalLoaded: false,
  ftpLocalEntries: [],
  ftpLocalSelectedPath: '',
  ftpLocalFilter: '',
  ftpLocalBackStack: [],
  ftpLocalForwardStack: [],
  ftpRemoteFilter: '',
  ftpCurrentPath: '.',
  ftpParentPath: '.',
  ftpEntries: [],
  ftpSelectedPath: '',
  ftpBackStack: [],
  ftpForwardStack: [],
  pendingTerminalInput: '',
  scriptCommandQueue: [],
  scriptRunnerActive: false,
  scriptWaitingForPrompt: false,
  scriptPromptTimer: null,
  scriptReadyMarker: '',
  scriptPromptMarkerActive: false,
  scriptTerminalSessionId: '',
  terminalOutputBuffer: '',
  terminalRawBuffer: '',
  modalMode: 'create',
  modalDraft: blankProject(),
  activeTemplateId: '',
  activeTemplateCategory: 'All',
  duplicateTemplateDraft: null,
  variablePrompt: null,
  exportPicker: {
    type: '',
    selectedIds: new Set()
  }
};

const terminal = new Terminal({
  cols: 120,
  rows: 34,
  cursorBlink: true,
  convertEol: false,
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.35,
  scrollback: 5000,
  theme: {
    background: '#09090b',
    foreground: '#d4d4d8',
    cursor: '#22c55e',
    selectionBackground: '#334155',
    black: '#18181b',
    blue: '#60a5fa',
    cyan: '#22d3ee',
    green: '#22c55e',
    magenta: '#c084fc',
    red: '#f87171',
    white: '#e5e7eb',
    yellow: '#facc15'
  }
});
const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);

const builtInVariableNames = new Set(['project_name', 'server_group', 'server_type', 'ssh_host', 'ssh_port', 'ssh_username']);
const templateCategories = ['Server', 'Laravel', 'Node.js', 'Database', 'Docker', 'Maintenance', 'Security', 'Hosting', 'Web Server', 'Cache', 'Control Panel', 'PaaS'];
const terminalReplayLimit = 160000;

function blankTerminalUploadState() {
  return {
    active: false,
    fileName: '',
    remotePath: '',
    transferredBytes: 0,
    totalBytes: 0,
    percent: 0,
    cancelRequested: false
  };
}

function blankTerminalSession(projectId = '') {
  return {
    projectId,
    sessionId: null,
    connected: false,
    status: 'Not connected',
    output: 'Ready.\r\n',
    pendingInput: '',
    outputBuffer: '',
    rawBuffer: '',
    commandBuffer: '',
    pendingDirectoryCandidate: '',
    currentDirectory: '',
    homeDirectory: '',
    previousDirectory: '',
    awaitingPwd: false,
    upload: blankTerminalUploadState()
  };
}

function blankFtpSession(projectId = '') {
  return {
    projectId,
    sessionId: null,
    connected: false,
    localCurrentPath: '',
    localParentPath: '',
    localLoaded: false,
    localEntries: [],
    localSelectedPath: '',
    localBackStack: [],
    localForwardStack: [],
    localFilter: '',
    currentPath: '.',
    parentPath: '.',
    entries: [],
    selectedPath: '',
    backStack: [],
    forwardStack: [],
    remoteFilter: ''
  };
}

function getTerminalSession(projectId = state.activeProject?.id, create = false) {
  if (!projectId) return null;
  if (!state.terminalSessions[projectId] && create) state.terminalSessions[projectId] = blankTerminalSession(projectId);
  return state.terminalSessions[projectId] || null;
}

function getTerminalSessionById(sessionId) {
  const projectId = state.terminalSessionProjectIds[sessionId];
  return projectId ? getTerminalSession(projectId) : null;
}

function getFtpSession(projectId = state.activeProject?.id, create = false) {
  if (!projectId) return null;
  if (!state.ftpSessions[projectId] && create) state.ftpSessions[projectId] = blankFtpSession(projectId);
  return state.ftpSessions[projectId] || null;
}

function projectConnectionState(projectId) {
  const terminalSession = getTerminalSession(projectId);
  const ftpSession = getFtpSession(projectId);
  return {
    ssh: Boolean(terminalSession?.sessionId && terminalSession.connected),
    ftp: Boolean(ftpSession?.sessionId && ftpSession.connected)
  };
}

function isVisibleTerminalSession(session) {
  return Boolean(session?.projectId && state.activeProject?.id === session.projectId);
}

function normalizeRemoteShellPath(remotePath = '.') {
  const source = String(remotePath || '.').trim().replace(/\\/g, '/');
  if (!source) return '.';
  const absolute = source.startsWith('/');
  const stack = [];
  for (const segment of source.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(segment);
  }

  if (absolute) return stack.length ? `/${stack.join('/')}` : '/';
  return stack.length ? stack.join('/') : '.';
}

function joinRemoteShellPath(parentPath = '.', childPath = '') {
  const child = String(childPath || '').trim().replace(/\\/g, '/');
  if (!child) return normalizeRemoteShellPath(parentPath);
  if (child.startsWith('/')) return normalizeRemoteShellPath(child);

  const base = normalizeRemoteShellPath(parentPath);
  if (base === '.' || !base) return normalizeRemoteShellPath(child);
  if (base === '/') return normalizeRemoteShellPath(`/${child}`);
  return normalizeRemoteShellPath(`${base}/${child}`);
}

function remoteShellBaseName(remotePath = '') {
  const normalized = normalizeRemoteShellPath(remotePath);
  if (!normalized || normalized === '.' || normalized === '/') return '';
  return normalized.split('/').filter(Boolean).pop() || '';
}

function stripShellQuotes(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function formatByteCount(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function setTerminalUploadState(
  session,
  patch = { active: false, fileName: '', remotePath: '', transferredBytes: 0, totalBytes: 0, percent: 0 }
) {
  if (!session) return;
  const current = session.upload || blankTerminalUploadState();
  session.upload = {
    ...current,
    ...patch
  };
  if (isVisibleTerminalSession(session)) renderSshUploadPanel(session);
}

function setTerminalSessionDirectory(session, directory, { setHome = false } = {}) {
  if (!session) return;
  const normalized = normalizeRemoteShellPath(directory);
  if (!normalized) return;
  const previous = String(session.currentDirectory || '');
  if (previous && previous !== normalized) session.previousDirectory = previous;
  session.currentDirectory = normalized;
  if (setHome || !session.homeDirectory) session.homeDirectory = normalized;
  if (isVisibleTerminalSession(session)) renderSshUploadPanel(session);
}

function renderSshUploadPanel(session = getTerminalSession()) {
  if (!els.sshUploadPanel) return;
  const connected = Boolean(session?.sessionId && session?.connected);
  els.sshUploadPanel.classList.toggle('hidden', !connected);
  if (!connected) return;

  const waitingForPathUpdate = Boolean(session?.pendingDirectoryCandidate);
  const currentPath = String(session?.currentDirectory || session?.homeDirectory || '').trim();
  els.sshUploadPath.textContent = waitingForPathUpdate
    ? 'Current path: updating...'
    : currentPath
      ? `Current path: ${currentPath}`
      : 'Current path: waiting for shell...';

  const upload = session?.upload || blankTerminalUploadState();
  const uploadInFlight = Boolean(upload.active || pendingActions.has('terminal:upload'));
  const canUpload = Boolean(connected && currentPath && !waitingForPathUpdate && !uploadInFlight);
  els.sshUploadButton.disabled = !canUpload;

  els.sshUploadProgress.classList.toggle('hidden', !upload.active);
  els.sshUploadCancelButton.classList.toggle('hidden', !upload.active);
  els.sshUploadCancelButton.disabled = Boolean(!upload.active || upload.cancelRequested);
  els.sshUploadCancelButton.textContent = upload.cancelRequested ? 'Cancelling...' : 'Cancel upload';
  if (!upload.active) return;

  const percent = Math.max(0, Math.min(100, Number(upload.percent || 0)));
  const transferred = Number(upload.transferredBytes || 0);
  const total = Number(upload.totalBytes || 0);
  els.sshUploadProgressFile.textContent = upload.fileName ? `Uploading ${upload.fileName}` : 'Uploading file';
  els.sshUploadProgressPercent.textContent = `${percent}%`;
  els.sshUploadProgressBar.style.width = `${percent}%`;
  els.sshUploadProgressDetail.textContent = `${formatByteCount(transferred)} of ${formatByteCount(total)}${
    upload.remotePath ? ` to ${upload.remotePath}` : ''
  }`;
}

function resolveShellCdTarget(rawTarget, session) {
  const source = String(rawTarget || '').trim().replace(/^--\s+/, '');
  const currentPath = String(session?.pendingDirectoryCandidate || session?.currentDirectory || session?.homeDirectory || '').trim();
  const homePath = String(session?.homeDirectory || '').trim();
  const previousPath = String(session?.previousDirectory || '').trim();

  if (!source || source === '~') return homePath || currentPath;
  if (source === '-') return previousPath;
  if (source.startsWith('/')) return normalizeRemoteShellPath(source);
  if (source === '~/') return homePath || currentPath;
  if (source.startsWith('~/')) {
    const relative = source.slice(2);
    return joinRemoteShellPath(homePath || currentPath || '.', relative);
  }
  if (source.startsWith('~')) return '';
  if (!currentPath) return '';
  return joinRemoteShellPath(currentPath, source);
}

function trackShellCommand(command, session) {
  if (!session) return;
  const raw = String(command || '').trim();
  if (!raw) return;

  session.awaitingPwd = /^pwd(?:\s|$)/.test(raw);
  const cdMatch = raw.match(/^cd(?:\s+(.*))?$/);
  if (!cdMatch) {
    renderSshUploadPanel(session);
    return;
  }

  const rawTarget = stripShellQuotes(cdMatch[1] || '');
  const nextDirectory = resolveShellCdTarget(rawTarget, session);
  if (nextDirectory) session.pendingDirectoryCandidate = normalizeRemoteShellPath(nextDirectory);
  renderSshUploadPanel(session);
}

function trackTerminalInputChunk(input, sessionId = state.activeTerminalSessionId) {
  const terminalSession = getTerminalSessionById(sessionId) || getTerminalSession();
  if (!terminalSession) return;

  const chunk = String(input || '');
  for (const char of chunk) {
    if (char === '\u0003') {
      terminalSession.commandBuffer = '';
      terminalSession.pendingDirectoryCandidate = '';
      terminalSession.awaitingPwd = false;
      continue;
    }
    if (char === '\u0015') {
      terminalSession.commandBuffer = '';
      continue;
    }
    if (char === '\u007f' || char === '\b') {
      terminalSession.commandBuffer = String(terminalSession.commandBuffer || '').slice(0, -1);
      continue;
    }
    if (char === '\r' || char === '\n') {
      const command = String(terminalSession.commandBuffer || '');
      terminalSession.commandBuffer = '';
      trackShellCommand(command, terminalSession);
      continue;
    }
    if (char >= ' ') terminalSession.commandBuffer = `${terminalSession.commandBuffer || ''}${char}`;
  }
}

function promptPathTokenFromLine(line = '') {
  const prompt = String(line || '').trimEnd();
  if (!prompt) return '';
  let match = prompt.match(/^\[[^\]\r\n]+?\s+([^\]\r\n]+)\]\s*[#$]\s*$/);
  if (match?.[1]) return match[1].trim();
  match = prompt.match(/^[A-Za-z0-9_.-]+@[\w.-]+:(~?[^\r\n#$]*)[#$]\s*$/);
  if (match?.[1]) return match[1].trim();
  match = prompt.match(/^[A-Za-z0-9_.-]+@[\w.-]+\s+(~?[^\r\n#$]*)[#$]\s*$/);
  if (match?.[1]) return match[1].trim();
  return '';
}

function reconcilePromptPath(session, promptToken = '') {
  if (!session) return;
  const token = String(promptToken || '').trim();
  if (!token) return;

  if (token.startsWith('/') || token.startsWith('~/') || token === '~') {
    const resolved = token === '~' ? session.homeDirectory : resolveShellCdTarget(token, session);
    if (resolved) setTerminalSessionDirectory(session, resolved);
    session.pendingDirectoryCandidate = '';
    return;
  }

  const pendingDirectory = String(session.pendingDirectoryCandidate || '');
  if (pendingDirectory && remoteShellBaseName(pendingDirectory) === token) {
    setTerminalSessionDirectory(session, pendingDirectory);
    session.pendingDirectoryCandidate = '';
    return;
  }

  const currentDirectory = String(session.currentDirectory || '');
  if (currentDirectory && remoteShellBaseName(currentDirectory) === token) {
    session.pendingDirectoryCandidate = '';
    renderSshUploadPanel(session);
    return;
  }

  if (pendingDirectory) {
    session.pendingDirectoryCandidate = '';
    renderSshUploadPanel(session);
  }
}

function syncTerminalDirectoryFromOutput(visibleText, session) {
  if (!session) return;
  const lines = String(visibleText || '')
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter(Boolean);

  for (const line of lines) {
    if (session.awaitingPwd && line.startsWith('/')) {
      setTerminalSessionDirectory(session, line);
      session.awaitingPwd = false;
      session.pendingDirectoryCandidate = '';
      continue;
    }

    const promptToken = promptPathTokenFromLine(line);
    if (promptToken) reconcilePromptPath(session, promptToken);
  }
}

async function ensureTerminalHomeDirectory(sessionId = state.activeTerminalSessionId) {
  const terminalSession = getTerminalSessionById(sessionId) || getTerminalSession();
  if (!terminalSession?.sessionId || terminalSession.homeDirectory) return terminalSession?.homeDirectory || '';
  const response = await window.deployerx.getTerminalHomeDirectory(terminalSession.sessionId);
  const homeDirectory = normalizeRemoteShellPath(response?.path || '');
  if (!homeDirectory) return '';
  setTerminalSessionDirectory(terminalSession, homeDirectory, { setHome: true });
  return homeDirectory;
}

function applyTerminalSessionToState(projectId) {
  const terminalSession = getTerminalSession(projectId);
  state.activeTerminalSessionId = terminalSession?.sessionId || null;
  state.terminalConnected = Boolean(terminalSession?.connected);
  state.pendingTerminalInput = terminalSession?.pendingInput || '';
  state.terminalOutputBuffer = terminalSession?.outputBuffer || '';
  state.terminalRawBuffer = terminalSession?.rawBuffer || '';
}

function renderVisibleTerminalSession(session = getTerminalSession()) {
  terminal.reset();
  terminal.clear();
  terminal.write(session?.output || 'Ready.\r\n');
}

function removeTerminalSessionRegistration(sessionId) {
  if (!sessionId) return;
  delete state.terminalSessionProjectIds[sessionId];
}

async function disconnectProjectConnections(projectId) {
  const terminalSession = getTerminalSession(projectId);
  if (terminalSession?.sessionId) {
    try {
      await window.deployerx.stopTerminal(terminalSession.sessionId);
    } catch {}
    removeTerminalSessionRegistration(terminalSession.sessionId);
  }

  const ftpSession = getFtpSession(projectId);
  if (ftpSession?.sessionId) {
    try {
      await window.deployerx.ftpDisconnect(ftpSession.sessionId);
    } catch {}
  }

  if (projectId) {
    state.terminalSessions[projectId] = blankTerminalSession(projectId);
    state.ftpSessions[projectId] = blankFtpSession(projectId);
  }

  if (state.activeProject?.id === projectId) {
    applyTerminalSessionToState(projectId);
    applyFtpSessionToState(projectId);
  }
}

async function disconnectAllProjectConnections() {
  const projectIds = [...new Set([...Object.keys(state.terminalSessions), ...Object.keys(state.ftpSessions)])];
  for (const projectId of projectIds) {
    await disconnectProjectConnections(projectId);
  }
}

const els = {
  startupLoader: document.getElementById('startupLoader'),
  startupAppVersion: document.getElementById('startupAppVersion'),
  appShell: document.querySelector('.app-shell'),
  setupModal: document.getElementById('setupModal'),
  authPanel: document.getElementById('authPanel'),
  firebaseConfigWarning: document.getElementById('firebaseConfigWarning'),
  emailVerificationNotice: document.getElementById('emailVerificationNotice'),
  emailVerificationCopy: document.getElementById('emailVerificationCopy'),
  resendVerificationButton: document.getElementById('resendVerificationButton'),
  verificationLogoutButton: document.getElementById('verificationLogoutButton'),
  loginTabButton: document.getElementById('loginTabButton'),
  registerTabButton: document.getElementById('registerTabButton'),
  authForm: document.getElementById('authForm'),
  signupNameFields: document.getElementById('signupNameFields'),
  authFirstName: document.getElementById('authFirstName'),
  authLastName: document.getElementById('authLastName'),
  authEmail: document.getElementById('authEmail'),
  authPassword: document.getElementById('authPassword'),
  confirmPasswordField: document.getElementById('confirmPasswordField'),
  authConfirmPassword: document.getElementById('authConfirmPassword'),
  authSubmitButton: document.getElementById('authSubmitButton'),
  googleLoginButton: document.getElementById('googleLoginButton'),
  forgotPasswordButton: document.getElementById('forgotPasswordButton'),
  continueWithoutLoginButton: document.getElementById('continueWithoutLoginButton'),
  authFooterText: document.getElementById('authFooterText'),
  authFooterSwitchButton: document.getElementById('authFooterSwitchButton'),
  workspaceSetupPanel: document.getElementById('workspaceSetupPanel'),
  workspaceSetupCopy: document.getElementById('workspaceSetupCopy'),
  workspaceSetupSelect: document.getElementById('workspaceSetupSelect'),
  workspaceCreateForm: document.getElementById('workspaceCreateForm'),
  workspaceCreateName: document.getElementById('workspaceCreateName'),
  workspaceCreateButton: document.getElementById('workspaceCreateButton'),
  workspaceContinueButton: document.getElementById('workspaceContinueButton'),
  workspaceLogoutButton: document.getElementById('workspaceLogoutButton'),
  dashboardView: document.getElementById('dashboardView'),
  uptimeView: document.getElementById('uptimeView'),
  serversView: document.getElementById('serversView'),
  projectView: document.getElementById('projectView'),
  templateView: document.getElementById('templateView'),
  teamView: document.getElementById('teamView'),
  projectGrid: document.getElementById('projectGrid'),
  projectList: document.getElementById('projectList'),
  dashboardButton: document.getElementById('dashboardButton'),
  uptimeButton: document.getElementById('uptimeButton'),
  serversButton: document.getElementById('serversButton'),
  templatesButton: document.getElementById('templatesButton'),
  goOnlineButton: document.getElementById('goOnlineButton'),
  teamButton: document.getElementById('teamButton'),
  sidebarWorkspaceName: document.getElementById('sidebarWorkspaceName'),
  sidebarWorkspaceMeta: document.getElementById('sidebarWorkspaceMeta'),
  sidebarServerCount: document.getElementById('sidebarServerCount'),
  dashboardImportAccountButton: document.getElementById('dashboardImportAccountButton'),
  dashboardExportAccountButton: document.getElementById('dashboardExportAccountButton'),
  dashboardImportProjectsButton: document.getElementById('dashboardImportProjectsButton'),
  dashboardExportProjectsButton: document.getElementById('dashboardExportProjectsButton'),
  dashboardTemplatesButton: document.getElementById('dashboardTemplatesButton'),
  dashboardServersButton: document.getElementById('dashboardServersButton'),
  dashboardCreateButton: document.getElementById('dashboardCreateButton'),
  dashboardStatsGrid: document.getElementById('dashboardStatsGrid'),
  dashboardHealthSummary: document.getElementById('dashboardHealthSummary'),
  dashboardGroupSummary: document.getElementById('dashboardGroupSummary'),
  dashboardServerSections: document.getElementById('dashboardServerSections'),
  backToDashboardButton: document.getElementById('backToDashboardButton'),
  backFromTemplatesButton: document.getElementById('backFromTemplatesButton'),
  activeProjectName: document.getElementById('activeProjectName'),
  projectSshTab: document.getElementById('projectSshTab'),
  projectFtpTab: document.getElementById('projectFtpTab'),
  sshWorkspace: document.getElementById('sshWorkspace'),
  ftpWorkspace: document.getElementById('ftpWorkspace'),
  uptimeWorkspace: document.getElementById('uptimeWorkspace'),
  uptimeProjectSelect: document.getElementById('uptimeProjectSelect'),
  uptimeServiceStatus: document.getElementById('uptimeServiceStatus'),
  uptimeServiceMeta: document.getElementById('uptimeServiceMeta'),
  uptimeHealthyCount: document.getElementById('uptimeHealthyCount'),
  uptimeAttentionCount: document.getElementById('uptimeAttentionCount'),
  uptimePausedCount: document.getElementById('uptimePausedCount'),
  uptimeMonitorListMeta: document.getElementById('uptimeMonitorListMeta'),
  uptimeMonitorList: document.getElementById('uptimeMonitorList'),
  uptimeAddMonitorButton: document.getElementById('uptimeAddMonitorButton'),
  uptimeRunAllButton: document.getElementById('uptimeRunAllButton'),
  uptimeEmptyState: document.getElementById('uptimeEmptyState'),
  uptimeDetailContent: document.getElementById('uptimeDetailContent'),
  uptimeSelectedMonitorStatus: document.getElementById('uptimeSelectedMonitorStatus'),
  uptimeSelectedMonitorName: document.getElementById('uptimeSelectedMonitorName'),
  uptimeSelectedMonitorMeta: document.getElementById('uptimeSelectedMonitorMeta'),
  uptimeOverviewList: document.getElementById('uptimeOverviewList'),
  uptimeConfigList: document.getElementById('uptimeConfigList'),
  uptimeIncidentList: document.getElementById('uptimeIncidentList'),
  uptimeHistoryList: document.getElementById('uptimeHistoryList'),
  uptimeRunMonitorButton: document.getElementById('uptimeRunMonitorButton'),
  uptimeToggleMonitorButton: document.getElementById('uptimeToggleMonitorButton'),
  uptimeEditMonitorButton: document.getElementById('uptimeEditMonitorButton'),
  uptimeDeleteMonitorButton: document.getElementById('uptimeDeleteMonitorButton'),
  ftpLocalStatus: document.getElementById('ftpLocalStatus'),
  ftpLocalFilter: document.getElementById('ftpLocalFilter'),
  ftpLocalPathInput: document.getElementById('ftpLocalPathInput'),
  ftpLocalPathPickerButton: document.getElementById('ftpLocalPathPickerButton'),
  ftpLocalBackButton: document.getElementById('ftpLocalBackButton'),
  ftpLocalForwardButton: document.getElementById('ftpLocalForwardButton'),
  ftpLocalFileList: document.getElementById('ftpLocalFileList'),
  ftpStatus: document.getElementById('ftpStatus'),
  ftpRemoteFilter: document.getElementById('ftpRemoteFilter'),
  connectFtpButton: document.getElementById('connectFtpButton'),
  disconnectFtpButton: document.getElementById('disconnectFtpButton'),
  ftpPathInput: document.getElementById('ftpPathInput'),
  ftpBackButton: document.getElementById('ftpBackButton'),
  ftpForwardButton: document.getElementById('ftpForwardButton'),
  ftpRemoteBrowser: document.getElementById('ftpRemoteBrowser'),
  ftpFileList: document.getElementById('ftpFileList'),
  fileActivity: document.getElementById('fileActivity'),
  ftpContextMenu: document.getElementById('ftpContextMenu'),
  terminalProjectLabel: document.getElementById('terminalProjectLabel'),
  terminalStatus: document.getElementById('terminalStatus'),
  detailsSummary: document.getElementById('detailsSummary'),
  commands: document.getElementById('commands'),
  projectTemplateSelect: document.getElementById('projectTemplateSelect'),
  runProjectButton: document.getElementById('runProjectButton'),
  saveCommandsButton: document.getElementById('saveCommandsButton'),
  editProjectButton: document.getElementById('editProjectButton'),
  deleteProjectButton: document.getElementById('deleteProjectButton'),
  emergencyStopButton: document.getElementById('emergencyStopButton'),
  connectTerminalButton: document.getElementById('connectTerminalButton'),
  terminalConnectOverlay: document.getElementById('terminalConnectOverlay'),
  disconnectTerminalButton: document.getElementById('disconnectTerminalButton'),
  terminal: document.getElementById('terminal'),
  projectModal: document.getElementById('projectModal'),
  projectModalForm: document.getElementById('projectModalForm'),
  projectModalTitle: document.getElementById('projectModalTitle'),
  projectModalSubtitle: document.getElementById('projectModalSubtitle'),
  projectModalCloseButton: document.getElementById('projectModalCloseButton'),
  projectModalCancelButton: document.getElementById('projectModalCancelButton'),
  projectModalSaveButton: document.getElementById('projectModalSaveButton'),
  uptimeMonitorModal: document.getElementById('uptimeMonitorModal'),
  uptimeMonitorForm: document.getElementById('uptimeMonitorForm'),
  uptimeMonitorModalTitle: document.getElementById('uptimeMonitorModalTitle'),
  uptimeMonitorModalSubtitle: document.getElementById('uptimeMonitorModalSubtitle'),
  uptimeMonitorCloseButton: document.getElementById('uptimeMonitorCloseButton'),
  uptimeMonitorCancelButton: document.getElementById('uptimeMonitorCancelButton'),
  uptimeMonitorSaveButton: document.getElementById('uptimeMonitorSaveButton'),
  uptimeMonitorName: document.getElementById('uptimeMonitorName'),
  uptimeMonitorType: document.getElementById('uptimeMonitorType'),
  uptimeMonitorEnabled: document.getElementById('uptimeMonitorEnabled'),
  uptimeMonitorInterval: document.getElementById('uptimeMonitorInterval'),
  uptimeMonitorTimeout: document.getElementById('uptimeMonitorTimeout'),
  uptimeMonitorLatencyBudget: document.getElementById('uptimeMonitorLatencyBudget'),
  uptimeHttpFields: document.getElementById('uptimeHttpFields'),
  uptimeHttpUrl: document.getElementById('uptimeHttpUrl'),
  uptimeHttpMethod: document.getElementById('uptimeHttpMethod'),
  uptimeHttpStatusCodes: document.getElementById('uptimeHttpStatusCodes'),
  uptimeHttpHeaders: document.getElementById('uptimeHttpHeaders'),
  uptimeHttpHeaderAssertions: document.getElementById('uptimeHttpHeaderAssertions'),
  uptimeHttpBodyMustContain: document.getElementById('uptimeHttpBodyMustContain'),
  uptimeHttpBodyMustNotContain: document.getElementById('uptimeHttpBodyMustNotContain'),
  uptimeTcpFields: document.getElementById('uptimeTcpFields'),
  uptimeTcpHost: document.getElementById('uptimeTcpHost'),
  uptimeTcpPort: document.getElementById('uptimeTcpPort'),
  modalProjectName: document.getElementById('modalProjectName'),
  modalProjectGroup: document.getElementById('modalProjectGroup'),
  projectGroupOptions: document.getElementById('projectGroupOptions'),
  modalServerType: document.getElementById('modalServerType'),
  modalTemplateSelect: document.getElementById('modalTemplateSelect'),
  modalVariablesList: document.getElementById('modalVariablesList'),
  modalAddVariableButton: document.getElementById('modalAddVariableButton'),
  modalSshHost: document.getElementById('modalSshHost'),
  modalSshPort: document.getElementById('modalSshPort'),
  modalSshUsername: document.getElementById('modalSshUsername'),
  modalAuthType: document.getElementById('modalAuthType'),
  modalSshPassword: document.getElementById('modalSshPassword'),
  modalPrivateKey: document.getElementById('modalPrivateKey'),
  modalKeyPassphrase: document.getElementById('modalKeyPassphrase'),
  modalPasswordField: document.getElementById('modalPasswordField'),
  modalKeyFields: document.getElementById('modalKeyFields'),
  modalSelectKeyButton: document.getElementById('modalSelectKeyButton'),
  modalFtpHost: document.getElementById('modalFtpHost'),
  modalFtpPort: document.getElementById('modalFtpPort'),
  modalFtpUsername: document.getElementById('modalFtpUsername'),
  modalFtpAuthType: document.getElementById('modalFtpAuthType'),
  modalFtpPassword: document.getElementById('modalFtpPassword'),
  modalFtpPrivateKey: document.getElementById('modalFtpPrivateKey'),
  modalFtpKeyPassphrase: document.getElementById('modalFtpKeyPassphrase'),
  modalFtpPasswordField: document.getElementById('modalFtpPasswordField'),
  modalFtpKeyFields: document.getElementById('modalFtpKeyFields'),
  templatePageForm: document.getElementById('templatePageForm'),
  templatePageCancelButton: document.getElementById('templatePageCancelButton'),
  templatePageSaveButton: document.getElementById('templatePageSaveButton'),
  templateCategoryChips: document.getElementById('templateCategoryChips'),
  importTemplatesButton: document.getElementById('importTemplatesButton'),
  exportTemplatesButton: document.getElementById('exportTemplatesButton'),
  newTemplateButton: document.getElementById('newTemplateButton'),
  deleteTemplateButton: document.getElementById('deleteTemplateButton'),
  duplicateTemplateButton: document.getElementById('duplicateTemplateButton'),
  templateSearch: document.getElementById('templateSearch'),
  templateList: document.getElementById('templateList'),
  templateName: document.getElementById('templateName'),
  templateCategory: document.getElementById('templateCategory'),
  templateCommands: document.getElementById('templateCommands'),
  templateVariableSummary: document.getElementById('templateVariableSummary'),
  templateEditorNote: document.getElementById('templateEditorNote'),
  toast: document.getElementById('toast'),
  uploadModal: document.getElementById('uploadModal'),
  uploadModalForm: document.getElementById('uploadModalForm'),
  uploadModalCloseButton: document.getElementById('uploadModalCloseButton'),
  uploadModalCancelButton: document.getElementById('uploadModalCancelButton'),
  uploadModalStartButton: document.getElementById('uploadModalStartButton'),
  runNeedsUpload: document.getElementById('runNeedsUpload'),
  runUploadFields: document.getElementById('runUploadFields'),
  uploadLocalPath: document.getElementById('uploadLocalPath'),
  uploadRemotePath: document.getElementById('uploadRemotePath'),
  selectUploadButton: document.getElementById('selectUploadButton'),
  sshUploadPanel: document.getElementById('sshUploadPanel'),
  sshUploadPath: document.getElementById('sshUploadPath'),
  sshUploadButton: document.getElementById('sshUploadButton'),
  sshUploadProgress: document.getElementById('sshUploadProgress'),
  sshUploadProgressFile: document.getElementById('sshUploadProgressFile'),
  sshUploadProgressPercent: document.getElementById('sshUploadProgressPercent'),
  sshUploadProgressBar: document.getElementById('sshUploadProgressBar'),
  sshUploadProgressDetail: document.getElementById('sshUploadProgressDetail'),
  sshUploadCancelButton: document.getElementById('sshUploadCancelButton'),
  exportPickerModal: document.getElementById('exportPickerModal'),
  exportPickerForm: document.getElementById('exportPickerForm'),
  exportPickerTitle: document.getElementById('exportPickerTitle'),
  exportPickerSubtitle: document.getElementById('exportPickerSubtitle'),
  exportPickerCloseButton: document.getElementById('exportPickerCloseButton'),
  exportPickerCancelButton: document.getElementById('exportPickerCancelButton'),
  exportPickerExportButton: document.getElementById('exportPickerExportButton'),
  exportPickerSearch: document.getElementById('exportPickerSearch'),
  exportPickerSelectAll: document.getElementById('exportPickerSelectAll'),
  exportPickerList: document.getElementById('exportPickerList'),
  exportPickerCount: document.getElementById('exportPickerCount'),
  duplicateTemplateModal: document.getElementById('duplicateTemplateModal'),
  duplicateTemplateForm: document.getElementById('duplicateTemplateForm'),
  duplicateTemplateCloseButton: document.getElementById('duplicateTemplateCloseButton'),
  duplicateTemplateCancelButton: document.getElementById('duplicateTemplateCancelButton'),
  duplicateTemplateSaveButton: document.getElementById('duplicateTemplateSaveButton'),
  duplicateTemplateName: document.getElementById('duplicateTemplateName'),
  duplicateTemplateCategory: document.getElementById('duplicateTemplateCategory'),
  variablePromptModal: document.getElementById('variablePromptModal'),
  variablePromptForm: document.getElementById('variablePromptForm'),
  variablePromptTitle: document.getElementById('variablePromptTitle'),
  variablePromptDetail: document.getElementById('variablePromptDetail'),
  variablePromptList: document.getElementById('variablePromptList'),
  variablePromptCloseButton: document.getElementById('variablePromptCloseButton'),
  variablePromptCancelButton: document.getElementById('variablePromptCancelButton'),
  variablePromptSaveButton: document.getElementById('variablePromptSaveButton'),
  variablePromptSaveLabel: document.getElementById('variablePromptSaveLabel'),
  confirmModal: document.getElementById('confirmModal'),
  confirmModalTitle: document.getElementById('confirmModalTitle'),
  confirmModalDetail: document.getElementById('confirmModalDetail'),
  confirmModalCancelButton: document.getElementById('confirmModalCancelButton'),
  confirmModalConfirmButton: document.getElementById('confirmModalConfirmButton'),
  confirmModalConfirmLabel: document.getElementById('confirmModalConfirmLabel'),
  teamHeaderCopy: document.getElementById('teamHeaderCopy'),
  logoutButton: document.getElementById('logoutButton'),
  settingsNavItems: Array.from(document.querySelectorAll('[data-settings-tab]')),
  settingsPanels: Array.from(document.querySelectorAll('[data-settings-panel]')),
  settingsLoginButtons: Array.from(document.querySelectorAll('[data-settings-login]')),
  settingsProfileAvatar: document.getElementById('settingsProfileAvatar'),
  settingsProfileName: document.getElementById('settingsProfileName'),
  settingsProfileEmail: document.getElementById('settingsProfileEmail'),
  settingsVerificationStatus: document.getElementById('settingsVerificationStatus'),
  settingsProfileNameInput: document.getElementById('settingsProfileNameInput'),
  settingsProfileEmailInput: document.getElementById('settingsProfileEmailInput'),
  settingsProfileSaveButton: document.getElementById('settingsProfileSaveButton'),
  settingsProfileLogoutButton: document.getElementById('settingsProfileLogoutButton'),
  settingsWorkspaceName: document.getElementById('settingsWorkspaceName'),
  settingsAppVersion: document.getElementById('settingsAppVersion'),
  appUpdateStatus: document.getElementById('appUpdateStatus'),
  appUpdateDetail: document.getElementById('appUpdateDetail'),
  appUpdateMeta: document.getElementById('appUpdateMeta'),
  appUpdateCheckButton: document.getElementById('appUpdateCheckButton'),
  appUpdateRestartButton: document.getElementById('appUpdateRestartButton'),
  appUpdateOpenReleasesButton: document.getElementById('appUpdateOpenReleasesButton'),
  settingsImportAccountButton: document.getElementById('settingsImportAccountButton'),
  settingsExportAccountButton: document.getElementById('settingsExportAccountButton'),
  backupHistoryList: document.getElementById('backupHistoryList'),
  deleteWorkspaceButton: document.getElementById('deleteWorkspaceButton'),
  teamSelect: document.getElementById('teamSelect'),
  switchTeamButton: document.getElementById('switchTeamButton'),
  openCreateTeamButton: document.getElementById('openCreateTeamButton'),
  importLocalToCloudButton: document.getElementById('importLocalToCloudButton'),
  inviteMemberForm: document.getElementById('inviteMemberForm'),
  inviteTeamSelect: document.getElementById('inviteTeamSelect'),
  inviteEmail: document.getElementById('inviteEmail'),
  teamMembersList: document.getElementById('teamMembersList'),
  incomingInvitesLists: document.querySelectorAll('[data-incoming-invites-list]'),
  pendingInvitesList: document.getElementById('pendingInvitesList'),
  teamCloudWarning: document.getElementById('teamCloudWarning'),
  createTeamModal: document.getElementById('createTeamModal'),
  createTeamForm: document.getElementById('createTeamForm'),
  createTeamCloseButton: document.getElementById('createTeamCloseButton'),
  createTeamCancelButton: document.getElementById('createTeamCancelButton'),
  createTeamName: document.getElementById('createTeamName')
};

const STARTUP_IPC_TIMEOUT_MS = 5000;
const CLOUD_SESSION_TIMEOUT_MS = 15000;
const STARTUP_VERSION_TIMEOUT_MS = 1200;
let ftpRemoteDragDepth = 0;

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

async function hydrateStartupMetadata() {
  if (!els.startupAppVersion) return;
  els.startupAppVersion.textContent = `Version ${state.app.version}`;
  if (!window.deployerx?.getAppMetadata) return;
  try {
    const metadata = await withTimeout(
      window.deployerx.getAppMetadata(),
      STARTUP_VERSION_TIMEOUT_MS,
      'App metadata took too long to load.'
    );
    applyAppMetadata(metadata);
  } catch {
    els.startupAppVersion.textContent = `Version ${state.app.version}`;
  }
}

function applyAppUpdateState(update = {}, { toastOnDownloaded = false } = {}) {
  const previousStatus = state.app.updates.status;
  state.app.updates = normalizeAppUpdateState(update);
  if (state.app.updates.currentVersion) state.app.version = state.app.updates.currentVersion;
  renderAppUpdateCard();
  if (toastOnDownloaded && previousStatus !== 'downloaded' && state.app.updates.status === 'downloaded') {
    const version = state.app.updates.downloadedVersion || state.app.updates.availableVersion || 'the latest release';
    showToast(`Update ${version} is ready. Restart DeployerX to install it.`);
  }
}

function applyAppMetadata(metadata = {}) {
  state.app.version = String(metadata?.version || state.app.version || '0.1.0');
  if (metadata?.updates) applyAppUpdateState(metadata.updates);
  else renderAppUpdateCard();
  if (els.startupAppVersion) els.startupAppVersion.textContent = `Version ${state.app.version}`;
}

async function refreshAppUpdateState() {
  if (!window.deployerx?.getUpdateState) return;
  try {
    const update = await window.deployerx.getUpdateState();
    applyAppUpdateState(update);
  } catch {}
}

function formatUpdateTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function appUpdateStatusLabel(status) {
  switch (status) {
    case 'checking':
      return 'Checking';
    case 'available':
      return 'Found';
    case 'manual-update':
      return 'Manual update';
    case 'downloading':
      return 'Downloading';
    case 'downloaded':
      return 'Ready';
    case 'up-to-date':
      return 'Up to date';
    case 'portable':
      return 'Portable build';
    case 'development':
      return 'Dev build';
    case 'unsupported':
      return 'Unsupported';
    case 'unconfigured':
      return 'Not configured';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

function appUpdateDetail(update) {
  if (update.error) return update.error;
  if (update.message) return update.message;
  if (update.status === 'manual-update' && update.availableVersion) {
    return `Version ${update.availableVersion} is available. Open Releases to download the latest setup build manually.`;
  }
  if (update.status === 'downloading' && update.availableVersion) return `Downloading version ${update.availableVersion}.`;
  if (update.status === 'downloaded' && (update.downloadedVersion || update.availableVersion)) {
    return `Version ${update.downloadedVersion || update.availableVersion} is downloaded and ready to install.`;
  }
  return 'Automatic GitHub release tracking is standing by.';
}

function renderAppUpdateCard() {
  const update = normalizeAppUpdateState(state.app.updates);
  const installedVersion = state.app.version || update.currentVersion || '0.1.0';
  if (els.settingsAppVersion) els.settingsAppVersion.textContent = `Installed version ${installedVersion}`;
  if (els.appUpdateStatus) {
    els.appUpdateStatus.textContent = appUpdateStatusLabel(update.status);
    els.appUpdateStatus.dataset.status = update.status || 'idle';
  }
  if (els.appUpdateDetail) els.appUpdateDetail.textContent = appUpdateDetail(update);
  if (els.appUpdateMeta) {
    const meta = [];
    if (update.availableVersion) meta.push(`Latest release ${update.availableVersion}`);
    if (update.status === 'downloaded' && update.downloadedVersion) meta.push(`Downloaded ${update.downloadedVersion}`);
    if (update.status === 'downloading') meta.push(`${Math.round(update.downloadPercent)}% downloaded`);
    if (update.lastCheckedAt) meta.push(`Checked ${formatUpdateTimestamp(update.lastCheckedAt)}`);
    els.appUpdateMeta.innerHTML = meta.map((entry) => `<span>${escapeHtml(entry)}</span>`).join('');
  }
  if (els.appUpdateCheckButton) {
    els.appUpdateCheckButton.disabled = !update.canCheck;
    els.appUpdateCheckButton.title = update.canCheck ? '' : 'Update checks are not available for this build.';
  }
  if (els.appUpdateRestartButton) {
    els.appUpdateRestartButton.classList.toggle('hidden', !update.canInstall);
    els.appUpdateRestartButton.disabled = !update.canInstall;
  }
  if (els.appUpdateOpenReleasesButton) {
    els.appUpdateOpenReleasesButton.disabled = !update.releasePageUrl;
  }
}

let toastTimer = null;
let uptimeRefreshTimer = null;
let uptimeRefreshInFlight = false;
let confirmModalResolve = null;
let variablePromptResolve = null;
const pendingActions = new Set();
const fileActivities = new Map();
let nextFileActivityId = 0;

function renderFileActivity() {
  if (!els.fileActivity) return;
  const activities = [...fileActivities.values()];
  els.fileActivity.classList.toggle('hidden', !activities.length);
  els.fileActivity.innerHTML = activities
    .map(
      (activity) => `
        <div class="file-activity-row">
          <span class="file-activity-spinner" aria-hidden="true"></span>
          <span>${escapeHtml(activity.message)}</span>
        </div>
      `
    )
    .join('');
}

async function withFileActivity(message, task) {
  const activityId = `${Date.now()}:${++nextFileActivityId}`;
  fileActivities.set(activityId, { message });
  renderFileActivity();
  try {
    return await task();
  } finally {
    fileActivities.delete(activityId);
    renderFileActivity();
  }
}

function normalizeCommands(value) {
  return value
    .split('\n')
    .map((command) => command.trim())
    .filter(Boolean);
}

function normalizeVariableKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
}

function normalizeVariables(value) {
  if (!value || typeof value !== 'object') return {};
  const entries = Array.isArray(value)
    ? value.map((item) => [item?.key, item?.value])
    : Object.entries(value);

  return entries.reduce((variables, [key, variableValue]) => {
    const normalizedKey = normalizeVariableKey(key);
    if (normalizedKey) variables[normalizedKey] = String(variableValue ?? '');
    return variables;
  }, {});
}

function extractTemplateVariables(commands) {
  const names = new Set();
  const commandList = Array.isArray(commands) ? commands : normalizeCommands(String(commands ?? ''));

  for (const command of commandList) {
    for (const match of String(command).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
      names.add(match[1]);
    }
  }

  return [...names].sort((first, second) => first.localeCompare(second));
}

function projectVariableMap(project) {
  const customVariables = normalizeVariables(project?.variables);
  const builtInVariables = {
    project_name: project?.name || '',
    server_group: project?.group || '',
    server_type: project?.serverType || '',
    ssh_host: project?.ssh?.host || '',
    ssh_port: String(project?.ssh?.port || 22),
    ssh_username: project?.ssh?.username || ''
  };

  for (const name of builtInVariableNames) {
    if (String(customVariables[name] || '').trim() === '') delete customVariables[name];
  }

  return {
    ...builtInVariables,
    ...customVariables
  };
}

function resolveCommandVariables(command, project) {
  const variables = projectVariableMap(project);
  return String(command).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (token, name) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : token
  );
}

function resolveTemplateCommands(commands, project) {
  return (Array.isArray(commands) ? commands : []).map((command) => resolveCommandVariables(command, project));
}

function missingTemplateVariables(commands, project) {
  const variables = projectVariableMap(project);
  return extractTemplateVariables(commands).filter(
    (name) => !Object.prototype.hasOwnProperty.call(variables, name) || String(variables[name]).trim() === ''
  );
}

function normalizeUptimeMonitor(monitor = {}) {
  const blank = blankUptimeMonitor();
  const type = monitor.type === 'tcp' ? 'tcp' : 'http';
  const http = monitor.http || {};
  const tcp = monitor.tcp || {};
  return {
    ...blank,
    ...monitor,
    id: String(monitor.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    name: String(monitor.name || '').trim() || `${type.toUpperCase()} monitor`,
    type,
    enabled: monitor.enabled !== false,
    intervalSec: Math.max(30, Number(monitor.intervalSec || blank.intervalSec) || blank.intervalSec),
    timeoutMs: Math.max(1000, Number(monitor.timeoutMs || blank.timeoutMs) || blank.timeoutMs),
    latencyBudgetMs: Math.max(0, Number(monitor.latencyBudgetMs || 0) || 0),
    http: {
      ...blank.http,
      ...http,
      method: String(http.method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET',
      url: String(http.url || '').trim(),
      headers: http.headers && typeof http.headers === 'object' ? http.headers : {},
      expectedStatusCodes: Array.isArray(http.expectedStatusCodes) ? http.expectedStatusCodes.map((item) => Number(item)).filter(Boolean) : [200],
      bodyMustContain: Array.isArray(http.bodyMustContain) ? http.bodyMustContain.map(String).filter(Boolean) : [],
      bodyMustNotContain: Array.isArray(http.bodyMustNotContain) ? http.bodyMustNotContain.map(String).filter(Boolean) : [],
      headerAssertions: Array.isArray(http.headerAssertions) ? http.headerAssertions : []
    },
    tcp: {
      ...blank.tcp,
      ...tcp,
      host: String(tcp.host || '').trim(),
      port: Math.max(1, Math.min(65535, Number(tcp.port || blank.tcp.port) || blank.tcp.port))
    }
  };
}

function normalizeUptimeRuntimeMonitor(runtime = {}) {
  return {
    ...defaultUptimeRuntimeMonitor(),
    ...(runtime && typeof runtime === 'object' ? runtime : {})
  };
}

function normalizeUptimeProjectState(project = {}) {
  return {
    ...defaultUptimeState(),
    ...(project && typeof project === 'object' ? project : {}),
    summary: {
      ...defaultUptimeState().summary,
      ...(project?.summary && typeof project.summary === 'object' ? project.summary : {})
    },
    service: {
      ...defaultUptimeState().service,
      ...(project?.service && typeof project.service === 'object' ? project.service : {})
    },
    monitors: Array.isArray(project?.monitors)
      ? project.monitors.map((monitor) => ({
          ...normalizeUptimeMonitor(monitor),
          runtime: normalizeUptimeRuntimeMonitor(monitor.runtime)
        }))
      : []
  };
}

function normalizeProject(project = {}) {
  const blank = blankProject();
  return {
    ...blank,
    ...project,
    group: String(project?.group || '').trim(),
    ssh: {
      ...blank.ssh,
      ...(project.ssh || {})
    },
    ftp: {
      ...blank.ftp,
      ...(project.ftp || {})
    },
    commands: Array.isArray(project.commands) ? project.commands : [],
    variables: normalizeVariables(project.variables),
    uptimeMonitors: Array.isArray(project.uptimeMonitors) ? project.uptimeMonitors.map(normalizeUptimeMonitor) : []
  };
}

function hasCustomFtpDetails(project = {}) {
  const ftp = project?.ftp || {};
  return ['host', 'port', 'username', 'authType', 'password', 'privateKey', 'passphrase'].some(
    (field) => String(ftp[field] ?? '').trim() !== ''
  );
}

function normalizeTemplateCategory(category) {
  const trimmed = String(category || '').trim();
  return templateCategories.includes(trimmed) ? trimmed : 'Server';
}

function normalizeTemplate(template = {}) {
  const commands = Array.isArray(template.commands) ? template.commands : [];
  return {
    ...template,
    category: normalizeTemplateCategory(template.category),
    commands,
    variables: Array.isArray(template.variables) ? template.variables : extractTemplateVariables(commands),
    builtIn: Boolean(template.builtIn),
    readOnly: Boolean(template.readOnly),
    source: template.source ? String(template.source) : template.builtIn ? 'library' : 'user'
  };
}

function isBuiltInTemplate(template) {
  return Boolean(template?.builtIn || template?.readOnly || template?.source === 'library');
}

function getTemplateById(templateId) {
  return state.templates.find((item) => String(item.id) === String(templateId)) || null;
}

function projectBadge(project) {
  return (project.name || 'DX').slice(0, 2).toUpperCase();
}

function serverGroupName(project = {}) {
  return String(project?.group || '').trim() || 'Ungrouped';
}

function savedProjectGroups(projects = state.projects) {
  const groups = new Map();
  for (const project of projects) {
    const name = String(project?.group || '').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, name);
  }
  return [...groups.values()].sort((first, second) => first.localeCompare(second));
}

function renderProjectGroupOptions() {
  if (!els.projectGroupOptions) return;
  els.projectGroupOptions.innerHTML = '';
  for (const group of savedProjectGroups()) {
    const option = document.createElement('option');
    option.value = group;
    els.projectGroupOptions.appendChild(option);
  }
}

function groupProjects(projects = state.projects) {
  const groups = new Map();
  for (const project of projects) {
    const name = serverGroupName(project);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(project);
  }
  return [...groups.entries()]
    .sort((first, second) => first[0].localeCompare(second[0]))
    .map(([name, items]) => ({
      name,
      items: [...items].sort((first, second) => (first.name || '').localeCompare(second.name || ''))
    }));
}

function dashboardStats(projects = state.projects) {
  const total = projects.length;
  let sshConnected = 0;
  let ftpConnected = 0;
  let commands = 0;
  const groups = new Set();

  for (const project of projects) {
    const connection = projectConnectionState(project.id);
    if (connection.ssh) sshConnected += 1;
    if (connection.ftp) ftpConnected += 1;
    commands += project.commands?.length || 0;
    groups.add(serverGroupName(project));
  }

  return {
    total,
    groups: groups.size,
    sshConnected,
    ftpConnected,
    commands,
    disconnected: total - sshConnected
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function icon(name) {
  return `
    <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <use href="#icon-${name}"></use>
    </svg>
  `;
}

function formatDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

function formatLatency(value) {
  if (value == null || value === '') return '-';
  return `${Number(value || 0)} ms`;
}

function uptimeStatusLabel(status) {
  switch (status) {
    case 'up':
      return 'Up';
    case 'down':
      return 'Down';
    case 'degraded':
      return 'Degraded';
    case 'queued':
      return 'Queued';
    case 'paused':
      return 'Paused';
    default:
      return 'Idle';
  }
}

function selectedUptimeProjectRecord() {
  return state.projects.find((project) => String(project.id) === String(state.uptime.selectedProjectId)) || null;
}

function syncSelectedUptimeProject(preferredId = '') {
  const preferred = String(preferredId || state.uptime.selectedProjectId || state.activeProject?.id || '').trim();
  if (preferred && state.projects.some((project) => String(project.id) === preferred)) {
    state.uptime.selectedProjectId = preferred;
  } else {
    state.uptime.selectedProjectId = state.projects[0]?.id || '';
  }
  return selectedUptimeProjectRecord();
}

function renderUptimeProjectSelect() {
  if (!els.uptimeProjectSelect) return;
  const selectedProject = syncSelectedUptimeProject();
  els.uptimeProjectSelect.innerHTML = '';

  if (!state.projects.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No servers available';
    els.uptimeProjectSelect.appendChild(option);
    els.uptimeProjectSelect.disabled = true;
    return;
  }

  for (const project of state.projects) {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = `${project.name || 'Untitled Server'} · ${serverGroupName(project)} · ${project.uptimeMonitors.length} monitor${project.uptimeMonitors.length === 1 ? '' : 's'}`;
    els.uptimeProjectSelect.appendChild(option);
  }

  els.uptimeProjectSelect.disabled = false;
  els.uptimeProjectSelect.value = selectedProject?.id || state.uptime.selectedProjectId || '';
}

function markQueuedUptimeMonitors(projectId, monitorId = '') {
  const currentProjectId = String(state.uptime.project.projectId || '').trim();
  if (!currentProjectId || currentProjectId !== String(projectId || '').trim()) return;

  const selectedMonitorId = String(monitorId || '').trim();
  state.uptime.project = normalizeUptimeProjectState({
    ...state.uptime.project,
    monitors: (state.uptime.project.monitors || []).map((monitor) => {
      const shouldQueue = monitor.enabled !== false && (!selectedMonitorId || String(monitor.id) === selectedMonitorId);
      if (!shouldQueue) return monitor;
      return {
        ...monitor,
        runtime: normalizeUptimeRuntimeMonitor({
          ...(monitor.runtime || {}),
          status: 'queued',
          summary: 'Run queued. Waiting for worker.',
          nextCheckAt: '',
          lastError: ''
        })
      };
    })
  });
  renderUptimeWorkspace();
}

function selectedUptimeMonitor() {
  return state.uptime.project.monitors.find((monitor) => String(monitor.id) === String(state.uptime.selectedMonitorId)) || null;
}

function syncSelectedUptimeMonitor() {
  const monitors = state.uptime.project.monitors || [];
  if (!monitors.length) {
    state.uptime.selectedMonitorId = '';
    return null;
  }
  if (!monitors.some((monitor) => String(monitor.id) === String(state.uptime.selectedMonitorId))) {
    state.uptime.selectedMonitorId = String(monitors[0].id);
  }
  return selectedUptimeMonitor();
}

function renderUptimeKeyValueList(target, items) {
  target.innerHTML = items
    .map(
      ([label, value]) => `
        <div class="uptime-kv-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `
    )
    .join('');
}

function renderUptimeMonitorList() {
  if (!state.uptime.project.projectId) {
    els.uptimeMonitorListMeta.textContent = 'No server selected.';
    els.uptimeMonitorList.innerHTML = `
      <div class="uptime-empty-state compact">
        <strong>No server available</strong>
        <span>Add a server first, then manage its uptime monitors here.</span>
      </div>
    `;
    return;
  }

  const monitors = state.uptime.project.monitors || [];
  els.uptimeMonitorListMeta.textContent = `${state.uptime.project.projectName || 'Server'} · ${monitors.length} configured monitor${monitors.length === 1 ? '' : 's'}`;
  if (!monitors.length) {
    els.uptimeMonitorList.innerHTML = `
      <div class="uptime-empty-state compact">
        <strong>No monitors yet</strong>
        <span>Add an HTTP or TCP check to start background uptime tracking for this server.</span>
      </div>
    `;
    return;
  }

  els.uptimeMonitorList.innerHTML = monitors
    .map((monitor) => {
      const runtime = normalizeUptimeRuntimeMonitor(monitor.runtime);
      const active = String(monitor.id) === String(state.uptime.selectedMonitorId);
      const target =
        monitor.type === 'tcp'
          ? `${monitor.tcp?.host || '-'}:${monitor.tcp?.port || '-'}`
          : `${monitor.http?.method || 'GET'} ${monitor.http?.url || '-'}`;
      return `
        <button class="uptime-monitor-row ${active ? 'active' : ''}" type="button" data-uptime-monitor-id="${escapeHtml(monitor.id)}">
          <div class="uptime-monitor-row-top">
            <strong>${escapeHtml(monitor.name)}</strong>
            <span class="uptime-status-pill status-${escapeHtml(runtime.status || 'idle')}">${escapeHtml(uptimeStatusLabel(runtime.status))}</span>
          </div>
          <span class="uptime-monitor-target">${escapeHtml(target)}</span>
          <span class="uptime-monitor-meta">${escapeHtml(runtime.summary || 'No checks yet.')}</span>
        </button>
      `;
    })
    .join('');
}

function renderUptimeMonitorDetail() {
  const monitor = syncSelectedUptimeMonitor();
  const service = state.uptime.project.service || defaultUptimeState().service;
  els.uptimeServiceStatus.textContent = service.active ? 'Background online' : 'Worker offline';
  els.uptimeServiceMeta.textContent = service.syncWarning
    ? service.syncWarning
    : service.lastConfigRefreshAt
      ? `Last config refresh ${formatDateTime(service.lastConfigRefreshAt)}`
      : 'Waiting for worker status.';
  els.uptimeHealthyCount.textContent = String((state.uptime.project.summary.up || 0) + 0);
  els.uptimeAttentionCount.textContent = String((state.uptime.project.summary.down || 0) + (state.uptime.project.summary.degraded || 0));
  els.uptimePausedCount.textContent = String(state.uptime.project.summary.paused || 0);

  if (!monitor) {
    els.uptimeEmptyState.classList.remove('hidden');
    els.uptimeDetailContent.classList.add('hidden');
    return;
  }

  const runtime = normalizeUptimeRuntimeMonitor(monitor.runtime);
  els.uptimeEmptyState.classList.add('hidden');
  els.uptimeDetailContent.classList.remove('hidden');
  els.uptimeSelectedMonitorStatus.className = `uptime-status-pill status-${runtime.status || 'idle'}`;
  els.uptimeSelectedMonitorStatus.textContent = uptimeStatusLabel(runtime.status);
  els.uptimeSelectedMonitorName.textContent = monitor.name;
  els.uptimeSelectedMonitorMeta.textContent = `${monitor.type.toUpperCase()} monitor · ${monitor.enabled ? 'Enabled' : 'Paused'}`;
  els.uptimeToggleMonitorButton.textContent = monitor.enabled ? 'Pause' : 'Resume';

  renderUptimeKeyValueList(els.uptimeOverviewList, [
    ['Last check', formatDateTime(runtime.lastCheckAt)],
    ['Last success', formatDateTime(runtime.lastSuccessAt)],
    ['Last failure', formatDateTime(runtime.lastFailureAt)],
    ['Latency', formatLatency(runtime.lastLatencyMs)],
    ['Consecutive failures', String(runtime.consecutiveFailures || 0)],
    ['Total checks', String(runtime.checkCount || 0)],
    ['Next check', formatDateTime(runtime.nextCheckAt)],
    ['Current summary', runtime.summary || '-']
  ]);

  const configItems =
    monitor.type === 'tcp'
      ? [
          ['Target', `${monitor.tcp?.host || '-'}:${monitor.tcp?.port || '-'}`],
          ['Interval', `${monitor.intervalSec} sec`],
          ['Timeout', `${monitor.timeoutMs} ms`],
          ['Latency budget', monitor.latencyBudgetMs ? `${monitor.latencyBudgetMs} ms` : 'None']
        ]
      : [
          ['URL', monitor.http?.url || '-'],
          ['Method', monitor.http?.method || 'GET'],
          ['Expected status', (monitor.http?.expectedStatusCodes || []).join(', ') || '200'],
          ['Headers', Object.keys(monitor.http?.headers || {}).length ? JSON.stringify(monitor.http.headers) : 'None'],
          ['Header assertions', (monitor.http?.headerAssertions || []).length ? JSON.stringify(monitor.http.headerAssertions) : 'None'],
          ['Body must contain', (monitor.http?.bodyMustContain || []).join(', ') || 'None'],
          ['Body must not contain', (monitor.http?.bodyMustNotContain || []).join(', ') || 'None'],
          ['Interval', `${monitor.intervalSec} sec`],
          ['Timeout', `${monitor.timeoutMs} ms`],
          ['Latency budget', monitor.latencyBudgetMs ? `${monitor.latencyBudgetMs} ms` : 'None']
        ];
  renderUptimeKeyValueList(els.uptimeConfigList, configItems);

  els.uptimeIncidentList.innerHTML = state.uptime.selectedMonitorIncidents.length
    ? state.uptime.selectedMonitorIncidents
        .slice()
        .reverse()
        .map(
          (incident) => `
            <article class="uptime-timeline-row">
              <strong>${escapeHtml(incident.event === 'resolved' ? 'Resolved' : 'Opened')}</strong>
              <span>${escapeHtml(formatDateTime(incident.at))}</span>
              <p>${escapeHtml(incident.message || '-')}</p>
            </article>
          `
        )
        .join('')
    : '<div class="settings-muted">No incidents logged yet.</div>';

  els.uptimeHistoryList.innerHTML = state.uptime.selectedMonitorHistory.length
    ? state.uptime.selectedMonitorHistory
        .slice()
        .reverse()
        .map(
          (entry) => `
            <article class="uptime-history-row">
              <div class="uptime-history-top">
                <strong>${escapeHtml(uptimeStatusLabel(entry.status))}</strong>
                <span>${escapeHtml(formatDateTime(entry.at))}</span>
              </div>
              <div class="uptime-history-meta">${escapeHtml(entry.summary || '-')}</div>
              <div class="uptime-history-meta">${escapeHtml(formatLatency(entry.latencyMs))}${entry.error ? ` · ${escapeHtml(entry.error)}` : ''}</div>
            </article>
          `
        )
        .join('')
    : '<div class="settings-muted">No checks recorded yet.</div>';
}

function renderUptimeWorkspace() {
  renderUptimeProjectSelect();
  const hasProject = Boolean(state.uptime.project.projectId);
  els.uptimeAddMonitorButton.disabled = !hasProject;
  els.uptimeRunAllButton.disabled = !hasProject;
  renderUptimeMonitorList();
  renderUptimeMonitorDetail();
}

async function loadSelectedUptimeMonitorHistory() {
  const monitor = selectedUptimeMonitor();
  if (!state.uptime.project.projectId || !monitor) {
    state.uptime.selectedMonitorHistory = [];
    state.uptime.selectedMonitorIncidents = [];
    renderUptimeMonitorDetail();
    return;
  }
  const history = await window.deployerx.getUptimeMonitorHistory({
    projectId: state.uptime.project.projectId,
    monitorId: monitor.id
  });
  state.uptime.selectedMonitorHistory = Array.isArray(history?.history) ? history.history : [];
  state.uptime.selectedMonitorIncidents = Array.isArray(history?.incidents) ? history.incidents : [];
  renderUptimeMonitorDetail();
}

async function refreshUptimeProjectState({ preserveSelection = true } = {}) {
  const selectedProject = syncSelectedUptimeProject();
  renderUptimeProjectSelect();
  if (!selectedProject?.id) {
    const service = await window.deployerx.getUptimeServiceStatus().catch(() => defaultUptimeState().service);
    state.uptime.project = normalizeUptimeProjectState({
      projectId: '',
      projectName: '',
      service,
      summary: defaultUptimeState().summary,
      monitors: []
    });
    if (!preserveSelection) state.uptime.selectedMonitorId = '';
    state.uptime.selectedMonitorHistory = [];
    state.uptime.selectedMonitorIncidents = [];
    renderUptimeWorkspace();
    return;
  }
  const nextProjectState = normalizeUptimeProjectState(await window.deployerx.getUptimeProjectState(selectedProject.id));
  state.uptime.project = nextProjectState;
  state.uptime.selectedProjectId = nextProjectState.projectId || selectedProject.id;
  if (!preserveSelection) state.uptime.selectedMonitorId = '';
  syncSelectedUptimeMonitor();
  renderUptimeWorkspace();
  await loadSelectedUptimeMonitorHistory();
}

function stopUptimeAutoRefresh() {
  if (uptimeRefreshTimer) {
    clearInterval(uptimeRefreshTimer);
    uptimeRefreshTimer = null;
  }
}

function startUptimeAutoRefresh() {
  stopUptimeAutoRefresh();
  uptimeRefreshTimer = setInterval(async () => {
    if (state.currentView !== 'uptime' || uptimeRefreshInFlight) return;
    uptimeRefreshInFlight = true;
    try {
      await refreshUptimeProjectState({ preserveSelection: true });
    } catch {
      // Keep the loop quiet; explicit actions already surface errors.
    } finally {
      uptimeRefreshInFlight = false;
    }
  }, 2500);
}

function updateUptimeMonitorTypeFields() {
  const isTcp = els.uptimeMonitorType.value === 'tcp';
  els.uptimeTcpFields.classList.toggle('hidden', !isTcp);
  els.uptimeHttpFields.classList.toggle('hidden', isTcp);
}

function parseJsonField(rawValue, fallback, label) {
  const value = String(rawValue || '').trim();
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function fillUptimeMonitorForm(monitor) {
  const normalized = normalizeUptimeMonitor(monitor);
  els.uptimeMonitorName.value = normalized.name;
  els.uptimeMonitorType.value = normalized.type;
  els.uptimeMonitorEnabled.value = normalized.enabled ? 'true' : 'false';
  els.uptimeMonitorInterval.value = String(normalized.intervalSec);
  els.uptimeMonitorTimeout.value = String(normalized.timeoutMs);
  els.uptimeMonitorLatencyBudget.value = String(normalized.latencyBudgetMs || 0);
  els.uptimeHttpUrl.value = normalized.http.url || '';
  els.uptimeHttpMethod.value = normalized.http.method || 'GET';
  els.uptimeHttpStatusCodes.value = (normalized.http.expectedStatusCodes || []).join(',');
  els.uptimeHttpHeaders.value = Object.keys(normalized.http.headers || {}).length ? JSON.stringify(normalized.http.headers, null, 2) : '';
  els.uptimeHttpHeaderAssertions.value = (normalized.http.headerAssertions || []).length
    ? JSON.stringify(normalized.http.headerAssertions, null, 2)
    : '';
  els.uptimeHttpBodyMustContain.value = (normalized.http.bodyMustContain || []).join('\n');
  els.uptimeHttpBodyMustNotContain.value = (normalized.http.bodyMustNotContain || []).join('\n');
  els.uptimeTcpHost.value = normalized.tcp.host || '';
  els.uptimeTcpPort.value = String(normalized.tcp.port || 80);
  updateUptimeMonitorTypeFields();
}

function readUptimeMonitorFormValue() {
  return normalizeUptimeMonitor({
    id: state.uptime.modalMonitorId || '',
    name: els.uptimeMonitorName.value,
    type: els.uptimeMonitorType.value,
    enabled: els.uptimeMonitorEnabled.value === 'true',
    intervalSec: Number(els.uptimeMonitorInterval.value || 300),
    timeoutMs: Number(els.uptimeMonitorTimeout.value || 10000),
    latencyBudgetMs: Number(els.uptimeMonitorLatencyBudget.value || 0),
    http: {
      method: els.uptimeHttpMethod.value,
      url: els.uptimeHttpUrl.value,
      expectedStatusCodes: String(els.uptimeHttpStatusCodes.value || '')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter(Boolean),
      headers: parseJsonField(els.uptimeHttpHeaders.value, {}, 'Headers'),
      headerAssertions: parseJsonField(els.uptimeHttpHeaderAssertions.value, [], 'Header assertions'),
      bodyMustContain: String(els.uptimeHttpBodyMustContain.value || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
      bodyMustNotContain: String(els.uptimeHttpBodyMustNotContain.value || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    },
    tcp: {
      host: els.uptimeTcpHost.value,
      port: Number(els.uptimeTcpPort.value || 80)
    }
  });
}

function openUptimeMonitorModal(mode = 'create', monitorId = '') {
  const project = selectedUptimeProjectRecord();
  if (!project) return;
  const current = project.uptimeMonitors?.find((monitor) => String(monitor.id) === String(monitorId)) || blankUptimeMonitor();
  state.uptime.modalMode = mode;
  state.uptime.modalMonitorId = mode === 'edit' ? String(current.id || '') : '';
  els.uptimeMonitorModalTitle.textContent = mode === 'edit' ? 'Edit monitor' : 'Add monitor';
  els.uptimeMonitorModalSubtitle.textContent =
    mode === 'edit' ? 'Update the uptime check and background monitoring rules.' : 'Configure a new HTTP or TCP monitor.';
  fillUptimeMonitorForm(mode === 'edit' ? current : blankUptimeMonitor());
  setModalVisible(true, els.uptimeMonitorModal);
  els.uptimeMonitorName.focus();
}

async function saveUptimeMonitor(event) {
  event.preventDefault();
  const project = selectedUptimeProjectRecord();
  if (!project) return;
  try {
    const monitor = readUptimeMonitorFormValue();
    const current = Array.isArray(project.uptimeMonitors) ? [...project.uptimeMonitors] : [];
    const index = current.findIndex((item) => String(item.id) === String(monitor.id));
    if (index >= 0) current[index] = monitor;
    else current.unshift(monitor);
    const saved = await saveProject({
      ...project,
      uptimeMonitors: current
    });
    if (state.activeProject?.id === saved.id) {
      state.activeProject = saved;
      els.activeProjectName.textContent = saved.name || 'Untitled Server';
      renderDetailsSummary(saved);
    }
    state.uptime.selectedProjectId = saved.id;
    renderProjects();
    state.uptime.selectedMonitorId = String(monitor.id);
    setModalVisible(false, els.uptimeMonitorModal);
    await refreshUptimeProjectState({ preserveSelection: true });
    showToast(index >= 0 ? 'Monitor updated' : 'Monitor created');
  } catch (error) {
    showAlert(error.message || 'Could not save uptime monitor.');
  }
}

async function deleteSelectedUptimeMonitor() {
  const project = selectedUptimeProjectRecord();
  if (!project) return;
  const monitor = selectedUptimeMonitor();
  if (!monitor) return;
  const ok = await confirmDangerousAction(
    `Delete monitor "${monitor.name}"?`,
    'Its local history and incidents will be removed from this device.',
    'Delete'
  );
  if (!ok) return;
  const nextMonitors = project.uptimeMonitors.filter((item) => String(item.id) !== String(monitor.id));
  const saved = await saveProject({
    ...project,
    uptimeMonitors: nextMonitors
  });
  if (state.activeProject?.id === saved.id) {
    state.activeProject = saved;
    renderDetailsSummary(saved);
  }
  state.uptime.selectedProjectId = saved.id;
  state.uptime.selectedMonitorId = nextMonitors[0]?.id || '';
  renderProjects();
  await refreshUptimeProjectState({ preserveSelection: true });
  showToast('Monitor deleted');
}

async function toggleSelectedUptimeMonitor() {
  const project = selectedUptimeProjectRecord();
  if (!project) return;
  const monitor = selectedUptimeMonitor();
  if (!monitor) return;
  const nextMonitors = project.uptimeMonitors.map((item) =>
    String(item.id) === String(monitor.id) ? { ...item, enabled: !item.enabled } : item
  );
  const saved = await saveProject({
    ...project,
    uptimeMonitors: nextMonitors
  });
  if (state.activeProject?.id === saved.id) {
    state.activeProject = saved;
    renderDetailsSummary(saved);
  }
  state.uptime.selectedProjectId = saved.id;
  renderProjects();
  await refreshUptimeProjectState({ preserveSelection: true });
  showToast(monitor.enabled ? 'Monitor paused' : 'Monitor resumed');
}

function showView(view) {
  if (state.setup.mode === 'cloud' && !state.teams.activeTeamId && view !== 'team') {
    view = 'team';
  }
  state.currentView = view;
  if (view === 'team') renderSettingsView();
  const isDashboard = view === 'dashboard';
  const isUptime = view === 'uptime';
  const isServers = view === 'servers';
  const isProject = view === 'project';
  const isTemplate = view === 'templates';
  const isTeam = view === 'team';
  els.dashboardView.classList.toggle('hidden', !isDashboard);
  els.uptimeView.classList.toggle('hidden', !isUptime);
  els.serversView.classList.toggle('hidden', !isServers);
  els.projectView.classList.toggle('hidden', !isProject);
  els.templateView.classList.toggle('hidden', !isTemplate);
  els.teamView.classList.toggle('hidden', !isTeam);
  els.dashboardButton.classList.toggle('active', isDashboard);
  els.uptimeButton.classList.toggle('active', isUptime);
  els.serversButton.classList.toggle('active', isServers);
  els.templatesButton.classList.toggle('active', isTemplate);
  els.teamButton.classList.toggle('active', isTeam);
  if (isUptime) {
    startUptimeAutoRefresh();
    refreshUptimeProjectState({ preserveSelection: true }).catch((error) => showAlert(error.message || 'Could not load uptime monitors.'));
  } else {
    stopUptimeAutoRefresh();
    if (isProject) {
    requestAnimationFrame(() => {
      if (state.activeProjectTab === 'ssh') {
        fitAddon.fit();
        if (state.terminalConnected) terminal.focus();
      }
    });
    }
  }
}

function setProjectTab(tab) {
  state.activeProjectTab = tab === 'ftp' ? 'ftp' : 'ssh';
  const isFtp = state.activeProjectTab === 'ftp';
  const isSsh = !isFtp;
  els.projectSshTab.classList.toggle('active', isSsh);
  els.projectFtpTab.classList.toggle('active', isFtp);
  els.projectSshTab.setAttribute('aria-selected', String(isSsh));
  els.projectFtpTab.setAttribute('aria-selected', String(isFtp));
  els.sshWorkspace.classList.toggle('hidden', !isSsh);
  els.ftpWorkspace.classList.toggle('hidden', !isFtp);
  if (isFtp) {
    renderFtpBrowser();
    if (!state.ftpLocalLoaded) {
      ensureActiveProjectLocalFtpReady().catch((error) => showAlert(error.message || 'Could not load local files.'));
    }
  } else {
    requestAnimationFrame(fitTerminal);
  }
}

function setModalVisible(visible, modal) {
  modal.classList.toggle('hidden', !visible);
}

function showToast(message) {
  if (!els.toast) return;
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove('visible');
  }, 2600);
}

function showAlert(message) {
  showToast(String(message || 'Something went wrong.'));
}

async function checkForAppUpdates() {
  if (!window.deployerx?.checkForUpdates || pendingActions.has('app:update:check')) return;
  pendingActions.add('app:update:check');
  setButtonLoading(els.appUpdateCheckButton, true);
  try {
    const update = await window.deployerx.checkForUpdates();
    applyAppUpdateState(update, { toastOnDownloaded: true });
    if (update.status === 'up-to-date') showToast('DeployerX is already on the latest published release.');
    if (update.status === 'portable' || update.status === 'development' || update.status === 'unsupported') {
      showToast(update.message || 'Automatic updates are not available for this build.');
    }
  } catch (error) {
    showAlert(error.message || 'Could not check for updates.');
  } finally {
    pendingActions.delete('app:update:check');
    setButtonLoading(els.appUpdateCheckButton, false);
    renderAppUpdateCard();
  }
}

async function installAppUpdate() {
  if (!window.deployerx?.installUpdate || pendingActions.has('app:update:install')) return;
  pendingActions.add('app:update:install');
  setButtonLoading(els.appUpdateRestartButton, true);
  try {
    showToast('Restarting DeployerX to install the downloaded update.');
    await window.deployerx.installUpdate();
  } catch (error) {
    showAlert(error.message || 'Could not install the downloaded update.');
  } finally {
    pendingActions.delete('app:update:install');
    setButtonLoading(els.appUpdateRestartButton, false);
    renderAppUpdateCard();
  }
}

async function openReleasesPage() {
  if (!window.deployerx?.openReleasesPage) return;
  try {
    await window.deployerx.openReleasesPage();
  } catch (error) {
    showAlert(error.message || 'Could not open the GitHub releases page.');
  }
}

window.alert = showAlert;

function friendlyAuthError(error, fallback = 'Something went wrong. Please try again.') {
  let message = String(error?.message || error || '').trim();
  message = message.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  message = message.replace(/^Error:\s*/i, '');
  message = message.replace(/^Firebase error:\s*/i, '');

  const normalized = message.replace(/[_-]/g, ' ').toLowerCase();
  if (normalized.includes('invalid login credentials') || normalized.includes('invalid password')) {
    return 'Invalid email or password.';
  }
  if (normalized.includes('email not found')) return 'No account was found for this email.';
  if (normalized.includes('email exists')) return 'An account already exists for this email.';
  if (normalized.includes('invalid email')) return 'Enter a valid email address.';
  if (normalized.includes('weak password')) return 'Use a stronger password with at least 6 characters.';
  if (normalized.includes('too many attempts') || normalized.includes('quota exceeded')) {
    return 'Too many attempts. Please wait a little and try again.';
  }
  if (normalized.includes('user disabled')) return 'This account has been disabled.';
  if (normalized.includes('operation not allowed')) return 'Email and password login is not enabled for this app.';
  if (normalized.includes('expired oob code') || normalized.includes('invalid oob code')) {
    return 'That link is no longer valid. Request a new one and try again.';
  }
  if (normalized.includes('token expired') || normalized.includes('invalid id token')) {
    return 'Your session expired. Please login again.';
  }
  if (normalized.includes('auth:') || normalized.includes('remote method')) return fallback;
  return message || fallback;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatFtpDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function parentFtpPath(remotePath) {
  const normalized = String(remotePath || '.').replace(/\\/g, '/').replace(/\/+/g, '/') || '.';
  if (normalized === '/' || normalized === '.') return normalized;
  const absolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  if (!parts.length) return absolute ? '/' : '.';
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function fileNameFromPath(filePath = '') {
  return String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || String(filePath || '');
}

function hasDraggedFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files');
}

function setFtpRemoteDropActive(active) {
  els.ftpRemoteBrowser?.classList.toggle('is-drop-target', Boolean(active));
}

function resetFtpRemoteDropState() {
  ftpRemoteDragDepth = 0;
  setFtpRemoteDropActive(false);
}

async function droppedFtpLocalPaths(event) {
  const files = Array.from(event.dataTransfer?.files || []);
  const paths = [];

  for (const file of files) {
    let localPath = String(file?.path || '');
    if (!localPath && window.deployerx?.getPathForDroppedFile) {
      localPath = String(window.deployerx.getPathForDroppedFile(file) || '');
    }
    if (localPath) paths.push(localPath);
  }

  return [...new Set(paths)];
}

function filteredEntries(entries, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => `${entry.name} ${entry.mode || ''}`.toLowerCase().includes(needle));
}

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle('is-loading', loading);
  button.disabled = loading;
  if (loading) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

async function withButtonLoading(actionKey, button, task) {
  if (pendingActions.has(actionKey)) return undefined;
  pendingActions.add(actionKey);
  setButtonLoading(button, true);
  try {
    return await task();
  } finally {
    pendingActions.delete(actionKey);
    setButtonLoading(button, false);
  }
}

function closeConfirmModal(confirmed) {
  if (!confirmModalResolve) return;
  const resolve = confirmModalResolve;
  confirmModalResolve = null;
  setModalVisible(false, els.confirmModal);
  resolve(Boolean(confirmed));
}

function confirmDangerousAction(message, detail = '', confirmLabel = 'Confirm') {
  if (confirmModalResolve) closeConfirmModal(false);

  els.confirmModalTitle.textContent = message;
  els.confirmModalDetail.textContent = detail;
  els.confirmModalDetail.classList.toggle('hidden', !detail);
  els.confirmModalConfirmLabel.textContent = confirmLabel;
  setModalVisible(true, els.confirmModal);
  els.confirmModalConfirmButton.focus();

  return new Promise((resolve) => {
    confirmModalResolve = resolve;
  });
}

function closeVariablePrompt(result = null) {
  if (!variablePromptResolve) {
    setModalVisible(false, els.variablePromptModal);
    els.variablePromptList.innerHTML = '';
    state.variablePrompt = null;
    return;
  }

  const resolve = variablePromptResolve;
  variablePromptResolve = null;
  state.variablePrompt = null;
  setModalVisible(false, els.variablePromptModal);
  els.variablePromptList.innerHTML = '';
  resolve(result);
}

function readVariablePromptValues() {
  const values = {};
  for (const input of els.variablePromptList.querySelectorAll('.variable-prompt-value')) {
    const key = normalizeVariableKey(input.dataset.variableName);
    if (!key) continue;
    values[key] = input.value;
  }
  return values;
}

function submitVariablePrompt(event) {
  if (event?.preventDefault) event.preventDefault();

  const inputs = Array.from(els.variablePromptList.querySelectorAll('.variable-prompt-value'));
  const emptyInput = inputs.find((input) => !String(input.value || '').trim());
  if (emptyInput) {
    emptyInput.reportValidity();
    emptyInput.focus();
    return;
  }

  closeVariablePrompt(readVariablePromptValues());
}

function renderVariablePromptFields(project, variableNames) {
  const existingVariables = normalizeVariables(project?.variables);
  els.variablePromptList.innerHTML = '';

  for (const name of variableNames) {
    const row = document.createElement('label');
    row.className = 'field variable-prompt-row';
    row.innerHTML = `
      <span class="variable-prompt-key">{{${escapeHtml(name)}}}</span>
      <input
        class="variable-prompt-value"
        type="text"
        data-variable-name="${escapeHtml(name)}"
        value="${escapeHtml(existingVariables[name] || '')}"
        placeholder="Enter ${escapeHtml(name)}"
        required
      />
    `;
    els.variablePromptList.appendChild(row);
  }
}

function promptForMissingVariables(
  project,
  variableNames,
  {
    title = 'Set script variables',
    detail = 'Enter the missing values to finish this script.',
    confirmLabel = 'Save and continue'
  } = {}
) {
  if (variablePromptResolve) closeVariablePrompt(null);

  const missingVariables = [...new Set((Array.isArray(variableNames) ? variableNames : []).map(String).filter(Boolean))];
  if (!missingVariables.length) return Promise.resolve({});

  state.variablePrompt = {
    projectId: project?.id || '',
    missingVariables
  };
  els.variablePromptTitle.textContent = title;
  els.variablePromptDetail.textContent = detail;
  els.variablePromptSaveLabel.textContent = confirmLabel;
  renderVariablePromptFields(project, missingVariables);
  setModalVisible(true, els.variablePromptModal);

  const firstInput = els.variablePromptList.querySelector('.variable-prompt-value');
  if (firstInput) {
    firstInput.focus();
    firstInput.select();
  }

  return new Promise((resolve) => {
    variablePromptResolve = resolve;
  });
}

async function ensureProjectVariables(
  project,
  commands,
  {
    persist = false,
    title = 'Set script variables',
    detail = 'Enter the missing values to finish this script.',
    confirmLabel = 'Save and continue'
  } = {}
) {
  const missingVariables = missingTemplateVariables(commands, project);
  if (!missingVariables.length) return normalizeProject(project);

  const values = await promptForMissingVariables(project, missingVariables, {
    title,
    detail,
    confirmLabel
  });
  if (!values) return null;

  const nextProject = normalizeProject({
    ...project,
    variables: {
      ...normalizeVariables(project?.variables),
      ...normalizeVariables(values)
    }
  });

  if (!persist) return nextProject;
  return saveProject(nextProject);
}

window.deployerx.onConfirmationRequest?.(async ({ id, message, detail, confirmLabel }) => {
  const confirmed = await confirmDangerousAction(message, detail, confirmLabel);
  await window.deployerx.resolveConfirmation?.({ id, confirmed });
});

function toggleConnectionAuthFields(authType, passwordField, keyFields) {
  passwordField.classList.toggle('hidden', authType !== 'password');
  keyFields.classList.toggle('hidden', authType !== 'key');
}

function syncSecretToggleButton(button, visible) {
  const showLabel = button.dataset.showLabel || 'Show value';
  const hideLabel = button.dataset.hideLabel || 'Hide value';
  const label = visible ? hideLabel : showLabel;
  const icon = button.querySelector('use');

  button.dataset.secretVisible = visible ? 'true' : 'false';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', visible ? 'true' : 'false');
  button.setAttribute('title', label);
  if (icon) icon.setAttribute('href', visible ? '#icon-eye-off' : '#icon-eye');
}

function setSecretVisibility(button, visible) {
  const input = document.getElementById(button.dataset.secretTarget || '');
  if (!input) return;
  input.type = visible ? 'text' : 'password';
  syncSecretToggleButton(button, visible);
}

function resetSecretVisibility(scope = document) {
  scope.querySelectorAll('[data-secret-toggle]').forEach((button) => setSecretVisibility(button, false));
}

function initializeSecretVisibilityToggles() {
  document.querySelectorAll('[data-secret-toggle]').forEach((button) => {
    syncSecretToggleButton(button, false);
    button.addEventListener('click', () => {
      const visible = button.dataset.secretVisible === 'true';
      setSecretVisibility(button, !visible);
    });
  });
}

function updateAuthFields() {
  toggleConnectionAuthFields(els.modalAuthType.value, els.modalPasswordField, els.modalKeyFields);
}

function updateFtpAuthFields() {
  toggleConnectionAuthFields(els.modalFtpAuthType.value, els.modalFtpPasswordField, els.modalFtpKeyFields);
}

function updateUploadFields() {
  els.runUploadFields.classList.toggle('hidden', !els.runNeedsUpload.checked);
}

function renderTemplateSelect() {
  els.modalTemplateSelect.innerHTML = '<option value="">No template</option>';
  for (const template of state.templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = `${template.name || 'Untitled template'} [${isBuiltInTemplate(template) ? 'Default' : 'Own'}]`;
    els.modalTemplateSelect.appendChild(option);
  }
  renderProjectTemplateSelect();
}

function renderProjectTemplateSelect() {
  els.projectTemplateSelect.innerHTML = '<option value="">Server commands</option>';
  for (const template of state.templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = `${template.name || 'Untitled template'} [${isBuiltInTemplate(template) ? 'Default' : 'Own'}]`;
    els.projectTemplateSelect.appendChild(option);
  }
}

function renderTemplateEditorState(template = null) {
  const builtIn = isBuiltInTemplate(template);
  els.deleteTemplateButton.disabled = !template || builtIn;
  els.duplicateTemplateButton.disabled = !template;
  els.templateEditorNote.classList.toggle('hidden', !builtIn);
  els.templateEditorNote.textContent = builtIn
    ? 'Library template: saving your edits creates a custom copy for this workspace. Duplicate also works if you want to keep the original open.'
    : '';
}

function updateTerminalStatus(text, connected = state.terminalConnected) {
  const terminalSession = getTerminalSession();
  if (terminalSession) {
    terminalSession.sessionId = state.activeTerminalSessionId;
    terminalSession.connected = Boolean(connected);
    terminalSession.status = text;
    terminalSession.pendingInput = state.pendingTerminalInput || '';
    terminalSession.outputBuffer = state.terminalOutputBuffer || '';
    terminalSession.rawBuffer = state.terminalRawBuffer || '';
    if (terminalSession.sessionId) state.terminalSessionProjectIds[terminalSession.sessionId] = terminalSession.projectId;
  }
  state.terminalConnected = Boolean(connected);
  els.terminalStatus.textContent = text;
  els.projectView.classList.toggle('terminal-connected', connected);
  els.projectView.classList.toggle(
    'terminal-needs-connect',
    Boolean(state.activeProject && !state.activeTerminalSessionId && !connected)
  );
  els.disconnectTerminalButton.disabled = !state.activeTerminalSessionId;
  els.connectTerminalButton.disabled = Boolean(state.activeTerminalSessionId);
  renderSshUploadPanel(terminalSession);
  renderProjects();
}

function setTerminalSessionStatus(session, text, connected = session?.connected) {
  if (!session) {
    updateTerminalStatus(text, connected);
    return;
  }

  session.status = text;
  session.connected = Boolean(connected);
  if (isVisibleTerminalSession(session)) {
    state.activeTerminalSessionId = session.sessionId;
    state.terminalConnected = session.connected;
    state.pendingTerminalInput = session.pendingInput || '';
    state.terminalOutputBuffer = session.outputBuffer || '';
    state.terminalRawBuffer = session.rawBuffer || '';
    updateTerminalStatus(text, connected);
  } else {
    renderProjects();
  }
}

function appendTerminalSessionOutput(session, data) {
  if (!session) {
    terminal.write(data);
    return;
  }

  session.output = `${session.output || ''}${String(data ?? '')}`.slice(-terminalReplayLimit);
  if (isVisibleTerminalSession(session)) terminal.write(data);
}

function fitTerminal() {
  if (els.appShell.classList.contains('hidden') || els.terminal.offsetParent === null) return;
  fitAddon.fit();
  if (terminal.cols < 80 || terminal.rows < 24) terminal.resize(Math.max(terminal.cols, 80), Math.max(terminal.rows, 24));
}

function resizeActiveTerminal() {
  if (!state.activeTerminalSessionId) return;
  window.deployerx.resizeTerminal({
    sessionId: state.activeTerminalSessionId,
    cols: terminal.cols,
    rows: terminal.rows
  });
}

async function applySelectedScriptTemplate() {
  if (!state.activeProject) return;

  const template = getTemplateById(els.projectTemplateSelect.value);
  if (!template) {
    els.commands.value = Array.isArray(state.activeProject.commands) ? state.activeProject.commands.join('\n') : '';
    return;
  }

  let project = state.activeProject;
  try {
    const nextProject = await ensureProjectVariables(project, template.commands || [], {
      persist: true,
      title: `Set variables for ${template.name || 'this template'}`,
      detail: 'This project is missing one or more template values. Enter them once and DeployerX will finish the script for you.',
      confirmLabel: 'Save and apply'
    });
    if (!nextProject) {
      els.projectTemplateSelect.value = '';
      els.commands.value = Array.isArray(state.activeProject.commands) ? state.activeProject.commands.join('\n') : '';
      return;
    }
    project = normalizeProject(nextProject);
    state.activeProject = structuredClone(project);
    renderDetailsSummary(project);
    renderProjects();
  } catch (error) {
    els.projectTemplateSelect.value = '';
    els.commands.value = Array.isArray(state.activeProject.commands) ? state.activeProject.commands.join('\n') : '';
    showAlert(error.message || 'Could not save project variables.');
    return;
  }

  const commands = resolveTemplateCommands(template.commands || [], project);
  els.commands.value = Array.isArray(commands) ? commands.join('\n') : '';
}

function renderTemplateVariableSummary(commands) {
  const variables = extractTemplateVariables(commands);
  if (!variables.length) {
    els.templateVariableSummary.innerHTML =
      '<span>No variables detected. Use {{name}} in commands to make a project variable.</span>';
    return;
  }

  els.templateVariableSummary.innerHTML = `
    <span>Server variables used by this template</span>
    <div class="template-variable-tags">
      ${variables.map((name) => `<code>{{${escapeHtml(name)}}}</code>`).join('')}
    </div>
  `;
}

function renderTemplateCategories() {
  const selectedCategory = els.templateCategory.value;
  const selectedDuplicateCategory = els.duplicateTemplateCategory.value;
  els.templateCategory.innerHTML = '<option value="">Select category</option>';
  els.duplicateTemplateCategory.innerHTML = '<option value="">Select category</option>';
  for (const category of templateCategories) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    els.templateCategory.appendChild(option);
    els.duplicateTemplateCategory.appendChild(option.cloneNode(true));
  }
  els.templateCategory.value = templateCategories.includes(selectedCategory) ? selectedCategory : '';
  els.duplicateTemplateCategory.value = templateCategories.includes(selectedDuplicateCategory) ? selectedDuplicateCategory : '';

  els.templateCategoryChips.innerHTML = '';
  for (const category of ['All', ...templateCategories]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `template-category-chip ${state.activeTemplateCategory === category ? 'active' : ''}`;
    chip.textContent = category;
    chip.addEventListener('click', () => {
      state.activeTemplateCategory = category;
      renderTemplateCategories();
      renderTemplates();
    });
    els.templateCategoryChips.appendChild(chip);
  }
}

function setSetupVisibility(visible) {
  els.startupLoader.classList.add('hidden');
  els.setupModal.classList.toggle('hidden', !visible);
  els.appShell.classList.toggle('hidden', visible);
  if (!visible) els.setupModal.classList.remove('auth-mode');
}

function updateAuthMode(mode) {
  state.auth.authMode = mode === 'register' ? 'register' : 'login';
  const isRegister = state.auth.authMode === 'register';
  els.emailVerificationNotice.classList.add('hidden');
  els.loginTabButton.classList.toggle('active', !isRegister);
  els.registerTabButton.classList.toggle('active', isRegister);
  els.signupNameFields.classList.toggle('hidden', !isRegister);
  els.confirmPasswordField.classList.toggle('hidden', !isRegister);
  els.authFirstName.required = isRegister;
  els.authLastName.required = isRegister;
  els.authConfirmPassword.required = isRegister;
  els.authSubmitButton.textContent = isRegister ? 'Create an account' : 'Login';
  els.authFooterText.textContent = isRegister ? 'Already have an account?' : 'Need an account?';
  els.authFooterSwitchButton.textContent = isRegister ? 'Login' : 'Sign Up';
  els.authPassword.autocomplete = isRegister ? 'new-password' : 'current-password';
  els.forgotPasswordButton.classList.toggle('hidden', isRegister);
}

function applySetupState(setup = {}) {
  if (Object.prototype.hasOwnProperty.call(setup, 'setupComplete')) state.setup.complete = Boolean(setup.setupComplete);
  if (Object.prototype.hasOwnProperty.call(setup, 'mode')) state.setup.mode = setup.mode || '';
  if (Object.prototype.hasOwnProperty.call(setup, 'firebase')) state.setup.firebase = setup.firebase || null;
  if (Object.prototype.hasOwnProperty.call(setup, 'session')) state.auth.session = setup.session || null;
  if (Object.prototype.hasOwnProperty.call(setup, 'activeTeamId')) state.teams.activeTeamId = setup.activeTeamId || '';
  state.teams.unlocked = Boolean(state.teams.activeTeamId);
  els.goOnlineButton.classList.toggle('hidden', state.setup.mode !== 'offline');
  renderSidebarWorkspace();
  els.teamButton.classList.remove('hidden');
  renderSettingsView();
}

function applyTeamSnapshot(snapshot = {}) {
  state.teams.teams = Array.isArray(snapshot.teams) ? snapshot.teams : [];
  state.teams.activeTeamId = snapshot.activeTeamId || '';
  state.teams.activeTeam = snapshot.activeTeam || null;
  state.teams.members = Array.isArray(snapshot.members) ? snapshot.members : [];
  state.teams.teamInvites = Array.isArray(snapshot.teamInvites) ? snapshot.teamInvites : [];
  state.teams.invites = Array.isArray(snapshot.invites) ? snapshot.invites : [];
  state.teams.unlocked = Boolean(state.teams.activeTeamId);
  state.teams.cloudError = snapshot.cloudError || '';
  renderTeamView();
  applySetupState({ setupComplete: state.setup.complete, mode: state.setup.mode, activeTeamId: state.teams.activeTeamId, session: state.auth.session });
}

function signedInForSettings() {
  return Boolean(state.auth.session && state.setup.mode === 'cloud');
}

function renderBackupHistory() {
  if (!els.backupHistoryList) return;
  const history = state.backupHistory.slice(-6).reverse();
  if (!history.length) {
    els.backupHistoryList.innerHTML = '<div class="settings-muted">No backup history yet.</div>';
    return;
  }
  els.backupHistoryList.innerHTML = history
    .map((item) => `
      <div class="backup-history-row">
        <span>
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.detail || '')}</small>
        </span>
        <time>${escapeHtml(item.time)}</time>
      </div>
    `)
    .join('');
}

function addBackupHistory(label, detail = '') {
  state.backupHistory.push({
    label,
    detail,
    time: new Date().toLocaleString()
  });
  renderBackupHistory();
}

function setSettingsTab(tab) {
  state.settingsTab = ['profile', 'workspace', 'members', 'backup'].includes(tab) ? tab : 'profile';
  renderSettingsView();
}

function renderSettingsView() {
  if (!els.settingsPanels?.length) return;
  const loggedIn = signedInForSettings();
  const session = state.auth.session || {};
  const activeTeam = state.teams.activeTeam;
  const displayName = session.displayName || session.email?.split('@')[0] || 'DeployerX user';
  const initial = (displayName || session.email || 'D').trim().charAt(0).toUpperCase();
  const verified = Boolean(session.emailVerified || session.provider === 'google.com');

  for (const item of els.settingsNavItems) {
    item.classList.toggle('active', item.dataset.settingsTab === state.settingsTab);
  }
  for (const panel of els.settingsPanels) {
    panel.classList.toggle('active', panel.dataset.settingsPanel === state.settingsTab);
  }

  document.querySelectorAll('.gated-settings-panel').forEach((panel) => {
    panel.classList.toggle('settings-locked', !loggedIn);
  });

  if (els.settingsProfileAvatar) els.settingsProfileAvatar.textContent = initial || 'D';
  if (els.settingsProfileName) els.settingsProfileName.textContent = displayName;
  if (els.settingsProfileEmail) els.settingsProfileEmail.textContent = session.email || 'Offline mode';
  if (els.settingsVerificationStatus) {
    els.settingsVerificationStatus.textContent = verified ? 'Verified' : 'Not verified';
    els.settingsVerificationStatus.classList.toggle('verified', verified);
    els.settingsVerificationStatus.classList.toggle('unverified', !verified);
  }
  if (els.settingsProfileNameInput) els.settingsProfileNameInput.value = displayName;
  if (els.settingsProfileEmailInput) els.settingsProfileEmailInput.value = session.email || '';
  if (els.settingsProfileLogoutButton) els.settingsProfileLogoutButton.disabled = !loggedIn;
  if (els.settingsWorkspaceName) els.settingsWorkspaceName.value = activeTeam?.name || 'DeployerX';
  if (els.deleteWorkspaceButton) {
    els.deleteWorkspaceButton.disabled = !activeTeam || activeTeam.role !== 'owner';
    els.deleteWorkspaceButton.title = activeTeam?.role === 'owner' ? '' : 'Only the workspace owner can delete this workspace.';
  }

  renderAppUpdateCard();
  renderBackupHistory();
}

function renderSidebarWorkspace() {
  if (!els.sidebarWorkspaceName || !els.sidebarWorkspaceMeta) return;

  const activeTeam = state.teams.activeTeam;
  let name = 'Local workspace';
  let meta = 'Offline mode';

  if (state.setup.mode === 'cloud') {
    name = activeTeam?.name || 'No workspace selected';
    meta = activeTeam?.role ? `Cloud workspace - ${activeTeam.role}` : 'Cloud workspace';
  }

  els.sidebarWorkspaceName.textContent = name;
  els.sidebarWorkspaceMeta.textContent = meta;
}

function renderIncomingInvites() {
  if (!els.incomingInvitesLists?.length) return;
  const invites = state.teams.invites || [];

  for (const list of els.incomingInvitesLists) {
    list.innerHTML = '';

    if (!invites.length) {
      list.innerHTML = '<div class="team-muted">No invites sent to you.</div>';
      continue;
    }

    for (const invite of invites) {
      const canAccept = Boolean(invite.teamId && invite.emailLower);
      const row = document.createElement('div');
      row.className = 'team-row';
      row.innerHTML = `
        <span class="team-row-copy">
          <strong>${escapeHtml(invite.teamName || 'Workspace invite')}</strong>
          <span>${escapeHtml(invite.email || invite.emailLower || '')} - ${escapeHtml(invite.role || 'member')}</span>
        </span>
        <span class="team-row-actions">
          <button class="button outline compact" type="button" data-accept-invite="${escapeHtml(invite.id)}" data-team-id="${escapeHtml(invite.teamId || '')}" ${canAccept ? '' : 'disabled'}>${canAccept ? 'Accept' : 'Unavailable'}</button>
        </span>
      `;
      row.querySelector('[data-accept-invite]')?.addEventListener('click', acceptInvite);
      list.appendChild(row);
    }
  }
}

function renderTeamView() {
  const activeTeam = state.teams.activeTeam;
  const activeRole = activeTeam?.role || '';
  const canManage = activeRole === 'owner';
  renderIncomingInvites();
  els.teamHeaderCopy.innerHTML = activeTeam
    ? `${escapeHtml(activeTeam.name)} <span class="team-status-pill unlocked">${escapeHtml(activeRole || 'member')}</span>`
    : 'Create or accept a workspace invite to start cloud sync.';
  els.teamCloudWarning.classList.toggle('hidden', !state.teams.cloudError);
  els.teamCloudWarning.innerHTML = state.teams.cloudError
    ? `<strong>Firebase cloud data is blocked</strong><span>${escapeHtml(state.teams.cloudError)}</span>`
    : '';

  els.teamSelect.innerHTML = '';
  if (!state.teams.teams.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No teams yet';
    els.teamSelect.appendChild(option);
  } else {
    for (const team of state.teams.teams) {
      const option = document.createElement('option');
      option.value = team.id;
      option.textContent = `${team.name || 'Team'} (${team.role || 'member'})`;
      els.teamSelect.appendChild(option);
    }
  }
  els.teamSelect.value = state.teams.activeTeamId || '';
  els.switchTeamButton.disabled = !state.teams.activeTeamId || els.teamSelect.value === state.teams.activeTeamId;
  els.importLocalToCloudButton.disabled = !state.teams.activeTeamId;

  const manageableTeams = state.teams.teams.filter((team) => team.role === 'owner');
  els.inviteTeamSelect.innerHTML = '';
  if (manageableTeams.length) {
    for (const team of manageableTeams) {
      const option = document.createElement('option');
      option.value = team.id;
      option.textContent = team.name || 'Workspace';
      els.inviteTeamSelect.appendChild(option);
    }
    els.inviteTeamSelect.value = manageableTeams.some((team) => team.id === state.teams.activeTeamId)
      ? state.teams.activeTeamId
      : manageableTeams[0].id;
  } else {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No owned workspaces';
    els.inviteTeamSelect.appendChild(option);
  }
  els.inviteTeamSelect.disabled = !manageableTeams.length;
  els.inviteMemberForm.querySelector('button').disabled = !manageableTeams.length;

  els.teamMembersList.innerHTML = '';
  if (!state.teams.members.length) {
    els.teamMembersList.innerHTML = '<div class="team-muted">No members yet.</div>';
  } else {
    for (const member of state.teams.members) {
      const isOwner = member.role === 'owner';
      const row = document.createElement('div');
      row.className = 'team-row';
      row.innerHTML = `
        <span class="team-row-copy">
          <strong>${escapeHtml(member.displayName || member.email || 'Member')}</strong>
          <span>${escapeHtml(member.email || '')} - ${escapeHtml(member.role || 'member')}</span>
        </span>
        <span class="team-row-actions">
          <span class="team-role-pill">${isOwner ? 'Owner' : 'Member'}</span>
          <button class="button plain danger compact" type="button" data-remove-member="${escapeHtml(member.uid)}" ${!canManage || isOwner ? 'disabled' : ''}>Remove</button>
        </span>
      `;
      row.querySelector('[data-remove-member]')?.addEventListener('click', removeMember);
      els.teamMembersList.appendChild(row);
    }
  }

  const pending = state.teams.teamInvites.map((invite) => ({ ...invite, personal: false }));
  els.pendingInvitesList.innerHTML = '';
  if (!pending.length) {
    els.pendingInvitesList.innerHTML = '<div class="team-muted">No invites sent from this workspace.</div>';
  } else {
    for (const invite of pending) {
      const canAccept = Boolean(invite.personal && invite.teamId && invite.emailLower);
      const canRevoke = Boolean(!invite.personal && canManage && invite.id);
      const actionButton = canAccept
        ? `<button class="button outline compact" type="button" data-accept-invite="${escapeHtml(invite.id)}" data-team-id="${escapeHtml(invite.teamId || '')}">Accept</button>`
        : canRevoke
          ? `<button class="button plain danger compact" type="button" data-revoke-invite="${escapeHtml(invite.id)}" data-team-id="${escapeHtml(invite.teamId || state.teams.activeTeamId || '')}">Revoke</button>`
          : '<button class="button outline compact" type="button" disabled>Pending</button>';
      const row = document.createElement('div');
      row.className = 'team-row';
      row.innerHTML = `
        <span class="team-row-copy">
          <strong>${escapeHtml(invite.teamName || invite.email || 'Invite')}</strong>
          <span>${escapeHtml(invite.email || invite.emailLower || '')} - ${escapeHtml(invite.role || 'member')}</span>
        </span>
        <span class="team-row-actions">
          ${actionButton}
        </span>
      `;
      row.querySelector('[data-accept-invite]')?.addEventListener('click', acceptInvite);
      row.querySelector('[data-revoke-invite]')?.addEventListener('click', revokeInvite);
      els.pendingInvitesList.appendChild(row);
    }
  }
}

function renderWorkspaceSetupPanel() {
  const teams = state.teams.teams || [];
  const hasTeams = teams.length > 0;
  const selectedTeamId = state.teams.activeTeamId || teams[0]?.id || '';

  els.workspaceSetupSelect.innerHTML = '';
  if (hasTeams) {
    for (const team of teams) {
      const option = document.createElement('option');
      option.value = team.id;
      option.textContent = team.name || 'Workspace';
      els.workspaceSetupSelect.appendChild(option);
    }
    els.workspaceSetupSelect.value = selectedTeamId;
  } else {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'New workspace';
    els.workspaceSetupSelect.appendChild(option);
  }

  els.workspaceSetupSelect.closest('.field').classList.toggle('hidden', !hasTeams);
  els.workspaceCreateForm.classList.toggle('hidden', hasTeams);
  els.workspaceContinueButton.classList.toggle('hidden', !hasTeams);
  els.workspaceSetupCopy.textContent = hasTeams
    ? 'Choose a workspace to load encrypted servers, templates, and SSH secrets.'
    : 'Create a workspace to keep servers, templates, and team members in cloud sync.';
}

function showWorkspaceSetupPanel() {
  setSetupVisibility(true);
  els.setupModal.classList.add('auth-mode');
  els.authPanel.classList.add('hidden');
  els.workspaceSetupPanel.classList.remove('hidden');
  renderWorkspaceSetupPanel();
  requestAnimationFrame(() => {
    if (state.teams.teams.length) els.workspaceContinueButton.focus();
    else els.workspaceCreateName.focus();
  });
}

function showAuthPanel() {
  els.setupModal.classList.add('auth-mode');
  els.workspaceSetupPanel.classList.add('hidden');
  els.authPanel.classList.remove('hidden');
  const configured = Boolean(state.setup.firebase?.configured);
  const googleConfigured = Boolean(state.setup.firebase?.googleConfigured);
  const note = !configured
    ? '<strong>Firebase Web config needed</strong><span>Add firebase.config.json with apiKey, authDomain, and projectId beside the app or in the app data folder.</span>'
    : !googleConfigured
      ? '<strong>Google login needs one more value</strong><span>Add googleClientId to firebase.config.json. Email and password login can still be used.</span>'
      : '';
  els.firebaseConfigWarning.classList.toggle('hidden', !note);
  els.firebaseConfigWarning.innerHTML = note;
  els.emailVerificationNotice.classList.add('hidden');
  els.authSubmitButton.disabled = !configured;
  els.googleLoginButton.disabled = !configured || !googleConfigured;
  els.googleLoginButton.title = !configured
    ? 'Add firebase.config.json first.'
    : !googleConfigured
      ? 'Add googleClientId to firebase.config.json to enable Google login.'
      : '';
  els.authEmail.focus();
}

function showAuthMessage(title, detail = '') {
  els.firebaseConfigWarning.classList.remove('hidden');
  els.firebaseConfigWarning.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}`;
}

function showEmailVerificationNotice(email = '') {
  setSetupVisibility(true);
  showAuthPanel();
  state.auth.authMode = 'login';
  updateAuthMode('login');
  els.authEmail.value = email || els.authEmail.value;
  els.emailVerificationCopy.textContent = email
    ? `We sent a verification link to ${email}. Open it, then login again.`
    : 'Open the verification link sent to your inbox, then login again.';
  els.emailVerificationNotice.classList.remove('hidden');
  els.firebaseConfigWarning.classList.add('hidden');
  els.authPassword.value = '';
  els.authSubmitButton.disabled = false;
}

function setAuthLoading(loading, label = '') {
  els.authSubmitButton.disabled = loading || !state.setup.firebase?.configured;
  els.googleLoginButton.disabled = loading || !state.setup.firebase?.configured || !state.setup.firebase?.googleConfigured;
  els.continueWithoutLoginButton.disabled = loading;
  els.forgotPasswordButton.disabled = loading;
  els.resendVerificationButton.disabled = loading;
  els.verificationLogoutButton.disabled = loading;
  els.authSubmitButton.textContent = loading ? label || 'Please wait...' : state.auth.authMode === 'register' ? 'Create an account' : 'Login';
  els.googleLoginButton.querySelector('span').textContent = loading && label === 'Opening Google...' ? 'Opening Google...' : 'Continue with Google';
}

function resetWorkspaceData() {
  state.projects = [];
  state.templates = [];
  state.activeProject = null;
  state.terminalSessions = {};
  state.terminalSessionProjectIds = {};
  state.ftpSessions = {};
  state.activeTerminalSessionId = null;
  state.terminalConnected = false;
  state.ftpSessionId = null;
  state.ftpConnected = false;
  state.pendingTerminalInput = '';
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';
  stopScriptQueue();
  closeTemplateEditor();
  renderTemplateSelect();
  renderProjects();
  renderTemplates();
}

async function enterCloudWorkspace() {
  if (!state.teams.activeTeamId) {
    showWorkspaceSetupPanel();
    return;
  }
  setSetupVisibility(false);
  await loadProjects();
  showView('dashboard');
}

async function continueCloudStartup() {
  if (state.teams.activeTeamId) {
    await enterCloudWorkspace();
    return;
  }

  resetWorkspaceData();
  showWorkspaceSetupPanel();
}

async function finishCloudAuth(result, isRegister = false) {
  state.auth.session = result.session || null;
  applySetupState({ setupComplete: true, mode: 'cloud', session: state.auth.session, firebase: state.setup.firebase });
  if (result.requiresEmailVerification || (state.auth.session && !state.auth.session.emailVerified && state.auth.session.provider !== 'google.com')) {
    resetWorkspaceData();
    showEmailVerificationNotice(state.auth.session?.email || '');
    if (isRegister) showToast('Verification email sent. Check your inbox before continuing.');
    return;
  }
  applyTeamSnapshot(result.teams || {});
  els.authPassword.value = '';
  els.authConfirmPassword.value = '';
  resetWorkspaceData();
  if (state.teams.activeTeamId) await enterCloudWorkspace();
  else showWorkspaceSetupPanel();
  if (isRegister) showToast('Confirmation email sent. Check your inbox to verify this account.');
}

async function activateOfflineMode() {
  try {
    const setup = await window.deployerx.setSetupMode('offline');
    state.auth.session = null;
    state.teams = { teams: [], activeTeamId: '', activeTeam: null, members: [], teamInvites: [], invites: [], unlocked: false, cloudError: '' };
    applySetupState(setup);
    setSetupVisibility(false);
    showView('dashboard');
    await loadProjects();
  } catch (error) {
    showAlert(error.message || 'Could not switch to offline mode.');
  }
}

async function activateCloudMode() {
  try {
    const setup = await window.deployerx.setSetupMode('cloud');
    applySetupState(setup);
    updateAuthMode('login');
    setSetupVisibility(true);
    showAuthPanel();
  } catch (error) {
    setSetupVisibility(true);
    showAuthPanel();
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const isRegister = state.auth.authMode === 'register';
  if (isRegister && els.authPassword.value !== els.authConfirmPassword.value) {
    showAlert('Password and Confirm Password must match.');
    els.authConfirmPassword.focus();
    return;
  }
  const payload = {
    firstName: els.authFirstName.value.trim(),
    lastName: els.authLastName.value.trim(),
    email: els.authEmail.value.trim(),
    password: els.authPassword.value
  };
  try {
    setAuthLoading(true, isRegister ? 'Creating account...' : 'Logging in...');
    const result =
      isRegister ? await window.deployerx.register(payload) : await window.deployerx.login(payload);
    await finishCloudAuth(result, isRegister);
  } catch (error) {
    showAuthMessage(isRegister ? 'Could not create account' : 'Login failed', friendlyAuthError(error, 'Check your details and try again.'));
  } finally {
    setAuthLoading(false);
  }
}

async function submitGoogleAuth() {
  try {
    setAuthLoading(true, 'Opening Google...');
    const result = await window.deployerx.loginWithGoogle();
    await finishCloudAuth(result);
  } catch (error) {
    showAuthMessage('Google login failed', friendlyAuthError(error, 'Check your Google login and try again.'));
  } finally {
    setAuthLoading(false);
  }
}

async function forgotPassword() {
  const email = els.authEmail.value.trim();
  if (!email) {
    showAuthMessage('Email required', 'Enter your email address first, then use Forgot password.');
    els.authEmail.focus();
    return;
  }
  try {
    setAuthLoading(true, 'Sending reset...');
    await window.deployerx.forgotPassword({ email });
    showAuthMessage('Reset email sent', `Check ${email} for the password reset link.`);
  } catch (error) {
    showAuthMessage('Could not send reset email', friendlyAuthError(error, 'Check the email address and try again.'));
  } finally {
    setAuthLoading(false);
  }
}

async function resendVerification() {
  try {
    setAuthLoading(true, 'Resending...');
    await window.deployerx.resendVerification();
    showEmailVerificationNotice(state.auth.session?.email || els.authEmail.value.trim());
    showToast('Verification email sent');
  } catch (error) {
    showAuthMessage('Could not resend verification', friendlyAuthError(error, 'Login again and try resending.'));
  } finally {
    setAuthLoading(false);
  }
}

async function logout(confirmFirst = true) {
  if (confirmFirst) {
    const ok = await confirmDangerousAction('Logout of the cloud account?', 'Cloud data will stay in Firebase. Local offline data is not affected.', 'Logout');
    if (!ok) return;
  }
  try {
    await disconnectAllProjectConnections();
    await window.deployerx.logout();
    state.auth.session = null;
    state.teams = { teams: [], activeTeamId: '', activeTeam: null, members: [], teamInvites: [], invites: [], unlocked: false, cloudError: '' };
    resetTerminalView();
    resetWorkspaceData();
    applySetupState({ setupComplete: true, mode: 'cloud', firebase: state.setup.firebase, session: null });
    setSetupVisibility(true);
    updateAuthMode('login');
    showAuthPanel();
  } catch (error) {
    showAlert(error.message || 'Could not logout.');
  }
}

async function refreshCloudSession() {
  const result = await window.deployerx.authSession();
  state.auth.session = result.session || null;
  if (result.teams) applyTeamSnapshot(result.teams);
  return result;
}

function sessionRequiresVerification(result) {
  return Boolean(
    result?.requiresEmailVerification ||
      (result?.session && !result.session.emailVerified && result.session.provider !== 'google.com')
  );
}

async function refreshCurrentPage() {
  if (pendingActions.has('page:refresh')) return;
  pendingActions.add('page:refresh');
  try {
    const currentView = state.currentView || 'dashboard';

    if (!state.setup.complete || !state.setup.mode) {
      const setup = await window.deployerx.getSetup();
      applySetupState(setup);
      renderTeamView();
      showToast('Page refreshed');
      return;
    }

    if (state.setup.mode === 'cloud') {
      const sessionResult = await refreshCloudSession();
      if (!sessionResult.session) {
        setSetupVisibility(true);
        showAuthPanel();
        showToast('Login required');
        return;
      }
      if (sessionRequiresVerification(sessionResult)) {
        showEmailVerificationNotice(sessionResult.session.email || '');
        return;
      }
    }

    if (currentView === 'dashboard' || currentView === 'templates' || currentView === 'project') {
      if (state.setup.mode === 'cloud' && !state.teams.activeTeamId) {
        resetWorkspaceData();
        showWorkspaceSetupPanel();
        showToast('Page refreshed');
        return;
      }

      const activeProjectId = state.activeProject?.id || '';
      await refreshProjectsAndTemplates();

      if (currentView === 'project') {
        const project = activeProjectId ? state.projects.find((item) => item.id === activeProjectId) : null;
        if (project) populateProjectView(project);
        else showView('dashboard');
      } else {
        showView(currentView);
      }
    } else {
      renderSettingsView();
      renderTeamView();
      showView('team');
    }

    showToast('Page refreshed');
  } catch (error) {
    showAlert(error.message || 'Could not refresh this page.');
  } finally {
    pendingActions.delete('page:refresh');
  }
}

async function createTeam(event) {
  event.preventDefault();
  const button = event.submitter || els.createTeamForm.querySelector('button[type="submit"]');
  try {
    const snapshot = await withButtonLoading('team:create', button, () =>
      window.deployerx.createTeam({
        name: els.createTeamName.value.trim()
      })
    );
    if (!snapshot) return;
    els.createTeamName.value = '';
    setModalVisible(false, els.createTeamModal);
    applyTeamSnapshot(snapshot);
    await loadProjects();
    showToast('Workspace created');
  } catch (error) {
    showAlert(error.message || 'Could not create team.');
  }
}

async function createWorkspace(event) {
  event.preventDefault();
  try {
    els.workspaceCreateButton.disabled = true;
    const snapshot = await window.deployerx.createTeam({
      name: els.workspaceCreateName.value.trim()
    });
    els.workspaceCreateName.value = '';
    applyTeamSnapshot(snapshot);
    await enterCloudWorkspace();
    showToast('Workspace created');
  } catch (error) {
    showAlert(error.message || 'Could not create workspace.');
  } finally {
    els.workspaceCreateButton.disabled = false;
  }
}

async function switchTeam() {
  const teamId = els.teamSelect.value;
  if (!teamId || teamId === state.teams.activeTeamId) return;
  try {
    const snapshot = await withButtonLoading('team:switch', els.switchTeamButton, () => window.deployerx.switchTeam(teamId));
    if (!snapshot) return;
    applyTeamSnapshot(snapshot);
    resetWorkspaceData();
    showView('team');
    showToast('Workspace switched');
  } catch (error) {
    showAlert(error.message || 'Could not switch team.');
  }
}

async function inviteMember(event) {
  event.preventDefault();
  const button = els.inviteMemberForm.querySelector('button[type="submit"]');
  try {
    const snapshot = await withButtonLoading('team:invite', button, () => window.deployerx.inviteTeamMember({
      teamId: els.inviteTeamSelect.value || state.teams.activeTeamId,
      email: els.inviteEmail.value.trim()
    }));
    if (!snapshot) return;
    els.inviteEmail.value = '';
    applyTeamSnapshot(snapshot);
    showToast('Invite created');
  } catch (error) {
    showAlert(error.message || 'Could not invite member.');
  }
}

async function acceptInvite(event) {
  const button = event.currentTarget;
  const inviteId = button.dataset.acceptInvite;
  try {
    const snapshot = await withButtonLoading(`team:accept:${inviteId}`, button, () =>
      window.deployerx.acceptTeamInvite({
        inviteId,
        teamId: button.dataset.teamId
      })
    );
    if (!snapshot) return;
    applyTeamSnapshot(snapshot);
    resetWorkspaceData();
    await enterCloudWorkspace();
    showToast('Invite accepted');
  } catch (error) {
    showAlert(error.message || 'Could not accept invite.');
  }
}

async function revokeInvite(event) {
  const button = event.currentTarget;
  const invite = state.teams.teamInvites.find((item) => item.id === button.dataset.revokeInvite);
  const ok = await confirmDangerousAction(
    `Revoke invite for ${invite?.email || invite?.emailLower || 'this email'}?`,
    'They will no longer be able to join this workspace from this invite.',
    'Revoke'
  );
  if (!ok) return;
  try {
    const snapshot = await withButtonLoading(`team:revoke:${button.dataset.revokeInvite}`, button, () =>
      window.deployerx.revokeTeamInvite({
        inviteId: button.dataset.revokeInvite,
        teamId: button.dataset.teamId
      })
    );
    if (!snapshot) return;
    applyTeamSnapshot(snapshot);
    showToast('Invite revoked');
  } catch (error) {
    showAlert(error.message || 'Could not revoke invite.');
  }
}

async function removeMember(event) {
  const uid = event.currentTarget.dataset.removeMember;
  const member = state.teams.members.find((item) => item.uid === uid);
  const ok = await confirmDangerousAction(
    `Remove ${member?.email || 'this member'}?`,
    'They will lose access to this team workspace.',
    'Remove'
  );
  if (!ok) return;
  try {
    const snapshot = await window.deployerx.removeTeamMember({ teamId: state.teams.activeTeamId, uid });
    applyTeamSnapshot(snapshot);
    showToast('Member removed');
  } catch (error) {
    showAlert(error.message || 'Could not remove member.');
  }
}

async function deleteWorkspace() {
  const team = state.teams.activeTeam;
  if (!team) return;
  const ok = await confirmDangerousAction(
    `Delete ${team.name || 'this workspace'}?`,
    'This permanently deletes the cloud workspace, members, invites, servers, and templates. This cannot be undone.',
    'Delete workspace'
  );
  if (!ok) return;
  try {
    const snapshot = await withButtonLoading('workspace:delete', els.deleteWorkspaceButton, () =>
      window.deployerx.deleteTeam({ teamId: state.teams.activeTeamId })
    );
    if (!snapshot) return;
    applyTeamSnapshot(snapshot);
    resetWorkspaceData();
    showWorkspaceSetupPanel();
    showToast('Workspace deleted');
  } catch (error) {
    showAlert(error.message || 'Could not delete workspace.');
  }
}

async function importLocalToCloud() {
  if (!state.teams.activeTeamId) return;
  const ok = await confirmDangerousAction(
    'Import local servers and templates to this cloud team?',
    'Items with the same id will be overwritten in the active cloud team.',
    'Import'
  );
  if (!ok) return;
  try {
    const result = await window.deployerx.importLocalToCloud();
    await refreshProjectsAndTemplates();
    showToast(`Imported ${result.projectCount} project${result.projectCount === 1 ? '' : 's'} and ${result.templateCount} template${result.templateCount === 1 ? '' : 's'}`);
  } catch (error) {
    showAlert(error.message || 'Could not import local data.');
  }
}

async function initializeApp() {
  try {
    hydrateStartupMetadata();
    refreshAppUpdateState().catch(() => {});
    const setup = await withTimeout(
      window.deployerx.getSetup(),
      STARTUP_IPC_TIMEOUT_MS,
      'Startup took too long. Please try again.'
    );
    applySetupState(setup);
    updateAuthMode('login');
    renderTeamView();

    if (!state.setup.complete || !state.setup.mode) {
      setSetupVisibility(true);
      showAuthPanel();
      return;
    }

    if (state.setup.mode === 'offline') {
      setSetupVisibility(false);
      showView('dashboard');
      await loadProjects();
      return;
    }

    const sessionRefreshPromise = refreshCloudSession();
    let sessionResult;
    try {
      sessionResult = await withTimeout(
        sessionRefreshPromise,
        CLOUD_SESSION_TIMEOUT_MS,
        'Cloud session took too long to refresh.'
      );
    } catch (error) {
      if (!state.auth.session) throw error;

      sessionRefreshPromise
        .then(async (lateResult) => {
          if (!lateResult.session) {
            setSetupVisibility(true);
            showAuthPanel();
            return;
          }
          if (sessionRequiresVerification(lateResult)) {
            showEmailVerificationNotice(lateResult.session.email || '');
            return;
          }
          if (state.setup.mode === 'cloud') await continueCloudStartup();
        })
        .catch(() => {});

      showToast('Restored your saved session while cloud sync reconnects.');
      await continueCloudStartup();
      return;
    }

    if (!sessionResult.session) {
      setSetupVisibility(true);
      showAuthPanel();
      return;
    }
    if (sessionRequiresVerification(sessionResult)) {
      showEmailVerificationNotice(sessionResult.session.email || '');
      return;
    }

    await continueCloudStartup();
  } catch (error) {
    showAlert(error.message || 'Could not initialize DeployerX.');
    setSetupVisibility(true);
    showAuthPanel();
  }
}

function addVariableRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'variable-row';
  row.innerHTML = `
    <input class="variable-key" type="text" placeholder="app_path" value="${escapeHtml(key)}" />
    <input class="variable-value" type="text" placeholder="/home/app" value="${escapeHtml(value)}" />
    <button class="icon-button variable-remove-button" type="button" aria-label="Remove variable">${icon('x')}</button>
  `;
  row.querySelector('.variable-remove-button').addEventListener('click', async () => {
    const variableName = normalizeVariableKey(row.querySelector('.variable-key')?.value);
    const ok = await confirmDangerousAction(
      `Remove variable${variableName ? ` "${variableName}"` : ''}?`,
      'This will remove the row from this project form.',
      'Remove'
    );
    if (!ok) return;
    row.remove();
  });
  els.modalVariablesList.appendChild(row);
}

function renderModalVariables(project) {
  els.modalVariablesList.innerHTML = '';
  const variables = normalizeVariables(project.variables);
  const entries = Object.entries(variables);

  if (!entries.length) {
    addVariableRow();
    return;
  }

  for (const [key, value] of entries) {
    addVariableRow(key, value);
  }
}

function readModalVariables() {
  const variables = {};
  for (const row of els.modalVariablesList.querySelectorAll('.variable-row')) {
    const key = normalizeVariableKey(row.querySelector('.variable-key')?.value);
    if (!key) continue;
    variables[key] = row.querySelector('.variable-value')?.value || '';
  }
  return variables;
}

function syncModalVariablesForTemplate() {
  const selectedTemplate = state.templates.find((template) => template.id === els.modalTemplateSelect.value);
  if (!selectedTemplate) return;

  const existingVariables = readModalVariables();
  for (const name of extractTemplateVariables(selectedTemplate.commands || [])) {
    if (builtInVariableNames.has(name)) continue;
    if (Object.prototype.hasOwnProperty.call(existingVariables, name)) continue;
    addVariableRow(name, '');
    existingVariables[name] = '';
  }
}

function fillModal(project) {
  const normalizedProject = normalizeProject(project);
  state.modalDraft = structuredClone(normalizedProject);
  resetSecretVisibility(els.projectModal);
  renderProjectGroupOptions();
  els.modalProjectName.value = normalizedProject.name || '';
  els.modalProjectGroup.value = normalizedProject.group || '';
  els.modalServerType.value = normalizedProject.serverType || 'ubuntu';
  renderTemplateSelect();
  els.modalTemplateSelect.value = '';
  renderModalVariables(normalizedProject);
  els.modalSshHost.value = normalizedProject.ssh?.host || '';
  els.modalSshPort.value = normalizedProject.ssh?.port || 22;
  els.modalSshUsername.value = normalizedProject.ssh?.username || '';
  els.modalAuthType.value = normalizedProject.ssh?.authType || 'password';
  els.modalSshPassword.value = normalizedProject.ssh?.password || '';
  els.modalPrivateKey.value = normalizedProject.ssh?.privateKey || '';
  els.modalKeyPassphrase.value = normalizedProject.ssh?.passphrase || '';
  els.modalFtpHost.value = normalizedProject.ftp?.host || '';
  els.modalFtpPort.value = normalizedProject.ftp?.port || '';
  els.modalFtpUsername.value = normalizedProject.ftp?.username || '';
  els.modalFtpAuthType.value = normalizedProject.ftp?.authType || (normalizedProject.ftp?.privateKey ? 'key' : normalizedProject.ftp?.password ? 'password' : '');
  els.modalFtpPassword.value = normalizedProject.ftp?.password || '';
  els.modalFtpPrivateKey.value = normalizedProject.ftp?.privateKey || '';
  els.modalFtpKeyPassphrase.value = normalizedProject.ftp?.passphrase || '';
  updateAuthFields();
  updateFtpAuthFields();
}

function readModalProject() {
  const selectedTemplate = state.templates.find((template) => template.id === els.modalTemplateSelect.value);
  const variables = readModalVariables();
  const ftpAuthType = els.modalFtpAuthType.value;

  const project = {
    ...state.modalDraft,
    name: els.modalProjectName.value.trim(),
    group: els.modalProjectGroup.value.trim(),
    serverType: els.modalServerType.value,
    variables,
    ssh: {
      host: els.modalSshHost.value.trim(),
      port: Number(els.modalSshPort.value || 22),
      username: els.modalSshUsername.value.trim(),
      authType: els.modalAuthType.value,
      password: els.modalSshPassword.value,
      privateKey: els.modalPrivateKey.value,
      passphrase: els.modalKeyPassphrase.value,
      timeout: 20000
    },
    ftp: {
      host: els.modalFtpHost.value.trim(),
      port: els.modalFtpPort.value ? Number(els.modalFtpPort.value) : '',
      username: els.modalFtpUsername.value.trim(),
      authType: ftpAuthType,
      password: ftpAuthType === 'password' ? els.modalFtpPassword.value : '',
      privateKey: ftpAuthType === 'key' ? els.modalFtpPrivateKey.value : '',
      passphrase: ftpAuthType === 'key' ? els.modalFtpKeyPassphrase.value : ''
    }
  };

  project.commands = selectedTemplate ? selectedTemplate.commands || [] : state.modalDraft.commands || [];

  return project;
}

function renderProjects() {
  els.projectList.innerHTML = '';
  els.projectGrid.innerHTML = '';
  if (els.dashboardStatsGrid) els.dashboardStatsGrid.innerHTML = '';
  if (els.dashboardHealthSummary) els.dashboardHealthSummary.innerHTML = '';
  if (els.dashboardGroupSummary) els.dashboardGroupSummary.innerHTML = '';
  if (els.dashboardServerSections) els.dashboardServerSections.innerHTML = '';
  if (els.sidebarServerCount) els.sidebarServerCount.textContent = String(state.projects.length);
  renderProjectGroupOptions();

  const renderServerCard = (project) => {
    const connectionState = projectConnectionState(project.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'project-card';
    card.innerHTML = `
      <div class="project-card-top">
        <span class="project-icon">${escapeHtml(projectBadge(project))}</span>
        <div class="project-card-meta">
          <strong>${escapeHtml(project.name || 'Untitled Server')}</strong>
          <span>${escapeHtml(project.serverType || 'server')} · ${escapeHtml(project.ssh?.host || 'no host')}</span>
        </div>
        <span class="project-card-action">${icon('chevron-right')}</span>
      </div>
      <div class="project-card-status-row">
        <span class="status-pill ${connectionState.ssh ? 'connected' : 'disconnected'}">SSH ${connectionState.ssh ? 'online' : 'offline'}</span>
        <span class="status-pill ${connectionState.ftp ? 'connected' : 'disconnected'}">FTP ${connectionState.ftp ? 'online' : 'offline'}</span>
      </div>
      <div class="project-card-note">${project.commands?.length || 0} saved commands</div>
    `;
    card.addEventListener('click', () => openProject(project.id));
    return card;
  };

  if (!state.projects.length) {
    const sidebarEmpty = document.createElement('div');
    sidebarEmpty.className = 'empty-project';
    sidebarEmpty.textContent = 'No servers yet';
    els.projectList.appendChild(sidebarEmpty);

    const empty = document.createElement('div');
    empty.className = 'project-card';
    empty.innerHTML = `
      <div class="project-card-top">
        <span class="project-icon">DX</span>
        <div class="project-card-meta">
          <strong>No servers yet</strong>
          <span>Add one to start.</span>
        </div>
      </div>
      <div class="project-card-note">Use Add server to save SSH details, groups, and deployment commands.</div>
    `;
    els.projectGrid.appendChild(empty);
    if (els.dashboardStatsGrid) {
      const emptyDashboard = document.createElement('div');
      emptyDashboard.className = 'dashboard-empty';
      emptyDashboard.innerHTML = '<strong>No servers saved</strong><span>Add your first server to start tracking stats and groups.</span>';
      els.dashboardStatsGrid.appendChild(emptyDashboard);
    }
    if (els.dashboardHealthSummary) els.dashboardHealthSummary.innerHTML = '<div class="dashboard-empty-inline">Save a server to see connection coverage.</div>';
    if (els.dashboardGroupSummary) els.dashboardGroupSummary.innerHTML = '<div class="dashboard-empty-inline">Groups appear here once servers are assigned.</div>';
    return;
  }

  for (const project of state.projects) {
    const connectionState = projectConnectionState(project.id);
    const sshStatus = connectionState.ssh ? 'SSH connected' : 'SSH disconnected';
    const ftpStatus = connectionState.ftp ? 'FTP connected' : 'FTP disconnected';
    const connectionDots = `
      <span class="project-connection-dots" aria-label="${sshStatus}. ${ftpStatus}.">
        <span class="project-status-dot ${connectionState.ssh ? 'connected' : 'disconnected'}" title="${sshStatus}"></span>
        <span class="project-status-dot ${connectionState.ftp ? 'connected' : 'disconnected'}" title="${ftpStatus}"></span>
      </span>
    `;
    const listItem = document.createElement('button');
    listItem.type = 'button';
    listItem.className = `project-item ${state.activeProject?.id === project.id ? 'active' : ''}`;
    listItem.innerHTML = `
      <span class="project-text">
        <strong>${escapeHtml(project.name || 'Untitled Server')}</strong>
        <span>${escapeHtml(project.serverType || 'server')} · ${escapeHtml(project.ssh?.host || 'no host')}</span>
      </span>
      ${connectionDots}
      <span class="project-item-action">${icon('chevron-right')}</span>
    `;
    listItem.addEventListener('click', () => openProject(project.id));
    els.projectList.appendChild(listItem);

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'project-card';
    card.innerHTML = `
      <div class="project-card-top">
        <span class="project-icon">${escapeHtml(projectBadge(project))}</span>
        <div class="project-card-meta">
          <strong>${escapeHtml(project.name || 'Untitled Server')}</strong>
          <span>${escapeHtml(project.serverType || 'server')} · ${escapeHtml(project.ssh?.host || 'no host')}</span>
        </div>
        <span class="project-card-action">${icon('chevron-right')}</span>
      </div>
      <div class="project-card-note">${project.commands?.length || 0} saved commands</div>
    `;
    card.addEventListener('click', () => openProject(project.id));
    els.projectGrid.appendChild(card);
  }

  const groups = groupProjects();
  const stats = dashboardStats();

  els.projectList.innerHTML = '';
  els.projectGrid.innerHTML = '';

  if (els.dashboardStatsGrid) {
    const statCards = [
      ['Servers', stats.total, 'Total saved systems'],
      ['Groups', stats.groups, 'Organized collections'],
      ['SSH online', stats.sshConnected, 'Active SSH sessions'],
      ['Saved commands', stats.commands, 'Deployment commands on hand']
    ];
    for (const [label, value, note] of statCards) {
      const statCard = document.createElement('article');
      statCard.className = 'dashboard-stat-card';
      statCard.innerHTML = `
        <span class="dashboard-stat-label">${escapeHtml(label)}</span>
        <strong class="dashboard-stat-value">${escapeHtml(value)}</strong>
        <span class="dashboard-stat-note">${escapeHtml(note)}</span>
      `;
      els.dashboardStatsGrid.appendChild(statCard);
    }
  }

  if (els.dashboardHealthSummary) {
    els.dashboardHealthSummary.innerHTML = `
      <div class="dashboard-health-row">
        <span>SSH connected</span>
        <strong>${stats.sshConnected} / ${stats.total}</strong>
      </div>
      <div class="dashboard-health-row">
        <span>FTP connected</span>
        <strong>${stats.ftpConnected} / ${stats.total}</strong>
      </div>
      <div class="dashboard-health-row">
        <span>Need attention</span>
        <strong>${stats.disconnected}</strong>
      </div>
    `;
  }

  for (const group of groups) {
    const summary = document.createElement('div');
    summary.className = 'dashboard-group-chip';
    summary.innerHTML = `
      <strong>${escapeHtml(group.name)}</strong>
      <span>${group.items.length} server${group.items.length === 1 ? '' : 's'}</span>
    `;
    if (els.dashboardGroupSummary) els.dashboardGroupSummary.appendChild(summary);

    const sidebarGroup = document.createElement('section');
    sidebarGroup.className = 'sidebar-server-group';
    sidebarGroup.innerHTML = `
      <div class="sidebar-server-group-header">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.items.length}</span>
      </div>
    `;

    const serverSection = document.createElement('section');
    serverSection.className = 'server-group-section';
    serverSection.innerHTML = `
      <div class="server-group-header">
        <div>
          <h2>${escapeHtml(group.name)}</h2>
          <p>${group.items.length} server${group.items.length === 1 ? '' : 's'} in this group</p>
        </div>
      </div>
      <div class="server-group-grid"></div>
    `;
    const serverGrid = serverSection.querySelector('.server-group-grid');

    const dashboardSection = document.createElement('section');
    dashboardSection.className = 'server-group-section';
    dashboardSection.innerHTML = `
      <div class="server-group-header">
        <div>
          <h2>${escapeHtml(group.name)}</h2>
          <p>${group.items.length} server${group.items.length === 1 ? '' : 's'} in this group</p>
        </div>
      </div>
      <div class="server-group-grid"></div>
    `;
    const dashboardGrid = dashboardSection.querySelector('.server-group-grid');

    for (const project of group.items) {
      const connectionState = projectConnectionState(project.id);
      const sshStatus = connectionState.ssh ? 'SSH connected' : 'SSH disconnected';
      const ftpStatus = connectionState.ftp ? 'FTP connected' : 'FTP disconnected';
      const connectionDots = `
        <span class="project-connection-dots" aria-label="${sshStatus}. ${ftpStatus}.">
          <span class="project-status-dot ${connectionState.ssh ? 'connected' : 'disconnected'}" title="${sshStatus}"></span>
          <span class="project-status-dot ${connectionState.ftp ? 'connected' : 'disconnected'}" title="${ftpStatus}"></span>
        </span>
      `;
      const listItem = document.createElement('button');
      listItem.type = 'button';
      listItem.className = `project-item ${state.activeProject?.id === project.id ? 'active' : ''}`;
      listItem.innerHTML = `
        <span class="project-text">
          <strong>${escapeHtml(project.name || 'Untitled Server')}</strong>
          <span>${escapeHtml(project.serverType || 'server')} · ${escapeHtml(project.ssh?.host || 'no host')}</span>
        </span>
        ${connectionDots}
        <span class="project-item-action">${icon('chevron-right')}</span>
      `;
      listItem.addEventListener('click', () => openProject(project.id));
      sidebarGroup.appendChild(listItem);

      serverGrid.appendChild(renderServerCard(project));
      dashboardGrid.appendChild(renderServerCard(project));
    }

    els.projectList.appendChild(sidebarGroup);
    els.projectGrid.appendChild(serverSection);
    if (els.dashboardServerSections) els.dashboardServerSections.appendChild(dashboardSection);
  }
}

function renderTemplatesLegacy() {
  els.templateList.innerHTML = '';
  const query = els.templateSearch.value.trim().toLowerCase();
  const visibleTemplates = state.templates.filter((template) => {
    const category = normalizeTemplateCategory(template.category);
    const categoryMatches = state.activeTemplateCategory === 'All' || category === state.activeTemplateCategory;
    const commands = Array.isArray(template.commands) ? template.commands.join('\n') : '';
    const variables = extractTemplateVariables(template.commands || []).join('\n');
    const searchMatches = !query || `${template.name || ''}\n${category}\n${commands}\n${variables}`.toLowerCase().includes(query);
    return categoryMatches && searchMatches;
  });

  if (!state.templates.length) {
    const empty = document.createElement('div');
    empty.className = 'template-empty';
    empty.innerHTML = '<strong>No templates</strong><span>Create reusable command lists.</span>';
    els.templateList.appendChild(empty);
    return;
  }

  if (!visibleTemplates.length) {
    const empty = document.createElement('div');
    empty.className = 'template-empty';
    empty.innerHTML = '<strong>No matching templates</strong><span>Try another category or search.</span>';
    els.templateList.appendChild(empty);
    return;
  }

  for (const template of visibleTemplates) {
    const variableCount = extractTemplateVariables(template.commands || []).length;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `template-item ${state.activeTemplateId === template.id ? 'active' : ''}`;
    item.innerHTML = `
      <span class="template-item-icon">${icon('templates')}</span>
      <strong>${escapeHtml(template.name || 'Untitled template')}</strong>
      <span>${template.commands?.length || 0} commands${variableCount ? ` · ${variableCount} variables` : ''}</span>
      <span class="template-item-action">${icon('chevron-right')}</span>
    `;
    setTemplateMetaLine(item, template, variableCount);
    item.addEventListener('click', () => selectTemplate(template.id));
    els.templateList.appendChild(item);
  }
}

function setTemplateMetaLineLegacy(item, template, variableCount) {
  const meta = item.querySelector('span:not(.template-item-icon):not(.template-item-action)');
  if (!meta) return;
  const category = normalizeTemplateCategory(template.category);
  const variableText = variableCount ? ` - ${variableCount} variables` : '';
  const scopeText = isBuiltInTemplate(template) ? 'Library - ' : '';
  meta.textContent = `${scopeText}${category} - ${template.commands?.length || 0} commands${variableText}`;
}

function renderTemplates() {
  els.templateList.innerHTML = '';
  const query = els.templateSearch.value.trim().toLowerCase();
  const visibleTemplates = state.templates.filter((template) => {
    const category = normalizeTemplateCategory(template.category);
    const categoryMatches = state.activeTemplateCategory === 'All' || category === state.activeTemplateCategory;
    const commands = Array.isArray(template.commands) ? template.commands.join('\n') : '';
    const variables = extractTemplateVariables(template.commands || []).join('\n');
    const searchMatches = !query || `${template.name || ''}\n${category}\n${commands}\n${variables}`.toLowerCase().includes(query);
    return categoryMatches && searchMatches;
  });

  if (!state.templates.length) {
    const empty = document.createElement('div');
    empty.className = 'template-empty';
    empty.innerHTML = '<strong>No templates</strong><span>Create reusable command lists.</span>';
    els.templateList.appendChild(empty);
    return;
  }

  if (!visibleTemplates.length) {
    const empty = document.createElement('div');
    empty.className = 'template-empty';
    empty.innerHTML = '<strong>No matching templates</strong><span>Try another category or search.</span>';
    els.templateList.appendChild(empty);
    return;
  }

  for (const template of visibleTemplates) {
    const variableCount = extractTemplateVariables(template.commands || []).length;
    const sourceLabel = isBuiltInTemplate(template) ? 'Default' : 'Own';
    const badgeClass = isBuiltInTemplate(template) ? 'template-badge' : 'template-badge own';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `template-item ${state.activeTemplateId === template.id ? 'active' : ''}`;
    item.innerHTML = `
      <span class="template-item-icon">${icon('templates')}</span>
      <strong>${escapeHtml(template.name || 'Untitled template')}</strong>
      <span class="template-item-meta">
        <span class="template-item-meta-text"></span>
        <span class="${badgeClass}">${sourceLabel}</span>
      </span>
      <span class="template-item-action">${icon('chevron-right')}</span>
    `;
    setTemplateMetaLine(item, template, variableCount);
    item.addEventListener('click', () => selectTemplate(template.id));
    els.templateList.appendChild(item);
  }
}

function setTemplateMetaLine(item, template, variableCount) {
  const meta = item.querySelector('.template-item-meta-text');
  if (!meta) return;
  const category = normalizeTemplateCategory(template.category);
  const variableText = variableCount ? ` - ${variableCount} variables` : '';
  meta.textContent = `${category} - ${template.commands?.length || 0} commands${variableText}`;
}

function selectTemplate(templateId) {
  const template = getTemplateById(templateId);
  if (!template) return;
  state.activeTemplateId = template.id;
  els.templateName.value = template.name || '';
  els.templateCategory.value = normalizeTemplateCategory(template.category);
  els.templateCommands.value = Array.isArray(template.commands) ? template.commands.join('\n') : '';
  renderTemplateVariableSummary(template.commands || []);
  renderTemplateEditorState(template);
  els.templatePageForm.classList.remove('hidden');
  renderTemplates();
}

function newTemplate() {
  state.activeTemplateId = '';
  els.templateName.value = '';
  els.templateCategory.value = '';
  els.templateCommands.value = '';
  renderTemplateVariableSummary([]);
  renderTemplateEditorState(null);
  els.templatePageForm.classList.remove('hidden');
  renderTemplates();
}

function closeTemplateEditor() {
  state.activeTemplateId = '';
  els.templateName.value = '';
  els.templateCategory.value = '';
  els.templateCommands.value = '';
  renderTemplateVariableSummary([]);
  renderTemplateEditorState(null);
  els.templatePageForm.classList.add('hidden');
  renderTemplates();
}

function renderDetailsSummary(project) {
  const ftpSummary = hasCustomFtpDetails(project) ? 'Custom FTP details saved' : 'Uses SSH details';
  const rows = [
    ['Group', serverGroupName(project)],
    ['Server type', project.serverType || '-'],
    ['Host', project.ssh?.host || '-'],
    ['Port', project.ssh?.port || '22'],
    ['Username', project.ssh?.username || '-'],
    ['Authentication', project.ssh?.authType === 'key' ? 'SSH private key' : 'Password'],
    ['FTP', ftpSummary]
  ];

  els.detailsSummary.innerHTML = rows
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`
    )
    .join('');
}

function syncActiveFtpSession() {
  const ftpSession = getFtpSession(state.activeProject?.id, Boolean(state.activeProject));
  if (!ftpSession) return;
  ftpSession.sessionId = state.ftpSessionId;
  ftpSession.connected = Boolean(state.ftpConnected);
  ftpSession.localCurrentPath = state.ftpLocalCurrentPath || '';
  ftpSession.localParentPath = state.ftpLocalParentPath || '';
  ftpSession.localLoaded = Boolean(state.ftpLocalLoaded);
  ftpSession.localEntries = Array.isArray(state.ftpLocalEntries) ? [...state.ftpLocalEntries] : [];
  ftpSession.localSelectedPath = state.ftpLocalSelectedPath || '';
  ftpSession.localBackStack = [...state.ftpLocalBackStack];
  ftpSession.localForwardStack = [...state.ftpLocalForwardStack];
  ftpSession.localFilter = state.ftpLocalFilter || '';
  ftpSession.currentPath = state.ftpCurrentPath || '.';
  ftpSession.parentPath = state.ftpParentPath || '.';
  ftpSession.entries = Array.isArray(state.ftpEntries) ? [...state.ftpEntries] : [];
  ftpSession.selectedPath = state.ftpSelectedPath || '';
  ftpSession.backStack = [...state.ftpBackStack];
  ftpSession.forwardStack = [...state.ftpForwardStack];
  ftpSession.remoteFilter = state.ftpRemoteFilter || '';
}

function applyFtpSessionToState(projectId) {
  const ftpSession = getFtpSession(projectId);
  state.ftpSessionId = ftpSession?.sessionId || null;
  state.ftpConnected = Boolean(ftpSession?.connected);
  state.ftpLocalCurrentPath = ftpSession?.localCurrentPath || '';
  state.ftpLocalParentPath = ftpSession?.localParentPath || '';
  state.ftpLocalLoaded = Boolean(ftpSession?.localLoaded);
  state.ftpLocalEntries = Array.isArray(ftpSession?.localEntries) ? [...ftpSession.localEntries] : [];
  state.ftpLocalSelectedPath = ftpSession?.localSelectedPath || '';
  state.ftpLocalBackStack = Array.isArray(ftpSession?.localBackStack) ? [...ftpSession.localBackStack] : [];
  state.ftpLocalForwardStack = Array.isArray(ftpSession?.localForwardStack) ? [...ftpSession.localForwardStack] : [];
  state.ftpLocalFilter = ftpSession?.localFilter || '';
  state.ftpCurrentPath = ftpSession?.currentPath || '.';
  state.ftpParentPath = ftpSession?.parentPath || '.';
  state.ftpEntries = Array.isArray(ftpSession?.entries) ? [...ftpSession.entries] : [];
  state.ftpSelectedPath = ftpSession?.selectedPath || '';
  state.ftpBackStack = Array.isArray(ftpSession?.backStack) ? [...ftpSession.backStack] : [];
  state.ftpForwardStack = Array.isArray(ftpSession?.forwardStack) ? [...ftpSession.forwardStack] : [];
  state.ftpRemoteFilter = ftpSession?.remoteFilter || '';
}

function updateFtpStatus(message, connected = state.ftpConnected) {
  state.ftpConnected = Boolean(connected);
  syncActiveFtpSession();
  els.ftpStatus.textContent = message;
  els.ftpWorkspace.classList.toggle('terminal-connected', state.ftpConnected);
  els.connectFtpButton.disabled = state.ftpConnected;
  els.disconnectFtpButton.disabled = !state.ftpSessionId;
  els.ftpPathInput.disabled = !state.ftpConnected;
  els.ftpBackButton.disabled = !state.ftpConnected || !state.ftpBackStack.length;
  els.ftpForwardButton.disabled = !state.ftpConnected || !state.ftpForwardStack.length;
  els.ftpRemoteFilter.disabled = !state.ftpConnected;
  if (!state.ftpConnected) resetFtpRemoteDropState();
  renderFtpActionState();
  renderProjects();
}

function updateLocalFtpStatus(message = 'Local files') {
  els.ftpLocalStatus.textContent = message;
  els.ftpLocalPathInput.disabled = !state.activeProject;
  els.ftpLocalPathPickerButton.disabled = !state.activeProject;
  els.ftpLocalBackButton.disabled = !state.ftpLocalBackStack.length;
  els.ftpLocalForwardButton.disabled = !state.ftpLocalForwardStack.length;
  renderFtpActionState();
}

function selectedFtpLocalEntry() {
  return state.ftpLocalEntries.find((entry) => entry.path === state.ftpLocalSelectedPath) || null;
}

function selectedFtpEntry() {
  return state.ftpEntries.find((entry) => entry.path === state.ftpSelectedPath) || null;
}

function renderFtpActionState() {
  hideFtpContextMenu();
}

function renderFtpRow(entry, selected, onSelect, onOpen, onContextMenu) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `ftp-row ${selected ? 'selected' : ''}`;
  row.innerHTML = `
    <span class="ftp-name">${icon(entry.type === 'directory' ? 'folder-open' : 'templates')}<strong>${escapeHtml(entry.name)}</strong></span>
    <span>${escapeHtml(formatFtpDate(entry.modifiedAt))}</span>
    <span>${entry.type === 'directory' ? '-' : escapeHtml(formatBytes(entry.size))}</span>
    <span>${escapeHtml(entry.mode || (entry.type === 'directory' ? 'folder' : 'file'))}</span>
  `;
  row.addEventListener('click', onSelect);
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    onSelect();
    if (onContextMenu) onContextMenu(event);
  });
  row.addEventListener('dblclick', () => {
    if (entry.type === 'directory') onOpen();
  });
  return row;
}

function renderLocalFtpBrowser() {
  els.ftpLocalPathInput.value = state.ftpLocalCurrentPath || '';
  els.ftpLocalFilter.value = state.ftpLocalFilter;
  els.ftpLocalFileList.innerHTML = '';

  if (!state.ftpLocalLoaded) {
    const empty = document.createElement('div');
    empty.className = 'ftp-empty';
    empty.textContent = 'Loading local files...';
    empty.addEventListener('contextmenu', (event) => showFtpContextMenu(event, 'local'));
    els.ftpLocalFileList.appendChild(empty);
    return;
  }

  const entries = filteredEntries(state.ftpLocalEntries, state.ftpLocalFilter);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'ftp-empty';
    empty.textContent = state.ftpLocalFilter ? 'No local matches.' : 'This local folder is empty.';
    empty.addEventListener('contextmenu', (event) => showFtpContextMenu(event, 'local'));
    els.ftpLocalFileList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    els.ftpLocalFileList.appendChild(
      renderFtpRow(
        entry,
        entry.path === state.ftpLocalSelectedPath,
        () => {
          state.ftpLocalSelectedPath = entry.path;
          renderFtpBrowser();
        },
        () => openLocalFtpPath(entry.path, { pushHistory: true }).catch((error) => showAlert(error.message || 'Could not open local folder.')),
        (event) => showFtpContextMenu(event, 'local', entry)
      )
    );
  }
}

function renderRemoteFtpBrowser() {
  els.ftpPathInput.value = state.ftpCurrentPath || '.';
  els.ftpRemoteFilter.value = state.ftpRemoteFilter;
  els.ftpFileList.innerHTML = '';

  if (!state.ftpConnected) {
    const empty = document.createElement('div');
    empty.className = 'ftp-empty';
    empty.textContent = 'Connect FTP to browse this server.';
    empty.addEventListener('contextmenu', (event) => showFtpContextMenu(event, 'remote'));
    els.ftpFileList.appendChild(empty);
    return;
  }

  const entries = filteredEntries(state.ftpEntries, state.ftpRemoteFilter);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'ftp-empty';
    empty.textContent = state.ftpRemoteFilter ? 'No server matches.' : 'This server folder is empty. Drop files or folders here to upload.';
    empty.addEventListener('contextmenu', (event) => showFtpContextMenu(event, 'remote'));
    els.ftpFileList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    els.ftpFileList.appendChild(
      renderFtpRow(
        entry,
        entry.path === state.ftpSelectedPath,
        () => {
          state.ftpSelectedPath = entry.path;
          renderFtpBrowser();
        },
        () => openFtpPath(entry.path, { pushHistory: true }).catch((error) => showAlert(error.message || 'Could not open server folder.')),
        (event) => showFtpContextMenu(event, 'remote', entry)
      )
    );
  }
}

function renderFtpBrowser() {
  renderLocalFtpBrowser();
  renderRemoteFtpBrowser();
  updateLocalFtpStatus(fileNameFromPath(state.ftpLocalCurrentPath) || 'Local files');
  updateFtpStatus(state.ftpConnected ? 'Connected' : 'Not connected', state.ftpConnected);
  syncActiveFtpSession();
}

async function persistActiveProjectLocalSettings(localPath = state.ftpLocalCurrentPath) {
  if (!state.activeProject?.id) return;
  await window.deployerx.setProjectLocalSettings(state.activeProject.id, {
    ftpLocalPath: localPath || ''
  });
}

async function ensureActiveProjectLocalFtpReady(projectId = state.activeProject?.id) {
  const activeProjectId = String(projectId || '').trim();
  if (!activeProjectId) return;

  const ftpSession = getFtpSession(activeProjectId, true);
  if (ftpSession?.localLoaded && ftpSession.localCurrentPath) return;

  let targetPath = ftpSession?.localCurrentPath || '';
  if (!targetPath) {
    const localSettings = await window.deployerx.getProjectLocalSettings(activeProjectId);
    targetPath = String(localSettings?.ftpLocalPath || '').trim();
    if (state.activeProject?.id === activeProjectId && targetPath) {
      state.ftpLocalCurrentPath = targetPath;
      state.ftpLocalLoaded = false;
      renderFtpBrowser();
    }
  }

  if (state.activeProject?.id !== activeProjectId) return;

  try {
    await refreshLocalFtpList(targetPath || undefined, { persist: false, projectId: activeProjectId });
  } catch (error) {
    if (!targetPath) throw error;
    await window.deployerx.setProjectLocalSettings(activeProjectId, { ftpLocalPath: '' });
    await refreshLocalFtpList(undefined, { persist: false, projectId: activeProjectId });
    showAlert('Your saved local folder was not found, so the FTP pane opened your home folder instead.');
  }
}

async function refreshLocalFtpList(pathOverride = state.ftpLocalCurrentPath, options = {}) {
  const targetProjectId = String(options.projectId || state.activeProject?.id || '').trim();
  const previousPath = state.ftpLocalCurrentPath;
  const result = await withFileActivity('Loading local files...', () => window.deployerx.localList({ path: pathOverride || undefined }));
  if (targetProjectId && state.activeProject?.id !== targetProjectId) return;
  state.ftpLocalCurrentPath = result.path || pathOverride || '';
  state.ftpLocalParentPath = result.parentPath || '';
  state.ftpLocalLoaded = true;
  state.ftpLocalEntries = Array.isArray(result.items) ? result.items : [];
  state.ftpLocalSelectedPath = '';
  if (options.pushHistory && previousPath && previousPath !== state.ftpLocalCurrentPath) {
    state.ftpLocalBackStack.push(previousPath);
    state.ftpLocalForwardStack = [];
  }
  updateLocalFtpStatus(fileNameFromPath(state.ftpLocalCurrentPath) || 'Local files');
  renderFtpBrowser();
  if (options.persist !== false && state.ftpLocalCurrentPath) {
    persistActiveProjectLocalSettings(state.ftpLocalCurrentPath).catch(() => {});
  }
}

async function refreshFtpList(pathOverride = state.ftpCurrentPath, options = {}) {
  if (!state.ftpSessionId) return;
  const previousPath = state.ftpCurrentPath;
  updateFtpStatus('Loading...', true);
  try {
    const result = await withFileActivity('Loading server files...', () =>
      window.deployerx.ftpList({
        sessionId: state.ftpSessionId,
        path: pathOverride || '.'
      })
    );
    state.ftpCurrentPath = result.path || pathOverride || '.';
    state.ftpParentPath = result.parentPath || parentFtpPath(state.ftpCurrentPath);
    state.ftpEntries = Array.isArray(result.items) ? result.items : [];
    state.ftpSelectedPath = '';
    if (options.pushHistory && previousPath && previousPath !== state.ftpCurrentPath) {
      state.ftpBackStack.push(previousPath);
      state.ftpForwardStack = [];
    }
    updateFtpStatus('Connected', true);
    renderFtpBrowser();
  } catch (error) {
    updateFtpStatus(state.ftpConnected ? 'Connected' : 'Not connected', state.ftpConnected);
    throw error;
  }
}

async function connectFtp() {
  if (!state.activeProject || state.ftpSessionId || pendingActions.has('ftp:connect')) return;
  try {
    updateFtpStatus('Connecting...', false);
    const sessionId = `${Date.now()}`;
    const response = await withButtonLoading('ftp:connect', els.connectFtpButton, () =>
      window.deployerx.ftpConnect({
        sessionId,
        project: state.activeProject
      })
    );
    if (!response) return;
    state.ftpSessionId = response.sessionId || sessionId;
    state.ftpCurrentPath = response.path || '.';
    state.ftpEntries = [];
    state.ftpBackStack = [];
    state.ftpForwardStack = [];
    updateFtpStatus('Connected', true);
    if (!state.ftpLocalLoaded) await ensureActiveProjectLocalFtpReady();
    await refreshFtpList(state.ftpCurrentPath);
  } catch (error) {
  state.ftpSessionId = null;
  state.ftpConnected = false;
  state.ftpCurrentPath = '.';
  state.ftpParentPath = '.';
  state.ftpEntries = [];
  state.ftpSelectedPath = '';
  state.ftpBackStack = [];
  state.ftpForwardStack = [];
    updateFtpStatus('Connection failed', false);
    renderFtpBrowser();
    showAlert(error.message || 'Could not connect FTP.');
  }
}

async function disconnectFtp() {
  if (!state.ftpSessionId || pendingActions.has('ftp:disconnect')) return;
  await withButtonLoading('ftp:disconnect', els.disconnectFtpButton, () => window.deployerx.ftpDisconnect(state.ftpSessionId));
  state.ftpSessionId = null;
  state.ftpConnected = false;
  state.ftpCurrentPath = '.';
  state.ftpParentPath = '.';
  state.ftpEntries = [];
  state.ftpSelectedPath = '';
  state.ftpBackStack = [];
  state.ftpForwardStack = [];
  renderFtpBrowser();
}

async function openLocalFtpPath(localPath, options = {}) {
  await refreshLocalFtpList(localPath || els.ftpLocalPathInput.value, options);
}

async function chooseLocalFtpPath() {
  if (!state.activeProject) return;
  const localPath = await window.deployerx.selectLocalFolder(state.ftpLocalCurrentPath || '');
  if (!localPath) return;
  await openLocalFtpPath(localPath, { pushHistory: true });
}

async function openFtpPath(remotePath, options = {}) {
  if (!state.ftpConnected) return;
  await refreshFtpList(remotePath || els.ftpPathInput.value || '.', options);
}

async function goLocalFtpHistory(direction) {
  const fromPath = state.ftpLocalCurrentPath;
  const stackFrom = direction < 0 ? state.ftpLocalBackStack : state.ftpLocalForwardStack;
  const stackTo = direction < 0 ? state.ftpLocalForwardStack : state.ftpLocalBackStack;
  const nextPath = stackFrom.pop();
  if (!nextPath) return;
  if (fromPath) stackTo.push(fromPath);
  try {
    await refreshLocalFtpList(nextPath);
  } catch (error) {
    stackFrom.push(nextPath);
    if (fromPath) stackTo.pop();
    throw error;
  }
}

async function goFtpHistory(direction) {
  if (!state.ftpConnected) return;
  const fromPath = state.ftpCurrentPath;
  const stackFrom = direction < 0 ? state.ftpBackStack : state.ftpForwardStack;
  const stackTo = direction < 0 ? state.ftpForwardStack : state.ftpBackStack;
  const nextPath = stackFrom.pop();
  if (!nextPath) return;
  if (fromPath) stackTo.push(fromPath);
  try {
    await refreshFtpList(nextPath);
  } catch (error) {
    stackFrom.push(nextPath);
    if (fromPath) stackTo.pop();
    throw error;
  }
}

function hideFtpContextMenu() {
  if (!els.ftpContextMenu) return;
  els.ftpContextMenu.classList.add('hidden');
  els.ftpContextMenu.setAttribute('aria-hidden', 'true');
}

function promptFileName(title, currentName = '') {
  const value = window.prompt(title, currentName);
  if (value === null) return '';
  return value.trim();
}

async function openLocalFtpEntry(entry) {
  if (!entry) return;
  if (entry.type === 'directory') {
    await openLocalFtpPath(entry.path, { pushHistory: true });
    return;
  }
  await window.deployerx.localOpen({ entry });
}

async function openLocalFtpEntryWith(entry) {
  if (!entry || entry.type === 'directory') return;
  await window.deployerx.localOpenWith({ entry });
}

async function renameLocalFtpEntry(entry) {
  if (!entry) return;
  const name = promptFileName('Rename local item', entry.name);
  if (!name || name === entry.name) return;
  await window.deployerx.localRename({ entry, name });
  await refreshLocalFtpList();
  showToast('Local item renamed');
}

async function openRemoteFtpEntry(entry) {
  if (!entry || !state.ftpSessionId) return;
  if (entry.type === 'directory') {
    await openFtpPath(entry.path, { pushHistory: true });
    return;
  }
  await window.deployerx.ftpOpen({ sessionId: state.ftpSessionId, entry });
}

async function openRemoteFtpEntryWith(entry) {
  if (!entry || entry.type === 'directory' || !state.ftpSessionId) return;
  await window.deployerx.ftpOpenWith({ sessionId: state.ftpSessionId, entry });
}

async function renameRemoteFtpEntry(entry) {
  if (!entry || !state.ftpSessionId) return;
  const name = promptFileName('Rename server item', entry.name);
  if (!name || name === entry.name) return;
  await window.deployerx.ftpRename({ sessionId: state.ftpSessionId, entry, name });
  await refreshFtpList();
  showToast('Server item renamed');
}

async function createFtpFolderFromMenu(pane) {
  const name = promptFileName('New folder name');
  if (!name) return;
  if (pane === 'local') await makeLocalFtpFolder(name);
  else await makeFtpFolder(name);
}

function getFtpContextItems(pane, entry) {
  const isLocal = pane === 'local';
  const hasEntry = Boolean(entry);
  const canUseLocalDirectory = Boolean(state.ftpLocalCurrentPath);
  const canUseRemoteDirectory = Boolean(state.ftpConnected && state.ftpSessionId);

  return [
    {
      label: 'Open',
      disabled: !hasEntry || (!isLocal && !canUseRemoteDirectory),
      action: () => (isLocal ? openLocalFtpEntry(entry) : openRemoteFtpEntry(entry))
    },
    {
      label: 'Open with...',
      disabled: !hasEntry || entry.type === 'directory' || (!isLocal && !canUseRemoteDirectory),
      action: () => (isLocal ? openLocalFtpEntryWith(entry) : openRemoteFtpEntryWith(entry))
    },
    {
      label: isLocal ? 'Upload' : 'Download',
      disabled: !hasEntry || (isLocal ? !canUseRemoteDirectory : !canUseLocalDirectory),
      action: () => (isLocal ? uploadFtpFile(entry) : downloadFtpFile(entry))
    },
    {
      label: 'Copy to target directory',
      disabled: !hasEntry || (isLocal ? !canUseRemoteDirectory : !canUseLocalDirectory),
      action: () => (isLocal ? uploadFtpFile(entry) : downloadFtpFile(entry))
    },
    {
      label: 'Rename',
      disabled: !hasEntry || (!isLocal && !canUseRemoteDirectory),
      action: () => (isLocal ? renameLocalFtpEntry(entry) : renameRemoteFtpEntry(entry))
    },
    {
      label: 'Delete',
      disabled: !hasEntry || (!isLocal && !canUseRemoteDirectory),
      action: () => (isLocal ? deleteLocalFtpEntry(entry) : deleteFtpEntry(entry))
    },
    {
      label: 'Refresh',
      disabled: isLocal ? !canUseLocalDirectory : !canUseRemoteDirectory,
      action: () => (isLocal ? refreshLocalFtpList() : refreshFtpList())
    },
    {
      label: 'New folder',
      disabled: isLocal ? !canUseLocalDirectory : !canUseRemoteDirectory,
      action: () => createFtpFolderFromMenu(pane)
    }
  ];
}

function showFtpContextMenu(event, pane, entry = null) {
  event.preventDefault();
  event.stopPropagation();
  const menu = els.ftpContextMenu;
  if (!menu) return;
  hideFtpContextMenu();
  menu.innerHTML = '';

  for (const item of getFtpContextItems(pane, entry)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitem';
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.addEventListener('click', () => {
      hideFtpContextMenu();
      Promise.resolve(item.action()).catch((error) => showAlert(error.message || 'Could not complete this action.'));
    });
    menu.appendChild(button);
  }

  menu.classList.remove('hidden');
  menu.setAttribute('aria-hidden', 'false');
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function uploadFtpFile(entryOverride = null) {
  const entry = entryOverride || selectedFtpLocalEntry();
  if (!entry) return;
  await uploadFtpPaths([entry.path]);
}

async function uploadFtpPaths(localPaths = []) {
  const paths = [...new Set(localPaths.map((localPath) => String(localPath || '').trim()).filter(Boolean))];
  if (!state.ftpSessionId || !paths.length || pendingActions.has('ftp:upload')) return;

  const label = paths.length === 1 ? fileNameFromPath(paths[0]) : `${paths.length} items`;
  const remoteDirectory = state.ftpCurrentPath;
  try {
    await withFileActivity(`Uploading ${label}...`, () =>
      withButtonLoading('ftp:upload', null, async () => {
        for (const localPath of paths) {
          await window.deployerx.ftpUpload({
            sessionId: state.ftpSessionId,
            localPath,
            remoteDirectory
          });
        }
      })
    );
    await refreshFtpList();
    showToast(paths.length === 1 ? `Uploaded ${label}` : `Uploaded ${paths.length} items`);
  } catch (error) {
    showAlert(error.message || 'Could not upload item.');
  }
}

function handleFtpRemoteDragEnter(event) {
  if (!hasDraggedFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  ftpRemoteDragDepth += 1;
  if (state.ftpConnected && state.ftpSessionId && !pendingActions.has('ftp:upload')) {
    setFtpRemoteDropActive(true);
  }
}

function handleFtpRemoteDragOver(event) {
  if (!hasDraggedFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  const droppable = Boolean(state.ftpConnected && state.ftpSessionId && !pendingActions.has('ftp:upload'));
  if (event.dataTransfer) event.dataTransfer.dropEffect = droppable ? 'copy' : 'none';
  setFtpRemoteDropActive(droppable);
}

function handleFtpRemoteDragLeave(event) {
  if (!hasDraggedFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.relatedTarget && els.ftpRemoteBrowser?.contains(event.relatedTarget)) return;
  ftpRemoteDragDepth = Math.max(0, ftpRemoteDragDepth - 1);
  if (!ftpRemoteDragDepth) setFtpRemoteDropActive(false);
}

async function handleFtpRemoteDrop(event) {
  if (!hasDraggedFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  resetFtpRemoteDropState();

  if (!state.ftpConnected || !state.ftpSessionId) {
    showAlert('Connect FTP before dropping files to upload.');
    return;
  }

  const localPaths = await droppedFtpLocalPaths(event);
  if (!localPaths.length) {
    showAlert('Could not read the dropped files. Try dropping local files or folders directly from Explorer.');
    return;
  }

  await uploadFtpPaths(localPaths);
}

async function downloadFtpFile(entryOverride = null) {
  const entry = entryOverride || selectedFtpEntry();
  if (!state.ftpSessionId || !entry || pendingActions.has('ftp:download')) return;
  try {
    await withFileActivity(`Downloading ${entry.name}...`, () =>
      withButtonLoading('ftp:download', null, () =>
        window.deployerx.ftpDownloadToDirectory({
          sessionId: state.ftpSessionId,
          entry,
          localDirectory: state.ftpLocalCurrentPath
        })
      )
    );
    await refreshLocalFtpList();
    showToast(`Downloaded ${entry.name}`);
  } catch (error) {
    showAlert(error.message || 'Could not download item.');
  }
}

async function makeLocalFtpFolder(nameOverride = '') {
  if (!state.ftpLocalCurrentPath || pendingActions.has('local:mkdir')) return;
  const name = String(nameOverride || '').trim();
  if (!name) return;
  try {
    await withButtonLoading('local:mkdir', null, () =>
      window.deployerx.localMkdir({
        directory: state.ftpLocalCurrentPath,
        name
      })
    );
    await refreshLocalFtpList();
    showToast('Local folder created');
  } catch (error) {
    showAlert(error.message || 'Could not create local folder.');
  }
}

async function makeFtpFolder(nameOverride = '') {
  if (!state.ftpSessionId || pendingActions.has('ftp:mkdir')) return;
  const name = String(nameOverride || '').trim();
  if (!name) return;
  try {
    await withButtonLoading('ftp:mkdir', null, () =>
      window.deployerx.ftpMkdir({
        sessionId: state.ftpSessionId,
        remoteDirectory: state.ftpCurrentPath,
        name
      })
    );
    await refreshFtpList();
    showToast('Server folder created');
  } catch (error) {
    showAlert(error.message || 'Could not create server folder.');
  }
}

async function deleteLocalFtpEntry(entryOverride = null) {
  const entry = entryOverride || selectedFtpLocalEntry();
  if (!entry || pendingActions.has('local:delete')) return;
  const ok = await confirmDangerousAction(
    `Delete local "${entry.name}"?`,
    entry.type === 'directory' ? 'This deletes the local folder and its contents.' : 'This deletes the local file.',
    'Delete'
  );
  if (!ok) return;
  try {
    await withButtonLoading('local:delete', null, () => window.deployerx.localDelete({ entry }));
    await refreshLocalFtpList();
    showToast('Local item deleted');
  } catch (error) {
    showAlert(error.message || 'Could not delete local item.');
  }
}

async function deleteFtpEntry(entryOverride = null) {
  const entry = entryOverride || selectedFtpEntry();
  if (!state.ftpSessionId || !entry || pendingActions.has('ftp:delete')) return;
  const ok = await confirmDangerousAction(
    `Delete server "${entry.name}"?`,
    entry.type === 'directory' ? 'This deletes the server folder and its contents.' : 'This action cannot be undone.',
    'Delete'
  );
  if (!ok) return;
  try {
    await withButtonLoading('ftp:delete', null, () =>
      window.deployerx.ftpDelete({
        sessionId: state.ftpSessionId,
        entry
      })
    );
    await refreshFtpList();
    showToast('Server item deleted');
  } catch (error) {
    showAlert(error.message || 'Could not delete server item.');
  }
}

function populateProjectView(project) {
  const normalizedProject = normalizeProject(project);
  state.activeProject = structuredClone(normalizedProject);
  const terminalSession = getTerminalSession(normalizedProject.id, true);
  getFtpSession(normalizedProject.id, true);
  applyTerminalSessionToState(normalizedProject.id);
  applyFtpSessionToState(normalizedProject.id);
  els.activeProjectName.textContent = normalizedProject.name || 'Untitled Server';
  els.terminalProjectLabel.textContent = 'SSH';
  renderVisibleTerminalSession(terminalSession);
  updateTerminalStatus(terminalSession.status || (terminalSession.connected ? 'Connected' : 'Not connected'), terminalSession.connected);
  updateFtpStatus(state.ftpConnected ? 'Connected' : 'Not connected', state.ftpConnected);
  els.projectTemplateSelect.value = '';
  els.commands.value = Array.isArray(normalizedProject.commands) ? normalizedProject.commands.join('\n') : '';
  renderDetailsSummary(normalizedProject);
  renderProjects();
  showView('project');
  setProjectTab(state.activeProjectTab);
  if (terminalSession.connected && terminalSession.sessionId && !terminalSession.homeDirectory) {
    ensureTerminalHomeDirectory(terminalSession.sessionId).catch(() => {});
  }
  if (state.activeProjectTab === 'ftp' && !state.ftpLocalLoaded) {
    ensureActiveProjectLocalFtpReady(normalizedProject.id).catch((error) => showAlert(error.message || 'Could not load local files.'));
  }
  requestAnimationFrame(() => {
    fitTerminal();
    if (!state.activeTerminalSessionId) els.connectTerminalButton.focus();
  });
}

async function refreshProjectsAndTemplates() {
  const data = await window.deployerx.listProjects();
  const activeProjectId = state.activeProject?.id || '';
  state.projects = (data.projects || []).map(normalizeProject);
  state.templates = (data.templates || []).map(normalizeTemplate);
  if (activeProjectId) {
    state.activeProject = state.projects.find((project) => project.id === activeProjectId) || null;
  }
  syncSelectedUptimeProject(state.uptime.selectedProjectId || activeProjectId);
  renderTemplateCategories();
  renderTemplates();
  renderTemplateSelect();
  renderUptimeProjectSelect();
  renderProjects();
}

async function loadProjects() {
  await refreshProjectsAndTemplates();
  state.activeProject = null;
  renderProjects();
  showView('dashboard');
}

async function saveProject(project) {
  const saved = normalizeProject(await window.deployerx.saveProject(normalizeProject(project)));
  const index = state.projects.findIndex((item) => item.id === saved.id);
  if (index >= 0) state.projects[index] = saved;
  else state.projects.unshift(saved);
  if (state.activeProject?.id === saved.id) state.activeProject = structuredClone(saved);
  return saved;
}

function exportPickerItems(type = state.exportPicker.type) {
  if (type === 'projects') {
    return state.projects.map((project) => ({
      id: String(project.id),
      title: project.name || 'Untitled Server',
      meta: `${serverGroupName(project)} - ${project.serverType || 'server'} - ${project.ssh?.host || 'no host'}`
    }));
  }

  return state.templates.filter((template) => !isBuiltInTemplate(template)).map((template) => {
    const variableCount = extractTemplateVariables(template.commands || []).length;
    return {
      id: String(template.id),
      title: template.name || 'Untitled template',
      meta: `${template.commands?.length || 0} commands${variableCount ? ` - ${variableCount} variables` : ''}`
    };
  });
}

function filteredExportPickerItems() {
  const query = els.exportPickerSearch.value.trim().toLowerCase();
  const items = exportPickerItems();
  if (!query) return items;
  return items.filter((item) => `${item.title} ${item.meta}`.toLowerCase().includes(query));
}

function updateExportPickerSelectionState(visibleItems = filteredExportPickerItems()) {
  const selectedCount = state.exportPicker.selectedIds.size;
  const visibleSelectedCount = visibleItems.filter((item) => state.exportPicker.selectedIds.has(item.id)).length;
  els.exportPickerCount.textContent = `${selectedCount} selected`;
  els.exportPickerSelectAll.checked = visibleItems.length > 0 && visibleSelectedCount === visibleItems.length;
  els.exportPickerSelectAll.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleItems.length;
  els.exportPickerExportButton.disabled = selectedCount === 0;
}

function renderExportPicker() {
  const visibleItems = filteredExportPickerItems();
  els.exportPickerList.innerHTML = '';

  if (!visibleItems.length) {
    const empty = document.createElement('div');
    empty.className = 'export-picker-empty';
    empty.textContent = 'No matches found.';
    els.exportPickerList.appendChild(empty);
    updateExportPickerSelectionState(visibleItems);
    return;
  }

  for (const item of visibleItems) {
    const row = document.createElement('label');
    row.className = 'export-picker-row';
    row.innerHTML = `
      <input class="export-check" type="checkbox" data-export-id="${escapeHtml(item.id)}" ${state.exportPicker.selectedIds.has(item.id) ? 'checked' : ''} />
      <span class="export-picker-copy">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.meta)}</span>
      </span>
    `;

    row.querySelector('input').addEventListener('change', (event) => {
      if (event.target.checked) state.exportPicker.selectedIds.add(item.id);
      else state.exportPicker.selectedIds.delete(item.id);
      updateExportPickerSelectionState(visibleItems);
    });

    els.exportPickerList.appendChild(row);
  }

  updateExportPickerSelectionState(visibleItems);
}

function openExportPicker(type) {
  const items = exportPickerItems(type);
  if (!items.length) {
    showToast(type === 'projects' ? 'No servers to export' : 'No templates to export');
    return;
  }

  state.exportPicker = {
    type,
    selectedIds: new Set(items.map((item) => item.id))
  };
  els.exportPickerTitle.textContent = type === 'projects' ? 'Export servers' : 'Export templates';
  els.exportPickerSubtitle.textContent =
    type === 'projects' ? 'Choose the servers to include in this JSON export.' : 'Choose the templates to include in this JSON export.';
  els.exportPickerSearch.placeholder = type === 'projects' ? 'Search servers' : 'Search templates';
  els.exportPickerSearch.value = '';
  setModalVisible(true, els.exportPickerModal);
  renderExportPicker();
  els.exportPickerSearch.focus();
}

function closeExportPicker() {
  setModalVisible(false, els.exportPickerModal);
  state.exportPicker = {
    type: '',
    selectedIds: new Set()
  };
  els.exportPickerSearch.value = '';
  els.exportPickerList.innerHTML = '';
}

function toggleExportPickerSelectAll() {
  const visibleItems = filteredExportPickerItems();
  for (const item of visibleItems) {
    if (els.exportPickerSelectAll.checked) state.exportPicker.selectedIds.add(item.id);
    else state.exportPicker.selectedIds.delete(item.id);
  }
  renderExportPicker();
}

async function confirmExportPicker(event) {
  event.preventDefault();
  const selectedIds = [...state.exportPicker.selectedIds];
  if (!selectedIds.length) return;

  try {
    const result =
      state.exportPicker.type === 'projects'
        ? await window.deployerx.exportProjects(selectedIds)
        : await window.deployerx.exportTemplates(selectedIds);
    if (result?.canceled) return;
    const itemName = state.exportPicker.type === 'projects' ? 'server' : 'template';
    closeExportPicker();
    showToast(`Exported ${result.count} ${itemName}${result.count === 1 ? '' : 's'}`);
  } catch (error) {
    showAlert(error.message || 'Could not export items.');
  }
}

function exportProjects() {
  openExportPicker('projects');
}

function importResultDetail(result, duplicateType = '') {
  const label = duplicateType ? `${duplicateType[0].toUpperCase()}${duplicateType.slice(1)}` : '';
  const skipped = Number(result?.[label ? `skipped${label}DuplicateCount` : 'skippedDuplicateCount'] || 0);
  const replaced = Number(result?.[label ? `replaced${label}DuplicateCount` : 'replacedDuplicateCount'] || 0);
  const parts = [];
  if (replaced) parts.push(`${replaced} replaced`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

async function importProjects() {
  try {
    const result = await window.deployerx.importProjects();
    if (result?.canceled) return;
    state.projects = (result.projects || []).map(normalizeProject);
    if (state.activeProject) {
      state.activeProject = state.projects.find((project) => project.id === state.activeProject.id) || state.activeProject;
    }
    renderProjects();
    showToast(`Imported ${result.count} server${result.count === 1 ? '' : 's'}${importResultDetail(result)}`);
  } catch (error) {
    showAlert(error.message || 'Could not import servers.');
  }
}

async function exportAccount() {
  try {
    const result = await window.deployerx.exportAccount();
    if (result?.canceled) return;
    addBackupHistory('Account exported', `${result.projectCount} servers, ${result.templateCount} templates`);
    showToast(`Exported ${result.projectCount} server${result.projectCount === 1 ? '' : 's'} and ${result.templateCount} template${result.templateCount === 1 ? '' : 's'}`);
  } catch (error) {
    showAlert(error.message || 'Could not export account.');
  }
}

async function importAccount() {
  try {
    const result = await window.deployerx.importAccount();
    if (result?.canceled) return;
    await refreshProjectsAndTemplates();
    closeTemplateEditor();
    renderProjects();
    renderTemplates();
    renderTemplateSelect();
    const projectDetail = importResultDetail(result, 'server');
    const templateDetail = importResultDetail(result, 'template');
    addBackupHistory('Account imported', `${result.projectCount} servers, ${result.templateCount} templates`);
    showToast(
      `Imported ${result.projectCount} server${result.projectCount === 1 ? '' : 's'}${projectDetail} and ${result.templateCount} template${result.templateCount === 1 ? '' : 's'}${templateDetail}`
    );
  } catch (error) {
    showAlert(error.message || 'Could not import account.');
  }
}

async function saveTemplate(event) {
  event.preventDefault();
  if (pendingActions.has('template:save')) return;
  const activeTemplate = getTemplateById(state.activeTemplateId);
  const template = {
    id: isBuiltInTemplate(activeTemplate) ? '' : state.activeTemplateId,
    name: els.templateName.value.trim(),
    category: els.templateCategory.value,
    commands: normalizeCommands(els.templateCommands.value),
    variables: extractTemplateVariables(els.templateCommands.value)
  };

  if (!template.name || !template.category || !template.commands.length) {
    els.templatePageForm.reportValidity();
    return;
  }

  try {
    const result = await withButtonLoading('template:save', els.templatePageSaveButton, () =>
      window.deployerx.saveTemplate(template)
    );
    if (!result) return;
  } catch (error) {
    showAlert(error.message || 'Could not save template.');
    return;
  }

  await refreshProjectsAndTemplates();
  closeTemplateEditor();
  showToast(isBuiltInTemplate(activeTemplate) ? 'Library template saved as custom copy' : 'Template saved');
}

async function deleteTemplate() {
  if (!state.activeTemplateId || pendingActions.has('template:delete')) return;
  const templateId = state.activeTemplateId;
  const template = getTemplateById(templateId);
  if (isBuiltInTemplate(template)) {
    showAlert('Library templates cannot be deleted. Duplicate one to customize it.');
    return;
  }
  const ok = await confirmDangerousAction(
    `Delete template "${template?.name || 'Untitled template'}"?`,
    'This action cannot be undone.',
    'Delete'
  );
  if (!ok || pendingActions.has('template:delete')) return;
  try {
    await withButtonLoading('template:delete', els.deleteTemplateButton, () => window.deployerx.deleteTemplate(templateId));
  } catch (error) {
    showAlert(error.message || 'Could not delete template.');
    return;
  }

  await refreshProjectsAndTemplates();
  closeTemplateEditor();
}

function closeDuplicateTemplateModal() {
  state.duplicateTemplateDraft = null;
  els.duplicateTemplateName.value = '';
  els.duplicateTemplateCategory.value = '';
  setModalVisible(false, els.duplicateTemplateModal);
}

function openDuplicateTemplateModal() {
  if (!state.activeTemplateId) return;

  const commands = normalizeCommands(els.templateCommands.value);
  if (!commands.length) return;
  if (!els.templateCategory.value) {
    els.templatePageForm.reportValidity();
    return;
  }

  const currentName = els.templateName.value.trim() || 'Untitled template';
  state.duplicateTemplateDraft = {
    commands,
    variables: extractTemplateVariables(commands)
  };
  els.duplicateTemplateName.value = `${currentName} (copy)`;
  els.duplicateTemplateCategory.value = els.templateCategory.value;
  setModalVisible(true, els.duplicateTemplateModal);
  els.duplicateTemplateName.focus();
  els.duplicateTemplateName.select();
}

async function duplicateTemplate(event) {
  event.preventDefault();
  if (pendingActions.has('template:duplicate')) return;
  const name = els.duplicateTemplateName.value.trim();
  const category = els.duplicateTemplateCategory.value;
  const draft = state.duplicateTemplateDraft;
  if (!name || !category || !draft) {
    els.duplicateTemplateForm.reportValidity();
    return;
  }

  try {
    const result = await withButtonLoading('template:duplicate', els.duplicateTemplateSaveButton, () =>
      window.deployerx.saveTemplate({
        name,
        category,
        commands: draft.commands,
        variables: draft.variables
      })
    );
    if (!result) return;
    const saved = normalizeTemplate(result);
    await refreshProjectsAndTemplates();
    closeDuplicateTemplateModal();
    selectTemplate(saved.id);
    showToast('Template duplicated');
  } catch (error) {
    showAlert(error.message || 'Could not duplicate template.');
  }
}

function exportTemplates() {
  openExportPicker('templates');
}

async function importTemplates() {
  try {
    const result = await window.deployerx.importTemplates();
    if (result?.canceled) return;
    await refreshProjectsAndTemplates();
    closeTemplateEditor();
    showToast(`Imported ${result.count} template${result.count === 1 ? '' : 's'}${importResultDetail(result)}`);
  } catch (error) {
    showAlert(error.message || 'Could not import templates.');
  }
}

async function openProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  populateProjectView(normalizeProject(project));
}

function openCreateModal() {
  state.modalMode = 'create';
  state.modalDraft = blankProject();
  els.projectModalTitle.textContent = 'Add server';
  els.projectModalSubtitle.textContent = 'Add server, SSH, and optional FTP details. Commands are managed inside the server.';
  fillModal(state.modalDraft);
  setModalVisible(true, els.projectModal);
}

function openEditModal() {
  if (!state.activeProject) return;
  state.modalMode = 'edit';
  els.projectModalTitle.textContent = 'Edit server';
  els.projectModalSubtitle.textContent = 'Update server, group, SSH, and optional FTP details.';
  fillModal(state.activeProject);
  setModalVisible(true, els.projectModal);
}

async function commitModalProject(event) {
  event.preventDefault();
  if (pendingActions.has('project:save')) return;
  let project = readModalProject();

  if (!project.name || !project.ssh.host || !project.ssh.username) {
    return;
  }

  if (project.ssh.authType === 'key' && !project.ssh.privateKey) {
    return;
  }

  if (project.ssh.authType !== 'key' && !project.ssh.password) {
    return;
  }

  let saved;
  try {
    saved = await withButtonLoading('project:save', els.projectModalSaveButton, async () => {
      const hydratedProject = await ensureProjectVariables(project, project.commands, {
        title: 'Set server variables',
        detail: 'This template needs a few values before the server can be saved.',
        confirmLabel: 'Save server'
      });
      if (!hydratedProject) return null;

      project = normalizeProject(hydratedProject);
      renderModalVariables(project);
      project.commands = resolveTemplateCommands(project.commands, project);
      return saveProject(project);
    });
    if (!saved) return;
  } catch (error) {
    showAlert(error.message || 'Could not save server.');
    return;
  }

  state.activeProject = saved;
  renderProjects();
  populateProjectView(saved);
  setModalVisible(false, els.projectModal);
}

async function saveCommands() {
  if (!state.activeProject || pendingActions.has('project:commands')) return;
  const updated = {
    ...state.activeProject,
    commands: normalizeCommands(els.commands.value)
  };
  let saved;
  try {
    saved = await withButtonLoading('project:commands', els.saveCommandsButton, () => saveProject(updated));
    if (!saved) return;
  } catch (error) {
    showAlert(error.message || 'Could not save server commands.');
    return;
  }

  state.activeProject = saved;
  renderDetailsSummary(saved);
  renderProjects();
}

async function deleteCurrentProject() {
  if (!state.activeProject || pendingActions.has('project:delete')) return;
  const projectId = state.activeProject.id;
  const projectName = state.activeProject.name;
  const ok = await confirmDangerousAction(
    `Delete server "${projectName}"?`,
    'This action cannot be undone.',
    'Delete'
  );
  if (!ok || pendingActions.has('project:delete')) return;
  try {
    await withButtonLoading('project:delete', els.deleteProjectButton, () => window.deployerx.deleteProject(projectId));
  } catch (error) {
    showAlert(error.message || 'Could not delete server.');
    return;
  }

  await disconnectProjectConnections(projectId);
  state.projects = state.projects.filter((project) => project.id !== projectId);
  state.activeProject = state.projects[0] || null;
  renderProjects();
  if (state.activeProject) {
    populateProjectView(state.activeProject);
  } else {
    showView('servers');
  }
}

function openRunModal() {
  if (!state.activeProject) return;
  els.runNeedsUpload.checked = false;
  els.uploadLocalPath.value = '';
  els.uploadRemotePath.value = '';
  updateUploadFields();
  setModalVisible(true, els.uploadModal);
}

async function startDeployment(event) {
  if (event?.preventDefault) event.preventDefault();
  if (!state.activeProject) return;

  const rawCommands = normalizeCommands(els.commands.value);
  let hydratedProject;
  try {
    hydratedProject = await ensureProjectVariables(state.activeProject, rawCommands, {
      persist: true,
      title: 'Set deployment variables',
      detail: 'This deployment script needs a few variable values before it can run.',
      confirmLabel: 'Save and deploy'
    });
  } catch (error) {
    showAlert(error.message || 'Could not save project variables.');
    return;
  }
  if (!hydratedProject) return;
  state.activeProject = structuredClone(normalizeProject(hydratedProject));
  renderDetailsSummary(state.activeProject);
  renderProjects();

  const project = {
    ...state.activeProject,
    commands: resolveTemplateCommands(rawCommands, state.activeProject)
  };

  if (!project.commands.length) return;

  const upload = els.runNeedsUpload.checked
    ? {
        localPath: els.uploadLocalPath.value,
        remotePath: els.uploadRemotePath.value.trim()
      }
    : null;

  if (els.runNeedsUpload.checked && (!upload.localPath || !upload.remotePath)) return;

  const response = await window.deployerx.runDeployment({
    runId: `${Date.now()}`,
    project,
    upload
  });
  state.activeRunId = response.runId;
  terminal.clear();
  appendLog(`Starting deployment: ${project.name}\n`);
  setModalVisible(false, els.uploadModal);
}

function appendLog(message, kind = 'log') {
  const prefix = kind === 'error' ? '[stderr] ' : '';
  const rendered = `${prefix}${message}`.replace(/\n/g, '\r\n');
  const needsBreak = !String(message).endsWith('\n') && !String(message).endsWith('\r');
  const terminalSession = getTerminalSession();
  appendTerminalSessionOutput(terminalSession, rendered);
  if (needsBreak) appendTerminalSessionOutput(terminalSession, '\r\n');
}

function writeTerminalData(data) {
  appendTerminalSessionOutput(getTerminalSession(), data);
}

function stripTerminalControls(data) {
  return String(data ?? '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[()][A-Za-z0-9]/g, '')
    .replace(/\x0f/g, '');
}

function applyTerminalBackspaces(text) {
  const output = [];

  for (const char of String(text ?? '')) {
    if (char === '\b') {
      const lastChar = output[output.length - 1];
      if (lastChar && lastChar !== '\n') output.pop();
    } else {
      output.push(char);
    }
  }

  return output.join('');
}

function appendTerminalOutputBuffer(data, terminalSession = getTerminalSession()) {
  const rawText = String(data ?? '');
  const visibleText = applyTerminalBackspaces(stripTerminalControls(rawText).replace(/\r/g, '\n'));

  if (!terminalSession) {
    state.terminalRawBuffer = `${state.terminalRawBuffer}${rawText}`.slice(-4000);
    state.terminalOutputBuffer = `${state.terminalOutputBuffer}${visibleText}`.slice(-4000);
    return;
  }

  terminalSession.rawBuffer = `${terminalSession.rawBuffer || ''}${rawText}`.slice(-4000);
  terminalSession.outputBuffer = `${terminalSession.outputBuffer || ''}${visibleText}`.slice(-4000);
  syncTerminalDirectoryFromOutput(visibleText, terminalSession);
  if (isVisibleTerminalSession(terminalSession)) {
    state.terminalRawBuffer = terminalSession.rawBuffer;
    state.terminalOutputBuffer = terminalSession.outputBuffer;
  }
}

function lastTerminalLine(terminalSession = getTerminalSessionById(state.scriptTerminalSessionId) || getTerminalSession()) {
  const lines = String(terminalSession?.outputBuffer || '').split('\n');
  return lines[lines.length - 1] || '';
}

function isShellPromptLine(line) {
  const prompt = String(line ?? '').trimEnd();
  if (!prompt || prompt.endsWith('?')) return false;

  return (
    /^\[[^\]\r\n]{1,160}\]\s*[#$]\s*$/.test(prompt) ||
    /^[A-Za-z0-9_.-]+@[\w.-]+:[^\r\n]{0,160}[#$]\s*$/.test(prompt) ||
    /^[A-Za-z0-9_.-]+@[\w.-]+\s+[^\r\n]{0,160}[#$]\s*$/.test(prompt)
  );
}

function clearScriptPromptTimer() {
  if (!state.scriptPromptTimer) return;
  clearTimeout(state.scriptPromptTimer);
  state.scriptPromptTimer = null;
}

function stopScriptQueue() {
  clearScriptPromptTimer();
  state.scriptCommandQueue = [];
  state.scriptRunnerActive = false;
  state.scriptWaitingForPrompt = false;
  state.scriptReadyMarker = '';
  state.scriptPromptMarkerActive = false;
  state.scriptTerminalSessionId = '';
}

function updateScriptStatus() {
  const terminalSession = getTerminalSessionById(state.scriptTerminalSessionId) || getTerminalSession();
  if (!state.scriptRunnerActive) {
    setTerminalSessionStatus(terminalSession, 'Connected', true);
    return;
  }

  setTerminalSessionStatus(terminalSession, `Running script (${state.scriptCommandQueue.length} queued)`, true);
}

async function runNextScriptCommand() {
  clearScriptPromptTimer();

  const terminalSession = getTerminalSessionById(state.scriptTerminalSessionId);
  if (!state.scriptRunnerActive || state.scriptWaitingForPrompt || !terminalSession?.connected) return;

  const command = state.scriptCommandQueue.shift();
  if (!command) {
    stopScriptQueue();
    setTerminalSessionStatus(terminalSession, 'Connected', true);
    return;
  }

  state.scriptWaitingForPrompt = true;
  terminalSession.outputBuffer = '';
  terminalSession.rawBuffer = '';
  if (isVisibleTerminalSession(terminalSession)) {
    state.terminalOutputBuffer = '';
    state.terminalRawBuffer = '';
  }
  updateScriptStatus();
  await sendTerminalInput(`${command}\n`, terminalSession.sessionId);
}

function createScriptPromptSetupCommand() {
  const marker = state.scriptReadyMarker;
  return `export PROMPT_COMMAND='printf "\\033]1337;${marker}\\007"'; if [ -n "$ZSH_VERSION" ]; then precmd() { printf "\\033]1337;${marker}\\007"; }; fi\n`;
}

async function prepareScriptQueue() {
  const terminalSession = getTerminalSessionById(state.scriptTerminalSessionId);
  if (!state.scriptRunnerActive || !terminalSession?.connected) return;

  state.scriptWaitingForPrompt = true;
  terminalSession.outputBuffer = '';
  terminalSession.rawBuffer = '';
  if (isVisibleTerminalSession(terminalSession)) {
    state.terminalOutputBuffer = '';
    state.terminalRawBuffer = '';
  }
  setTerminalSessionStatus(terminalSession, 'Preparing script runner', true);
  await sendTerminalInput(createScriptPromptSetupCommand(), terminalSession.sessionId);
}

function hasScriptReadyMarker(terminalSession = getTerminalSessionById(state.scriptTerminalSessionId) || getTerminalSession()) {
  if (!state.scriptReadyMarker) return false;

  return (
    String(terminalSession?.rawBuffer || '').includes(`\x1b]1337;${state.scriptReadyMarker}\x07`) ||
    String(terminalSession?.rawBuffer || '').includes(`\x1b]1337;${state.scriptReadyMarker}\x1b\\`)
  );
}

function maybeContinueScriptQueue(terminalSession = getTerminalSessionById(state.scriptTerminalSessionId)) {
  if (!state.scriptRunnerActive || !state.scriptWaitingForPrompt || !terminalSession || terminalSession.sessionId !== state.scriptTerminalSessionId) return;

  const markerSeen = hasScriptReadyMarker(terminalSession);
  if (markerSeen) state.scriptPromptMarkerActive = true;

  const promptSeen = !state.scriptPromptMarkerActive && isShellPromptLine(lastTerminalLine(terminalSession));
  if (!markerSeen && !promptSeen) return;

  clearScriptPromptTimer();
  state.scriptPromptTimer = setTimeout(() => {
    state.scriptPromptTimer = null;
    if (!state.scriptRunnerActive || !state.scriptWaitingForPrompt) return;
    if (!hasScriptReadyMarker(terminalSession) && !(!state.scriptPromptMarkerActive && isShellPromptLine(lastTerminalLine(terminalSession)))) return;

    state.scriptWaitingForPrompt = false;
    runNextScriptCommand().catch((error) => appendLog(error.message, 'error'));
  }, 150);
}

function handleTerminalData(data, terminalSession = getTerminalSession()) {
  appendTerminalSessionOutput(terminalSession, data);
  appendTerminalOutputBuffer(data, terminalSession);
  maybeContinueScriptQueue(terminalSession);
}

function resetTerminalView() {
  const terminalSession = getTerminalSession();
  if (terminalSession) {
    terminalSession.sessionId = null;
    terminalSession.connected = false;
    terminalSession.status = 'Not connected';
    terminalSession.pendingInput = '';
    terminalSession.outputBuffer = '';
    terminalSession.rawBuffer = '';
    terminalSession.commandBuffer = '';
    terminalSession.pendingDirectoryCandidate = '';
    terminalSession.awaitingPwd = false;
    terminalSession.upload = blankTerminalUploadState();
  }
  state.activeTerminalSessionId = null;
  state.terminalConnected = false;
  state.pendingTerminalInput = '';
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';
  stopScriptQueue();
  renderVisibleTerminalSession(terminalSession);
  updateTerminalStatus('Not connected', false);
}

async function startRun(event) {
  if (!state.activeProject) return;

  if (event?.preventDefault) event.preventDefault();
  const rawCommands = normalizeCommands(els.commands.value);
  let hydratedProject;
  try {
    hydratedProject = await ensureProjectVariables(state.activeProject, rawCommands, {
      persist: true,
      title: 'Set script variables',
      detail: 'This script needs a few variable values before it can run in the SSH terminal.',
      confirmLabel: 'Save and run'
    });
  } catch (error) {
    showAlert(error.message || 'Could not save project variables.');
    return;
  }
  if (!hydratedProject) return;
  state.activeProject = structuredClone(normalizeProject(hydratedProject));
  renderDetailsSummary(state.activeProject);
  renderProjects();

  const commands = resolveTemplateCommands(rawCommands, state.activeProject);
  if (!commands.length) return;

  if (!state.terminalConnected) {
    updateTerminalStatus('Connect SSH to run scripts', false);
    return;
  }

  stopScriptQueue();
  state.scriptCommandQueue = [...commands];
  state.scriptRunnerActive = true;
  state.scriptWaitingForPrompt = false;
  state.scriptReadyMarker = `__DEPLOYERX_READY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  state.scriptPromptMarkerActive = false;
  state.scriptTerminalSessionId = state.activeTerminalSessionId || '';
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';

  await prepareScriptQueue();
}

async function ensureTerminal() {
  if (!state.activeProject) return false;
  if (state.terminalConnected) return true;
  if (state.activeTerminalSessionId) return false;
  fitTerminal();

  const terminalSession = getTerminalSession(state.activeProject.id, true);
  const sessionId = `${Date.now()}`;
  terminalSession.sessionId = sessionId;
  terminalSession.connected = false;
  terminalSession.status = 'Connecting...';
  terminalSession.output = 'Ready.\r\n';
  terminalSession.pendingInput = '';
  terminalSession.outputBuffer = '';
  terminalSession.rawBuffer = '';
  state.terminalSessionProjectIds[sessionId] = state.activeProject.id;
  state.activeTerminalSessionId = sessionId;
  renderVisibleTerminalSession(terminalSession);
  updateTerminalStatus('Connecting...');
  appendLog(`Opening terminal: ${state.activeProject.name}\n`);

  const response = await window.deployerx.startTerminal({
    sessionId,
    project: state.activeProject,
    cols: terminal.cols,
    rows: terminal.rows
  });
  const nextSessionId = response.sessionId || sessionId;
  if (nextSessionId !== sessionId) {
    removeTerminalSessionRegistration(sessionId);
    state.terminalSessionProjectIds[nextSessionId] = state.activeProject.id;
  }
  terminalSession.sessionId = nextSessionId;
  state.activeTerminalSessionId = nextSessionId;
  updateTerminalStatus('Connecting...');
  setTimeout(() => {
    fitTerminal();
    resizeActiveTerminal();
  }, 250);
  return false;
}

async function sendTerminalInput(input, sessionId = state.activeTerminalSessionId) {
  if (!input) return;
  const terminalSession = getTerminalSessionById(sessionId) || getTerminalSession();
  const targetConnected = Boolean(terminalSession?.connected);

  if (!targetConnected) {
    if (sessionId && terminalSession && sessionId === terminalSession.sessionId && isVisibleTerminalSession(terminalSession)) {
      state.pendingTerminalInput = `${state.pendingTerminalInput || ''}${input}`;
      terminalSession.pendingInput = state.pendingTerminalInput;
    } else {
      updateTerminalStatus('Connect SSH first', false);
    }
    return;
  }

  trackTerminalInputChunk(input, sessionId);
  window.deployerx.sendTerminalInput({
    sessionId,
    input
  });
}

async function disconnectTerminal() {
  if (!state.activeTerminalSessionId) return;
  const sessionId = state.activeTerminalSessionId;
  const ok = await confirmDangerousAction(
    'Disconnect the active terminal session?',
    'Running shell commands in this terminal session will be stopped.',
    'Disconnect'
  );
  if (!ok) return;
  stopScriptQueue();
  await window.deployerx.stopTerminal(sessionId);
}

async function connectTerminal() {
  if (!state.activeProject || state.activeTerminalSessionId || state.terminalConnected) return;
  try {
    await ensureTerminal();
  } catch (error) {
    const terminalSession = getTerminalSession(state.activeProject.id, true);
    removeTerminalSessionRegistration(terminalSession.sessionId);
    terminalSession.sessionId = null;
    terminalSession.connected = false;
    terminalSession.status = 'Connection failed';
    state.activeTerminalSessionId = null;
    state.terminalConnected = false;
    updateTerminalStatus('Connection failed', false);
    appendLog(`${error.message}\n`, 'error');
  }
}

async function uploadFileToCurrentSshPath() {
  const terminalSession = getTerminalSession();
  if (!terminalSession?.sessionId || !terminalSession.connected || pendingActions.has('terminal:upload')) return;
  if (terminalSession.pendingDirectoryCandidate) {
    showAlert('Wait for the current directory to finish updating, then upload.');
    return;
  }

  let remoteDirectory = String(terminalSession.currentDirectory || '').trim();
  if (!remoteDirectory) {
    try {
      await ensureTerminalHomeDirectory(terminalSession.sessionId);
    } catch {}
    remoteDirectory = String(terminalSession.currentDirectory || terminalSession.homeDirectory || '').trim();
  }
  if (!remoteDirectory) {
    showAlert('Current SSH path is not ready yet. Try again in a moment.');
    return;
  }

  const localPath = await window.deployerx.selectUpload();
  if (!localPath) return;

  const fileName = fileNameFromPath(localPath);
  const remotePath = joinRemoteShellPath(remoteDirectory, fileName);
  setTerminalUploadState(terminalSession, {
    active: true,
    fileName,
    remotePath,
    transferredBytes: 0,
    totalBytes: 0,
    percent: 0,
    cancelRequested: false
  });

  try {
    await withButtonLoading('terminal:upload', els.sshUploadButton, () =>
      window.deployerx.uploadTerminalFile({
        sessionId: terminalSession.sessionId,
        localPath,
        remoteDirectory
      })
    );
  } catch (error) {
    const canceled = Boolean(terminalSession.upload?.cancelRequested);
    setTerminalUploadState(terminalSession, blankTerminalUploadState());
    if (canceled || /canceled/i.test(String(error?.message || ''))) {
      showToast('Upload canceled');
      return;
    }
    showAlert(error.message || 'Could not upload file.');
  }
}

async function cancelCurrentSshUpload() {
  const terminalSession = getTerminalSession();
  if (!terminalSession?.sessionId || !terminalSession.upload?.active || terminalSession.upload.cancelRequested) return;

  setTerminalUploadState(terminalSession, {
    ...terminalSession.upload,
    cancelRequested: true
  });

  try {
    const canceled = await window.deployerx.cancelTerminalUpload(terminalSession.sessionId);
    if (!canceled) {
      setTerminalUploadState(terminalSession, {
        ...terminalSession.upload,
        cancelRequested: false
      });
    }
  } catch (error) {
    setTerminalUploadState(terminalSession, {
      ...terminalSession.upload,
      cancelRequested: false
    });
    showAlert(error.message || 'Could not cancel upload.');
  }
}

async function emergencyStop() {
  const ok = await confirmDangerousAction(
    'Emergency stop the active deployment and close any open terminal session?',
    'Active deployments and terminal sessions will be stopped immediately.',
    'Stop'
  );
  if (!ok) return;
  await window.deployerx.emergencyStop();
  state.activeRunId = null;
  const activeProjectId = state.activeProject?.id || '';
  state.terminalSessions = {};
  state.terminalSessionProjectIds = {};
  state.ftpSessions = {};
  state.activeTerminalSessionId = null;
  state.terminalConnected = false;
  state.ftpSessionId = null;
  state.ftpConnected = false;
  state.ftpCurrentPath = '.';
  state.ftpParentPath = '.';
  state.ftpEntries = [];
  state.ftpSelectedPath = '';
  state.ftpBackStack = [];
  state.ftpForwardStack = [];
  state.pendingTerminalInput = '';
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';
  stopScriptQueue();
  if (activeProjectId) {
    state.terminalSessions[activeProjectId] = blankTerminalSession(activeProjectId);
    state.ftpSessions[activeProjectId] = blankFtpSession(activeProjectId);
  }
  appendLog('Emergency stop requested.\n', 'error');
  renderFtpBrowser();
}

els.dashboardButton.addEventListener('click', () => showView('dashboard'));
els.serversButton.addEventListener('click', () => showView('servers'));
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    refreshCurrentPage();
  }
});
els.loginTabButton.addEventListener('click', () => updateAuthMode('login'));
els.registerTabButton.addEventListener('click', () => updateAuthMode('register'));
els.authForm.addEventListener('submit', submitAuth);
els.googleLoginButton.addEventListener('click', submitGoogleAuth);
els.forgotPasswordButton.addEventListener('click', forgotPassword);
els.resendVerificationButton.addEventListener('click', resendVerification);
els.verificationLogoutButton.addEventListener('click', () => logout(false));
els.continueWithoutLoginButton.addEventListener('click', activateOfflineMode);
els.authFooterSwitchButton.addEventListener('click', () => updateAuthMode(state.auth.authMode === 'register' ? 'login' : 'register'));
els.settingsNavItems.forEach((item) => item.addEventListener('click', () => setSettingsTab(item.dataset.settingsTab)));
els.settingsLoginButtons.forEach((button) => button.addEventListener('click', activateCloudMode));
els.settingsProfileSaveButton.addEventListener('click', () => showToast('Profile updates are synced through Firebase Auth.'));
els.settingsProfileLogoutButton.addEventListener('click', logout);
els.appUpdateCheckButton?.addEventListener('click', checkForAppUpdates);
els.appUpdateRestartButton?.addEventListener('click', installAppUpdate);
els.appUpdateOpenReleasesButton?.addEventListener('click', openReleasesPage);
els.settingsImportAccountButton.addEventListener('click', importAccount);
els.settingsExportAccountButton.addEventListener('click', exportAccount);
els.deleteWorkspaceButton.addEventListener('click', deleteWorkspace);
els.workspaceCreateForm.addEventListener('submit', createWorkspace);
els.workspaceSetupSelect.addEventListener('change', async () => {
  const teamId = els.workspaceSetupSelect.value;
  if (!teamId || teamId === state.teams.activeTeamId) return;
  try {
    applyTeamSnapshot(await window.deployerx.switchTeam(teamId));
    renderWorkspaceSetupPanel();
  } catch (error) {
    showAlert(error.message || 'Could not switch workspace.');
  }
});
els.workspaceContinueButton.addEventListener('click', enterCloudWorkspace);
els.workspaceLogoutButton.addEventListener('click', logout);
els.dashboardCreateButton.addEventListener('click', openCreateModal);
els.uptimeButton.addEventListener('click', () => showView('uptime'));
els.dashboardImportAccountButton.addEventListener('click', importAccount);
els.dashboardExportAccountButton.addEventListener('click', exportAccount);
els.dashboardImportProjectsButton.addEventListener('click', importProjects);
els.dashboardExportProjectsButton.addEventListener('click', exportProjects);
els.templatesButton.addEventListener('click', () => showView('templates'));
els.goOnlineButton.addEventListener('click', activateCloudMode);
els.teamButton.addEventListener('click', () => {
  setSettingsTab(state.settingsTab || 'profile');
  showView('team');
});
els.dashboardTemplatesButton.addEventListener('click', () => showView('templates'));
els.dashboardServersButton.addEventListener('click', () => showView('servers'));
els.backToDashboardButton.addEventListener('click', () => showView('servers'));
els.backFromTemplatesButton.addEventListener('click', () => showView('dashboard'));
els.projectSshTab.addEventListener('click', () => setProjectTab('ssh'));
els.projectFtpTab.addEventListener('click', () => setProjectTab('ftp'));
els.uptimeAddMonitorButton.addEventListener('click', () => openUptimeMonitorModal('create'));
els.uptimeProjectSelect.addEventListener('change', () => {
  state.uptime.selectedProjectId = els.uptimeProjectSelect.value;
  state.uptime.selectedMonitorId = '';
  refreshUptimeProjectState({ preserveSelection: false }).catch((error) => showAlert(error.message || 'Could not load uptime monitors.'));
});
els.uptimeRunAllButton.addEventListener('click', () => {
  const project = selectedUptimeProjectRecord();
  if (!project) return;
  window.deployerx
    .runUptimeNow({ projectId: project.id })
    .then(() => {
      markQueuedUptimeMonitors(project.id);
      showToast('Run queued for all monitors');
    })
    .catch((error) => showAlert(error.message || 'Could not queue monitor run.'));
});
els.uptimeMonitorList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-uptime-monitor-id]');
  if (!button) return;
  state.uptime.selectedMonitorId = button.dataset.uptimeMonitorId;
  renderUptimeWorkspace();
  loadSelectedUptimeMonitorHistory().catch((error) => showAlert(error.message || 'Could not load monitor history.'));
});
els.uptimeRunMonitorButton.addEventListener('click', () => {
  const monitor = selectedUptimeMonitor();
  const project = selectedUptimeProjectRecord();
  if (!project || !monitor) return;
  window.deployerx
    .runUptimeNow({ projectId: project.id, monitorId: monitor.id })
    .then(() => {
      markQueuedUptimeMonitors(project.id, monitor.id);
      showToast('Run queued');
    })
    .catch((error) => showAlert(error.message || 'Could not queue monitor run.'));
});
els.uptimeToggleMonitorButton.addEventListener('click', () => {
  toggleSelectedUptimeMonitor().catch((error) => showAlert(error.message || 'Could not update monitor.'));
});
els.uptimeEditMonitorButton.addEventListener('click', () => {
  const monitor = selectedUptimeMonitor();
  if (!monitor) return;
  openUptimeMonitorModal('edit', monitor.id);
});
els.uptimeDeleteMonitorButton.addEventListener('click', () => {
  deleteSelectedUptimeMonitor().catch((error) => showAlert(error.message || 'Could not delete monitor.'));
});
els.editProjectButton.addEventListener('click', openEditModal);
els.deleteProjectButton.addEventListener('click', deleteCurrentProject);
els.saveCommandsButton.addEventListener('click', saveCommands);
els.runProjectButton.addEventListener('click', startRun);
els.projectTemplateSelect.addEventListener('change', applySelectedScriptTemplate);
els.emergencyStopButton.addEventListener('click', emergencyStop);
els.connectTerminalButton.addEventListener('click', connectTerminal);
els.disconnectTerminalButton.addEventListener('click', disconnectTerminal);
els.sshUploadButton.addEventListener('click', () =>
  uploadFileToCurrentSshPath().catch((error) => showAlert(error.message || 'Could not upload file.'))
);
els.sshUploadCancelButton.addEventListener('click', () =>
  cancelCurrentSshUpload().catch((error) => showAlert(error.message || 'Could not cancel upload.'))
);
els.connectFtpButton.addEventListener('click', connectFtp);
els.disconnectFtpButton.addEventListener('click', disconnectFtp);
els.ftpLocalBackButton.addEventListener('click', () => goLocalFtpHistory(-1).catch((error) => showAlert(error.message || 'Could not go back.')));
els.ftpLocalForwardButton.addEventListener('click', () => goLocalFtpHistory(1).catch((error) => showAlert(error.message || 'Could not go forward.')));
els.ftpLocalPathPickerButton.addEventListener('click', () => chooseLocalFtpPath().catch((error) => showAlert(error.message || 'Could not choose local folder.')));
els.ftpLocalPathInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  openLocalFtpPath(els.ftpLocalPathInput.value, { pushHistory: true }).catch((error) => showAlert(error.message || 'Could not open local path.'));
});
els.ftpLocalFilter.addEventListener('input', () => {
  state.ftpLocalFilter = els.ftpLocalFilter.value;
  renderFtpBrowser();
});
els.ftpLocalFileList.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.ftp-row')) return;
  showFtpContextMenu(event, 'local');
});
els.ftpRemoteFilter.addEventListener('input', () => {
  state.ftpRemoteFilter = els.ftpRemoteFilter.value;
  renderFtpBrowser();
});
els.ftpBackButton.addEventListener('click', () => goFtpHistory(-1).catch((error) => showAlert(error.message || 'Could not go back.')));
els.ftpForwardButton.addEventListener('click', () => goFtpHistory(1).catch((error) => showAlert(error.message || 'Could not go forward.')));
els.ftpPathInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  openFtpPath(els.ftpPathInput.value, { pushHistory: true }).catch((error) => showAlert(error.message || 'Could not open path.'));
});
els.ftpFileList.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.ftp-row')) return;
  showFtpContextMenu(event, 'remote');
});
els.ftpRemoteBrowser.addEventListener('dragenter', handleFtpRemoteDragEnter);
els.ftpRemoteBrowser.addEventListener('dragover', handleFtpRemoteDragOver);
els.ftpRemoteBrowser.addEventListener('dragleave', handleFtpRemoteDragLeave);
els.ftpRemoteBrowser.addEventListener('drop', (event) => {
  handleFtpRemoteDrop(event).catch((error) => showAlert(error.message || 'Could not upload dropped items.'));
});
document.addEventListener('click', (event) => {
  if (!els.ftpContextMenu || els.ftpContextMenu.contains(event.target)) return;
  hideFtpContextMenu();
});
document.addEventListener('dragend', resetFtpRemoteDropState);
document.addEventListener('drop', resetFtpRemoteDropState);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  hideFtpContextMenu();
  if (variablePromptResolve) closeVariablePrompt(null);
});
els.logoutButton.addEventListener('click', logout);
els.teamSelect.addEventListener('change', () => {
  els.switchTeamButton.disabled = !els.teamSelect.value || els.teamSelect.value === state.teams.activeTeamId;
});
els.switchTeamButton.addEventListener('click', switchTeam);
els.openCreateTeamButton.addEventListener('click', () => {
  els.createTeamName.value = '';
  setModalVisible(true, els.createTeamModal);
  els.createTeamName.focus();
});
els.inviteMemberForm.addEventListener('submit', inviteMember);
els.importLocalToCloudButton.addEventListener('click', importLocalToCloud);
els.createTeamForm.addEventListener('submit', createTeam);
els.createTeamCloseButton.addEventListener('click', () => setModalVisible(false, els.createTeamModal));
els.createTeamCancelButton.addEventListener('click', () => setModalVisible(false, els.createTeamModal));
els.createTeamModal.addEventListener('click', (event) => {
  if (event.target === els.createTeamModal || event.target.classList.contains('modal-backdrop')) setModalVisible(false, els.createTeamModal);
});

els.projectModalForm.addEventListener('submit', commitModalProject);
els.uptimeMonitorForm.addEventListener('submit', saveUptimeMonitor);
els.templatePageForm.addEventListener('submit', saveTemplate);
els.uploadModalForm.addEventListener('submit', startDeployment);
els.exportPickerForm.addEventListener('submit', confirmExportPicker);
els.duplicateTemplateForm.addEventListener('submit', duplicateTemplate);
els.variablePromptForm.addEventListener('submit', submitVariablePrompt);
els.projectModalCloseButton.addEventListener('click', () => setModalVisible(false, els.projectModal));
els.projectModalCancelButton.addEventListener('click', () => setModalVisible(false, els.projectModal));
els.uptimeMonitorCloseButton.addEventListener('click', () => setModalVisible(false, els.uptimeMonitorModal));
els.uptimeMonitorCancelButton.addEventListener('click', () => setModalVisible(false, els.uptimeMonitorModal));
els.uptimeMonitorModal.addEventListener('click', (event) => {
  if (event.target === els.uptimeMonitorModal || event.target.classList.contains('modal-backdrop')) {
    setModalVisible(false, els.uptimeMonitorModal);
  }
});
els.uptimeMonitorType.addEventListener('change', updateUptimeMonitorTypeFields);
els.newTemplateButton.addEventListener('click', newTemplate);
els.importTemplatesButton.addEventListener('click', importTemplates);
els.exportTemplatesButton.addEventListener('click', exportTemplates);
els.templateSearch.addEventListener('input', renderTemplates);
els.templatePageCancelButton.addEventListener('click', closeTemplateEditor);
els.deleteTemplateButton.addEventListener('click', deleteTemplate);
els.duplicateTemplateButton.addEventListener('click', openDuplicateTemplateModal);
els.duplicateTemplateCloseButton.addEventListener('click', closeDuplicateTemplateModal);
els.duplicateTemplateCancelButton.addEventListener('click', closeDuplicateTemplateModal);
els.duplicateTemplateModal.addEventListener('click', (event) => {
  if (event.target === els.duplicateTemplateModal || event.target.classList.contains('modal-backdrop')) closeDuplicateTemplateModal();
});
els.variablePromptCloseButton.addEventListener('click', () => closeVariablePrompt(null));
els.variablePromptCancelButton.addEventListener('click', () => closeVariablePrompt(null));
els.variablePromptModal.addEventListener('click', (event) => {
  if (event.target === els.variablePromptModal || event.target.classList.contains('modal-backdrop')) closeVariablePrompt(null);
});
els.uploadModalCloseButton.addEventListener('click', () => setModalVisible(false, els.uploadModal));
els.uploadModalCancelButton.addEventListener('click', () => setModalVisible(false, els.uploadModal));
els.exportPickerCloseButton.addEventListener('click', closeExportPicker);
els.exportPickerCancelButton.addEventListener('click', closeExportPicker);
els.exportPickerSearch.addEventListener('input', renderExportPicker);
els.exportPickerSelectAll.addEventListener('change', toggleExportPickerSelectAll);
els.confirmModalCancelButton.addEventListener('click', () => closeConfirmModal(false));
els.confirmModalConfirmButton.addEventListener('click', () => closeConfirmModal(true));
els.confirmModal.addEventListener('click', (event) => {
  if (event.target === els.confirmModal || event.target.classList.contains('modal-backdrop')) closeConfirmModal(false);
});
els.modalAuthType.addEventListener('change', updateAuthFields);
els.modalFtpAuthType.addEventListener('change', updateFtpAuthFields);
els.modalTemplateSelect.addEventListener('change', syncModalVariablesForTemplate);
els.modalAddVariableButton.addEventListener('click', () => addVariableRow());
els.templateCommands.addEventListener('input', () => renderTemplateVariableSummary(els.templateCommands.value));
els.runNeedsUpload.addEventListener('change', updateUploadFields);
els.modalSelectKeyButton.addEventListener('click', async () => {
  const privateKey = await window.deployerx.selectKey();
  if (privateKey) els.modalPrivateKey.value = privateKey;
});
els.selectUploadButton.addEventListener('click', async () => {
  const filePath = await window.deployerx.selectUpload();
  if (filePath) els.uploadLocalPath.value = filePath;
});

window.deployerx.onAppUpdateEvent?.((update) => {
  applyAppUpdateState(update, { toastOnDownloaded: true });
});

window.deployerx.onDeploymentEvent((event) => {
  if (state.activeRunId && event.runId !== state.activeRunId) return;

  if (event.type === 'log') writeTerminalData(event.payload);
  if (event.type === 'error') writeTerminalData(event.payload);
  if (event.type === 'done') {
    appendLog(`${event.payload}\n`);
    state.activeRunId = null;
  }
  if (event.type === 'failed') {
    appendLog(`${event.payload}\n`, 'error');
    state.activeRunId = null;
  }
});

window.deployerx.onTerminalEvent(async (event) => {
  const terminalSession = getTerminalSessionById(event.sessionId);
  if (!terminalSession) return;

  if (event.type === 'connected') {
    terminalSession.connected = true;
    setTerminalSessionStatus(terminalSession, 'Connected', true);
    ensureTerminalHomeDirectory(event.sessionId).catch(() => {});
    if (terminalSession.pendingInput) {
      trackTerminalInputChunk(terminalSession.pendingInput, event.sessionId);
      window.deployerx.sendTerminalInput({
        sessionId: event.sessionId,
        input: terminalSession.pendingInput
      });
      terminalSession.pendingInput = '';
      if (isVisibleTerminalSession(terminalSession)) state.pendingTerminalInput = '';
    }
    if (state.scriptRunnerActive && state.scriptTerminalSessionId === event.sessionId) {
      prepareScriptQueue().catch((error) => appendLog(error.message, 'error'));
    }
  }
  if (event.type === 'upload-started') {
    setTerminalUploadState(terminalSession, {
      active: true,
      fileName: event.payload?.fileName || '',
      remotePath: event.payload?.remotePath || '',
      transferredBytes: 0,
      totalBytes: Number(event.payload?.totalBytes || 0),
      percent: 0
    });
  }
  if (event.type === 'upload-progress') {
    setTerminalUploadState(terminalSession, {
      active: true,
      fileName: event.payload?.fileName || terminalSession.upload?.fileName || '',
      remotePath: event.payload?.remotePath || terminalSession.upload?.remotePath || '',
      transferredBytes: Number(event.payload?.transferredBytes || 0),
      totalBytes: Number(event.payload?.totalBytes || 0),
      percent: Number(event.payload?.percent || 0)
    });
  }
  if (event.type === 'upload-complete') {
    setTerminalUploadState(terminalSession, blankTerminalUploadState());
    showToast(`Uploaded ${event.payload?.fileName || 'file'} to ${event.payload?.remotePath || 'server path'}`);
  }
  if (event.type === 'log') handleTerminalData(event.payload, terminalSession);
  if (event.type === 'error') handleTerminalData(event.payload, terminalSession);
  if (event.type === 'failed' || event.type === 'closed') {
    const message = `${event.payload}\n`;
    appendTerminalSessionOutput(terminalSession, message.replace(/\n/g, '\r\n'));
    appendTerminalOutputBuffer(message, terminalSession);
    if (state.scriptTerminalSessionId === event.sessionId) stopScriptQueue();
    const closedSessionId = terminalSession.sessionId;
    terminalSession.sessionId = null;
    terminalSession.connected = false;
    terminalSession.pendingInput = '';
    terminalSession.commandBuffer = '';
    terminalSession.pendingDirectoryCandidate = '';
    terminalSession.awaitingPwd = false;
    terminalSession.upload = blankTerminalUploadState();
    removeTerminalSessionRegistration(closedSessionId);
    setTerminalSessionStatus(terminalSession, event.type === 'failed' ? 'Connection failed' : 'Disconnected', false);
  }
});

window.deployerx.onUptimeEvent?.((event) => {
  if (state.currentView !== 'uptime') return;
  if (!['uptime', 'project-saved', 'run-queued', 'heartbeat', 'monitor-updated'].some((token) => String(event?.type || '').includes(token))) {
    return;
  }
  if (String(event?.type || '').includes('run-queued')) {
    markQueuedUptimeMonitors(event?.payload?.projectId, event?.payload?.monitorId);
    return;
  }
  refreshUptimeProjectState({ preserveSelection: true }).catch(() => {});
});

terminal.open(els.terminal);
terminal.write('Ready.\r\n');
requestAnimationFrame(fitTerminal);
terminal.attachCustomKeyEventHandler((event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'keydown') refreshCurrentPage();
    return false;
  }

  if (event.key !== 'Tab') return true;

  event.preventDefault();
  event.stopPropagation();

  if (event.type === 'keydown') {
    sendTerminalInput('\t').catch((error) => appendLog(error.message, 'error'));
  }

  return false;
});
terminal.onData((data) => {
  if (data === '\x03') stopScriptQueue();
  sendTerminalInput(data).catch((error) => appendLog(error.message, 'error'));
});
els.terminal.addEventListener('pointerdown', () => terminal.focus());
terminal.onResize(({ cols, rows }) => {
  if (!state.activeTerminalSessionId) return;
  window.deployerx.resizeTerminal({
    sessionId: state.activeTerminalSessionId,
    cols,
    rows
  });
});
window.addEventListener('resize', () => {
  fitTerminal();
});

initializeSecretVisibilityToggles();
renderTemplateCategories();
updateUptimeMonitorTypeFields();
renderUptimeWorkspace();
showView('dashboard');
initializeApp().catch((error) => {
  showAlert(error.message || 'Could not initialize DeployerX.');
  setSetupVisibility(true);
  showAuthPanel();
});
