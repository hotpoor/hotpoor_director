// Uses disposable fixture credentials, no real accounts or cloud requests.
const {app,BrowserWindow}=require('electron');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');let server;
app.whenReady().then(async()=>{try{
 const profile={name:'测试七牛',provider:'qiniu',credentials_configured:true,bucket_name:'fixture-bucket',region:'z0',domain:'https://cdn.example.com'};
 const config={active_profile_id:'one',profiles:{one:profile,two:{...profile,name:'第二配置'}},providers:{qiniu:{name:'七牛',key_label:'AccessKey',secret_label:'SecretKey',regions:[['z0','华东']],help:''}}};
 server=http.createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<button id="open-storage-settings">设置</button>'+fs.readFileSync(path.join(root,'backend/web/index.html'),'utf8').match(/<dialog id="storage-dialog">[\s\S]*?<\/dialog>/)[0]+'<div id="upload-progress" hidden><button id="close-upload-progress"></button><progress id="upload-progress-bar"></progress></div><script src="/storage.js"></script>');}
  if(req.url==='/storage.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,'backend/web/storage.js')));}
  res.setHeader('Content-Type','application/json');if(req.method==='GET')return res.end(JSON.stringify(config));
  let raw='';for await(const c of req)raw+=c;const data=JSON.parse(raw);
  if(data.action==='copy'){assert.deepEqual(Object.keys(data).sort(),['action','id']);config.profiles.copy={...config.profiles[data.id],name:config.profiles[data.id].name+' · 副本'};return res.end(JSON.stringify(config));}
  if(data.id==='copy'&&!data.action){config.profiles.copy={...config.profiles.copy,...data};return res.end(JSON.stringify(config));}
  assert.equal(data.action,'reveal');
  res.end(JSON.stringify({access_key_id:'fixture-ak-'+data.id,access_key_secret:'fixture-sk-'+data.id}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}}),js=s=>win.webContents.executeJavaScript(s,true);
 const wait=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,20));}throw Error(s);};
 await win.loadURL('http://127.0.0.1:'+server.address().port);
 await js("document.querySelector('#open-storage-settings').click()");await wait("document.querySelector('[name=access_key_id]').placeholder==='已保存，留空保留'");
 assert.equal(await js("document.querySelector('[name=access_key_secret]').value"),'');
 await js("document.querySelector('#storage-reveal').click()");await wait("document.querySelector('[name=access_key_secret]').value==='fixture-sk-one'");
 assert.equal(await js("document.querySelector('[name=access_key_secret]').type"),'text');
 await js("document.querySelector('#storage-reveal').click()");assert.equal(await js("document.querySelector('[name=access_key_secret]').value"),'');
 await js("document.querySelector('#storage-reveal').click()");await wait("document.querySelector('[name=access_key_secret]').type==='text'");
 await js("document.querySelector('[data-storage-edit=two]').click()");assert.equal(await js("document.querySelector('[name=access_key_secret]').value"),'');
 await js("document.querySelector('#storage-reveal').click()");await wait("document.querySelector('[name=access_key_secret]').value==='fixture-sk-two'");
 await js("document.querySelector('[data-storage-copy=one]').click()");await wait("document.querySelector('#storage-editor-title').textContent.includes('副本')");
 assert.equal(await js("document.querySelector('#storage-form').elements.path_prefix===document.activeElement"),true);
 assert.equal(config.active_profile_id,'one');
 await js("document.querySelector('#storage-form').elements.path_prefix.value='wechat/archive';document.querySelector('#storage-save-only').click()");await wait("document.querySelector('#storage-status').textContent.includes('保存完成')");
 assert.equal(config.profiles.copy.path_prefix,'wechat/archive');assert.equal(config.profiles.one.path_prefix,undefined);assert.equal(config.active_profile_id,'one');
 await js("document.querySelector('#close-storage').click()");await wait("document.querySelector('[name=access_key_secret]').value===''");
 assert.equal(await js("document.querySelector('[name=access_key_secret]').type"),'password');
 console.log('Storage copy UI passed: saved credentials remain hidden, copy selects independent profile, prefix editable, source and active selection preserved');win.destroy();
 }catch(e){console.error(e);process.exitCode=1;}finally{server?.close();app.quit();}});
