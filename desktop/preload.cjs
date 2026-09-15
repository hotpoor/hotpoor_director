const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('directorDesktop',Object.freeze({openAuthorization:url=>ipcRenderer.invoke('director:open-authorization',url)}));
