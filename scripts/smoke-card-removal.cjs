// Actual Electron + disposable DB. Card removal confirmation; no production account/storage.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.test-data','removal-ui-'));
app.setPath('userData',path.join(directory,'profile'));let backend,failed=false;
app.whenReady().then(async()=>{
  backend=spawn(path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['tests/inference_backend.py','serve','--port','0','--desktop'],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'sync-ui-fixture'}});
  backend.stderr.on('data',d=>process.stderr.write(d));
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),60000);readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(timer);resolve(v.port);}}catch{}});backend.once('exit',()=>reject(Error('Backend exited')));});
    const origin='http://127.0.0.1:'+port;
    const win=new BrowserWindow({width:1440,height:1080,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',(_e,level,msg)=>{if(level>=3)errors.push(msg);});
    const js=code=>win.webContents.executeJavaScript(code,true);
    const wait=async code=>{for(let n=0;n<200;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+code);};
    await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'sync-ui-fixture',httpOnly:true,path:'/',sameSite:'strict'});
    await win.loadURL(origin);await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
    await js(`window.testApi=async(url,body)=>{const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};void 0;`);
    await js(`(async()=>{await testApi('/api/setup',{login:'sync-demo',password:'sync-demo-password-123'});await testApi('/api/login',{login:'sync-demo',password:'sync-demo-password-123'});await directorStudio.enter(await testApi('/api/me'));const p=await testApi('/api/projects',{title:'雨夜来信 · 双端协作',subtitle:'保留每一次创作选择'});await directorStudio.openProject(p.block_id);})();`);
    await js("document.querySelector('#add-image').click();document.querySelector('#add-video').click();directorStudio.save();");
    await wait("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
    await js("window.confirm=window.alert=window.prompt=()=>{throw Error('Native dialog used');};document.querySelector('.remove-card').click()");
    await wait("!!document.querySelector('.director-message-dialog[open]')");
    fs.writeFileSync(path.join(directory,'remove-card.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('[data-cancel]').click()");
    await wait("!document.querySelector('.director-message-dialog')");
    if(await js("directorStudio.currentProject().body.canvas.cards.length")!==2)throw Error('Cancel removed a card');
    await js("document.querySelector('.remove-card').click()");
    await wait("!!document.querySelector('[data-accept]')");
    await js("document.querySelector('[data-accept]').click()");
    await wait("directorStudio.currentProject().body.canvas.cards.length===1");
    await js("directorStudio.save()");
    if(await js("testApi('/api/projects/'+directorStudio.currentProject().block_id).then(p=>p.body.canvas.cards.length)")!==1)throw Error('Removal not persisted');
    // A pending asynchronous confirmation must never act on a newly opened project.
    await js("document.querySelector('.remove-card').click()");
    await wait("!!document.querySelector('[data-accept]')");
    await js("(async()=>{const p=await testApi('/api/projects',{title:'另一个项目'});await directorStudio.openProject(p.block_id);document.querySelector('#add-image').click();await directorStudio.save();})()");
    await js("document.querySelector('[data-accept]').click()");
    await wait("!document.querySelector('.director-message-dialog')");
    if(await js("directorStudio.currentProject().body.canvas.cards.length")!==1)throw Error('Stale confirmation affected new project');
    if(errors.length)throw Error(errors.join('\n'));
    console.log('Card removal passed: cancel, confirmed removal persisted, stale project guard, no native dialogs. Screenshot: '+path.join(directory,'remove-card.png'));
  }catch(e){failed=true;console.error(e.stack||e);}
  finally{if(backend&&backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}app.exit(failed?1:0);}
});
