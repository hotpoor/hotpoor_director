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


    await js(`(()=>{document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='框选引入验证';document.querySelector('#project-form').requestSubmit();})()`);
    await wait("!document.querySelector('#editor').hidden");
    await js("document.querySelector('#add-image').click();document.querySelector('#add-image').click();document.querySelector('#add-video').click()");
    await js(`(()=>{const p=directorStudio.currentProject();p.body.canvas.cards.forEach((c,i)=>Object.assign(c,{x:i*500,y:0,w:400,h:520}));Object.assign(p.body.canvas.viewport,{x:20,y:20,zoom:.5});directorStudio.changed();})()`);
    await js('directorStudio.save()');
    const project=await js('directorStudio.currentProject()');
    await js(`directorStudio.openProject('${project.block_id}')`);
    const canvasOrigin=await js("(()=>{const r=document.querySelector('#canvas').getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top)};})()");
    const boxGesture=async()=>{
      await js("document.querySelector('#box-import').click()");
      win.webContents.sendInputEvent({type:'mouseDown',x:canvasOrigin.x+10,y:canvasOrigin.y+10,button:'left',clickCount:1});
      win.webContents.sendInputEvent({type:'mouseMove',x:canvasOrigin.x+470,y:canvasOrigin.y+290});
      win.webContents.sendInputEvent({type:'mouseUp',x:canvasOrigin.x+470,y:canvasOrigin.y+290,button:'left',clickCount:1});
      await wait("document.querySelectorAll('.box-import-selected').length===2 && document.querySelector('.canvas-selection-box').hidden");
    };
    await boxGesture();
    if(await js("document.querySelectorAll('.box-import-selected').length")!==2)throw Error('Zoomed selection should select exactly two sources');
    fs.writeFileSync(path.join(directory,'box-selected.png'),(await win.webContents.capturePage()).toPNG());
    const target=project.body.canvas.cards[2].id;
    await js(`directorEditing.claim('card:${target}')`);
    await js(`document.querySelector('[data-card="${target}"]').click()`);
    if(await js('directorStudio.currentProject().body.canvas.connections.length')!==2)throw Error('Batch connections missing');
    await js('directorStudio.save()');await js(`directorStudio.openProject('${project.block_id}')`);
    if(await js('directorStudio.currentProject().body.canvas.connections.length')!==2)throw Error('Connections were not persisted');
    await boxGesture();await js(`directorEditing.claim('card:${target}')`);await js(`document.querySelector('[data-card="${target}"]').click()`);
    if(await js('directorStudio.currentProject().body.canvas.connections.length')!==2)throw Error('Duplicate connections created');
    await js("document.querySelector('#canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    if(await js("document.querySelector('#box-import').getAttribute('aria-pressed')")!=='false')throw Error('Escape did not cancel');
    await js("document.querySelector('#canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true}))");
    if(await js("document.querySelector('#box-import').getAttribute('aria-pressed')")!=='true')throw Error('B shortcut did not start');
    await js("document.querySelector('#box-import').click()");
    await js(`(()=>{const input=document.querySelector('[data-field=prompt]');input.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true}));})()`);
    if(await js("document.querySelector('#box-import').getAttribute('aria-pressed')")!=='false')throw Error('Typing activated selection');
    await js(`(()=>{directorStudio.currentProject().permission={role:'viewer'};document.querySelector('#box-import').click();})()`);
    if(await js("document.querySelector('#box-import').getAttribute('aria-pressed')")!=='false')throw Error('Viewer activated selection');
    console.log('Box import passed: zoomed multi-selection, real leases, batch connections, save/reopen, duplicates, B, Escape, text input and viewer guard. Artifacts:',directory);
    win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{
    if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}
    if(remoteImages)remoteImages.close();
    app.exit(failed?1:0);
  }
});
