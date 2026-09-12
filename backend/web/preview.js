(() => {
  'use strict';
  const dialog = document.createElement('dialog');
  dialog.id = 'image-preview';
  dialog.setAttribute('aria-label', '图片放大预览');
  dialog.innerHTML = `<header class="preview-toolbar"><div><strong>图片预览</strong><span id="preview-caption"></span></div><button data-action="out" aria-label="缩小">−</button><button data-action="in" aria-label="放大">＋</button><button data-action="actual">100%</button><button data-action="fit">适应窗口</button><button data-action="fullscreen">全屏</button><button data-action="close" aria-label="关闭预览">✕</button></header><div class="preview-stage"><img alt="放大预览图片" draggable="false"><p class="preview-error" hidden>图片加载失败，请确认 ComfyUI 正在运行。</p></div><footer class="preview-footer"><button data-action="previous" aria-label="上一张">← 上一张</button><span class="preview-counter"></span><span class="preview-help">滚轮缩放 · 拖动查看 · 双击切换原尺寸 · Esc 关闭</span><span class="preview-scale"></span><button data-action="next" aria-label="下一张">下一张 →</button></footer>`;
  document.body.append(dialog);
  const stage = dialog.querySelector('.preview-stage'), img = stage.querySelector('img');
  const error = dialog.querySelector('.preview-error');
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
    current = index; dragging = null; error.hidden = true; img.style.visibility = 'hidden';
    img.src = gallery[index].src;
    dialog.querySelector('#preview-caption').textContent = gallery[index].title;
    dialog.querySelector('.preview-counter').textContent = `${index+1} / ${gallery.length}`;
    dialog.querySelector('[data-action=previous]').disabled = index === 0;
    dialog.querySelector('[data-action=next]').disabled = index === gallery.length-1;
  }
  img.onload = () => { img.style.visibility = ''; fit(); };
  img.onerror = () => { error.hidden = false; };
  function open(target) {
    origin = target;
    const card = target.closest('[data-card]');
    const images = card ? [...card.querySelectorAll('.history-strip img[data-preview]')] : [target];
    const unique = new Map(images.map(el => [el.dataset.preview, {src:el.dataset.preview,title:el.dataset.previewTitle || '图片预览'}]));
    if (!unique.has(target.dataset.preview)) unique.set(target.dataset.preview,{src:target.dataset.preview,title:target.dataset.previewTitle || '图片预览'});
    gallery = [...unique.values()];
    dialog.showModal();
    show(gallery.findIndex(item => item.src === target.dataset.preview));
    dialog.querySelector('[data-action=close]').focus({preventScroll:true});
  }
  async function close() {
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
    if(action==='previous'&&current>0)show(current-1);
    if(action==='next'&&current<gallery.length-1)show(current+1);
  });
  dialog.addEventListener('keydown',event=>{
    if(event.key==='ArrowLeft'&&current>0){event.preventDefault();show(current-1);}
    if(event.key==='ArrowRight'&&current<gallery.length-1){event.preventDefault();show(current+1);}
    if(event.key==='+'||event.key==='='){event.preventDefault();zoom(1.25);}
    if(event.key==='-'){event.preventDefault();zoom(.8);}
  });
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
  document.addEventListener('click',event=>{const target=event.target.closest('img[data-preview]');if(target&&!dialog.open)open(target);},true);
  document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('img[data-preview]')){event.preventDefault();open(event.target);}});
})();
