(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
  const num=n=>Number.isFinite(Number(n))?Math.max(0,Math.min(1,Number(n)))*1000:0;
  function shapesMarkup(shapes=[]) {
    return shapes.map(s=>{
      const color=/^#[0-9a-f]{6}$/i.test(s.color)?s.color:'#ff5c5c',width=Math.min(10,Math.max(1,Number(s.width)||3));
      const attrs=`fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"`;
      if(s.type==='rect')return `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}" ${attrs}/>`;
      if(s.type==='path'&&Array.isArray(s.points))return `<polyline points="${s.points.map(p=>`${num(p[0])},${num(p[1])}`).join(' ')}" ${attrs}/>`;
      return '';
    }).join('');
  }
  function media(item,resizable=false) {
    const url=esc(item.url),name=esc(item.name||'附件'),review=item.review;
    const image=item.mime.startsWith('image/');
    const visual=image?(review?.shapes?.length?`<div class="review-image-inline" data-review-view><img src="${url}" alt="${name}" loading="lazy"><svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="图片 SVG 标注">${shapesMarkup(review.shapes)}</svg></div>`:`<img src="${url}" alt="${name}" loading="lazy" data-preview="${url}" data-preview-copy="${item.source==='cloud'?'/api/storage/uploads/'+esc(item.id)+'/image':''}" data-preview-title="${name}" role="button" tabindex="0">`):`<video src="${url}" controls preload="metadata" aria-label="${name}" ${review?.kind==='video'?`data-review-start="${review.start}" data-review-end="${review.end}"`:''}></video>`;
    return `<figure class="review-media" data-review-item="${esc(JSON.stringify(item))}">${resizable?`<div class="review-resizable">${visual}<button type="button" class="review-size-handle" aria-label="调整媒体预览大小" title="拖动调整预览宽高；双击恢复缩略图"></button></div>`:visual}<figcaption>${name}${review?.kind==='video'?` · ${time(review.start)} – ${time(review.end)}`:review?.shapes?.length?` · ${review.shapes.length} 处标注`:''}</figcaption>${review?`<button type="button" class="quiet" data-review-view>${image?'查看标注':'播放引用片段'}</button>`:''}</figure>`;
  }
  function bindVideo(video) {
    if(video._reviewBound||!video.hasAttribute('data-review-start'))return;
    video._reviewBound=true;let raf;
    const range=()=>[Number(video.dataset.reviewStart),Math.min(Number(video.dataset.reviewEnd),Number.isFinite(video.duration)?video.duration:Infinity)];
    const tick=()=>{
      if(video.paused)return;
      if(!video.isConnected){video.pause();return;}
      const [start,end]=range();
      if(video.currentTime>=end){video.pause();video.currentTime=end;return;}
      if(video.currentTime<start)video.currentTime=start;
      raf=requestAnimationFrame(tick);
    };
    video.addEventListener('play',()=>{cancelAnimationFrame(raf);const [start,end]=range();if(start>=end){video.pause();return;}if(video.currentTime<start||video.currentTime>=end)video.currentTime=start;tick();});
    video.addEventListener('pause',()=>cancelAnimationFrame(raf));
    video.addEventListener('timeupdate',()=>{const [,end]=range();if(!video.paused&&video.currentTime>=end){video.pause();video.currentTime=end;}});
  }
  // Presentation-only sizing: keep the original file and review coordinates unchanged.
  function fitPreview(box) {
    const frame=box.querySelector('.review-image-inline'),img=box.querySelector('img');
    if(!frame||!img?.naturalWidth)return;
    const scale=Math.min(box.clientWidth/img.naturalWidth,box.clientHeight/img.naturalHeight);
    frame.style.width=img.naturalWidth*scale+'px';
    frame.style.height=img.naturalHeight*scale+'px';
  }
  document.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.review-size-handle');if(!handle||e.button!==0)return;
    e.preventDefault();e.stopPropagation();
    const box=handle.parentElement,r=box.getBoundingClientRect(),scale=r.width/box.offsetWidth||1;
    const w=box.offsetWidth,h=box.offsetHeight,x=e.clientX,y=e.clientY;
    const item=box.closest('.chat-message-media>div');
    const bounds=box.closest('.chat-message-media')||box.closest('.chat-attachments');
    const max=Math.max(100,bounds?.clientWidth||600);
    box.classList.add('review-custom-size');item?.classList.add('review-expanded-item');
    box.style.width=Math.min(w,max)+'px';box.style.height=h+'px';fitPreview(box);
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove=event=>{
      event.preventDefault();event.stopPropagation();
      box.style.width=Math.max(100,Math.min(max,w+(event.clientX-x)/scale))+'px';
      box.style.height=Math.max(70,Math.min(800,h+(event.clientY-y)/scale))+'px';fitPreview(box);
    };
    const finish=()=>{handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;};
    handle.onpointerup=finish;handle.onpointercancel=finish;
  },true);
  document.addEventListener('dblclick',e=>{
    if(!e.target.closest('.review-size-handle'))return;e.preventDefault();e.stopPropagation();
    const box=e.target.closest('.review-resizable');box.classList.remove('review-custom-size');box.removeAttribute('style');
    box.querySelector('.review-image-inline')?.removeAttribute('style');box.closest('.review-expanded-item')?.classList.remove('review-expanded-item');
  });
  document.addEventListener('load',e=>{const box=e.target.closest?.('.review-custom-size');if(box)fitPreview(box);},true);
  const dialog=document.createElement('dialog');dialog.id='media-review-dialog';document.body.append(dialog);
  let current=null;
  function open(item,onSave=null) {
    if(dialog.open)return;
    const image=item.mime.startsWith('image/');
    current={item:structuredClone(item),onSave,image,shapes:structuredClone(item.review?.shapes||[]),stroke:null,mode:'rect'};
    const q=sel=>dialog.querySelector(sel),editable=!!onSave;
    dialog.innerHTML=`<div class="dialog-heading"><h2>${editable?(image?'图片位置标注':'视频片段引用'):(image?'查看图片标注':'播放视频引用')}</h2><button type="button" class="quiet review-close" aria-label="关闭标注">✕</button></div><p class="comfy-help">${esc(item.name)} · 引用原文件，标注单独保存。</p><div class="review-tools" ${!image||!editable?'hidden':''}><button type="button" class="quiet selected" data-review-tool="rect">框选</button><button type="button" class="quiet" data-review-tool="path">涂鸦</button><label>颜色<input type="color" class="review-color" value="#ff5c5c"></label><button type="button" class="quiet review-undo">撤销一笔</button><button type="button" class="quiet review-clear">清空标注</button></div><div class="review-stage">${image?`<div class="review-image-frame"><img src="${esc(item.url)}" alt="标注原图" draggable="false"><svg class="review-draw" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="拖动框选或涂鸦" ${!editable?'style="pointer-events:none"':''}></svg></div>`:`<video src="${esc(item.url)}" controls preload="metadata" class="review-video"></video>`}</div><div class="review-range" ${image?'hidden':''}><label>开始 / 秒<input class="review-start" type="number" min="0" step="0.01" value="${item.review?.start??0}" ${!editable?'readonly':''}></label><label>结束 / 秒<input class="review-end" type="number" min="0" step="0.01" value="${item.review?.end??''}" ${!editable?'readonly':''}></label><button type="button" class="quiet review-mark-start" ${!editable?'hidden':''}>当前位置为开始</button><button type="button" class="quiet review-mark-end" ${!editable?'hidden':''}>当前位置为结束</button><button type="button" class="quiet review-play">播放选段</button></div><p class="review-status" role="status"></p><div class="review-footer"><button type="button" class="quiet review-cancel">${editable?'取消':'关闭'}</button><button type="button" class="review-save" ${!editable?'hidden':''}>保存引用标注</button></div>`;
    dialog.showModal();
    const say=t=>q('.review-status').textContent=t;
    const close=()=>dialog.close();q('.review-close').onclick=close;q('.review-cancel').onclick=close;
    if(image){
      const img=q('.review-image-frame img'),frame=q('.review-image-frame'),svg=q('.review-draw');
      img.onload=()=>{const ratio=img.naturalWidth/img.naturalHeight;frame.style.aspectRatio=String(ratio);frame.style.width=Math.min(img.naturalWidth,innerHeight*.48*ratio,850)+'px';say(editable?'拖动绘制框选；切换涂鸦可自由圈出问题位置。':'标注与原图按比例叠加。');};
      img.onerror=()=>say('原图无法加载，请检查素材地址或服务。');
      const paint=()=>{svg.innerHTML=shapesMarkup([...current.shapes,...(current.stroke?[current.stroke]:[])]);};paint();
      for(const b of dialog.querySelectorAll('[data-review-tool]'))b.onclick=()=>{current.mode=b.dataset.reviewTool;for(const x of dialog.querySelectorAll('[data-review-tool]'))x.classList.toggle('selected',x===b);};
      q('.review-undo').onclick=()=>{current.shapes.pop();paint();};q('.review-clear').onclick=()=>{current.shapes=[];paint();};
      const point=e=>{const r=svg.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];};
      let start;
      svg.onpointerdown=e=>{
        if(!editable||e.button!==0||!img.naturalWidth)return;
        e.preventDefault();e.stopPropagation();if(current.shapes.length>=50){say('最多 50 处标注');return;}
        start=point(e);current.stroke={type:current.mode,color:q('.review-color').value,width:3,...(current.mode==='rect'?{x:start[0],y:start[1],w:0,h:0}:{points:[start]})};svg.setPointerCapture(e.pointerId);paint();
      };
      svg.onpointermove=e=>{if(!current.stroke)return;e.preventDefault();const p=point(e),s=current.stroke;
        if(s.type==='rect')Object.assign(s,{x:Math.min(p[0],start[0]),y:Math.min(p[1],start[1]),w:Math.abs(p[0]-start[0]),h:Math.abs(p[1]-start[1])});
        else if(s.points.length<1000){const last=s.points.at(-1);if(Math.hypot(p[0]-last[0],p[1]-last[1])>.002)s.points.push(p);}
        paint();};
      svg.onpointerup=e=>{if(!current.stroke)return;svg.onpointermove(e);const s=current.stroke;if(s.type==='rect'?s.w>.001&&s.h>.001:s.points.length>1)current.shapes.push(s);current.stroke=null;paint();};
      svg.onpointercancel=()=>{current.stroke=null;paint();};
    }else{
      const v=q('video');
      v.onloadedmetadata=()=>{if(!q('.review-end').value&&Number.isFinite(v.duration))q('.review-end').value=Math.min(86400,v.duration).toFixed(3);say('原视频时长 '+(Number.isFinite(v.duration)?time(v.duration):'未知'));if(item.review)v.currentTime=Math.min(item.review.start,v.duration);};
      v.onerror=()=>say('原视频无法加载，请检查素材地址或编码。');
      q('.review-mark-start').onclick=()=>{q('.review-start').value=v.currentTime.toFixed(3);};q('.review-mark-end').onclick=()=>{q('.review-end').value=v.currentTime.toFixed(3);};
      q('.review-play').onclick=()=>{try{const r=getRange();v.dataset.reviewStart=r.start;v.dataset.reviewEnd=r.end;bindVideo(v);v.currentTime=r.start;v.play().catch(()=>say('视频暂时无法播放'));}catch(e){say(e.message);}};
    }
    function getRange(){
      const start=Number(q('.review-start').value),end=Number(q('.review-end').value),duration=q('video').duration;
      if(!q('.review-end').value||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>86400)throw Error('请填写有效的开始和结束秒数');
      if(Number.isFinite(duration)&&(start>=duration||end>duration+.05))throw Error('选段范围不能超过视频时长');
      return {kind:'video',start,end};
    }
    q('.review-save').onclick=()=>{try{
      const review=image?{kind:'image',shapes:current.shapes}:getRange();
      if(image&&current.shapes.reduce((n,s)=>n+(s.points?.length||0),0)>4000)throw Error('笔迹过多，请撤销部分笔迹');
      onSave(review);close();
    }catch(e){say(e.message);}};
  }
  dialog.addEventListener('close',()=>{dialog.querySelector('video')?.pause();dialog.innerHTML='';current=null;});
  document.addEventListener('play',e=>{if(e.target instanceof HTMLVideoElement)bindVideo(e.target);},true);
  document.addEventListener('loadedmetadata',e=>{if(e.target instanceof HTMLVideoElement)bindVideo(e.target);},true);
  document.addEventListener('click',e=>{
    const button=e.target.closest('[data-review-view]');if(!button)return;
    const figure=button.closest('[data-review-item]');if(!figure)return;e.preventDefault();
    const item=JSON.parse(figure.dataset.reviewItem);
    if(item.review?.kind==='video'){
      const v=figure.querySelector('video');bindVideo(v);v.currentTime=item.review.start;v.play().catch(()=>open(item));
    }else open(item);
  });
  window.directorReview={media,open,shapesMarkup,bindVideo};
})();
