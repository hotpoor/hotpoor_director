// Live local Director smoke: isolated task selection, real read-only retrieval, no paid calls.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),thread='test-director-scope-'+Date.now();
const origin=process.env.DIRECTOR_SCOPE_URL||'http://127.0.0.1:8890';
const directory=process.env.DIRECTOR_DATA_DIR||path.join(root,'.local');
const artifacts=process.env.DIRECTOR_SCOPE_ARTIFACTS||path.join(root,'.test-data',thread);
fs.mkdirSync(artifacts,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'director-scope-browser-')));
let win;
app.whenReady().then(async()=>{let failed=false;try{
 win=new BrowserWindow({width:1440,height:1080,show:false,webPreferences:{contextIsolation:true,sandbox:true}});
 await win.loadURL(origin+'/?thread='+thread);
 const js=code=>win.webContents.executeJavaScript(code,true);
 const wait=async code=>{for(let i=0;i<900;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout '+code);};
 await wait("document.querySelector('#notice').textContent.includes('目录已就绪')");
 const health=await js("fetch('/health').then(r=>r.json())");if(health.service!=='director-codex-scope'||!health.ok)throw Error('Not the Director service');
 const target=await js("items.find(x=>x.kind==='directory'&&pathsFor(x).length>50&&pathsFor(x).length<300).path");
 await js(`document.querySelector('#search').value=${JSON.stringify(target)};document.querySelector('#search').dispatchEvent(new Event('input'))`);
 await js(`document.querySelector('input[aria-label='+JSON.stringify('选择 '+${JSON.stringify(target)})+']').click()`);
 const count=await js('selected.size');if(count<=50)throw Error('Selection truncated');
 await js("document.querySelector('#apply').click()");await wait("document.querySelector('#notice').textContent.includes('已应用')");
 const stored=JSON.parse(fs.readFileSync(path.join(directory,'knowledge/codex-scopes',thread+'.json')));
 if(stored.paths.length!==count)throw Error('Save truncated');
 await win.reload();await wait("document.querySelector('#notice').textContent.includes('目录已就绪')");
 if(await js('selected.size')!==count)throw Error('Scope lost after reload');
 const invoke=(...args)=>spawnSync(path.join(root,'.venv/bin/python'),['-m','backend.knowledge.scope_cli','--thread',thread,...args],{cwd:root,encoding:'utf8',timeout:180000,env:{...process.env,DIRECTOR_SCOPE_URL:origin}});
 const status=invoke('status');if(status.status!==0||JSON.parse(status.stdout).selected_count!==count)throw Error('CLI status mismatch '+status.stderr);
 const codes=await js(`(async()=>{const send=body=>fetch('/api/scope/'+${JSON.stringify(thread)},{method:'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:JSON.stringify(body)});return [(await send({revision:'stale',paths:[]})).status,(await send({revision:saved.revision,paths:['../unknown']})).status]})()`);
 if(codes.join()!=='409,400')throw Error('Conflict checks failed '+codes);
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'knowledge/semantic/manifest.json')));
 const ids=Object.keys(manifest.documents).slice(0,2);
 const chosen=await js(`(async()=>{const docs=await Promise.all(${JSON.stringify(ids)}.map(id=>fetch('/wiki/api/blocks/'+id+'?include=summary').then(r=>r.json())));return docs.map(d=>d.paths.find(p=>filePaths.includes(p)));})()`);
 if(chosen.some(p=>!p))throw Error('Indexed document is absent from catalog');
 await js(`selected=new Set(${JSON.stringify(chosen)});render();document.querySelector('#apply').click()`);
 await wait("document.querySelector('#notice').textContent.includes('已应用 2')");
 const search=invoke('search','--query','研究','--page-size','1');if(search.status!==0)throw Error(search.stderr);
 const results=JSON.parse(search.stdout);if(!results.items.length||results.items.some(x=>!x.paths.every(p=>chosen.includes(p))))throw Error('Scoped search failed');
 const read=invoke('read','--block',results.items[0].block_id,'--page-size','2');if(read.status!==0||!JSON.parse(read.stdout).document.lines)throw Error('Body read failed '+read.stderr);
 const previousRevision=await js('saved.revision');
 await js("document.querySelector('#search').value='';onlySelected=true;folder='';render()");
 fs.writeFileSync(path.join(artifacts,'director-codex-scope.png'),(await win.webContents.capturePage()).toPNG());
 await js("document.querySelector('#clear').click();document.querySelector('#apply').click()");
 await wait("document.querySelector('#notice').textContent.includes('已应用 0')");
 const empty=invoke('search','--query','研究');if(empty.status===0)throw Error('Empty scope searched the library');
 win.setContentSize(440,900);await new Promise(r=>setTimeout(r,200));if(await js('document.documentElement.scrollWidth>innerWidth'))throw Error('Narrow layout overflow');
 console.log(JSON.stringify({passed:true,provider:health.service,director_pid:health.pid,folder_selection:count,real_search_total:results.total,channels:results.items.map(x=>x.channels),persistence:true,conflict_rejected:true,empty_scope_denied:true,mobile:true}));
 }catch(error){failed=true;console.error(error);if(win)fs.writeFileSync(path.join(artifacts,'failure.png'),(await win.webContents.capturePage()).toPNG());}
 finally{fs.rmSync(path.join(directory,'knowledge/codex-scopes',thread+'.json'),{force:true});if(win)win.destroy();app.exit(failed?1:0);}
});
