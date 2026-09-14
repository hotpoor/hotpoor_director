(() => {
  'use strict';
  const dialog = document.createElement('dialog');
  dialog.id = 'image-preview';
  dialog.setAttribute('aria-label', '图片放大预览');
  dialog.innerHTML = `<header class="preview-toolbar"><div><strong>图片预览</strong><span id="preview-caption"></span></div><button data-action="out" aria-label="缩小">−</button><button data-action="in" aria-label="放大">＋</button><button data-action="actual">100%</button><button data-action="fit">适应窗口</button><button data-action="fullscreen">全屏</button><button data-action="close" aria-label="关闭预览">✕</button></header><div class="preview-stage"><img alt="放大预览图片" draggable="false"><p class="preview-error" hidden>图片加载失败，请检查素材来源与网络。</p></div><footer class="preview-footer"><button data-action="previous" aria-label="上一张">← 上一张</button><span class="preview-counter"></span><span class="preview-help">滚轮缩放 · 拖动查看 · 双击切换原尺寸 · Esc 关闭</span><span class="preview-scale"></span><button data-action="next" aria-label="下一张">下一张 →</button></footer>`;
  dialog.querySelector('[data-action=fullscreen]').insertAdjacentHTML('beforebegin', '<button data-action="copy" disabled title="复制完整图片（Ctrl+C）">复制图片</button>');
  dialog.querySelector('.preview-toolbar>div').insertAdjacentHTML('beforeend', '<span class="preview-copy-status" role="status" aria-live="polite"></span>');
  document.body.append(dialog);
  const stage = dialog.querySelector('.preview-stage'), img = stage.querySelector('img');
  const error = dialog.querySelector('.preview-error');
  const copyButton = dialog.querySelector('[data-action=copy]'), copyStatus = dialog.querySelector('.preview-copy-status');
  const copyMenu = document.createElement('div');
  copyMenu.className = 'preview-copy-menu'; copyMenu.hidden = true; copyMenu.setAttribute('role','menu');
  copyMenu.innerHTML = '<button role="menuitem" data-action="copy">复制图片</button>';
  dialog.append(copyMenu);
  let copying = false, imageVersion = 0;
  let gallery = [], current = 0, scale = 1, x = 0, y = 0, dragging = null, ownsFullscreen = false, origin = null;
  function draw() {
    img.style.transform = `translate(-50%, -50%) translate(${x}px,${y}px) scale(${scale})`;
    dialog.querySelector('.preview-scale').textContent = Math.round(scale * 100) + '%';
  }
  function fit() {
    if (!img.naturalWidth) return;
    scale = Math.min((stage.clientWidth-40)/img.naturalWidth, (stage.clientHeight-40)/img.naturalHeight);
    x = y = 0; draw();
  }
  function zoom(factor, px=0, py=0) {
    const previous = scale;
    scale = Math.max(.01, Math.min(32, scale*factor));
    x = px - (px-x)*scale/previous; y = py - (py-y)*scale/previous; draw();
  }
  function show(index) {
    copyMenu.hidden = true;
    imageVersion++; copyButton.disabled = true; copyStatus.textContent = '';
    current = index; dragging = null; error.hidden = true; img.style.visibility = 'hidden';
    img.src = gallery[index].src;
    dialog.querySelector('#preview-caption').textContent = gallery[index].title;
    dialog.querySelector('.preview-counter').textContent = `${index+1} / ${gallery.length}`;
    dialog.querySelector('[data-action=previous]').disabled = index === 0;
    dialog.querySelector('[data-action=next]').disabled = index === gallery.length-1;
  }
  img.onload = () => { img.style.visibility = ''; copyButton.disabled = copying; fit(); };
  img.onerror = () => { error.hidden = false; copyButton.disabled = true; };
  async function copyImage() {
    if (copying || !img.complete || !img.naturalWidth || !error.hidden) return;
    const version = imageVersion;
    copying = true; copyButton.disabled = true; copyStatus.textContent = '正在复制…';
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) throw Error('当前环境不支持复制图片，请使用桌面工作台或允许剪贴板权限。');
      // Snapshot the selected source before gallery navigation. Cloud images displayed
      // without CORS cannot be exported; read the owned original via the local API.
      const source=gallery[current],remote=new URL(source.src,location.href).origin!==location.origin;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw Error('图片太大，无法准备剪贴板内容。');
      if(!remote)context.drawImage(img,0,0);
      const png=(async()=>{
        if(remote){
          if(!source.copySrc||new URL(source.copySrc,location.href).origin!==location.origin)throw Error('此图片尚未关联云存储素材，请从素材卡片打开后复制。');
          const response=await fetch(source.copySrc);
          if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||'无法读取云存储原图');}
          const bitmap=await createImageBitmap(await response.blob());
          try{canvas.width=bitmap.width;canvas.height=bitmap.height;context.drawImage(bitmap,0,0);}finally{bitmap.close();}
        }
        return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('无法编码图片，请重试。')),'image/png'));
      })();
      await navigator.clipboard.write([new ClipboardItem({'image/png': png})]);
      if (dialog.open && version === imageVersion) copyStatus.textContent = '图片已复制，可直接粘贴';
    } catch (failure) {
      if (dialog.open && version === imageVersion) copyStatus.textContent = failure.name === 'NotAllowedError' ? '未获得剪贴板权限，请允许后重试。' : failure.message || '复制失败，请重试。';
    } finally {
      copying = false;
      copyButton.disabled = !dialog.open || !img.complete || !img.naturalWidth || !error.hidden;
    }
  }
  function open(target) {
    origin = target;
    const card = target.closest('[data-card]');
    const materials = target.closest('.history-materials');
    const images = materials ? [...materials.querySelectorAll('img[data-preview]')] : card ? [...card.querySelectorAll('.history-strip img[data-preview]')] : [target];
    const unique = new Map(images.map(el => [el.dataset.preview, {src:el.dataset.preview,copySrc:el.dataset.previewCopy,title:el.dataset.previewTitle || '图片预览'}]));
    if (!unique.has(target.dataset.preview)) unique.set(target.dataset.preview,{src:target.dataset.preview,copySrc:target.dataset.previewCopy,title:target.dataset.previewTitle || '图片预览'});
    gallery = [...unique.values()];
    dialog.showModal();
    show(gallery.findIndex(item => item.src === target.dataset.preview));
    dialog.querySelector('[data-action=close]').focus({preventScroll:true});
  }
  async function close() {
    copyMenu.hidden = true;
    imageVersion++; copyStatus.textContent = ''; copyButton.disabled = true;
    if (ownsFullscreen && document.fullscreenElement) { ownsFullscreen=false; await document.exitFullscreen().catch(()=>{}); }
    dialog.close(); img.removeAttribute('src'); gallery=[]; dragging=null;
    if (origin?.isConnected) origin.focus({preventScroll:true});
    else document.querySelector('#canvas')?.focus({preventScroll:true});
  }
  async function fullscreen() {
    try {
      if(document.fullscreenElement){ownsFullscreen=false;await document.exitFullscreen();}
      else {await document.documentElement.requestFullscreen();ownsFullscreen=true;}
    } catch {dialog.querySelector('#preview-caption').textContent='当前环境无法进入系统全屏，仍可在窗口内预览。';}
  }
  dialog.addEventListener('cancel', event => {event.preventDefault();close();});
  dialog.addEventListener('click',event=>{
    const action=event.target.closest('[data-action]')?.dataset.action;
    if(action==='close')close();
    if(action==='fit')fit();
    if(action==='actual'){scale=1;x=y=0;draw();}
    if(action==='in')zoom(1.25);
    if(action==='out')zoom(.8);
    if(action==='fullscreen')fullscreen();
    if(action==='copy'){copyMenu.hidden=true;copyImage();}
    if(action==='previous'&&current>0)show(current-1);
    if(action==='next'&&current<gallery.length-1)show(current+1);
  });
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!copyMenu.hidden){event.preventDefault();event.stopPropagation();copyMenu.hidden=true;return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'&&!window.getSelection()?.toString()) {event.preventDefault();copyImage();return;}
    if(event.key==='ArrowLeft'&&current>0){event.preventDefault();show(current-1);}
    if(event.key==='ArrowRight'&&current<gallery.length-1){event.preventDefault();show(current+1);}
    if(event.key==='+'||event.key==='='){event.preventDefault();zoom(1.25);}
    if(event.key==='-'){event.preventDefault();zoom(.8);}
  });
  stage.addEventListener('contextmenu',event=>{
    event.preventDefault();
    if(copyButton.disabled)return;
    copyMenu.hidden=false;
    copyMenu.style.left=Math.max(8,Math.min(event.clientX,window.innerWidth-copyMenu.offsetWidth-8))+'px';
    copyMenu.style.top=Math.max(8,Math.min(event.clientY,window.innerHeight-copyMenu.offsetHeight-8))+'px';
    copyMenu.querySelector('button').focus({preventScroll:true});
  });
  dialog.addEventListener('pointerdown',event=>{if(!copyMenu.contains(event.target))copyMenu.hidden=true;},true);
  stage.addEventListener('wheel',event=>{event.preventDefault();const r=stage.getBoundingClientRect();zoom(Math.exp(-event.deltaY*.0015),event.clientX-r.left-r.width/2,event.clientY-r.top-r.height/2);},{passive:false});
  stage.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();dragging={px:event.clientX,py:event.clientY,x,y};stage.setPointerCapture(event.pointerId);stage.classList.add('dragging');};
  stage.onpointermove=event=>{if(dragging){x=dragging.x+event.clientX-dragging.px;y=dragging.y+event.clientY-dragging.py;draw();}};
  stage.onpointerup=stage.onpointercancel=()=>{dragging=null;stage.classList.remove('dragging');};
  stage.ondblclick=()=>{if(Math.abs(scale-1)<.001)fit();else{scale=1;x=y=0;draw();}};
  document.addEventListener('fullscreenchange',()=>{
    dialog.querySelector('[data-action=fullscreen]').textContent=document.fullscreenElement?'退出全屏':'全屏';
    if(ownsFullscreen&&!document.fullscreenElement){ownsFullscreen=false;close();}
  });
  new ResizeObserver(()=>{if(dialog.open)fit();}).observe(stage);
  document.addEventListener('click',event=>{const target=event.target.closest('img[data-preview]');if(target&&!target.closest('[data-history]')&&!dialog.open)open(target);},true);
  document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('img[data-preview]')&&!event.target.closest('[data-history]')){event.preventDefault();open(event.target);}});
})();
