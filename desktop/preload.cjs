const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('directorDesktop',Object.freeze({
  isDesktop:true,
  openAuthorization:url=>ipcRenderer.invoke('director:open-authorization',url),
  runCommand:request=>ipcRenderer.invoke('director:run-command',request)
}));
