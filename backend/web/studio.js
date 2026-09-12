(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => crypto.randomUUID().replaceAll('-', '');
  const date = v => new Date(v).toLocaleString('zh-CN', {hour12:false});
  const state = {user:null, projects:[], project:null, models:[], history:[], version:0, saved:0, saving:null, timer:null, polling:null, conflict:false};
  let dialogCovers = [], editing = false, uploading = false, drag = null;
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
    await save();
    clearTimeout(state.polling);
    state.project = null;
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
  async function upload(file) {
    if (file.size > 20*1024*1024) throw new Error('单张图片不能超过 20 MB');
    const form = new FormData(); form.append('file',file); return (await request('/api/assets',form)).id;
  }
  $('#cover-upload').onchange = async event => {
    if (dialogCovers.length + event.target.files.length > 20) { $('#project-form-error').textContent = '最多 20 张封面'; return; }
    uploading = true; $('#save-project').disabled = true;
    try { for (const file of event.target.files) { dialogCovers.push(await upload(file)); renderCovers(); } }
    catch (error) { $('#project-form-error').textContent = error.message; }
    finally { uploading = false; $('#save-project').disabled = false; }
  };
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
    const defaults = {model:card.type === 'image' ? 'z-image-turbo':'minimax-h3', prompt:'', width:card.type === 'image' ? 1024:832, height:card.type === 'image' ? 1024:480, steps:8, seed:-1, denoise:.65, duration:2, refs:[]};
    return card.drafts[card.mode] = {...defaults, ...card.drafts[card.mode]};
  }
  function transform() {
    const {x,y,zoom} = state.project.body.canvas.viewport;
    $('#canvas-world').style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    $('#zoom-reset').textContent = Math.round(zoom*100)+'%';
    $('#canvas').style.backgroundSize = `${24*zoom}px ${24*zoom}px`;
    $('#canvas').style.backgroundPosition = `${x}px ${y}px`;
  }
  function renderCanvas() {
    $('#canvas-world').innerHTML = '';
    for (const card of cards()) { const el = document.createElement('article'); el.className = 'generation-card'; el.dataset.card = card.id; $('#canvas-world').append(el); renderCard(card); }
    $('#canvas-empty').hidden = !!cards().length; transform();
  }
  function position(card, el) { Object.assign(el.style,{left:card.x+'px',top:card.y+'px',width:card.w+'px',height:card.h+'px'}); }
  function renderCard(card) {
    const el = document.querySelector(`[data-card="${card.id}"]`); if (!el) return;
    position(card,el);
    const d = draft(card), model = state.models.find(m => m.id === d.model), unsupported = !model?.modes.includes(card.mode);
    const tabLabels = card.type === 'image' ? ['文生图','图生图','参考图'] : ['文生视频','图生视频','多元素参考'];
    el.innerHTML = `<header class="card-heading"><span class="card-grip">⠿</span><strong>${card.type === 'image'?'◧ 图片生成':'▷ 视频生成'}</strong><small>${card.id.slice(0,6).toUpperCase()}</small><button class="quiet remove-card" title="移除卡片">✕</button></header><div class="card-content"><section class="card-results"></section><div class="generation-tabs" role="tablist">${['text','image','reference'].map((m,i)=>`<button role="tab" aria-selected="${m===card.mode}" data-mode="${m}">${tabLabels[i]}</button>`).join('')}</div><div class="generation-settings"><label>模型<select data-field="model">${state.models.filter(m=>m.type===card.type).map(m=>`<option value="${m.id}" ${m.id===d.model?'selected':''}>${esc(m.name)}</option>`).join('')}</select></label>${unsupported ? `<p class="mode-note">${esc(model?.note || '模型不可用')}</p>` : ''}<label>提示词<textarea data-field="prompt" rows="3" placeholder="描述画面、镜头、光线与情绪…">${esc(d.prompt)}</textarea></label>${card.mode!=='text' ? `<label>${card.type==='video'&&card.mode==='image'?'首帧 / 尾帧（可选）':'输入图片'}<input class="ref-upload" type="file" accept="image/png,image/jpeg,image/webp" ${card.type==='video'||card.mode==='reference'?'multiple':''}></label><div class="ref-list">${d.refs.map((r,i)=>`<div><img src="/api/assets/${esc(r)}" alt="输入图片 ${i+1}"><button class="quiet" data-remove-ref="${i}" title="移除图片">✕</button><small>${card.type==='video'&&card.mode==='image'?(i?'尾帧':'首帧'):i+1}</small></div>`).join('')}</div>`:''}<div class="parameter-grid"><label>宽度<input data-field="width" type="number" min="256" max="1536" step="${card.type==='image'?16:32}" value="${d.width}"></label><label>高度<input data-field="height" type="number" min="256" max="1536" step="${card.type==='image'?16:32}" value="${d.height}"></label><label>步数<input data-field="steps" type="number" min="1" max="40" value="${d.steps}"></label>${card.type==='video'?`<label>时长 / 秒<input data-field="duration" type="number" min="1" max="15" step="1" value="${d.duration}"></label>`:`<label>重绘强度<input data-field="denoise" type="number" min="0.01" max="1" step="0.05" value="${d.denoise}" ${card.mode==='text'?'disabled':''}></label>`}</div><label>种子 <small>−1 为随机</small><input data-field="seed" type="number" min="-1" max="9007199254740991" value="${d.seed}"></label><button class="generate" ${unsupported?'disabled':''}>${unsupported?'当前模式暂不可生成':'生成'+(card.type==='image'?'图片':'视频')+' ↗'}</button><p class="card-feedback" role="status"></p></div></div>${['n','s','e','w','ne','nw','se','sw'].map(dir=>`<div class="resize-handle resize-${dir}" data-resize="${dir}"></div>`).join('')}`;
    renderResults(card);
  }
  function jobMedia(row,index=0,mini=false) {
    const url = `/api/outputs/${row.block_id}/${index}`;
    return row.body.type === 'video' ? `<video src="${url}" ${mini?'preload="none"':'controls preload="metadata"'}></video>` : `<img src="${url}" data-preview="${url}" data-preview-title="${esc(row.body.model)} · ${date(row.createtime)}" ${mini?'':'role="button" tabindex="0"'} title="点击放大预览" alt="生成图片，点击放大预览" loading="lazy">`;
  }
  function renderResults(card) {
    const el = document.querySelector(`[data-card="${card.id}"] .card-results`); if (!el) return;
    const rows = state.history.filter(h => h.body.card_id === card.id);
    const selected = rows.find(h => h.block_id === card.selected) || rows[0];
    const pins = (card.pins || []).map(id=>rows.find(h=>h.block_id===id)).filter(h=>h?.body.outputs.length);
    const labels = {completed:'已完成',failed:'失败',submitting:'提交中',queued:'队列中 / 生成中',running:'生成中'};
    el.innerHTML = `<div class="result-stage">${selected?.body.outputs.length ? jobMedia(selected) : `<div class="result-placeholder"><span>${card.type==='image'?'◧':'▷'}</span><p>${selected ? esc(labels[selected.body.status] || selected.body.status) : '你的下一帧，从这里诞生'}</p></div>`}</div><div class="pin-toolbar"><span>PIN / 对比位</span><input class="pin-limit" aria-label="对比位数量" type="number" min="0" max="8" value="${card.pinLimit ?? 2}"><button class="quiet pin-current" ${selected?.body.outputs.length?'':'disabled'}>＋ 固定当前</button></div>${pins.length?`<div class="pinned-results">${pins.map(h=>`<div>${jobMedia(h)}<button class="quiet" data-unpin="${h.block_id}" title="取消固定">✕</button></div>`).join('')}</div>`:''}<div class="history-heading"><span>生成历史 / ${rows.length}</span><small>最新在左</small></div><div class="history-strip">${rows.map(h=>`<button data-history="${h.block_id}" class="${h===selected?'selected':''}" title="${esc(labels[h.body.status])} · ${date(h.createtime)}">${h.body.outputs.length?jobMedia(h,0,true):`<span>${esc(labels[h.body.status])}</span>`}</button>`).join('') || '<small>还没有生成记录</small>'}</div><details class="history-details" ${card.detailsOpen?'open':''}><summary>生成信息${selected?' · '+esc(labels[selected.body.status]):''}</summary>${selected?`<dl><dt>模型</dt><dd>${esc(selected.body.model)}</dd><dt>创建时间</dt><dd>${date(selected.createtime)}</dd><dt>参数</dt><dd>${selected.body.params.width} × ${selected.body.params.height} · ${selected.body.params.steps} 步 · seed ${selected.body.params.seed}</dd><dt>耗时</dt><dd>${selected.body.elapsed_ms!=null?(selected.body.elapsed_ms/1000).toFixed(1)+' 秒':'待返回'}</dd><dt>Tokens</dt><dd>${selected.body.usage.tokens ?? '未提供（本地模型不按 token 计费）'}</dd><dt>提示词</dt><dd>${esc(selected.body.params.prompt)}</dd>${selected.body.error?`<dt>错误</dt><dd>${esc(selected.body.error)}</dd>`:''}</dl><button class="quiet reuse-params" data-job="${selected.block_id}">复用这次参数</button>`:'<p>选择一条历史查看模型、参数和用量。</p>'}</details>`;
  }
  async function pollHistory() {
    clearTimeout(state.polling);
    const projectId = state.project?.block_id; if (!projectId) return;
    try {
      const rows = (await request('/api/projects/'+projectId+'/history')).history;
      if (state.project?.block_id !== projectId) return;
      if (JSON.stringify(rows)!==JSON.stringify(state.history)) {state.history=rows;for(const card of cards())renderResults(card);}
    } catch(error) {tell(error.message);}
    if(state.project?.block_id===projectId)state.polling=setTimeout(pollHistory,5000);
  }
  function addCard(type) {
    if(cards().length>=200){tell('当前画布最多 200 张卡片');return;}
    const v=state.project.body.canvas.viewport;
    const nextX=cards().length ? Math.max(...cards().map(c=>c.x+c.w))+40 : (50-v.x)/v.zoom;
    const card={id:uid(),type,mode:'text',x:nextX,y:cards()[0]?.y ?? (40-v.y)/v.zoom,w:480,h:Math.max(520,Math.min(860,($('#canvas').clientHeight-80)/v.zoom)),drafts:{},pins:[],pinLimit:2};
    cards().push(card);draft(card);renderCanvas();changed();
  }
  $('#canvas-world').addEventListener('input',event=>{
    const el=event.target.closest('[data-card]');if(!el)return;const card=cardById(el.dataset.card);
    if(event.target.dataset.field){const key=event.target.dataset.field;draft(card)[key]=['model','prompt'].includes(key)?event.target.value:Number(event.target.value);changed();}
  });
  $('#canvas-world').addEventListener('change',async event=>{
    const el=event.target.closest('[data-card]');if(!el)return;const card=cardById(el.dataset.card);
    if(event.target.classList.contains('pin-limit')){card.pinLimit=Math.max(0,Math.min(8,Number(event.target.value)||0));card.pins=(card.pins||[]).slice(0,card.pinLimit);changed();renderResults(card);}
    if(event.target.classList.contains('ref-upload')){
      const d=draft(card),limit=card.mode==='reference'?8:card.type==='video'?2:1;
      if(d.refs.length+event.target.files.length>limit){tell(`当前模式最多 ${limit} 张输入图片`);event.target.value='';return;}
      event.target.disabled=true;
      try{for(const file of event.target.files){d.refs.push(await upload(file));changed();}renderCard(card);}catch(error){tell(error.message);event.target.disabled=false;}
    }
  });
  $('#canvas-world').addEventListener('toggle',event=>{if(event.target.isConnected&&event.target.classList.contains('history-details')){const card=cardById(event.target.closest('[data-card]').dataset.card);card.detailsOpen=event.target.open;}},true);
  $('#canvas-world').addEventListener('click',async event=>{
    const button=event.target.closest('button'),el=event.target.closest('[data-card]');if(!button||!el)return;
    const card=cardById(el.dataset.card);
    if(button.dataset.mode){card.mode=button.dataset.mode;draft(card);renderCard(card);changed();}
    if(button.classList.contains('remove-card')){if(!confirm('移除此卡片？项目中的生成历史仍会保留。'))return;state.project.body.canvas.cards=cards().filter(c=>c.id!==card.id);renderCanvas();changed();}
    if(button.dataset.history){card.selected=button.dataset.history;card.detailsOpen=true;renderResults(card);changed();}
    if(button.dataset.unpin){card.pins=card.pins.filter(id=>id!==button.dataset.unpin);renderResults(card);changed();}
    if(button.classList.contains('pin-current')){const selected=card.selected||state.history.find(h=>h.body.card_id===card.id)?.block_id;card.pins||=[];if(card.pins.includes(selected))return;if(card.pins.length>=(card.pinLimit??2)){tell('对比位已满，可增加数量或取消已有固定。');return;}card.pins.push(selected);renderResults(card);changed();}
    if(button.dataset.removeRef!==undefined){draft(card).refs.splice(Number(button.dataset.removeRef),1);renderCard(card);changed();}
    if(button.classList.contains('reuse-params')){const h=state.history.find(h=>h.block_id===button.dataset.job);card.mode=h.body.mode;card.drafts[card.mode]={...h.body.params,model:h.body.model,refs:[...h.body.refs]};renderCard(card);changed();}
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
    const heading=event.target.closest('.card-heading');
    if(cardEl&&!handle&&(!heading||event.target.closest('button')))return;
    if(!cardEl&&event.target!==$('#canvas')&&event.target!==$('#canvas-world'))return;
    event.preventDefault();
    const card=cardEl?cardById(cardEl.dataset.card):null;
    drag={px:event.clientX,py:event.clientY,card,el:cardEl,dir:handle?.dataset.resize,original:structuredClone(card||state.project.body.canvas.viewport)};
    $('#canvas').setPointerCapture(event.pointerId);if(cardEl)cardEl.style.zIndex=10;
  };
  $('#canvas').onpointermove=event=>{
    if(!drag)return;const v=state.project.body.canvas.viewport,dx=(event.clientX-drag.px)/v.zoom,dy=(event.clientY-drag.py)/v.zoom,o=drag.original,c=drag.card;
    if(!c){v.x=o.x+event.clientX-drag.px;v.y=o.y+event.clientY-drag.py;transform();return;}
    if(!drag.dir){c.x=o.x+dx;c.y=o.y+dy;}else{
      if(drag.dir.includes('e'))c.w=Math.max(380,Math.min(3000,o.w+dx));
      if(drag.dir.includes('s'))c.h=Math.max(520,Math.min(4000,o.h+dy));
      if(drag.dir.includes('w')){c.w=Math.max(380,Math.min(3000,o.w-dx));c.x=o.x+o.w-c.w;}
      if(drag.dir.includes('n')){c.h=Math.max(520,Math.min(4000,o.h-dy));c.y=o.y+o.h-c.h;}
    }position(c,drag.el);
  };
  function finishDrag(){if(drag){if(drag.el)drag.el.style.zIndex='';drag=null;changed();}}
  $('#canvas').onpointerup=finishDrag;$('#canvas').onpointercancel=finishDrag;
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
  $('#add-image').onclick=()=>addCard('image');$('#add-video').onclick=()=>addCard('video');
  $('.studio-brand').onclick=event=>{event.preventDefault();dashboard().catch(e=>tell(e.message));};
  $('#studio-logout').onclick=async()=>{try{await save();await request('/api/logout',{});location.reload();}catch(e){tell(e.message);}};
  window.addEventListener('beforeunload',event=>{if(state.version!==state.saved){event.preventDefault();event.returnValue='';}});
  window.directorStudio={
    async enter(user){state.user=user;document.body.classList.add('studio-active');$('#studio').hidden=false;$('#studio-account').textContent=user.login;try{const data=await request('/api/models');state.models=data.models;if(!data.online)tell('ComfyUI 未启动，仍可编辑项目；生成前请启动 ComfyUI。');await dashboard();}catch(error){tell(error.message);}},
    leave(){clearTimeout(state.polling);clearTimeout(state.timer);state.user=null;state.project=null;state.version=state.saved=0;$('#studio').hidden=true;document.body.classList.remove('studio-active');}
  };
})();
