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
    await js("document.querySelector('[data-credential]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js("document.querySelector('[data-mode=reference]').click()");
    await wait("!!document.querySelector('[data-field=video_urls]')");
    await js(`(()=>{for(const [key,value] of Object.entries({image_urls:'https://cdn.example.com/one.png\\nhttps://cdn.example.com/two.png',video_urls:'https://cdn.example.com/video.mp4',audio_urls:'https://cdn.example.com/audio.mp3',prompt:'让主角走向镜头'})){const input=document.querySelector('[data-field='+key+']');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    if(!await js("[...document.querySelectorAll('.reference-mention')].map(e=>e.dataset.refMention).join(',')==='@Image1,@Image2,@Video1,@Audio1'"))throw Error('Reference numbering is incorrect');
    await js(`(()=>{const input=document.querySelector('[data-field=prompt]');input.focus();input.setSelectionRange(1,3);input.dispatchEvent(new Event('select'));const button=document.querySelector('[data-ref-mention="@Image2"]');button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));button.click();})()`);
    if(await js("document.querySelector('[data-field=prompt]').value")!=='让@Image2走向镜头')throw Error('Mention did not replace the selected text');
    if(!await js("document.activeElement===document.querySelector('[data-field=prompt]')"))throw Error('Prompt focus was lost');
    await js("document.querySelector('[data-ref-mention=\"@Video1\"]').click()");
    if(await js("document.querySelector('[data-field=prompt]').value")!=='让@Image2@Video1走向镜头')throw Error('Mention did not insert at restored caret');
    await js('directorStudio.save()');
    await js(`directorStudio.openProject('${project.block_id}')`);
    await wait("document.querySelector('[data-field=prompt]')?.value==='让@Image2@Video1走向镜头'");
    await js("document.querySelector('[data-field=prompt]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js(`(()=>{const input=document.querySelector('[data-field=prompt]');input.value=Array.from({length:100},(_,i)=>'第 '+i+' 行提示词内容').join('\\n');input.dispatchEvent(new Event('input',{bubbles:true}));input.scrollIntoView({block:'center'});input.scrollTop=0;})()`);
    await new Promise(r=>setTimeout(r,300));
    const scrollPoint=await js("(()=>{const r=document.querySelector('[data-field=prompt]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    const before=await js("JSON.stringify(directorStudio.currentProject().body.canvas.viewport)");
    const cardTop=await js("document.querySelector('.generation-editor').scrollTop");
    win.webContents.sendInputEvent({type:'mouseMove',...scrollPoint});
    await new Promise(r=>setTimeout(r,250));
    win.webContents.sendInputEvent({type:'mouseWheel',...scrollPoint,deltaY:-90,deltaX:0,canScroll:true});
    await wait("document.querySelector('[data-field=prompt]').scrollTop>0");
    if(await js("JSON.stringify(directorStudio.currentProject().body.canvas.viewport)")!==before)throw Error('Textarea wheel moved canvas');
    if(await js("document.querySelector('.generation-editor').scrollTop")!==cardTop)throw Error('Textarea wheel moved parent card');
    await js("document.querySelector('[data-field=prompt]').scrollTop=100000");
    win.webContents.sendInputEvent({type:'mouseWheel',...scrollPoint,deltaY:-200,deltaX:0,canScroll:true});
    await new Promise(r=>setTimeout(r,250));
    if(await js("JSON.stringify(directorStudio.currentProject().body.canvas.viewport)")!==before||await js("document.querySelector('.generation-editor').scrollTop")!==cardTop)throw Error('Textarea boundary chained scroll');
    await js("document.querySelector('[data-field=prompt]').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,ctrlKey:true,bubbles:true,cancelable:true}))");
    if(await js("JSON.stringify(directorStudio.currentProject().body.canvas.viewport)")!==before)throw Error('Textarea pinch changed canvas');
    // The card padding is a usable outer scrolling lane, independent of its textarea.
    const marginPoint=await js("(()=>{const r=document.querySelector('.card-content').getBoundingClientRect();return {x:Math.round(r.left+8),y:Math.round(r.top+r.height/2)}})()");
    if(await js(`document.elementFromPoint(${marginPoint.x},${marginPoint.y}).classList.contains('card-content')`)!==true)throw Error('Outer card scrolling lane is covered: '+await js(`document.elementFromPoint(${marginPoint.x},${marginPoint.y})?.outerHTML.slice(0,200)`));
    const outerBefore=await js("document.querySelector('.card-content').scrollTop");
    win.webContents.sendInputEvent({type:'mouseMove',...marginPoint});
    await new Promise(r=>setTimeout(r,250));
    win.webContents.sendInputEvent({type:'mouseWheel',...marginPoint,deltaY:-100,deltaX:0,canScroll:true});
    await wait(`document.querySelector('.card-content').scrollTop>${outerBefore}`);
    if(await js("JSON.stringify(directorStudio.currentProject().body.canvas.viewport)")!==before)throw Error('Outer card scroll moved canvas');
    // Long details and many imported materials exercise the production scroll containers.
    await js(`(()=>{const details=document.querySelector('.history-details');details.innerHTML='<summary>生成信息</summary><dl>'+Array.from({length:40},(_,i)=>'<dt>参数 '+i+'</dt><dd>用于滚动验证的生成信息内容</dd>').join('')+'</dl>';details.open=true;details.scrollIntoView({block:'center'});details.scrollTop=0;})()`);
    await new Promise(r=>setTimeout(r,300));
    const detailPoint=await js("(()=>{const r=document.querySelector('.history-details').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    const detailsParent=await js("document.querySelector('.card-content').scrollTop");
    win.webContents.sendInputEvent({type:'mouseMove',...detailPoint});
    await new Promise(r=>setTimeout(r,250));
    win.webContents.sendInputEvent({type:'mouseWheel',...detailPoint,deltaY:-90,deltaX:0,canScroll:true});
    await wait("document.querySelector('.history-details').scrollTop>0");
    if(await js("document.querySelector('.card-content').scrollTop")!==detailsParent)throw Error('Details scrolled parent card');
    await js("document.querySelector('.history-details').scrollTop=100000");
    win.webContents.sendInputEvent({type:'mouseWheel',...detailPoint,deltaY:-200,deltaX:0,canScroll:true});
    await new Promise(r=>setTimeout(r,200));
    if(await js("document.querySelector('.card-content').scrollTop")!==detailsParent)throw Error('Details boundary chained to card');
    await js(`(()=>{document.querySelector('.history-details').open=false;const library=document.querySelector('.imported-library');library.innerHTML='<summary>引入素材库 · 滚动验证</summary><div class="imported-items">'+Array.from({length:12},(_,i)=>'<div class="imported-item"><img src="https://cdn.example.com/one.png"><small>素材 '+(i+1)+'</small><button class="quiet">用作参考素材</button></div>').join('')+'</div>';library.open=true;document.querySelector('.imported-items').scrollIntoView({block:'center'});})()`);
    await new Promise(r=>setTimeout(r,300));
    const materialPoint=await js("(()=>{const r=document.querySelector('.imported-items').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    if(!await js(`!!document.elementFromPoint(${materialPoint.x},${materialPoint.y})?.closest('.imported-items')`))throw Error('Material wheel target is obscured');
    const materialParent=await js("document.querySelector('.card-content').scrollTop");
    win.webContents.sendInputEvent({type:'mouseMove',...materialPoint});
    await new Promise(r=>setTimeout(r,250));
    win.webContents.sendInputEvent({type:'mouseWheel',...materialPoint,deltaX:-140,deltaY:0,canScroll:true});
    await wait("document.querySelector('.imported-items').scrollLeft>0");
    if(await js("document.querySelector('.card-content').scrollTop")!==materialParent||await js("JSON.stringify(directorStudio.currentProject().body.canvas.viewport)")!==before)throw Error('Horizontal materials scroll moved parent/canvas');
    const materialLeft=await js("document.querySelector('.imported-items').scrollLeft");
    win.webContents.sendInputEvent({type:'mouseWheel',...materialPoint,deltaX:90,deltaY:0,canScroll:true});
    await wait(`document.querySelector('.imported-items').scrollLeft<${materialLeft}`);
    await js("document.querySelector('.imported-items').scrollLeft=100000");
    win.webContents.sendInputEvent({type:'mouseWheel',...materialPoint,deltaX:-140,deltaY:0,canScroll:true});
    await new Promise(r=>setTimeout(r,200));
    if(await js("JSON.stringify(directorStudio.currentProject().body.canvas.viewport)")!==before)throw Error('Horizontal boundary panned canvas');
    console.log('Nested scrolling passed: outer padding lane, expanded details, details boundary, horizontal materials both directions and boundary, stationary canvas.');
    console.log('Reference mentions + native textarea wheel passed: typed URLs, per-type numbering, selected replacement, caret, save/reopen, text scrolling, boundary containment, pinch isolation.');
    await js("document.querySelector('[data-field=prompt]').scrollTop=0");
    fs.writeFileSync(path.join(directory,'reference-mentions.png'),(await win.webContents.capturePage()).toPNG());
    console.log('Video card UI passed: missing default AK, cloud model selection, AK switching, save and reopen; real editing leases; no generation. Artifacts:',directory);
    await js('directorStudio.save()');win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{
    if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}
    if(remoteImages)remoteImages.close();
    app.exit(failed?1:0);
  }
});
