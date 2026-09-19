const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('directorDesktop',Object.freeze({
  isDesktop:true,
  openAuthorization:url=>ipcRenderer.invoke('director:open-authorization',url),
  runCommand:request=>ipcRenderer.invoke('director:run-command',request),
  agentFolders:()=>ipcRenderer.invoke('director:agent-folders'),
  addAgentFolder:()=>ipcRenderer.invoke('director:add-agent-folder'),
  removeAgentFolder:path=>ipcRenderer.invoke('director:remove-agent-folder',path)
}));
