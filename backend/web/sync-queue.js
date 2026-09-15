(() => {
  'use strict';
  const $=s=>document.querySelector(s),operations=new Map();let status={projectId:null,targets:[]};
  const tabs=[$('#queue-generation-tab'),$('#queue-sync-tab')];
  function select(index){tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;$('#'+tab.getAttribute('aria-controls')).hidden=i!==index;});if(index===1){render();window.dispatchEvent(new Event('director-sync-refresh'));}}
  tabs.forEach((tab,i)=>{tab.onclick=()=>select(i);tab.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?1:1-i;select(next);tabs[next].focus();}};});
  const labels={preview:'比较两端版本',push:'上传资源并提交版本',pull:'拉回新副本并回传',receipt:'回传 UUID 对应记录'};
  function element(tag,value){const node=document.createElement(tag);node.textContent=value;return node;}
  function render(){
    const projectId=window.directorStudio.currentProject()?.block_id,container=$('#sync-queue-items');container.replaceChildren();
    if(window.directorCloud){container.append(element('p','请在本地客户端查看同步进度。'));return;}
    if(!projectId){container.append(element('p','请先打开项目。'));return;}
    const targets=status.projectId===projectId?status.targets:[];
    if(!targets.length){const empty=element('div','尚未配置同步云端');empty.className='queue-empty';container.append(empty);return;}
    for(const target of targets){
      const op=operations.get(projectId+':'+target.id),row=element('article','');row.className='queue-item sync-queue-item';row.append(element('strong',target.name));
      const phase=op?.phase==='running'?'正在'+labels[op.action]:op?.phase==='failed'?'同步失败':op?.needsReview?'有差异待处理':target.pending_receipt?'回传待重试':target.enabled?(target.status||'等待同步'):'自动同步未开启';
      row.append(element('p',phase));
      if(op?.phase==='running'){const progress=document.createElement('progress');progress.setAttribute('aria-label',phase);row.append(progress);}
      if(op?.phase==='failed')row.append(element('p',op.error));
      if(op?.phase==='completed')row.append(element('small',labels[op.action]+'已完成'));
      row.append(element('time',target.last_sync?'最近同步：'+new Date(target.last_sync).toLocaleString():'尚无成功同步记录'));
      const actions=element('div','');actions.className='queue-actions';const button=element('button',op?.phase==='failed'||target.pending_receipt?'查看原因 / 重试':'查看差异 / 配置');button.className='quiet';button.disabled=op?.phase==='running';button.onclick=()=>window.dispatchEvent(new CustomEvent('director-sync-open',{detail:{targetId:target.id}}));actions.append(button);row.append(actions);container.append(row);
    }
  }
  window.addEventListener('director-sync-operation',e=>{const d=e.detail;operations.set(d.projectId+':'+d.targetId,d);render();});
  window.addEventListener('director-sync-status',e=>{status=e.detail;render();});
  window.addEventListener('director-changed',render);
})();
