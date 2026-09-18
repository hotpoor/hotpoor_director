// Two real Chromium pages, one project, one account; no production data.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(root,'.test-data/live-ui-'));
app.setPath('userData',path.join(directory,'profile'));let backend,failed=false;
app.whenReady().then(async()=>{
 backend=spawn(path.join(root,'.venv/bin/python'),['tests/inference_backend.py','serve','--port','0','--desktop'],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'sync-ui-fixture'}});
 backend.stderr.on('data',d=>process.stderr.write(d));
 try{
  const port=await new Promise((resolve,reject)=>{readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready')resolve(v.port);}catch{}});backend.once('exit',()=>reject(Error('backend exited')));});
  const origin='http://127.0.0.1:'+port;
  const create=()=>new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const a=create(),b=create(),js=(w,code)=>w.webContents.executeJavaScript(code,true);
  const wait=async(w,code)=>{for(let n=0;n<200;n++){if(await js(w,code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout '+code+'; '+await js(w,"document.querySelector('#live-status').textContent+' / '+document.querySelector('#studio-message').textContent"));};
  const api=`window.api=async(url,body)=>{const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json()};void 0;`;
  await a.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'sync-ui-fixture',httpOnly:true,path:'/',sameSite:'strict'});
  await a.loadURL(origin);await js(a,api);
  await js(a,`(async()=>{await api('/api/setup',{login:'collaborator',password:'test-live-password-123'});await api('/api/login',{login:'collaborator',password:'test-live-password-123'});await directorStudio.enter(await api('/api/me'));const p=await api('/api/projects',{title:'Live shared project'});await directorStudio.openProject(p.block_id);document.querySelector('#add-image').click();document.querySelector('#add-image').click();await directorStudio.save();})()`);
  const id=await js(a,'directorStudio.currentProject().block_id');
  await b.loadURL(origin);await js(b,api);await js(b,`directorStudio.openProject('${id}')`);
  await wait(a,"document.querySelector('#live-status').textContent==='协作已连接'");
  await wait(b,"directorStudio.currentProject().body.canvas.cards.length===2");
  const hold=async(w,index)=>{await js(w,`(()=>{const c=document.querySelectorAll('.generation-card')[${index}];c.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));})()`);await wait(w,`directorEditing.held().includes('card:'+directorStudio.currentProject().body.canvas.cards[${index}].id)`);};
  await hold(a,0);
  await wait(b,"document.querySelector('.generation-card').classList.contains('edit-locked')");
  if(!await js(b,"document.querySelector('.edit-lock-badge').textContent.includes('collaborator')"))throw Error('Missing editor identity');
  if(await js(b,"directorEditing.claim('card:'+directorStudio.currentProject().body.canvas.cards[0].id)"))throw Error('Second tab stole lock');
  await hold(b,1);
  await js(a,"directorStudio.currentProject().body.canvas.cards[0].title='A 编辑';directorStudio.changed();void 0");
  await js(b,"directorStudio.currentProject().body.canvas.cards[1].title='B 编辑';directorStudio.changed();void 0");
  await wait(a,"directorStudio.currentProject().body.canvas.cards[1].title==='B 编辑'");
  await wait(b,"directorStudio.currentProject().body.canvas.cards[0].title==='A 编辑'");
  await js(a,"window.editInput=document.querySelector('.generation-card textarea');editInput.focus();editInput.value='正在输入的草稿';editInput.dispatchEvent(new Event('input',{bubbles:true}));editInput.setSelectionRange(2,2);void 0");
  await js(b,"directorStudio.currentProject().body.canvas.cards[1].title='另一处新修改';directorStudio.changed();void 0");
  await wait(a,"directorStudio.currentProject().body.canvas.cards[1].title==='另一处新修改'");
  if(!await js(a,"document.activeElement===editInput&&editInput.isConnected&&editInput.selectionStart===2"))throw Error('Remote update interrupted typing');
  await js(a,"document.querySelector('#toggle-timeline').click();document.querySelector('#timeline-panel').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));void 0");
  await wait(a,"directorEditing.held().includes('timeline:main')");
  await js(b,"document.querySelector('#toggle-timeline').click()");
  await wait(b,"document.querySelector('#timeline-panel').classList.contains('edit-locked')");
  await js(a,"document.querySelector('#tl-start').value='3';document.querySelector('#tl-start').dispatchEvent(new Event('change',{bubbles:true}));void 0");
  await wait(b,"directorTimeline.data().start===3");
  fs.writeFileSync(path.join(directory,'live-locks.png'),(await b.webContents.capturePage()).toPNG());
  a.destroy();
  await wait(b,"!document.querySelector('#timeline-panel').classList.contains('edit-locked')");
  await js(b,"document.querySelector('#timeline-panel').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));void 0");
  await wait(b,"directorEditing.held().includes('timeline:main')");
  console.log('PASS: two pages, exclusive card and sequence leases, named owner, simultaneous disjoint save/merge, automatic remote render, crashed-tab expiry. '+directory);
 }catch(e){failed=true;console.error(e.stack||e);}
 finally{if(backend&&backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}app.exit(failed?1:0);}
});
