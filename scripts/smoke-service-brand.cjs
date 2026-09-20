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
    await js("document.querySelector('#add-video').click();document.querySelector('#fit-cards').click()");
    if(!await js("document.querySelector('[data-card] [data-credential]')?.value===firstKey"))throw Error('New card has no usable AK selector with null default');
    if(!await js("[...document.querySelector('[data-card] [data-field=model]').options].some(o=>o.value.startsWith('si:')&&!o.disabled)"))throw Error('No selectable video model');
    await js("document.querySelector('[data-credential]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js(`(()=>{const model=document.querySelector('[data-field=model]');model.value='si:dreamina-seedance-2-0-260128-max';model.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("!!document.querySelector('[data-field=resolution]')");
    await js(`(async()=>{const second=await smokeApi('/api/settings/service-inference',{action:'save',id:'',name:'视频 AK B',api_key:'second-ui-key-not-real'});window.secondKey=second.active_key_id;await directorStudio.refreshModels();})()`);
    await js("document.querySelector('[data-credential]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js("(()=>{const ak=document.querySelector('[data-credential]');ak.value=secondKey;ak.dispatchEvent(new Event('change',{bubbles:true}));})()");
    if(!await js("document.querySelector('[data-credential]').value===secondKey"))throw Error('AK change was lost');
    await js("directorStudio.save()");
    const project=await js("directorStudio.currentProject()");
    if(project.body.canvas.cards[0].credential_id!==await js('secondKey')||project.body.canvas.cards[0].model!=='si:dreamina-seedance-2-0-260128-max')throw Error('Selection not stored');
    await js(`directorStudio.openProject('${project.block_id}')`);
    await wait("document.querySelector('[data-credential]')?.value===secondKey");
    if(await js("document.querySelector('[data-field=model]').value")!=='si:dreamina-seedance-2-0-260128-max')throw Error('Model not restored');
    await js("document.querySelector('#back-dashboard').click()");await wait("!document.querySelector('#dashboard').hidden");
    await js("document.querySelector('#open-inference-settings').click()");
    await wait("document.querySelector('#management-status').textContent.includes('请添加管理 AK')");
    if(!await js("document.querySelector('#management-ak-tab').getAttribute('aria-selected')==='true' && document.querySelector('#inference-form').hidden && !document.querySelector('#management-settings').hidden"))throw Error('Management tab not first/default');
    await wait("document.querySelector('.inference-brand img').naturalWidth>0");
    let externalURL='';win.webContents.setWindowOpenHandler(({url})=>{externalURL=url;return {action:'deny'}});
    await js("document.querySelector('.inference-brand').click()");await new Promise(r=>setTimeout(r,200));
    if(externalURL!=='https://console.service-inference.ai/')throw Error('Incorrect console destination');
    await js("document.querySelector('#management-form').elements.name.value='测试管理 AK';document.querySelector('#management-form').elements.api_key.value='sk-mgmt-v1-ui-main-management-key';document.querySelector('#management-form').requestSubmit()");
    await wait("document.querySelector('#management-status').textContent.includes('管理配置已保存')");
    await js("document.querySelector('#application-ak-tab').click();document.querySelector('[data-edit-key=\"'+secondKey+'\"]').click()");
    const managementId=await js("document.querySelector('#inference-form').elements.management_key_id.options[1].value");
    await js(`(()=>{const f=document.querySelector('#inference-form');f.elements.name.value='测试应用 AK';f.elements.api_key.value='second-ui-key-not-real';f.elements.management_key_id.value='${managementId}';})()`);
    await js("document.querySelector('#management-ak-tab').click();document.querySelector('#application-ak-tab').click()");
    if(!await js("document.querySelector('#inference-form').elements.api_key.value==='second-ui-key-not-real' && document.querySelector('#inference-form').elements.api_key.type==='password'"))throw Error('Tab switch lost unsaved key or exposed it');
    await js("document.querySelector('#inference-form').requestSubmit()");await wait("document.querySelector('#inference-status').textContent.includes('已保存')");
    if(!await js("document.querySelector('#inference-key-list').textContent.includes('测试应用 AK')"))throw Error('Application form no longer saves: '+await js("document.querySelector('#inference-status').textContent"));
    await js("document.querySelector('#query-bound-management').click()");
    await wait("!document.querySelector('#management-settings').hidden && document.querySelector('#management-report').textContent.includes('USD')");
    await js("document.querySelector('#management-ak-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    if(!await js("document.querySelector('#application-ak-tab').getAttribute('aria-selected')==='true' && !document.querySelector('#inference-form').hidden"))throw Error('Tab keyboard navigation failed');
    await js("document.querySelector('#new-inference-key').click();document.querySelector('#inference-form').elements.api_key.value='unsaved-local-fixture';document.querySelector('#close-inference-settings').click()");
    await wait("document.querySelector('#inference-form').elements.api_key.value===''");
    await js("document.querySelector('#open-inference-settings').click();document.querySelector('#management-ak-tab').click()");await wait("document.querySelector('#management-status').textContent.includes('已配置独立管理 AK')");
    fs.writeFileSync(path.join(directory,'service-management.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#application-ak-tab').click()");await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(directory,'service-application.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#close-inference-settings').click()");
    console.log('Service settings passed: bundled logo, console link, management-first tabs, keyboard switching, unsaved fields preserved, management and application saves/binding, bound report tab, clear key on close.');
    fs.writeFileSync(path.join(directory,'new-video-card.png'),(await win.webContents.capturePage()).toPNG());
    console.log('Video card UI passed: missing default AK, cloud model selection, AK switching, save and reopen; real editing leases; no generation. Artifacts:',directory);
    await js('directorStudio.save()');win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{
    if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}
    if(remoteImages)remoteImages.close();
    app.exit(failed?1:0);
  }
});
