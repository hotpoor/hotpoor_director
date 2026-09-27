const {app,BrowserWindow}=require('electron');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const http=require('node:http');
const sourceMarkdown='前文😀\n'.repeat(1000)+'财政预算是本篇相关资料的主题。<script>unsafe</script>\n'+'后文\n'.repeat(2000);
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(root,'.test-data','wiki-ui-'));
app.setPath('userData',path.join(directory,'profile'));
let backend,win,wikiServer,failed=false;
app.whenReady().then(async()=>{
 wikiServer=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  const send=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  const url=new URL(req.url,'http://fixture'),page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('page_size')||100);
  let items=[];
  if(url.pathname==='/api/resolve'){
   return send({block_ids:body.paths.map(p=>'doc-'+p.split('/')[1].split('.')[0]),missing_paths:[]});
  }else if(url.pathname==='/api/semantic/index'){
   return send({ready:true});
  }else if(url.pathname==='/api/hybrid/search'){
   if(body.block_ids.length!==120)throw Error('Incomplete request scope');
   return send({items:[{block_id:'doc-119',paths:['folder/119.md'],score:1,channels:['lexical','semantic'],passages:[{char_start:4000}]}],pagination:{has_next:false},retrieval:{strategy:'hybrid_union_rrf',lexical_count:1,semantic_count:1,overlap_count:1,union_count:1}});
  }else if(url.pathname==='/api/tree'){
   items=[{kind:'directory',path:'folder',name:'folder',child_count:120},...Array.from({length:120},(_,i)=>({kind:'file',path:'folder/'+String(i).padStart(3,'0')+'.md',name:'资料 '+i}))];
  }else if(url.pathname==='/api/search'){
   items=[...Array.from({length:100},(_,i)=>({block_id:'outside'+i,paths:['outside/'+i+'.md'],score:100})),{block_id:'inside',paths:['folder/119.md'],score:1}];
  }else if(url.pathname==='/api/blocks/doc-119'){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({markdown:sourceMarkdown}));return;
  }else{res.writeHead(404);res.end();return;}
  const offset=(page-1)*size;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:items.slice(offset,offset+size),pagination:{total:items.length,pages:Math.ceil(items.length/size),has_next:offset+size<items.length}}));
 });
 await new Promise(resolve=>wikiServer.listen(0,'127.0.0.1',resolve));
 backend=spawn(path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),['tests/dialogue_backend.py','serve','--port','0','--desktop','--dev'],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'dialogue-bootstrap'}});
 backend.stderr.on('data',d=>process.stderr.write(d));
 try{
  const port=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Startup timeout')),360000);readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(t);resolve(v.port);}}catch{}});backend.once('exit',()=>reject(Error('Backend stopped')));});
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
  await js(`window.directorDesktop={importWikiFolder:async callback=>{callback({phase:'importing',completed:2,total:2});return window.cancelWikiImport?{cancelled:true}:{ok:true,documents:2,skipped:1};}};void 0`);
  await js(`testApi('/api/wiki/config',{enabled:true,provider:'builtin'})`);
  if(!await js(`(async()=>{const result=await testApi('/api/wiki/library/health');return result.ok&&result.databases.length===3;})()`))throw Error('Built-in Wiki is not healthy');
  const wikiOrigin='http://127.0.0.1:'+wikiServer.address().port;
  await js(`testApi('/api/wiki/config',{enabled:true,base_url:${JSON.stringify(wikiOrigin)},max_chars_per_doc:4000,max_total_chars:16000})`);
  await js("document.querySelector('#new-dialogue').click()");
  await wait("document.querySelector('#dialogue-list .dialogue-list-item')&&!document.querySelector('#new-dialogue').disabled");
  await wait("document.querySelector('#dialogue-sources input[data-wiki-kind=directory]')");
  if(!await js("document.querySelector('#dialogue-settings-page').hidden&&document.querySelector('#dialogue-sources').getBoundingClientRect().right<=document.querySelector('.dialogue-main').getBoundingClientRect().left+1"))throw Error('Sources not visible beside conversation');
  await js("document.querySelector('#wiki-source-settings').click()");
  await wait(`document.querySelector('#wiki-base-url').value===${JSON.stringify(wikiOrigin)}&&document.querySelector('#wiki-provider').value==='external'`);
  await wait("document.querySelector('input[data-wiki-kind=directory]')");
  await js("document.querySelector('#wiki-provider').value='builtin';document.querySelector('#wiki-provider').dispatchEvent(new Event('change'));document.querySelector('#wiki-save-config').click()");
  await wait("document.querySelector('[data-config-notice]').textContent.includes('设置已保存')");
  if(!await js("document.querySelector('#wiki-external-url').hidden"))throw Error('Built-in mode still requires URL');
  if(!await js("(async()=>{const cfg=await testApi('/api/wiki/config');return cfg.provider==='builtin'&&!('_knowledge' in cfg);})()"))throw Error('Provider switch or secret filtering failed');
  if(await js("document.querySelector('#wiki-import-folder').disabled"))throw Error('Native import entry disabled');
  await js("window.cancelWikiImport=true;document.querySelector('#wiki-import-folder').click()");
  await wait("document.querySelector('#wiki-import-status').textContent.includes('已取消')&&!document.querySelector('#wiki-import-folder').disabled");
  await js("window.cancelWikiImport=false;document.querySelector('#wiki-import-folder').click()");
  await wait("document.querySelector('#wiki-import-status').textContent.includes('已导入 2 篇')&&!document.querySelector('#wiki-import-folder').disabled");

  await js("document.querySelector('#wiki-provider').value='external';document.querySelector('#wiki-provider').dispatchEvent(new Event('change'));document.querySelector('#wiki-save-config').click()");
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
  // The sidebar must distinguish ready, missing, running and failed documents.
  await js(`window.realWikiFetch=window.fetch;window.fetch=async (url,options)=>{if(String(url)==='/api/wiki/readiness'){const paths=JSON.parse(options.body).paths;return new Response(JSON.stringify({supported:true,ready:false,job:{state:'running',completed_documents:2,total_documents:3,current_completed_chunks:4,current_total_chunks:9},items:paths.map((path,index)=>({path,documents:[{block_id:path,lexical:{state:index===0?'missing':'ready',terms:index===0?0:42},semantic:{state:index===0?'missing':index===1?'running':index===2?'failed':'ready',chunks:3,completed_chunks:4,total_chunks:9}}]}))}),{status:200,headers:{'Content-Type':'application/json'}});}return window.realWikiFetch(url,options);};void 0`);
  await js("document.querySelector('#wiki-tree-refresh').click()");
  await wait("document.querySelector('.wiki-document-processing')?.textContent.includes('分词 119/120')");
  await js("document.querySelector('.dialogue-wiki-node button').click()");
  await wait("document.querySelectorAll('input[data-wiki-kind=file]').length===120");
  await wait("[...document.querySelectorAll('.wiki-document-processing')].some(n=>n.textContent.includes('分词未整理'))&&[...document.querySelectorAll('.wiki-document-processing')].some(n=>n.textContent.includes('向量整理中 4/9'))&&[...document.querySelectorAll('.wiki-document-processing')].some(n=>n.textContent.includes('向量异常'))");
  await js("window.fetch=window.realWikiFetch;void 0");
  // Reopen the saved conversation and check all 120 paths survived persistence.
  await js("document.querySelector('#dialogue-settings-page [data-close]').click();document.querySelector('#dialogue-list .dialogue-list-item').click()");
  await wait("!document.querySelector('#dialogue-send').disabled");
  await wait("document.querySelector('#dialogue-sources input[data-wiki-kind=directory]')?.checked");
  if(!await js("document.querySelector('#wiki-source-state').textContent.includes('120')"))throw Error('Persistent selection summary missing');
  await js("document.querySelector('#dialogue-sources .dialogue-wiki-node button').click()");
  await wait("document.querySelectorAll('#dialogue-sources input[data-wiki-kind=file]').length===120");
  await js("document.querySelector('#dialogue-sources input[data-wiki-kind=file]').click()");
  await wait("document.querySelector('#wiki-sel-count').textContent==='119'&&!document.querySelector('#dialogue-send').disabled");
  await js("document.querySelector('#dialogue-sources input[data-wiki-kind=directory]').click()");
  await wait("document.querySelector('#wiki-sel-count').textContent==='120'&&!document.querySelector('#dialogue-send').disabled");
  win.setSize(700,900);
  await new Promise(r=>setTimeout(r,150));
  if(!await js("document.querySelector('#dialogue-sources').getBoundingClientRect().bottom<=document.querySelector('.dialogue-main').getBoundingClientRect().top+1&&document.querySelector('#dialogue-compose').getBoundingClientRect().bottom<=innerHeight"))throw Error('Narrow layout overlaps composer');
  win.setSize(1320,930);
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
  if(!await js("document.querySelector('.wiki-channel-badge[data-channel=both]')?.textContent==='两路均命中'&&document.querySelector('.wiki-channel-summary')?.textContent.includes('分词 1 · 向量 1 · 两路重合 1 · 合并去重 1')"))throw Error('Retrieval provenance or overlap counts missing');
  await wait("!document.querySelector('#dialogue-status').textContent.includes('模型正在回答')");
  await js("document.querySelector('.dialogue-context').open=true;document.querySelector('.dialogue-context').dispatchEvent(new Event('toggle'));document.querySelector('.dialogue-context').scrollIntoView()");
  await new Promise(resolve=>setTimeout(resolve,250));
  fs.writeFileSync(path.join(directory,'wiki-retrieval.png'),(await win.webContents.capturePage()).toPNG());
  await js("document.querySelector('.wiki-source-link').click()");
  await wait("!!document.querySelector('#wiki-source-reader mark')");
  if(!await js(`document.querySelector('#wiki-source-reader mark').textContent===${JSON.stringify(Array.from(sourceMarkdown).slice(3000,7000).join(''))}&&!document.querySelector('#wiki-source-reader script')`))throw Error('Unicode offsets or safe plaintext rendering failed');
  await wait("document.querySelector('#wiki-source-reader pre').scrollTop>0");
  if(!await js("document.querySelector('#wiki-source-reader [role=tab][aria-selected=true]')&&document.querySelector('#wiki-source-reader').getBoundingClientRect().left>=document.querySelector('.dialogue-main').getBoundingClientRect().right-1"))throw Error('Source reader is not docked on the right');
  await new Promise(resolve=>setTimeout(resolve,250));
  fs.writeFileSync(path.join(directory,'wiki-source-reader.png'),(await win.webContents.capturePage()).toPNG());
  await js("document.querySelector('#wiki-source-reader [data-close]').click()");
  if(!await js("document.querySelector('#wiki-source-reader').hidden&&!document.querySelector('#dialogue-mode').classList.contains('wiki-reader-open')"))throw Error('Reader did not close');
  console.log('Wiki UI verified: full folder selection, 120 persisted paths, partial state, reopen, confirmation, late-page in-scope retrieval and report. Artifacts:',directory);
 }catch(e){failed=true;console.error(e);if(win){console.error(await win.webContents.executeJavaScript("document.querySelector('#dialogue-status')?.textContent"));fs.writeFileSync(path.join(directory,'failure.png'),(await win.webContents.capturePage()).toPNG());}}
 finally{if(wikiServer)wikiServer.close();if(win)win.destroy();if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(r=>backend.once('exit',r));}app.exit(failed?1:0);}
});
