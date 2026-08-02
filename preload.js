const { contextBridge, ipcRenderer } = require('electron');

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
  }
});
