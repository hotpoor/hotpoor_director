(() => {
  'use strict';
  const dialog=document.querySelector('#inference-dialog');
  const section=document.createElement('section');section.id='management-settings';
  section.innerHTML='<h2>管理 AK · 费用与用量查询</h2><p class="mode-note">每个生成 AK 绑定一个管理 AK；多个生成 AK 可共用。管理 AK 支持多个配置，多选启用用于组织汇总，同一组织只计一次。费用范围为整个组织，按生成 Key 分摊的费用为近似值。</p><form id="management-form"><div id="management-key-list"></div><button type="button" id="new-management-key" class="quiet">＋ 添加管理 AK</button><label>管理 AK 名称<input name="name" maxlength="80" required placeholder="例如 主组织 / 视频业务"></label><label>管理 AK<input name="api_key" type="password" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="sk-mgmt-v1-…；编辑时留空保留密钥"></label><div class="comfy-actions"><button type="button" class="quiet" id="delete-management-key">删除此管理 AK</button><button type="button" class="quiet" id="test-management-key">验证管理 AK</button><button type="submit">保存并启用管理 AK</button></div><p id="management-status" role="status" aria-live="polite"></p></form><div class="management-report-filters"><label>查询范围<select id="management-period"><option value="all" selected>全部历史</option><option value="24h">24 小时</option><option value="7d">7 天</option><option value="14d">14 天</option><option value="30d">30 天</option><option value="90d">90 天</option></select></label><label>开始日期（UTC）<input type="date" id="management-from"></label><label>结束日期（UTC）<input type="date" id="management-to"></label></div><button type="button" class="quiet" id="query-management-report">查询启用管理 AK 的组织费用</button><p class="comfy-help">管理凭据独立保存于隐藏文件，不回显。保存与验证只读查询组织身份，不触发生成。本管理 API 文档未提供单条请求费用查询。</p><div id="management-report" aria-live="polite"></div>';
  dialog.append(section);
  const form=section.querySelector('form'),status=document.querySelector('#management-status'),key=form.elements.api_key;
  const editor=document.createElement('div');editor.className='ak-inline-editor';editor.hidden=true;
  const newButton=document.querySelector('#new-management-key');
  let node=newButton.nextSibling;
  while(node){const next=node.nextSibling;if(node!==status)editor.append(node);node=next;}
  form.append(editor);
  function placeEditor(id,open=true){
    editor.hidden=!open;
    const button=[...form.querySelectorAll('[data-edit-management]')].find(b=>b.dataset.editManagement===id);
    if(button)button.closest('.ak-config-item').append(editor);else newButton.after(editor);
    for(const b of form.querySelectorAll('[data-edit-management]')){const expanded=open&&b===button;b.textContent=expanded?'收起编辑':'展开编辑';b.setAttribute('aria-expanded',String(expanded));}
  }
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let config={keys:[]},editing='',busy=false;
  async function request(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'请求失败');return d;}
  function edit(id,open=true){editing=id||'';const p=config.keys.find(p=>p.id===editing);form.elements.name.value=p?.name||'';key.value='';document.querySelector('#delete-management-key').disabled=!p;placeEditor(editing,open);}
  function render(){form.append(editor);document.querySelector('#management-key-list').innerHTML=config.keys.map(p=>`<div class="ak-config-item"><div class="inference-key-row"><label><input type="checkbox" name="active_management" value="${esc(p.id)}" ${(config.enabled_key_ids||[]).includes(p.id)?'checked':''}>${esc(p.name)}</label><small>${esc(p.organization_id)}</small><button type="button" class="quiet" data-edit-management="${esc(p.id)}" aria-expanded="false">展开编辑</button></div></div>`).join('')||'<p>尚未配置管理 AK</p>';}
  function updated(){window.dispatchEvent(new CustomEvent('director-management-updated',{detail:config}));document.querySelector('#management-report').replaceChildren();}
  async function load(){if(busy)return;status.textContent='读取管理 AK…';try{config=await request('/api/settings/service-inference/management');render();edit(config.active_key_id,!config.keys.length);status.textContent=config.configured?'已配置独立管理 AK':'请添加管理 AK，再在生成 AK 中选择绑定';updated();}catch(e){status.textContent=e.message;}}
  document.querySelector('#open-inference-settings').addEventListener('click',load);
  dialog.addEventListener('close',()=>{key.value='';});
  document.querySelector('#new-management-key').onclick=()=>{edit('');status.textContent='填写名称与管理 AK，保存后可绑定生成 AK';key.focus();};
  async function submit(action='save',id=editing,enabled){if(busy)return;busy=true;const controls=[...form.querySelectorAll('input,button')];controls.forEach(c=>c.disabled=true);status.textContent='查询并更新管理配置…';try{const data={action,id,name:form.elements.name.value,api_key:key.value.trim()};if(action==='test'){const r=await request('/api/settings/service-inference/management/test',data);status.textContent='验证通过 · 组织 '+r.organization_id+'（未保存）';}else{config=await request('/api/settings/service-inference/management',action==='save'?data:{action,id,enabled});const wasOpen=!editor.hidden,previous=editing;render();edit(action==='save'?config.active_key_id:previous,action==='save'||(action!=='delete'&&wasOpen));updated();status.textContent='管理配置已保存 · 已启用 '+(config.keys.filter(p=>(config.enabled_key_ids||[]).includes(p.id)).map(p=>p.name).join('、')||'无');}}catch(e){render();status.textContent=e.message;}finally{busy=false;controls.forEach(c=>c.disabled=false);document.querySelector('#delete-management-key').disabled=!editing;}}
  form.onsubmit=e=>{e.preventDefault();submit();};
  document.querySelector('#test-management-key').onclick=()=>submit('test');
  document.querySelector('#delete-management-key').onclick=()=>submit('delete');
  document.querySelector('#management-key-list').addEventListener('change',e=>{if(e.target.name==='active_management')submit('enable',e.target.value,e.target.checked);});
  document.querySelector('#management-key-list').addEventListener('click',e=>{const b=e.target.closest('[data-edit-management]');if(b)edit(b.dataset.editManagement,editor.hidden||editing!==b.dataset.editManagement);});
  let reporting=false;
  async function report(generationId=''){
    if(reporting)return;reporting=true;
    const output=document.querySelector('#management-report'),buttons=[document.querySelector('#query-management-report'),document.querySelector('#query-bound-management')];buttons.forEach(b=>b.disabled=true);output.textContent='查询组织费用…';
    try{const query=new URLSearchParams({period:document.querySelector('#management-period').value});if(generationId)query.set('generation_key_id',generationId);const from=document.querySelector('#management-from').value,to=document.querySelector('#management-to').value;if(from||to){query.set('from',from);query.set('to',to);}const r=await request('/api/service-inference/management/report?'+query);output.innerHTML=(r.reports?`<p>组织费用合计 USD ${esc(r.total_cost_usd)} · ${r.organization_count} 个组织（已去重）</p>`:'')+(r.reports||[r]).map(r=>`<p><strong>${esc(r.key_name)} · 组织 ${esc(r.organization_id)}</strong></p><p>${esc(r.from)} → ${esc(r.to)} · UTC · 组织总费用 USD ${esc(r.total_cost_usd)}</p><p>未定价模型 ${esc(r.unpriced_count??'未提供')} 个${Number(r.unpriced_count)>0?'，汇总费用尚不完整':''}</p><h3>按模型</h3>${r.by_model.map(x=>`<p>${esc(x.model)} · USD ${esc(x.total_cost_usd)}</p>`).join('')||'<p>暂无记录</p>'}<h3>按生成 Key · 近似分摊费用</h3>${r.by_key.map(x=>`<p>${esc(x.apiKeyId)} · USD ${esc(x.total_cost_usd)}</p>`).join('')||'<p>暂无记录</p>'}`).join('<hr>');output.scrollIntoView({block:'nearest'});}catch(e){output.textContent=e.message;}finally{reporting=false;buttons.forEach(b=>b.disabled=false);}
  }
  document.querySelector('#query-management-report').onclick=()=>report();window.directorManagement={report};
})();
