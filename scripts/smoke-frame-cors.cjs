// Real cross-origin video decoding, extraction and PNG pixel checks; isolated local DB.
// Run with: node_modules/.bin/electron scripts/smoke-frame-cors.cjs
// Requires ffmpeg, or DIRECTOR_FRAME_FIXTURE pointing to the two-color fixture.
const {app,BrowserWindow}=require('electron');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const directory=fs.mkdtempSync(path.join(root,'.test-data','frame-cors-ui-'));
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
    const fixture=process.env.DIRECTOR_FRAME_FIXTURE||path.join(directory,'two-colors.mp4');
    if(!process.env.DIRECTOR_FRAME_FIXTURE)execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=160x96:r=10:d=1','-f','lavfi','-i','color=c=blue:s=160x96:r=10:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',fixture]);
    const videoBytes=fs.readFileSync(fixture);const requests=[];
    remoteImages=require('node:http').createServer((req,res)=>{
      const cors=!req.url.startsWith('/blocked');requests.push({origin:req.headers.origin||'',cookie:!!req.headers.cookie,cors});
      let start=0,end=videoBytes.length-1;const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
      if(range){start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}
      const headers={'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes'};
      if(cors)headers['Access-Control-Allow-Origin']='*';if(range)headers['Content-Range']='bytes '+start+'-'+end+'/'+videoBytes.length;
      res.writeHead(range?206:200,headers);res.end(videoBytes.subarray(start,end+1));
    });
    await new Promise(resolve=>remoteImages.listen(0,'127.0.0.1',resolve));
    const remoteImageURL='http://127.0.0.1:'+remoteImages.address().port+'/image.png';
    const win=new BrowserWindow({width:1180,height:820,show:true,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)console.error('Renderer:',message);});
    await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'inference-ui-bootstrap',httpOnly:true,path:'/',sameSite:'strict'});
    win.webContents.session.webRequest.onBeforeRequest({urls:['https://cdn.example.com/*']},(details,callback)=>callback({redirectURL:remoteImageURL}));
    await win.loadURL(origin);
    const js=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw Error(error.message+' in '+code.slice(0,240));}};
    const wait=async code=>{for(let n=0;n<300;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+code+'; UI: '+await js("JSON.stringify({message:document.querySelector('#studio-message').textContent,cards:directorStudio.currentProject().body.canvas.cards.length})"));};
    await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
    await js(`window.smokeApi=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};void 0;`);
    await js(`(async()=>{await smokeApi('/api/setup',{login:'cloud-ui',password:'cloud-ui-password-123'});await smokeApi('/api/login',{login:'cloud-ui',password:'cloud-ui-password-123'});await window.directorStudio.enter(await smokeApi('/api/me'));})()`);
    await js(`(async()=>{const p=await smokeApi('/api/projects',{title:'跨域提帧测试',subtitle:'',description:'',covers:[],canvas:{viewport:{x:40,y:40,zoom:1},cards:[]}});await directorStudio.openProject(p.block_id);})()`);
    const videoURL='http://localhost:'+remoteImages.address().port+'/video.mp4';
    const b64=videoBytes.toString('base64');
    await js(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));const f=new FormData();f.append('file',new File([bytes],'two-colors.mp4',{type:'video/mp4'}));const r=await fetch('/api/assets',{method:'POST',headers:{'X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:f});const asset=await r.json();await directorStudio.addSpeechAsset(asset,directorStudio.currentProject().block_id);})()`);
    const card=await js("directorStudio.currentProject().body.canvas.cards.find(c=>c.mime==='video/mp4').id");
    // Reproduce the reported failure even though this origin has valid CORS headers.
    const tainted=await js(`new Promise((resolve,reject)=>{const v=document.createElement('video');v.muted=true;v.onloadeddata=()=>{v.currentTime=0.5;};v.onseeked=()=>{const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);try{const data=c.toDataURL();resolve({tainted:false,width:v.videoWidth,src:v.currentSrc,origin:location.origin,data_length:data.length,crossOrigin:v.crossOrigin});}catch(e){resolve({tainted:e.name==='SecurityError',name:e.name,message:e.message});}finally{v.removeAttribute('src');v.load();}};v.onerror=reject;v.src=${JSON.stringify(videoURL)};v.load();})`);
    console.log('Baseline canvas check',JSON.stringify(tainted));if(!tainted.tainted)throw Error('Fixture did not reproduce the cross-origin canvas failure');
    const claim=async()=>{await js(`(async()=>{await directorEditing.refresh();document.querySelector('[data-card="${card}"]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));if(!await directorEditing.claim('card:${card}'))throw Error('Could not acquire edit lease');})()`);};
    for(const [mode,seconds,count,color] of [['last',0,2,'blue'],['time',0,3,'red']]){
      await claim();
      await js(`(()=>{const c=document.querySelector('[data-card="${card}"]');c.querySelector('.video-frame-tools').dataset.frameUrl=${JSON.stringify(videoURL)};c.querySelector('.frame-seconds').value=${seconds};const b=c.querySelector('[data-extract-frame=${mode}]');b.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`);
      await wait(`directorStudio.currentProject().body.canvas.cards.length===${count}`);
      const pixels=await js(`(async()=>{const card=directorStudio.currentProject().body.canvas.cards.at(-1);const image=new Image();image.src='/api/assets/'+card.asset_id;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);return {width:image.width,height:image.height,pixel:[...c.getContext('2d').getImageData(80,48,1,1).data]};})()`);
      if(pixels.width!==160||pixels.height!==96)throw Error('Wrong extracted dimensions');
      if(color==='blue'&&!(pixels.pixel[2]>200&&pixels.pixel[0]<40))throw Error('Last frame was not blue');
      if(color==='red'&&!(pixels.pixel[0]>200&&pixels.pixel[2]<40))throw Error('Zero-second frame was not red');
      await wait("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
    }
    const blockedURL='http://localhost:'+remoteImages.address().port+'/blocked.mp4';
    await claim();
    await js(`(()=>{const c=document.querySelector('[data-card="${card}"]');c.querySelector('.video-frame-tools').dataset.frameUrl=${JSON.stringify(blockedURL)};c.querySelector('[data-extract-frame=last]').click();})()`);
    await wait("document.querySelector('#studio-message').textContent.includes('跨域读取')");
    if(!await js("directorStudio.currentProject().body.canvas.cards.length===3"))throw Error('Blocked CORS created an invalid asset');
    if(!requests.some(r=>r.cors&&r.origin&&!r.cookie))throw Error('Anonymous CORS request was not observed');
    if(process.env.DIRECTOR_FRAME_LIVE_VIDEO_JSON){
      const value=JSON.parse(fs.readFileSync(process.env.DIRECTOR_FRAME_LIVE_VIDEO_JSON,'utf8'));const url=typeof value==='string'?value:value.url||value.remote_url;
      await claim();
      await js(`(()=>{const c=document.querySelector('[data-card="${card}"]');c.querySelector('.video-frame-tools').dataset.frameUrl=${JSON.stringify(url)};c.querySelector('[data-extract-frame=last]').dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`);
      await wait('directorStudio.currentProject().body.canvas.cards.length===4');
      console.log('PASS: actual cloud video last frame extracted and saved.');
    }
    const output=path.join(root,'.test-data','frame-cors-preview');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'desktop.png'),(await win.webContents.capturePage()).toPNG());
    console.log('PASS: reproduced tainted canvas; anonymous direct video reads export real last/0-second PNGs with verified pixels; missing CORS gives a clear error without an invalid asset or video proxy.');
    win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{backend?.kill('SIGTERM');remoteImages?.close();app.exit(failed?1:0);}
});
