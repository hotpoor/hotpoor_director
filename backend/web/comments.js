(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => crypto.randomUUID().replaceAll('-','');
  const sessions = new Map();
  const apiBase = new URL(document.currentScript.src).pathname.replace(/\/static\/comments\.js$/, '');
  function clean(html) {
    const fragment=DOMPurify.sanitize(html,{RETURN_DOM_FRAGMENT:true,
      ALLOWED_TAGS:['p','div','br','strong','b','em','i','u','s','del','blockquote','pre','code','h1','h2','h3','h4','h5','h6','ul','ol','li','hr','a','table','thead','tbody','tr','th','td','img','video','source'],
      ALLOWED_ATTR:['href','src','alt','title','controls','colspan','rowspan'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false});
    for(const el of fragment.querySelectorAll('[src],[href]')) {
      for(const attr of ['src','href'])if(el.hasAttribute(attr)){
        let value=el.getAttribute(attr);
        if(apiBase && /^\/api\//.test(value)){value=apiBase+value;el.setAttribute(attr,value);}
        const local=apiBase&&value.startsWith(apiBase+'/')?value.slice(apiBase.length):value;
        if(!/^https?:\/\//i.test(value)&&!/^\/api\/(assets|outputs)\//.test(local)&&!/^file:\/\//i.test(value))el.removeAttribute(attr);
      }
      if(el.tagName==='A'){el.target='_blank';el.rel='noopener noreferrer';}
      if(el.tagName==='VIDEO'){el.controls=true;el.preload='metadata';}
      if(el.tagName==='IMG')el.loading='lazy';
    }
    const div=document.createElement('div');div.append(fragment);return div.innerHTML;
  }
  const formatted = (format,text) => format==='text'?`<div class="comment-plain">${esc(text)}</div>`:clean(format==='markdown'?marked.parse(text,{async:false}):text);
  const media=item=>window.directorReview.media(item,true);
  function status(s,text) {s.status=text;const el=s.el?.querySelector('.chat-status');if(el)el.textContent=text;}
  function remember(s) {
    try {localStorage.setItem(s.draftKey,JSON.stringify({format:s.format,content:s.content,attachments:s.attachments,requestId:s.requestId}));}
    catch {status(s,'草稿暂无法保存到本机，请发送后再关闭。');}
  }
  function dirty(s) {s.requestId=null;remember(s);}
  function contents(s) {
    s.el.querySelector('.chat-source').hidden=s.format==='rich';
    s.el.querySelector('.chat-rich').hidden=s.format!=='rich';
    s.el.querySelector('.chat-format-tools').hidden=s.format!=='rich';
    s.el.querySelector('.chat-source').value=s.content;
    s.el.querySelector('.chat-rich').innerHTML=s.format==='rich'?clean(s.content):'';
  }
  function attachments(s) {
    s.el.querySelector('.chat-attachments').innerHTML=s.attachments.map((a,i)=>`<div class="chat-attachment">${media(a)}<button type="button" class="quiet chat-annotate" data-chat-annotate="${i}">${a.mime.startsWith('image/')?'框选 / 涂鸦':'引用时间段'}</button><button type="button" class="quiet" data-chat-remove="${i}" aria-label="移除附件 ${i+1}">×</button></div>`).join('');
  }
  function renderMessages(s, bottom=false) {
    const el=s.el;if(!el?.isConnected)return;
    const list=el.querySelector('.chat-messages'),top=list.scrollTop,oldHeight=list.scrollHeight;
    list.innerHTML=s.messages.length?s.messages.map(m=>`<article class="chat-message" data-message-id="${m.id}"><div class="chat-message-meta"><strong>${esc(m.author)}</strong><time>${new Date(m.created_at).toLocaleString('zh-CN',{hour12:false})}</time><span>#${m.seq}</span></div><div class="comment-body">${formatted(m.format,m.content)}</div><div class="chat-message-media">${m.attachments.map((a,i)=>`<div>${media(a)}<button type="button" class="quiet" data-chat-reply="${m.id}:${i}">引用并标注</button></div>`).join('')}</div></article>`).join(''):'<p class="chat-empty">还没有评论。记录想法，或分享一张图片、一段视频。</p>';
    if(bottom)list.scrollTop=list.scrollHeight;
    else list.scrollTop=top+Math.max(0,list.scrollHeight-oldHeight);
    el.querySelector('.chat-older').hidden=!s.prev;
    if(s.chat){el.querySelector('.chat-count').textContent=`${s.chat.message_count} 条 · ${s.chat.pack_count} 包`;el.querySelector('.chat-batch').value=s.chat.batch_size;}
  }
  async function load(s, older=false) {
    while(s.loading)await s.loading;
    if(older&&!s.prev)return;
    let release;s.loading=new Promise(resolve=>{release=resolve;});status(s,'正在读取评论…');
    try {
      const data=await s.ctx.request('/api/chats/'+s.id+'/messages'+(older?'?pack_id='+s.prev:''));
      s.chat=data.chat.body;
      const messages=data.pack?.body.messages||[];
      s.messages=older?[...messages,...s.messages].filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i):messages;
      s.prev=data.pack?.body.prev_id||null;
      renderMessages(s,!older);status(s,'');
      if(!older)refreshOutputs(s);
    }catch(e){status(s,e.message);}finally{s.loading=null;release();}
  }
  async function refreshOutputs(s) {
    if(s.outputLoading){s.outputAgain=true;return;}
    s.outputLoading=true;s.outputPacks ||= new Map();
    try {
      let packId=null;const seen=new Set();
      do {
        const data=await s.ctx.request('/api/chats/'+s.id+'/materials'+(packId?'?pack_id='+packId:''));
        if(!data.pack_id)break;
        if(seen.has(data.pack_id))break;seen.add(data.pack_id);
        const old=s.outputPacks.get(data.pack_id);s.outputPacks.set(data.pack_id,data);
        s.ctx.materialsChanged?.();
        if(old?.sealed)break;
        packId=data.prev_id;
      }while(packId);
    }catch(e){status(s,'关联素材读取失败，可刷新评论重试：'+e.message);}
    finally{s.outputLoading=false;if(s.outputAgain){s.outputAgain=false;refreshOutputs(s);}}
  }
  function outputs(chatId) {
    const s=sessions.get(chatId);if(!s?.outputPacks)return [];
    return [...s.outputPacks.values()].flatMap(p=>p.materials).sort((a,b)=>b.seq-a.seq||a.index-b.index).map(m=>({
      ...structuredClone(m.attachment),key:chatId+':'+m.message_id+':'+m.index,
      commentText:m.text,commentLabel:'评论 #'+m.seq,chat_id:chatId
    }));
  }
  function addAttachment(chatId,item) {
    const s=sessions.get(chatId);if(!s||s.busy)return;
    if(s.attachments.length>=10){status(s,'每条最多 10 个附件');return;}
    const clone=structuredClone(item);delete clone.key;delete clone.commentText;delete clone.commentLabel;delete clone.chat_id;
    s.attachments.push(clone);dirty(s);attachments(s);status(s,'已引用原素材，可添加时间段或图片标注后发送。');
  }
  async function upload(s,files) {
    if(s.busy)return;
    if(files.some(f=>!['image/png','image/jpeg','image/webp','video/mp4','video/webm'].includes(f.type))){status(s,'支持 PNG / JPEG / WebP 图片和 MP4 / WebM 视频');return;}
    if(s.attachments.length+files.length>10){status(s,'每条评论最多 10 个附件');return;}
    s.busy=true;s.el.querySelector('.chat-send').disabled=true;
    try {
      for(const [i,file] of files.entries()){
        if(file.size>(file.type.startsWith('image/')?20:200)*1024*1024)throw Error('图片最多 20 MB，视频最多 200 MB');
        const cloud=window.directorCloud||s.el.querySelector('.chat-upload-destination').value==='cloud';
        let a;
        if(cloud){const r=await directorStorage.uploadFile(file,t=>status(s,t),s.ctx.projectId,{index:i+1,total:files.length});a={source:'cloud',id:r.id,url:r.url,name:r.name,mime:r.mime};}
        else {
          const result=await new Promise((resolve,reject)=>{
            const xhr=new XMLHttpRequest();xhr.open('POST','/api/assets');xhr.setRequestHeader('X-XSRFToken',decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||''));
            xhr.upload.onprogress=e=>status(s,`上传 ${i+1}/${files.length} · ${file.name} · ${e.lengthComputable?Math.floor(e.loaded/e.total*100)+'%':'上传中'}`);
            xhr.onload=()=>{try{const r=JSON.parse(xhr.responseText);if(xhr.status!==200)throw Error(r.error||'上传失败');resolve(r);}catch(e){reject(e);}};
            xhr.onerror=()=>reject(Error('上传连接失败，请重新选择文件'));xhr.timeout=300000;xhr.ontimeout=()=>reject(Error('上传超时'));
            const body=new FormData();body.append('file',file);xhr.send(body);
          });
          a={source:'asset',id:result.id,url:result.url,name:result.name,mime:result.mime};
        }
        s.attachments.push(a);dirty(s);attachments(s);
      }
      status(s,'附件已就绪，点击发送评论。');
    }catch(e){status(s,e.message);}finally{s.busy=false;s.el.querySelector('.chat-send').disabled=false;}
  }
  function mount(el,card,ctx) {
    let s=sessions.get(card.chat_id);
    if(!s){
      const draftKey='director:comment:'+ctx.ownerId+':'+card.chat_id;
      let d={};try{d=JSON.parse(localStorage.getItem(draftKey)||'{}');}catch{}
      s={id:card.chat_id,draftKey,format:d.format||'text',content:d.content||'',attachments:d.attachments||[],requestId:d.requestId||null,messages:[],prev:null,chat:null,status:''};sessions.set(s.id,s);
    }
    s.el=el;s.ctx=ctx;el._commentCard=card;
    el.classList.add('chat-card');
    el.innerHTML=`<header class="card-heading"><span class="card-grip">⠿</span><strong>${esc(card.name||'评论区')}</strong><small class="chat-count"></small><button class="quiet remove-card" title="移除评论区卡片，评论仍保留">✕</button></header><div class="chat-settings"><details><summary>评论区设置</summary><label>名称<input class="chat-name" maxlength="160" value="${esc(card.name||'评论区')}"></label><label>每包条数<input class="chat-batch" type="number" min="25" max="100" step="1" value="${s.chat?.batch_size||50}"></label><button class="quiet chat-save-settings">保存设置</button><small>新包使用新条数，已有包保持原容量。</small><code>chat_id: ${s.id}</code></details><button class="quiet chat-refresh" type="button">刷新评论</button></div><details class="imported-library chat-imported-library"><summary>关联素材</summary></details><button class="quiet chat-older" type="button" hidden>加载更早的一包</button><div class="chat-messages" aria-label="评论记录"></div><form class="chat-composer"><div class="chat-compose-heading"><select class="chat-format" aria-label="评论文字格式"><option value="text">纯文本</option><option value="markdown">Markdown</option><option value="html">HTML 源码</option><option value="rich">富文本编辑</option></select><button type="button" class="quiet chat-preview-toggle">预览</button></div><div class="chat-format-tools" hidden><button type="button" class="quiet" data-chat-command="bold"><b>粗体</b></button><button type="button" class="quiet" data-chat-command="italic"><i>斜体</i></button><button type="button" class="quiet" data-chat-command="underline">下划线</button><button type="button" class="quiet" data-chat-command="insertUnorderedList">列表</button></div><textarea class="chat-source" rows="3" maxlength="100000" placeholder="写下评论… Ctrl / ⌘ + Enter 发送" aria-label="评论内容"></textarea><div class="chat-rich comment-body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="富文本评论" hidden></div><div class="chat-preview comment-body" hidden></div><div class="chat-attachments"></div><details class="chat-additions"><summary>＋ 图片 / 视频附件</summary><div class="chat-file-tools"><select class="chat-upload-destination" aria-label="评论附件存储">${window.directorCloud?'':'<option value="local">上传到本机</option>'}<option value="cloud">直传云存储</option></select><button type="button" class="quiet chat-files-button">选择文件</button><input type="file" class="chat-files" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" multiple hidden></div><div class="chat-url-tools"><select class="chat-url-type" aria-label="地址媒体类型"><option value="image">图片地址</option><option value="video">视频地址</option></select><input class="chat-url" type="url" placeholder="https://…" aria-label="图片或视频地址"><button type="button" class="quiet chat-add-url">添加地址</button></div><div class="chat-reference-tools"><select class="chat-reference" aria-label="引用项目卡片资产"></select><button type="button" class="quiet chat-add-reference">引用卡片资产</button></div></details><div class="chat-send-row"><small>可拖入或粘贴图片、视频 · 每条最多 10 个附件</small><button type="submit" class="chat-send">发送评论 ↗</button></div><p class="chat-status" role="status">${esc(s.status)}</p></form>${['n','s','e','w','ne','nw','se','sw'].map(dir=>`<div class="resize-handle resize-${dir}" data-resize="${dir}"></div>`).join('')}`;
    el.querySelector('.chat-format').value=s.format;contents(s);attachments(s);renderMessages(s);
    const references=()=>{s.references=ctx.materials();const select=el.querySelector('.chat-reference'),value=select.value;select.innerHTML='<option value="">选择图片 / 视频素材或生成结果</option>'+s.references.map((a,i)=>`<option value="${i}">${esc(a.name)}</option>`).join('');select.value=value;};references();
    el.querySelector('.chat-reference').onfocus=references;s.refreshReferences=references;
    const input=()=>{s.content=s.format==='rich'?el.querySelector('.chat-rich').innerHTML:el.querySelector('.chat-source').value;dirty(s);if(!el.querySelector('.chat-preview').hidden)el.querySelector('.chat-preview').innerHTML=formatted(s.format,s.content);};
    el.querySelector('.chat-source').oninput=input;el.querySelector('.chat-rich').oninput=input;
    el.querySelector('.chat-format').onchange=e=>{
      if(s.format==='rich')s.content=clean(s.content);
      s.format=e.target.value;contents(s);dirty(s);el.querySelector('.chat-preview').hidden=true;
    };
    const insertRich=e=>{
      const data=e.clipboardData||e.dataTransfer;if(data.files.length)return;
      e.preventDefault();const html=data.getData('text/html');
      document.execCommand(html?'insertHTML':'insertText',false,html?clean(html):data.getData('text/plain'));input();
    };
    el.querySelector('.chat-rich').onpaste=insertRich;el.querySelector('.chat-rich').ondrop=insertRich;
    for(const button of el.querySelectorAll('[data-chat-command]')){button.onpointerdown=e=>e.preventDefault();button.onclick=()=>{el.querySelector('.chat-rich').focus();document.execCommand(button.dataset.chatCommand,false);input();};}
    el.querySelector('.chat-preview-toggle').onclick=()=>{const p=el.querySelector('.chat-preview');p.hidden=!p.hidden;p.innerHTML=p.hidden?'':formatted(s.format,s.content);};
    el.querySelector('.chat-refresh').onclick=()=>load(s);el.querySelector('.chat-older').onclick=()=>load(s,true);
    el.querySelector('.chat-save-settings').onclick=async()=>{try{const data=await ctx.request('/api/chats/'+s.id,{batch_size:Number(el.querySelector('.chat-batch').value)});s.chat=data.body;card.name=el.querySelector('.chat-name').value.trim()||'评论区';el.querySelector('.card-heading strong').textContent=card.name;ctx.changed();await ctx.save();status(s,'设置已保存');}catch(e){status(s,e.message);}};
    el.querySelector('.chat-files-button').onclick=()=>el.querySelector('.chat-files').click();
    el.querySelector('.chat-files').onchange=e=>{upload(s,[...e.target.files]);e.target.value='';};
    const add=a=>addAttachment(s.id,a);
    el.querySelector('.chat-add-url').onclick=()=>{try{const url=el.querySelector('.chat-url').value.trim(),u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error();const media=el.querySelector('.chat-url-type').value;add({source:'url',url,media,mime:media+'/*',name:'地址附件'});el.querySelector('.chat-url').value='';}catch{status(s,'请输入完整 HTTP / HTTPS 图片或视频地址');}};
    el.querySelector('.chat-add-reference').onclick=()=>{const v=el.querySelector('.chat-reference').value;if(v!==''&&s.references[Number(v)])add(s.references[Number(v)]);else status(s,'请先选择项目卡片的资产');};
    el.querySelector('.chat-attachments').onclick=e=>{const annotate=e.target.closest('[data-chat-annotate]');if(annotate&&!s.busy){const index=Number(annotate.dataset.chatAnnotate);window.directorReview.open(s.attachments[index],review=>{s.attachments[index].review=review;dirty(s);attachments(s);});return;}const b=e.target.closest('[data-chat-remove]');if(b&&!s.busy){s.attachments.splice(Number(b.dataset.chatRemove),1);dirty(s);attachments(s);}};
    el.querySelector('.chat-messages').onclick=e=>{const b=e.target.closest('[data-chat-reply]');if(!b||s.busy)return;const [id,index]=b.dataset.chatReply.split(':');const a=s.messages.find(m=>m.id===id)?.attachments[Number(index)];if(!a||s.attachments.length>=10)return;addAttachment(s.id,a);const i=s.attachments.length-1;window.directorReview.open(s.attachments[i],review=>{s.attachments[i].review=review;dirty(s);attachments(s);});};
    const composer=el.querySelector('.chat-composer');
    composer.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();composer.requestSubmit();}};
    composer.onsubmit=async e=>{
      e.preventDefault();if(s.busy)return;
      if(s.format==='rich'){s.content=clean(s.content);if(!el.querySelector('.chat-rich').textContent.trim()&&!s.content.includes('<img')&&!s.content.includes('<video'))s.content='';}
      if(!s.content.trim()&&!s.attachments.length){status(s,'请输入评论或添加附件');return;}
      if(s.content.length>100000){status(s,'评论正文最多 100000 字符');return;}
      s.requestId ||= uid();remember(s);s.busy=true;el.querySelector('.chat-send').disabled=true;
      const controls=[...composer.querySelectorAll('input,textarea,select,button')];controls.forEach(c=>c.disabled=true);el.querySelector('.chat-rich').contentEditable='false';
      try{await ctx.save();await ctx.request('/api/chats/'+s.id+'/messages',{id:s.requestId,format:s.format,content:s.content,attachments:s.attachments});s.content='';s.attachments=[];s.requestId=null;remember(s);contents(s);attachments(s);el.querySelector('.chat-preview').hidden=true;await load(s);status(s,'评论已发送');}
      catch(e){status(s,e.message+'；内容已保留，可重试发送');}
      finally{s.busy=false;controls.forEach(c=>c.disabled=false);el.querySelector('.chat-rich').contentEditable='true';}
    };
    for(const event of ['drop','paste'])el.addEventListener(event,e=>{const files=[...(event==='drop'?e.dataTransfer?.files:e.clipboardData?.files)||[]];if(files.length){e.preventDefault();e.stopPropagation();upload(s,files);}});
    el.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();e.stopPropagation();}});
    load(s);
  }
  window.directorComments={mount,clean,formatted,outputs,addAttachment,refreshReferences:chatId=>sessions.get(chatId)?.refreshReferences?.(),busy:()=>[...sessions.values()].some(s=>s.busy)};
})();
