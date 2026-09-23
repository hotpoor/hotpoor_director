const {app,BrowserWindow}=require('electron');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const http=require('node:http');
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(root,'.test-data','wiki-ui-'));
app.setPath('userData',path.join(directory,'profile'));
let backend,win,wikiServer,failed=false;
app.whenReady().then(async()=>{
 wikiServer=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://fixture'),page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('page_size')||100);
  let items=[];
  if(url.pathname==='/api/tree'){
   items=[{kind:'directory',path:'folder',name:'folder',child_count:120},...Array.from({length:120},(_,i)=>({kind:'file',path:'folder/'+String(i).padStart(3,'0')+'.md',name:'资料 '+i}))];
  }else if(url.pathname==='/api/search'){
   items=[...Array.from({length:100},(_,i)=>({block_id:'outside'+i,paths:['outside/'+i+'.md'],score:100})),{block_id:'inside',paths:['folder/119.md'],score:1}];
  }else if(url.pathname==='/api/blocks/inside'){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({markdown:'财政预算是本篇相关资料的主题。'}));return;
  }else{res.writeHead(404);res.end();return;}
  const offset=(page-1)*size;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:items.slice(offset,offset+size),pagination:{total:items.length,pages:Math.ceil(items.length/size),has_next:offset+size<items.length}}));
 });
 await new Promise(resolve=>wikiServer.listen(0,'127.0.0.1',resolve));
 backend=spawn(path.join(root,'.venv/bin/python'),['tests/dialogue_backend.py','serve','--port','0','--desktop','--dev'],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'dialogue-bootstrap'}});
 backend.stderr.on('data',d=>process.stderr.write(d));
 try{
  const port=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Startup timeout')),60000);readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(t);resolve(v.port);}}catch{}});backend.once('exit',()=>reject(Error('Backend stopped')));});
  const origin=`http://127.0.0.1:${port}`;
  win=new BrowserWindow({width:1320,height:930,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'dialogue-bootstrap',httpOnly:true,path:'/'});
  await win.loadURL(origin);
  const js=code=>win.webContents.executeJavaScript(code,true);
  const wait=async code=>{for(let n=0;n<300;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout '+code);};
  await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
  await js(`window.testApi=async(path,body,expected=200)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(r.status!==expected)throw Error(r.status+' '+JSON.stringify(d));return d;};void 0`);
  await js(`(async()=>{await testApi('/api/setup',{login:'dialogue-ui',password:'dialogue-password-123'});await testApi('/api/login',{login:'dialogue-ui',password:'dialogue-password-123'});await directorStudio.enter(await testApi('/api/me'));document.querySelector('#open-dialogue').click();})()`);
  await wait("document.querySelector('#dialogue-model').value==='gpt-6-astra'");
  const wikiOrigin='http://127.0.0.1:'+wikiServer.address().port;
  await js(`testApi('/api/wiki/config',{enabled:true,base_url:${JSON.stringify(wikiOrigin)},max_chars_per_doc:4000,max_total_chars:16000})`);
  await js("document.querySelector('#new-dialogue').click()");
  await wait("document.querySelector('#dialogue-list .dialogue-list-item')&&!document.querySelector('#new-dialogue').disabled");
  await js("document.querySelector('#dialogue-settings-launcher').click();document.querySelector('[data-settings-page=wiki]').click()");
  await wait("document.querySelector('input[data-wiki-kind=directory]')");
  await js("document.querySelector('input[data-wiki-kind=directory]').click()");
  await wait("document.querySelector('#wiki-sel-count').textContent==='120'&&!document.querySelector('#dialogue-send').disabled");
  if(!await js("document.querySelector('input[data-wiki-kind=directory]').checked"))throw Error('Folder not fully checked');
  await js("document.querySelector('.dialogue-wiki-node button').click()");
  await wait("document.querySelectorAll('input[data-wiki-kind=file]').length===120");
  if(!await js("[...document.querySelectorAll('input[data-wiki-kind=file]')].every(c=>c.checked)"))throw Error('Children not selected');
  await js("document.querySelector('input[data-wiki-kind=file]').click()");
  await wait("document.querySelector('#wiki-sel-count').textContent==='119'&&!document.querySelector('#dialogue-send').disabled");
  if(!await js("document.querySelector('input[data-wiki-kind=directory]').indeterminate"))throw Error('Partial state missing');
  await js("document.querySelector('input[data-wiki-kind=directory]').click()");
  await wait("document.querySelector('#wiki-sel-count').textContent==='120'&&!document.querySelector('#dialogue-send').disabled");
  // Reopen the saved conversation and check all 120 paths survived persistence.
  await js("document.querySelector('#dialogue-settings-page [data-close]').click();document.querySelector('#dialogue-list .dialogue-list-item').click()");
  await wait("!document.querySelector('#dialogue-send').disabled");
  await js("document.querySelector('#dialogue-question').textContent='财政预算';document.querySelector('#dialogue-compose').requestSubmit()");
  await wait("document.querySelector('#dialogue-wiki-confirm').open");
  if(!await js("document.querySelector('#dialogue-wiki-confirm header strong').textContent.includes('120')"))throw Error('Scope was truncated on reopen');
  await js("document.querySelector('#dialogue-wiki-confirm ul button').click()");
  if(!await js("[...document.querySelectorAll('#dialogue-wiki-confirm li')].filter(n=>n.textContent.includes('folder/')).length===120"))throw Error('Confirmation hides selections');
  await js("document.querySelector('#dialogue-wiki-confirm [data-confirm]').click()");
  await wait("document.querySelector('.dialogue-answer')?.textContent.includes('模型 gpt-6-astra')");
  await wait("!document.querySelector('#dialogue-send').disabled");
  await js("document.querySelector('.dialogue-context').open=true");
  if(!await js("document.querySelector('.dialogue-context').textContent.includes('勾选 120 篇')&&document.querySelector('.dialogue-context').textContent.includes('folder/119.md')&&!document.querySelector('.dialogue-context').textContent.includes('outside/')"))throw Error('Actual retrieval report missing or scope leaked');
  await new Promise(resolve=>setTimeout(resolve,250));
  await js("document.querySelector('.dialogue-context').open=true;document.querySelector('.dialogue-context').scrollIntoView()");
  await new Promise(resolve=>setTimeout(resolve,250));
  fs.writeFileSync(path.join(directory,'wiki-retrieval.png'),(await win.webContents.capturePage()).toPNG());
  console.log('Wiki UI verified: full folder selection, 120 persisted paths, partial state, reopen, confirmation, late-page in-scope retrieval and report. Artifacts:',directory);
 }catch(e){failed=true;console.error(e);if(win){console.error(await win.webContents.executeJavaScript("document.querySelector('#dialogue-status')?.textContent"));fs.writeFileSync(path.join(directory,'failure.png'),(await win.webContents.capturePage()).toPNG());}}
 finally{if(wikiServer)wikiServer.close();if(win)win.destroy();if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(r=>backend.once('exit',r));}app.exit(failed?1:0);}
});
