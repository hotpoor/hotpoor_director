const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('directorDesktop',Object.freeze({
  isDesktop:true,
  openAuthorization:url=>ipcRenderer.invoke('director:open-authorization',url),
  runCommand:async(request,onOutput)=>{
    const executionId=request.executionId||globalThis.crypto.randomUUID();
    const listener=(_event,payload)=>{if(payload.executionId===executionId&&typeof onOutput==='function')onOutput({stdout:payload.stdout,stderr:payload.stderr,truncated:payload.truncated});};
    ipcRenderer.on('director:command-output',listener);
    try{return await ipcRenderer.invoke('director:run-command',{...request,executionId});}
    finally{ipcRenderer.removeListener('director:command-output',listener);}
  },
  stopCommand:id=>ipcRenderer.invoke('director:stop-command',id),
  credentialNames:()=>ipcRenderer.invoke('director:credentials-list'),
  saveCredential:value=>ipcRenderer.invoke('director:credentials-save',value),
  removeCredential:name=>ipcRenderer.invoke('director:credentials-remove',name),
  agentFolders:()=>ipcRenderer.invoke('director:agent-folders'),
  addAgentFolder:()=>ipcRenderer.invoke('director:add-agent-folder'),
  removeAgentFolder:path=>ipcRenderer.invoke('director:remove-agent-folder',path)
}));
