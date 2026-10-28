// Browser fixtures only; no real WeChat data or paid cloud requests.
const {app,BrowserWindow}=require('electron'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');let server;
app.whenReady().then(async()=>{try{
 const conversation={block_id:'a'.repeat(32),body:{title:'产品讨论（测试数据）',count:205,storage:'cloud',storage_name:'七牛归档',source_name:'fixture.json',last_time:'2026-10-29 09:30:00'}},rows=[conversation],imports=[];
 const messages=Array.from({length:205},(_,i)=>({id:String(i),sender:i%2?'我':'张三',time:'2026-10-29 09:30:00',text:i===0?'<img src=x onerror="window.pwned=true">':`讨论消息 ${i}`,is_self:!!(i%2),type:'text'}));
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json; charset=utf-8');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<meta charset="utf-8"><link rel="stylesheet" href="/wechat.css"><button id="open-wechat">微信模式</button><script src="/wechat.js"></script>');}
  if(['/wechat.js','/wechat.css'].includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');return res.end(fs.readFileSync(path.join(root,'backend/web'+url.pathname)));}
  if(url.pathname==='/api/settings/storage')return res.end(JSON.stringify({profiles:{chosen:{name:'七牛归档',bucket_name:'fixture-private'}}}));
  let data;if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;data=JSON.parse(raw);}
  if(url.pathname==='/api/wechat/preview')return res.end(JSON.stringify({title:'导入测试',count:2,sample:messages.slice(0,2)}));
  if(url.pathname==='/api/wechat/conversations'){
   if(data){imports.push(data);rows.unshift({block_id:'b'.repeat(32),body:{...conversation.body,title:'新导入会话',count:2,storage:'cloud',storage_name:'七牛归档'}});return res.end(JSON.stringify({id:'b'.repeat(32),count:2}));}
   return res.end(JSON.stringify({conversations:rows}));
  }
  if(url.pathname.startsWith('/api/wechat/conversations/')){const offset=Number(url.searchParams.get('offset')||0),query=url.searchParams.get('q');let selected=query?messages.filter(m=>m.text.includes(query)):messages;return res.end(JSON.stringify({messages:selected.slice(offset,offset+100),total:selected.length,next_offset:offset+100<selected.length?offset+100:null}));}
  res.statusCode=404;res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const win=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{sandbox:true,contextIsolation:true}}),js=s=>win.webContents.executeJavaScript(s,true);
 const wait=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,30));}throw Error(s);};
 await win.loadURL('http://127.0.0.1:'+server.address().port);await js("document.querySelector('#open-wechat').click()");await wait("document.querySelector('.wx-conversation')!==null");
 await js("document.querySelector('.wx-conversation').click()");await wait("document.querySelectorAll('#wx-messages .wx-message').length===100");
 assert.equal(await js('!!window.pwned'),false);assert.equal(await js("document.querySelectorAll('.wx-bubble img').length"),0);
 await js("document.querySelector('#wx-more').click()");await wait("document.querySelectorAll('#wx-messages .wx-message').length===200");
 await js("document.querySelector('#wx-search').value='讨论消息 204';document.querySelector('#wx-search').dispatchEvent(new Event('input'))");await wait("document.querySelectorAll('#wx-messages .wx-message').length===1");
 await js("document.querySelector('#wx-search').value='';document.querySelector('#wx-search').dispatchEvent(new Event('input'))");await wait("document.querySelectorAll('#wx-messages .wx-message').length===100");
 fs.writeFileSync('/tmp/director-wechat-desktop.png',(await win.webContents.capturePage()).toPNG());
 await js("document.querySelector('#wx-import-open').click()");await wait("document.querySelector('#wx-storage option[value=\"cloud:chosen\"]')!==null");
 await js("var dt=new DataTransfer();dt.items.add(new File([JSON.stringify({messages:[]})],'fixture.json',{type:'application/json'}));document.querySelector('#wx-file').files=dt.files;document.querySelector('#wx-file').dispatchEvent(new Event('change'));");await wait("!document.querySelector('#wx-confirm').disabled");
 await js("document.querySelector('#wx-storage').value='cloud:chosen';document.querySelector('#wx-confirm').click()");await wait("document.querySelector('#wx-import-panel').hidden");
 assert.equal(imports.length,1);assert.equal(imports[0].profile_id,'chosen');assert.equal(imports[0].storage,'cloud');
 await js("document.querySelector('#wx-import-open').click()");assert.equal(await js("document.querySelector('#wx-confirm').disabled"),true);
 await js("document.querySelector('#wx-import-close').click()");
 win.setSize(390,844);await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 assert.ok(await js("document.querySelector('#wechat-mode').scrollWidth<=document.querySelector('#wechat-mode').clientWidth"));
 fs.writeFileSync('/tmp/director-wechat-mobile.png',(await win.webContents.capturePage()).toPNG());
 console.log('WeChat UI passed: reading, pagination, search, XSS escaping, preview, selected cloud profile, repeat import, 390px layout');win.destroy();
 }catch(e){console.error(e);process.exitCode=1;}finally{server?.close();app.quit();}});
