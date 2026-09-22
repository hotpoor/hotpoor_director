/* A single settings surface, with existing controls and persistence preserved. */
(() => {
  'use strict';
  window.createDirectorDialogueSettings=({root,sections,onEnter})=>{
    const panel=document.createElement('section');panel.id='dialogue-settings-page';panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-label','设置');
    panel.innerHTML='<header><div><span>Director</span><h2>设置</h2></div><button type="button" class="quiet" data-close>返回对话 <span aria-hidden="true">×</span></button></header><div class="dialogue-settings-layout"><nav aria-label="设置分类"></nav><div class="dialogue-settings-content"></div></div>';
    root.append(panel);
    const nav=panel.querySelector('nav'),content=panel.querySelector('.dialogue-settings-content');let page='',previousFocus=null;
    const launcher=document.createElement('button');launcher.type='button';launcher.id='dialogue-settings-launcher';launcher.className='quiet';launcher.innerHTML='<span aria-hidden="true">⚙</span> 设置';launcher.setAttribute('aria-controls',panel.id);launcher.setAttribute('aria-expanded','false');
    const footer=document.createElement('div');footer.className='dialogue-sidebar-footer';footer.append(launcher);root.querySelector('.dialogue-sidebar').append(footer);
    const shortcut=document.createElement('button');shortcut.type='button';shortcut.id='dialogue-settings-shortcut';shortcut.className='quiet';shortcut.textContent='⚙';shortcut.setAttribute('aria-label','设置');shortcut.setAttribute('aria-controls',panel.id);root.querySelector('.dialogue-heading>div').append(shortcut);
    const entries=new Map();
    for(const section of sections){
      const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=section.title;button.dataset.settingsPage=section.id;nav.append(button);
      const body=document.createElement('section');body.className='dialogue-settings-section';body.dataset.settingsSection=section.id;body.hidden=true;body.tabIndex=-1;
      const heading=document.createElement('h3'),description=document.createElement('p');heading.textContent=section.title;description.className='dialogue-settings-description';description.textContent=section.description;body.append(heading,description,...section.nodes);content.append(body);entries.set(section.id,{button,body});button.onclick=()=>open(section.id);
    }
    function open(id='general'){
      if(!entries.has(id))id='general';
      if(panel.hidden)previousFocus=document.activeElement;
      root.dispatchEvent(new CustomEvent('dialogue-overlay-open',{detail:'settings'}));page=id;panel.hidden=false;launcher.setAttribute('aria-expanded','true');
      root.querySelector('.dialogue-layout').inert=true;
      for(const [key,entry] of entries){entry.body.hidden=key!==id;entry.button.setAttribute('aria-current',String(key===id));}
      content.scrollTop=0;entries.get(id).body.focus({preventScroll:true});onEnter?.(id);
    }
    function close(){
      if(panel.hidden)return;panel.hidden=true;page='';launcher.setAttribute('aria-expanded','false');root.querySelector('.dialogue-layout').inert=false;
      const target=previousFocus?.isConnected&&!previousFocus.closest('[hidden]')?previousFocus:launcher;
      if(root.open)target.focus({preventScroll:true});
    }
    launcher.onclick=()=>open();shortcut.onclick=()=>open();panel.querySelector('[data-close]').onclick=close;
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}});
    root.addEventListener('cancel',event=>{if(!panel.hidden){event.preventDefault();close();}});
    root.addEventListener('close',close);
    root.addEventListener('dialogue-overlay-open',event=>{if(event.detail==='models')close();});
    return {open,close,current:()=>page};
  };
})();
