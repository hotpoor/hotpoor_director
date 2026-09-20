(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => crypto.randomUUID().replaceAll('-', '');
  const date = v => new Date(v).toLocaleString('zh-CN', {hour12:false});
  const state = {user:null, projects:[], project:null, models:[], history:[], version:0, saved:0, saving:null, timer:null, polling:null, base:null, conflict:false};
  const stoppingJobs = new Set();
  let reorderAvailable=false, queueMoving=false, queueDrag=null;
  let elapsedTicker = null, wireDrag = null, keyboardPort = null;
  let dialogCovers = [], editing = false, uploading = false, importing = false, drag = null;
  async function request(path, body) {
    const headers = {};
    if(window.directorEditing)headers['X-Director-Client']=window.directorEditing.client;
    if (body !== undefined) headers['X-XSRFToken'] = decodeURIComponent(document.cookie.split('; ').find(x => x.startsWith('_xsrf='))?.slice(6) || '');
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {method:body === undefined ? 'GET':'POST', headers, body:body === undefined ? undefined:body instanceof FormData ? body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || '请求失败'); error.status = response.status; throw error; }
    return data;
  }
  function tell(text) { $('#studio-message').textContent = text; $('#studio-message').hidden = !text; }
  function saveLabel(text) { $('#save-status').textContent = text; }
  function changed() {
    if(state.project?.permission&&!['owner','editor','admin'].includes(state.project.permission.role)){saveLabel('只读画布 · 本地浏览调整不保存');return;}
    state.version++;
    window.dispatchEvent(new Event('director-changed'));
    saveLabel('未保存…');
    clearTimeout(state.timer);
    state.timer = setTimeout(() => save().catch(error => tell(error.message)), 700);
  }
  async function save() {
    if(window.directorPublicShare){state.saved=state.version;saveLabel('公开分享 · 只读');return;}
    clearTimeout(state.timer);
    if (state.saving) { await state.saving; return save(); }
    if (!state.project || state.saved === state.version) return;
    if (state.conflict) throw new Error('保存冲突：请先导出 JSON 草稿，重新打开项目后合并修改。');
    const version = state.version;
    const snapshot = structuredClone(state.project.body);
    const projectId = state.project.block_id;
    saveLabel('正在保存…');
    const base = structuredClone(state.base);
    state.saving = (async()=>{
      let proposed=snapshot, ancestor=base;
      for(let attempt=0;attempt<4;attempt++){
        try{return await request('/api/projects/'+projectId,proposed);}
        catch(error){
          if(error.status!==409||attempt===3)throw error;
          const remote=await request('/api/projects/'+projectId);
          try{proposed=window.directorLiveMerge.merge(ancestor,proposed,remote.body);}catch(conflict){conflict.status=409;throw conflict;}
          ancestor=remote.body;
        }
      }
    })().then(result => {
      applyRemote(result,snapshot);
      state.base=structuredClone(result.body);
      state.saved = version;
      saveLabel(state.saved === state.version ? '已自动保存 · ' + new Date().toLocaleTimeString('zh-CN') : '未保存…');
    }).catch(error => {
      state.conflict = error.status === 409;
      saveLabel(state.conflict ? '保存冲突 · 请导出草稿' : '保存失败 · 修改保留在当前窗口');
      if (!state.conflict && error.status !== 401) state.timer = setTimeout(() => save().catch(e => tell(e.message)), 5000);
      throw error;
    }).finally(() => { state.saving = null; });
    await state.saving;
    if (state.saved !== state.version) return save();
  }
  function applyRemote(remote, ancestor=state.base) {
    if(!state.project||remote.block_id!==state.project.block_id)return;
    const old=state.project.body;
    const merged=window.directorLiveMerge.merge(ancestor,old,remote.body);
    // A viewport belongs to the local viewing session. Remote edits must not pan it.
    merged.canvas.viewport=old.canvas.viewport;
    const previous=new Map(old.canvas.cards.map(c=>[c.id,c]));
    merged.canvas.cards=merged.canvas.cards.map(c=>window.directorLiveMerge.same(previous.get(c.id),c)?previous.get(c.id):c);
    state.project.body=merged;state.project.updatetime=remote.updatetime;
    if(remote.permission)state.project.permission=remote.permission;
    for(const [id] of previous)if(!merged.canvas.cards.some(c=>c.id===id))document.querySelector('[data-card="'+id+'"]')?.remove();
    for(const card of merged.canvas.cards){
      if(previous.get(card.id)===card)continue;
      let el=document.querySelector('.generation-card[data-card="'+card.id+'"]');
      if(!el){el=document.createElement('article');el.className='generation-card';el.dataset.card=card.id;$('#canvas-world').append(el);}
      renderCard(card);
    }
    $('#project-title').textContent=merged.title;$('#canvas-empty').hidden=!!merged.canvas.cards.length;renderConnections();
    window.dispatchEvent(new CustomEvent('director-project-updated',{detail:{before:old,after:merged}}));
  }
  async function refreshProject() {
    const project=state.project;if(!project||state.saving||state.conflict)return;
    const remote=await request('/api/projects/'+project.block_id);
    if(state.project!==project||state.saving||state.conflict)return;
    if(remote.body.revision===state.base?.revision)return;
    try{applyRemote(remote);state.base=structuredClone(remote.body);saveLabel(state.version===state.saved?'已实时同步 · '+new Date().toLocaleTimeString('zh-CN'):'未保存…');}
    catch(error){state.conflict=true;saveLabel('编辑冲突 · 草稿已保留');tell(error.message);throw error;}
  }
  async function dashboard() {
    if(importing||window.directorComments?.busy())throw Error('请等待素材上传或评论发送完成');
    await save();
    clearTimeout(state.polling);
    state.project = null;
    updateElapsedClocks();
    $('#editor').hidden = true; $('#dashboard').hidden = false;
    state.projects = (await request('/api/projects')).projects;
    renderProjects();
  }
  function renderProjects() {
    const term = $('#project-search').value.toLowerCase();
    const list = state.projects.filter(p => [p.body.title,p.body.subtitle,p.body.description].some(x => x.toLowerCase().includes(term)));
    $('#project-count').textContent = String(state.projects.length).padStart(2,'0');
    $('#project-list').innerHTML = list.length ? list.map(p => `<button class="project-tile" data-project="${p.block_id}"><div class="project-cover">${p.body.covers.length ? `<img src="/api/assets/${p.body.covers[0]}" alt="${esc(p.body.title)} 的封面" loading="lazy">` : '<span>◧<small>UNTITLED FRAME / 等待你的第一帧</small></span>'}<b>${p.body.covers.length ? p.body.covers.length + ' 张封面' : 'DIRECTOR PROJECT'}</b></div><div class="project-copy"><h3>${esc(p.body.title)}</h3><p>${esc(p.body.subtitle || '为下一个故事留白')}</p><div class="project-description">${esc(p.body.description)}</div><small>${p.permission?'共享项目 · '+esc(({viewer:'只读',commenter:'可评论',editor:'可编辑',admin:'管理员'})[p.permission.role]||'')+'<br>':''}创建 ${date(p.createtime)}<br>更新 ${date(p.updatetime)}</small><code>${p.block_id}</code></div></button>`).join('') : '<div class="empty-projects"><span>01 / 第一部作品</span><h2>你的创作现场，尚未开场。</h2><p>创建项目，收集灵感，让画面和故事一起生长。</p><button id="empty-create">＋ 创建第一个项目</button></div>';
  }
  async function openProject(id) {
    if(importing||window.directorComments?.busy())throw Error('请等待素材上传或评论发送完成');
    await save();
    const project = await request('/api/projects/' + id);
    state.project = project; state.base = structuredClone(project.body); state.version = 0; state.saved = 0; state.conflict = false; state.history = [];spending.close();$('#spending-notice').textContent='';
    $('#dashboard').hidden = true; $('#editor').hidden = false; $('#project-title').textContent = project.body.title;
    saveLabel('已保存'); tell(''); renderCanvas(); renderQueue(); window.dispatchEvent(new Event('director-project-opened')); await pollHistory();
  }
  function openDialog(edit = false) {
    editing = edit; const body = edit ? state.project.body : {title:'',subtitle:'',description:'',covers:[]};
    const form = $('#project-form');
    for (const key of ['title','subtitle','description']) form.elements[key].value = body[key];
    dialogCovers = [...body.covers]; $('#cover-upload').value = ''; $('#project-form-error').textContent = '';
    $('#dialog-title').textContent = edit ? '项目设置' : '新建项目';
    $('#save-project').textContent = edit ? '保存设置' : '创建并进入画布';
    renderCovers(); $('#project-dialog').showModal();
  }
  function renderCovers() { $('#cover-list').innerHTML = dialogCovers.map((id,i) => `<div><img src="/api/assets/${id}" alt="封面 ${i+1}"><button type="button" data-remove-cover="${i}" aria-label="移除封面">✕</button><small>${i ? i+1:'主封面'}</small></div>`).join(''); }
  async function uploadMedia(file) {
    const limit=file.type.startsWith('image/')?20:200;
    if(file.size>limit*1024*1024)throw new Error(`${file.name} 不能超过 ${limit} MB`);
    if(window.directorCloud){const cloud=await window.directorStorage.uploadFile(file);return request('/api/assets/cloud',{upload_id:cloud.id});}
    const form=new FormData();form.append('file',file);return request('/api/assets',form);
  }
  async function upload(file) {
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('封面和参考图只支持 PNG、JPEG、WebP 图片');
    return (await uploadMedia(file)).id;
  }
  async function addCovers(files) {
    if(uploading)return;
    if(dialogCovers.length+files.length>20){$('#project-form-error').textContent='最多 20 张封面';return;}
    uploading=true;$('#save-project').disabled=true;
    try{for(const file of files){dialogCovers.push(await upload(file));renderCovers();}}
    catch(error){$('#project-form-error').textContent=error.message;}
    finally{uploading=false;$('#save-project').disabled=false;$('#cover-upload').value='';}
  }
  $('#cover-upload').onchange=event=>addCovers([...event.target.files]);
  $('#choose-covers').onclick=()=>$('#cover-upload').click();
  $('#cover-list').onclick = event => { const button = event.target.closest('[data-remove-cover]'); if (button) {dialogCovers.splice(Number(button.dataset.removeCover),1);renderCovers();} };
  $('#close-dialog').onclick = () => $('#project-dialog').close();
  $('#project-form').onsubmit = async event => {
    event.preventDefault(); if (uploading) return;
    const form = event.currentTarget; $('#save-project').disabled = true;
    try {
      const metadata = Object.fromEntries(new FormData(form)); metadata.covers = [...dialogCovers];
      if (editing) { Object.assign(state.project.body,metadata); changed(); await save(); $('#project-title').textContent = metadata.title; }
      else { const project = await request('/api/projects',metadata); await openProject(project.block_id); }
      $('#project-dialog').close();
    } catch (error) { $('#project-form-error').textContent = error.message; }
    finally { $('#save-project').disabled = false; }
  };
  const cards = () => state.project.body.canvas.cards;
  const cardById = id => cards().find(c => c.id === id);
  function draft(card) {
    card.drafts ||= {};
    const selectedModel = card.model || card.drafts[card.mode]?.model;
    const spec=state.models.find(m=>m.id===selectedModel);
    const standard = selectedModel === 'z-image';
    const defaults = {max_images:4,n:1,quality:'auto',background:'auto',output_format:spec?.output_formats?.[0] || 'jpeg',optimize_mode:'standard',watermark:true,size:spec?.sizes?.[0] || '1K',resolution:spec?.resolutions?.[0] || '480p',ratio:'16:9',generate_audio:true,image_urls:'',video_urls:'',audio_urls:'',first_frame:'',last_frame:'',negative_prompt:'', cfg:standard?4:1, model:card.type === 'image' ? 'z-image-turbo':'minimax-h3', prompt:'', width:spec?.default_width || (card.type === 'image' ? 1024:832), height:spec?.default_height || (card.type === 'image' ? 1024:480), steps:spec?.default_steps || (standard?40:8), seed:-1, denoise:.65, duration:spec?.default_duration || 2, refs:[]};
    if(card.model && card.drafts[card.mode]?.model && card.drafts[card.mode].model!==card.model){
      card.drafts[card.mode].steps=defaults.steps;card.drafts[card.mode].cfg=defaults.cfg;
      for(const k of ['width','height','duration','size','resolution','output_format','optimize_mode','quality','background','n'])card.drafts[card.mode][k]=defaults[k];
      if(spec?.provider==='service-inference')card.drafts[card.mode].refs=[];
      card.drafts[card.mode].refs=card.drafts[card.mode].refs.filter(r=>(spec?.ref_types||['image']).includes(refKind(card.drafts[card.mode],r))).slice(0,spec?.ref_limit || (card.type==='video'?2:1));
    }
    return card.drafts[card.mode] = {...defaults, ...card.drafts[card.mode], ...(card.model ? {model:card.model} : {})};
  }
  function transform() {
    const {x,y,zoom} = state.project.body.canvas.viewport;
    $('#canvas-world').style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    $('#zoom-reset').textContent = Math.round(zoom*100)+'%';
    $('#canvas').style.backgroundSize = `${24*zoom}px ${24*zoom}px`;
    $('#canvas').style.backgroundPosition = `${x}px ${y}px`;
  }
  function renderCanvas() {
    const liveChats=new Map([...document.querySelectorAll('.chat-card')].map(el=>[el.dataset.card,el]));
    $('#canvas-world').innerHTML = '<svg class="connection-layer" aria-label="卡片连接线"><defs><marker id="connection-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#aaa"/></marker></defs><g class="connection-paths"></g></svg>';wireDrag=null;keyboardPort=null;
    for (const card of cards()) { const candidate=liveChats.get(card.id);const live=card.type==='chat'&&candidate?._commentCard===card?candidate:null;const el=live||document.createElement('article');if(!live){el.className='generation-card';el.dataset.card=card.id;}$('#canvas-world').append(el);if(live)position(card,el);else renderCard(card); }
    $('#canvas-empty').hidden = !!cards().length; transform();renderConnections();
  }
  function position(card, el) {
    Object.assign(el.style,{left:card.x+'px',top:card.y+'px',width:card.w+'px',height:card.h+'px'});
    if(['image','video'].includes(card.type)){
      el.classList.toggle('generation-wide',card.w>=760);
      const toggle=el.querySelector('[data-card-layout]');
      if(toggle){toggle.textContent=card.w>=760?'上下布局':'左右布局';toggle.setAttribute('aria-label',card.w>=760?'收窄卡片，切换上下布局':'展开卡片，切换左右布局');}
    }
  }
  const connections=()=>state.project.body.canvas.connections ||= [];
  function referenceLimit(card){return state.models.find(m=>m.id===card.model)?.ref_limit || (card.mode==='reference'?8:card.type==='video'?2:1);}
  function referenceLabel(card,i){if(card.mode==='reference'){const d=draft(card),kind=refKind(d,d.refs[i]);return `${{image:'Picture',video:'Video',audio:'Audio'}[kind]} ${d.refs.slice(0,i+1).filter(r=>refKind(d,r)===kind).length}`;}return card.type==='video'?(i?'尾帧':'首帧'):String(i+1);}
  function acceptsReference(card,mime){const spec=state.models.find(m=>m.id===card.model);if(spec?.provider==='service-inference')return mime?.startsWith('image/')||(spec.type==='video'&&spec.modes.includes('reference')&&['video','audio'].includes(mime?.split('/')[0]));return (state.models.find(m=>m.id===card.model)?.ref_types || ['image']).includes(mime?.split('/')[0]);}
  function refKind(d,id){return d.ref_info?.[id]?.mime?.split('/')[0] || 'image';}
  function rememberRef(d,asset){(d.ref_info ||= {})[asset.id]={mime:asset.mime,name:asset.name};}
  function checkRefCount(card,d,mime){const kind=mime.split('/')[0];if(!acceptsReference(card,mime))throw Error('当前模型不支持此参考类型');if(d.refs.length>=referenceLimit(card))throw Error(`最多 ${referenceLimit(card)} 项参考素材`);if(kind!=='image'&&d.refs.filter(r=>refKind(d,r)===kind).length>=3)throw Error('视频和音频各最多 3 项');}
  function refPreview(d,id){const kind=refKind(d,id),url='/api/assets/'+esc(id);return kind==='image'?`<img src="${url}" alt="参考图片">`:`<${kind} src="${url}" controls preload="metadata"></${kind}>`;}
  const promptSelections=new WeakMap();
  function rememberPromptSelection(event){
    const input=event.target;
    if(!input.matches?.('textarea[data-field="prompt"]'))return;
    const card=cardById(input.closest('[data-card]')?.dataset.card);if(!card)return;
    promptSelections.set(card,{model:card.model,mode:card.mode,value:input.value,start:input.selectionStart,end:input.selectionEnd});
  }
  function insertReferenceMention(card,el,token){
    if(window.directorPublicShare||state.project?.permission&&!['owner','editor','admin'].includes(state.project.permission.role))return;
    const input=el.querySelector('textarea[data-field="prompt"]');if(!input)return;
    const saved=promptSelections.get(card);
    const valid=saved&&saved.model===card.model&&saved.mode===card.mode&&saved.value===input.value;
    const start=valid?saved.start:input.value.length,end=valid?saved.end:start;
    input.setRangeText(token,start,end,'end');
    input.focus({preventScroll:true});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    rememberPromptSelection({target:input});
  }
  function localReferenceToken(d,index){
    const kind=refKind(d,d.refs[index]);
    return '@'+({image:'Image',video:'Video',audio:'Audio'}[kind]||'Image')+d.refs.slice(0,index+1).filter(id=>refKind(d,id)===kind).length;
  }
  function cloudReferenceMentions(d,key){
    const kind=key==='video_urls'?'Video':key==='audio_urls'?'Audio':'Image';
    return String(d[key]||'').split(/\s+/).filter(Boolean).map((url,index)=>{
      const token='@'+kind+(key==='last_frame'?2:index+1);
      const safe=/^https?:\/\//i.test(url);
      const preview=kind==='Image'&&safe?`<img src="${esc(url)}" alt="${token} 参考图片" loading="lazy" draggable="false">`:`<span class="reference-media-kind">${kind==='Video'?'视频':kind==='Audio'?'音频':'图片'}</span>`;
      return `<button type="button" class="reference-mention quiet" data-ref-mention="${token}" title="插入 ${token} · ${esc(url)}">${preview}<strong>${token}</strong></button>`;
    }).join('');
  }
  function refreshReferenceMentions(card,el,key){
    const list=el.querySelector(`[data-reference-field="${key}"]`);
    if(list)list.innerHTML=cloudReferenceMentions(draft(card),key);
  }
  function historyMaterials(body){
    const refs=body.refs || [],counts={image:0,video:0,audio:0};
    if(!refs.length)return '<p class="history-materials-empty">本次未使用参考素材</p>';
    return `<div class="history-materials">${refs.map((id,i)=>{
      const kind=refKind(body,id),info=body.ref_info?.[id],url='/api/assets/'+esc(id);
      const label=body.mode==='reference'?`${{image:'Picture',video:'Video',audio:'Audio'}[kind]} ${++counts[kind]}`:body.type==='video'?(i?'尾帧':'首帧'):'输入图片';
      const name=info?.name || label;
      const media=kind==='image'?`<img src="${url}" data-preview="${url}" data-preview-title="${esc(label+' · '+name)}" alt="${esc(name)}" role="button" tabindex="0" loading="lazy">`:kind==='video'?`<video src="${url}" controls preload="metadata" aria-label="${esc(name)}"></video>`:`<div class="history-audio-icon" aria-hidden="true">♫</div><audio src="${url}" controls preload="metadata" aria-label="${esc(name)}"></audio>`;
      return `<figure>${media}<figcaption><strong>${label}</strong><span>${esc(name)}</span></figcaption></figure>`;
    }).join('')}</div>`;
  }
  function sizeHelp(card,model){const l=model?.size_limits;if(!l)return '';return `<section class="size-help"><strong>推荐尺寸</strong><div>${l.presets.map(([w,h])=>`<button class="quiet" data-size-preset="${w},${h}">${w} × ${h}</button>`).join('')}</div><small>宽高各 ${l.minimum}–${l.maximum} px，${l.step} 的倍数；总像素 ≤ ${l.max_pixels.toLocaleString()}。这是当前工作台的本机限制；分辨率越高越耗显存。${card.type==='video'?'建议先用 512×320 短片测试。':''}</small><p class="size-error" role="status" hidden></p></section>`;}
  function checkSize(card){const d=draft(card),l=state.models.find(m=>m.id===d.model)?.size_limits;if(!l)return '';for(const [key,label] of [['width','宽度'],['height','高度']]){const n=d[key];if(!Number.isInteger(n)||n<l.minimum||n>l.maximum)return `${label}需为 ${l.minimum}–${l.maximum} px 的整数`;if(n%l.step)return `${label} ${n} px 不符合要求，需为 ${l.step} 的倍数`;}return d.width*d.height>l.max_pixels?`总像素 ${(d.width*d.height).toLocaleString()} 超过本机上限 ${l.max_pixels.toLocaleString()}，请减小宽高或选择推荐尺寸。`:'';}
  function updateSizeFeedback(card){const el=document.querySelector(`[data-card="${card.id}"]`),error=checkSize(card),hint=el?.querySelector('.size-error');if(hint){hint.textContent=error;hint.hidden=!error;}for(const key of ['width','height'])el?.querySelector(`[data-field="${key}"]`)?.setAttribute('aria-invalid',String(!!error));updateGenerationSummary(card);return error;}
  function cardPorts(){return '<button class="card-port port-input" data-port="input" aria-label="输入连接点，接收其他卡片素材" title="左侧输入：从其他卡片右侧拖线到这里"></button><button class="card-port port-output" data-port="output" aria-label="输出连接点，拖向另一张卡片左侧" title="右侧输出：拖向另一张卡片左侧"></button>';}
  function portPoint(card,side){return {x:side==='output'?card.x+card.w+15:card.x-15,y:card.y+card.h/2};}
  function wirePath(a,b){const bend=Math.max(70,Math.abs(b.x-a.x)*.45);return `M ${a.x} ${a.y} C ${a.x+bend} ${a.y}, ${b.x-bend} ${b.y}, ${b.x} ${b.y}`;}
  function renderConnections(){
    const group=$('.connection-paths');if(!group||!state.project)return;
    let html=connections().map(edge=>{const a=cardById(edge.source),b=cardById(edge.target);return a&&b?`<path class="connection-wire" d="${wirePath(portPoint(a,'output'),portPoint(b,'input'))}" marker-end="url(#connection-arrow)"/><path class="connection-hit" data-edge="${edge.id}" d="${wirePath(portPoint(a,'output'),portPoint(b,'input'))}"><title>双击断开连接</title></path>`:'';}).join('');
    if(wireDrag){const card=cardById(wireDrag.id);if(card){const fixed=portPoint(card,wireDrag.side);html+=`<path class="connection-wire draft-wire" d="${wireDrag.side==='output'?wirePath(fixed,wireDrag):wirePath(wireDrag,fixed)}"/>`;}}
    group.innerHTML=html;
  }
  function connectCards(source,target){
    if(source===target){tell('不能连接卡片自身');return;}
    if(connections().some(e=>e.source===source&&e.target===target)){tell('这两张卡片已经连接');return;}
    if(connections().length>=1000){tell('当前画布最多 1000 条连接线');return;}
    connections().push({id:uid(),source,target});renderConnections();renderLibraries();changed();tell('已连接，可在下游卡片的引入素材库中使用素材');
  }
  function disconnect(id){state.project.body.canvas.connections=connections().filter(e=>e.id!==id);renderConnections();renderLibraries();changed();}
  function upstreamMaterials(card){
    const materials=[],seen=new Set();
    for(const edge of connections().filter(e=>e.target===card.id)){
      const source=cardById(edge.source);if(!source)continue;
      if(source.type==='chat'){
        for(const a of window.directorComments.outputs(source.chat_id)){const key='comment:'+a.key;if(seen.has(key))continue;seen.add(key);materials.push({key,asset:a.source==='asset'?a.id:null,storage:a.source==='cloud'||a.source==='url'?'cloud':undefined,url:a.url,name:cardName(source)+' · '+a.commentLabel+' · '+a.name,mime:a.mime,review:a.review,reviewAttachment:a,commentText:a.commentText,attachment:a});}
      }else if(source.type==='asset'){
        const key='asset:'+source.asset_id;if(seen.has(key))continue;seen.add(key);
        materials.push({attachment:{source:source.storage==='cloud'?'cloud':'asset',id:source.asset_id,url:source.storage==='cloud'?source.url:'/api/assets/'+source.asset_id,mime:source.mime,name:cardName(source)},key,asset:source.storage==='cloud'?null:source.asset_id,storage:source.storage,copySource:source.storage==='cloud'?'/api/storage/uploads/'+source.asset_id+'/image':'',url:source.storage==='cloud'?source.url:'/api/assets/'+source.asset_id,name:cardName(source),mime:source.mime});
      }else{
        for(const job of state.history.filter(h=>h.body.card_id===source.id&&h.body.status==='completed'))for(const [index,output] of job.body.outputs.entries()){
          const key=job.block_id+':'+index;if(seen.has(key))continue;seen.add(key);
          materials.push({attachment:{source:'output',id:job.block_id,index,url:`/api/outputs/${job.block_id}/${index}`,mime:job.body.type==='image'?'image/png':'video/mp4',name:job.body.model},key,storage:output.remote_url?'cloud':undefined,url:output.remote_url||`/api/outputs/${job.block_id}/${index}`,name:cardName(source)+' · '+date(job.createtime)+' · 结果 '+(index+1),mime:job.body.type==='image'?'image/png':'video/mp4'});
        }
      }
    }
    return card.type==='chat'?materials.filter(m=>/^(image|video)\//.test(m.mime)):materials;
  }
  function renderLibrary(card){
    if(card.type==='chat')window.directorComments.refreshReferences(card.chat_id);
    const library=document.querySelector(`[data-card="${card.id}"] .imported-library`);if(!library)return;
    const incoming=connections().filter(e=>e.target===card.id),materials=upstreamMaterials(card);
    const html=`<summary>引入素材库 · ${materials.length}</summary><div class="upstream-links">${incoming.map(e=>`<span>${esc(cardById(e.source)?.name||e.source.slice(0,6))}<button class="quiet" data-disconnect="${e.id}" title="断开此来源">×</button></span>`).join('')}</div>${materials.length?`<div class="imported-items">${materials.map(m=>`<div class="imported-item">${m.reviewAttachment?window.directorReview.media(m.reviewAttachment):m.mime?.startsWith('image/')?`<img src="${m.url}" data-preview-copy="${esc(m.copySource||'')}" data-preview="${m.url}" data-preview-title="${esc(m.name)}" alt="${esc(m.name)}" tabindex="0" role="button" loading="lazy">`:m.mime?.startsWith('video/')?`<video src="${m.url}" controls preload="metadata"></video>`:`<audio src="${m.url}" controls preload="metadata"></audio>`}<small>${esc(m.name)}</small>${m.commentText?`<p class="imported-comment-text">${esc(m.commentText)}</p>`:''}${card.type==='chat'?`<button class="quiet" data-use-material="${m.key}">引用并评论</button>`:card.type!=='asset'?`<button class="quiet" data-use-material="${m.key}" ${(acceptsReference(card,m.mime)&&(m.storage!=='cloud'||state.models.find(model=>model.id===card.model)?.provider==='service-inference'))?'':'disabled'}>${(acceptsReference(card,m.mime)&&(m.storage!=='cloud'||state.models.find(model=>model.id===card.model)?.provider==='service-inference'))?'用作参考素材':(state.models.find(model=>model.id===card.model)?.provider==='service-inference'?'云端参考请填写公网 URL':'当前模型不支持此类输入')}</button>`:''}</div>`).join('')}</div>`:`<p>${incoming.length?'等待上游卡片生成素材。':'从其他卡片右侧拖线到本卡片左侧，引入素材。'}</p>`}`;
    if(library._markup!==html){library.innerHTML=html;library._markup=html;}
  }
  function renderLibraries(){if(state.project)for(const card of cards())renderLibrary(card);}
  async function useMaterial(card,key){
    if(importing)return;
    const material=upstreamMaterials(card).find(m=>m.key===key);if(!material)return;
    if(card.type==='chat'){window.directorComments.addAttachment(card.chat_id,material.attachment);return;}
    if(!acceptsReference(card,material.mime))return;
    const model=state.models.find(m=>m.id===card.model);
    if(model?.provider==='service-inference'){
      if(material.storage==='cloud'){
        card.mode=model.type==='image'?'image':model.modes.includes('reference')?'reference':'image';const d=draft(card);
        const key=material.mime.startsWith('video/')?'video_urls':material.mime.startsWith('audio/')?'audio_urls':model.api_version==='v2'&&card.mode==='image'?'first_frame':'image_urls';
        const single=key==='first_frame',urls=(d[key]||'').split(/\s+/).filter(Boolean),limit=single?1:key==='image_urls'?model.ref_limit:3;
        if(!single&&urls.length>=limit){tell(`最多 ${limit} 项参考素材`);return;}
        d[key]=single?material.url:[...new Set([...urls,material.url])].join('\n');renderCard(card);changed();tell('已使用云存储 URL 作为参考素材');return;
      }
      card.mode=model.type==='image'?'image':model.modes.includes('reference')?'reference':'image';draft(card);renderCard(card);changed();
      try{const response=await fetch(material.url);if(!response.ok)throw Error('无法读取上游素材');const blob=await response.blob();
        await addCloudReferences(card,material.mime.startsWith('video/')?'video_urls':material.mime.startsWith('audio/')?'audio_urls':model.api_version==='v2'&&card.mode==='image'?'first_frame':'image_urls',[new File([blob],'upstream'+(material.mime.startsWith('video/')?'.mp4':material.mime.startsWith('audio/')?'.wav':'.png'),{type:material.mime})]);
      }catch(e){tell(e.message);}return;
    }
    if(!model?.modes.some(m=>m==='image'||m==='reference')){tell('当前模型不支持图片输入');return;}
    const project=state.project;
    card.mode=model.type==='image'?'image':model.modes.includes('reference')?'reference':'image';const d=draft(card),limit=referenceLimit(card);
    if(material.asset&&d.refs.includes(material.asset)){tell('这个素材已经在输入列表中');renderCard(card);changed();return;}
    if(d.refs.length>=limit){tell(`当前模式最多 ${limit} 项参考素材，请先移除已有输入`);renderCard(card);changed();return;}
    importing=true;
    try{
      checkRefCount(card,d,material.mime);
      let id=material.asset;
      if(!id){tell('正在载入上游生成素材…');const response=await fetch(material.url);if(!response.ok)throw Error('无法读取上游结果，请确认 ComfyUI 正在运行');const blob=await response.blob();const asset=await uploadMedia(new File([blob],material.mime.startsWith('video/')?'upstream.mp4':'upstream.png',{type:material.mime}));id=asset.id;rememberRef(d,asset);}
      if(state.project!==project||!cardById(card.id))return;
      if(material.asset)rememberRef(d,{id,mime:material.mime,name:material.name});
      d.refs.push(id);renderCard(card);changed();tell('已添加到参考素材；点击生成即可使用');
    }catch(error){tell(error.message);if(state.project===project){renderCard(card);changed();}}
    finally{importing=false;}
  }
  function cardCredentials(card) {
    const all=state.inferenceCredentials||{keys:[]};
    const keys=(all.keys||[]).filter(p=>(all.enabled_key_ids||[]).includes(p.id));
    if(!card.credential_id&&keys.length){
      const supports=p=>state.models.some(m=>m.type===card.type&&m.provider==='service-inference'&&(m.credential_ids||[]).includes(p.id));
      const active=keys.find(p=>p.id===all.active_key_id);
      const preferred=card.model||card.drafts?.[card.mode]?.model;
      const matching=keys.find(p=>state.models.some(m=>m.id===preferred&&(m.credential_ids||[]).includes(p.id)));
      card.credential_id=(active&&supports(active)?active:matching||keys.find(supports)||active||keys[0])?.id||'';
    }
    return {...all,keys};
  }
  function renderCard(card) {
    const el = document.querySelector(`[data-card="${card.id}"]`); if (!el) return;
    position(card,el);
    if(card.type==='chat'){
      window.directorComments.mount(el,card,{request,changed,save,projectId:state.project.block_id,ownerId:state.user.user_id,materials:()=>commentMaterials(card),materialsChanged:()=>{if(state.project?.block_id===el._commentProject)renderLibraries();}});
      el._commentProject=state.project.block_id;el.insertAdjacentHTML('beforeend',cardPorts());renderLibrary(card);
      return;
    }
    if(card.type==='asset'){
      const url=esc(card.storage==='cloud'?card.url:'/api/assets/'+card.asset_id);
      const media=card.mime?.startsWith('image/')?`<img src="${url}" data-preview-copy="${card.storage==='cloud'?'/api/storage/uploads/'+card.asset_id+'/image':''}" data-preview="${url}" data-preview-title="${esc(card.name)}" role="button" tabindex="0" alt="${esc(card.name)}">`:card.mime?.startsWith('video/')?videoMedia(url):`<div class="audio-art">♫</div><audio src="${url}" controls preload="metadata"></audio>`;
      el.classList.add('asset-card');
      el.innerHTML=`<header class="card-heading"><span class="card-grip">⠿</span><strong title="${esc(cardName(card))}">${esc(cardName(card))}</strong><button class="quiet rename-card" title="重命名卡片" aria-label="重命名卡片">✎</button><button class="quiet remove-card" title="移除素材卡片">✕</button></header><div class="asset-content">${media}<small>${card.storage==='cloud'?'云存储 · ':''}${esc(card.mime)} · ${((card.size||0)/1024/1024).toFixed(2)} MB</small>${card.storage==='cloud'?'<button class="quiet copy-cloud-url">复制公网 URL</button>':''}<p class="media-error" hidden>浏览器无法播放此文件，请检查编码格式。</p></div>${['n','s','e','w','ne','nw','se','sw'].map(dir=>`<div class="resize-handle resize-${dir}" data-resize="${dir}"></div>`).join('')}`;
      el.insertAdjacentHTML('beforeend',cardPorts());el.querySelector('.asset-content').insertAdjacentHTML('beforeend','<details class="imported-library" open></details>');renderLibrary(card);
      return;
    }
    const credentials=cardCredentials(card);
    const cardModels=state.models.map(m=>m.provider==='service-inference'?{...m,available:(m.credential_ids||[]).includes(card.credential_id)}:m);
    const available = cardModels.filter(m => m.type === card.type&&(m.available!==false||m.id===card.model));
    const model = available.find(m => m.id === (card.model || draft(card).model)) || available[0];
    if(model) {
      card.model = model.id;
      if(!model.modes.includes(card.mode) && model.modes.length) {
        card.mode = model.modes[0];
        changed();
      }
    }
    const d = draft(card), unsupported = model?.available===false||!model?.modes.includes(card.mode);
    const tabLabels = card.type === 'image' ? ['文生图','图生图','参考图'] : ['文生视频','图生视频','多元素参考'];
    el.innerHTML = `<header class="card-heading"><span class="card-grip">⠿</span><strong title="${esc(cardName(card))}">${esc(cardName(card))}</strong><button class="quiet rename-card" title="重命名卡片" aria-label="重命名卡片">✎</button><small>${card.id.slice(0,6).toUpperCase()}</small><button class="quiet remove-card" title="移除卡片">✕</button></header><div class="card-progress"></div><div class="card-content"><section class="card-results"></section><details class="imported-library" open></details>${(model?.provider==='service-inference'||credentials.keys.length||card.credential_id)?`<label class="model-picker">生成 AK<select data-credential><option value="">请选择生成 AK</option>${credentials.keys.map(p=>`<option value="${esc(p.id)}" ${p.id===card.credential_id?'selected':''}>${esc(p.name)}</option>`).join('')}${card.credential_id&&!credentials.keys.some(p=>p.id===card.credential_id)?'<option selected disabled>原 AK 在当前账号不可用，请重新选择</option>':''}</select></label>`:''}<label class="model-picker">模型<select data-field="model" ${available.length?'':'disabled'}>${available.map(m=>`<option value="${m.id}" ${m.available===false?'disabled':''} ${m.id===d.model?'selected':''}>${esc(m.name)}${m.available===false?'（所选 AK 不可用）':''}</option>`).join('') || '<option>暂无可用模型</option>'}</select></label><div class="generation-tabs" role="tablist">${['text','image','reference','edit','series'].map((m,i)=>model?.modes.includes(m)?`<button role="tab" aria-selected="${m===card.mode}" data-mode="${m}">${model?.type==='image'&&model?.provider==='service-inference'?({text:'文生图',image:'图片编辑',reference:'多图融合',edit:'交互编辑',series:'组图生成'}[m]):tabLabels[i]}</button>`:'').join('')}</div><div class="generation-settings">${model?.note?`<p class="mode-note">${esc(model.note)}</p>`:''}<label>提示词<textarea data-field="prompt" rows="3" placeholder="描述画面、镜头、光线与情绪…">${esc(d.prompt)}</textarea></label>${d.model==='z-image'?`<label>反向提示词<textarea data-field="negative_prompt" rows="2" placeholder="希望避免的内容…">${esc(d.negative_prompt)}</textarea></label>`:''}${card.mode!=='text' ? `<div class="ref-zone" tabindex="0"><span>${card.mode==='reference'?'参考素材（按类型编号）':card.type==='video'?(referenceLimit(card)>1?'首帧 / 尾帧（可选）':'首帧图片'):'输入图片'}</span><button class="quiet choose-ref">＋ 添加${model?.ref_types?'素材':'图片'} · 拖入 / 粘贴</button><input hidden class="ref-upload" type="file" accept="${model?.ref_types?'image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/*':'image/png,image/jpeg,image/webp'}" ${card.type==='video'||card.mode==='reference'?'multiple':''}></div><div class="ref-list">${d.refs.map((r,i)=>`<div>${refKind(d,r)==='image'?`<button type="button" class="local-reference-mention" data-ref-mention="${localReferenceToken(d,i)}" title="插入 ${localReferenceToken(d,i)}">${refPreview(d,r)}</button>`:refPreview(d,r)}<button class="quiet" data-remove-ref="${i}" title="移除参考素材">✕</button><small>${referenceLabel(card,i)}</small><button type="button" class="quiet reference-token" data-ref-mention="${localReferenceToken(d,i)}">${localReferenceToken(d,i)}</button></div>`).join('')}</div>`:''}${sizeHelp(card,model)}<div class="parameter-grid"><label>宽度<input data-field="width" type="number" min="256" max="1536" step="${model?.dimension_step || (card.type==='image'?16:32)}" value="${d.width}"></label><label>高度<input data-field="height" type="number" min="256" max="1536" step="${model?.dimension_step || (card.type==='image'?16:32)}" value="${d.height}"></label><label>步数<input data-field="steps" type="number" min="1" max="${d.model==='z-image'?60:40}" value="${d.steps}" ${model?.fixed_steps?'readonly':''}></label>${d.model==='z-image'?`<label>CFG / 提示词引导<input data-field="cfg" type="number" min="1" max="20" step="0.5" value="${d.cfg}"></label>`:''}${card.type==='video'?`<label>时长 / 秒<input data-field="duration" type="number" min="1" max="15" step="1" value="${d.duration}"></label>`:`<label>重绘强度<input data-field="denoise" type="number" min="0.01" max="1" step="0.05" value="${d.denoise}" ${card.mode==='text'?'disabled':''}></label>`}</div><label>种子 <small>−1 为随机</small><input data-field="seed" type="number" min="-1" max="9007199254740991" value="${d.seed}"></label><button class="generate" ${unsupported?'disabled':''}>${unsupported?'当前模式暂不可生成':'生成'+(card.type==='image'?'图片':'视频')+' ↗'}</button><p class="card-feedback" role="status"></p></div></div>${['n','s','e','w','ne','nw','se','sw'].map(dir=>`<div class="resize-handle resize-${dir}" data-resize="${dir}"></div>`).join('')}`;
    el.insertAdjacentHTML('beforeend',cardPorts());
    if(model?.provider==='service-inference')el.querySelector('.generation-settings').innerHTML=cloudFields(card,model,d);
    arrangeGenerationCard(card,el);
    renderResults(card);renderLibrary(card);updateSizeFeedback(card);
  }
  function arrangeGenerationCard(card,el){
    el.classList.add('generation-workbench');
    const preview=el.querySelector('.card-content'),settings=el.querySelector('.generation-settings');
    const workspace=document.createElement('div');workspace.className='generation-workspace';
    preview.before(workspace);workspace.append(preview);
    preview.classList.add('generation-preview');preview.setAttribute('aria-label','生成结果与素材');
    const editor=document.createElement('section');editor.className='generation-editor';editor.setAttribute('aria-label','提示词与生成参数');
    workspace.append(editor);
    for(const child of [...preview.children])if(!child.matches('.card-results,.imported-library'))editor.append(child);
    const models=document.createElement('div');models.className='generation-models';editor.prepend(models);
    editor.querySelectorAll(':scope > .model-picker').forEach(label=>models.append(label));
    const notes=document.createElement('details');notes.className='generation-notes';notes.innerHTML='<summary>模型与生成说明</summary>';
    settings.querySelectorAll(':scope > .mode-note').forEach(note=>notes.append(note));
    if(notes.children.length>1)settings.append(notes);
    const parameters=settings.querySelector('.parameter-grid');
    const prompt=settings.querySelector('[data-field="prompt"]')?.closest('label');
    const mentions=settings.querySelector('.reference-mentions');
    if(parameters&&prompt)(mentions||prompt).after(parameters);
    const footer=document.createElement('div');footer.className='generation-submit';
    footer.innerHTML='<button type="button" class="quiet generation-size-link" data-edit-dimensions title="查看并调整输出尺寸"><span class="generation-size-summary"></span><small>调整尺寸 ↗</small></button>';
    footer.append(settings.querySelector('.generate'),settings.querySelector('.card-feedback'));
    workspace.after(footer);
    const toggle=document.createElement('button');toggle.type='button';toggle.className='quiet card-layout-toggle';toggle.dataset.cardLayout='';
    el.querySelector('.card-heading .remove-card').before(toggle);
    position(card,el);
  }
  function updateGenerationSummary(card){
    const el=document.querySelector(`[data-card="${card.id}"]`),output=el?.querySelector('.generation-size-summary');if(!output)return;
    const d=draft(card),model=state.models.find(m=>m.id===card.model);
    const size=model?.provider==='service-inference'?(card.type==='video'?`${d.resolution} · ${d.ratio}`:d.size):`${d.width} × ${d.height} px`;
    output.textContent=size+(card.type==='video'?` · ${d.duration} 秒`:'');
    el.querySelector('.generation-size-link').classList.toggle('size-invalid',!!checkSize(card));
  }
  function parameterSummary(body){const p=body.params;if(body.provider==='service-inference')return body.type==='image'?`分辨率 ${p.size}`:`${p.resolution} · ${p.ratio} · ${p.duration} 秒`;return `${p.width} × ${p.height} · ${p.steps} 步 · seed ${p.seed}`;}
  function cloudFields(card,model,d){
    const select=(key,label,values)=>`<label>${label}<select data-field="${key}">${values.map(v=>`<option value="${v}" ${d[key]===v?'selected':''}>${v}</option>`).join('')}</select></label>`;
    const refs=(key,label,rows=2)=>`<div class="cloud-ref-zone" data-cloud-field="${key}"><label>${label}<textarea data-field="${key}" rows="${rows}" placeholder="https://…">${esc(d[key]||'')}</textarea></label><button class="quiet" data-cloud-upload="${key}">＋ 选择文件直传 · 拖入 / 粘贴</button>${cloudRetries.get(card.id+':'+key)?.model===card.model&&cloudRetries.get(card.id+':'+key)?.mode===card.mode?`<button class="quiet" data-cloud-retry="${key}">重试上次直传 / 确认</button>`:''}<input hidden class="cloud-upload" data-cloud-field="${key}" type="file" accept="${key==='video_urls'?'video/mp4,video/webm':key==='audio_urls'?'audio/*':'image/png,image/jpeg,image/webp'}" ${rows>1?'multiple':''}></div>`;
    let html=`${model.available===false?'<p class="mode-note">当前 Key 的模型列表不包含此模型，请在设置中切换 Key 或重新选择模型。</p>':''}<p class="mode-note">${esc(model.note)}</p><label>提示词<textarea data-field="prompt" rows="3" placeholder="描述画面、镜头、光线与情绪…">${esc(d.prompt)}</textarea></label>`;
    if(card.mode!=='text'){
      const referenceKeys=model.type==='video'&&model.api_version==='v2'&&card.mode==='image'?['first_frame','last_frame']:['image_urls'];
      if(model.type==='video'&&card.mode==='reference')referenceKeys.push('video_urls','audio_urls');
      html+='<p class="reference-mention-help">选中提示词文字后点击素材替换为编号；也可在光标处插入。</p><div class="reference-mentions">'+referenceKeys.map(key=>`<div data-reference-field="${key}">${cloudReferenceMentions(d,key)}</div>`).join('')+'</div>';
      html+='<p class="mode-note">填写公网直链（每行一项），或选择文件直传到已配置的云存储。</p>';
      if(model.type==='video'&&model.api_version==='v2'&&card.mode==='image')html+=refs('first_frame','首帧图片 URL',1)+refs('last_frame','尾帧图片 URL（可选）',1);
      else html+=refs('image_urls',`参考图片 URL · 最多 ${model.ref_limit} 张（依填写顺序编号）`);
      if(model.type==='video'&&card.mode==='reference')html+=refs('video_urls','参考视频 URL · 最多 3 段')+refs('audio_urls','参考音频 URL · 最多 3 段');
    }
    if(model.type==='image'&&card.mode==='edit'&&model.image_api!=='openai')html+='<p class="mode-note">上传已圈选、涂鸦标记的图片，在提示词中说明编辑位置；也可填写 &lt;point&gt; 或 &lt;bbox&gt; 坐标标签。此处使用已有标记图，尚无内置画笔。</p>';
    if(model.type==='image'&&card.mode==='reference')html+='<p class="mode-note">至少两张参考图，提示词按上传顺序使用「图1」「图2」描述融合关系。</p>';
    if(model.type==='image'&&card.mode==='series')html+='<p class="mode-note">可不填参考图。模型根据提示词生成关联组图，实际张数可能少于上限；参考图 + 最多生成张数不能超过 15。</p>';
    html+='<div class="parameter-grid">';
    if(model.type==='image'){
      html+=select('size','图片分辨率',model.sizes)+select('output_format','输出格式',model.output_formats);
      if(model.optimize_modes.includes('fast'))html+=select('optimize_mode','提示词优化',model.optimize_modes);
      if(card.mode==='series')html+=`<label>最多生成张数<input data-field="max_images" type="number" min="1" max="15" step="1" value="${d.max_images}"></label>`;
      if(model.image_api==='openai')html+=select('quality','画质',model.qualities)+select('background','背景',['auto','opaque','transparent'])+`<label>生成张数<input data-field="n" type="number" min="1" max="10" step="1" value="${d.n}"></label><p class="mode-note">透明背景请选择 PNG 或 WebP。</p>`;
      else html+=`<label class="cloud-checkbox"><input data-field="watermark" type="checkbox" ${d.watermark?'checked':''}>AI 生成水印</label>`;
    }
    else{
      html+=select('resolution','视频分辨率',model.resolutions)+select('ratio','画面比例',['16:9','4:3','1:1','3:4','9:16','21:9',...(model.api_version==='v1'&&card.mode==='image'?['adaptive']:[])])+`<label>时长 / 秒<input data-field="duration" type="number" min="${model.min_duration||4}" max="${model.max_duration||15}" step="1" value="${d.duration}"></label>`;
      if(model.api_version==='v2')html+=`<label class="cloud-checkbox"><input data-field="generate_audio" type="checkbox" ${d.generate_audio?'checked':''}>生成音频</label>`;
    }
    return html+'</div><p class="mode-note">图片请求完成前请保持应用开启。提交后由云端计费并处理。结果按提交时选择保存到本机或云存储；在线版保存到云存储。视频可在重启后继续查询。云端接口暂不支持取消任务。</p><button class="generate" '+(model.available===false?'disabled':'')+'>生成'+(card.type==='image'?'图片':'视频')+' ↗</button><p class="card-feedback" role="status"></p>';
  }
  function videoFrameTools(url){
    return `<div class="video-frame-tools" data-frame-url="${esc(url)}" role="group" aria-label="视频提帧"><span class="frame-tools-caption">提帧</span><button class="quiet" data-extract-frame="last" title="提取视频最后一帧">最后一帧</button><span class="frame-tools-divider" aria-hidden="true"></span><div class="frame-time-group"><label class="frame-time-input"><input class="frame-seconds" type="number" min="0" step="0.1" value="0" aria-label="提取帧的秒数"><span>秒</span></label><button class="quiet" data-extract-frame="time" title="提取指定秒数的画面">按秒提取</button></div></div>`;
  }
  function videoMedia(url){
    return `<div class="video-preview"><video src="${esc(url)}" controls preload="metadata"></video></div>${videoFrameTools(url)}`;
  }
  async function extractFrame(source,button){
    if(importing)return;
    if(cards().length>=200){tell('当前画布最多 200 张卡片');return;}
    const project=state.project,bar=button.closest('.video-frame-tools');
    const last=button.dataset.extractFrame==='last',seconds=Number(bar.querySelector('.frame-seconds').value);
    if(!last&&(!Number.isFinite(seconds)||seconds<0||bar.querySelector('.frame-seconds').value==='')){tell('请输入有效的非负秒数');return;}
    importing=true;button.disabled=true;tell('正在读取视频帧…');
    const video=document.createElement('video');video.muted=true;video.preload='auto';
    const wait=(event,action)=>new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);video.removeEventListener(event,ok);video.removeEventListener('error',fail);error?reject(error):resolve();};
      const ok=()=>done(),fail=()=>done(Error('视频无法解码，请检查视频格式'));
      const timer=setTimeout(()=>done(Error('读取视频帧超时，请重试')),30000);
      video.addEventListener(event,ok,{once:true});video.addEventListener('error',fail,{once:true});try{action?.();}catch(error){done(error);}
    });
    try{
      await wait('loadedmetadata',()=>{video.src=bar.dataset.frameUrl;video.load();});
      if(!Number.isFinite(video.duration)||video.duration<=0)throw Error('无法确定视频时长');
      if(!last&&seconds>video.duration)throw Error(`秒数不能超过视频时长 ${video.duration.toFixed(3)} 秒`);
      const target=Math.min(last?video.duration:seconds,Math.max(0,video.duration-0.001));
      if(target!==video.currentTime)await wait('seeked',()=>{video.currentTime=target;});
      if(video.readyState<2)await wait('loadeddata');
      if(!video.videoWidth||!video.videoHeight)throw Error('视频没有可提取的画面');
      const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('图片编码失败')),'image/png'));
      const asset=await uploadMedia(new File([blob],`frame-${last?'last':seconds+'s'}.png`,{type:'image/png'}));
      if(state.project!==project)throw Error('项目已切换，已停止添加帧');
      const card={id:uid(),type:'asset',mode:'media',asset_id:asset.id,name:asset.name,mime:asset.mime,size:asset.size,x:Math.max(...cards().map(c=>c.x+c.w))+80,y:source.y,w:420,h:360};
      cards().push(card);renderCanvas();const v=project.body.canvas.viewport;v.x=40-card.x*v.zoom;v.y=40-card.y*v.zoom;transform();changed();await save();tell('已提取为图片素材卡片，可连线用于下一次生成');
    }catch(error){tell(error.message);}
    finally{video.pause();video.removeAttribute('src');video.load();importing=false;button.disabled=false;}
  }
  function jobMedia(row,index=0,mini=false,frames=true) {
    const url = `/api/outputs/${row.block_id}/${index}`;
    return row.body.type === 'video' ? (!mini&&frames?videoMedia(url):`<video src="${url}" ${mini?'preload="none"':'controls preload="metadata"'}></video>`) : `<img src="${url}" data-preview="${url}" data-preview-title="${esc(row.body.model)} · ${date(row.createtime)}" ${mini?'':'role="button" tabindex="0"'} title="${mini?'点击切换当前图片':'点击放大预览'}" alt="生成图片" loading="lazy">`;
  }
  function formatDuration(milliseconds){
    if(milliseconds==null||!Number.isFinite(milliseconds))return '待返回';
    const seconds=Math.max(0,Math.floor(milliseconds/1000));
    const days=Math.floor(seconds/86400),hours=Math.floor(seconds/3600)%24,minutes=Math.floor(seconds/60)%60;
    if(days)return `${days}天 ${hours}小时 ${minutes}分钟 ${seconds%60}秒（${seconds}秒）`;
    if(seconds>=3600)return `${hours}小时 ${minutes}分钟 ${seconds%60}秒（${seconds}秒）`;
    if(seconds>=60)return `${minutes}分钟 ${seconds%60}秒（${seconds}秒）`;
    return `${seconds}秒`;
  }
  function elapsedText(start){return formatDuration(Date.now()-start);}
  function updateElapsedClocks(){
    const clocks=state.project?[...document.querySelectorAll('.generation-elapsed')]:[];
    for(const clock of clocks)clock.textContent='已等待 '+elapsedText(Number(clock.dataset.started));
    if(clocks.length&&!elapsedTicker)elapsedTicker=setInterval(updateElapsedClocks,1000);
    if(!clocks.length&&elapsedTicker){clearInterval(elapsedTicker);elapsedTicker=null;}
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateElapsedClocks();});
  const pinEvents=new WeakMap();
  function pinVideos(card){return [...document.querySelectorAll(`[data-card="${card.id}"] .pinned-results video`)];}
  function pinAction(video,event,action){const expected=pinEvents.get(video)||new Set();expected.add(event);pinEvents.set(video,expected);try{const result=action();if(result?.catch)result.catch(()=>{expected.delete(event);tell('部分视频暂不能播放，请等待加载后再点击播放。');});}catch(error){expected.delete(event);tell(error.message);}}
  function alignPin(video,time){if(video.readyState<1){video.addEventListener('loadedmetadata',()=>{if(video.isConnected)alignPin(video,time);},{once:true});return;}const target=Math.min(time,Number.isFinite(video.duration)?video.duration:time);if(Math.abs(video.currentTime-target)>.08)pinAction(video,'seeking',()=>{video.currentTime=target;});}
  function startPins(card){for(const video of pinVideos(card)){alignPin(video,0);if(video.paused)pinAction(video,'play',()=>video.play());}}
  for(const event of ['play','pause','seeking','ratechange'])$('#canvas-world').addEventListener(event,e=>{
    const source=e.target;if(!state.project||!source.isConnected||source.tagName!=='VIDEO'||!source.closest('.pinned-results'))return;
    const expected=pinEvents.get(source);if(expected?.has(event)){expected.delete(event);return;}
    const card=cardById(source.closest('[data-card]').dataset.card);if(!card?.syncPinPlayback)return;
    if(event==='pause'&&source.ended)return;
    for(const video of pinVideos(card)){if(video===source)continue;
      if(event==='play'||event==='seeking')alignPin(video,source.currentTime);
      if(event==='play'&&video.paused&&(!Number.isFinite(video.duration)||source.currentTime<video.duration))pinAction(video,'play',()=>video.play());
      if(event==='pause'&&!video.paused)pinAction(video,'pause',()=>video.pause());
      if(event==='ratechange'&&video.playbackRate!==source.playbackRate)pinAction(video,'ratechange',()=>{video.playbackRate=source.playbackRate;});
    }
  },true);
  function cloudPhase(body) {
    const p=body.progress || {}, destination=body.output_storage==='cloud'?'云存储':'本机';
    if(body.error)return body.error;
    const phases={preparing:'云端正在准备参考素材',pending:'云端排队中',processing:'云端生成中',
      downloading:'正在保存生成结果到'+destination,reading_output:'正在读取生成结果，准备转存云存储',
      fetching_output:'云存储正在直接抓取生成视频',uploading_output:'正在上传生成结果到云存储',verifying_output:'正在校验云存储结果'};
    let text=phases[body.remote_status] || (body.status==='submitting'?'正在提交到云端':'等待云端返回结果');
    if(p.phase==='remote') {
      const stages={downloading:'读取参考素材',uploading:'上传参考素材',validating:'校验参考素材',preparing:'处理参考素材',processing:'生成',pending:'排队'};
      if(stages[p.stage])text+=' · '+stages[p.stage];
      if(Number.isFinite(p.value)&&p.maximum>0)text+=` · ${p.value} / ${p.maximum}（${Math.floor(p.value/p.maximum*100)}%）`;
      else if(body.remote_status==='preparing')text+=' · 上游尚未提供逐项进度';
      if(p.checked_at)text+=' · 最近查询 '+new Date(p.checked_at).toLocaleTimeString();
    }
    if(p.phase==='saving'&&p.item)text+=` · 第 ${p.item} / ${p.maximum} 个结果`;
    if(p.bytes)text+=` · ${body.remote_status==='uploading_output'?'已发送':'已读取'} ${(p.bytes/1024/1024).toFixed(1)} MB${p.total_bytes?' / '+(p.total_bytes/1024/1024).toFixed(1)+' MB':''}`;
    return text+'…';
  }
  function renderResults(card, progressOnly=false) {
    const el = document.querySelector(`[data-card="${card.id}"] .card-results`); if (!el) return;
    const scroller = el.closest('.card-content'), scrollTop = scroller.scrollTop;
    const detailScroll = el.querySelector('.history-details')?.scrollTop || 0;
    const allRows = state.history.filter(h => h.body.card_id === card.id);
    const hidden = new Set(card.hiddenJobs || []);
    const rows = allRows.filter(h=>!hidden.has(h.block_id));
    const hiddenRows = allRows.filter(h=>hidden.has(h.block_id));
    const selected = rows.find(h => h.block_id === card.selected) || rows[0];
    const pins = (card.pins || []).map(id=>rows.find(h=>h.block_id===id)).filter(h=>h?.body.outputs.length);
    const labels = {completed:'已完成',failed:'失败',submitting:'提交中',queued:'排队中',running:'生成中',stopping:'正在停止',cancelled:'已停止'};
    const activeRows = allRows.filter(h=>['submitting','queued','running','stopping'].includes(h.body.status));
    const active = activeRows.find(h=>['running','stopping'].includes(h.body.status)) || activeRows.at(-1);
    const stopButton = job => job.body.provider==='service-inference'?'<small>云端任务不支持取消</small>':`<button class="quiet stop-generation" data-cancel-job="${job.block_id}" ${stoppingJobs.has(job.block_id)||['submitting','stopping'].includes(job.body.status)?'disabled':''}>${job.body.status==='stopping'||stoppingJobs.has(job.block_id)?'正在停止…':job.body.status==='submitting'?'提交中…':job.body.status==='queued'?'取消排队':'停止生成'}</button>`;
    const p = active?.body.progress;
    const samplerNodes=state.models.find(m=>m.id===active?.body.model)?.sampler_nodes || [active?.body.type==='image'?'8':'11'];
    const sampler = active && samplerNodes.includes(String(p?.node));
    const determinate = (active?.body.provider==='service-inference' ? p?.phase==='remote' : sampler && p?.phase==='sampling') && Number.isFinite(p?.value) && p.maximum>0 && p.value<=p.maximum;
    const percent = determinate ? Math.floor(p.value/p.maximum*100) : null;
    const phase = active?.body.provider==='service-inference' ? cloudPhase(active.body) : active?.body.status==='stopping' ? '已请求停止，等待模型释放当前任务…' : p?.phase==='unavailable' ? '进度暂不可用，正在等待结果' : determinate ? `${samplerNodes.length>1?'阶段 '+(samplerNodes.indexOf(String(p.node))+1)+'/'+samplerNodes.length+' · ':''}采样 ${p.value} / ${p.maximum} · ${percent}%` : sampler && p?.value>=p?.maximum && samplerNodes.indexOf(String(p.node))<samplerNodes.length-1 ? '第一阶段采样完成，正在放大…' : p?.phase==='finishing' || (sampler && p?.value>=p?.maximum) ? '采样完成，正在处理输出…' : active?.body.status==='submitting' ? '正在提交…' : active?.body.status==='queued' ? '排队等待生成…' : '正在生成 / 加载模型或处理媒体…';
    const progress = active ? `<div class="generation-progress"><div class="generation-status"><span title="${esc(phase)}">${esc(phase)}</span><span class="generation-elapsed" data-started="${Number(active.body.submitted_at || active.createtime)}" title="从任务提交开始累计，包含排队、加载和生成时间">已等待 ${elapsedText(Number(active.body.submitted_at || active.createtime))}</span>${stopButton(active)}</div><progress max="100" ${determinate?`value="${percent}"`:''} aria-label="${esc(phase)}"></progress>${activeRows.length>1?`<details class="generation-queue"><summary>本卡片还有 ${activeRows.length-1} 个任务</summary><div>${activeRows.filter(h=>h!==active).map(h=>`<div><span>${esc(labels[h.body.status])} · ${h.block_id.slice(0,6)}</span>${stopButton(h)}</div>`).join('')}</div></details>`:''}</div>` : '';
    const progressEl=el.closest('[data-card]').querySelector('.card-progress');
    const queueOpen=progressEl.querySelector('.generation-queue')?.open;
    progressEl.innerHTML=progress;
    if(queueOpen&&progressEl.querySelector('.generation-queue'))progressEl.querySelector('.generation-queue').open=true;
    updateElapsedClocks();
    if(progressOnly)return;
    const savedPins=new Map([...el.querySelectorAll('[data-pinned-job]')].map(node=>[node.dataset.pinnedJob,{node,playing:!node.querySelector('video')?.paused}]));
    el.innerHTML = `<div class="result-stage">${selected?.body.outputs.length ? jobMedia(selected,0,false,false) : `<div class="result-placeholder"><span>${card.type==='image'?'◧':'▷'}</span><p>${selected ? esc(selected.body.provider==='service-inference'&&['submitting','queued','running'].includes(selected.body.status)?cloudPhase(selected.body):(labels[selected.body.status] || selected.body.status)) : '你的下一帧，从这里诞生'}</p></div>`}</div>${selected?.body.type==='image'&&selected.body.outputs.length>1?`<div class="group-output-heading">组图 · ${selected.body.outputs.length} 张，点击查看</div><div class="group-outputs">${selected.body.outputs.map((_,i)=>`<div>${jobMedia(selected,i,false,false)}<small>第 ${i+1} 张</small></div>`).join('')}</div>`:''}${selected?.body.type==='video'&&selected.body.outputs.length?videoFrameTools(`/api/outputs/${selected.block_id}/0`):''}${selected?.body.outputs.length?`<label class="hide-result"><input type="checkbox" data-hide-job="${selected.block_id}"> 隐藏当前生成结果</label>`:''}<div class="pin-toolbar"><span>PIN / 对比位</span>${card.type==='video'?`<label class="sync-pins-label" title="至少固定两个视频；联动播放、暂停、进度和倍速"><input type="checkbox" class="sync-pins" ${card.syncPinPlayback?'checked':''} ${pins.length<2?'disabled':''}> 同时播放</label>`:''}<input class="pin-limit" aria-label="对比位数量" type="number" min="0" max="8" value="${card.pinLimit ?? 2}"><button class="quiet pin-current" ${selected?.body.outputs.length?'':'disabled'}>＋ 固定当前</button></div>${pins.length?`<div class="pinned-results">${pins.map(h=>`<div data-pinned-job="${h.block_id}">${jobMedia(h,0,false,false)}<button class="quiet" data-unpin="${h.block_id}" title="取消固定">✕</button></div>`).join('')}</div>`:''}<div class="history-heading"><span>生成历史 / ${rows.length}</span><small>最新在左</small></div><div class="history-cost-summary">${esc(costTotals(allRows))} · 云端费用未知 ${allRows.filter(h=>h.body.provider==='service-inference'&&!h.body.cost).length} 条（含隐藏记录）</div><div class="history-strip">${rows.map(h=>`<button data-history="${h.block_id}" class="${h===selected?'selected':''}" title="${esc(labels[h.body.status])} · ${date(h.createtime)}">${h.body.outputs.length?jobMedia(h,0,true):`<span>${esc(labels[h.body.status])}</span>`}</button>`).join('') || '<small>还没有生成记录</small>'}</div><details class="hidden-history" ${card.hiddenOpen?'open':''}><summary>已隐藏 / ${hiddenRows.length}</summary><div class="hidden-items">${hiddenRows.map(h=>`<div class="hidden-item">${jobMedia(h,0,false,false)}<small>${esc(h.body.model)} · ${date(h.createtime)}</small><button data-restore-job="${h.block_id}">恢复到生成历史</button></div>`).join('')||'<p>没有隐藏的结果</p>'}</div></details><details class="history-details" ${card.detailsOpen?'open':''}><summary>生成信息${selected?' · '+esc(labels[selected.body.status]):''}</summary>${selected?`<dl><dt>模型</dt><dd>${esc(selected.body.model)}</dd><dt>创建时间</dt><dd>${date(selected.createtime)}</dd><dt>参数</dt><dd>${esc(parameterSummary(selected.body))}</dd>${selected.body.model==='z-image'?`<dt>CFG</dt><dd>${selected.body.params.cfg ?? 4}</dd><dt>反向提示词</dt><dd>${esc(selected.body.params.negative_prompt || '未填写')}</dd>`:''}<dt>耗时</dt><dd title="${selected.body.elapsed_ms!=null?esc(selected.body.elapsed_ms+' 毫秒'):''}">${formatDuration(selected.body.elapsed_ms)}</dd><dt>费用</dt><dd>${esc(costText(selected.body))}${selected.body.provider==='service-inference'&&selected.body.type==='video'&&selected.body.remote_task_id?` <button class="quiet query-cost" data-cost-job="${selected.block_id}" ${['submitting','queued','running'].includes(selected.body.status)?'disabled':''}>查询费用</button>`:''}</dd><dt>Tokens / 用量</dt><dd>${selected.body.usage.tokens ?? '未提供'}</dd><dt>提示词</dt><dd>${esc(selected.body.params.prompt)}</dd>${selected.body.provider==='service-inference'?`<dt>使用 Key</dt><dd>${esc(selected.body.credential_name||'原有 Key')}</dd><dt>结果保存位置</dt><dd>${esc(selected.body.output_storage==='cloud'?'云存储 · '+(selected.body.storage_profile_name||'已选配置'):'本机')}</dd><dt>云端任务 ID</dt><dd>${esc(selected.body.remote_task_id||'同步图片请求')}</dd><dt>服务用量</dt><dd>${esc(JSON.stringify(selected.body.usage))}</dd><dt>参考 URL</dt><dd>${esc(['first_frame','last_frame','image_urls','video_urls','audio_urls'].map(k=>selected.body.params[k]||'').filter(Boolean).join('\n')||'无')}</dd>`:''}${selected.body.error?`<dt>错误</dt><dd>${esc(selected.body.error)}</dd>`:''}</dl><div class="history-materials-heading">本次使用素材 · ${(selected.body.refs || []).length}</div>${historyMaterials(selected.body)}<button class="quiet reuse-params" data-job="${selected.block_id}">复用这次参数</button>`:'<p>选择一条历史查看模型、参数和用量。</p>'}</details>`;
    for(const node of el.querySelectorAll('[data-pinned-job]')){const previous=savedPins.get(node.dataset.pinnedJob);if(previous){node.replaceWith(previous.node);const video=previous.node.querySelector('video');if(previous.playing&&video?.paused)pinAction(video,'play',()=>video.play());}}
    scroller.scrollTop = scrollTop;
    el.querySelector('.history-details').scrollTop = detailScroll;
  }
  async function pollHistory() {
    clearTimeout(state.polling);
    const projectId = state.project?.block_id; if (!projectId) return;
    try {
      const response = await request('/api/projects/'+projectId+'/history');
      const rows = response.history;
      reorderAvailable=!!response.reorder_available;
      if (state.project?.block_id !== projectId) return;
      if (JSON.stringify(rows)!==JSON.stringify(state.history)) {
        const stable = list => JSON.stringify(list.map(row=>({...row,body:{...row.body,progress:undefined}})));
        const progressOnly = stable(rows)===stable(state.history);
        state.history=rows;for(const card of cards())renderResults(card,progressOnly);if(!progressOnly){renderLibraries();window.dispatchEvent(new Event('director-materials-ready'));}
      }
      renderQueue();renderSpending();
    } catch(error) {tell(error.message);}
    if(state.project?.block_id===projectId)state.polling=setTimeout(pollHistory,state.history.some(h=>['submitting','queued','running','stopping'].includes(h.body.status))?1000:5000);
  }
  function costText(body){return body.cost ? `${body.cost.currency} ${body.cost.amount}（${body.cost.source==='provider_log'?'控制台账单':'服务返回'}）` : body.provider==='service-inference'?'费用未提供':'本地生成 · 未统计电费/设备成本';}
  function costTotals(rows){
    const totals=new Map();
    for(const h of rows){const c=h.body.cost;if(!c)continue;const n=Number(c.amount);if(Number.isFinite(n))totals.set(c.currency,(totals.get(c.currency)||0)+n);}
    return totals.size ? '已知费用 '+[...totals].map(([c,n])=>`${c} ${n.toFixed(6).replace(/0+$/,'').replace(/\.$/,'')}`).join(' / ') : '暂无已知费用';
  }
  const spending=document.createElement('dialog');spending.id='spending-dialog';
  spending.innerHTML='<div class="dialog-heading"><h2>历史生成 · 费用汇总</h2><button class="quiet spending-close" aria-label="关闭">✕</button></div><p>当前项目全部生成记录，包含已隐藏结果和已移除卡片的历史。按币种分别汇总服务返回的费用；未提供费用的记录不计为零元。本地生成的电费和设备成本未统计。</p><div class="spending-actions"><a href="https://console.service-inference.ai/logs" target="_blank" rel="noopener">打开服务商日志</a><button class="quiet" id="spending-import">导入费用账单</button><input hidden type="file" id="spending-file" accept=".ndjson,.jsonl"><small>在控制台「下载 → NDJSON」，按视频任务 ID 精确回填费用；新图片按请求 ID 匹配。</small></div><div class="spending-filters"><label>查询<input id="spending-search" placeholder="模型、Key、提示词、任务 ID"></label><label>类型<select id="spending-type"><option value="">全部</option><option value="video">视频</option><option value="image">图片</option></select></label><label>状态<select id="spending-status"><option value="">全部</option><option value="completed">已完成</option><option value="failed">失败</option><option value="running">生成中</option><option value="queued">排队中</option><option value="submitting">提交中</option><option value="cancelled">已停止</option></select></label><label>开始日期<input type="date" id="spending-from"></label><label>结束日期<input type="date" id="spending-to"></label></div><p id="spending-summary" aria-live="polite"></p><div id="spending-models"></div><div class="spending-table"><table><thead><tr><th>创建时间</th><th>模型 / Key</th><th>状态 / 参数</th><th>费用</th><th>操作</th></tr></thead><tbody id="spending-rows"></tbody></table></div><p id="spending-notice" role="status"></p>';
  $('#studio').append(spending);
  const spendingButton=document.createElement('button');spendingButton.className='quiet';spendingButton.textContent='生成记录 / 费用汇总';$('.canvas-bottom').prepend(spendingButton);
  spendingButton.onclick=async()=>{spending.showModal();renderSpending();await pollHistory();};
  spending.querySelector('.spending-close').onclick=()=>spending.close();
  $('#spending-import').onclick=()=>$('#spending-file').click();
  $('#spending-file').onchange=async event=>{
    const file=event.target.files[0];event.target.value='';if(!file)return;
    const projectId=state.project?.block_id;if(!projectId)return;
    const button=$('#spending-import');button.disabled=true;
    try{if(file.size>5*1024*1024)throw Error('账单文件需小于 5 MB');const r=await request(`/api/projects/${projectId}/cost-import`,{text:await file.text()});if(state.project?.block_id!==projectId)return;$('#spending-notice').textContent=r.message;await pollHistory();}
    catch(error){if(state.project?.block_id===projectId)$('#spending-notice').textContent=error.message;}
    finally{button.disabled=false;}
  };
  spending.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',renderSpending));
  function renderSpending(){
    if(!spending.open)return;
    const search=$('#spending-search').value.trim().toLowerCase(),type=$('#spending-type').value,status=$('#spending-status').value;
    const from=$('#spending-from').value,to=$('#spending-to').value;
    const day=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
    const rows=state.history.filter(h=>{const b=h.body,d=day(h.createtime);return (!type||b.type===type)&&(!status||b.status===status)&&(!from||d>=from)&&(!to||d<=to)&&(!search||[b.model,b.credential_name,b.params?.prompt,b.remote_task_id,h.block_id].join(' ').toLowerCase().includes(search));});
    const unknown=rows.filter(h=>h.body.provider==='service-inference'&&!h.body.cost).length;
    $('#spending-summary').textContent=`筛选结果 ${rows.length} / ${state.history.length} 条 · ${costTotals(rows)} · 云端费用未知 ${unknown} 条`;
    const grouped=new Map();for(const h of rows){const model=h.body.model;if(!grouped.has(model))grouped.set(model,[]);grouped.get(model).push(h);}
    $('#spending-models').innerHTML=[...grouped].map(([model,jobs])=>`<p>${esc(state.models.find(m=>m.id===model)?.name||model)} · ${jobs.length} 条 · ${esc(costTotals(jobs))}</p>`).join('');
    const labels={completed:'已完成',failed:'失败',running:'生成中',queued:'排队中',submitting:'提交中',cancelled:'已停止',stopping:'正在停止'};
    $('#spending-rows').innerHTML=rows.map(h=>{const b=h.body;return `<tr><td>${date(h.createtime)}<small>${esc(b.remote_task_id||h.block_id)}</small></td><td>${esc(state.models.find(m=>m.id===b.model)?.name||b.model)}<small>${esc(b.credential_name||'本地')}</small></td><td>${esc(labels[b.status]||b.status)}<small>${esc(parameterSummary(b))}</small></td><td>${esc(costText(b))}${b.cost?.effective_per_1m_tokens?`<small>本次折算单价 ${esc(b.cost.currency)} ${Number(b.cost.effective_per_1m_tokens).toFixed(4)} / 百万视频 Tokens</small>`:''}</td><td>${b.provider==='service-inference'&&b.type==='video'&&b.remote_task_id?`<button class="quiet query-cost" data-cost-job="${h.block_id}" ${['submitting','queued','running'].includes(b.status)?'disabled':''}>查询费用</button>`:''}</td></tr>`;}).join('')||'<tr><td colspan="5">没有符合条件的生成记录</td></tr>';
  }
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-cost-job]');if(!button)return;
    const projectId=state.project?.block_id;button.disabled=true;
    try{const r=await request(`/api/generations/${button.dataset.costJob}/cost`,{});if(state.project?.block_id!==projectId)return;const h=state.history.find(h=>h.block_id===button.dataset.costJob);if(h&&r.cost)h.body.cost=r.cost;if(h)h.body.cost_checked_at=r.checked_at;for(const c of cards())renderResults(c);renderSpending();$('#spending-notice').textContent=r.message;tell(r.message);}
    catch(error){if(state.project?.block_id===projectId){$('#spending-notice').textContent=error.message;tell(error.message);}}
    finally{if(button.isConnected)button.disabled=false;}
  });
  function queueRows(){return state.history.filter(h=>['submitting','queued','running','stopping'].includes(h.body.status)).sort((a,b)=>{
    const rank=h=>h.body.status==='running'||h.body.status==='stopping'?0:h.body.queue_position?1:2;
    return rank(a)-rank(b)||(a.body.queue_position||0)-(b.body.queue_position||0)||a.createtime-b.createtime;
  });}
  function pendingQueue(){return queueRows().filter(h=>h.body.status==='queued'&&h.body.queue_position).map(h=>h.block_id);}
  function renderQueue(){
    const rows=queueRows();$('#queue-count').textContent=rows.length;
    $('#queue-notice').textContent=(rows.some(h=>h.body.provider==='service-inference')?'云端任务仅支持查看和定位，不支持取消或排序。':'')+(reorderAvailable?'拖动待执行任务调整顺序，也可用 ↑ ↓。其他项目或用户任务保留原队列位置。':'本地 ComfyUI 排序扩展尚未加载。');
    if(queueDrag)return;
    const pending=pendingQueue(),labels={running:'生成中',queued:'排队中',submitting:'提交中',stopping:'正在停止'};
    const html=rows.map(h=>{const b=h.body,index=pending.indexOf(h.block_id),movable=index>=0&&reorderAvailable&&!queueMoving;
      return `<article class="queue-item" data-queue-job="${h.block_id}" draggable="${movable}"><div class="queue-item-heading"><span>${movable?'⠿ ':''}${labels[b.status]}${b.queue_position?' · 第 '+b.queue_position+' 位':''}</span><code>${h.block_id.slice(0,6)}</code></div><strong>${esc(state.models.find(m=>m.id===b.model)?.name||b.model)}</strong><p>${esc(b.params.prompt)}</p><small>${esc(parameterSummary(b))}</small><div class="queue-actions"><button class="quiet" data-locate-card="${b.card_id}" ${cardById(b.card_id)?'':'disabled'}>定位卡片</button><button class="quiet" data-queue-stop="${h.block_id}" ${b.provider==='service-inference'||stoppingJobs.has(h.block_id)||['submitting','stopping'].includes(b.status)?'disabled':''}>${b.provider==='service-inference'?'云端不支持取消':b.status==='queued'?'取消排队':b.status==='stopping'?'正在停止':'停止生成'}</button><button class="quiet" data-queue-up="${h.block_id}" aria-label="上移任务" ${movable&&index>0?'':'disabled'}>↑</button><button class="quiet" data-queue-down="${h.block_id}" aria-label="下移任务" ${movable&&index<pending.length-1?'':'disabled'}>↓</button></div></article>`;
    }).join('')||'<div class="queue-empty">暂无排队任务<br><small>从画布卡片提交生成后会显示在这里。</small></div>';
    if($('#queue-items')._markup!==html){$('#queue-items').innerHTML=html;$('#queue-items')._markup=html;}
  }
  function toggleQueue(open){$('#queue-panel').hidden=!open;$('#toggle-queue').setAttribute('aria-expanded',String(open));}
  $('#toggle-queue').onclick=()=>toggleQueue($('#queue-panel').hidden);
  $('#close-queue').onclick=()=>toggleQueue(false);
  async function moveQueue(id,target){
    if(queueMoving||!reorderAvailable)return;
    const previous=pendingQueue(),order=[...previous],from=order.indexOf(id),to=order.indexOf(target);
    if(from<0||to<0||from===to)return;
    order.splice(from,1);order.splice(to,0,id);
    queueMoving=true;renderQueue();
    try{await request('/api/projects/'+state.project.block_id+'/queue-order',{order,previous});tell('执行顺序已更新');}
    catch(error){tell(error.message);}
    finally{queueMoving=false;await pollHistory();renderQueue();}
  }
  $('#queue-items').onclick=async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.locateCard){const card=cardById(button.dataset.locateCard);if(!card)return;const v=state.project.body.canvas.viewport;
      v.zoom=Math.min(1,Math.max(.15,($('#canvas').clientWidth-60)/card.w,0));v.x=30-card.x*v.zoom;v.y=30-card.y*v.zoom;transform();changed();return;}
    if(button.dataset.queueStop){const id=button.dataset.queueStop;if(stoppingJobs.has(id))return;stoppingJobs.add(id);renderQueue();
      try{await request('/api/generations/'+id+'/cancel',{});await pollHistory();}catch(error){tell(error.message);}finally{stoppingJobs.delete(id);renderQueue();}return;}
    const id=button.dataset.queueUp||button.dataset.queueDown,order=pendingQueue(),index=order.indexOf(id);
    if(index>=0)await moveQueue(id,order[index+(button.dataset.queueUp?-1:1)]);
  };
  $('#queue-items').ondragstart=event=>{const item=event.target.closest('[data-queue-job]');if(!item||item.draggable!==true)return;queueDrag=item.dataset.queueJob;event.dataTransfer.setData('text/plain',queueDrag);event.dataTransfer.effectAllowed='move';};
  $('#queue-items').ondragover=event=>{if(queueDrag){event.preventDefault();event.dataTransfer.dropEffect='move';}};
  $('#queue-items').ondrop=event=>{if(!queueDrag)return;event.preventDefault();const id=queueDrag,target=event.target.closest('[data-queue-job]')?.dataset.queueJob;queueDrag=null;moveQueue(id,target);};
  $('#queue-items').ondragend=()=>{queueDrag=null;renderQueue();};
  function cardName(card) {
    return card.title?.trim() || (card.type==='asset'||card.type==='chat' ? card.name : '') || ({image:'图片生成',video:'视频生成',chat:'评论区',asset:'素材'}[card.type]+' · '+card.id.slice(0,6).toUpperCase());
  }
  function describeMedia(media) {
    const candidates=commentMaterials().filter(m=>m.source===media.source && (m.source==='url'?m.url===media.url:m.id===media.id) && (m.source!=='output'||m.index===media.index));
    return candidates[0] || null;
  }
  async function renameCard(card) {
    const project=state.project;
    if(window.directorPublicShare||(project.permission&&!['owner','admin','editor'].includes(project.permission.role)))return;
    const name=await window.directorDialogs.prompt('为卡片起一个好辨认的名字，例如「镜头 02 · 书房采访」。留空恢复默认名称。',{title:'重命名卡片',value:card.title||''});
    if(name===null||state.project!==project||!cards().includes(card))return;
    if(name.trim().length>160){tell('卡片名称最多 160 个字符');return;}
    card.title=name.trim();
    for(const clip of [project.body.canvas.timeline,...(project.body.canvas.timelines||[])].flatMap(t=>t?.clips||[])){const source=describeMedia(clip.media);if(source)clip.source_name=source.name;}
    const heading=document.querySelector(`[data-card="${card.id}"] .card-heading strong`);
    if(heading){heading.textContent=cardName(card);heading.title=cardName(card);}
    changed();renderLibraries();window.directorTimeline?.render();
  }
  $('#canvas-world').addEventListener('click',event=>{const button=event.target.closest('.rename-card');if(button){const card=cardById(button.closest('[data-card]').dataset.card);renameCard(card).catch(e=>tell(e.message));}});
  function commentMaterials(target) {
    const result=[];
    for(const card of cards())if(card.type==='asset'&&/^(image|video)\//.test(card.mime))result.push({source:card.storage==='cloud'?'cloud':'asset',id:card.asset_id,url:card.storage==='cloud'?card.url:'/api/assets/'+card.asset_id,mime:card.mime,name:cardName(card)});
    for(const job of state.history.filter(h=>h.body.status==='completed'&&cards().some(c=>c.id===h.body.card_id)))for(const [index] of job.body.outputs.entries())result.push({source:'output',id:job.block_id,index,url:'/api/outputs/'+job.block_id+'/'+index,mime:job.body.type==='image'?'image/png':'video/mp4',name:cardName(cardById(job.body.card_id))+' · '+date(job.createtime)+' · 结果 '+(index+1)+' ['+job.block_id.slice(0,6).toUpperCase()+']'});
    for(const card of cards())if(card.type==='chat'&&card.id!==target?.id)for(const a of window.directorComments.outputs(card.chat_id))result.push({...a,name:cardName(card)+' · '+a.commentLabel+' · '+a.name+(a.review?.kind==='video'?' · 原片 '+a.review.start.toFixed(2)+'–'+a.review.end.toFixed(2)+' s':'')});
    if(target){const linked=upstreamMaterials(target).filter(m=>m.attachment).map(m=>({...m.attachment,name:'已关联 · '+m.name}));return [...linked,...result];}
    return result;
  }
  async function addChat() {
    if(cards().length>=200)throw Error('当前画布最多 200 张卡片');
    const project=state.project;await save();const id=uid();
    await request('/api/projects/'+project.block_id+'/chats',{chat_id:id,batch_size:50});
    if(state.project!==project)return;
    const v=project.body.canvas.viewport;
    const card={id:uid(),chat_id:id,name:'评论区',type:'chat',mode:'chat',x:(50-v.x)/v.zoom,y:(40-v.y)/v.zoom,w:560,h:Math.max(520,Math.min(820,($('#canvas').clientHeight-60)/v.zoom))};
    if(cards().length)card.x=Math.max(...cards().map(c=>c.x+c.w))+80;
    cards().push(card);renderCanvas();changed();await save();
    v.x=40-card.x*v.zoom;v.y=30-card.y*v.zoom;transform();changed();
  }
  function addCard(type) {
    if(cards().length>=200){tell('当前画布最多 200 张卡片');return;}
    const v=state.project.body.canvas.viewport;
    const nextX=cards().length ? Math.max(...cards().map(c=>c.x+c.w))+80 : (50-v.x)/v.zoom;
    const card={id:uid(),type,mode:'text',x:nextX,y:cards()[0]?.y ?? (40-v.y)/v.zoom,w:920,h:Math.max(520,Math.min(720,($('#canvas').clientHeight-80)/v.zoom)),drafts:{},pins:[],pinLimit:2};
    cards().push(card);draft(card);renderCanvas();changed();
  }
  for(const type of ['select','focusout','keyup','pointerup','input'])$('#canvas-world').addEventListener(type,rememberPromptSelection,true);
  $('#canvas-world').addEventListener('pointerdown',event=>{
    if(event.button!==0||!event.target.closest('[data-ref-mention]'))return;
    const input=document.activeElement;
    if(input?.matches('textarea[data-field="prompt"]')&&input.closest('[data-card]')===event.target.closest('[data-card]')){
      rememberPromptSelection({target:input});event.preventDefault();
    }
  },true);
  $('#canvas-world').addEventListener('input',event=>{
    const el=event.target.closest('[data-card]');if(!el)return;const card=cardById(el.dataset.card);
    if(event.target.dataset.field && event.target.dataset.field!=='model'){const key=event.target.dataset.field;draft(card)[key]=event.target.type==='checkbox'?event.target.checked:['model','prompt','negative_prompt','size','resolution','ratio','image_urls','video_urls','audio_urls','first_frame','last_frame','output_format','optimize_mode','quality','background'].includes(key)?event.target.value:Number(event.target.value);changed();updateGenerationSummary(card);if(['image_urls','video_urls','audio_urls','first_frame','last_frame'].includes(key))refreshReferenceMentions(card,el,key);if(['width','height'].includes(key))updateSizeFeedback(card);}
  });
  $('#canvas-world').addEventListener('change',async event=>{
    const el=event.target.closest('[data-card]');if(!el)return;const card=cardById(el.dataset.card);
    if(event.target.hasAttribute('data-credential')){
      card.credential_id=event.target.value;changed();renderCard(card);return;
    }
    if(event.target.dataset.field==='model'){
      const model=state.models.find(m=>m.id===event.target.value&&m.type===card.type);
      if(!model)return;
      card.model=model.id;
      const top=el.querySelector('.card-content').scrollTop,editorTop=el.querySelector('.generation-editor')?.scrollTop||0;
      renderCard(card);el.querySelector('.card-content').scrollTop=top;el.querySelector('.generation-editor').scrollTop=editorTop;
      el.querySelector('[data-field=model]').focus({preventScroll:true});changed();
    }
    if(event.target.dataset.hideJob){const id=event.target.dataset.hideJob;card.hiddenJobs=[...new Set([...(card.hiddenJobs||[]),id])];card.pins=(card.pins||[]).filter(p=>p!==id);if(card.selected===id)delete card.selected;renderResults(card);changed();}
    if(event.target.classList.contains('sync-pins')){card.syncPinPlayback=event.target.checked;changed();if(card.syncPinPlayback)startPins(card);}
    if(event.target.classList.contains('pin-limit')){card.pinLimit=Math.max(0,Math.min(8,Number(event.target.value)||0));card.pins=(card.pins||[]).slice(0,card.pinLimit);changed();renderResults(card);}
    if(event.target.classList.contains('cloud-upload')){await addCloudReferences(card,event.target.dataset.cloudField,[...event.target.files]);return;}
    if(event.target.classList.contains('ref-upload')){await addReferences(card,[...event.target.files]);}
  });
  $('#canvas-world').addEventListener('toggle',event=>{if(event.target.isConnected&&event.target.classList.contains('hidden-history')){cardById(event.target.closest('[data-card]').dataset.card).hiddenOpen=event.target.open;}if(event.target.isConnected&&event.target.classList.contains('history-details')){const card=cardById(event.target.closest('[data-card]').dataset.card);card.detailsOpen=event.target.open;}},true);
  $('#canvas-world').addEventListener('click',async event=>{
    const button=event.target.closest('button'),el=event.target.closest('[data-card]');if(!button||!el)return;
    const card=cardById(el.dataset.card);
    if(button.hasAttribute('data-card-layout')){
      if(window.directorPublicShare||state.project?.permission&&!['owner','editor','admin'].includes(state.project.permission.role))return;
      card.w=card.w>=760?480:920;position(card,el);renderConnections();changed();return;
    }
    if(button.hasAttribute('data-edit-dimensions')){
      const target=el.querySelector('.parameter-grid');target?.scrollIntoView({block:'nearest',inline:'nearest'});
      target?.querySelector('input,select')?.focus({preventScroll:true});return;
    }
    if(button.dataset.refMention){insertReferenceMention(card,el,button.dataset.refMention);return;}
    if(button.classList.contains('copy-cloud-url')){try{await navigator.clipboard.writeText(card.url);tell('公网 URL 已复制');}catch(e){tell('复制失败：'+e.message);}return;}
    if(button.dataset.sizePreset){const [w,h]=button.dataset.sizePreset.split(',').map(Number);Object.assign(draft(card),{width:w,height:h});el.querySelector('[data-field=width]').value=w;el.querySelector('[data-field=height]').value=h;updateSizeFeedback(card);changed();return;}
    if(button.dataset.extractFrame){await extractFrame(card,button);return;}
    if(button.dataset.restoreJob){card.hiddenJobs=(card.hiddenJobs||[]).filter(id=>id!==button.dataset.restoreJob);card.selected=button.dataset.restoreJob;renderResults(card);changed();return;}
    if(button.dataset.disconnect){disconnect(button.dataset.disconnect);return;}
    if(button.dataset.cancelJob){
      const id=button.dataset.cancelJob;if(stoppingJobs.has(id))return;
      stoppingJobs.add(id);renderResults(card,true);
      try{await request('/api/generations/'+id+'/cancel',{});await pollHistory();}
      catch(error){tell(error.message);}
      finally{stoppingJobs.delete(id);if(state.project&&cardById(card.id))renderResults(card,true);}
      return;
    }
    if(button.dataset.cloudRetry){const retry=cloudRetries.get(card.id+':'+button.dataset.cloudRetry);if(retry)await addCloudReferences(card,button.dataset.cloudRetry,[retry.file]);return;}
    if(button.dataset.cloudUpload){button.closest('.cloud-ref-zone').querySelector('input').click();return;}
    if(button.dataset.useMaterial){await useMaterial(card,button.dataset.useMaterial);return;}
    if(button.classList.contains('choose-ref'))el.querySelector('.ref-upload').click();
    if(button.dataset.mode){if(!state.models.find(m=>m.id===card.model)?.modes.includes(button.dataset.mode))return;card.mode=button.dataset.mode;draft(card);renderCard(card);changed();}
    if(button.classList.contains('remove-card')){if(window.directorComments?.busy()){tell('请等待评论发送或上传完成');return;}const project=state.project;if(!await window.directorDialogs.confirm(card.type==='chat'?'移除此评论区卡片？评论记录仍会保留。':card.type==='asset'?'移除此素材卡片？':'移除此卡片？项目中的生成历史仍会保留。',{title:'移除卡片',acceptLabel:'移除卡片'}))return;if(state.project!==project||cardById(card.id)!==card)return;if(window.directorComments?.busy()){tell('请等待评论发送或上传完成');return;}state.project.body.canvas.connections=connections().filter(e=>e.source!==card.id&&e.target!==card.id);state.project.body.canvas.cards=cards().filter(c=>c.id!==card.id);renderCanvas();changed();}
    if(button.dataset.history){card.selected=button.dataset.history;card.detailsOpen=true;renderResults(card);changed();}
    if(button.dataset.unpin){card.pins=card.pins.filter(id=>id!==button.dataset.unpin);renderResults(card);changed();}
    if(button.classList.contains('pin-current')){const selected=card.selected||state.history.find(h=>h.body.card_id===card.id&&!(card.hiddenJobs||[]).includes(h.block_id))?.block_id;card.pins||=[];if(card.pins.includes(selected))return;if(card.pins.length>=(card.pinLimit??2)){tell('对比位已满，可增加数量或取消已有固定。');return;}card.pins.push(selected);renderResults(card);changed();}
    if(button.dataset.removeRef!==undefined){draft(card).refs.splice(Number(button.dataset.removeRef),1);renderCard(card);changed();}
    if(button.classList.contains('reuse-params')){const h=state.history.find(h=>h.block_id===button.dataset.job);card.model=h.body.model;card.mode=h.body.mode;card.drafts[card.mode]={...h.body.params,model:h.body.model,refs:[...h.body.refs],ref_info:h.body.ref_info||{}};renderCard(card);changed();}
    if(button.classList.contains('generate')){
      const dimensionError=updateSizeFeedback(card);if(dimensionError){el.querySelector('.size-help').scrollIntoView({block:'center'});tell(dimensionError);return;}
      button.disabled=true;const feedback=el.querySelector('.card-feedback');feedback.textContent='保存并提交…';
      const projectId=state.project.block_id, outputStorage=window.directorCloud||$('#asset-import-mode').value==='cloud'?'cloud':'local';
      try{await save();const row=await request(`/api/projects/${projectId}/generate`,{...structuredClone(draft(card)),card_id:card.id,credential_id:card.credential_id,mode:card.mode,request_id:uid(),output_storage:outputStorage});if(state.project?.block_id!==projectId)return;state.history.unshift(row);card.selected=row.block_id;changed();renderResults(card);feedback.textContent=row.body.error||(row.body.provider==='service-inference'?`已使用 AK「${row.body.credential_name||'原有 Key'}」提交到云端；结果会自动保存到${row.body.output_storage==='cloud'?'云存储'+(row.body.storage_profile_name?'（'+row.body.storage_profile_name+'）':''):'本机'}。`:'已提交到本地 ComfyUI，结果会自动出现。');}
      catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}
    }
  });
  $('#canvas').onpointerdown=event=>{
    if(event.button!==0&&event.button!==1)return;
    const cardEl=event.target.closest('[data-card]'),handle=event.target.closest('[data-resize]');
    const port=event.target.closest('[data-port]');
    if(port&&event.button===0){event.preventDefault();const c=cardById(cardEl.dataset.card);wireDrag={id:c.id,side:port.dataset.port,...portPoint(c,port.dataset.port)};$('#canvas').setPointerCapture(event.pointerId);renderConnections();return;}
    const heading=event.target.closest('.card-heading');
    if(cardEl&&!handle&&(!heading||event.target.closest('button')))return;
    if(!cardEl&&event.target!==$('#canvas')&&event.target!==$('#canvas-world'))return;
    event.preventDefault();
    const card=cardEl?cardById(cardEl.dataset.card):null;
    drag={px:event.clientX,py:event.clientY,card,el:cardEl,dir:handle?.dataset.resize,original:structuredClone(card||state.project.body.canvas.viewport)};
    $('#canvas').setPointerCapture(event.pointerId);if(cardEl)cardEl.style.zIndex=10;
  };
  $('#canvas').onpointermove=event=>{
    if(wireDrag){const v=state.project.body.canvas.viewport,r=$('#canvas').getBoundingClientRect();wireDrag.x=(event.clientX-r.left-v.x)/v.zoom;wireDrag.y=(event.clientY-r.top-v.y)/v.zoom;renderConnections();return;}
    if(!drag)return;const v=state.project.body.canvas.viewport,dx=(event.clientX-drag.px)/v.zoom,dy=(event.clientY-drag.py)/v.zoom,o=drag.original,c=drag.card;
    if(!c){v.x=o.x+event.clientX-drag.px;v.y=o.y+event.clientY-drag.py;transform();return;}
    if(!drag.dir){c.x=o.x+dx;c.y=o.y+dy;}else{
      if(drag.dir.includes('e'))c.w=Math.max(380,Math.min(3000,o.w+dx));
      if(drag.dir.includes('s'))c.h=Math.max(c.type==='asset'?200:520,Math.min(4000,o.h+dy));
      if(drag.dir.includes('w')){c.w=Math.max(380,Math.min(3000,o.w-dx));c.x=o.x+o.w-c.w;}
      if(drag.dir.includes('n')){c.h=Math.max(c.type==='asset'?200:520,Math.min(4000,o.h-dy));c.y=o.y+o.h-c.h;}
    }position(c,drag.el);renderConnections();
  };
  function finishDrag(){if(drag){if(drag.el)drag.el.style.zIndex='';drag=null;changed();}}
  $('#canvas').onpointerup=event=>{
    if(wireDrag){const port=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-port]'),start=wireDrag;wireDrag=null;
      if(port&&port.dataset.port!==start.side){const other=port.closest('[data-card]').dataset.card;connectCards(start.side==='output'?start.id:other,start.side==='output'?other:start.id);}
      renderConnections();return;
    }finishDrag();
  };
  $('#canvas').onpointercancel=()=>{wireDrag=null;renderConnections();finishDrag();};
  $('#canvas-world').addEventListener('dblclick',event=>{const line=event.target.closest('[data-edge]');if(line)disconnect(line.dataset.edge);});
  $('#canvas-world').addEventListener('keydown',event=>{
    if(event.key==='Escape'){wireDrag=null;keyboardPort=null;renderConnections();return;}
    const port=event.target.closest('[data-port]');if(!port||!['Enter',' '].includes(event.key))return;event.preventDefault();
    const selected={id:port.closest('[data-card]').dataset.card,side:port.dataset.port};
    if(keyboardPort&&keyboardPort.side!==selected.side){connectCards(selected.side==='input'?keyboardPort.id:selected.id,selected.side==='input'?selected.id:keyboardPort.id);keyboardPort=null;}
    else{keyboardPort=selected;tell('已选连接点，请聚焦另一张卡片的对应连接点并按 Enter');}
  });
  const zoomSensitivityKey='director-canvas-zoom-sensitivity';
  const zoomSensitivityOptions=[1,2,4,6,8,12,20];
  const desktopZoomPreference=!!window.directorDesktop?.isDesktop;
  let zoomSensitivity=6;
  try{
    // Desktop uses a new loopback port on launch; cookies survive that port change.
    const stored=desktopZoomPreference?document.cookie.split('; ').find(row=>row.startsWith(zoomSensitivityKey+'='))?.split('=')[1]:localStorage.getItem(zoomSensitivityKey);
    const saved=Number(stored);
    if(zoomSensitivityOptions.includes(saved))zoomSensitivity=saved;
  }catch{}
  $('#zoom-sensitivity').value=String(zoomSensitivity);
  $('#zoom-sensitivity').onchange=event=>{
    const value=Number(event.target.value);
    if(!zoomSensitivityOptions.includes(value))return;
    zoomSensitivity=value;
    try{
      if(desktopZoomPreference){
        document.cookie=zoomSensitivityKey+'='+value+'; Path=/; Max-Age=31536000; SameSite=Strict';
        if(!document.cookie.split('; ').includes(zoomSensitivityKey+'='+value))throw Error('Preference unavailable');
      }else localStorage.setItem(zoomSensitivityKey,String(value));
    }
    catch{tell('缩放灵敏度已生效，但当前浏览器无法保存设置。');}
  };
  function zoom(factor,px,py){const v=state.project.body.canvas.viewport,old=v.zoom;v.zoom=Math.max(.15,Math.min(3,old*factor));v.x=px-(px-v.x)*v.zoom/old;v.y=py-(py-v.y)*v.zoom/old;transform();changed();}
  $('#canvas').addEventListener('wheel',event=>{
    if(!state.project)return;
    if(event.target.closest('textarea')){
      // Keep native text scrolling, including at its boundaries; never pan/zoom here.
      if(event.ctrlKey||event.metaKey)event.preventDefault();
      return;
    }
    // Card content owns native scrolling; its padding also scrolls the outer card.
    if(!event.ctrlKey&&event.target.closest('.card-content,.generation-editor,.generation-submit,.asset-content,.imported-items,.ref-list,.history-strip,.pinned-results,.hidden-items'))return;
    event.preventDefault();
    const canvas=$('#canvas'),r=canvas.getBoundingClientRect();
    const unit=event.deltaMode===1?16:event.deltaMode===2?canvas.clientHeight:1;
    // Trackpad pinch is delivered as Ctrl+wheel; two-finger scrolling pans.
    if(event.ctrlKey){zoom(Math.exp(-event.deltaY*unit*.001*zoomSensitivity),event.clientX-r.left,event.clientY-r.top);return;}
    const v=state.project.body.canvas.viewport;
    v.x-=event.deltaX*(event.deltaMode===2?canvas.clientWidth:unit);
    v.y-=event.deltaY*unit;
    transform();changed();
  },{passive:false});
  $('#zoom-in').onclick=()=>zoom(1.2,$('#canvas').clientWidth/2,$('#canvas').clientHeight/2);
  $('#zoom-out').onclick=()=>zoom(1/1.2,$('#canvas').clientWidth/2,$('#canvas').clientHeight/2);
  $('#zoom-reset').onclick=()=>zoom(1/state.project.body.canvas.viewport.zoom,$('#canvas').clientWidth/2,$('#canvas').clientHeight/2);
  $('#fit-cards').onclick=()=>{if(!cards().length)return;const minX=Math.min(...cards().map(c=>c.x)),minY=Math.min(...cards().map(c=>c.y)),maxX=Math.max(...cards().map(c=>c.x+c.w)),maxY=Math.max(...cards().map(c=>c.y+c.h));const z=Math.max(.15,Math.min(1,($('#canvas').clientWidth-100)/(maxX-minX),($('#canvas').clientHeight-80)/(maxY-minY)));Object.assign(state.project.body.canvas.viewport,{zoom:z,x:50-minX*z,y:40-minY*z});transform();changed();};
  $('#export-draft').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(state.project,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=state.project.block_id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  $('#new-project').onclick=()=>openDialog();$('#edit-project').onclick=()=>openDialog(true);
  $('#studio-message').onclick=()=>tell('');
  $('#project-list').onclick=event=>{const tile=event.target.closest('[data-project]');if(tile)openProject(tile.dataset.project).catch(e=>tell(e.message));if(event.target.closest('#empty-create'))openDialog();};
  $('#project-search').oninput=renderProjects;
  $('#back-dashboard').onclick=()=>dashboard().catch(e=>tell(e.message));
  async function addReferences(card,files){
    if(importing)return;
    const project=state.project,d=draft(card),limit=referenceLimit(card);
    if(d.refs.length+files.length>limit){tell(`当前模式最多 ${limit} 项参考素材`);return;}
    importing=true;
    try{for(const file of files){checkRefCount(card,d,file.type);const asset=await uploadMedia(file);if(state.project!==project)throw Error('项目已切换，已停止添加参考素材');rememberRef(d,asset);d.refs.push(asset.id);changed();}renderCard(card);}
    catch(error){tell(error.message);if(state.project===project)renderCard(card);}
    finally{importing=false;}
  }
  async function importAssets(files,point){
    if(!state.project||importing)return;
    if(cards().length+files.length>200){tell('当前画布最多 200 张卡片');return;}
    const cloud=window.directorCloud||$('#asset-import-mode').value==='cloud';
    const project=state.project,v=project.body.canvas.viewport,r=$('#canvas').getBoundingClientRect();
    const x=point?(point.x-r.left-v.x)/v.zoom:cards().length?Math.max(...cards().map(c=>c.x+c.w))+80:(40-v.x)/v.zoom;
    const y=point?(point.y-r.top-v.y)/v.zoom:(40-v.y)/v.zoom;
    importing=true;$('#add-assets').disabled=true;
    try{
      for(let i=0;i<files.length;i++){
        tell(`正在导入 ${i+1}/${files.length}：${files[i].name}`);
        const asset=cloud?await window.directorStorage.uploadFile(files[i],tell,project.block_id,{index:i+1,total:files.length}):await uploadMedia(files[i]);
        if(state.project!==project)throw Error('项目已切换，已停止导入');
        const card={id:uid(),type:'asset',mode:'media',asset_id:asset.id,...(cloud?{storage:'cloud',url:asset.url,provider:asset.provider}:{}),name:asset.name,mime:asset.mime,size:asset.size,x:x+(i%3)*500,y:y+Math.floor(i/3)*400,w:420,h:asset.mime.startsWith('audio/')?240:360};
        cards().push(card);const el=document.createElement('article');el.className='generation-card';el.dataset.card=card.id;$('#canvas-world').append(el);renderCard(card);changed();$('#canvas-empty').hidden=true;
      }
      if(!point){v.x=40-x*v.zoom;v.y=40-y*v.zoom;transform();changed();}
      tell('');await save();
    }catch(error){tell(error.message);}
    finally{importing=false;$('#add-assets').disabled=false;$('#asset-upload').value='';}
  }
  const cloudRetries=new Map();
  async function addCloudReferences(card,key,files){
    if(importing||!files.length)return;
    const d=draft(card),project=state.project,mode=card.mode,model=card.model,spec=state.models.find(m=>m.id===model);
    const single=['first_frame','last_frame'].includes(key),limit=single?1:key==='image_urls'?spec.ref_limit:3;
    const old=(d[key]||'').split(/\s+/).filter(Boolean),kind=key==='video_urls'?'video/':key==='audio_urls'?'audio/':'image/';
    if(files.some(f=>!f.type.startsWith(kind))){tell('请选择对应类型的素材');return;}
    if(files.length+(single?0:old.length)>limit){tell(`此字段最多 ${limit} 项素材`);return;}
    importing=true;
    try{for(const file of files){
      cloudRetries.set(card.id+':'+key,{file,model,mode:card.mode});
      const result=await window.directorStorage.uploadFile(file,tell,project.block_id,{index:files.indexOf(file)+1,total:files.length});
      cloudRetries.delete(card.id+':'+key);
      if(state.project!==project||!cardById(card.id)||card.model!==model||card.mode!==mode)throw Error('素材已上传；卡片已切换，请在原模式重新选择文件');
      const current=draft(card);current[key]=single?result.url:[current[key],result.url].filter(Boolean).join('\n');changed();
    }tell('直传完成，公网 URL 已填入参考素材');}
    catch(e){tell(e.message);}finally{importing=false;if(state.project===project&&cardById(card.id))renderCard(card);}
  }
  function receiveFiles(files,target,point){
    if($('#project-dialog').open){addCovers(files);return;}
    if(!state.project)return;
    const cloud=target.closest('.cloud-ref-zone');if(cloud){addCloudReferences(cardById(cloud.closest('[data-card]').dataset.card),cloud.dataset.cloudField,files);return;}
    const ref=target.closest('.ref-zone');
    if(ref){addReferences(cardById(ref.closest('[data-card]').dataset.card),files);return;}
    importAssets(files,point);
  }
  $('#asset-import-mode').onchange=()=>{$('#add-assets').textContent=$('#asset-import-mode').value==='cloud'?'＋ 选择素材直传':'＋ 导入素材';};
  $('#add-assets').onclick=()=>$('#asset-upload').click();
  $('#asset-upload').onchange=event=>importAssets([...event.target.files]);
  document.addEventListener('dragover',event=>{
    if(!event.dataTransfer?.types.includes('Files'))return;
    event.preventDefault();event.dataTransfer.dropEffect='copy';
    const zone=event.target.closest('.ref-zone')||($('#project-dialog').open?$('#project-dialog'):state.project?$('#canvas'):null);
    document.querySelectorAll('.file-dragover').forEach(el=>{if(el!==zone)el.classList.remove('file-dragover');});zone?.classList.add('file-dragover');
  });
  document.addEventListener('dragleave',event=>{if(!event.relatedTarget)document.querySelectorAll('.file-dragover').forEach(el=>el.classList.remove('file-dragover'));});
  document.addEventListener('drop',event=>{
    document.querySelectorAll('.file-dragover').forEach(el=>el.classList.remove('file-dragover'));
    const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;
    event.preventDefault();receiveFiles(files,event.target,{x:event.clientX,y:event.clientY});
  });
  document.addEventListener('paste',event=>{
    const files=[...(event.clipboardData?.files||[])];if(!files.length)return;
    if(!state.project&&!$('#project-dialog').open)return;
    event.preventDefault();receiveFiles(files,event.target);
  });
  $('#canvas-world').addEventListener('error',event=>{const el=event.target.closest('.asset-card');if(el)el.querySelector('.media-error').hidden=false;},true);
  $('#add-chat').onclick=async()=>{const b=$('#add-chat');b.disabled=true;try{await addChat();}catch(e){tell(e.message);}finally{b.disabled=false;}};
  $('#add-image').onclick=()=>addCard('image');$('#add-video').onclick=()=>addCard('video');
  $('.studio-brand').onclick=event=>{event.preventDefault();dashboard().catch(e=>tell(e.message));};
  $('#studio-logout').onclick=async()=>{try{if(importing||window.directorComments?.busy())throw Error('请等待素材上传或评论发送完成');await save();await request('/api/logout',{});location.reload();}catch(e){tell(e.message);}};
  window.addEventListener('beforeunload',event=>{if(importing||uploading||window.directorComments?.busy()||state.version!==state.saved){event.preventDefault();event.returnValue='';}});
  window.directorStudio={
    changed, describeMedia, cardName, materials:()=>state.project ? commentMaterials() : [],
    save, openProject, refreshProject, busy:()=>!!(drag||wireDrag||uploading||importing||window.directorComments?.busy()||[...(window.directorTimeline?.instances.values()||[])].some(i=>i.busy())), dirty:()=>state.version!==state.saved, currentProject:()=>state.project,
    async refreshModels(){const data=await request('/api/models');state.models=data.models;state.inferenceCredentials=data.inference_credentials||{keys:[]};if(data.model_error)tell(data.model_error);if(state.project)renderCanvas();},
    async enter(user){state.user=user;document.body.classList.add('studio-active');$('#studio').hidden=false;$('#studio-account').textContent=user.login;try{const data=await request('/api/models');state.models=data.models;state.inferenceCredentials=data.inference_credentials||{keys:[]};if(!data.online)tell('ComfyUI 未连接，仅影响本地模型；云端模型可通过 service-inference 设置使用。');await dashboard();}catch(error){tell(error.message);}},
    leave(){clearTimeout(state.polling);clearTimeout(state.timer);state.user=null;state.project=null;updateElapsedClocks();state.version=state.saved=0;$('#studio').hidden=true;document.body.classList.remove('studio-active');}
  };
})();
