const {spawn}=require('node:child_process');
const readline=require('node:readline');

function createWikiImporter({window,origin,dialog,executable,prefix,root,dataDirectory,pgBin,spawnProcess=spawn}){
 let busy=false;
 return {
  get busy(){return busy;},
  async run(event,requestId){
   if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');
   if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(requestId))throw Error('Invalid request');
   if(busy)return {ok:false,error:'已有导入任务正在进行。'};
   busy=true;
   try{
    const selected=await dialog.showOpenDialog(window,{title:'选择知识库 Markdown 文件夹（包含子目录）',properties:['openDirectory']});
    if(selected.canceled||!selected.filePaths[0])return {cancelled:true};
    const progress=value=>{if(!window.isDestroyed())window.webContents.send('director:wiki-import-progress',{requestId,...value});};
    progress({phase:'starting',completed:0,total:0});
    return await new Promise(resolve=>{
     let result=null,problem='',last={completed:0,total:0},lastSent=0;
     const child=spawnProcess(executable,[...prefix,'wiki-import','--root',selected.filePaths[0]],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DIRECTOR_DATA_DIR:dataDirectory,DIRECTOR_PG_BIN:pgBin,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}});
     child.stderr.on('data',()=>{});
     const lines=readline.createInterface({input:child.stdout});
     lines.on('line',line=>{
      try{const value=JSON.parse(line);
       if(value.event==='wiki-import-progress'){
        last=value;const now=Date.now();if(now-lastSent>100||value.completed===value.total){progress(value);lastSent=now;}
       }else if(value.event==='wiki-import-error'&&typeof value.message==='string')problem=value.message;
       else if(Number.isInteger(value.documents)&&value.tree_block_id)result=value;
      }catch{}
     });
     child.once('error',()=>resolve({ok:false,error:'无法启动本机导入程序。'}));
     child.once('close',code=>{lines.close();resolve(code===0&&result?{ok:true,...result}:{ok:false,error:problem||`导入未完成（已处理 ${last.completed}/${last.total}）。请检查文件夹读取权限和 Markdown 文件；原目录保留，已处理文档可能已入库。`});});
    });
   }finally{busy=false;}
  }
 };
}
module.exports={createWikiImporter};
