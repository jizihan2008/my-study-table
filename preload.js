const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  openAudioDialog: () => ipcRenderer.invoke('open-audio-dialog'),
  readAudioFile: (filePath) => ipcRenderer.invoke('read-audio-file', filePath),
  openBackupDir: () => ipcRenderer.invoke('open-backup-dir'),
  getBackupDir: () => ipcRenderer.invoke('get-backup-dir'),
  performBackup: (data) => ipcRenderer.invoke('perform-backup', data),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
  isElectron: true,
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
  openVideoDialog: () => ipcRenderer.invoke('open-video-dialog'),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:event', listener);
    return () => ipcRenderer.removeListener('update:event', listener);
  },
  // ── Extension System IPC ──
  extList: () => ipcRenderer.invoke('ext:list'),
  extRead: (payload) => ipcRenderer.invoke('ext:read', payload),
  extWrite: (payload) => ipcRenderer.invoke('ext:write', payload),
  extBackup: (payload) => ipcRenderer.invoke('ext:backup', payload),
  extListBackups: (payload) => ipcRenderer.invoke('ext:list-backups', payload),
  extRestore: (payload) => ipcRenderer.invoke('ext:restore', payload),
  extRemove: (payload) => ipcRenderer.invoke('ext:remove', payload),
  extOpenDir: () => ipcRenderer.invoke('ext:open-dir'),
  extTrashList: () => ipcRenderer.invoke('ext:trash-list'),
  extTrashRestore: (payload) => ipcRenderer.invoke('ext:trash-restore', payload),
  extTrashPurge: (payload) => ipcRenderer.invoke('ext:trash-purge', payload),
  extTrashEmpty: () => ipcRenderer.invoke('ext:trash-empty'),
  extImport: (payload) => ipcRenderer.invoke('ext:import', payload),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // ── Textbook Learning IPC ──
  pickPdfFile: () => ipcRenderer.invoke('pdf:pick'),
  readPdfFile: (filePath) => ipcRenderer.invoke('pdf:read', filePath),
  booksTextSave: (payload) => ipcRenderer.invoke('books:text-save', payload),
  booksTextLoad: (payload) => ipcRenderer.invoke('books:text-load', payload),
  booksTextDelete: (payload) => ipcRenderer.invoke('books:text-delete', payload),
  srcList: () => ipcRenderer.invoke('src:list'),
  srcRead: (payload) => ipcRenderer.invoke('src:read', payload),
  // ── CodeBuddy CLI IPC ──
  codebuddyLocate: (payload) => ipcRenderer.invoke('codebuddy:locate', payload),
  codebuddyInstall: (payload) => ipcRenderer.invoke('codebuddy:install', payload),
  codebuddyRun: (payload) => ipcRenderer.invoke('codebuddy:run', payload),
  codebuddyCheckLogin: (payload) => ipcRenderer.invoke('codebuddy:check-login', payload),
  codebuddyOpenLoginTerminal: (payload) => ipcRenderer.invoke('codebuddy:open-login-terminal', payload),
  srcExportSnapshot: () => ipcRenderer.invoke('src:export-snapshot'),
  onCodegenAgentOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('codegen:agent-output', listener);
    return () => ipcRenderer.removeListener('codegen:agent-output', listener);
  },
  onCodebuddyInstallOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('codebuddy:install-output', listener);
    return () => ipcRenderer.removeListener('codebuddy:install-output', listener);
  },
  // ── Inbox Assistant IPC ──
  inboxMailTest: (cfg) => ipcRenderer.invoke('mail:test', cfg),
  inboxMailFetch: (cfg) => ipcRenderer.invoke('mail:fetch', cfg),
  captureListWindows: () => ipcRenderer.invoke('capture:list-windows'),
  captureLongShot: (payload) => ipcRenderer.invoke('capture:long-shot', payload),
  captureListFiles: (payload) => ipcRenderer.invoke('capture:list-files', payload),
  capturePickDir: () => ipcRenderer.invoke('capture:pick-dir'),
  captureSaveImage: (payload) => ipcRenderer.invoke('capture:save-image', payload),
  captureReadImage: (filePath) => ipcRenderer.invoke('capture:read-image', filePath),
  captureReadFileText: (filePath) => ipcRenderer.invoke('capture:read-file-text', filePath),
  // ── Web Page Reader IPC (AI 阅读网页) ──
  webRead: (payload) => ipcRenderer.invoke('web:read', payload),
  // ── 本地 WebRTC 信令服务器（局域网 PDF 传输）──
  webrtcSignalStart: (preferredPort) => ipcRenderer.invoke('webrtc:signal-start', preferredPort),
  webrtcSignalState: () => ipcRenderer.invoke('webrtc:signal-state'),
  webrtcSignalStop: () => ipcRenderer.invoke('webrtc:signal-stop'),
  onWebrtcSignalIncoming: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('webrtc:signal-incoming', listener);
    return () => ipcRenderer.removeListener('webrtc:signal-incoming', listener);
  }
});
