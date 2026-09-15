// Isolated Electron form check; API responses are fixtures, no real keys or accounts.
const {app,BrowserWindow}=require('electron'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),api=process.env.DIRECTOR_API_CHECKOUT||path.resolve(root,'../../api_xialiwei_com');
const directory=fs.mkdtempSync(path.join(root,'.test-data/key-expiration-'));app.setPath('userData',path.join(directory,'profile'));
let server;
app.whenReady().then(async()=>{try{
 const rows=[],requests=[];
 server=http.createServer(async(req,res)=>{const url=req.url.split('?')[0];res.setHeader('Content-Type','application/json');
 if(url.endsWith('/authorize')){res.setHeader('Content-Type','text/html');return res.end(fs.readFileSync(path.join(api,'web/director/authorize.html')));}
 if(url.endsWith('/auth-ui.js')){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(api,'web/director/auth-ui.js')));}
 if(url.endsWith('/static/style.css')){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(root,'backend/web/style.css')));}
 if(req.method==='GET')return res.end(JSON.stringify({keys:rows}));
 let raw='';for await(const c of req)raw+=c;const data=JSON.parse(raw);requests.push({url,data});
 if(url.endsWith('/auth/keys'))rows.push({key_id:String(rows.length+1),label:data.name,created_at:Date.now(),expires_at:data.expires_at,last_used:null,revoked_at:null});
 if(url.endsWith('/expiration'))rows.find(r=>r.key_id===url.split('/').at(-2)).expires_at=data.expires_at;
 res.end(JSON.stringify({note:'已保存',access_key:'fixture-only'}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const win=new BrowserWindow({width:1100,height:1300,show:false,webPreferences:{sandbox:true,contextIsolation:true}}),js=s=>win.webContents.executeJavaScript(s,true);
 const wait=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,30));}throw Error(s);};
 await win.loadURL('http://127.0.0.1:'+server.address().port+'/hotpoor/director/authorize');await wait("document.querySelector('#create-key select')!==null");
 assert.equal(await js("document.querySelector('#create-key').checkValidity()"),false);
 await js("var f=document.querySelector('#create-key');f.elements.name.value='我的工作电脑';f.elements.duration.value='never';f.querySelector('button').click();");await wait("document.querySelectorAll('#keys article').length===1");assert.equal(requests[0].data.expires_at,null);
 await js("var f=document.querySelector('#create-key');f.elements.name.value='临时协作';f.elements.duration.value='custom';f.elements.duration.dispatchEvent(new Event('change'));f.elements.expiration_date.value='2030-12-15';f.querySelector('button').click();");await wait("document.querySelectorAll('#keys article').length===2");assert.equal(requests[1].data.expires_at,await js("new Date('2030-12-15T23:59:59.999').getTime()"));
 assert.equal(await js("getComputedStyle(document.querySelector('#keys article form')).display"),'none');
 await js("document.querySelector('#keys article button').click();var f=document.querySelector('#keys article form');f.elements.duration.value='30';f.querySelector('button').click();");await wait("document.querySelector('#notice').textContent==='有效期已更新。'");assert.ok(requests[2].data.expires_at>Date.now()+29*86400000);
 await js("var f=document.querySelector('#approve');f.elements.code.value='ABCDEF12';f.elements.duration.value='never';f.querySelector('button').click();");await wait("document.querySelector('#notice').textContent==='已保存'");assert.equal(requests[3].data.expires_at,null);
 fs.writeFileSync(path.join(directory,'key-expiration.png'),(await win.webContents.capturePage()).toPNG());console.log('Key UI passed: explicit choice, calendar, multiple keys, edit expiration, device approval. Screenshot: '+path.join(directory,'key-expiration.png'));win.destroy();
 }catch(e){console.error(e);process.exitCode=1;}finally{server?.close();app.exit(process.exitCode||0);}});
