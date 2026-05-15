const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deployerx', {
  getAppMetadata: () => ipcRenderer.invoke('app:metadata'),
  getSetup: () => ipcRenderer.invoke('setup:get'),
  setSetupMode: (mode) => ipcRenderer.invoke('setup:setMode', mode),
  selectFirebaseConfig: () => ipcRenderer.invoke('setup:select-firebase-config'),
  register: (payload) => ipcRenderer.invoke('auth:register', payload),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  loginWithGoogle: () => ipcRenderer.invoke('auth:google'),
  forgotPassword: (payload) => ipcRenderer.invoke('auth:forgotPassword', payload),
  resendVerification: () => ipcRenderer.invoke('auth:resendVerification'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  authSession: () => ipcRenderer.invoke('auth:session'),
  listTeams: () => ipcRenderer.invoke('teams:list'),
  createTeam: (payload) => ipcRenderer.invoke('teams:create', payload),
  switchTeam: (teamId) => ipcRenderer.invoke('teams:switch', teamId),
  inviteTeamMember: (payload) => ipcRenderer.invoke('teams:invite', payload),
  revokeTeamInvite: (payload) => ipcRenderer.invoke('teams:revokeInvite', payload),
  acceptTeamInvite: (payload) => ipcRenderer.invoke('teams:acceptInvite', payload),
  removeTeamMember: (payload) => ipcRenderer.invoke('teams:removeMember', payload),
  deleteTeam: (payload) => ipcRenderer.invoke('teams:delete', payload),
  importLocalToCloud: () => ipcRenderer.invoke('cloud:import-local'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  exportProjects: (projectIds) => ipcRenderer.invoke('projects:export', projectIds),
  importProjects: () => ipcRenderer.invoke('projects:import'),
  exportAccount: () => ipcRenderer.invoke('account:export'),
  importAccount: () => ipcRenderer.invoke('account:import'),
  saveTemplate: (template) => ipcRenderer.invoke('templates:save', template),
  deleteTemplate: (id) => ipcRenderer.invoke('templates:delete', id),
  exportTemplates: (templateIds) => ipcRenderer.invoke('templates:export', templateIds),
  importTemplates: () => ipcRenderer.invoke('templates:import'),
  selectKey: () => ipcRenderer.invoke('dialog:select-key'),
  selectUpload: () => ipcRenderer.invoke('dialog:select-upload'),
  selectFtpUpload: () => ipcRenderer.invoke('dialog:select-ftp-upload'),
  selectFtpDownload: (defaultName) => ipcRenderer.invoke('dialog:select-ftp-download', defaultName),
  getPathForDroppedFile: (file) => {
    try {
      return file?.path || webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  runDeployment: (payload) => ipcRenderer.invoke('deployment:run', payload),
  stopDeployment: (runId) => ipcRenderer.invoke('deployment:stop', runId),
  startTerminal: (payload) => ipcRenderer.invoke('terminal:start', payload),
  sendTerminalInput: (payload) => ipcRenderer.send('terminal:input:send', payload),
  resizeTerminal: (payload) => ipcRenderer.invoke('terminal:resize', payload),
  stopTerminal: (sessionId) => ipcRenderer.invoke('terminal:stop', sessionId),
  localList: (payload) => ipcRenderer.invoke('local:list', payload),
  localOpen: (payload) => ipcRenderer.invoke('local:open', payload),
  localOpenWith: (payload) => ipcRenderer.invoke('local:open-with', payload),
  localMkdir: (payload) => ipcRenderer.invoke('local:mkdir', payload),
  localRename: (payload) => ipcRenderer.invoke('local:rename', payload),
  localDelete: (payload) => ipcRenderer.invoke('local:delete', payload),
  ftpConnect: (payload) => ipcRenderer.invoke('ftp:connect', payload),
  ftpList: (payload) => ipcRenderer.invoke('ftp:list', payload),
  ftpUpload: (payload) => ipcRenderer.invoke('ftp:upload', payload),
  ftpDownload: (payload) => ipcRenderer.invoke('ftp:download', payload),
  ftpDownloadToDirectory: (payload) => ipcRenderer.invoke('ftp:download-to-directory', payload),
  ftpOpen: (payload) => ipcRenderer.invoke('ftp:open', payload),
  ftpOpenWith: (payload) => ipcRenderer.invoke('ftp:open-with', payload),
  ftpMkdir: (payload) => ipcRenderer.invoke('ftp:mkdir', payload),
  ftpRename: (payload) => ipcRenderer.invoke('ftp:rename', payload),
  ftpDelete: (payload) => ipcRenderer.invoke('ftp:delete', payload),
  ftpDisconnect: (sessionId) => ipcRenderer.invoke('ftp:disconnect', sessionId),
  emergencyStop: () => ipcRenderer.invoke('emergency:stop'),
  resolveConfirmation: (payload) => ipcRenderer.invoke('ui:confirm-response', payload),
  onConfirmationRequest: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('ui:confirm-request', handler);
    return () => ipcRenderer.removeListener('ui:confirm-request', handler);
  },
  onDeploymentEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('deployment:event', handler);
    return () => ipcRenderer.removeListener('deployment:event', handler);
  },
  onTerminalEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('terminal:event', handler);
    return () => ipcRenderer.removeListener('terminal:event', handler);
  }
});
