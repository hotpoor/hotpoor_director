// Isolated documentation fixture: no system commands or credentials are accessed.
const {contextBridge}=require('electron');
contextBridge.exposeInMainWorld('directorDesktop',{
 isDesktop:true,agentFolders:async()=>['/demo/project'],credentialNames:async()=>['research_token'],
 runCommand:async(request,onOutput)=>{onOutput({stdout:'[1/3] 已读取项目目录\n[2/3] 正在整理 Markdown 文档…\n',stderr:'',truncated:false});await new Promise(resolve=>setTimeout(resolve,30000));return {exit_code:0,stdout:'演示完成',stderr:'',duration_ms:30000};},
 stopCommand:async()=>true
});
