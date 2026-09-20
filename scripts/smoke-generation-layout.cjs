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
    const checkLayout=async(wide)=>{
      const result=await js(`(()=>{const card=document.querySelector('[data-card]'),left=card.querySelector('.generation-preview').getBoundingClientRect(),right=card.querySelector('.generation-editor').getBoundingClientRect(),button=card.querySelector('.generate').getBoundingClientRect(),summary=card.querySelector('.generation-size-summary').getBoundingClientRect(),canvas=document.querySelector('#canvas').getBoundingClientRect(),footer=card.querySelector('.generation-submit').getBoundingClientRect();return {side:right.left>=left.right-1,stack:right.top>=left.bottom-1,buttonVisible:button.top>=canvas.top&&button.bottom<=canvas.bottom&&button.left>=canvas.left&&button.right<=canvas.right,summaryVisible:summary.top>=canvas.top&&summary.bottom<=canvas.bottom,buttonInFooter:button.top>=footer.top&&button.bottom<=footer.bottom,editorOverflow:card.querySelector('.generation-editor').scrollWidth>card.querySelector('.generation-editor').clientWidth+1,portVisible:card.querySelector('[data-port=input]').getBoundingClientRect().left<card.getBoundingClientRect().left}})()`);
      if(!(wide?result.side:result.stack)||!result.buttonVisible||!result.summaryVisible||!result.buttonInFooter||result.editorOverflow||!result.portVisible)throw Error('Bad layout: '+JSON.stringify(result));
    };
    await checkLayout(true);
    await js("document.querySelector('[data-credential]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js("(()=>{const input=document.querySelector('[data-field=duration]');input.value='7';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.generation-editor').scrollTop=100000;document.querySelector('.generation-preview').scrollTop=100000;})()");
    if(!await js("document.querySelector('.generation-size-summary').textContent.includes('7 秒')"))throw Error('Pinned dimensions did not update');
    await checkLayout(true);
    await js("document.querySelector('[data-edit-dimensions]').click()");
    if(!await js("!!document.activeElement.closest('.parameter-grid')"))throw Error('Size shortcut failed');
    await js("document.querySelector('.generation-editor').scrollTop=0;document.querySelector('.generation-preview').scrollTop=0");
    await new Promise(r=>setTimeout(r,250));
    fs.writeFileSync(path.join(directory,'video-wide.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('[data-card-layout]').click();document.querySelector('#fit-cards').click()");
    await checkLayout(false);
    const narrowProject=await js('directorStudio.currentProject()');if(narrowProject.body.canvas.cards[0].w!==480)throw Error('Compact width did not persist in draft');
    await js('directorStudio.save()');await js(`directorStudio.openProject('${project.block_id}')`);await checkLayout(false);
    await js("document.querySelector('[data-credential]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js("document.querySelector('[data-card-layout]').click();document.querySelector('#fit-cards').click()");await checkLayout(true);
    // Exercise a minimum-sized card through the saved project, not CSS-only mocks.
    await js("(()=>{const c=directorStudio.currentProject().body.canvas.cards[0];c.w=380;c.h=520;directorStudio.changed();})()");await js('directorStudio.save()');await js(`directorStudio.openProject('${project.block_id}')`);await js("document.querySelector('#fit-cards').click()");await checkLayout(false);
    await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(directory,'video-narrow.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#add-image').click()");
    const imageId=await js("directorStudio.currentProject().body.canvas.cards.at(-1).id");
    await js(`(()=>{const c=document.querySelector('[data-card="${imageId}"]');c.querySelector('[data-field=prompt]').focus();return directorEditing.claim('card:${imageId}');})()`);
    await js(`(()=>{const c=document.querySelector('[data-card="${imageId}"]');for(const [key,value] of Object.entries({width:768,height:512})){const input=c.querySelector('[data-field='+key+']');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}if(!c.querySelector('.generation-size-summary').textContent.includes('768 × 512'))throw Error('Image dimensions not updated');})()`);
    await js('directorStudio.save()');
    console.log('Generation layout passed: default split, fixed dimensions/generate after both panes scroll, parameter shortcut, compact switch+save/reopen, minimum 380px card, local image summary.');
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
