(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={completed:'已完成',failed:'失败',running:'生成 / 转存中',queued:'排队中',submitting:'提交中',stopping:'停止中',cancelled:'已停止'};
  const stages={submitted:'提交生成',requesting_upstream:'请求上游',upstream_accepted:'收到上游响应',source_received:'收到生成结果',reading_output:'读取结果',uploading_output:'上传云存储',fetching_output:'云端抓取',verifying_output:'校验归档',downloading:'保存本机',archived:'归档完成'};
  const stamp=value=>Number.isFinite(value)?new Date(value).toLocaleString():'未记录';
  const safe=url=>{try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
  const dialog=document.createElement('dialog');dialog.id='project-album';dialog.setAttribute('aria-label','项目相册与生成历史');
  dialog.innerHTML=`<header class="album-heading"><div><span class="eyebrow">PROJECT ALBUM</span><h2>项目相册</h2><p class="album-project"></p></div><button class="quiet album-close" aria-label="关闭项目相册">✕</button></header><div class="album-controls"><input class="album-search" type="search" placeholder="搜索提示词、模型、卡片名称…" aria-label="搜索生成记录"><select class="album-type" aria-label="生成类型"><option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option></select><select class="album-status" aria-label="生成状态"><option value="">全部状态</option>${Object.entries(labels).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select><select class="album-sort" aria-label="记录排序"><option value="new">最新在前</option><option value="old">最早在前</option></select><div class="album-view" role="group" aria-label="展示方式"><button class="quiet" data-album-view="grid" aria-pressed="true">相册</button><button class="quiet" data-album-view="list" aria-pressed="false">列表</button></div><button class="quiet album-refresh">刷新</button></div><p class="album-summary" role="status"></p><div class="album-items"></div><button class="quiet album-more" hidden>加载更多记录</button>`;
  document.body.append(dialog);
  const button=document.createElement('button');button.id='open-project-album';button.className='quiet';button.textContent='项目相册';
  document.querySelector('#edit-project').insertAdjacentElement('afterend',button);
  let projectId=null,rows=[],limit=24,view='grid',version=0;
  function sourceLink(url,label){const href=safe(url);return href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:'';}
  function render(){
    const project=window.directorStudio?.currentProject();if(!dialog.open||project?.block_id!==projectId)return;
    const search=dialog.querySelector('.album-search').value.trim().toLowerCase(),type=dialog.querySelector('.album-type').value,status=dialog.querySelector('.album-status').value;
    const cards=project.body.canvas.cards||[];
    const selected=rows.filter(row=>{const b=row.body,card=cards.find(c=>c.id===b.card_id);return (!type||b.type===type)&&(!status||b.status===status)&&(!search||[b.params?.prompt,b.model,card?.name,row.block_id,b.remote_task_id].some(value=>String(value||'').toLowerCase().includes(search)));}).sort((a,b)=>dialog.querySelector('.album-sort').value==='new'?b.createtime-a.createtime:a.createtime-b.createtime);
    dialog.querySelector('.album-summary').textContent=`${selected.length} / ${rows.length} 条生成记录 · ${selected.reduce((n,row)=>n+(row.body.outputs||[]).length,0)} 个结果 · 包含画布中隐藏及已移除卡片的历史`;
    const container=dialog.querySelector('.album-items');container.dataset.view=view;
    container.innerHTML=selected.slice(0,limit).map(row=>{
      const b=row.body,card=cards.find(c=>c.id===b.card_id),outputs=b.outputs||[],pending=(b.source_outputs||b.pending_outputs||[]).map(o=>typeof o==='string'?o:o?.url);
      const media=outputs.map((output,index)=>{const url='/api/outputs/'+row.block_id+'/'+index;return `<figure>${b.type==='video'?`<video src="${url}" controls preload="metadata" aria-label="结果 ${index+1}"></video>`:`<img src="${url}" data-preview="${url}" data-preview-copy="${url}" data-preview-title="${esc(b.model)} · ${stamp(row.createtime)} · 结果 ${index+1}" tabindex="0" role="button" loading="lazy" alt="生成图片 ${index+1}">`}<figcaption><span>结果 ${index+1}</span><a href="${url}" target="_blank" rel="noopener noreferrer">打开 / 下载</a></figcaption></figure>`;}).join('');
      const params=b.params||{},fields={size:'尺寸',resolution:'分辨率',width:'宽度',height:'高度',ratio:'比例',duration:'时长（秒）',steps:'步数',seed:'种子',quality:'画质',n:'张数',generate_audio:'生成音频'};
      const timeline=(b.generation_timeline||[]).map((e,i,all)=>`<li>${esc(stamp(e.at))} · ${esc(stages[e.stage]||e.stage)}${e.item?' · 结果 '+e.item:''}${all[i+1]?' · 至下一节点 '+(Math.max(0,all[i+1].at-e.at)/1000).toFixed(3)+' 秒':''}</li>`).join('');
      return `<article class="album-record" data-album-job="${esc(row.block_id)}"><header><span class="album-badge">${esc(labels[b.status]||b.status)}</span><time>${esc(stamp(row.createtime))}</time></header><div class="album-media">${media||`<p class="album-no-media">${outputs.length?'结果不可用':b.status==='failed'?'本次生成未完成':b.status==='completed'?'此记录没有可展示的结果':'尚未归档结果'}</p>`}</div><div class="album-record-body"><h3>${esc(card?.name||(b.type==='video'?'视频':'图片')+'生成')}${card?'':' · 原卡片已移除'}</h3><small>${esc(b.model)}</small><p class="album-prompt">${esc(params.prompt||'未填写提示词')}</p><details><summary>记录详情</summary><p class="album-full-prompt">${esc(params.prompt||'未填写提示词')}</p><dl>${Object.entries(fields).filter(([key])=>params[key]!=null).map(([key,label])=>`<dt>${label}</dt><dd>${esc(typeof params[key]==='boolean'?(params[key]?'是':'否'):params[key])}</dd>`).join('')}<dt>任务编号</dt><dd>${esc(row.block_id)}</dd><dt>耗时</dt><dd>${Number.isFinite(b.elapsed_ms)?(b.elapsed_ms/1000).toFixed(3)+' 秒':'未记录'}</dd></dl>${b.error?`<p class="album-error">${esc(b.error)}</p>`:''}${pending.some(safe)?`<h4>上游原始链接 · 可能存在时效</h4><p>收到时间：${esc(stamp(b.source_received_at))}</p><div class="album-source-links">${pending.map((url,i)=>sourceLink(url,'原始结果 '+(i+1)+' · 打开 / 下载')).join('')}</div>`:''}<h4>阶段时间 · 当前浏览器时区</h4>${timeline?'<ol>'+timeline+'</ol>':'<p>此历史任务未记录各阶段时间。</p>'}</details></div></article>`;
    }).join('')||'<p class="album-empty">没有符合条件的生成记录。</p>';
    dialog.querySelector('.album-more').hidden=selected.length<=limit;
  }
  async function refresh(){
    const id=projectId,token=++version;dialog.querySelector('.album-summary').textContent='正在读取项目生成历史…';
    try{const response=await fetch('/api/projects/'+id+'/history');const data=await response.json();if(!response.ok)throw Error(data.error||'读取失败');if(token!==version||!dialog.open||window.directorStudio?.currentProject()?.block_id!==id)return;rows=data.history||[];render();}
    catch(error){if(token===version&&dialog.open)dialog.querySelector('.album-summary').textContent=error.message;}
  }
  button.onclick=()=>{const project=window.directorStudio?.currentProject();if(!project)return;projectId=project.block_id;rows=[];limit=24;dialog.querySelector('.album-project').textContent=project.body.title||'当前项目';dialog.querySelector('.album-search').value='';dialog.querySelector('.album-type').value='';dialog.querySelector('.album-status').value='';dialog.querySelector('.album-items').replaceChildren();dialog.showModal();refresh();};
  dialog.querySelector('.album-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{version++;for(const video of dialog.querySelectorAll('video')){video.pause();video.removeAttribute('src');video.load();}rows=[];});
  dialog.querySelector('.album-refresh').onclick=refresh;
  dialog.querySelectorAll('input,select').forEach(input=>input.addEventListener('input',()=>{limit=24;render();}));
  dialog.querySelectorAll('[data-album-view]').forEach(b=>{b.onclick=()=>{view=b.dataset.albumView;for(const tab of dialog.querySelectorAll('[data-album-view]'))tab.setAttribute('aria-pressed',String(tab===b));render();};});
  dialog.querySelector('.album-more').onclick=()=>{limit+=24;render();};
})();
