/* Searchable model selection shared with the existing dialogue request state. */
(() => {
  'use strict';
  window.createDirectorModelPicker=({root,input,getProfiles,getKey,onSelect,onRefresh,onManage})=>{
    const trigger=document.createElement('button');trigger.type='button';trigger.id='dialogue-model-trigger';trigger.className='quiet';
    trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls','dialogue-model-panel');
    const title=document.createElement('span'),chevron=document.createElement('span');chevron.textContent='⌄';chevron.setAttribute('aria-hidden','true');trigger.append(title,chevron);
    input.hidden=true;input.closest('label').after(trigger);input.closest('label').hidden=true;
    const panel=document.createElement('section');panel.id='dialogue-model-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','选择模型');
    panel.innerHTML='<header><strong>选择模型</strong><button type="button" class="quiet" data-close aria-label="关闭模型选择">×</button></header><label class="dialogue-model-source">连接<select aria-label="模型来源 AK"></select></label><input type="search" placeholder="搜索模型…" aria-label="搜索模型" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="dialogue-model-results" aria-autocomplete="list"><div id="dialogue-model-results" role="listbox" aria-label="可用模型"></div><p class="dialogue-model-notice" role="status"></p><footer><button type="button" class="quiet" data-refresh>刷新模型</button><button type="button" class="quiet" data-manage>管理连接 ↗</button></footer>';
    root.querySelector('.dialogue-main').append(panel);
    const search=panel.querySelector('input'),source=panel.querySelector('select'),results=panel.querySelector('[role=listbox]'),notice=panel.querySelector('[role=status]'),refreshButton=panel.querySelector('[data-refresh]');
    let visible=[],active=-1,loading=false,revision=0;
    function position(){
      if(panel.hidden)return;
      const main=root.querySelector('.dialogue-main').getBoundingClientRect(),button=trigger.getBoundingClientRect();
      panel.style.left=Math.max(8,Math.min(button.left-main.left,main.width-panel.offsetWidth-8))+'px';
      panel.style.bottom=Math.max(8,main.bottom-button.top+8)+'px';
      panel.style.maxHeight=Math.max(100,button.top-main.top-16)+'px';
    }
    function setActive(index){
      active=visible.length?Math.max(0,Math.min(index,visible.length-1)):-1;
      for(const [i,row] of [...results.children].entries())row.classList.toggle('active',i===active);
      const row=results.children[active];
      if(row){search.setAttribute('aria-activedescendant',row.id);row.scrollIntoView({block:'nearest'});}else search.removeAttribute('aria-activedescendant');
    }
    function choose(index){
      const value=visible[index],profile=getProfiles().find(p=>p.id===source.value);
      if(!value||!profile||input.disabled||loading)return;
      onSelect(profile.id,value.id);close();trigger.focus();
    }
    function render(){
      const profile=getProfiles().find(p=>p.id===source.value),query=search.value.trim().toLocaleLowerCase();
      const ids=new Set();visible=(profile?.models||[]).filter(m=>!ids.has(m.id)&&ids.add(m.id)&&m.id.toLocaleLowerCase().includes(query));
      results.replaceChildren();
      visible.forEach((m,i)=>{
        const row=document.createElement('div');row.id='dialogue-model-option-'+i;row.setAttribute('role','option');
        const selected=profile.id===getKey()&&input.value===m.id;row.setAttribute('aria-selected',String(selected));row.dataset.model=m.id;
        const name=document.createElement('span'),mark=document.createElement('span');name.textContent=m.id;mark.textContent=selected?'✓':'';mark.setAttribute('aria-hidden','true');row.append(name,mark);
        row.onclick=()=>choose(i);row.onpointermove=()=>setActive(i);results.append(row);
      });
      notice.textContent=visible.length?visible.length+' 个可用模型':query?'没有匹配的模型，试试其他关键词。':profile?'此连接暂无可用模型，可刷新或管理连接。':'尚未配置连接，请先添加并启用 AK。';
      setActive(Math.max(0,visible.findIndex(m=>profile?.id===getKey()&&m.id===input.value)));
    }
    function sync(){
      const selected=getProfiles().find(p=>p.id===getKey())?.models?.some(m=>m.id===input.value);
      title.textContent=selected?input.value:'选择模型';trigger.title=selected?input.value+' · '+(getProfiles().find(p=>p.id===getKey())?.name||''):'选择回答模型';
      trigger.setAttribute('aria-label','选择模型，当前：'+(selected?input.value:'未选择'));trigger.disabled=input.disabled;
      if(input.disabled&&!panel.hidden)close();
    }
    function fillSources(preferred=getKey()){
      source.replaceChildren();for(const profile of getProfiles())source.append(new Option(profile.name,profile.id));
      source.value=getProfiles().some(p=>p.id===preferred)?preferred:(getProfiles()[0]?.id||'');source.disabled=!getProfiles().length||loading;
    }
    function close(){panel.hidden=true;trigger.setAttribute('aria-expanded','false');revision++;}
    function open(){
      if(input.disabled)return;root.dispatchEvent(new CustomEvent('dialogue-overlay-open',{detail:'models'}));
      panel.hidden=false;trigger.setAttribute('aria-expanded','true');search.value='';fillSources();render();position();search.focus();
    }
    trigger.onclick=()=>panel.hidden?open():close();panel.querySelector('[data-close]').onclick=()=>{close();trigger.focus();};
    search.oninput=render;source.onchange=()=>{search.value='';render();search.focus();};
    search.onkeydown=event=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(active+(event.key==='ArrowDown'?1:-1));}
      else if(event.key==='Enter'){event.preventDefault();choose(active);}
      else if(event.key==='Home'&&!search.value){event.preventDefault();setActive(0);}
      else if(event.key==='End'&&!search.value){event.preventDefault();setActive(visible.length-1);}
    };
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();trigger.focus();}});
    root.addEventListener('cancel',event=>{if(!panel.hidden){event.preventDefault();close();trigger.focus();}});
    document.addEventListener('pointerdown',event=>{if(!panel.hidden&&!panel.contains(event.target)&&!trigger.contains(event.target))close();});
    root.addEventListener('dialogue-overlay-open',event=>{if(event.detail!=='models')close();});root.addEventListener('close',close);
    panel.querySelector('[data-manage]').onclick=()=>{close();onManage();};
    refreshButton.onclick=async()=>{
      if(loading)return;loading=true;const token=revision,preferred=source.value;refreshButton.disabled=true;source.disabled=true;search.disabled=true;notice.textContent='正在刷新可用模型…';
      try{await onRefresh();sync();if(token===revision&&!panel.hidden){fillSources(preferred);render();position();}}
      catch(error){if(token===revision&&!panel.hidden)notice.textContent=error.message||'刷新失败，请稍后重试。';}
      finally{loading=false;refreshButton.disabled=false;search.disabled=false;source.disabled=!getProfiles().length;}
    };
    input.addEventListener('change',()=>{sync();if(!panel.hidden){fillSources();render();}});
    new MutationObserver(sync).observe(input,{attributes:true,attributeFilter:['disabled']});
    new ResizeObserver(position).observe(root.querySelector('.dialogue-composer-box'));window.addEventListener('resize',position);
    sync();return {sync,close};
  };
})();
