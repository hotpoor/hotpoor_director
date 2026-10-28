(() => {
  'use strict';
  const dialog=document.createElement('dialog');dialog.id='wechat-mode';
  dialog.innerHTML=`<header class="wx-heading"><div><span class="wx-brand">微</span><div><strong>微信模式</strong><small>聊天记录档案</small></div></div><button type="button" id="wx-close" class="quiet">返回工作台</button></header><div class="wx-layout"><aside class="wx-sidebar"><button type="button" id="wx-import-open">＋ 导入聊天记录</button><input id="wx-filter" type="search" placeholder="查找会话" aria-label="查找会话"><p id="wx-count"></p><div id="wx-conversations"></div></aside><section class="wx-reader"><header class="wx-reader-heading"><div><h2 id="wx-title">让重要的对话，有处可寻。</h2><p id="wx-meta">导入已有聊天导出文件，按会话浏览与搜索。</p></div><button type="button" id="wx-export" class="quiet" disabled>导出 JSON</button></header><div class="wx-searchbar"><input id="wx-search" type="search" placeholder="搜索当前会话的消息、发送者或时间" aria-label="搜索当前会话" disabled><span id="wx-results"></span></div><div id="wx-messages"><div class="wx-empty"><span>聊</span><h3>你的聊天记录，独立归档。</h3><p>选择左侧会话开始阅读，或导入 JSON、CSV、TXT。<br>可保存到当前账号数据库，也可使用已配置的云存储。</p><p>尚未导入真实记录。微信加密数据库不能直接读取。</p></div></div><footer class="wx-reader-footer"><button type="button" id="wx-more" class="quiet" hidden>加载后续 100 条</button><span id="wx-status" role="status" aria-live="polite"></span></footer></section></div><section id="wx-import-panel" hidden aria-label="导入聊天记录"><header><h2>导入聊天记录</h2><button type="button" id="wx-import-close" class="quiet" aria-label="关闭导入">✕</button></header><p>每个文件导入为独立会话，保留文件中的消息顺序。每次最多 10 MB、20,000 条。重复导入会创建新会话。</p><label>会话名称<input id="wx-import-title" maxlength="200" placeholder="留空使用文件中的标题或文件名"></label><label>保存位置<select id="wx-storage"><option value="database">当前账号数据库</option></select></label><div class="wx-import-actions"><button type="button" id="wx-storage-settings" class="quiet">管理云存储配置</button><button type="button" id="wx-storage-refresh" class="quiet">刷新配置</button></div><p class="wx-privacy">选择云存储时，消息正文使用 AES-256-GCM 加密后上传并回读校验。解密密钥留在当前运行端的账号目录中，请同时备份该目录；更换运行端不会自动带走密钥。图片、语音、视频目前显示导出文件中的文字说明。</p><label class="wx-file">选择导出文件<input id="wx-file" type="file" accept=".json,.csv,.txt"></label><div class="wx-import-actions"><button type="button" id="wx-example" class="quiet">下载 JSON 示例</button><span id="wx-file-name"></span></div><p id="wx-import-status" role="status" aria-live="polite">先选择文件，预览后再确认保存。</p><div id="wx-preview"></div><button type="button" id="wx-confirm" disabled>确认导入</button></section>`;
  document.body.append(dialog);
  const $=s=>dialog.querySelector(s),status=$('#wx-status');
  let conversations=[],selected=null,nextOffset=null,query='',viewVersion=0,fileVersion=0,fileData=null,busy=false;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Error(result.error||result.detail||'请求失败');return result;
  }
  function list(){
    const term=$('#wx-filter').value.trim().toLocaleLowerCase();
    const rows=conversations.filter(r=>r.body.title.toLocaleLowerCase().includes(term));
    $('#wx-count').textContent=`${conversations.length} 个会话`;
    $('#wx-conversations').innerHTML=rows.map(r=>`<button type="button" class="wx-conversation ${selected===r.block_id?'selected':''}" data-id="${esc(r.block_id)}"><span class="wx-avatar">${esc(Array.from(r.body.title)[0]||'聊')}</span><span><strong>${esc(r.body.title)}</strong><small>${r.body.count} 条 · ${esc(r.body.storage==='cloud'?r.body.storage_name:'账号数据库')}</small><small>${esc(r.body.last_time)}</small></span></button>`).join('')||'<p class="wx-list-empty">'+(term?'没有匹配的会话':'还没有导入聊天记录')+'</p>';
  }
  async function refresh(){const result=await request('/api/wechat/conversations');conversations=result.conversations;list();}
  function bubbles(messages){return messages.map(m=>`<article class="wx-message ${m.is_self?'self':''}"><span class="wx-avatar">${esc(Array.from(m.sender)[0]||'?')}</span><div><header><strong>${esc(m.sender)}</strong><time>${esc(m.time)}</time></header><div class="wx-bubble">${m.type!=='text'?`<small class="wx-message-type">${esc(m.type)}</small>`:''}${esc(m.text)}</div></div></article>`).join('');}
  async function loadMessages(append=false){
    if(!selected)return;
    const id=selected,version=++viewVersion,offset=append?nextOffset:0;
    status.textContent='正在读取聊天记录…';$('#wx-more').disabled=true;
    try{
      const result=await request('/api/wechat/conversations/'+id+'?offset='+offset+'&q='+encodeURIComponent(query));
      if(version!==viewVersion||selected!==id)return;
      if(append)$('#wx-messages').insertAdjacentHTML('beforeend',bubbles(result.messages));
      else $('#wx-messages').innerHTML=result.messages.length?bubbles(result.messages):'<div class="wx-empty"><h3>没有匹配的消息</h3><p>试试其他关键词。</p></div>';
      nextOffset=result.next_offset;$('#wx-more').hidden=nextOffset===null;
      $('#wx-results').textContent=`${result.total} 条${query?'匹配消息':'消息'}`;status.textContent='';
      if(!append)$('#wx-messages').scrollTop=0;
    }catch(e){if(version===viewVersion){status.textContent=e.message;$('#wx-more').hidden=true;if(!append)$('#wx-messages').replaceChildren();}}
    finally{if(version===viewVersion)$('#wx-more').disabled=false;}
  }
  async function select(id){selected=id;query='';$('#wx-search').value='';$('#wx-search').disabled=false;$('#wx-export').disabled=false;
    const body=conversations.find(r=>r.block_id===id).body;$('#wx-title').textContent=body.title;$('#wx-meta').textContent=`${body.count} 条消息 · ${body.storage==='cloud'?'加密云归档 · '+body.storage_name:'账号数据库'} · ${body.source_name}`;list();await loadMessages();}
  $('#wx-conversations').onclick=e=>{const button=e.target.closest('[data-id]');if(button)select(button.dataset.id);};
  $('#wx-filter').oninput=list;
  let searchTimer;$('#wx-search').oninput=()=>{clearTimeout(searchTimer);viewVersion++;const id=selected;searchTimer=setTimeout(()=>{if(selected!==id)return;query=$('#wx-search').value.trim();loadMessages();},250);};
  $('#wx-more').onclick=()=>loadMessages(true);
  async function profiles(){
    const selectedValue=$('#wx-storage').value,result=await request('/api/settings/storage');
    $('#wx-storage').innerHTML='<option value="database">当前账号数据库</option>'+Object.entries(result.profiles).map(([id,p])=>`<option value="cloud:${esc(id)}">${esc(p.name)} · ${esc(p.bucket_name)}</option>`).join('');
    if([...$('#wx-storage').options].some(o=>o.value===selectedValue))$('#wx-storage').value=selectedValue;
  }
  function panel(show){if(busy)return;$('#wx-import-panel').hidden=!show;}
  $('#wx-import-open').onclick=async()=>{panel(true);try{await profiles();}catch(e){$('#wx-import-status').textContent=e.message;}};
  $('#wx-import-close').onclick=()=>panel(false);
  $('#wx-storage-settings').onclick=()=>window.directorStorage.open();
  $('#wx-storage-refresh').onclick=()=>profiles().catch(e=>$('#wx-import-status').textContent=e.message);
  $('#wx-file').onchange=async()=>{
    const version=++fileVersion,file=$('#wx-file').files[0];fileData=null;$('#wx-preview').replaceChildren();$('#wx-confirm').disabled=true;
    if(!file)return;
    $('#wx-file-name').textContent=file.name;
    try{
      if(file.size>10*1024*1024)throw Error('文件超过 10 MB，请分批导入');
      $('#wx-import-status').textContent='正在解析与预览…';
      const content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      const payload={request_id:crypto.randomUUID().replaceAll('-',''),name:file.name,content,title:$('#wx-import-title').value.trim()};
      const result=await request('/api/wechat/preview',payload);if(version!==fileVersion)return;
      fileData=payload;$('#wx-preview').innerHTML=bubbles(result.sample);$('#wx-import-status').textContent=`已识别「${result.title}」共 ${result.count} 条消息。下方预览前 ${result.sample.length} 条。`;$('#wx-confirm').disabled=false;
    }catch(e){if(version===fileVersion)$('#wx-import-status').textContent=e.message;}
  };
  $('#wx-confirm').onclick=async()=>{
    if(!fileData||busy)return;busy=true;
    const controls=[...$('#wx-import-panel').querySelectorAll('input,select,button')];controls.forEach(e=>e.disabled=true);
    try{
      const target=$('#wx-storage').value,cloud=target.startsWith('cloud:');
      $('#wx-import-status').textContent=cloud?'正在加密、上传并回读校验，请等待…':'正在保存聊天记录…';
      const result=await request('/api/wechat/conversations',{...fileData,title:$('#wx-import-title').value.trim(),storage:cloud?'cloud':'database',profile_id:cloud?target.slice(6):null});
      await refresh();await select(result.id);$('#wx-import-panel').hidden=true;fileData=null;$('#wx-file').value='';$('#wx-preview').replaceChildren();$('#wx-import-status').textContent='导入完成，可继续选择下一个文件。';status.textContent='导入完成 · '+result.count+' 条消息';
    }catch(e){$('#wx-import-status').textContent=e.message;}
    finally{busy=false;controls.forEach(e=>e.disabled=false);$('#wx-confirm').disabled=!fileData;}
  };
  function saveJson(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('#wx-example').onclick=()=>saveJson({version:1,title:'格式示例（非真实记录）',messages:[{sender:'张三',time:'2026-10-29 09:30:00',text:'这是一条格式示例。',is_self:false},{sender:'我',time:'2026-10-29 09:31:00',text:'支持多行正文。\nCSV 列名为 sender,time,text,is_self。',is_self:true}]},'wechat-format-example.json');
  $('#wx-export').onclick=async()=>{const id=selected;$('#wx-export').disabled=true;try{const result=await request('/api/wechat/conversations/'+id+'/export');saveJson(result,'wechat-'+id+'.json');}catch(e){status.textContent=e.message;}finally{$('#wx-export').disabled=!selected;}};
  $('#wx-close').onclick=()=>{if(!busy)dialog.close();};
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog.addEventListener('close',()=>{viewVersion++;fileVersion++;clearTimeout(searchTimer);fileData=null;$('#wx-file').value='';$('#wx-preview').replaceChildren();$('#wx-confirm').disabled=true;$('#wx-import-panel').hidden=true;});
  document.querySelector('#open-wechat').onclick=async()=>{dialog.showModal();status.textContent='读取会话列表…';try{await refresh();status.textContent='';if(selected&&conversations.some(r=>r.block_id===selected))await loadMessages();}catch(e){status.textContent=e.message;}};
})();
