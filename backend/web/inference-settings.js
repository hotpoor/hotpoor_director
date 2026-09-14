(() => {
  'use strict';
  const dialog=document.querySelector('#inference-dialog'),form=document.querySelector('#inference-form');
  const status=document.querySelector('#inference-status'),key=form.elements.api_key,list=document.querySelector('#inference-key-list');
  let config={keys:[]},editing='';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
  }
  function models(items=[],loaded=false){
    document.querySelector('#inference-model-list').innerHTML=['image','video'].map(kind=>{const rows=items.filter(m=>m.type===kind);return `<section><h3>${kind==='image'?'图片生成':'视频生成'} · ${rows.length}</h3>${!loaded?'<p>查询后显示此 Key 的模型。</p>':rows.length?`<ul>${rows.map(m=>`<li><strong>${esc(m.name)}</strong><small>${esc(m.id)}</small><span>${m.integrated?'已接入工作台':'API 可见 · 工作台暂未接入'}</span></li>`).join('')}</ul>`:'<p>此 Key 的列表中没有此类模型。</p>'}</section>`;}).join('');
  }
  function edit(id){editing=id||'';const p=config.keys.find(k=>k.id===editing);form.elements.name.value=p?.name||'';key.value='';document.querySelector('#clear-inference').disabled=!p;models(p?.models,p?.models_loaded);}
  function render(){
    list.innerHTML=config.keys.map(p=>`<div class="inference-key-row"><label><input type="radio" name="active_key" value="${esc(p.id)}" ${p.id===config.active_key_id?'checked':''}>${esc(p.name)}</label><button type="button" class="quiet" data-edit-key="${esc(p.id)}">查看 / 编辑</button><button type="button" class="quiet" data-refresh-key="${esc(p.id)}">刷新模型</button></div>`).join('')||'<p class="comfy-help">尚未配置 API Key</p>';
  }
  document.querySelector('#open-inference-settings').onclick=async()=>{
    key.value='';dialog.showModal();status.textContent='读取配置…';
    try{config=await request('/api/settings/service-inference');render();edit(config.active_key_id);status.textContent=config.configured?'已配置 API Key · 可添加多个，单选启用':'尚未配置 API Key';}catch(e){status.textContent=e.message;}
  };
  document.querySelector('#close-inference-settings').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{key.value='';});
  document.querySelector('#new-inference-key').onclick=()=>{edit('');status.textContent='填写名称和 Key，保存后查询模型并启用';key.focus();};
  async function submit(action='save',id=editing){
    const data={action,id,name:form.elements.name.value,api_key:key.value.trim()},controls=[...form.querySelectorAll('input,button')];
    controls.forEach(b=>b.disabled=true);status.textContent='查询并更新配置…';
    try{
      if(action==='test'){const r=await request('/api/settings/service-inference/test',data);models(r.models,true);status.textContent='查询验证通过；如填写新 Key，请保存配置';}
      else{config=await request('/api/settings/service-inference',action==='save'?data:{action,id});render();edit(action==='delete'?config.active_key_id:action==='save'?config.active_key_id:id);status.textContent='已保存 · 当前启用：'+(config.keys.find(p=>p.id===config.active_key_id)?.name||'无');await window.directorStudio?.refreshModels();}
    }catch(e){status.textContent=e.message;render();}
    finally{controls.forEach(b=>b.disabled=false);document.querySelector('#clear-inference').disabled=!editing;}
  }
  list.addEventListener('change',e=>{if(e.target.name==='active_key')submit('select',e.target.value);});
  list.addEventListener('click',e=>{const b=e.target.closest('button');if(b?.dataset.editKey)edit(b.dataset.editKey);if(b?.dataset.refreshKey)submit('refresh',b.dataset.refreshKey);});
  form.onsubmit=e=>{e.preventDefault();submit();};
  document.querySelector('#test-inference').onclick=()=>submit('test');
  document.querySelector('#clear-inference').onclick=()=>submit('delete');
})();
