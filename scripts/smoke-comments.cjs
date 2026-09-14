// Isolated UI + real local DB + simulated cloud responses. No real key or paid API calls.
const {app,BrowserWindow,nativeImage}=require('electron');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const directory=fs.mkdtempSync(path.join(root,'.test-data','comments-ui-'));
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
    const js=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error(error.message+' in '+code.slice(0,240));}};
    const wait=async code=>{for(let n=0;n<300;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+code);};
    await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
    await js(`window.smokeApi=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};void 0;`);
    await js(`(async()=>{await smokeApi('/api/setup',{login:'cloud-ui',password:'cloud-ui-password-123'});await smokeApi('/api/login',{login:'cloud-ui',password:'cloud-ui-password-123'});await window.directorStudio.enter(await smokeApi('/api/me'));})()`);

    await js("document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='评论区验证';document.querySelector('#project-form').requestSubmit()");
    await wait("!document.querySelector('#editor').hidden");
    await js("document.querySelector('#add-chat').click()");
    await wait("document.querySelector('.chat-card') && document.querySelector('.chat-count').textContent.includes('0 条') && document.querySelector('#save-status').textContent.includes('已自动保存')");
    await js(`(async()=>{window.chatId=document.querySelector('.chat-settings code').textContent.split(': ')[1];window.chatProject=(await smokeApi('/api/projects')).projects[0].block_id;})()`);
    await js("document.querySelector('.chat-settings details').open=true;document.querySelector('.chat-batch').value=25;document.querySelector('.chat-name').value='分镜讨论';document.querySelector('.chat-save-settings').click()");
    await wait("document.querySelector('.chat-status').textContent==='设置已保存'");
    await js("document.querySelector('.chat-settings details').open=false;window.writeComment=(format,content)=>{const f=document.querySelector('.chat-format');f.value=format;f.dispatchEvent(new Event('change'));const el=document.querySelector(format==='rich'?'.chat-rich':'.chat-source');if(format==='rich')el.innerHTML=content;else el.value=content;el.dispatchEvent(new Event('input',{bubbles:true}));};writeComment('markdown','# 片头讨论\\n\\n**保留暖色调**，镜头慢慢推进。');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelector('.chat-message h1')?.textContent==='片头讨论'");
    await js("writeComment('html','<p>HTML <strong>评论</strong></p><img src=x onerror=alert(1)><script>window.chatUnsafe=1</script><form><input id=login></form>');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelectorAll('.chat-message').length===2");
    if(!await js("!window.chatUnsafe && !document.querySelector('.chat-messages script,.chat-messages [onerror],.chat-messages form,.chat-messages input')"))throw Error('Unsafe HTML survived');
    await js("writeComment('rich','<p>富文本：<em>确认机位</em>，准备拍摄。</p>');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelectorAll('.chat-message').length===3");
    await js("writeComment('text','纯文本 <b>保持原样</b>');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelectorAll('.chat-message').length===4");
    if(!await js("document.querySelectorAll('.chat-message')[3].textContent.includes('<b>保持原样</b>')"))throw Error('Plain text rendered HTML');
    const fixture=path.join(directory,'fixture.mp4');
    const made=spawnSync(path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['-c',`import av,sys
with av.open(sys.argv[1],'w') as c:
 s=c.add_stream('libx264',rate=24);s.width=64;s.height=64;s.pix_fmt='yuv420p'
 for i in range(24):
  f=av.VideoFrame(64,64,'yuv420p')
  for p in f.planes:p.update(bytes([90])*p.buffer_size)
  for p in s.encode(f):c.mux(p)
 for p in s.encode():c.mux(p)
`,fixture]);if(made.status!==0)throw Error(made.stderr.toString());
    const videoBytes=fs.readFileSync(fixture);
    await js(`(async()=>{const r=await fetch('/static/brand/logo.png'),blob=await r.blob(),input=document.querySelector('.chat-files'),dt=new DataTransfer();dt.items.add(new File([blob],'讨论图片.png',{type:'image/png'}));dt.items.add(new File([new Uint8Array(${JSON.stringify([...videoBytes])})],'讨论视频.mp4',{type:'video/mp4'}));input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
    await wait("document.querySelectorAll('.chat-attachment').length===2 && !directorComments.busy()");
    await js("document.querySelector('.chat-url').value='https://cdn.example.com/shot.png';document.querySelector('.chat-add-url').click();document.querySelector('.chat-url-type').value='video';document.querySelector('.chat-url').value='https://cdn.example.com/shot.mp4';document.querySelector('.chat-add-url').click();writeComment('text','图片和视频：文件与地址');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelectorAll('.chat-message').length===5");
    await wait("document.querySelectorAll('.chat-message')[4].querySelector('video').readyState>=1");
    if(!await js("document.querySelectorAll('.chat-message')[4].querySelectorAll('figure').length===4"))throw Error('Missing attachments');
    await js(`(async()=>{const messages=(await smokeApi('/api/chats/'+chatId+'/messages')).pack.body.messages;window.commentAsset=messages.at(-1).attachments[0];const p=await smokeApi('/api/projects/'+chatProject);p.body.canvas.cards.push({id:crypto.randomUUID().replaceAll('-',''),type:'asset',mode:'media',asset_id:commentAsset.id,x:800,y:0,w:420,h:360});await smokeApi('/api/projects/'+chatProject,p.body);})()`);
    // Reopen to load the new asset card and validate persisted chat rendering.
    await js("document.querySelector('#back-dashboard').click()");await wait("!document.querySelector('#dashboard').hidden && !!document.querySelector('[data-project]')");
    await js("document.querySelector('[data-project]').click()");await wait("!document.querySelector('#editor').hidden && document.querySelector('.chat-card') && document.querySelectorAll('.chat-message').length===5");
    await js("document.querySelector('.chat-reference').focus();document.querySelector('.chat-reference').value='0';document.querySelector('.chat-add-reference').click();writeComment('text','引用素材卡片');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelectorAll('.chat-message').length===6");
    if(!await js("document.querySelectorAll('.chat-message')[5].querySelector('img').getAttribute('src')===commentAsset.url"))throw Error('Reference copied or lost');
    await js(`(async()=>{for(let i=0;i<21;i++)await smokeApi('/api/chats/'+chatId+'/messages',{id:crypto.randomUUID().replaceAll('-',''),content:'分包边界 '+i});document.querySelector('.chat-refresh').click();})()`);
    await wait("document.querySelector('.chat-count').textContent==='27 条 · 2 包'");
    if(!await js("document.querySelectorAll('.chat-message').length===2 && !document.querySelector('.chat-older').hidden"))throw Error('Tail pagination wrong');
    await js("document.querySelector('.chat-older').click()");await wait("document.querySelectorAll('.chat-message').length===27");
    await js("writeComment('markdown','未发送的 **草稿**');document.querySelector('#add-image').click()");
    if(!await js("document.querySelector('.chat-source').value==='未发送的 **草稿**'"))throw Error('Rerender lost draft');
    await wait("document.querySelector('#save-status').textContent.includes('已自动保存')");
    await win.reload();await wait("!document.querySelector('#dashboard').hidden && !!document.querySelector('[data-project]')");
    await js("document.querySelector('[data-project]').click()");await wait("document.querySelector('.chat-source')?.value==='未发送的 **草稿**'");
    await js("document.querySelector('.chat-older').click()");await wait("document.querySelectorAll('.chat-message').length===27");
    await js("document.querySelector('.chat-messages').scrollTop=0;document.querySelector('.chat-source').value='';document.querySelector('.chat-source').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.chat-card').style.height='520px';");
    fs.writeFileSync(path.join(directory,'comments.png'),(await win.webContents.capturePage()).toPNG());
    await js(`window.writeComment=(format,content)=>{const f=document.querySelector('.chat-format');f.value=format;f.dispatchEvent(new Event('change'));const t=document.querySelector('.chat-source');t.value=content;t.dispatchEvent(new Event('input',{bubbles:true}));};window.smokeApi=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};window.chatId=document.querySelector('.chat-settings code').textContent.split(': ')[1];window.commentAsset={id:document.querySelector('.asset-card img').getAttribute('src').split('/').pop()};void 0;`);
    // Connect an asset -> chat -> generation card through the real keyboard-port UI.
    await js(`window.connectPorts=(a,b)=>{for(const el of [a,b])el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));};connectPorts(document.querySelector('.asset-card .port-output'),document.querySelector('.chat-card .port-input'));connectPorts(document.querySelector('.chat-card .port-output'),[...document.querySelectorAll('.generation-card')].find(e=>!e.classList.contains('chat-card')&&!e.classList.contains('asset-card')).querySelector('.port-input'));`);
    await wait("document.querySelectorAll('.connection-hit').length===2 && document.querySelector('.chat-imported-library [data-use-material]') && document.querySelector('.generation-card:not(.chat-card):not(.asset-card) .imported-item')");
    await js(`window.noReuploads=0;window.reviewOriginalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){if(method==='POST'&&url==='/api/assets')noReuploads++;return reviewOriginalOpen.call(this,method,url,...args);};document.querySelector('.chat-imported-library [data-use-material]').click();document.querySelector('[data-chat-annotate="0"]').click();`);
    await wait("document.querySelector('#media-review-dialog').open && document.querySelector('.review-image-frame img').naturalWidth>0");
    const draw=async(tool,points)=>{
      await js(`document.querySelector('[data-review-tool="${tool}"]').click()`);
      const r=await js("(()=>{const r=document.querySelector('.review-draw').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()");
      const events=points.map(([x,y])=>({x:Math.round(r.x+r.w*x),y:Math.round(r.y+r.h*y)}));
      win.webContents.sendInputEvent({type:'mouseMove',...events[0]});
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...events[0]});
      for(const p of events.slice(1)){win.webContents.sendInputEvent({type:'mouseMove',...p});await new Promise(resolve=>setTimeout(resolve,30));}
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...events.at(-1)});
    };
    await draw('rect',[[.15,.2],[.5,.55]]);
    await wait("document.querySelectorAll('.review-draw rect').length===1");
    await draw('path',[[.55,.2],[.62,.25],[.65,.4],[.55,.45]]);
    await wait("document.querySelectorAll('.review-draw polyline').length===1");
    fs.writeFileSync(path.join(directory,'image-review.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('.review-save').click();writeComment('text','这里的构图需要调整，框选和涂鸦见图。');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelector('.chat-count').textContent==='28 条 · 2 包' && document.querySelector('.chat-messages svg rect') && document.querySelector('.generation-card:not(.chat-card):not(.asset-card) .review-media svg rect')");
    const reviewMessage=await js("(async()=>{const p=await smokeApi('/api/chats/'+chatId+'/messages');return p.pack.body.messages.at(-1);})()");
    if(reviewMessage.attachments[0].id!==await js('commentAsset.id')||reviewMessage.attachments[0].review.shapes.length!==2)throw Error('Review changed original reference');
    // Refer to an already-posted video, selecting only a short range.
    await js("document.querySelector('.chat-older').click()");await wait("document.querySelectorAll('.chat-message').length===28");
    await js("(()=>{const m=[...document.querySelectorAll('.chat-message')].find(m=>m.querySelector('video'));const v=m.querySelector('video');v.closest('.review-media').parentElement.querySelector('[data-chat-reply]').click();})()");
    await wait("document.querySelector('#media-review-dialog').open && document.querySelector('.review-video').readyState>=1");
    await js("document.querySelector('.review-start').value=.2;document.querySelector('.review-end').value=.55;document.querySelector('.review-play').click()");
    await wait("document.querySelector('.review-video').paused && document.querySelector('.review-video').currentTime>=.54");
    if(await js("document.querySelector('.review-video').currentTime")>.61)throw Error('Clip exceeded end');
    await js("document.querySelector('.review-save').click();writeComment('text','0.20 到 0.55 秒需要修改。');document.querySelector('.chat-composer').requestSubmit()");
    await wait("document.querySelector('.chat-count').textContent==='29 条 · 2 包' && document.querySelector('.chat-messages video[data-review-start]')");
    await js("document.querySelector('.chat-messages video[data-review-start]').closest('figure').querySelector('[data-review-view]').click()");
    await wait("document.querySelector('.chat-messages video[data-review-start]').paused && document.querySelector('.chat-messages video[data-review-start]').currentTime>=.54");
    if(await js('noReuploads')!==0)throw Error('Annotation reuploaded media');
    await wait("document.querySelector('#save-status').textContent.includes('已自动保存') || document.querySelector('#save-status').textContent==='已保存'");
    await win.reload();await wait("!document.querySelector('#dashboard').hidden && !!document.querySelector('[data-project]')");
    await js("document.querySelector('[data-project]').click()");
    await wait("!document.querySelector('#editor').hidden && document.querySelectorAll('.connection-hit').length===2 && document.querySelector('.chat-messages svg rect') && document.querySelector('.generation-card:not(.chat-card):not(.asset-card) video[data-review-start]')");
    await wait("document.querySelectorAll('.generation-card:not(.chat-card):not(.asset-card) .imported-item').length===7");
    if(!await js("document.querySelector('.chat-messages video[data-review-start]').dataset.reviewStart==='0.2'"))throw Error('Reload lost clip');
    for(const selector of ['.chat-messages .review-image-inline img','.chat-messages video[data-review-start]']){
      const before=await js(`(()=>{const media=document.querySelector(${JSON.stringify(selector)}),box=media.closest('.review-resizable');box.querySelector('.review-size-handle').scrollIntoView({block:'center',behavior:'instant'});window.resizeBox=box;const r=box.querySelector('.review-size-handle').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:box.offsetWidth,h:box.offsetHeight};})()`);
      await new Promise(r=>setTimeout(r,150));
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:before.x,y:before.y});
      win.webContents.sendInputEvent({type:'mouseMove',x:before.x+100,y:before.y+70});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:before.x+100,y:before.y+70});
      await wait('resizeBox.classList.contains("review-custom-size")');
      if(!await js(`resizeBox.offsetWidth>${before.w} && resizeBox.offsetHeight>${before.h}`))throw Error('Media drag did not resize');
      if(!await js(`(()=>{const img=resizeBox.querySelector('.review-image-inline img'),svg=resizeBox.querySelector('svg');if(!img)return true;const a=img.getBoundingClientRect(),b=svg.getBoundingClientRect();return Math.abs(a.width-b.width)<1&&Math.abs(a.height-b.height)<1&&Math.abs(a.width/a.height-img.naturalWidth/img.naturalHeight)<.01;})()`))throw Error('Resized SVG misaligned');
      await js(`resizeBox.querySelector('.review-size-handle').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`);
      if(await js('resizeBox.classList.contains("review-custom-size")'))throw Error('Preview reset failed');
    }
    await js("document.querySelector('.chat-card').style.height='520px'");
    fs.writeFileSync(path.join(directory,'review-chain.png'),(await win.webContents.capturePage()).toPNG());

    win.setContentSize(640,760);await new Promise(r=>setTimeout(r,200));
    if(await js('document.documentElement.scrollWidth>innerWidth'))throw Error('Narrow page overflow');
    fs.writeFileSync(path.join(directory,'comments-narrow.png'),(await win.webContents.capturePage()).toPNG());
    console.log('Comments UI passed: rich text, media, linked packs, both connection directions, SVG rectangle/freehand, video clip boundaries, original asset reuse and reload.',directory);

    win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{
    if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}
    if(remoteImages)remoteImages.close();
    app.exit(failed?1:0);
  }
});
