const blankProject = () => ({
  id: '',
  name: '',
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
  commands: [],
  variables: {}
});

const state = {
  setup: {
    complete: false,
    mode: '',
    firebase: null
  },
  auth: {
    session: null,
    authMode: 'login'
  },
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
  activeRunId: null,
  activeTerminalSessionId: null,
  terminalConnected: false,
  ftpSessionId: null,
  ftpConnected: false,
  ftpLocalCurrentPath: '',
  ftpLocalParentPath: '',
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
  terminalOutputBuffer: '',
  terminalRawBuffer: '',
  modalMode: 'create',
  modalDraft: blankProject(),
  activeTemplateId: '',
  activeTemplateCategory: 'All',
  duplicateTemplateDraft: null,
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

const builtInVariableNames = new Set(['project_name', 'server_type', 'ssh_host', 'ssh_port', 'ssh_username']);
const templateCategories = ['Server', 'Laravel', 'Node.js', 'Database', 'Docker', 'Maintenance'];

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
  workspaceCreatePassphrase: document.getElementById('workspaceCreatePassphrase'),
  workspaceCreateButton: document.getElementById('workspaceCreateButton'),
  workspaceUnlockForm: document.getElementById('workspaceUnlockForm'),
  workspaceUnlockPassphrase: document.getElementById('workspaceUnlockPassphrase'),
  workspaceUnlockButton: document.getElementById('workspaceUnlockButton'),
  workspaceContinueButton: document.getElementById('workspaceContinueButton'),
  workspaceLogoutButton: document.getElementById('workspaceLogoutButton'),
  dashboardView: document.getElementById('dashboardView'),
  projectView: document.getElementById('projectView'),
  templateView: document.getElementById('templateView'),
  teamView: document.getElementById('teamView'),
  projectGrid: document.getElementById('projectGrid'),
  projectList: document.getElementById('projectList'),
  dashboardButton: document.getElementById('dashboardButton'),
  templatesButton: document.getElementById('templatesButton'),
  goOnlineButton: document.getElementById('goOnlineButton'),
  teamButton: document.getElementById('teamButton'),
  dashboardImportAccountButton: document.getElementById('dashboardImportAccountButton'),
  dashboardExportAccountButton: document.getElementById('dashboardExportAccountButton'),
  dashboardImportProjectsButton: document.getElementById('dashboardImportProjectsButton'),
  dashboardExportProjectsButton: document.getElementById('dashboardExportProjectsButton'),
  dashboardTemplatesButton: document.getElementById('dashboardTemplatesButton'),
  dashboardCreateButton: document.getElementById('dashboardCreateButton'),
  backToDashboardButton: document.getElementById('backToDashboardButton'),
  backFromTemplatesButton: document.getElementById('backFromTemplatesButton'),
  activeProjectName: document.getElementById('activeProjectName'),
  projectSshTab: document.getElementById('projectSshTab'),
  projectFtpTab: document.getElementById('projectFtpTab'),
  sshWorkspace: document.getElementById('sshWorkspace'),
  ftpWorkspace: document.getElementById('ftpWorkspace'),
  ftpLocalStatus: document.getElementById('ftpLocalStatus'),
  ftpLocalFilter: document.getElementById('ftpLocalFilter'),
  ftpLocalPathInput: document.getElementById('ftpLocalPathInput'),
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
  modalProjectName: document.getElementById('modalProjectName'),
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
  settingsImportAccountButton: document.getElementById('settingsImportAccountButton'),
  settingsExportAccountButton: document.getElementById('settingsExportAccountButton'),
  backupHistoryList: document.getElementById('backupHistoryList'),
  deleteWorkspaceButton: document.getElementById('deleteWorkspaceButton'),
  teamSelect: document.getElementById('teamSelect'),
  switchTeamButton: document.getElementById('switchTeamButton'),
  openCreateTeamButton: document.getElementById('openCreateTeamButton'),
  unlockTeamForm: document.getElementById('unlockTeamForm'),
  teamPassphrase: document.getElementById('teamPassphrase'),
  importLocalToCloudButton: document.getElementById('importLocalToCloudButton'),
  inviteMemberForm: document.getElementById('inviteMemberForm'),
  inviteEmail: document.getElementById('inviteEmail'),
  inviteRole: document.getElementById('inviteRole'),
  teamMembersList: document.getElementById('teamMembersList'),
  pendingInvitesList: document.getElementById('pendingInvitesList'),
  teamCloudWarning: document.getElementById('teamCloudWarning'),
  createTeamModal: document.getElementById('createTeamModal'),
  createTeamForm: document.getElementById('createTeamForm'),
  createTeamCloseButton: document.getElementById('createTeamCloseButton'),
  createTeamCancelButton: document.getElementById('createTeamCancelButton'),
  createTeamName: document.getElementById('createTeamName'),
  createTeamPassphrase: document.getElementById('createTeamPassphrase')
};

const STARTUP_IPC_TIMEOUT_MS = 5000;
const STARTUP_VERSION_TIMEOUT_MS = 1200;

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
  els.startupAppVersion.textContent = 'Version 0.1.0';
  if (!window.deployerx?.getAppMetadata) return;
  try {
    const metadata = await withTimeout(
      window.deployerx.getAppMetadata(),
      STARTUP_VERSION_TIMEOUT_MS,
      'App metadata took too long to load.'
    );
    els.startupAppVersion.textContent = `Version ${metadata.version || '0.1.0'}`;
  } catch {
    els.startupAppVersion.textContent = 'Version 0.1.0';
  }
}

let toastTimer = null;
let confirmModalResolve = null;
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

function normalizeProject(project = {}) {
  const blank = blankProject();
  return {
    ...blank,
    ...project,
    ssh: {
      ...blank.ssh,
      ...(project.ssh || {})
    },
    commands: Array.isArray(project.commands) ? project.commands : [],
    variables: normalizeVariables(project.variables)
  };
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
    variables: Array.isArray(template.variables) ? template.variables : extractTemplateVariables(commands)
  };
}

function projectBadge(project) {
  return (project.name || 'DX').slice(0, 2).toUpperCase();
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

function showView(view) {
  if (state.setup.mode === 'cloud' && !state.teams.unlocked && view !== 'team') {
    view = 'team';
  }
  if (view === 'team') renderSettingsView();
  const isDashboard = view === 'dashboard';
  const isProject = view === 'project';
  const isTemplate = view === 'templates';
  const isTeam = view === 'team';
  els.dashboardView.classList.toggle('hidden', !isDashboard);
  els.projectView.classList.toggle('hidden', !isProject);
  els.templateView.classList.toggle('hidden', !isTemplate);
  els.teamView.classList.toggle('hidden', !isTeam);
  els.dashboardButton.classList.toggle('active', isDashboard);
  els.templatesButton.classList.toggle('active', isTemplate);
  els.teamButton.classList.toggle('active', isTeam);
  if (isProject) {
    requestAnimationFrame(() => {
      if (state.activeProjectTab === 'ssh') {
        fitAddon.fit();
        if (state.terminalConnected) terminal.focus();
      }
    });
  }
}

function setProjectTab(tab) {
  state.activeProjectTab = tab === 'ftp' ? 'ftp' : 'ssh';
  const isFtp = state.activeProjectTab === 'ftp';
  els.projectSshTab.classList.toggle('active', !isFtp);
  els.projectFtpTab.classList.toggle('active', isFtp);
  els.projectSshTab.setAttribute('aria-selected', String(!isFtp));
  els.projectFtpTab.setAttribute('aria-selected', String(isFtp));
  els.sshWorkspace.classList.toggle('hidden', isFtp);
  els.ftpWorkspace.classList.toggle('hidden', !isFtp);
  if (isFtp) {
    renderFtpBrowser();
    if (!state.ftpLocalCurrentPath) {
      refreshLocalFtpList().catch((error) => showAlert(error.message || 'Could not load local files.'));
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

window.alert = showAlert;

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

window.deployerx.onConfirmationRequest?.(async ({ id, message, detail, confirmLabel }) => {
  const confirmed = await confirmDangerousAction(message, detail, confirmLabel);
  await window.deployerx.resolveConfirmation?.({ id, confirmed });
});

function updateAuthFields() {
  const isKey = els.modalAuthType.value === 'key';
  els.modalPasswordField.classList.toggle('hidden', isKey);
  els.modalKeyFields.classList.toggle('hidden', !isKey);
}

function updateUploadFields() {
  els.runUploadFields.classList.toggle('hidden', !els.runNeedsUpload.checked);
}

function renderTemplateSelect() {
  els.modalTemplateSelect.innerHTML = '<option value="">No template</option>';
  for (const template of state.templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.name || 'Untitled template';
    els.modalTemplateSelect.appendChild(option);
  }
  renderProjectTemplateSelect();
}

function renderProjectTemplateSelect() {
  els.projectTemplateSelect.innerHTML = '<option value="">Project commands</option>';
  for (const template of state.templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.name || 'Untitled template';
    els.projectTemplateSelect.appendChild(option);
  }
}

function updateTerminalStatus(text, connected = state.terminalConnected) {
  els.terminalStatus.textContent = text;
  els.projectView.classList.toggle('terminal-connected', connected);
  els.projectView.classList.toggle(
    'terminal-needs-connect',
    Boolean(state.activeProject && !state.activeTerminalSessionId && !connected)
  );
  els.disconnectTerminalButton.disabled = !state.activeTerminalSessionId;
  els.connectTerminalButton.disabled = Boolean(state.activeTerminalSessionId);
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

function applySelectedScriptTemplate() {
  const template = state.templates.find((item) => item.id === els.projectTemplateSelect.value);
  const commands = template
    ? resolveTemplateCommands(template.commands || [], state.activeProject)
    : state.activeProject?.commands || [];
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
    <span>Project variables used by this template</span>
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
  if (Object.prototype.hasOwnProperty.call(setup, 'unlocked')) state.teams.unlocked = Boolean(setup.unlocked);
  els.goOnlineButton.classList.toggle('hidden', state.setup.mode !== 'offline');
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
  state.teams.unlocked = Boolean(snapshot.unlocked);
  state.teams.cloudError = snapshot.cloudError || '';
  renderTeamView();
  applySetupState({ setupComplete: state.setup.complete, mode: state.setup.mode, activeTeamId: state.teams.activeTeamId, session: state.auth.session, unlocked: state.teams.unlocked });
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

  renderBackupHistory();
}

function renderTeamView() {
  const activeTeam = state.teams.activeTeam;
  const activeRole = activeTeam?.role || '';
  const canManage = ['owner', 'admin'].includes(activeRole);
  els.teamHeaderCopy.innerHTML = activeTeam
    ? `${escapeHtml(activeTeam.name)} <span class="team-status-pill ${state.teams.unlocked ? 'unlocked' : 'locked'}">${state.teams.unlocked ? 'Unlocked' : 'Locked'}</span>`
    : 'Create or accept a team invite to start cloud sync.';
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
  els.unlockTeamForm.classList.toggle('hidden', !state.teams.activeTeamId);
  els.importLocalToCloudButton.disabled = !state.teams.unlocked;
  els.inviteMemberForm.querySelector('button').disabled = !canManage;

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
          <select ${!canManage || isOwner ? 'disabled' : ''} data-member-role="${escapeHtml(member.uid)}">
            <option value="member" ${member.role === 'member' ? 'selected' : ''}>Member</option>
            <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
          <button class="button plain danger compact" type="button" data-remove-member="${escapeHtml(member.uid)}" ${!canManage || isOwner ? 'disabled' : ''}>Remove</button>
        </span>
      `;
      row.querySelector('[data-member-role]')?.addEventListener('change', updateMemberRole);
      row.querySelector('[data-remove-member]')?.addEventListener('click', removeMember);
      els.teamMembersList.appendChild(row);
    }
  }

  const pending = [
    ...state.teams.invites.map((invite) => ({ ...invite, personal: true })),
    ...state.teams.teamInvites.map((invite) => ({ ...invite, personal: false }))
  ];
  els.pendingInvitesList.innerHTML = '';
  if (!pending.length) {
    els.pendingInvitesList.innerHTML = '<div class="team-muted">No pending invites.</div>';
  } else {
    for (const invite of pending) {
      const canAccept = Boolean(invite.personal && invite.teamId && invite.emailLower);
      const row = document.createElement('div');
      row.className = 'team-row';
      row.innerHTML = `
        <span class="team-row-copy">
          <strong>${escapeHtml(invite.teamName || invite.email || 'Invite')}</strong>
          <span>${escapeHtml(invite.email || invite.emailLower || '')} - ${escapeHtml(invite.role || 'member')}</span>
        </span>
        <span class="team-row-actions">
          <button class="button outline compact" type="button" data-accept-invite="${escapeHtml(invite.id)}" data-team-id="${escapeHtml(invite.teamId || '')}" ${canAccept ? '' : 'disabled'}>${canAccept ? 'Accept' : 'Pending'}</button>
        </span>
      `;
      row.querySelector('[data-accept-invite]')?.addEventListener('click', acceptInvite);
      els.pendingInvitesList.appendChild(row);
    }
  }
}

function renderWorkspaceSetupPanel() {
  const teams = state.teams.teams || [];
  const hasTeams = teams.length > 0;
  const unlocked = Boolean(state.teams.unlocked);
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
  els.workspaceCreateForm.classList.toggle('hidden', hasTeams || unlocked);
  els.workspaceUnlockForm.classList.toggle('hidden', !hasTeams || unlocked);
  els.workspaceContinueButton.classList.toggle('hidden', !unlocked);
  els.workspaceSetupCopy.textContent = unlocked
    ? 'Workspace is ready. Continue to your dashboard.'
    : hasTeams
      ? 'Unlock your workspace to load projects, templates, and encrypted SSH secrets.'
      : 'Create a workspace to keep projects, templates, and team members in cloud sync.';
}

function showWorkspaceSetupPanel() {
  setSetupVisibility(true);
  els.setupModal.classList.add('auth-mode');
  els.authPanel.classList.add('hidden');
  els.workspaceSetupPanel.classList.remove('hidden');
  renderWorkspaceSetupPanel();
  requestAnimationFrame(() => {
    if (state.teams.teams.length) els.workspaceUnlockPassphrase.focus();
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
  closeTemplateEditor();
  renderTemplateSelect();
  renderProjects();
  renderTemplates();
}

async function enterCloudWorkspace() {
  if (!state.teams.unlocked) {
    showWorkspaceSetupPanel();
    return;
  }
  setSetupVisibility(false);
  await loadProjects();
  showView('dashboard');
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
  if (state.teams.unlocked) await enterCloudWorkspace();
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
    showAuthMessage('Could not continue', error.message || 'Check your Firebase setup and try again.');
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
    showAuthMessage('Could not login with Google', error.message || 'Check your Firebase setup and try again.');
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
    showAuthMessage('Could not send reset email', error.message || 'Check the email address and try again.');
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
    showAuthMessage('Could not resend verification', error.message || 'Login again and try resending.');
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
    if (state.activeTerminalSessionId) await window.deployerx.stopTerminal(state.activeTerminalSessionId);
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

async function createTeam(event) {
  event.preventDefault();
  try {
    const snapshot = await window.deployerx.createTeam({
      name: els.createTeamName.value.trim(),
      passphrase: els.createTeamPassphrase.value
    });
    els.createTeamName.value = '';
    els.createTeamPassphrase.value = '';
    setModalVisible(false, els.createTeamModal);
    applyTeamSnapshot(snapshot);
    await loadProjects();
    showToast('Team created and unlocked');
  } catch (error) {
    showAlert(error.message || 'Could not create team.');
  }
}

async function createWorkspace(event) {
  event.preventDefault();
  try {
    els.workspaceCreateButton.disabled = true;
    const snapshot = await window.deployerx.createTeam({
      name: els.workspaceCreateName.value.trim(),
      passphrase: els.workspaceCreatePassphrase.value
    });
    els.workspaceCreateName.value = '';
    els.workspaceCreatePassphrase.value = '';
    applyTeamSnapshot(snapshot);
    await enterCloudWorkspace();
    showToast('Workspace created');
  } catch (error) {
    showAlert(error.message || 'Could not create workspace.');
  } finally {
    els.workspaceCreateButton.disabled = false;
  }
}

async function unlockWorkspace(event) {
  event.preventDefault();
  try {
    els.workspaceUnlockButton.disabled = true;
    const selectedTeamId = els.workspaceSetupSelect.value || state.teams.activeTeamId;
    if (selectedTeamId && selectedTeamId !== state.teams.activeTeamId) {
      applyTeamSnapshot(await window.deployerx.switchTeam(selectedTeamId));
    }
    const snapshot = await window.deployerx.unlockTeam({
      teamId: selectedTeamId || state.teams.activeTeamId,
      passphrase: els.workspaceUnlockPassphrase.value
    });
    els.workspaceUnlockPassphrase.value = '';
    applyTeamSnapshot(snapshot);
    await enterCloudWorkspace();
    showToast('Workspace unlocked');
  } catch (error) {
    showAlert(error.message || 'Could not unlock this workspace.');
  } finally {
    els.workspaceUnlockButton.disabled = false;
  }
}

async function switchTeam() {
  const teamId = els.teamSelect.value;
  if (!teamId || teamId === state.teams.activeTeamId) return;
  try {
    const snapshot = await window.deployerx.switchTeam(teamId);
    applyTeamSnapshot(snapshot);
    resetWorkspaceData();
    showView('team');
    showToast('Team switched. Unlock it to sync projects.');
  } catch (error) {
    showAlert(error.message || 'Could not switch team.');
  }
}

async function unlockTeam(event) {
  event.preventDefault();
  try {
    const snapshot = await window.deployerx.unlockTeam({
      teamId: state.teams.activeTeamId,
      passphrase: els.teamPassphrase.value
    });
    els.teamPassphrase.value = '';
    applyTeamSnapshot(snapshot);
    await loadProjects();
    showToast('Cloud workspace unlocked');
    showView('dashboard');
  } catch (error) {
    showAlert(error.message || 'Could not unlock this team.');
  }
}

async function inviteMember(event) {
  event.preventDefault();
  try {
    const snapshot = await window.deployerx.inviteTeamMember({
      teamId: state.teams.activeTeamId,
      email: els.inviteEmail.value.trim(),
      role: els.inviteRole.value
    });
    els.inviteEmail.value = '';
    applyTeamSnapshot(snapshot);
    showToast('Invite created');
  } catch (error) {
    showAlert(error.message || 'Could not invite member.');
  }
}

async function acceptInvite(event) {
  const button = event.currentTarget;
  try {
    const snapshot = await window.deployerx.acceptTeamInvite({
      inviteId: button.dataset.acceptInvite,
      teamId: button.dataset.teamId
    });
    applyTeamSnapshot(snapshot);
    showToast('Invite accepted. Unlock the team to sync.');
  } catch (error) {
    showAlert(error.message || 'Could not accept invite.');
  }
}

async function updateMemberRole(event) {
  const select = event.currentTarget;
  try {
    const snapshot = await window.deployerx.updateTeamMember({
      teamId: state.teams.activeTeamId,
      uid: select.dataset.memberRole,
      role: select.value
    });
    applyTeamSnapshot(snapshot);
    showToast('Member role updated');
  } catch (error) {
    showAlert(error.message || 'Could not update member.');
    renderTeamView();
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
    'This permanently deletes the cloud workspace, members, invites, projects, and templates. This cannot be undone.',
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
  if (!state.teams.unlocked) return;
  const ok = await confirmDangerousAction(
    'Import local projects and templates to this cloud team?',
    'Items with the same id will be overwritten in the active cloud team.',
    'Import'
  );
  if (!ok) return;
  try {
    const result = await window.deployerx.importLocalToCloud();
    state.projects = (result.projects || []).map(normalizeProject);
    state.templates = (result.templates || []).map(normalizeTemplate);
    renderProjects();
    renderTemplates();
    renderTemplateSelect();
    showToast(`Imported ${result.projectCount} project${result.projectCount === 1 ? '' : 's'} and ${result.templateCount} template${result.templateCount === 1 ? '' : 's'}`);
  } catch (error) {
    showAlert(error.message || 'Could not import local data.');
  }
}

async function initializeApp() {
  try {
    hydrateStartupMetadata();
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

    const sessionResult = await withTimeout(
      refreshCloudSession(),
      STARTUP_IPC_TIMEOUT_MS,
      'Cloud session took too long to refresh.'
    );
    if (!sessionResult.session) {
      setSetupVisibility(true);
      showAuthPanel();
      return;
    }
    if (sessionResult.requiresEmailVerification || (sessionResult.session && !sessionResult.session.emailVerified && sessionResult.session.provider !== 'google.com')) {
      showEmailVerificationNotice(sessionResult.session.email || '');
      return;
    }

    if (state.teams.unlocked) {
      await enterCloudWorkspace();
    } else {
      resetWorkspaceData();
      showWorkspaceSetupPanel();
    }
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
  els.modalProjectName.value = normalizedProject.name || '';
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
  updateAuthFields();
}

function readModalProject() {
  const selectedTemplate = state.templates.find((template) => template.id === els.modalTemplateSelect.value);
  const variables = readModalVariables();

  const project = {
    ...state.modalDraft,
    name: els.modalProjectName.value.trim(),
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
    }
  };

  project.commands = selectedTemplate ? selectedTemplate.commands || [] : state.modalDraft.commands || [];

  return project;
}

function renderProjects() {
  els.projectList.innerHTML = '';
  els.projectGrid.innerHTML = '';

  if (!state.projects.length) {
    const empty = document.createElement('div');
    empty.className = 'project-card';
    empty.innerHTML = `
      <div class="project-card-top">
        <span class="project-icon">DX</span>
        <div class="project-card-meta">
          <strong>No projects yet</strong>
          <span>Create one to start.</span>
        </div>
      </div>
      <div class="project-card-note">Use Create project to add SSH details and commands.</div>
    `;
    els.projectGrid.appendChild(empty);
    return;
  }

  for (const project of state.projects) {
    const listItem = document.createElement('button');
    listItem.type = 'button';
    listItem.className = `project-item ${state.activeProject?.id === project.id ? 'active' : ''}`;
    listItem.innerHTML = `
      <span class="project-icon">${escapeHtml(projectBadge(project))}</span>
      <span class="project-text">
        <strong>${escapeHtml(project.name || 'Untitled Project')}</strong>
        <span>${escapeHtml(project.serverType || 'server')} · ${escapeHtml(project.ssh?.host || 'no host')}</span>
      </span>
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
          <strong>${escapeHtml(project.name || 'Untitled Project')}</strong>
          <span>${escapeHtml(project.serverType || 'server')} · ${escapeHtml(project.ssh?.host || 'no host')}</span>
        </div>
        <span class="project-card-action">${icon('chevron-right')}</span>
      </div>
      <div class="project-card-note">${project.commands?.length || 0} saved commands</div>
    `;
    card.addEventListener('click', () => openProject(project.id));
    els.projectGrid.appendChild(card);
  }
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

function setTemplateMetaLine(item, template, variableCount) {
  const meta = item.querySelector('span:not(.template-item-icon):not(.template-item-action)');
  if (!meta) return;
  const category = normalizeTemplateCategory(template.category);
  const variableText = variableCount ? ` - ${variableCount} variables` : '';
  meta.textContent = `${category} - ${template.commands?.length || 0} commands${variableText}`;
}

function selectTemplate(templateId) {
  const template = state.templates.find((item) => item.id === templateId);
  if (!template) return;
  state.activeTemplateId = template.id;
  els.templateName.value = template.name || '';
  els.templateCategory.value = normalizeTemplateCategory(template.category);
  els.templateCommands.value = Array.isArray(template.commands) ? template.commands.join('\n') : '';
  renderTemplateVariableSummary(template.commands || []);
  els.deleteTemplateButton.disabled = false;
  els.duplicateTemplateButton.disabled = false;
  els.templatePageForm.classList.remove('hidden');
  renderTemplates();
}

function newTemplate() {
  state.activeTemplateId = '';
  els.templateName.value = '';
  els.templateCategory.value = '';
  els.templateCommands.value = '';
  renderTemplateVariableSummary([]);
  els.deleteTemplateButton.disabled = true;
  els.duplicateTemplateButton.disabled = true;
  els.templatePageForm.classList.remove('hidden');
  renderTemplates();
}

function closeTemplateEditor() {
  state.activeTemplateId = '';
  els.templateName.value = '';
  els.templateCategory.value = '';
  els.templateCommands.value = '';
  renderTemplateVariableSummary([]);
  els.deleteTemplateButton.disabled = true;
  els.duplicateTemplateButton.disabled = true;
  els.templatePageForm.classList.add('hidden');
  renderTemplates();
}

function renderDetailsSummary(project) {
  const rows = [
    ['Server type', project.serverType || '-'],
    ['Host', project.ssh?.host || '-'],
    ['Port', project.ssh?.port || '22'],
    ['Username', project.ssh?.username || '-'],
    ['Authentication', project.ssh?.authType === 'key' ? 'SSH private key' : 'Password']
  ];

  els.detailsSummary.innerHTML = rows
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`
    )
    .join('');
}

function updateFtpStatus(message, connected = state.ftpConnected) {
  state.ftpConnected = Boolean(connected);
  els.ftpStatus.textContent = message;
  els.ftpWorkspace.classList.toggle('terminal-connected', state.ftpConnected);
  els.connectFtpButton.disabled = state.ftpConnected;
  els.disconnectFtpButton.disabled = !state.ftpSessionId;
  els.ftpPathInput.disabled = !state.ftpConnected;
  els.ftpBackButton.disabled = !state.ftpConnected || !state.ftpBackStack.length;
  els.ftpForwardButton.disabled = !state.ftpConnected || !state.ftpForwardStack.length;
  els.ftpRemoteFilter.disabled = !state.ftpConnected;
  renderFtpActionState();
}

function updateLocalFtpStatus(message = 'Local files') {
  els.ftpLocalStatus.textContent = message;
  els.ftpLocalPathInput.disabled = !state.ftpLocalCurrentPath;
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
  const entries = filteredEntries(state.ftpLocalEntries, state.ftpLocalFilter);

  if (!state.ftpLocalCurrentPath) {
    const empty = document.createElement('div');
    empty.className = 'ftp-empty';
    empty.textContent = 'Loading local files...';
    empty.addEventListener('contextmenu', (event) => showFtpContextMenu(event, 'local'));
    els.ftpLocalFileList.appendChild(empty);
    return;
  }

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
    empty.textContent = 'Connect FTP to browse this project server.';
    empty.addEventListener('contextmenu', (event) => showFtpContextMenu(event, 'remote'));
    els.ftpFileList.appendChild(empty);
    return;
  }

  const entries = filteredEntries(state.ftpEntries, state.ftpRemoteFilter);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'ftp-empty';
    empty.textContent = state.ftpRemoteFilter ? 'No server matches.' : 'This server folder is empty.';
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
}

async function refreshLocalFtpList(pathOverride = state.ftpLocalCurrentPath, options = {}) {
  const previousPath = state.ftpLocalCurrentPath;
  const result = await withFileActivity('Loading local files...', () => window.deployerx.localList({ path: pathOverride || undefined }));
  state.ftpLocalCurrentPath = result.path || pathOverride || '';
  state.ftpLocalParentPath = result.parentPath || '';
  state.ftpLocalEntries = Array.isArray(result.items) ? result.items : [];
  state.ftpLocalSelectedPath = '';
  if (options.pushHistory && previousPath && previousPath !== state.ftpLocalCurrentPath) {
    state.ftpLocalBackStack.push(previousPath);
    state.ftpLocalForwardStack = [];
  }
  updateLocalFtpStatus(fileNameFromPath(state.ftpLocalCurrentPath) || 'Local files');
  renderFtpBrowser();
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
    if (!state.ftpLocalCurrentPath) await refreshLocalFtpList();
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
  if (!state.ftpSessionId || !entry || pendingActions.has('ftp:upload')) return;
  try {
    await withFileActivity(`Uploading ${entry.name}...`, () =>
      withButtonLoading('ftp:upload', null, () =>
        window.deployerx.ftpUpload({
          sessionId: state.ftpSessionId,
          localPath: entry.path,
          remoteDirectory: state.ftpCurrentPath
        })
      )
    );
    await refreshFtpList();
    showToast(`Uploaded ${entry.name}`);
  } catch (error) {
    showAlert(error.message || 'Could not upload item.');
  }
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
  const isDifferentProject = state.activeProject?.id && state.activeProject.id !== project.id;

  if (isDifferentProject && state.activeTerminalSessionId) {
    window.deployerx.stopTerminal(state.activeTerminalSessionId);
    resetTerminalView();
  } else if (!state.activeTerminalSessionId) {
    resetTerminalView();
  }

  if (isDifferentProject && state.ftpSessionId) {
    window.deployerx.ftpDisconnect(state.ftpSessionId);
    state.ftpSessionId = null;
    state.ftpConnected = false;
  }

  const normalizedProject = normalizeProject(project);
  state.activeProject = structuredClone(normalizedProject);
  if (isDifferentProject || !state.ftpSessionId) {
    state.ftpCurrentPath = '.';
    state.ftpParentPath = '.';
    state.ftpEntries = [];
    state.ftpSelectedPath = '';
    state.ftpBackStack = [];
    state.ftpForwardStack = [];
  }
  els.activeProjectName.textContent = normalizedProject.name || 'Untitled Project';
  els.terminalProjectLabel.textContent = 'SSH';
  if (!state.activeTerminalSessionId) updateTerminalStatus('Not connected', false);
  updateFtpStatus(state.ftpConnected ? 'Connected' : 'Not connected', state.ftpConnected);
  els.projectTemplateSelect.value = '';
  els.commands.value = Array.isArray(normalizedProject.commands) ? normalizedProject.commands.join('\n') : '';
  renderDetailsSummary(normalizedProject);
  renderProjects();
  showView('project');
  setProjectTab(state.activeProjectTab);
  requestAnimationFrame(() => {
    fitTerminal();
    if (!state.activeTerminalSessionId) els.connectTerminalButton.focus();
  });
}

async function loadProjects() {
  const data = await window.deployerx.listProjects();
  state.projects = (data.projects || []).map(normalizeProject);
  state.templates = (data.templates || []).map(normalizeTemplate);
  renderTemplateCategories();
  renderTemplates();
  renderTemplateSelect();
  renderProjects();
  state.activeProject = null;
  showView('dashboard');
}

async function saveProject(project) {
  const saved = normalizeProject(await window.deployerx.saveProject(normalizeProject(project)));
  const index = state.projects.findIndex((item) => item.id === saved.id);
  if (index >= 0) state.projects[index] = saved;
  else state.projects.unshift(saved);
  return saved;
}

function exportPickerItems(type = state.exportPicker.type) {
  if (type === 'projects') {
    return state.projects.map((project) => ({
      id: String(project.id),
      title: project.name || 'Untitled Project',
      meta: `${project.serverType || 'server'} - ${project.ssh?.host || 'no host'} - ${project.commands?.length || 0} commands`
    }));
  }

  return state.templates.map((template) => {
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
    showToast(type === 'projects' ? 'No projects to export' : 'No templates to export');
    return;
  }

  state.exportPicker = {
    type,
    selectedIds: new Set(items.map((item) => item.id))
  };
  els.exportPickerTitle.textContent = type === 'projects' ? 'Export projects' : 'Export templates';
  els.exportPickerSubtitle.textContent =
    type === 'projects' ? 'Choose the projects to include in this JSON export.' : 'Choose the templates to include in this JSON export.';
  els.exportPickerSearch.placeholder = type === 'projects' ? 'Search projects' : 'Search templates';
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
    const itemName = state.exportPicker.type === 'projects' ? 'project' : 'template';
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
    showToast(`Imported ${result.count} project${result.count === 1 ? '' : 's'}${importResultDetail(result)}`);
  } catch (error) {
    showAlert(error.message || 'Could not import projects.');
  }
}

async function exportAccount() {
  try {
    const result = await window.deployerx.exportAccount();
    if (result?.canceled) return;
    addBackupHistory('Account exported', `${result.projectCount} projects, ${result.templateCount} templates`);
    showToast(`Exported ${result.projectCount} project${result.projectCount === 1 ? '' : 's'} and ${result.templateCount} template${result.templateCount === 1 ? '' : 's'}`);
  } catch (error) {
    showAlert(error.message || 'Could not export account.');
  }
}

async function importAccount() {
  try {
    const result = await window.deployerx.importAccount();
    if (result?.canceled) return;
    state.projects = (result.projects || []).map(normalizeProject);
    state.templates = (result.templates || []).map(normalizeTemplate);
    if (state.activeProject) {
      state.activeProject = state.projects.find((project) => project.id === state.activeProject.id) || state.activeProject;
    }
    closeTemplateEditor();
    renderProjects();
    renderTemplates();
    renderTemplateSelect();
    const projectDetail = importResultDetail(result, 'project');
    const templateDetail = importResultDetail(result, 'template');
    addBackupHistory('Account imported', `${result.projectCount} projects, ${result.templateCount} templates`);
    showToast(
      `Imported ${result.projectCount} project${result.projectCount === 1 ? '' : 's'}${projectDetail} and ${result.templateCount} template${result.templateCount === 1 ? '' : 's'}${templateDetail}`
    );
  } catch (error) {
    showAlert(error.message || 'Could not import account.');
  }
}

async function saveTemplate(event) {
  event.preventDefault();
  if (pendingActions.has('template:save')) return;
  const template = {
    id: state.activeTemplateId,
    name: els.templateName.value.trim(),
    category: els.templateCategory.value,
    commands: normalizeCommands(els.templateCommands.value),
    variables: extractTemplateVariables(els.templateCommands.value)
  };

  if (!template.name || !template.category || !template.commands.length) {
    els.templatePageForm.reportValidity();
    return;
  }

  let saved;
  try {
    const result = await withButtonLoading('template:save', els.templatePageSaveButton, () =>
      window.deployerx.saveTemplate(template)
    );
    if (!result) return;
    saved = normalizeTemplate(result);
  } catch (error) {
    showAlert(error.message || 'Could not save template.');
    return;
  }

  const index = state.templates.findIndex((item) => item.id === saved.id);
  if (index >= 0) state.templates[index] = saved;
  else state.templates.unshift(saved);
  renderTemplateSelect();
  closeTemplateEditor();
  showToast('Template saved');
}

async function deleteTemplate() {
  if (!state.activeTemplateId || pendingActions.has('template:delete')) return;
  const templateId = state.activeTemplateId;
  const template = state.templates.find((item) => item.id === templateId);
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

  state.templates = state.templates.filter((item) => item.id !== templateId);
  if (state.activeTemplateId === templateId) closeTemplateEditor();
  else renderTemplates();
  renderTemplateSelect();
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
    state.templates.unshift(saved);
    state.activeTemplateId = saved.id;
    els.templateName.value = saved.name || '';
    els.templateCategory.value = normalizeTemplateCategory(saved.category);
    els.templateCommands.value = Array.isArray(saved.commands) ? saved.commands.join('\n') : '';
    renderTemplateVariableSummary(saved.commands || []);
    els.deleteTemplateButton.disabled = false;
    els.duplicateTemplateButton.disabled = false;
    els.templatePageForm.classList.remove('hidden');
    closeDuplicateTemplateModal();
    renderTemplateSelect();
    renderTemplates();
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
    state.templates = (result.templates || []).map(normalizeTemplate);
    closeTemplateEditor();
    renderTemplateSelect();
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
  els.projectModalTitle.textContent = 'Create project';
  els.projectModalSubtitle.textContent = 'Add project and SSH details. Commands are managed inside the project.';
  fillModal(state.modalDraft);
  setModalVisible(true, els.projectModal);
}

function openEditModal() {
  if (!state.activeProject) return;
  state.modalMode = 'edit';
  els.projectModalTitle.textContent = 'Edit project';
  els.projectModalSubtitle.textContent = 'Update project and SSH details.';
  fillModal(state.activeProject);
  setModalVisible(true, els.projectModal);
}

async function commitModalProject(event) {
  event.preventDefault();
  if (pendingActions.has('project:save')) return;
  const project = readModalProject();

  if (!project.name || !project.ssh.host || !project.ssh.username) {
    return;
  }

  if (project.ssh.authType === 'key' && !project.ssh.privateKey) {
    return;
  }

  if (project.ssh.authType !== 'key' && !project.ssh.password) {
    return;
  }

  const missingVariables = missingTemplateVariables(project.commands, project);
  if (missingVariables.length) {
    showAlert(`Set project variable${missingVariables.length > 1 ? 's' : ''}: ${missingVariables.join(', ')}`);
    return;
  }

  project.commands = resolveTemplateCommands(project.commands, project);

  let saved;
  try {
    saved = await withButtonLoading('project:save', els.projectModalSaveButton, () => saveProject(project));
    if (!saved) return;
  } catch (error) {
    showAlert(error.message || 'Could not save project.');
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
    showAlert(error.message || 'Could not save project script.');
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
    `Delete project "${projectName}"?`,
    'This action cannot be undone.',
    'Delete'
  );
  if (!ok || pendingActions.has('project:delete')) return;
  try {
    await withButtonLoading('project:delete', els.deleteProjectButton, () => window.deployerx.deleteProject(projectId));
  } catch (error) {
    showAlert(error.message || 'Could not delete project.');
    return;
  }

  if (state.ftpSessionId) {
    window.deployerx.ftpDisconnect(state.ftpSessionId);
    state.ftpSessionId = null;
    state.ftpConnected = false;
    state.ftpCurrentPath = '.';
    state.ftpParentPath = '.';
    state.ftpEntries = [];
    state.ftpSelectedPath = '';
    state.ftpBackStack = [];
    state.ftpForwardStack = [];
  }
  state.projects = state.projects.filter((project) => project.id !== projectId);
  state.activeProject = state.projects[0] || null;
  renderProjects();
  if (state.activeProject) {
    populateProjectView(state.activeProject);
  } else {
    showView('dashboard');
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
  const missingVariables = missingTemplateVariables(rawCommands, state.activeProject);
  if (missingVariables.length) {
    showAlert(`Set project variable${missingVariables.length > 1 ? 's' : ''}: ${missingVariables.join(', ')}`);
    return;
  }

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
  terminal.write(`${prefix}${message}`.replace(/\n/g, '\r\n'));
  if (!String(message).endsWith('\n') && !String(message).endsWith('\r')) terminal.write('\r\n');
}

function writeTerminalData(data) {
  terminal.write(data);
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

function appendTerminalOutputBuffer(data) {
  const rawText = String(data ?? '');
  const visibleText = applyTerminalBackspaces(stripTerminalControls(rawText).replace(/\r/g, '\n'));

  state.terminalRawBuffer = `${state.terminalRawBuffer}${rawText}`.slice(-4000);
  state.terminalOutputBuffer = `${state.terminalOutputBuffer}${visibleText}`.slice(-4000);
}

function lastTerminalLine() {
  const lines = state.terminalOutputBuffer.split('\n');
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
}

function updateScriptStatus() {
  if (!state.scriptRunnerActive) {
    updateTerminalStatus('Connected', true);
    return;
  }

  updateTerminalStatus(`Running script (${state.scriptCommandQueue.length} queued)`, true);
}

async function runNextScriptCommand() {
  clearScriptPromptTimer();

  if (!state.scriptRunnerActive || state.scriptWaitingForPrompt || !state.terminalConnected) return;

  const command = state.scriptCommandQueue.shift();
  if (!command) {
    stopScriptQueue();
    updateTerminalStatus('Connected', true);
    return;
  }

  state.scriptWaitingForPrompt = true;
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';
  updateScriptStatus();
  await sendTerminalInput(`${command}\n`);
}

function createScriptPromptSetupCommand() {
  const marker = state.scriptReadyMarker;
  return `export PROMPT_COMMAND='printf "\\033]1337;${marker}\\007"'; if [ -n "$ZSH_VERSION" ]; then precmd() { printf "\\033]1337;${marker}\\007"; }; fi\n`;
}

async function prepareScriptQueue() {
  if (!state.scriptRunnerActive || !state.terminalConnected) return;

  state.scriptWaitingForPrompt = true;
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';
  updateTerminalStatus('Preparing script runner', true);
  await sendTerminalInput(createScriptPromptSetupCommand());
}

function hasScriptReadyMarker() {
  if (!state.scriptReadyMarker) return false;

  return (
    state.terminalRawBuffer.includes(`\x1b]1337;${state.scriptReadyMarker}\x07`) ||
    state.terminalRawBuffer.includes(`\x1b]1337;${state.scriptReadyMarker}\x1b\\`)
  );
}

function maybeContinueScriptQueue() {
  if (!state.scriptRunnerActive || !state.scriptWaitingForPrompt) return;

  const markerSeen = hasScriptReadyMarker();
  if (markerSeen) state.scriptPromptMarkerActive = true;

  const promptSeen = !state.scriptPromptMarkerActive && isShellPromptLine(lastTerminalLine());
  if (!markerSeen && !promptSeen) return;

  clearScriptPromptTimer();
  state.scriptPromptTimer = setTimeout(() => {
    state.scriptPromptTimer = null;
    if (!state.scriptRunnerActive || !state.scriptWaitingForPrompt) return;
    if (!hasScriptReadyMarker() && !(!state.scriptPromptMarkerActive && isShellPromptLine(lastTerminalLine()))) return;

    state.scriptWaitingForPrompt = false;
    runNextScriptCommand().catch((error) => appendLog(error.message, 'error'));
  }, 150);
}

function handleTerminalData(data) {
  writeTerminalData(data);
  appendTerminalOutputBuffer(data);
  maybeContinueScriptQueue();
}

function resetTerminalView() {
  state.activeTerminalSessionId = null;
  state.terminalConnected = false;
  state.pendingTerminalInput = '';
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';
  stopScriptQueue();
  terminal.clear();
  terminal.write('Ready.\r\n');
  updateTerminalStatus('Not connected', false);
}

async function startRun(event) {
  if (!state.activeProject) return;

  if (event?.preventDefault) event.preventDefault();
  const rawCommands = normalizeCommands(els.commands.value);
  const missingVariables = missingTemplateVariables(rawCommands, state.activeProject);
  if (missingVariables.length) {
    showAlert(`Set project variable${missingVariables.length > 1 ? 's' : ''}: ${missingVariables.join(', ')}`);
    return;
  }

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
  state.terminalOutputBuffer = '';
  state.terminalRawBuffer = '';

  await prepareScriptQueue();
}

async function ensureTerminal() {
  if (!state.activeProject) return false;
  if (state.terminalConnected) return true;
  if (state.activeTerminalSessionId) return false;
  fitTerminal();

  const sessionId = `${Date.now()}`;
  state.activeTerminalSessionId = sessionId;
  terminal.clear();
  updateTerminalStatus('Connecting...');
  appendLog(`Opening terminal: ${state.activeProject.name}\n`);

  const response = await window.deployerx.startTerminal({
    sessionId,
    project: state.activeProject,
    cols: terminal.cols,
    rows: terminal.rows
  });
  state.activeTerminalSessionId = response.sessionId || sessionId;
  updateTerminalStatus('Connecting...');
  setTimeout(() => {
    fitTerminal();
    resizeActiveTerminal();
  }, 250);
  return false;
}

async function sendTerminalInput(input) {
  if (!input) return;

  if (!state.terminalConnected) {
    if (state.activeTerminalSessionId) {
      state.pendingTerminalInput = `${state.pendingTerminalInput || ''}${input}`;
    } else {
      updateTerminalStatus('Connect SSH first', false);
    }
    return;
  }

  window.deployerx.sendTerminalInput({
    sessionId: state.activeTerminalSessionId,
    input
  });
}

async function disconnectTerminal() {
  if (!state.activeTerminalSessionId) return;
  const ok = await confirmDangerousAction(
    'Disconnect the active terminal session?',
    'Running shell commands in this terminal session will be stopped.',
    'Disconnect'
  );
  if (!ok) return;
  stopScriptQueue();
  await window.deployerx.stopTerminal(state.activeTerminalSessionId);
  state.activeTerminalSessionId = null;
  state.terminalConnected = false;
  updateTerminalStatus('Disconnected', false);
}

async function connectTerminal() {
  if (!state.activeProject || state.activeTerminalSessionId || state.terminalConnected) return;
  try {
    await ensureTerminal();
  } catch (error) {
    state.activeTerminalSessionId = null;
    state.terminalConnected = false;
    updateTerminalStatus('Connection failed', false);
    appendLog(`${error.message}\n`, 'error');
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
  appendLog('Emergency stop requested.\n', 'error');
  renderFtpBrowser();
}

els.dashboardButton.addEventListener('click', () => showView('dashboard'));
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
els.settingsImportAccountButton.addEventListener('click', importAccount);
els.settingsExportAccountButton.addEventListener('click', exportAccount);
els.deleteWorkspaceButton.addEventListener('click', deleteWorkspace);
els.workspaceCreateForm.addEventListener('submit', createWorkspace);
els.workspaceUnlockForm.addEventListener('submit', unlockWorkspace);
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
els.backToDashboardButton.addEventListener('click', () => showView('dashboard'));
els.backFromTemplatesButton.addEventListener('click', () => showView('dashboard'));
els.projectSshTab.addEventListener('click', () => setProjectTab('ssh'));
els.projectFtpTab.addEventListener('click', () => setProjectTab('ftp'));
els.editProjectButton.addEventListener('click', openEditModal);
els.deleteProjectButton.addEventListener('click', deleteCurrentProject);
els.saveCommandsButton.addEventListener('click', saveCommands);
els.runProjectButton.addEventListener('click', startRun);
els.projectTemplateSelect.addEventListener('change', applySelectedScriptTemplate);
els.emergencyStopButton.addEventListener('click', emergencyStop);
els.connectTerminalButton.addEventListener('click', connectTerminal);
els.disconnectTerminalButton.addEventListener('click', disconnectTerminal);
els.connectFtpButton.addEventListener('click', connectFtp);
els.disconnectFtpButton.addEventListener('click', disconnectFtp);
els.ftpLocalBackButton.addEventListener('click', () => goLocalFtpHistory(-1).catch((error) => showAlert(error.message || 'Could not go back.')));
els.ftpLocalForwardButton.addEventListener('click', () => goLocalFtpHistory(1).catch((error) => showAlert(error.message || 'Could not go forward.')));
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
document.addEventListener('click', (event) => {
  if (!els.ftpContextMenu || els.ftpContextMenu.contains(event.target)) return;
  hideFtpContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideFtpContextMenu();
});
els.logoutButton.addEventListener('click', logout);
els.teamSelect.addEventListener('change', () => {
  els.switchTeamButton.disabled = !els.teamSelect.value || els.teamSelect.value === state.teams.activeTeamId;
});
els.switchTeamButton.addEventListener('click', switchTeam);
els.openCreateTeamButton.addEventListener('click', () => {
  els.createTeamName.value = '';
  els.createTeamPassphrase.value = '';
  setModalVisible(true, els.createTeamModal);
  els.createTeamName.focus();
});
els.unlockTeamForm.addEventListener('submit', unlockTeam);
els.inviteMemberForm.addEventListener('submit', inviteMember);
els.importLocalToCloudButton.addEventListener('click', importLocalToCloud);
els.createTeamForm.addEventListener('submit', createTeam);
els.createTeamCloseButton.addEventListener('click', () => setModalVisible(false, els.createTeamModal));
els.createTeamCancelButton.addEventListener('click', () => setModalVisible(false, els.createTeamModal));
els.createTeamModal.addEventListener('click', (event) => {
  if (event.target === els.createTeamModal || event.target.classList.contains('modal-backdrop')) setModalVisible(false, els.createTeamModal);
});

els.projectModalForm.addEventListener('submit', commitModalProject);
els.templatePageForm.addEventListener('submit', saveTemplate);
els.uploadModalForm.addEventListener('submit', startDeployment);
els.exportPickerForm.addEventListener('submit', confirmExportPicker);
els.duplicateTemplateForm.addEventListener('submit', duplicateTemplate);
els.projectModalCloseButton.addEventListener('click', () => setModalVisible(false, els.projectModal));
els.projectModalCancelButton.addEventListener('click', () => setModalVisible(false, els.projectModal));
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
  if (state.activeTerminalSessionId && event.sessionId !== state.activeTerminalSessionId) return;

  if (event.type === 'connected') {
    state.terminalConnected = true;
    updateTerminalStatus('Connected', true);
    if (state.pendingTerminalInput) {
      window.deployerx.sendTerminalInput({
        sessionId: event.sessionId,
        input: state.pendingTerminalInput
      });
      state.pendingTerminalInput = '';
    }
    if (state.scriptRunnerActive) {
      prepareScriptQueue().catch((error) => appendLog(error.message, 'error'));
    }
  }
  if (event.type === 'log') handleTerminalData(event.payload);
  if (event.type === 'error') handleTerminalData(event.payload);
  if (event.type === 'failed') {
    stopScriptQueue();
    appendLog(`${event.payload}\n`, 'error');
    state.activeTerminalSessionId = null;
    state.terminalConnected = false;
    updateTerminalStatus('Connection failed', false);
  }
  if (event.type === 'closed') {
    stopScriptQueue();
    appendLog(`${event.payload}\n`);
    state.activeTerminalSessionId = null;
    state.terminalConnected = false;
    updateTerminalStatus('Disconnected', false);
  }
});

terminal.open(els.terminal);
terminal.write('Ready.\r\n');
requestAnimationFrame(fitTerminal);
terminal.attachCustomKeyEventHandler((event) => {
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

renderTemplateCategories();
showView('dashboard');
initializeApp().catch((error) => appendLog(error.message, 'error'));
