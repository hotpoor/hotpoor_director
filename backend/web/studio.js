(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => crypto.randomUUID().replaceAll('-', '');
  const date = v => new Date(v).toLocaleString('zh-CN', {hour12:false});
  const state = {user:null, projects:[], project:null, models:[], history:[], version:0, saved:0, saving:null, timer:null, polling:null, conflict:false};
  let elapsedTicker = null, wireDrag = null, keyboardPort = null;
  let dialogCovers = [], editing = false, uploading = false, importing = false, drag = null;
  async function request(path, body) {
    const headers = {};
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
    state.version++;
    saveLabel('未保存…');
    clearTimeout(state.timer);
    state.timer = setTimeout(() => save().catch(error => tell(error.message)), 700);
  }
  async function save() {
    clearTimeout(state.timer);
    if (state.saving) { await state.saving; return save(); }
    if (!state.project || state.saved === state.version) return;
    if (state.conflict) throw new Error('保存冲突：请先导出 JSON 草稿，重新打开项目后合并修改。');
    const version = state.version;
    const snapshot = structuredClone(state.project.body);
    const projectId = state.project.block_id;
    saveLabel('正在保存…');
    state.saving = request('/api/projects/' + projectId, snapshot).then(result => {
      state.project.body.revision = result.body.revision;
      state.project.updatetime = result.updatetime;
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
  async function dashboard() {
    if(importing)throw Error('请等待素材导入完成');
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
    $('#project-list').innerHTML = list.length ? list.map(p => `<button class="project-tile" data-project="${p.block_id}"><div class="project-cover">${p.body.covers.length ? `<img src="/api/assets/${p.body.covers[0]}" alt="${esc(p.body.title)} 的封面" loading="lazy">` : '<span>◧<small>UNTITLED FRAME / 等待你的第一帧</small></span>'}<b>${p.body.covers.length ? p.body.covers.length + ' 张封面' : 'DIRECTOR PROJECT'}</b></div><div class="project-copy"><h3>${esc(p.body.title)}</h3><p>${esc(p.body.subtitle || '为下一个故事留白')}</p><div class="project-description">${esc(p.body.description)}</div><small>创建 ${date(p.createtime)}<br>更新 ${date(p.updatetime)}</small><code>${p.block_id}</code></div></button>`).join('') : '<div class="empty-projects"><span>01 / 第一部作品</span><h2>你的创作现场，尚未开场。</h2><p>创建项目，收集灵感，让画面和故事一起生长。</p><button id="empty-create">＋ 创建第一个项目</button></div>';
  }
  async function openProject(id) {
    if(importing)throw Error('请等待素材导入完成');
    await save();
    const project = await request('/api/projects/' + id);
    state.project = project; state.version = 0; state.saved = 0; state.conflict = false; state.history = [];
    $('#dashboard').hidden = true; $('#editor').hidden = false; $('#project-title').textContent = project.body.title;
    saveLabel('已保存'); tell(''); renderCanvas(); await pollHistory();
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
    const standard = (card.model || card.drafts[card.mode]?.model) === 'z-image';
    const defaults = {negative_prompt:'', cfg:standard?4:1, model:card.type === 'image' ? 'z-image-turbo':'minimax-h3', prompt:'', width:card.type === 'image' ? 1024:832, height:card.type === 'image' ? 1024:480, steps:standard?40:8, seed:-1, denoise:.65, duration:2, refs:[]};
    if(card.model && card.drafts[card.mode]?.model && card.drafts[card.mode].model!==card.model){
      card.drafts[card.mode].steps=defaults.steps;card.drafts[card.mode].cfg=defaults.cfg;
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
    $('#canvas-world').innerHTML = '<svg class="connection-layer" aria-label="卡片连接线"><defs><marker id="connection-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#aaa"/></marker></defs><g class="connection-paths"></g></svg>';wireDrag=null;keyboardPort=null;
    for (const card of cards()) { const el = document.createElement('article'); el.className = 'generation-card'; el.dataset.card = card.id; $('#canvas-world').append(el); renderCard(card); }
    $('#canvas-empty').hidden = !!cards().length; transform();renderConnections();
  }
  function position(card, el) { Object.assign(el.style,{left:card.x+'px',top:card.y+'px',width:card.w+'px',height:card.h+'px'}); }
  const connections=()=>state.project.body.canvas.connections ||= [];
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
      if(source.type==='asset'){
        const key='asset:'+source.asset_id;if(seen.has(key))continue;seen.add(key);
        materials.push({key,asset:source.asset_id,url:'/api/assets/'+source.asset_id,name:source.name,mime:source.mime});
      }else{
        for(const job of state.history.filter(h=>h.body.card_id===source.id&&h.body.status==='completed'))for(const [index,output] of job.body.outputs.entries()){
          const key=job.block_id+':'+index;if(seen.has(key))continue;seen.add(key);
          materials.push({key,url:`/api/outputs/${job.block_id}/${index}`,name:job.body.model+' · '+date(job.createtime),mime:job.body.type==='image'?'image/png':'video/mp4'});
        }
      }
    }
    return materials;
  }
  function renderLibrary(card){
    const library=document.querySelector(`[data-card="${card.id}"] .imported-library`);if(!library)return;
    const incoming=connections().filter(e=>e.target===card.id),materials=upstreamMaterials(card);
    const html=`<summary>引入素材库 · ${materials.length}</summary><div class="upstream-links">${incoming.map(e=>`<span>${esc(cardById(e.source)?.name||e.source.slice(0,6))}<button class="quiet" data-disconnect="${e.id}" title="断开此来源">×</button></span>`).join('')}</div>${materials.length?`<div class="imported-items">${materials.map(m=>`<div class="imported-item">${m.mime?.startsWith('image/')?`<img src="${m.url}" data-preview="${m.url}" data-preview-title="${esc(m.name)}" alt="${esc(m.name)}" tabindex="0" role="button" loading="lazy">`:m.mime?.startsWith('video/')?`<video src="${m.url}" controls preload="metadata"></video>`:`<audio src="${m.url}" controls preload="metadata"></audio>`}<small>${esc(m.name)}</small>${card.type!=='asset'?`<button class="quiet" data-use-material="${m.key}" ${m.mime?.startsWith('image/')?'':'disabled'}>${m.mime?.startsWith('image/')?'用作输入图片':'当前模型不支持此类输入'}</button>`:''}</div>`).join('')}</div>`:`<p>${incoming.length?'等待上游卡片生成素材。':'从其他卡片右侧拖线到本卡片左侧，引入素材。'}</p>`}`;
    if(library._markup!==html){library.innerHTML=html;library._markup=html;}
  }
  function renderLibraries(){if(state.project)for(const card of cards())renderLibrary(card);}
  async function useMaterial(card,key){
    if(importing)return;
    const material=upstreamMaterials(card).find(m=>m.key===key);if(!material||!material.mime.startsWith('image/'))return;
    const model=state.models.find(m=>m.id===card.model);
    if(!model?.modes.includes('image')){tell('当前模型不支持图片输入');return;}
    const project=state.project;
    card.mode='image';const d=draft(card),limit=card.type==='video'?2:1;
    if(material.asset&&d.refs.includes(material.asset)){tell('这张图片已经在输入列表中');renderCard(card);changed();return;}
    if(d.refs.length>=limit){tell(`当前模式最多 ${limit} 张输入图片，请先移除已有输入`);renderCard(card);changed();return;}
    importing=true;
    try{
      let id=material.asset;
      if(!id){tell('正在载入上游生成图片…');const response=await fetch(material.url);if(!response.ok)throw Error('无法读取上游结果，请确认 ComfyUI 正在运行');const blob=await response.blob();id=await upload(new File([blob],'upstream.png',{type:blob.type}));}
      if(state.project!==project||!cardById(card.id))return;
      d.refs.push(id);renderCard(card);changed();tell('已添加到输入图片；点击生成即可使用');
    }catch(error){tell(error.message);if(state.project===project){renderCard(card);changed();}}
    finally{importing=false;}
  }
  function renderCard(card) {
    const el = document.querySelector(`[data-card="${card.id}"]`); if (!el) return;
    position(card,el);
    if(card.type==='asset'){
      const url='/api/assets/'+card.asset_id;
      const media=card.mime?.startsWith('image/')?`<img src="${url}" data-preview="${url}" data-preview-title="${esc(card.name)}" role="button" tabindex="0" alt="${esc(card.name)}">`:card.mime?.startsWith('video/')?videoMedia(url):`<div class="audio-art">♫</div><audio src="${url}" controls preload="metadata"></audio>`;
      el.classList.add('asset-card');
      el.innerHTML=`<header class="card-heading"><span class="card-grip">⠿</span><strong title="${esc(card.name)}">${esc(card.name)}</strong><button class="quiet remove-card" title="移除素材卡片">✕</button></header><div class="asset-content">${media}<small>${esc(card.mime)} · ${((card.size||0)/1024/1024).toFixed(2)} MB</small><p class="media-error" hidden>浏览器无法播放此文件，请检查编码格式。</p></div>${['n','s','e','w','ne','nw','se','sw'].map(dir=>`<div class="resize-handle resize-${dir}" data-resize="${dir}"></div>`).join('')}`;
      el.insertAdjacentHTML('beforeend',cardPorts());el.querySelector('.asset-content').insertAdjacentHTML('beforeend','<details class="imported-library" open></details>');renderLibrary(card);
      return;
    }
    const available = state.models.filter(m => m.type === card.type);
    const model = available.find(m => m.id === (card.model || draft(card).model)) || available[0];
    if(model) {
      card.model = model.id;
      if(!model.modes.includes(card.mode) && model.modes.length) {
        card.mode = model.modes[0];
        changed();
      }
    }
    const d = draft(card), unsupported = !model?.modes.includes(card.mode);
    const tabLabels = card.type === 'image' ? ['文生图','图生图','参考图'] : ['文生视频','图生视频','多元素参考'];
    el.innerHTML = `<header class="card-heading"><span class="card-grip">⠿</span><strong>${card.type === 'image'?'◧ 图片生成':'▷ 视频生成'}</strong><small>${card.id.slice(0,6).toUpperCase()}</small><button class="quiet remove-card" title="移除卡片">✕</button></header><div class="card-progress"></div><div class="card-content"><section class="card-results"></section><details class="imported-library" open></details><label class="model-picker">模型<select data-field="model" ${available.length?'':'disabled'}>${available.map(m=>`<option value="${m.id}" ${m.id===d.model?'selected':''}>${esc(m.name)}</option>`).join('') || '<option>暂无可用模型</option>'}</select></label><div class="generation-tabs" role="tablist">${['text','image','reference'].map((m,i)=>model?.modes.includes(m)?`<button role="tab" aria-selected="${m===card.mode}" data-mode="${m}">${tabLabels[i]}</button>`:'').join('')}</div><div class="generation-settings">${unsupported ? `<p class="mode-note">${esc(model?.note || '模型不可用')}</p>` : ''}<label>提示词<textarea data-field="prompt" rows="3" placeholder="描述画面、镜头、光线与情绪…">${esc(d.prompt)}</textarea></label>${d.model==='z-image'?`<label>反向提示词<textarea data-field="negative_prompt" rows="2" placeholder="希望避免的内容…">${esc(d.negative_prompt)}</textarea></label>`:''}${card.mode!=='text' ? `<div class="ref-zone" tabindex="0"><span>${card.type==='video'&&card.mode==='image'?'首帧 / 尾帧（可选）':'输入图片'}</span><button class="quiet choose-ref">＋ 添加图片 · 拖入 / 粘贴</button><input hidden class="ref-upload" type="file" accept="image/png,image/jpeg,image/webp" ${card.type==='video'||card.mode==='reference'?'multiple':''}></div><div class="ref-list">${d.refs.map((r,i)=>`<div><img src="/api/assets/${esc(r)}" alt="输入图片 ${i+1}"><button class="quiet" data-remove-ref="${i}" title="移除图片">✕</button><small>${card.type==='video'&&card.mode==='image'?(i?'尾帧':'首帧'):i+1}</small></div>`).join('')}</div>`:''}<div class="parameter-grid"><label>宽度<input data-field="width" type="number" min="256" max="1536" step="${card.type==='image'?16:32}" value="${d.width}"></label><label>高度<input data-field="height" type="number" min="256" max="1536" step="${card.type==='image'?16:32}" value="${d.height}"></label><label>步数<input data-field="steps" type="number" min="1" max="${d.model==='z-image'?60:40}" value="${d.steps}"></label>${d.model==='z-image'?`<label>CFG / 提示词引导<input data-field="cfg" type="number" min="1" max="20" step="0.5" value="${d.cfg}"></label>`:''}${card.type==='video'?`<label>时长 / 秒<input data-field="duration" type="number" min="1" max="15" step="1" value="${d.duration}"></label>`:`<label>重绘强度<input data-field="denoise" type="number" min="0.01" max="1" step="0.05" value="${d.denoise}" ${card.mode==='text'?'disabled':''}></label>`}</div><label>种子 <small>−1 为随机</small><input data-field="seed" type="number" min="-1" max="9007199254740991" value="${d.seed}"></label><button class="generate" ${unsupported?'disabled':''}>${unsupported?'当前模式暂不可生成':'生成'+(card.type==='image'?'图片':'视频')+' ↗'}</button><p class="card-feedback" role="status"></p></div></div>${['n','s','e','w','ne','nw','se','sw'].map(dir=>`<div class="resize-handle resize-${dir}" data-resize="${dir}"></div>`).join('')}`;
    el.insertAdjacentHTML('beforeend',cardPorts());
    renderResults(card);renderLibrary(card);
  }
  function videoMedia(url){
    return `<div class="video-preview"><video src="${esc(url)}" controls preload="metadata"></video><div class="video-frame-tools" data-frame-url="${esc(url)}"><button data-extract-frame="last">提取最后一帧</button><label>秒<input class="frame-seconds" type="number" min="0" step="0.1" value="0" aria-label="提取帧的秒数"></label><button data-extract-frame="time">提取指定帧</button></div></div>`;
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
  function elapsedText(start){
    const seconds=Math.max(0,Math.floor((Date.now()-start)/1000));
    const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
    return (hours?String(hours).padStart(2,'0')+':':'')+String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  }
  function updateElapsedClocks(){
    const clocks=state.project?[...document.querySelectorAll('.generation-elapsed')]:[];
    for(const clock of clocks)clock.textContent='已等待 '+elapsedText(Number(clock.dataset.started));
    if(clocks.length&&!elapsedTicker)elapsedTicker=setInterval(updateElapsedClocks,1000);
    if(!clocks.length&&elapsedTicker){clearInterval(elapsedTicker);elapsedTicker=null;}
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateElapsedClocks();});
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
    const labels = {completed:'已完成',failed:'失败',submitting:'提交中',queued:'排队中',running:'生成中'};
    const active = allRows.find(h=>['submitting','queued','running'].includes(h.body.status));
    const p = active?.body.progress;
    const sampler = active && String(p?.node) === (active.body.type==='image'?'8':'11');
    const determinate = sampler && p?.phase==='sampling' && p.maximum>0 && p.value<p.maximum;
    const percent = determinate ? Math.floor(p.value/p.maximum*100) : null;
    const phase = p?.phase==='unavailable' ? '进度暂不可用，正在等待结果' : determinate ? `采样 ${p.value} / ${p.maximum} · ${percent}%` : p?.phase==='finishing' || (sampler && p?.value>=p?.maximum) ? '采样完成，正在处理输出…' : active?.body.status==='submitting' ? '正在提交…' : active?.body.status==='queued' ? '排队等待生成…' : '正在生成 / 加载模型或处理媒体…';
    const progress = active ? `<div class="generation-progress"><div class="generation-status"><span title="${esc(phase)}">${esc(phase)}</span><span class="generation-elapsed" data-started="${Number(active.body.submitted_at || active.createtime)}" title="从任务提交开始累计，包含排队、加载和生成时间">已等待 ${elapsedText(Number(active.body.submitted_at || active.createtime))}</span></div><progress max="100" ${determinate?`value="${percent}"`:''} aria-label="${esc(phase)}"></progress></div>` : '';
    el.closest('[data-card]').querySelector('.card-progress').innerHTML=progress;
    updateElapsedClocks();
    if(progressOnly)return;
    el.innerHTML = `<div class="result-stage">${selected?.body.outputs.length ? jobMedia(selected) : `<div class="result-placeholder"><span>${card.type==='image'?'◧':'▷'}</span><p>${selected ? esc(labels[selected.body.status] || selected.body.status) : '你的下一帧，从这里诞生'}</p></div>`}</div>${selected?.body.outputs.length?`<label class="hide-result"><input type="checkbox" data-hide-job="${selected.block_id}"> 隐藏当前生成结果</label>`:''}<div class="pin-toolbar"><span>PIN / 对比位</span><input class="pin-limit" aria-label="对比位数量" type="number" min="0" max="8" value="${card.pinLimit ?? 2}"><button class="quiet pin-current" ${selected?.body.outputs.length?'':'disabled'}>＋ 固定当前</button></div>${pins.length?`<div class="pinned-results">${pins.map(h=>`<div>${jobMedia(h,0,false,false)}<button class="quiet" data-unpin="${h.block_id}" title="取消固定">✕</button></div>`).join('')}</div>`:''}<div class="history-heading"><span>生成历史 / ${rows.length}</span><small>最新在左</small></div><div class="history-strip">${rows.map(h=>`<button data-history="${h.block_id}" class="${h===selected?'selected':''}" title="${esc(labels[h.body.status])} · ${date(h.createtime)}">${h.body.outputs.length?jobMedia(h,0,true):`<span>${esc(labels[h.body.status])}</span>`}</button>`).join('') || '<small>还没有生成记录</small>'}</div><details class="hidden-history" ${card.hiddenOpen?'open':''}><summary>已隐藏 / ${hiddenRows.length}</summary><div class="hidden-items">${hiddenRows.map(h=>`<div class="hidden-item">${jobMedia(h,0,false,false)}<small>${esc(h.body.model)} · ${date(h.createtime)}</small><button data-restore-job="${h.block_id}">恢复到生成历史</button></div>`).join('')||'<p>没有隐藏的结果</p>'}</div></details><details class="history-details" ${card.detailsOpen?'open':''}><summary>生成信息${selected?' · '+esc(labels[selected.body.status]):''}</summary>${selected?`<dl><dt>模型</dt><dd>${esc(selected.body.model)}</dd><dt>创建时间</dt><dd>${date(selected.createtime)}</dd><dt>参数</dt><dd>${selected.body.params.width} × ${selected.body.params.height} · ${selected.body.params.steps} 步 · seed ${selected.body.params.seed}</dd>${selected.body.model==='z-image'?`<dt>CFG</dt><dd>${selected.body.params.cfg ?? 4}</dd><dt>反向提示词</dt><dd>${esc(selected.body.params.negative_prompt || '未填写')}</dd>`:''}<dt>耗时</dt><dd>${selected.body.elapsed_ms!=null?(selected.body.elapsed_ms/1000).toFixed(1)+' 秒':'待返回'}</dd><dt>Tokens</dt><dd>${selected.body.usage.tokens ?? '未提供（本地模型不按 token 计费）'}</dd><dt>提示词</dt><dd>${esc(selected.body.params.prompt)}</dd>${selected.body.error?`<dt>错误</dt><dd>${esc(selected.body.error)}</dd>`:''}</dl><button class="quiet reuse-params" data-job="${selected.block_id}">复用这次参数</button>`:'<p>选择一条历史查看模型、参数和用量。</p>'}</details>`;
    scroller.scrollTop = scrollTop;
    el.querySelector('.history-details').scrollTop = detailScroll;
  }
  async function pollHistory() {
    clearTimeout(state.polling);
    const projectId = state.project?.block_id; if (!projectId) return;
    try {
      const rows = (await request('/api/projects/'+projectId+'/history')).history;
      if (state.project?.block_id !== projectId) return;
      if (JSON.stringify(rows)!==JSON.stringify(state.history)) {
        const stable = list => JSON.stringify(list.map(row=>({...row,body:{...row.body,progress:undefined}})));
        const progressOnly = stable(rows)===stable(state.history);
        state.history=rows;for(const card of cards())renderResults(card,progressOnly);if(!progressOnly)renderLibraries();
      }
    } catch(error) {tell(error.message);}
    if(state.project?.block_id===projectId)state.polling=setTimeout(pollHistory,state.history.some(h=>['submitting','queued','running'].includes(h.body.status))?1000:5000);
  }
  function addCard(type) {
    if(cards().length>=200){tell('当前画布最多 200 张卡片');return;}
    const v=state.project.body.canvas.viewport;
    const nextX=cards().length ? Math.max(...cards().map(c=>c.x+c.w))+80 : (50-v.x)/v.zoom;
    const card={id:uid(),type,mode:'text',x:nextX,y:cards()[0]?.y ?? (40-v.y)/v.zoom,w:480,h:Math.max(520,Math.min(860,($('#canvas').clientHeight-80)/v.zoom)),drafts:{},pins:[],pinLimit:2};
    cards().push(card);draft(card);renderCanvas();changed();
  }
  $('#canvas-world').addEventListener('input',event=>{
    const el=event.target.closest('[data-card]');if(!el)return;const card=cardById(el.dataset.card);
    if(event.target.dataset.field && event.target.dataset.field!=='model'){const key=event.target.dataset.field;draft(card)[key]=['model','prompt','negative_prompt'].includes(key)?event.target.value:Number(event.target.value);changed();}
  });
  $('#canvas-world').addEventListener('change',async event=>{
    const el=event.target.closest('[data-card]');if(!el)return;const card=cardById(el.dataset.card);
    if(event.target.dataset.field==='model'){
      const model=state.models.find(m=>m.id===event.target.value&&m.type===card.type);
      if(!model)return;
      card.model=model.id;
      const top=el.querySelector('.card-content').scrollTop;
      renderCard(card);el.querySelector('.card-content').scrollTop=top;
      el.querySelector('[data-field=model]').focus({preventScroll:true});changed();
    }
    if(event.target.dataset.hideJob){const id=event.target.dataset.hideJob;card.hiddenJobs=[...new Set([...(card.hiddenJobs||[]),id])];card.pins=(card.pins||[]).filter(p=>p!==id);if(card.selected===id)delete card.selected;renderResults(card);changed();}
    if(event.target.classList.contains('pin-limit')){card.pinLimit=Math.max(0,Math.min(8,Number(event.target.value)||0));card.pins=(card.pins||[]).slice(0,card.pinLimit);changed();renderResults(card);}
    if(event.target.classList.contains('ref-upload')){await addReferences(card,[...event.target.files]);}
  });
  $('#canvas-world').addEventListener('toggle',event=>{if(event.target.isConnected&&event.target.classList.contains('hidden-history')){cardById(event.target.closest('[data-card]').dataset.card).hiddenOpen=event.target.open;}if(event.target.isConnected&&event.target.classList.contains('history-details')){const card=cardById(event.target.closest('[data-card]').dataset.card);card.detailsOpen=event.target.open;}},true);
  $('#canvas-world').addEventListener('click',async event=>{
    const button=event.target.closest('button'),el=event.target.closest('[data-card]');if(!button||!el)return;
    const card=cardById(el.dataset.card);
    if(button.dataset.extractFrame){await extractFrame(card,button);return;}
    if(button.dataset.restoreJob){card.hiddenJobs=(card.hiddenJobs||[]).filter(id=>id!==button.dataset.restoreJob);card.selected=button.dataset.restoreJob;renderResults(card);changed();return;}
    if(button.dataset.disconnect){disconnect(button.dataset.disconnect);return;}
    if(button.dataset.useMaterial){await useMaterial(card,button.dataset.useMaterial);return;}
    if(button.classList.contains('choose-ref'))el.querySelector('.ref-upload').click();
    if(button.dataset.mode){if(!state.models.find(m=>m.id===card.model)?.modes.includes(button.dataset.mode))return;card.mode=button.dataset.mode;draft(card);renderCard(card);changed();}
    if(button.classList.contains('remove-card')){if(!confirm(card.type==='asset'?'移除此素材卡片？':'移除此卡片？项目中的生成历史仍会保留。'))return;state.project.body.canvas.connections=connections().filter(e=>e.source!==card.id&&e.target!==card.id);state.project.body.canvas.cards=cards().filter(c=>c.id!==card.id);renderCanvas();changed();}
    if(button.dataset.history){card.selected=button.dataset.history;card.detailsOpen=true;renderResults(card);changed();}
    if(button.dataset.unpin){card.pins=card.pins.filter(id=>id!==button.dataset.unpin);renderResults(card);changed();}
    if(button.classList.contains('pin-current')){const selected=card.selected||state.history.find(h=>h.body.card_id===card.id&&!(card.hiddenJobs||[]).includes(h.block_id))?.block_id;card.pins||=[];if(card.pins.includes(selected))return;if(card.pins.length>=(card.pinLimit??2)){tell('对比位已满，可增加数量或取消已有固定。');return;}card.pins.push(selected);renderResults(card);changed();}
    if(button.dataset.removeRef!==undefined){draft(card).refs.splice(Number(button.dataset.removeRef),1);renderCard(card);changed();}
    if(button.classList.contains('reuse-params')){const h=state.history.find(h=>h.block_id===button.dataset.job);card.model=h.body.model;card.mode=h.body.mode;card.drafts[card.mode]={...h.body.params,model:h.body.model,refs:[...h.body.refs]};renderCard(card);changed();}
    if(button.classList.contains('generate')){
      button.disabled=true;const feedback=el.querySelector('.card-feedback');feedback.textContent='保存并提交…';
      const projectId=state.project.block_id;
      try{await save();const row=await request(`/api/projects/${projectId}/generate`,{...structuredClone(draft(card)),card_id:card.id,mode:card.mode,request_id:uid()});if(state.project?.block_id!==projectId)return;state.history.unshift(row);card.selected=row.block_id;changed();renderResults(card);feedback.textContent=row.body.error||'已提交到本地 ComfyUI，结果会自动出现。';}
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
  function zoom(factor,px,py){const v=state.project.body.canvas.viewport,old=v.zoom;v.zoom=Math.max(.15,Math.min(3,old*factor));v.x=px-(px-v.x)*v.zoom/old;v.y=py-(py-v.y)*v.zoom/old;transform();changed();}
  $('#canvas').addEventListener('wheel',event=>{if(event.target.closest('[data-card]')&&!event.ctrlKey)return;event.preventDefault();const r=$('#canvas').getBoundingClientRect();zoom(Math.exp(-event.deltaY*.001),event.clientX-r.left,event.clientY-r.top);},{passive:false});
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
    const project=state.project,d=draft(card),limit=card.mode==='reference'?8:card.type==='video'?2:1;
    if(d.refs.length+files.length>limit){tell(`当前模式最多 ${limit} 张输入图片`);return;}
    importing=true;
    try{for(const file of files){const id=await upload(file);if(state.project!==project)throw Error('项目已切换，已停止添加参考图');d.refs.push(id);changed();}renderCard(card);}
    catch(error){tell(error.message);if(state.project===project)renderCard(card);}
    finally{importing=false;}
  }
  async function importAssets(files,point){
    if(!state.project||importing)return;
    if(cards().length+files.length>200){tell('当前画布最多 200 张卡片');return;}
    const project=state.project,v=project.body.canvas.viewport,r=$('#canvas').getBoundingClientRect();
    const x=point?(point.x-r.left-v.x)/v.zoom:cards().length?Math.max(...cards().map(c=>c.x+c.w))+80:(40-v.x)/v.zoom;
    const y=point?(point.y-r.top-v.y)/v.zoom:(40-v.y)/v.zoom;
    importing=true;$('#add-assets').disabled=true;
    try{
      for(let i=0;i<files.length;i++){
        tell(`正在导入 ${i+1}/${files.length}：${files[i].name}`);
        const asset=await uploadMedia(files[i]);
        if(state.project!==project)throw Error('项目已切换，已停止导入');
        const card={id:uid(),type:'asset',mode:'media',asset_id:asset.id,name:asset.name,mime:asset.mime,size:asset.size,x:x+(i%3)*500,y:y+Math.floor(i/3)*400,w:420,h:asset.mime.startsWith('audio/')?240:360};
        cards().push(card);const el=document.createElement('article');el.className='generation-card';el.dataset.card=card.id;$('#canvas-world').append(el);renderCard(card);changed();$('#canvas-empty').hidden=true;
      }
      if(!point){v.x=40-x*v.zoom;v.y=40-y*v.zoom;transform();changed();}
      tell('');await save();
    }catch(error){tell(error.message);}
    finally{importing=false;$('#add-assets').disabled=false;$('#asset-upload').value='';}
  }
  function receiveFiles(files,target,point){
    if($('#project-dialog').open){addCovers(files);return;}
    if(!state.project)return;
    const ref=target.closest('.ref-zone');
    if(ref){addReferences(cardById(ref.closest('[data-card]').dataset.card),files);return;}
    importAssets(files,point);
  }
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
  $('#add-image').onclick=()=>addCard('image');$('#add-video').onclick=()=>addCard('video');
  $('.studio-brand').onclick=event=>{event.preventDefault();dashboard().catch(e=>tell(e.message));};
  $('#studio-logout').onclick=async()=>{try{if(importing)throw Error('请等待素材导入完成');await save();await request('/api/logout',{});location.reload();}catch(e){tell(e.message);}};
  window.addEventListener('beforeunload',event=>{if(importing||uploading||state.version!==state.saved){event.preventDefault();event.returnValue='';}});
  window.directorStudio={
    async enter(user){state.user=user;document.body.classList.add('studio-active');$('#studio').hidden=false;$('#studio-account').textContent=user.login;try{const data=await request('/api/models');state.models=data.models;if(!data.online)tell('ComfyUI 未启动，仍可编辑项目；生成前请启动 ComfyUI。');await dashboard();}catch(error){tell(error.message);}},
    leave(){clearTimeout(state.polling);clearTimeout(state.timer);state.user=null;state.project=null;updateElapsedClocks();state.version=state.saved=0;$('#studio').hidden=true;document.body.classList.remove('studio-active');}
  };
})();
