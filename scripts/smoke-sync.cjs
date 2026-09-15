// Actual Electron + disposable DB. Remote diff fixture only; no production account/storage.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.test-data','sync-ui-'));
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
    await js(`(async()=>{const a=await testApi('/api/sync/targets',{name:'制作团队云端',url:'https://api.xialiwei.com/hotpoor/director',access_key:'fixture-not-a-real-key'});await testApi('/api/sync/targets',{name:'个人归档云端',url:'https://archive.example.com/director',access_key:'fixture-not-a-real-key'});window.fixtureTarget=a.targets[0].id;})();`);
    await js(`window.originalFetch=window.fetch;window.fetch=async(url,options)=>{if(String(url).includes('/api/sync/projects/')&&String(url).includes('/targets/')){const d=JSON.parse(options.body);if(d.action==='preview')return new Response(JSON.stringify({local_hash:'a'.repeat(64),remote_hash:'b'.repeat(64),local_time:1789451940000,remote_time:1789452000000,local_changes:[{path:'/cards/镜头一/drafts/text/prompt',operation:'replace',before:'雨夜，人物走过街角',after:'雨夜，低机位跟拍人物走过街角，保留雨滴反光'},{path:'/cards/镜头二/x',operation:'replace',before:620,after:780}],remote_changes:[{path:'/cards/镜头一/drafts/text/prompt',operation:'replace',before:'雨夜，人物走过街角',after:'雨夜，固定远景，人物停在街角等候'}],conflicts:[{path:'/cards/镜头一/drafts/text/prompt'}],identical:false}),{headers:{'Content-Type':'application/json'}});}return originalFetch(url,options);};void 0;`);
    await js("document.querySelector('[data-desktop-sync]').click()");await wait("document.querySelector('#sync-target-list').children.length===2 && !document.querySelector('#sync-preview').disabled");
    if(!await js("document.querySelector('#sync-target-form').elements.access_key.value===''"))throw Error('Saved key leaked to form');
    await js("document.querySelector('#sync-preview').click()");await wait("document.querySelector('#sync-summary').textContent.includes('冲突')");
    if(!await js("!document.querySelector('#sync-pull').disabled && document.querySelectorAll('#sync-diff .sync-change').length===3"))throw Error('Diff actions/rows missing');
    const png=(await win.webContents.capturePage()).toPNG();fs.writeFileSync(path.join(directory,'cloud-sync-diff.png'),png);
    if(process.argv.includes('--readme'))fs.writeFileSync(path.join(root,'docs/screenshots/cloud-sync-diff.png'),png);
    await js("document.querySelector('#sync-close').click();[...document.querySelectorAll('.canvas-bottom button')].find(b=>b.textContent==='修改历史').click()");
    await wait("document.querySelector('#history-events details')!==null");
    if(errors.some(e=>!e.includes('401')&&!e.includes('ERR_CONNECTION_REFUSED')))throw Error('Renderer errors: '+errors.join('\n'));
    console.log('Sync UI passed: multiple targets, hidden key, three-way diff, conflict actions, durable history. Screenshot: '+path.join(directory,'cloud-sync-diff.png'));
    win.destroy();
  }catch(e){failed=true;console.error(e.stack||e);}
  finally{if(backend&&backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}app.exit(failed?1:0);}
});
