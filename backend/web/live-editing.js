/* Short database leases: hovering/focusing a card or sequence reserves its edits. */
(() => {
  'use strict';
  const studio=window.directorStudio,client=crypto.randomUUID().replaceAll('-','');
  let projectId=null,leases={},held=new Set(),pending=new Map(),hover=null,focus=null,timer=null,running=false,online=false;
  const label=document.createElement('span');label.id='live-status';label.setAttribute('role','status');document.querySelector('#save-status').after(label);
  const style=document.createElement('style');style.textContent=`
    #live-status{font-size:11px;color:#94a9b7;margin-left:12px}
    .timeline-panel{position:relative}
    .edit-lock-badge{position:absolute;right:38px;top:3px;z-index:12;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;background:#263a43;color:#bde8ff;padding:3px 8px;border-radius:4px;pointer-events:none}
    .edit-locked{outline:1px solid #bd9565}.edit-locked>.edit-lock-badge{background:#48351f;color:#ffdcab}
  `;document.head.append(style);
  const project=()=>studio.currentProject();
  const editable=()=>project()&&!window.directorPublicShare&&(!project().permission||['owner','editor','admin'].includes(project().permission.role));
  const resource=target=>{const el=target?.closest?.('.generation-card[data-card],.timeline-panel');return el?.dataset.editResource||(el?.dataset.card?'card:'+el.dataset.card:null);};
  const mine=key=>held.has(key)&&leases[key]?.client===client&&leases[key].expires>Date.now()/1000+2;
  async function api(id,body){
    const headers={'X-Director-Client':client};if(body){headers['Content-Type']='application/json';headers['X-XSRFToken']=decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'');}
    const response=await fetch('/api/projects/'+id+'/editing',{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
    const data=await response.json();
    if(id===projectId&&data.leases){leases=data.leases;paint();}
    if(!response.ok)throw Error(data.error||'编辑连接中断');return data;
  }
  function paint(){
    for(const el of document.querySelectorAll('.generation-card[data-card],.timeline-panel')){
      const key=resource(el),lease=leases[key],active=lease&&lease.expires>Date.now()/1000,own=active&&lease.client===client;
      el.classList.toggle('edit-locked',!!active&&!own);
      let badge=el.querySelector(':scope > .edit-lock-badge');
      if(!active){badge?.remove();continue;}
      if(!badge){badge=document.createElement('span');badge.className='edit-lock-badge';el.append(badge);}
      badge.textContent=own?'你正在编辑':lease.login+' 正在编辑'+'（其他窗口）';badge.title=badge.textContent;
    }
  }
  async function claim(key){
    if(!key||!editable()||mine(key))return mine(key);
    if(leases[key]?.client!==client&&leases[key]?.expires>Date.now()/1000)return false;
    if(pending.has(key))return pending.get(key);
    const id=projectId;
    const promise=(async()=>{
      try{await studio.save();await api(id,{action:'claim',resource:key});if(id!==projectId)return false;held.add(key);await studio.refreshProject();online=true;paint();return true;}
      catch(error){label.textContent=error.message;return false;}
      finally{pending.delete(key);}
    })();pending.set(key,promise);return promise;
  }
  async function releaseUnused(){
    if(studio.busy()||document.querySelector('dialog[open]'))return;
    for(const key of [...held]){
      if(key===hover||key===focus)continue;
      const id=projectId;
      try{await studio.save();await api(id,{action:'release',resource:key});if(id===projectId)held.delete(key);}catch(error){label.textContent=error.message;}
    }
  }
  // Capture before card/timeline handlers. Unknown or expired leases fail closed.
  function gate(event){
    const key=resource(event.target);if(!key||!editable())return;
    if(event.target.closest('video,audio,[data-tl=play],[data-tl=home],[data-tl=close]'))return;
    if(event.type==='keydown'&&(event.key==='Tab'||event.key==='Escape'))return;
    if(!mine(key)||!online){event.preventDefault();event.stopImmediatePropagation();void claim(key);label.textContent=leases[key]?.client!==client&&leases[key]?.expires>Date.now()/1000?leases[key].login+' 正在编辑':'正在取得编辑权限，请稍后操作';}
  }
  for(const type of ['pointerdown','click','dblclick','keydown','beforeinput','paste','drop','change'])document.addEventListener(type,gate,true);
  document.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey)gate(e);},{capture:true,passive:false});
  document.addEventListener('pointerover',e=>{hover=resource(e.target);if(hover)void claim(hover);},true);
  document.addEventListener('pointerout',e=>{hover=resource(e.relatedTarget);},true);
  document.addEventListener('focusin',e=>{focus=resource(e.target);if(focus)void claim(focus);},true);
  document.addEventListener('focusout',e=>{focus=resource(e.relatedTarget);},true);
  async function tick(){
    if(running)return;running=true;
    try{
      if(!project()||document.querySelector('#editor').hidden||window.directorPublicShare)return;
      if(projectId!==project().block_id){projectId=project().block_id;leases={};held.clear();pending.clear();hover=focus=null;}
      if(editable()){
        await releaseUnused();
        for(const key of [...held]){try{await api(projectId,{action:'claim',resource:key});}catch(error){held.delete(key);label.textContent=error.message;}}
      }
      const status=await api(projectId);online=true;
      if(!studio.busy()&&status.revision!==project()?.body.revision)await studio.refreshProject();
      label.textContent='协作已连接';paint();
    }catch(error){online=false;label.textContent='协作暂停 · '+error.message;paint();}
    finally{running=false;clearTimeout(timer);timer=setTimeout(tick,1000);}
  }
  window.addEventListener('director-project-opened',()=>{projectId=project().block_id;leases={};held.clear();pending.clear();hover=focus=null;online=false;void tick();});
  window.addEventListener('director-project-updated',paint);
  window.addEventListener('director-changed',()=>queueMicrotask(paint));
  window.addEventListener('online',()=>void tick());
  window.directorEditing={client,claim,refresh:tick,held:()=>[...held],locks:()=>structuredClone(leases)};
  // Closing a page stops heartbeats; leases expire after at most 15 seconds.
})();
