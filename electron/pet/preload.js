'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petAPI', {
  status: () => ipcRenderer.invoke('pet:status'),
  action: action => ipcRenderer.invoke('pet:action', action),
  move: delta => ipcRenderer.send('pet:move', delta),
  moveEnd: () => ipcRenderer.send('pet:move-end'),
  pointer: interactive => ipcRenderer.send('pet:pointer', interactive),
  onState: callback => ipcRenderer.on('pet:state', (_event, state) => callback(state)),
  onCue: callback => ipcRenderer.on('pet:cue', (_event, cue) => callback(cue)),
  onAnimation: callback => ipcRenderer.on('pet:animation', (_event, action) => callback(action))
});
