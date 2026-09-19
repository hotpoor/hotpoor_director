// Isolated UI + real local DB + simulated cloud responses. No real key or paid API calls.
const {app,BrowserWindow,nativeImage}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const directory=fs.mkdtempSync(path.join(root,'.test-data','inference-ui-'));
app.setPath('userData',path.join(directory,'profile'));
let backend,remoteImages,failed=false;
app.whenReady().then(async()=>{
  backend=spawn(path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
    ['tests/inference_backend.py','serve','--port','0','--desktop','--dev'],{cwd:root,stdio:['pipe','pipe','pipe'],
      env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'inference-ui-bootstrap'}});
  backend.stderr.on('data',data=>process.stderr.write(data));
  try{
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Backend timeout')),60000);
      readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(timer);resolve(v.port);}}catch{}});
      backend.once('exit',()=>{clearTimeout(timer);reject(Error('Backend exited'));});
    });
    const origin=`http://127.0.0.1:${port}`;
    remoteImages=require('node:http').createServer((req,res)=>{res.writeHead(200,{'Content-Type':'image/png'});res.end(fs.readFileSync(path.join(root,'assets/icon.png')));});
    await new Promise(resolve=>remoteImages.listen(0,'127.0.0.1',resolve));
    const remoteImageURL='http://127.0.0.1:'+remoteImages.address().port+'/image.png';
    const win=new BrowserWindow({width:1180,height:820,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)console.error('Renderer:',message);});
    await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'inference-ui-bootstrap',httpOnly:true,path:'/',sameSite:'strict'});
    win.webContents.session.webRequest.onBeforeRequest({urls:['https://cdn.example.com/*']},(details,callback)=>callback({redirectURL:remoteImageURL}));
    await win.loadURL(origin);
    const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw Error(error.message+' in '+code.slice(0,240));}};
    const wait=async code=>{for(let n=0;n<300;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+code);};
    await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
    await js(`window.smokeApi=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};void 0;`);
    await js(`(async()=>{await smokeApi('/api/setup',{login:'cloud-ui',password:'cloud-ui-password-123'});await smokeApi('/api/login',{login:'cloud-ui',password:'cloud-ui-password-123'});await window.directorStudio.enter(await smokeApi('/api/me'));})()`);

    await js(`(async()=>{
      const first=await smokeApi('/api/settings/service-inference',{action:'save',id:'',name:'视频 AK A',api_key:'fake-ui-key-not-a-real-credential'});window.firstKey=first.active_key_id;
      const second=await smokeApi('/api/settings/service-inference',{action:'save',id:'',name:'视频 AK B',api_key:'second-ui-key-not-real'});window.secondKey=second.active_key_id;
      const withoutDefault=await smokeApi('/api/settings/service-inference',{action:'delete',id:secondKey});
      if(withoutDefault.active_key_id!==null||!withoutDefault.enabled_key_ids.includes(firstKey))throw Error('Missing-default fixture failed');
      await directorStudio.refreshModels();
      document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='新视频卡 AK 验证';document.querySelector('#project-form').requestSubmit();
    })()`);
    await wait("!document.querySelector('#editor').hidden");
    await js("document.querySelector('#add-image').click();document.querySelector('#fit-cards').click()");
    await js("document.querySelector('[data-credential]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js(`(()=>{const model=document.querySelector('[data-field=model]');model.value='si:gpt-image-2.5-flare';model.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("!!document.querySelector('[data-field=quality]')");
    if(await js("!!document.querySelector('[data-field=watermark]')"))throw Error('Seedream parameter leaked');
    if(!await js("[...document.querySelector('[data-field=quality]').options].some(o=>o.value==='max')"))throw Error('Flare max quality missing');
    await js(`(()=>{for(const [field,value] of Object.entries({quality:'max',background:'transparent',output_format:'webp',n:'2',prompt:'A test image'})){const el=document.querySelector('[data-field='+field+']');el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await js("directorStudio.save()");
    const project=await js("directorStudio.currentProject()");
    const card=project.body.canvas.cards[0],d=card.drafts[card.mode];
    if(d.quality!=='max'||d.background!=='transparent'||d.output_format!=='webp'||d.n!==2)throw Error('GPT parameters not stored');
    await js(`directorStudio.openProject('${project.block_id}')`);
    await wait("document.querySelector('[data-field=quality]')?.value==='max'");
    if(await js("document.querySelector('[data-field=model]').value")!=='si:gpt-image-2.5-flare')throw Error('Model not restored');
    await js("document.querySelector('[data-credential]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js(`(()=>{const model=document.querySelector('[data-field=model]');model.value='si:gpt-image-1';model.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    if(await js("document.querySelector('[data-field=quality]').value")!=='auto')throw Error('Incompatible quality not reset');
    console.log('GPT image UI passed: AK selection, Flare max quality, formats/background/count, save/reopen, switching capabilities. No paid API calls.');
    await js('directorStudio.save()');win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{
    if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}
    if(remoteImages)remoteImages.close();
    app.exit(failed?1:0);
  }
});
