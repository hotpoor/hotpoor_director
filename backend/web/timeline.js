/* Shared desktop/cloud timeline. Later clips cover earlier clips without deleting them. */
(() => {
  'use strict';
  const startOf = (s,t) => s.mode==='follow' ? (t.clips.find(c=>c.id===s.clip_id)?.start||0)+s.start : s.start;
  const activeClip = (t,time) => [...t.clips].reverse().find(c=>time>=c.start&&time<c.start+c.duration);
  const snapTo = (value,points,threshold) => points.reduce((best,p)=>Math.abs(p-value)<Math.abs(best-value)?p:best, value+threshold+1)-value;
  const snap = (value,points,threshold) => {const d=snapTo(value,points,threshold);return Math.abs(d)<=threshold?value+d:value;};
  // Higher compositing priority always occupies a higher row when clips intersect.
  function layers(clips){
    const rows=new Map();let max=0;
    for(let i=0;i<clips.length;i++){const c=clips[i];let row=0;for(let j=0;j<i;j++){const b=clips[j];if(c.start<b.start+b.duration&&b.start<c.start+c.duration)row=Math.max(row,rows.get(b.id)+1);}rows.set(c.id,row);max=Math.max(max,row);}
    return {rows,max};
  }
  const core={startOf,activeClip,snap,layers};
  if(typeof module!=='undefined')module.exports=core;
  if(typeof document==='undefined')return;
  const global$=s=>document.querySelector(s), studio=window.directorStudio;
  const instances=new Map();let synchronized=false,syncClock=null,coordinating=false,audioChoice='auto',activeAudioKey='main';
  const workspace=document.createElement('section');workspace.id='timeline-workspace';workspace.hidden=true;
  workspace.innerHTML='<header class="tl-workspace-tools"><button id="tl-new">＋ 新时间轴</button><label><input id="tl-sync-all" type="checkbox">同步播放 / 定位</label><button id="tl-compare">PIN 对比窗</button><label>声音<select id="tl-audio"><option value="main">时间轴 1</option><option value="none">全部静音</option><option value="all">全部混音</option></select></label><button id="tl-hide-all" class="quiet">收起全部</button></header><div id="tl-sequences"></div>';
  global$('.canvas-bottom').before(workspace);
  const toggle=document.createElement('button');toggle.id='toggle-timeline';toggle.className='quiet';toggle.textContent='时间轴';global$('.canvas-bottom').prepend(toggle);
  const wall=document.createElement('section');wall.id='tl-pin-wall';wall.hidden=true;
  wall.innerHTML='<header><strong>PIN · 时间轴对比</strong><label>布局 <input id="tl-pin-rows" type="number" min="1" max="16" step="1" value="1" aria-label="PIN 布局行数"> 行 × <input id="tl-pin-cols" type="number" min="1" max="16" step="1" value="2" aria-label="PIN 布局列数"> 列</label><output id="tl-pin-count"></output><label>声音<select id="tl-pin-audio"></select></label><button id="tl-pin-play">同步播放 / 暂停</button><button id="tl-pin-close" class="quiet">✕</button></header><div id="tl-pin-grid"></div>';
  document.body.append(wall);
  let pinned=new Set(['main']),pinRows=1,pinCols=2;
  function ensurePinCapacity(){if(pinned.size>pinRows*pinCols){pinRows=Math.ceil(pinned.size/pinCols);global$('#tl-pin-rows').value=pinRows;}}
  function applyAudio(){const chosen=audioChoice==='auto'?activeAudioKey:audioChoice;for(const [key,i] of instances){i.video.muted=chosen!=='all'&&chosen!==key;i.audioStatus.textContent=i.video.muted?'静音':'🔊 音源';i.audioStatus.title=i.video.muted?'当前声音来自其他时间轴或已选择静音':'播放此时间轴的声音';}}
  function refreshAudio(){const el=global$('#tl-audio');el.innerHTML='<option value="auto">跟随播放轴</option><option value="none">全部静音</option><option value="all">全部混音</option>'+[...instances].map(([key,i])=>{const o=document.createElement('option');o.value=key;o.textContent=i.name();return o.outerHTML;}).join('');if(!instances.has(audioChoice)&&!['auto','none','all'].includes(audioChoice))audioChoice='auto';el.value=audioChoice;global$('#tl-pin-audio').innerHTML=el.innerHTML;global$('#tl-pin-audio').value=audioChoice;applyAudio();}
  function updateWall(){
    const limit=pinRows*pinCols,grid=global$('#tl-pin-grid');grid.style.gridTemplateColumns=`repeat(${pinCols},minmax(0,1fr))`;grid.style.gridTemplateRows=`repeat(${pinRows},minmax(0,1fr))`;global$('#tl-pin-count').textContent=`显示 ${Math.min(pinned.size,limit)}/${pinned.size} 路`;
    let n=0;for(const [key,i] of instances){const shown=!wall.hidden&&pinned.has(key)&&n++<limit;if(shown)grid.append(i.monitor);else i.home.prepend(i.monitor);i.monitor.classList.toggle('tl-pinned',shown);i.pin.textContent=pinned.has(key)?'已 PIN':'PIN 预览';i.monitor.querySelector('.tl-monitor-name').textContent=i.name();}
    applyAudio();
  }
  function coordinate(action,key,n){
    if(!synchronized||coordinating)return false;coordinating=true;
    const leader=instances.get(key);if(action==='play'){activeAudioKey=key;applyAudio();if(instances.size>1){wall.hidden=false;updateWall();}const time=n??leader.position();syncClock={time,at:performance.now()};for(const i of instances.values())i.stop();for(const i of instances.values())if(!i.panel.hidden){i.seek(time);i.play();}}
    else if(action==='stop'){syncClock=null;for(const i of instances.values())i.stop();}
    else {syncClock=null;for(const i of instances.values()){i.stop();i.seek(n);}}
    coordinating=false;return true;
  }
  function showAll(){workspace.hidden=false;for(const i of instances.values())i.show();toggle.setAttribute('aria-expanded','true');}
  toggle.onclick=()=>{if(workspace.hidden)showAll();else{for(const i of instances.values())i.stop();workspace.hidden=true;wall.hidden=true;updateWall();toggle.setAttribute('aria-expanded','false');}};
  global$('#tl-hide-all').onclick=()=>toggle.click();
  global$('#tl-audio').onchange=global$('#tl-pin-audio').onchange=e=>{audioChoice=e.target.value;global$('#tl-audio').value=audioChoice;global$('#tl-pin-audio').value=audioChoice;applyAudio();};
  global$('#tl-sync-all').onchange=e=>{for(const i of instances.values())i.stop();synchronized=e.target.checked;syncClock=null;if(synchronized)coordinate('seek','main',instances.get('main').position());};
  global$('#tl-compare').onclick=()=>{wall.hidden=false;updateWall();};
  global$('#tl-pin-close').onclick=()=>{wall.hidden=true;updateWall();};
  for(const axis of ['rows','cols'])global$('#tl-pin-'+axis).onchange=e=>{const n=Number(e.target.value);if(!Number.isInteger(n)||n<1||n>16){e.target.value=axis==='rows'?pinRows:pinCols;global$('#tl-pin-count').textContent='行列请输入 1–16 的整数';return;}if(axis==='rows')pinRows=n;else pinCols=n;updateWall();};
  global$('#tl-pin-play').onclick=()=>{synchronized=true;global$('#tl-sync-all').checked=true;const key=[...pinned].find(k=>instances.has(k))||'main';const i=instances.get(key);coordinate(i.playing()?'stop':'play',key);};
  let wallDrag=null;wall.querySelector('header').onpointerdown=e=>{if(e.target.closest('button,input,select,label'))return;const r=wall.getBoundingClientRect();wallDrag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};e.currentTarget.setPointerCapture(e.pointerId);};
  wall.querySelector('header').onpointermove=e=>{if(!wallDrag)return;wall.style.left=Math.max(0,Math.min(innerWidth-100,wallDrag.left+e.clientX-wallDrag.x))+'px';wall.style.top=Math.max(0,Math.min(innerHeight-50,wallDrag.top+e.clientY-wallDrag.y))+'px';wall.style.right='auto';};
  wall.querySelector('header').onpointerup=wall.querySelector('header').onpointercancel=()=>wallDrag=null;
  function createSequence(key='main'){
  const $=selector=>selector.startsWith('#tl-')?(panel.querySelector(selector.replace('#tl-','#tl-'+(key==='main'?'':key+'-')))||global$(selector.replace('#tl-','#tl-'+(key==='main'?'':key+'-')))):global$(selector);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid=()=>crypto.randomUUID().replaceAll('-','');
  const empty=()=>({version:1,start:0,zoom:60,snap:true,clips:[],subtitles:[]});
  let selected=null,position=0,playing=false,frame=0,last=0,drag=null,mediaId=null,sourceList=[],adding=false,viewZoom=null;
  const project=()=>studio.currentProject();
  const data=()=>key==='main'?(project()?.body.canvas.timeline||empty()):(project()?.body.canvas.timelines||[]).find(t=>t.id===key)||empty();
  const replaceData=t=>{if(key==='main')project().body.canvas.timeline=t;else{const list=project().body.canvas.timelines;list[list.findIndex(t=>t.id===key)]=t;}};
  const editable=()=>!!project()&&!window.directorPublicShare&&(!project().permission||['owner','admin','editor'].includes(project().permission.role));
  const scale=()=>viewZoom??data().zoom;
  const end=()=>Math.max(data().start,...data().clips.map(c=>c.start+c.duration),...data().subtitles.map(s=>startOf(s,data())+s.duration));
  function mutate(fn){if(!editable())return;if(key==='main')project().body.canvas.timeline ||= empty();fn(data());studio.changed();render();}
  const panel=document.createElement('section');panel.id=key==='main'?'timeline-panel':'timeline-panel-'+key;panel.className='timeline-panel';panel.dataset.editResource='timeline:'+key;panel.hidden=true;panel.setAttribute('aria-label','视频剪辑时间轴');
  panel.innerHTML=`<div class="tl-toolbar"><strong>时间轴 <small>SEQUENCE / 01</small></strong><button id="tl-play" aria-label="播放时间轴">▶ 播放</button><output id="tl-time">0.00 s</output><button id="tl-home" class="quiet">回到开始线</button><button id="tl-set-start" class="quiet" data-edit>设为开始线</button><label>开始 <input id="tl-start" type="number" min="0" max="86400" step="0.01" data-edit> s</label><label><input id="tl-snap" type="checkbox" data-edit>磁吸</label><label>缩放 <input id="tl-zoom" type="range" min="4" max="240" step="1" aria-label="时间轴缩放"></label><button id="tl-close" class="quiet" aria-label="收起时间轴">✕</button></div><div class="tl-body"><div class="tl-monitor"><video id="tl-video" playsinline preload="metadata"></video><div id="tl-captions"></div><span id="tl-preview-empty">移动播放线预览</span></div><div class="tl-edit"><div class="tl-import"><select id="tl-source" aria-label="引入视频"></select><button id="tl-add" data-edit>＋ 接到末尾</button><button id="tl-subtitle" data-edit class="quiet">＋ 字幕</button></div><div id="tl-inspector"></div><p id="tl-notice" role="status">拖动片段移动，拖动两端裁剪 · 后放置片段覆盖重叠区 · Alt 暂停磁吸 · Ctrl/⌘ + 滚轮缩放</p></div></div><div id="tl-scroll" tabindex="0" aria-label="可横向滚动的时间轴"><div id="tl-tracks"><div id="tl-ruler"></div><div class="tl-lane tl-video-lane"><span>视频 / 后放置优先</span><div id="tl-clips"></div></div><div class="tl-lane tl-subtitle-lane"><span>字幕</span><div id="tl-subtitles"></div></div><div id="tl-origin" title="开始线：拖动设置播放起点"></div><div id="tl-playhead" title="播放线：拖动定位"></div></div></div>`;
  panel.querySelectorAll('[id]').forEach(el=>{el.dataset.tl=el.id.slice(3);if(key!=='main')el.id=el.id.replace('tl-','tl-'+key+'-');});
  global$('#tl-sequences').append(panel);
  const pin=document.createElement('button');pin.className='quiet';pin.textContent='PIN 预览';panel.querySelector('.tl-toolbar').prepend(pin);
  pin.onclick=()=>{if(pinned.has(key))pinned.delete(key);else{pinned.add(key);ensurePinCapacity();}wall.hidden=false;updateWall();};
  const duplicate=document.createElement('button');duplicate.className='quiet';duplicate.textContent='复制时间轴';duplicate.dataset.edit='';panel.querySelector('.tl-toolbar').append(duplicate);duplicate.onclick=()=>addSequence(data());
  if(key!=='main'){const remove=document.createElement('button');remove.className='quiet';remove.textContent='删除时间轴';remove.dataset.edit='';panel.querySelector('.tl-toolbar').append(remove);remove.onclick=async()=>{const p=project();if(!editable()||!await window.directorDialogs.confirm('删除此时间轴及其编排？原视频素材保留。')||project()!==p)return;stop();instances.get(key).destroy();instances.delete(key);p.body.canvas.timelines=p.body.canvas.timelines.filter(t=>t.id!==key);pinned.delete(key);studio.changed();refreshAudio();updateWall();};}
  const heading=panel.querySelector('.tl-toolbar strong');heading.tabIndex=0;heading.title='点击重命名时间轴';heading.onclick=async()=>{if(!editable())return;const p=project();const value=await window.directorDialogs.prompt('时间轴名称',{value:data().name||name()});if(value===null||project()!==p)return;if(value.trim().length>160)return notice('名称最多 160 字符');mutate(t=>t.name=value.trim());refreshAudio();updateWall();};
  const name=()=>data().name||(key==='main'?'时间轴 1':'时间轴 '+([...instances.keys()].indexOf(key)+1));
  const home=panel.querySelector('.tl-body'),monitor=panel.querySelector('.tl-monitor');
  const monitorName=document.createElement('b');monitorName.className='tl-monitor-name';monitor.prepend(monitorName);
  const audioStatus=document.createElement('span');audioStatus.className='tl-audio-status';monitor.append(audioStatus);
  const video=$('#tl-video'),scroll=$('#tl-scroll');
  function stop(){if(coordinate('stop',key))return;playing=false;cancelAnimationFrame(frame);video.pause();$('#tl-play').textContent='▶ 播放';}
  function show(){panel.hidden=false;render();}
  function close(){const wasCoordinating=coordinating;coordinating=true;stop();coordinating=wasCoordinating;panel.hidden=true;pinned.delete(key);updateWall();}
  $('#tl-close').onclick=close;
  const sourceName=c=>studio.describeMedia(c.media)?.name||c.source_name||c.media.name;
  const clipName=c=>c.title?.trim()||sourceName(c);
  const sourceRange=c=>'原片 '+c.in.toFixed(2)+'–'+(c.in+c.duration).toFixed(2)+' s';
  function sources(){
    const before=$('#tl-source').value;
    sourceList=studio.materials().filter(m=>m.mime?.startsWith('video/'));
    $('#tl-source').innerHTML=sourceList.length?sourceList.map((m,i)=>`<option value="${i}">${esc(m.name)}</option>`).join(''):'<option value="">先在画布导入视频或生成视频</option>';
    if(before!==''&&sourceList[Number(before)])$('#tl-source').value=before;
  }
  $('#tl-source').onfocus=sources;
  function render(){
    if(!project())return close();
    const t=data(),z=scale();heading.textContent=name();monitorName.textContent=name();
    $('#tl-start').value=t.start;$('#tl-snap').checked=t.snap;$('#tl-zoom').value=z;
    panel.querySelectorAll('[data-edit]').forEach(e=>e.disabled=!editable());
    $('#tl-add').disabled=!editable()||adding;
    sources();
    const width=Math.max(scroll.clientWidth-2,(Math.max(20,end(),position)+10)*z);
    $('#tl-tracks').style.width=width+'px';
    const step=z<8?30:z<20?10:z<50?5:z<110?2:1;
    let ticks='';for(let s=Math.max(0,Math.floor(scroll.scrollLeft/z/step)*step);s<=Math.min(width/z,(scroll.scrollLeft+scroll.clientWidth)/z+step);s+=step)ticks+=`<span style="left:${s*z}px">${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}</span>`;
    $('#tl-ruler').innerHTML=ticks;
    const layout=layers(t.clips),laneHeight=28+(layout.max+1)*48;panel.querySelector('.tl-video-lane').style.height=laneHeight+'px';$('#tl-tracks').style.height=(27+laneHeight+54)+'px';
    $('#tl-clips').innerHTML=t.clips.map(c=>`<button class="tl-item tl-clip ${selected===c.id?'selected':''}" data-id="${c.id}" style="top:${18+(layout.max-layout.rows.get(c.id))*48}px;left:${c.start*z}px;width:${Math.max(3,c.duration*z)}px" title="${esc(clipName(c))} · ${esc(sourceName(c))} · ${sourceRange(c)} · 时间轴 ${c.start.toFixed(2)}–${(c.start+c.duration).toFixed(2)} s"><i data-edge="left"></i><b>${esc(clipName(c))}</b><small>${sourceRange(c)}</small><i data-edge="right"></i></button>`).join('');
    const stems=panel.querySelectorAll('.tl-overlap-stem');stems.forEach(e=>e.remove());
    for(const c of t.clips){const row=layout.rows.get(c.id);if(!row)continue;const stem=document.createElement('i');stem.className='tl-overlap-stem';Object.assign(stem.style,{left:c.start*z+'px',top:(18+(layout.max-row)*48+38)+'px',height:(row*48+6)+'px'});panel.querySelector('.tl-video-lane').append(stem);}
    $('#tl-subtitles').innerHTML=t.subtitles.map(s=>`<button class="tl-item tl-caption ${selected===s.id?'selected':''}" data-id="${s.id}" style="left:${startOf(s,t)*z}px;width:${Math.max(3,s.duration*z)}px" title="${esc(s.text)}"><i data-edge="left"></i><b>${s.mode==='follow'?'↳ ':'⌖ '}${esc(s.text)}</b><i data-edge="right"></i></button>`).join('');
    inspector();heads();preview();
  }
  function inspector(){
    const t=data(),c=t.clips.find(c=>c.id===selected),s=t.subtitles.find(s=>s.id===selected),item=c||s;
    if(!item){$('#tl-inspector').innerHTML='<p>选择片段或字幕，精确调整位置与时长。视频按原始时长连续追加。</p>';return;}
    $('#tl-inspector').innerHTML=`${s?`<label>字幕 <input id="tl-text" maxlength="2000" value="${esc(s.text)}"></label><label>定位 <select id="tl-mode"><option value="absolute" ${s.mode==='absolute'?'selected':''}>绝对定位</option><option value="follow" ${s.mode==='follow'?'selected':''}>跟随视频</option></select></label><label>绑定 <select id="tl-bind"><option value="">选择视频片段</option>${t.clips.map(c=>`<option value="${c.id}" ${s.clip_id===c.id?'selected':''}>${esc(clipName(c))} · ${c.start.toFixed(2)} s</option>`).join('')}</select></label>`:`<label>片段名 <input id="tl-title" maxlength="160" placeholder="默认跟随来源卡片" value="${esc(c.title||'')}"></label><span class="tl-source-detail" title="${esc(sourceName(c))}">来源：${esc(sourceName(c))} · ${sourceRange(c)}</span>`}<label>${s?.mode==='follow'?'片内偏移':'开始秒数'} <input id="tl-item-start" type="number" min="0" step="0.01" value="${item.start}"></label><label>持续秒数 <input id="tl-duration" type="number" min="0.04" step="0.01" value="${item.duration}"></label>${c?`<label>素材入点 <input id="tl-in" type="number" min="0" step="0.01" value="${c.in}"></label><button id="tl-front" class="quiet">置于覆盖顶层</button>`:''}<button id="tl-delete" class="quiet">移除</button>`;
    $('#tl-inspector').querySelectorAll('[id]').forEach(el=>{el.dataset.tl=el.id.slice(3);if(key!=='main')el.id=el.id.replace('tl-','tl-'+key+'-');});
    $('#tl-inspector').querySelectorAll('input,select,button').forEach(e=>e.disabled=!editable());
    const edit=(id,fn)=>{const el=$(id);if(el)el.onchange=()=>{const backup=structuredClone(data());try{mutate(t=>{fn(el,t);check(t);});notice('');}catch(e){replaceData(backup);render();notice(e.message);}};};
    edit('#tl-title',el=>c.title=el.value.trim());
    edit('#tl-text',el=>s.text=el.value);
    edit('#tl-item-start',el=>item.start=Number(el.value));
    edit('#tl-duration',el=>item.duration=Number(el.value));
    edit('#tl-in',el=>c.in=Number(el.value));
    edit('#tl-mode',(el,t)=>{const absolute=startOf(s,t);s.mode=el.value;if(s.mode==='follow'){const host=t.clips.find(c=>c.id===$('#tl-bind').value)||activeClip(t,absolute)||t.clips[0];if(!host)throw Error('请先添加视频');s.clip_id=host.id;s.start=Math.max(0,absolute-host.start);s.duration=Math.min(s.duration,host.duration-s.start);}else{s.start=absolute;delete s.clip_id;}});
    edit('#tl-bind',el=>{s.clip_id=el.value;s.mode='follow';s.start=0;s.duration=Math.min(s.duration,t.clips.find(c=>c.id===el.value)?.duration||0);});
    if(c)$('#tl-front').onclick=()=>mutate(t=>{t.clips=t.clips.filter(x=>x!==c);t.clips.push(c);});
    $('#tl-delete').onclick=()=>mutate(t=>{for(const sub of t.subtitles.filter(s=>s.clip_id===selected)){sub.start=startOf(sub,t);sub.mode='absolute';delete sub.clip_id;}t.clips=t.clips.filter(c=>c.id!==selected);t.subtitles=t.subtitles.filter(s=>s.id!==selected);selected=null;});
  }
  function check(t){
    for(const c of t.clips)if(![c.start,c.duration,c.in].every(Number.isFinite)||c.start<0||c.duration<.04||c.in<0||c.in+c.duration>c.source_duration+.001||c.start+c.duration>86400)throw Error('片段超出有效范围或原视频长度');
    for(const s of t.subtitles){const host=t.clips.find(c=>c.id===s.clip_id);if(!Number.isFinite(s.start)||!Number.isFinite(s.duration)||s.start<0||s.duration<.04||s.start+s.duration>86400||(s.mode==='follow'&&(!host||s.start+s.duration>host.duration+.001)))throw Error('字幕须在有效时间范围内；跟随字幕不能超出绑定片段');}
  }
  function notice(text){$('#tl-notice').textContent=text||'拖动片段移动，拖动两端裁剪 · 后放置片段覆盖重叠区 · Alt 暂停磁吸';}
  $('#tl-add').onclick=async()=>{
    const p=project(),sequence=data(),m=sourceList[Number($('#tl-source').value)];if(!m||!editable()||adding)return;
    if(data().clips.length>=500)return notice('最多 500 个片段');
    adding=true;$('#tl-add').disabled=true;notice('正在读取视频真实时长…');
    const probe=document.createElement('video');probe.preload='metadata';
    try{const duration=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('读取视频时长超时，请检查素材地址')),20000);probe.onloadedmetadata=()=>{clearTimeout(timer);Number.isFinite(probe.duration)&&probe.duration>=.04?resolve(probe.duration):reject(Error('视频没有可用时长'));};probe.onerror=()=>{clearTimeout(timer);reject(Error('无法读取视频，请检查格式或地址'));};probe.src=m.url;});
      if(project()!==p||(key!=='main'&&data()!==sequence))return;
      mutate(t=>{const c={id:uid(),media:{...m},source_name:m.name,start:Math.max(t.start,...t.clips.map(c=>c.start+c.duration)),duration:m.review?.kind==='video'?Math.min(duration,m.review.end)-m.review.start:duration,in:m.review?.kind==='video'?m.review.start:0,source_duration:duration};if(c.duration<.04||c.in<0)throw Error('引用片段超出原视频范围');if(c.start+c.duration>86400)throw Error('时间轴最多 24 小时');t.clips.push(c);selected=c.id;position=c.start;});notice('已追加视频，可拖动调整位置或裁剪两端');
    }catch(e){if(project()===p)notice(e.message);}finally{probe.removeAttribute('src');probe.load();adding=false;if(project()===p)$('#tl-add').disabled=!editable();}
  };
  $('#tl-subtitle').onclick=()=>mutate(t=>{if(t.subtitles.length>=2000)return notice('最多 2000 条字幕');const c=t.clips.find(c=>c.id===selected)||activeClip(t,position);const s={id:uid(),text:'输入字幕',mode:c?'follow':'absolute',start:c?Math.max(0,Math.min(position-c.start,c.duration-.04)):Math.min(position,86397),duration:c?Math.min(3,c.duration-Math.max(0,Math.min(position-c.start,c.duration-.04))):3,...(c?{clip_id:c.id}:{})};t.subtitles.push(s);selected=s.id;});
  $('#tl-snap').onchange=e=>mutate(t=>t.snap=e.target.checked);
  const setStart=n=>{if(Number.isFinite(n)&&n>=0&&n<=86400)mutate(t=>t.start=n);else render();};
  $('#tl-start').onchange=e=>setStart(Number(e.target.value));$('#tl-set-start').onclick=()=>setStart(position);
  $('#tl-home').onclick=()=>seek(data().start);
  function zoom(z,anchor=position){const before=anchor*scale()-scroll.scrollLeft;if(editable())mutate(t=>t.zoom=z);else{viewZoom=z;render();}scroll.scrollLeft=anchor*z-before;}
  $('#tl-zoom').oninput=e=>zoom(Number(e.target.value));
  scroll.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();const anchor=(e.clientX-scroll.getBoundingClientRect().left+scroll.scrollLeft)/scale();zoom(Math.max(4,Math.min(240,scale()*(e.deltaY>0?.85:1.15))),anchor);}else if(Math.abs(e.deltaY)>Math.abs(e.deltaX)){e.preventDefault();scroll.scrollLeft+=e.deltaY;}},{passive:false});
  scroll.addEventListener('scroll',()=>{if(!drag)render();});
  const at=e=>Math.max(0,Math.min(86400,(e.clientX-scroll.getBoundingClientRect().left+scroll.scrollLeft)/scale()));
  scroll.onpointerdown=e=>{
    if(e.button!==0)return;stop();const el=e.target.closest('[data-id]');
    if(el){selected=el.dataset.id;inspector();if(!editable())return;const t=data(),item=t.clips.find(c=>c.id===selected)||t.subtitles.find(s=>s.id===selected);drag={id:selected,edge:e.target.dataset.edge,original:structuredClone(t),x:at(e),start:item.start,duration:item.duration,in:item.in||0};}
    else if(e.target.dataset.tl==='origin'&&editable())drag={origin:true};
    else {drag={seek:true};seek(at(e));}
    e.preventDefault();scroll.setPointerCapture(e.pointerId);
  };
  scroll.onpointermove=e=>{
    if(!drag)return;
    if(e.clientX>scroll.getBoundingClientRect().right-30)scroll.scrollLeft+=20;
    if(e.clientX<scroll.getBoundingClientRect().left+30)scroll.scrollLeft-=20;
    if(drag.seek)return seek(at(e));
    if(drag.origin){if(key==='main')project().body.canvas.timeline ||= empty();data().start=at(e);heads();return;}
    const t=structuredClone(drag.original),item=t.clips.find(c=>c.id===drag.id)||t.subtitles.find(s=>s.id===drag.id),clip=t.clips.includes(item),base=item.mode==='follow'?(t.clips.find(c=>c.id===item.clip_id)?.start||0):0;
    let delta=at(e)-drag.x,points=[0,t.start,position];
    for(const c of t.clips)if(c.id!==item.id)points.push(c.start,c.start+c.duration);
    for(const s of t.subtitles)if(s.id!==item.id)points.push(startOf(s,t),startOf(s,t)+s.duration);
    let target=drag.start+base+delta+(drag.edge==='right'?drag.duration:0);
    if(t.snap&&!e.altKey){const candidates=drag.edge?points:points.concat(points.map(p=>p-drag.duration));target=snap(target,candidates,8/scale());}
    delta=target-(drag.start+base+(drag.edge==='right'?drag.duration:0));
    if(drag.edge==='left'){item.start=drag.start+delta;item.duration=drag.duration-delta;if(clip)item.in=drag.in+delta;}
    else if(drag.edge==='right')item.duration=drag.duration+delta;
    else {item.start=drag.start+delta;if(clip){t.clips=t.clips.filter(c=>c.id!==item.id);t.clips.push(item);}}
    try{check(t);}catch(error){notice(error.message);return;}
    replaceData(t);render();notice(`${item.start.toFixed(2)} s · ${item.duration.toFixed(2)} s`);
  };
  scroll.onpointerup=()=>{if(!drag)return;const dirty=!drag.seek;drag=null;if(dirty){studio.changed();render();}};
  scroll.onpointercancel=()=>{if(drag?.original)replaceData(drag.original);const dirty=drag?.origin;drag=null;if(dirty)studio.changed();render();};
  function heads(){const z=scale();$('#tl-origin').style.left=data().start*z+'px';$('#tl-playhead').style.left=position*z+'px';$('#tl-time').textContent=position.toFixed(2)+' s';}
  function seek(n){if(coordinate('seek',key,n))return;position=n;heads();preview(true);}
  function preview(force=false){
    const t=data(),c=activeClip(t,position);
    $('#tl-captions').textContent=t.subtitles.filter(s=>position>=startOf(s,t)&&position<startOf(s,t)+s.duration&&(s.mode!=='follow'||s.clip_id===c?.id)).map(s=>s.text).join('\n');
    $('#tl-preview-empty').hidden=!!c;video.hidden=!c;
    if(!c){video.pause();mediaId=null;return;}
    const time=c.in+position-c.start;
    if(mediaId!==c.id){mediaId=c.id;video.src=c.media.url;video.onloadedmetadata=()=>preview(true);force=true;}
    if(video.readyState>=1&&(force||Math.abs(video.currentTime-time)>.25))video.currentTime=time;
    if(playing&&video.paused)video.play().catch(e=>{if(e.name!=='AbortError'&&playing){stop();notice('视频播放失败，请检查素材地址或编码');}});
  }
  video.onerror=()=>{stop();notice('视频无法播放，请检查素材地址或浏览器支持的编码');};
  function play(){
    if(playing)return stop();if(!data().clips.length)return notice('先添加视频片段');
    if(!coordinating&&(position<data().start||position>=end()))position=data().start;
    if(!coordinating){activeAudioKey=key;applyAudio();}
    if(coordinate('play',key,position))return;
    playing=true;$('#tl-play').textContent='Ⅱ 暂停';last=performance.now();preview(true);
    const tick=now=>{if(!playing||!project()||panel.hidden||$('#editor').hidden)return stop();position=synchronized&&syncClock?syncClock.time+(now-syncClock.at)/1000:position+(now-last)/1000;last=now;const stopAt=synchronized?Math.max(...[...instances.values()].filter(i=>!i.panel.hidden).map(i=>i.end())):end();if(position>=stopAt){position=stopAt;stop();}heads();preview();if(playing)frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);
  };
  $('#tl-play').onclick=play;
  const instance={...core,key,panel,video,monitor,home,pin,audioStatus,name,data,render,show,seek,stop,play,end,busy:()=>!!drag,position:()=>position,playing:()=>playing,destroy(){coordinating=true;stop();coordinating=false;video.onloadedmetadata=null;video.onerror=null;video.removeAttribute('src');video.load();monitor.remove();panel.remove();}};
  instances.set(key,instance);return instance;
  }
  function rebuild(){
    syncClock=null;activeAudioKey='main';coordinating=true;for(const i of instances.values())i.destroy();instances.clear();coordinating=false;pinned=new Set(['main']);
    createSequence();for(const t of studio.currentProject()?.body.canvas.timelines||[])createSequence(t.id);
    if(instances.size>1)pinned.add([...instances.keys()][1]);refreshAudio();coordinating=true;for(const i of instances.values()){i.render();i.seek(i.data().start);}coordinating=false;if(!workspace.hidden)showAll();updateWall();
  }
  function addSequence(source=null){
    const p=studio.currentProject();if(!p||window.directorPublicShare||(p.permission&&!['owner','editor','admin'].includes(p.permission.role)))return;
    p.body.canvas.timelines ||= [];if(p.body.canvas.timelines.length>=7)return window.directorDialogs.alert('最多 8 个时间轴');
    const id=crypto.randomUUID().replaceAll('-',''),copy=source?structuredClone(source):{version:1,start:0,zoom:60,snap:true,clips:[],subtitles:[]};
    const ids=new Map();for(const item of [...copy.clips,...copy.subtitles]){const before=item.id;item.id=crypto.randomUUID().replaceAll('-','');ids.set(before,item.id);}for(const sub of copy.subtitles)if(sub.clip_id)sub.clip_id=ids.get(sub.clip_id);
    Object.assign(copy,{id,name:source?(source.name||'时间轴 1').slice(0,145)+' · 副本 '+(p.body.canvas.timelines.length+1):'时间轴 '+(p.body.canvas.timelines.length+2)});p.body.canvas.timelines.push(copy);studio.changed();const i=createSequence(id);i.show();refreshAudio();pinned.add(id);ensurePinCapacity();updateWall();
  };
  global$('#tl-new').onclick=()=>addSequence();
  window.addEventListener('director-project-opened',rebuild);
  window.addEventListener('director-project-updated',e=>{
    const canvas=e.detail.after.canvas,desired=new Set(['main',...(canvas.timelines||[]).map(t=>t.id)]);
    for(const [key,i] of instances)if(!desired.has(key)){i.destroy();instances.delete(key);pinned.delete(key);}
    for(const key of desired){
      const existed=instances.has(key),i=instances.get(key)||createSequence(key);
      const before=key==='main'?e.detail.before.canvas.timeline:e.detail.before.canvas.timelines?.find(t=>t.id===key);
      if(!existed||!window.directorLiveMerge.same(before,i.data())){i.render();if(!workspace.hidden)i.show();}
    }
    refreshAudio();updateWall();
  });
  window.addEventListener('director-materials-ready',()=>{for(const i of instances.values())if(!i.panel.hidden&&!i.panel.contains(document.activeElement))i.render();});
  new MutationObserver(()=>{if(global$('#editor').hidden){coordinating=true;for(const i of instances.values())i.stop();coordinating=false;wall.hidden=true;updateWall();}}).observe(global$('#editor'),{attributes:true,attributeFilter:['hidden']});
  window.directorTimeline={...core,render:()=>{for(const i of instances.values())i.render();},show:showAll,data:()=>instances.get('main')?.data(),seek:n=>instances.get('main')?.seek(n),instances};
})();
