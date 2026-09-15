// Actual Electron + disposable DB. Remote diff fixture only; no production account/storage.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.test-data','collaboration-ui-'));
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
    await js(`window.directorCloud=true;window.memberRole='owner';window.collabRequests=[];const nativeFetch=window.fetch;window.fetch=async(url,options)=>{if(String(url).includes('/collaboration/')){if(options?.method==='POST'){collabRequests.push(JSON.parse(options.body));return new Response(JSON.stringify(String(url).endsWith('/links')?{token:'fixture-readonly-share',id:'a'.repeat(32)}:{ok:true}),{headers:{'Content-Type':'application/json'}});}return new Response(JSON.stringify(String(url).endsWith('/members')?{members:[{user_id:'b'.repeat(32),login:'editor@example.com',role:'editor',can_generate:true}]}:String(url).endsWith('/links')?{links:[]}:{role:memberRole,can_generate:true}),{headers:{'Content-Type':'application/json'}});}return nativeFetch(url,options);};directorStudio.currentProject().permission={role:'owner',can_generate:true};window.dispatchEvent(new Event('director-project-opened'));`);
    await js("document.querySelector('#share-project').click()");await wait("document.querySelector('#collaboration-members').textContent.includes('editor@example.com')");
    await js("var f=document.querySelector('#collaboration-invite');f.elements.login.value='member@example.com';f.elements.role.value='editor';f.elements.can_generate.checked=true;f.querySelector('button').click()");await wait("window.collabRequests.length===1");
    if(!await js("collabRequests[0].role==='editor'&&collabRequests[0].can_generate===true"))throw Error('Member generation permission missing');
    await wait("document.querySelector('#collaboration-message').textContent==='已完成'");
    await js("var f=document.querySelector('#collaboration-link');f.elements.label.value='客户审阅';f.elements.duration.value='never';f.querySelector('button').click()");await wait("document.querySelector('#collaboration-new-link a')!==null");
    if(!await js("collabRequests[1].expires_at===null"))throw Error('Permanent share choice lost');
    fs.writeFileSync(path.join(directory,'collaboration.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#collaboration-close').click();memberRole='viewer';directorStudio.currentProject().permission={role:'viewer',can_generate:false};window.dispatchEvent(new Event('director-project-opened'));");
    if(!await js("document.querySelector('#add-image').disabled && document.querySelector('#edit-project').disabled"))throw Error('Viewer editing controls not disabled');
    await js("document.querySelector('#share-project').click()");await wait("document.querySelector('#collaboration-manage').hidden");
    console.log('Collaboration UI passed: member role, own AK guidance, share expiration and viewer restrictions. Screenshot: '+path.join(directory,'collaboration.png'));
  }catch(e){failed=true;console.error(e.stack||e);}
  finally{if(backend&&backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}app.exit(failed?1:0);}
});
