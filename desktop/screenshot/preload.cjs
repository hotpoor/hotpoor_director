const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('screenCapture', {
  state: () => ipcRenderer.invoke('hotpoor:screenshot-state'),
  save: value => ipcRenderer.invoke('hotpoor:screenshot-save', value),
  capture: () => ipcRenderer.invoke('hotpoor:screenshot-capture'),
  onStatus: callback => ipcRenderer.on('hotpoor:screenshot-status', (_event, message) => callback(message))
});
