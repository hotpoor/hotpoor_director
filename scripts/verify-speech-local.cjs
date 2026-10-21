// Isolated UI + real local DB + simulated cloud responses. No real key or paid API calls.
const {app,BrowserWindow,nativeImage}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const directory=fs.mkdtempSync(path.join(root,'.test-data','speech-ui-'));
app.setPath('userData',path.join(directory,'profile'));
let backend,remoteImages,failed=false;
app.whenReady().then(async()=>{
  backend=spawn(path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
    ['tests/inference_backend.py','serve','--port','0','--desktop','--dev'],{cwd:root,stdio:['pipe','pipe','pipe'],
      env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'real-speech-ui-bootstrap'}});
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
    await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'real-speech-ui-bootstrap',httpOnly:true,path:'/',sameSite:'strict'});
    win.webContents.session.webRequest.onBeforeRequest({urls:['https://cdn.example.com/*']},(details,callback)=>callback({redirectURL:remoteImageURL}));
    await win.loadURL(origin);
    const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw Error(error.message+' in '+code.slice(0,240));}};
    const wait=async code=>{for(let n=0;n<1500;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+code);};
    await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
    await js(`window.smokeApi=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};void 0;`);
    await js(`(async()=>{await smokeApi('/api/setup',{login:'cloud-ui',password:'cloud-ui-password-123'});await smokeApi('/api/login',{login:'cloud-ui',password:'cloud-ui-password-123'});await window.directorStudio.enter(await smokeApi('/api/me'));})()`);
    await js(`(async()=>{const p=await smokeApi('/api/projects',{title:'配音测试',subtitle:'',description:'',covers:[],canvas:{viewport:{x:40,y:40,zoom:1},cards:[]}});await directorStudio.openProject(p.block_id);})()`);
    await js(`(async()=>{const b=new Uint8Array(4844),v=new DataView(b.buffer);for(const [offset,text] of [[0,'RIFF'],[8,'WAVEfmt '],[36,'data']])for(let i=0;i<text.length;i++)b[offset+i]=text.charCodeAt(i);v.setUint32(4,b.length-8,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,24000,true);v.setUint32(28,48000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,4800,true);const f=new FormData();f.append('file',new File([b],'配音测试.wav',{type:'audio/wav'}));const r=await fetch('/api/assets',{method:'POST',headers:{'X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:f});window.fixtureAsset=await r.json();})()`);
    const python=process.env.QWEN_TTS_PYTHON,model=process.env.QWEN_TTS_MODEL;
    if(!python||!model)throw Error('Set QWEN_TTS_PYTHON and QWEN_TTS_MODEL to existing local runtime');
    await js(`smokeApi('/api/settings/speech',${JSON.stringify({python,model_path:model,device:process.env.QWEN_TTS_DEVICE||'cpu'})})`);
    const started=Date.now();
    const job=await js("smokeApi('/api/projects/'+directorStudio.currentProject().block_id+'/speech',{text:'你好，欢迎来到导演工作站。',language:'Chinese',speaker:'aiden'})");
    let result;
    for(let i=0;i<1200;i++){const data=await js("smokeApi('/api/projects/'+directorStudio.currentProject().block_id+'/speech')");result=data.jobs.find(item=>item.block_id===job.id);if(['succeeded','failed','cancelled'].includes(result?.body.status))break;await new Promise(resolve=>setTimeout(resolve,500));}
    if(result?.body.status!=='succeeded')throw Error('Real local synthesis failed: '+JSON.stringify(result));
    await js(`directorStudio.addSpeechAsset(${JSON.stringify(result.body.asset)},directorStudio.currentProject().block_id)`);
    console.log(JSON.stringify({generated:true,model:result.body.model_id,device:result.body.device,duration_ms:result.body.asset.duration_ms,elapsed_ms:Date.now()-started,asset_file:path.join(directory,'media',result.body.asset.id+'.wav')}));
    await js("document.querySelector('#open-speech').click()");await wait("document.querySelector('#speech-dialog audio')");
    await js("document.querySelector('#speech-dialog audio').muted=true;document.querySelector('#speech-dialog audio').play()");await wait("document.querySelector('#speech-dialog audio').ended");
    console.log(JSON.stringify({real_local_synthesis:true,model:result.body.model_id,device:result.body.device,duration_ms:result.body.asset.duration_ms,elapsed_ms:Date.now()-started,asset_file:path.join(directory,'media',result.body.asset.id+'.wav')}));
    const out=path.join(root,'.test-data','speech-ui-preview');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'desktop.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(520,900);await new Promise(r=>setTimeout(r,250));if(await js("document.querySelector('#speech-dialog').scrollWidth > document.querySelector('#speech-dialog').clientWidth+1"))throw Error('Speech dialog overflow');fs.writeFileSync(path.join(out,'narrow.png'),(await win.webContents.capturePage()).toPNG());
    console.log('PASS: real local Qwen3-TTS queue, WAV asset, canvas insertion and playback reached end. No cloud synthesis.');
    win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{backend?.kill('SIGTERM');remoteImages?.close();app.exit(failed?1:0);}
});
