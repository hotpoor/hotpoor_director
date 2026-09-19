const {app,BrowserWindow}=require('electron');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(root,'.test-data','readme-dialogue-'));
app.setPath('userData',path.join(directory,'profile'));
let backend,win,failed=false;
app.whenReady().then(async()=>{
 backend=spawn(path.join(root,'.venv/bin/python'),['tests/dialogue_backend.py','serve','--port','0','--desktop','--dev'],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'dialogue-bootstrap',DIRECTOR_README_SCENES:'1'}});
 backend.stderr.on('data',d=>process.stderr.write(d));
 try{
  const port=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Startup timeout')),60000);readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(t);resolve(v.port);}}catch{}});backend.once('exit',()=>reject(Error('Backend stopped')));});
  const origin=`http://127.0.0.1:${port}`;
  win=new BrowserWindow({width:1500,height:1080,show:false,webPreferences:{preload:path.join(root,'scripts/readme-preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'dialogue-bootstrap',httpOnly:true,path:'/'});
  await win.loadURL(origin);
  const js=code=>win.webContents.executeJavaScript(code,true);
  const wait=async code=>{for(let n=0;n<300;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout '+code);};
  await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
  await js(`window.testApi=async(path,body,expected=200)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(r.status!==expected)throw Error(r.status+' '+JSON.stringify(d));return d;};void 0`);
  await js(`(async()=>{await testApi('/api/setup',{login:'dialogue-ui',password:'dialogue-password-123'});await testApi('/api/login',{login:'dialogue-ui',password:'dialogue-password-123'});await directorStudio.enter(await testApi('/api/me'));document.querySelector('#open-dialogue').click();})()`);
  await wait("document.querySelector('#dialogue-model').value==='gpt-6-astra'");
  const destination=path.join(root,'docs/screenshots');
  const capture=async name=>{await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(destination,name),(await win.webContents.capturePage()).toPNG());};
  await js("document.querySelector('#dialogue-question').value='帮我把项目资料整理成研究提纲，保留来源与后续问题。';document.querySelector('#dialogue-compose').requestSubmit()");
  await wait("document.querySelector('.dialogue-answer')?.textContent.includes('资料整理流程') && !document.querySelector('#dialogue-send').disabled");
  await js(`(async()=>{const id=document.querySelector('.dialogue-list-item').dataset.id;const c=await testApi('/api/dialogue/categories',{name:'产品研究'});await testApi('/api/dialogue/conversations/'+id,{action:'metadata',title:'研究资料 · 从收集到结论',description:'文件、模型与上下文放在一起',category_id:c.block_id,archived:false});document.querySelector('.dialogue-list-item').click()})()`);
  await wait("document.querySelector('#dialogue-title').textContent.includes('研究资料')");
  await js("document.querySelector('.dialogue-directory').open=true;document.querySelector('#dialogue-transcript').scrollTop=0");
  await capture('dialogue-overview.png');
  await js("document.querySelector('#dialogue-toggle-preferences').click()");
  await capture('dialogue-settings.png');
  await js("document.querySelector('#dialogue-toggle-preferences').click();document.querySelector('#new-dialogue').click()");
  await wait("document.querySelector('#dialogue-status').textContent==='新对话已创建'");
  await js("document.querySelector('#dialogue-run-mode').value='agent';document.querySelector('#dialogue-run-mode').dispatchEvent(new Event('change'));document.querySelector('#dialogue-question').value='整理当前项目目录，汇总 Markdown 文档。';document.querySelector('#dialogue-compose').requestSubmit()");
  await wait("[...document.querySelectorAll('.dialogue-tool-actions button')].some(b=>b.textContent==='允许执行')");
  await capture('dialogue-agent-approval.png');
  await js("[...document.querySelectorAll('.dialogue-tool-actions button')].find(b=>b.textContent==='允许执行').click()");
  await wait("document.querySelector('.dialogue-tool-output')?.textContent.includes('[2/3]')");
  await capture('dialogue-agent-output.png');
  console.log('README screenshots captured from isolated Electron UI:',destination);
 }catch(e){failed=true;console.error(e);}
 finally{if(win)win.destroy();if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(r=>backend.once('exit',r));}app.exit(failed?1:0);}
});
