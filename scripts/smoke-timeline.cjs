// Actual Electron + disposable DB. Timeline editing; no production account/storage.
const {app,BrowserWindow}=require('electron');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
app.commandLine.appendSwitch('mute-audio'); // Decode the tone fixture without playing test sound on the host.
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.test-data','timeline-ui-'));
app.setPath('userData',path.join(directory,'profile'));let backend,failed=false;
app.whenReady().then(async()=>{
  backend=spawn(path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['tests/inference_backend.py','serve','--port','0','--desktop'],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'sync-ui-fixture'}});
  backend.stderr.on('data',d=>process.stderr.write(d));
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),60000);readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(timer);resolve(v.port);}}catch{}});backend.once('exit',()=>reject(Error('Backend exited')));});
    const origin='http://127.0.0.1:'+port;
    const win=new BrowserWindow({width:1440,height:1080,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',(_e,level,msg)=>{if(level>=3)errors.push(msg);});
    const js=code=>win.webContents.executeJavaScript(code,true);
    const wait=async code=>{for(let n=0;n<200;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+code);};
    await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'sync-ui-fixture',httpOnly:true,path:'/',sameSite:'strict'});
    await win.loadURL(origin);await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
    await js(`window.testApi=async(url,body)=>{const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};void 0;`);
    await js(`(async()=>{await testApi('/api/setup',{login:'sync-demo',password:'sync-demo-password-123'});await testApi('/api/login',{login:'sync-demo',password:'sync-demo-password-123'});await directorStudio.enter(await testApi('/api/me'));const p=await testApi('/api/projects',{title:'雨夜来信 · 双端协作',subtitle:'保留每一次创作选择'});await directorStudio.openProject(p.block_id);})();`);
    const fixture=path.join(directory,'fixture.mp4');
    const made=spawnSync(path.join(root,'.venv/bin/python'),['-c',`import av,sys,math,array
with av.open(sys.argv[1],'w') as c:
 s=c.add_stream('libx264',rate=24);s.width=320;s.height=180;s.pix_fmt='yuv420p'
 a=c.add_stream('aac',rate=48000);a.layout='mono'
 for i in range(144):
  f=av.VideoFrame(320,180,'yuv420p')
  for p in f.planes:p.update(bytes([90])*p.buffer_size)
  for p in s.encode(f):c.mux(p)
 for p in s.encode():c.mux(p)
 for start in range(0,288000,1024):
  n=min(1024,288000-start);f=av.AudioFrame(format='fltp',layout='mono',samples=n);f.sample_rate=48000;f.pts=start
  f.planes[0].update(array.array('f',(0.03*math.sin(2*math.pi*440*(start+j)/48000) for j in range(n))).tobytes())
  for packet in a.encode(f):c.mux(packet)
 for packet in a.encode():c.mux(packet)
`,fixture]);if(made.status!==0)throw Error(made.stderr.toString());
    const bytes=fs.readFileSync(fixture);
    await js(`(()=>{const input=document.querySelector('#asset-upload'),dt=new DataTransfer();dt.items.add(new File([new Uint8Array(${JSON.stringify([...bytes])})],'镜头一 · 城市清晨.mp4',{type:'video/mp4'}));input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
    await wait("directorStudio.currentProject().body.canvas.cards.length===1");
    async function rename(value){
      await js("document.querySelector('.rename-card').click()");
      await wait("!!document.querySelector('.director-message-dialog[open]')");
      await js(`document.querySelector('.director-message-dialog input').value=${JSON.stringify(value)};document.querySelector('.director-message-dialog form').requestSubmit()`);
      await wait("!document.querySelector('.director-message-dialog')");
    }
    await rename('镜头 01 · 清晨');
    await js("document.querySelector('#toggle-timeline').click();document.querySelector('#tl-add').click()");
    await wait("directorTimeline.data().clips.length===1");
    await js("document.querySelector('#tl-add').click()");
    await wait("directorTimeline.data().clips.length===2");
    if(!await js("directorTimeline.data().clips[1].start===6"))throw Error('Append duration mismatch');
    await js("document.querySelector('#tl-subtitle').click();document.querySelector('#tl-text').value='城市醒来，故事开始。';document.querySelector('#tl-text').dispatchEvent(new Event('change'))");
    await rename('镜头 01 · 城市苏醒');
    if(!await js("[...document.querySelectorAll('.tl-clip b')].every(b=>b.textContent.includes('城市苏醒')) && document.querySelector('#tl-source').textContent.includes('城市苏醒')"))throw Error('Rename did not update existing clips');
    // Real Electron pointer drag: move second clip from 6 to 4 seconds, overlapping the first.
    const dragItem=async(selector,delta)=>{
      const p=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+Math.min(r.width/2,60)),y:Math.round(r.top+r.height/2)};})()`);
      win.webContents.sendInputEvent({type:'mouseMove',x:p.x,y:p.y});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:p.x,y:p.y});
      win.webContents.sendInputEvent({type:'mouseMove',x:p.x+delta,y:p.y});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:p.x+delta,y:p.y});
      await new Promise(r=>setTimeout(r,150));
    };
    await dragItem('.tl-clip:nth-child(2)',-120);
    if(!await js("Math.abs(directorTimeline.data().clips[1].start-4)<.03 && directorTimeline.startOf(directorTimeline.data().subtitles[0],directorTimeline.data())===4"))throw Error('Drag/follow mismatch');
    if(!await js("directorTimeline.activeClip(directorTimeline.data(),5).id===directorTimeline.data().clips[1].id"))throw Error('Overlap priority failed');
    // Magnetic docking: within eight pixels, snap the second clip to the first clip end.
    await dragItem('.tl-clip:nth-child(2)',116);
    if(!await js("directorTimeline.data().clips[1].start===6"))throw Error('Magnetic docking failed');
    await js("document.querySelector('.tl-caption').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1}));document.querySelector('#tl-mode').value='absolute';document.querySelector('#tl-mode').dispatchEvent(new Event('change'))");
    await js("document.querySelector('#tl-scroll').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));");
    await dragItem('.tl-clip:nth-child(2)',-120);
    if(!await js("directorTimeline.data().subtitles[0].start===6 && directorTimeline.data().subtitles[0].mode==='absolute'"))throw Error('Absolute caption moved');
    await dragItem('.tl-clip:nth-child(1) [data-edge=left]',60);
    if(!await js("directorTimeline.data().clips.some(c=>Math.abs(c.start-1)<.01 && Math.abs(c.in-1)<.01 && Math.abs(c.duration-5)<.01)"))throw Error('Left trim failed');
    await js("document.querySelector('#tl-zoom').value=120;document.querySelector('#tl-zoom').dispatchEvent(new Event('input'))");
    if(!await js("directorTimeline.data().zoom===120 && document.querySelector('#tl-tracks').scrollWidth>document.querySelector('#tl-scroll').clientWidth"))throw Error('Zoom/scroll failed');
    await js("document.querySelector('#tl-scroll').scrollLeft=0;document.querySelector('#tl-scroll').dispatchEvent(new WheelEvent('wheel',{deltaY:200,bubbles:true,cancelable:true}))");
    if(!await js("document.querySelector('#tl-scroll').scrollLeft===200"))throw Error('Horizontal wheel failed');
    await dragItem('.tl-clip:nth-child(2)',0);
    await js("document.querySelector('#tl-title').value='采访开场';document.querySelector('#tl-title').dispatchEvent(new Event('change'))");
    await rename('镜头 01 · 正式名称');
    if(!await js("[...document.querySelectorAll('.tl-clip b')].some(b=>b.textContent==='采访开场') && document.querySelector('.tl-source-detail').textContent.includes('正式名称') && document.querySelector('.tl-source-detail').textContent.includes('原片')"))throw Error('Clip alias/source range failed');
    await js("directorTimeline.seek(4.5);document.querySelector('#tl-set-start').click();directorStudio.save()");
    await js("directorStudio.openProject(directorStudio.currentProject().block_id)");
    if(!await js("directorStudio.currentProject().body.canvas.cards[0].title==='镜头 01 · 正式名称' && directorTimeline.data().clips.some(c=>c.title==='采访开场') && directorTimeline.data().clips.length===2 && directorTimeline.data().start===4.5 && directorTimeline.data().subtitles[0].text==='城市醒来，故事开始。'"))throw Error('Reload lost timeline');
    await js("directorTimeline.seek(6.2);document.querySelector('#tl-play').click()");
    await new Promise(r=>setTimeout(r,400));
    await js("document.querySelector('#tl-play').click()");
    if(!await js("Number(document.querySelector('#tl-time').textContent.split(' ')[0])>6.3 && !document.querySelector('#tl-video').hidden && document.querySelector('#tl-captions').textContent.includes('城市醒来')"))throw Error('Preview playback failed');
    // Intersections occupy separate rows, and retain a stem to the base lane.
    if(!await js("(()=>{const a=[...document.querySelectorAll('#tl-clips .tl-clip')].map(e=>e.getBoundingClientRect());return a[0].top!==a[1].top&&!!document.querySelector('.tl-overlap-stem');})()"))throw Error('Overlap rows missing');
    await js("[...document.querySelectorAll('#timeline-panel button')].find(b=>b.textContent==='复制时间轴').click()");
    await wait("directorTimeline.instances.size===2");
    await js("window.secondClipId=[...directorTimeline.instances.values()][1].data().clips[0].id;window.secondStart=[...directorTimeline.instances.values()][1].data().clips[0].start;window.firstBefore=JSON.stringify(directorTimeline.data());");
    await dragItem('#tl-sequences .timeline-panel:nth-child(2) .tl-clip',60);
    if(!await js("Math.abs([...directorTimeline.instances.values()][1].data().clips.find(c=>c.id===secondClipId).start-secondStart-.5)<.01 && JSON.stringify(directorTimeline.data())===firstBefore"))throw Error('Second timeline drag failed or modified first');

    await js("(()=>{const i=[...directorTimeline.instances.values()][1];const input=i.panel.querySelector('[data-tl=title]');input.value='第二轴独立片段';input.dispatchEvent(new Event('change'));window.trimBefore=i.data().clips.find(c=>c.id===secondClipId).duration;})()");
    await js("[...directorTimeline.instances.values()][1].panel.querySelector('[data-tl=scroll]').scrollLeft=300");
    await new Promise(r=>setTimeout(r,100));
    await dragItem(`[data-id="${await js('secondClipId')}"] [data-edge=right]`,-60);
    if(!await js("(()=>{const c=[...directorTimeline.instances.values()][1].data().clips.find(c=>c.id===secondClipId);return c.title==='第二轴独立片段'&&Math.abs(c.duration-trimBefore+.5)<.01;})()"))throw Error('Second timeline inspector/trim failed');
    await js("(()=>{const i=[...directorTimeline.instances.values()][1];i.seek(3);i.play();})()");
    await new Promise(r=>setTimeout(r,500));
    if(!await js("(()=>{const a=[...directorTimeline.instances.values()];return document.querySelector('#tl-audio').value==='auto'&&a[0].video.muted&&!a[1].video.muted&&a[1].video.webkitAudioDecodedByteCount>0&&!a[1].video.paused;})()"))throw Error('Second timeline automatic audio/real soundtrack decode failed');
    await js("[...directorTimeline.instances.values()][1].stop()");
    await js("document.querySelector('#tl-compare').click();document.querySelector('#tl-sync-all').checked=true;document.querySelector('#tl-sync-all').dispatchEvent(new Event('change'));directorTimeline.seek(5)");
    if(!await js("[...directorTimeline.instances.values()].every(i=>i.position()===5) && document.querySelectorAll('#tl-pin-grid video').length===2"))throw Error('PIN/sync seek failed');
    await js("document.querySelector('#tl-pin-play').click()");
    await new Promise(r=>setTimeout(r,350));
    if(!await js("(()=>{const a=[...directorTimeline.instances.values()];return a.every(i=>i.playing())&&Math.abs(a[0].position()-a[1].position())<.04&&a[0].position()>5.1;})()"))throw Error('Shared playback clock failed');
    await js("document.querySelector('#tl-pin-play').click();document.querySelector('#tl-pin-audio').value=[...directorTimeline.instances.keys()][1];document.querySelector('#tl-pin-audio').dispatchEvent(new Event('change'))");
    if(!await js("(()=>{const a=[...directorTimeline.instances.values()];return a.every(i=>!i.playing())&&a[0].video.muted&&!a[1].video.muted;})()"))throw Error('Audio routing or sync pause failed');
    await js("document.querySelector('#tl-pin-audio').value='none';document.querySelector('#tl-pin-audio').dispatchEvent(new Event('change'));document.querySelector('#tl-sync-all').checked=false;document.querySelector('#tl-sync-all').dispatchEvent(new Event('change'));[...directorTimeline.instances.values()][1].play()");
    if(!await js("(()=>{const a=[...directorTimeline.instances.values()];return !a[0].playing()&&a[1].playing()&&a.every(i=>i.video.muted);})()"))throw Error('Independent playback/mute failed');
    await js("[...directorTimeline.instances.values()][1].stop();[...document.querySelectorAll('#timeline-panel button')].find(b=>b.textContent==='复制时间轴').click();document.querySelector('#tl-pin-rows').value='1';document.querySelector('#tl-pin-rows').dispatchEvent(new Event('change'));document.querySelector('#tl-pin-cols').value='3';document.querySelector('#tl-pin-cols').dispatchEvent(new Event('change'))");
    if(!await js("document.querySelectorAll('#tl-pin-grid video').length===3"))throw Error('Three-up view failed');
    await js("[...document.querySelectorAll('#timeline-panel button')].find(b=>b.textContent==='复制时间轴').click();document.querySelector('#tl-pin-rows').value='2';document.querySelector('#tl-pin-rows').dispatchEvent(new Event('change'));document.querySelector('#tl-pin-cols').value='2';document.querySelector('#tl-pin-cols').dispatchEvent(new Event('change'));directorStudio.save()");
    if(!await js("document.querySelectorAll('#tl-pin-grid video').length===4"))throw Error('Quad view failed');
    await js("document.querySelector('#tl-pin-cols').value='3';document.querySelector('#tl-pin-cols').dispatchEvent(new Event('change'))");
    if(!await js("document.querySelector('#tl-pin-grid').style.gridTemplateColumns==='repeat(3, minmax(0px, 1fr))' && document.querySelector('#tl-pin-grid').style.gridTemplateRows==='repeat(2, minmax(0px, 1fr))' && document.querySelectorAll('#tl-pin-grid video').length===4"))throw Error('Custom 2 by 3 grid failed');
    await js("[...document.querySelectorAll('#timeline-panel button')].find(b=>b.textContent==='复制时间轴').click()");
    if(!await js("document.querySelectorAll('#tl-pin-grid video').length===5"))throw Error('PIN still limited to four streams');
    await js("[...document.querySelectorAll([...directorTimeline.instances.values()][4].panel.id?('#'+[...directorTimeline.instances.values()][4].panel.id+' button'):'')].find(b=>b.textContent==='删除时间轴').click()");
    await wait("!!document.querySelector('.director-message-dialog[open]')");
    await js("document.querySelector('.director-message-dialog [data-accept]').click()");
    await wait("directorTimeline.instances.size===4");
    await js("document.querySelector('#tl-pin-cols').value='0';document.querySelector('#tl-pin-cols').dispatchEvent(new Event('change'))");
    if(!await js("document.querySelector('#tl-pin-cols').value==='3'"))throw Error('Invalid grid dimension accepted');
    await js("document.querySelector('#tl-pin-cols').value='2';document.querySelector('#tl-pin-cols').dispatchEvent(new Event('change'))");
    await js("for(const i of directorTimeline.instances.values())i.seek(5);document.querySelector('#tl-pin-audio').value='all';document.querySelector('#tl-pin-audio').dispatchEvent(new Event('change'))");
    if(!await js("[...directorTimeline.instances.values()].every(i=>!i.video.muted)"))throw Error('Mix audio selection failed');
    await new Promise(r=>setTimeout(r,250));
    fs.writeFileSync(path.join(directory,'timeline-pin-quad.png'),(await win.webContents.capturePage()).toPNG());
    await js("directorStudio.openProject(directorStudio.currentProject().block_id)");
    if(!await js("directorTimeline.instances.size===4&&directorStudio.currentProject().body.canvas.timelines.every(t=>t.clips.length===2)"))throw Error('Multiple timelines did not persist');
    await js("(()=>{const i=[...directorTimeline.instances.values()][3];i.panel.querySelector('[data-tl=close]').click();document.querySelector('#tl-sync-all').checked=true;document.querySelector('#tl-sync-all').dispatchEvent(new Event('change'));directorTimeline.seek(5);document.querySelector('#tl-pin-play').click();})()");
    await new Promise(r=>setTimeout(r,250));
    if(!await js("(()=>{const a=[...directorTimeline.instances.values()];return a.slice(0,3).every(i=>i.playing())&&!a[3].playing();})()"))throw Error('Hidden sequence interrupted sync group');
    await js("[...directorTimeline.instances.values()][2].panel.querySelector('[data-tl=close]').click()");
    if(!await js("[...directorTimeline.instances.values()].slice(0,2).every(i=>i.playing())"))throw Error('Closing pane stopped other players');
    await js("document.querySelector('#tl-pin-play').click()");
    await js("document.querySelector('#tl-pin-close').click()");
    if(!await js("document.querySelectorAll('#tl-sequences video').length===4"))throw Error('PIN close lost video panes');
    await new Promise(r=>setTimeout(r,150));
    fs.writeFileSync(path.join(directory,'timeline.png'),(await win.webContents.capturePage()).toPNG());
    if(errors.length)throw Error(errors.join('\n'));
    console.log('Timeline passed: append, actual pointer drag, overlap, snap, follow/absolute captions, save/reopen, preview. Screenshot: '+path.join(directory,'timeline.png'));
  }catch(e){failed=true;console.error(e.stack||e);}
  finally{if(backend&&backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}app.exit(failed?1:0);}
});
