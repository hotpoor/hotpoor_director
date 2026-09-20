(() => {
  'use strict';
  const dialog=document.querySelector('#inference-dialog'),form=document.querySelector('#inference-form');
  const status=document.querySelector('#inference-status'),key=form.elements.api_key,list=document.querySelector('#inference-key-list');
  let config={keys:[]},management={keys:[]},editing='';
  const editor=document.createElement('div');editor.className='ak-inline-editor';editor.hidden=true;
  const newButton=document.querySelector('#new-inference-key');
  let node=newButton.nextSibling;
  while(node){const next=node.nextSibling;if(node!==status)editor.append(node);node=next;}
  form.append(editor);
  const reveal=document.createElement('button'),copy=document.createElement('button');
  reveal.type=copy.type='button';reveal.className=copy.className='quiet';
  reveal.textContent='显示 AK';copy.textContent='复制 AK';key.after(reveal,copy);
  let keyRequest=0;
  function hideKey(){keyRequest++;key.type='password';key.value='';reveal.textContent='显示 AK';}
  async function readKey(){
    if(key.value.trim())return key.value.trim();
    if(!editing)throw Error('请先输入或保存 AK');
    const id=editing,token=keyRequest;
    const result=await request('/api/settings/service-inference',{action:'reveal',id});
    if(token!==keyRequest||id!==editing||!dialog.open)throw Error('AK 展示已取消');
    return result.api_key;
  }
  reveal.onclick=async()=>{
    if(key.type==='text'){keyRequest++;key.type='password';reveal.textContent='显示 AK';return;}
    reveal.disabled=true;
    try{key.value=await readKey();key.type='text';reveal.textContent='隐藏 AK';}catch(e){status.textContent=e.message;}
    finally{reveal.disabled=false;}
  };
  copy.onclick=async()=>{
    copy.disabled=true;
    try{await navigator.clipboard.writeText(await readKey());status.textContent='AK 已复制';}
    catch(e){status.textContent=e.message;}
    finally{copy.disabled=false;}
  };
  dialog.addEventListener('close',hideKey);
  window.addEventListener('director-inference-tab-changed',()=>{keyRequest++;key.type='password';reveal.textContent='显示 AK';});

  function placeEditor(id,open=true){
    editor.hidden=!open;
    const button=[...form.querySelectorAll('[data-edit-key]')].find(b=>b.dataset.editKey===id);
    if(button)button.closest('.ak-config-item').append(editor);else newButton.after(editor);
    for(const b of form.querySelectorAll('[data-edit-key]')){const expanded=open&&b===button;b.textContent=expanded?'收起编辑':'展开编辑';b.setAttribute('aria-expanded',String(expanded));}
  }
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
  }
  function models(items=[],loaded=false){
    document.querySelector('#inference-model-list').innerHTML=['image','video'].map(kind=>{const rows=items.filter(m=>m.type===kind);return `<section><h3>${kind==='image'?'图片生成':'视频生成'} · ${rows.length}</h3>${!loaded?'<p>查询后显示此 Key 的模型。</p>':rows.length?`<ul>${rows.map(m=>`<li><strong>${esc(m.name)}</strong><small>${esc(m.id)}</small><span>${m.integrated?'已接入工作台':'API 可见 · 工作台暂未接入'}</span></li>`).join('')}</ul>`:'<p>此 Key 的列表中没有此类模型。</p>'}</section>`;}).join('');
  }
  function edit(id,open=true){editing=id||'';const p=config.keys.find(k=>k.id===editing);form.elements.name.value=p?.name||'';hideKey();binding(p?.management_key_id);document.querySelector('#clear-inference').disabled=!p;models(p?.models,p?.models_loaded);placeEditor(editing,open);}
  function binding(selected){
    const select=form.elements.management_key_id;
    select.innerHTML='<option value="">请选择管理 AK</option>'+management.keys.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.organization_id||'')}</option>`).join('');select.value=selected||'';
  }
  window.addEventListener('director-management-updated',event=>{const selected=form.elements.management_key_id.value;management=event.detail;binding(selected);});
  function render(){
    form.append(editor);
    list.innerHTML=config.keys.map(p=>`<div class="ak-config-item"><div class="inference-key-row"><label><input type="checkbox" name="active_key" value="${esc(p.id)}" ${(config.enabled_key_ids||[]).includes(p.id)?'checked':''}>${esc(p.name)}</label><button type="button" class="quiet" data-edit-key="${esc(p.id)}" aria-expanded="false">展开编辑</button><button type="button" class="quiet" data-refresh-key="${esc(p.id)}">刷新模型</button></div></div>`).join('')||'<p class="comfy-help">尚未配置 API Key</p>';
  }
  document.querySelector('#open-inference-settings').onclick=async()=>{
    hideKey();dialog.showModal();status.textContent='读取配置…';
    try{const results=await Promise.allSettled([request('/api/settings/service-inference'),request('/api/settings/service-inference/management')]);for(const r of results)if(r.status==='rejected')throw r.reason;config=results[0].value;management=results[1].value;render();edit(config.active_key_id,!config.keys.length);status.textContent=config.configured?'已配置 API Key · 可添加多个，卡片分别选择 AK':'尚未配置 API Key';}catch(e){status.textContent=e.message;}
  };
  document.querySelector('#close-inference-settings').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{hideKey();});
  document.querySelector('#new-inference-key').onclick=()=>{edit('');status.textContent='填写名称和 Key，保存后查询模型并启用';key.focus();};
  async function submit(action='save',id=editing,enabled){
    const data={action,id,name:form.elements.name.value,api_key:key.value.trim(),management_key_id:form.elements.management_key_id.value},controls=[...form.querySelectorAll('input,button')];
    controls.forEach(b=>b.disabled=true);status.textContent='查询并更新配置…';
    try{
      if(action==='test'){const r=await request('/api/settings/service-inference/test',data);models(r.models,true);status.textContent='查询验证通过；如填写新 Key，请保存配置';}
      else{config=await request('/api/settings/service-inference',action==='save'?data:{action,id,enabled});const wasOpen=!editor.hidden,previous=editing;render();edit(action==='delete'?'':action==='save'?config.active_key_id:previous,action==='save'||(action!=='delete'&&wasOpen));status.textContent='已保存 · 已启用 AK：'+(config.keys.filter(p=>(config.enabled_key_ids||[]).includes(p.id)).map(p=>p.name).join('、')||'无');await window.directorStudio?.refreshModels();}
    }catch(e){status.textContent=e.message;render();}
    finally{controls.forEach(b=>b.disabled=false);document.querySelector('#clear-inference').disabled=!editing;}
  }
  list.addEventListener('change',e=>{if(e.target.name==='active_key')submit('enable',e.target.value,e.target.checked);});
  list.addEventListener('click',e=>{const b=e.target.closest('button');if(b?.dataset.editKey)edit(b.dataset.editKey,editor.hidden||editing!==b.dataset.editKey);if(b?.dataset.refreshKey)submit('refresh',b.dataset.refreshKey);});
  document.querySelector('#query-bound-management').onclick=()=>window.directorManagement?.report(editing);
  form.onsubmit=e=>{e.preventDefault();submit();};
  document.querySelector('#test-inference').onclick=()=>submit('test');
  document.querySelector('#clear-inference').onclick=()=>submit('delete');
})();
