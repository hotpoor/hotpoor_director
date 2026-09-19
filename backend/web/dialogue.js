(() => {
  'use strict';
  const dialog=document.createElement('dialog');dialog.id='dialogue-mode';
  dialog.innerHTML=`<header class="dialogue-heading"><div><small>SERVICE-INFERENCE / 对话模式</small><h2>把问题，交给你选择的模型。</h2></div><button type="button" class="quiet" id="close-dialogue">返回工作台</button></header><div class="dialogue-layout"><aside class="dialogue-sidebar"><div class="dialogue-sidebar-actions"><button type="button" id="new-dialogue">＋ 新对话</button><button type="button" id="new-dialogue-category" class="quiet">＋ 分类</button><button type="button" id="toggle-archived" class="quiet" aria-pressed="false">归档</button></div><div id="dialogue-list" aria-label="我的对话"></div></aside><section class="dialogue-main"><section id="dialogue-info" aria-label="对话信息"><div class="dialogue-info-row"><label class="dialogue-editor-label" data-label="标题">标题<div id="dialogue-title" class="dialogue-inline-edit" contenteditable="true" role="textbox" data-placeholder="输入对话标题" data-maxlength="120" aria-label="对话标题"></div></label><label>分类<input id="dialogue-category" list="dialogue-category-options" autocomplete="off" placeholder="点击或输入搜索分类"><datalist id="dialogue-category-options"></datalist></label></div><div class="dialogue-info-row"><label class="dialogue-editor-label" data-label="描述">描述<div id="dialogue-description" class="dialogue-inline-edit" contenteditable="true" role="textbox" data-placeholder="补充这组对话的主题或用途" data-maxlength="1000" aria-label="对话描述"></div></label><button type="button" id="dialogue-archive" class="quiet">归档对话</button></div></section><div class="dialogue-controls"><label>使用 AK<input id="dialogue-key" list="dialogue-key-options" autocomplete="off" placeholder="点击或输入搜索 AK"><datalist id="dialogue-key-options"></datalist></label><label>回答模型<input id="dialogue-model" list="dialogue-model-options" autocomplete="off" placeholder="点击或输入搜索模型"><datalist id="dialogue-model-options"></datalist></label><label>接口<select id="dialogue-protocol"><option value="auto">自动选择</option><option value="responses">Responses</option><option value="chat">Chat Completions</option></select></label><button type="button" class="quiet" id="dialogue-refresh">刷新可用模型</button><button type="button" class="quiet" id="dialogue-settings">配置 AK</button><button type="button" class="quiet" id="dialogue-toggle-preferences" aria-expanded="false" aria-controls="dialogue-preferences-panel">对话设置</button></div><div id="dialogue-preferences-panel" hidden><div class="dialogue-preferences"><label class="dialogue-font-control">字体大小<div><input id="dialogue-font" type="range" min="0" max="4" step="1" value="2" list="dialogue-font-stops" aria-label="对话字体大小"><output id="dialogue-font-label" for="dialogue-font">中</output></div><datalist id="dialogue-font-stops"><option value="0" label="较小"></option><option value="1" label="小"></option><option value="2" label="中"></option><option value="3" label="大"></option><option value="4" label="较大"></option></datalist></label><label>历史轮次<input id="dialogue-context-turns" type="number" min="0" max="100" value="20"></label><label>每包轮次<input id="dialogue-pack-size" type="number" min="1" max="100" value="25"></label><label>折叠最小宽度<input id="dialogue-card-width" type="number" min="240" max="1600" value="520"></label><label>折叠最小高度<input id="dialogue-card-height" type="number" min="120" max="900" value="240"></label><button type="button" class="quiet" id="dialogue-save-options">保存对话配置</button></div><p class="dialogue-note">历史轮次决定每次发送给模型的成功问答数量，0 表示只发送当前问题；每包轮次决定记录包容量，每轮都会立即保存。修改容量不重排旧记录。</p></div><button type="button" class="quiet" id="dialogue-older" hidden>加载更早记录</button><div id="dialogue-transcript" aria-live="polite"></div><p id="dialogue-status" role="status"></p><button type="button" class="quiet" id="dialogue-acknowledge" hidden>已核对中断请求，继续对话</button><form id="dialogue-compose"><label for="dialogue-question">你的问题</label><textarea id="dialogue-question" rows="3" maxlength="20000" placeholder="选择模型，开始提问…" required></textarea><div class="dialogue-attachment-tools"><button type="button" id="dialogue-add-file" class="quiet">＋ 添加文件</button><input type="file" id="dialogue-file-input" multiple hidden accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.py,.sh,.sql,.log,.toml,.ini,.c,.cpp,.h,.java,.go,.rs,.vue"><small>可拖入文件或粘贴图片 · 最多 5 个，每个 10 MB · 图片 / PDF 需模型支持</small></div><div id="dialogue-draft-files"></div><div class="dialogue-send-row"><small>Enter 换行 · Ctrl / ⌘ + Enter 发送</small><button id="dialogue-send" type="submit">发送问题</button></div></form></section></div>`;
  document.querySelector('#studio').append(dialog);
  const $=selector=>dialog.querySelector(selector),key=$('#dialogue-key'),model=$('#dialogue-model'),status=$('#dialogue-status'),question=$('#dialogue-question');
  let inventory={keys:[]},categories=[],showArchived=false,currentBody=null,metadataTimer=null,current='',turns=[],older=null,timer=null,generation=0,busy=false,pending=false,requestId='',requestQuestion='',draftFiles=[];
  const storedSet=name=>{try{return new Set(JSON.parse(localStorage.getItem(name)||'[]'));}catch{return new Set();}},collapsed=storedSet('dialogue-collapsed-answers'),openDirectories=storedSet('dialogue-open-directories'),contextExpanded=new Set(),contextCache=new Map();
  const makeId=()=>crypto.randomUUID().replaceAll('-','');
  async function api(path,body){
    const response=await fetch('/api/dialogue/'+path,{method:body===undefined?'GET':'POST',headers:{...(body instanceof FormData?{}:{'Content-Type':'application/json'}),'X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Error(result.error||result.detail||'请求失败');return result;
  }
  const editText=id=>$(id).textContent.trim();
  function setEditText(id,value){const element=$(id);if(document.activeElement!==element)element.textContent=value||'';}
  function metadataPayload(archived=Boolean(currentBody?.archived)){
    const category=categories.find(item=>item.body.name===$('#dialogue-category').value.trim());
    if($('#dialogue-category').value.trim()&&!category)throw Error('请选择已有分类，或先新建分类');
    return {action:'metadata',title:editText('#dialogue-title'),description:editText('#dialogue-description'),category_id:category?.block_id||null,archived};
  }
  function controls(){
    $('#dialogue-save-options').disabled=busy||pending;$('#dialogue-send').disabled=busy||pending||!model.value;$('#new-dialogue').disabled=busy;$('#new-dialogue-category').disabled=busy;$('#close-dialogue').disabled=busy;question.disabled=busy;$('#dialogue-add-file').disabled=busy;for(const b of $('#dialogue-draft-files').querySelectorAll('button'))b.disabled=busy;
    for(const item of [key,model,$('#dialogue-protocol'),$('#dialogue-refresh'),$('#dialogue-settings'),$('#dialogue-context-turns'),$('#dialogue-pack-size'),$('#dialogue-card-width'),$('#dialogue-card-height'),$('#dialogue-save-options')])item.disabled=busy||(pending&&item.id==='dialogue-save-options');
    for(const item of [$('#dialogue-category'),$('#dialogue-archive')])item.disabled=busy||!current;
    for(const item of [$('#dialogue-title'),$('#dialogue-description')]){item.contentEditable=String(Boolean(current&&!busy));item.setAttribute('aria-disabled',String(Boolean(busy||!current)));}
  }
  function fileLink(file){
    const link=document.createElement('a');link.href='/api/dialogue/files/'+file.id;link.download=file.name;link.textContent=file.name+' · '+(file.size<1024?file.size+' B':(file.size/1024).toFixed(1)+' KB');link.className='dialogue-file-link';return link;
  }
  function fileView(file){
    if(file.format!=='image')return fileLink(file);
    const card=document.createElement('div');card.className='dialogue-image-file';
    const img=document.createElement('img');img.src='/api/dialogue/files/'+file.id;img.alt=file.name;img.dataset.preview=img.src;img.dataset.previewTitle=file.name;img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','查看图片：'+file.name);img.className='dialogue-image-thumbnail';
    card.append(img,fileLink(file));return card;
  }
  function options(){
    const context_turns=Number($('#dialogue-context-turns').value),pack_size=Number($('#dialogue-pack-size').value);
    if(!$('#dialogue-context-turns').value||!Number.isInteger(context_turns)||context_turns<0||context_turns>100||!Number.isInteger(pack_size)||pack_size<1||pack_size>100)throw Error('历史轮次为 0–100，每包轮次为 1–100，均需整数');
    const card_width=Number($('#dialogue-card-width').value),card_height=Number($('#dialogue-card-height').value);if(!Number.isInteger(card_width)||card_width<240||card_width>1600||!Number.isInteger(card_height)||card_height<120||card_height>900)throw Error('折叠卡片宽度为 240–1600，高度为 120–900，均需整数');
    return {context_turns,pack_size,card_width,card_height};
  }
  const fontSizes=[13,15,18,21,24],fontLabels=['较小','小','中','大','较大'],savedFont=localStorage.getItem('dialogue-font');
  const savedFontIndex=fontSizes.indexOf(Number(savedFont));$('#dialogue-font').value=/^[0-4]$/.test(savedFont||'')?savedFont:String(savedFontIndex>=0?savedFontIndex:2);
  function font(){const level=Number($('#dialogue-font').value),size=fontSizes[level];dialog.style.setProperty('--dialogue-answer-font',size+'px');dialog.style.setProperty('--dialogue-ui-font',Math.max(12,size-2)+'px');$('#dialogue-font-label').value=fontLabels[level];localStorage.setItem('dialogue-font',String(level));}
  $('#dialogue-font').oninput=font;font();
  $('#dialogue-card-width').value=localStorage.getItem('dialogue-card-width')||'520';$('#dialogue-card-height').value=localStorage.getItem('dialogue-card-height')||'240';
  const cardSizes=()=>{try{return JSON.parse(localStorage.getItem('dialogue-card-sizes')||'{}');}catch{return {};}};
  const answerFonts=()=>{try{return JSON.parse(localStorage.getItem('dialogue-answer-fonts')||'{}');}catch{return {};}};
  const turnKey=turnId=>current+':'+turnId;
  const saveCollapsed=()=>localStorage.setItem('dialogue-collapsed-answers',JSON.stringify([...collapsed]));
  function cardSize(turnId){const saved=cardSizes()[current+':'+turnId];return saved||{width:Number($('#dialogue-card-width').value),height:Number($('#dialogue-card-height').value)};}
  function applyCardSize(response,turnId){const size=cardSize(turnId);response.style.setProperty('--dialogue-card-min-width',$('#dialogue-card-width').value+'px');response.style.setProperty('--dialogue-card-min-height',$('#dialogue-card-height').value+'px');response.style.width=size.width+'px';response.style.height=size.height+'px';}
  function clearCardSize(response){response.style.width='';response.style.height='';}
  function saveCardSize(response,turnId,notify=false){if(!response.classList.contains('dialogue-answer-collapsed'))return;const sizes=cardSizes(),rect=response.getBoundingClientRect();sizes[current+':'+turnId]={width:Math.round(rect.width),height:Math.round(rect.height)};localStorage.setItem('dialogue-card-sizes',JSON.stringify(sizes));if(notify)status.textContent='折叠尺寸已保存';}
  function applyAnswerFont(response,turnId){const level=answerFonts()[turnKey(turnId)];response.style.fontSize=Number.isInteger(level)?fontSizes[level]+'px':'';}
  function setAnswerFont(response,turnId,level,button,output){const fonts=answerFonts(),key=turnKey(turnId);fonts[key]=level;localStorage.setItem('dialogue-answer-fonts',JSON.stringify(fonts));applyAnswerFont(response,turnId);button.title='调整此回答字号（当前：'+fontLabels[level]+'）';button.setAttribute('aria-label',button.title);output.value=fontLabels[level];status.textContent='此回答字号已保存：'+fontLabels[level];}
  $('#dialogue-toggle-preferences').onclick=()=>{const panel=$('#dialogue-preferences-panel'),expanded=panel.hidden;panel.hidden=!expanded;$('#dialogue-toggle-preferences').setAttribute('aria-expanded',String(expanded));$('#dialogue-toggle-preferences').textContent=expanded?'收起设置':'对话设置';};
  $('#dialogue-save-options').onclick=async()=>{
    if(busy||pending)return;busy=true;controls();
    try{const values=options();localStorage.setItem('dialogue-card-width',String(values.card_width));localStorage.setItem('dialogue-card-height',String(values.card_height));const {card_width,card_height,...conversationOptions}=values;const result=await api(current?'conversations/'+current:'conversations',current?{action:'configure',...conversationOptions}:conversationOptions);apply(result);await loadList();status.textContent='对话配置已保存，下一次提问生效';}catch(e){status.textContent=e.message;}finally{busy=false;controls();}
  };
  function renderDraft(){
    const list=$('#dialogue-draft-files');list.replaceChildren();
    for(const file of draftFiles){const item=document.createElement('div');item.className='dialogue-draft-file';item.append(fileView(file));const remove=document.createElement('button');remove.type='button';remove.className='quiet dialogue-remove-file';remove.textContent='移除';remove.disabled=busy;remove.onclick=()=>{draftFiles=draftFiles.filter(f=>f.id!==file.id);requestId='';renderDraft();};item.append(remove);list.append(item);}
  }
  function clearDraft(){draftFiles=[];renderDraft();}
  async function addFiles(files){
    if(busy||!files.length)return;
    if(draftFiles.length+files.length>5){status.textContent='每次最多添加 5 个文件';return;}
    if(files.some(f=>f.size>10*1024*1024)||files.reduce((n,f)=>n+f.size,0)+draftFiles.reduce((n,f)=>n+f.size,0)>20*1024*1024){status.textContent='单个文件最多 10 MB，本次附件合计最多 20 MB';return;}
    busy=true;controls();renderDraft();
    try{
      if(!current){const result=await api('conversations',options());apply(result,true);}
      for(const file of files){status.textContent='正在添加：'+file.name;const form=new FormData();form.append('file',file);draftFiles.push(await api('conversations/'+current+'/files',form));requestId='';renderDraft();}
      status.textContent='文件已添加，发送问题时一起交给模型';await loadList();
    }catch(e){status.textContent=e.message;}
    finally{busy=false;controls();renderDraft();for(const b of $('#dialogue-list').querySelectorAll('button'))b.disabled=false;}
  }
  $('#dialogue-add-file').onclick=()=>$('#dialogue-file-input').click();
  $('#dialogue-file-input').onchange=e=>{const files=[...e.target.files];e.target.value='';addFiles(files);};
  dialog.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.stopPropagation();dialog.classList.add('dialogue-drop-active');}});
  dialog.addEventListener('dragleave',e=>{if(!dialog.contains(e.relatedTarget))dialog.classList.remove('dialogue-drop-active');});
  dialog.addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();e.stopPropagation();dialog.classList.remove('dialogue-drop-active');addFiles([...e.dataTransfer.files]);}});
  dialog.addEventListener('paste',e=>{const files=[...e.clipboardData.files];if(files.length){e.preventDefault();e.stopPropagation();addFiles(files);}});
  function keyProfile(){return inventory.keys.find(profile=>profile.name===key.value||profile.id===key.value);}
  function models(preferred=model.value,fallback=true){
    const profile=keyProfile();key.dataset.id=profile?.id||'';if(profile&&key.value!==profile.name)key.value=profile.name;
    const values=(profile?.models||[]).map(item=>item.id),options=$('#dialogue-model-options');options.replaceChildren();for(const value of values)options.append(new Option(value,value));
    model.value=values.includes(preferred)?preferred:fallback?(values[0]||''):'';model.placeholder=values.length?'点击或输入搜索模型':'此 AK 暂无可用语言模型';controls();
  }
  function restoreSelection(body,quiet=false){
    const wantedKey=body?.last_credential_id||localStorage.getItem('dialogue-key-id'),wantedModel=body?.last_model||localStorage.getItem('dialogue-model');
    if(!wantedKey)return '';
    const profile=inventory.keys.find(item=>item.id===wantedKey);
    if(!profile){key.value='';key.dataset.id='';models('');return quiet?'':'上次使用的 AK 已不存在或被停用，请重新搜索选择。';}
    key.value=profile.name;key.dataset.id=profile.id;models(wantedModel||profile.models[0]?.id||'',!wantedModel);
    if(wantedModel&&!profile.models.some(item=>item.id===wantedModel))return quiet?'':'上次使用的模型已不可用，请重新搜索选择。';
    if(body?.last_protocol)$('#dialogue-protocol').value=body.last_protocol;
    return '';
  }
  async function loadModels(refresh=false){
    const previous=key.dataset.id;status.textContent='查询可用语言模型…';
    inventory=await api('models'+(refresh?'?refresh=1':''));const options=$('#dialogue-key-options');options.replaceChildren();for(const profile of inventory.keys){const option=new Option(profile.name,profile.name);option.dataset.id=profile.id;options.append(option);}
    if(previous&&inventory.keys.some(profile=>profile.id===previous)){const profile=inventory.keys.find(item=>item.id===previous);key.value=profile.name;key.dataset.id=profile.id;models(model.value);}else restoreSelection(currentBody,true);
    if(!keyProfile()&&!currentBody?.last_credential_id&&!localStorage.getItem('dialogue-key-id')&&inventory.keys.length){key.value=inventory.keys[0].name;key.dataset.id=inventory.keys[0].id;models(inventory.keys[0].models[0]?.id||'');}
    status.textContent=inventory.errors.map(e=>e.message).join('；')||(!inventory.keys.length?'请先配置并启用 service-inference AK':!model.value?'请选择可用的 AK 和模型':'可用模型已加载');
  }
  async function loadList(){
    const result=await api('conversations');categories=result.categories||[];const list=$('#dialogue-list');list.replaceChildren();
    const categoryInput=$('#dialogue-category'),categoryOptions=$('#dialogue-category-options');categoryOptions.replaceChildren();for(const category of categories)categoryOptions.append(new Option(category.body.name,category.body.name));
    if(currentBody)categoryInput.value=categories.find(item=>item.block_id===currentBody.category_id)?.body.name||'';
    const visible=result.conversations.filter(item=>Boolean(item.body.archived)===showArchived);
    const groups=[{block_id:'',body:{name:'未分类'}},...categories];
    for(const category of groups){
      const conversations=visible.filter(item=>(item.body.category_id||'')===category.block_id);
      if(!conversations.length&&category.block_id==='')continue;
      const section=document.createElement('section');section.className='dialogue-list-group';
      const heading=document.createElement('div');heading.className='dialogue-list-heading';const name=document.createElement('strong');name.textContent=category.body.name;heading.append(name);
      if(category.block_id){const rename=document.createElement('button');rename.type='button';rename.className='quiet dialogue-rename-category';rename.textContent='改名';rename.onclick=()=>renameCategory(category);heading.append(rename);}
      section.append(heading);
      for(const item of conversations){const button=document.createElement('button');button.type='button';button.className='quiet dialogue-list-item';button.dataset.id=item.block_id;button.setAttribute('aria-current',String(item.block_id===current));const title=document.createElement('strong');title.textContent=item.body.title;button.append(title);if(item.body.description){const description=document.createElement('small');description.textContent=item.body.description;button.append(description);}button.onclick=()=>openConversation(item.block_id);button.disabled=busy;section.append(button);}
      list.append(section);
    }
    if(!visible.length){const p=document.createElement('p');p.textContent=showArchived?'暂无归档对话。':'从一个问题开始。';list.append(p);}
  }
  function readableBytes(value){
    if(value<1024)return value+' B';if(value<1024*1024)return (value/1024).toFixed(1)+' KB';return (value/1024/1024).toFixed(1)+' MB';
  }
  function fillContext(panel,result){
    panel.replaceChildren();
    if(!result.turns.length){const empty=document.createElement('p');empty.textContent='本次没有携带历史问答，只提交了当前问题。';panel.append(empty);return;}
    for(const item of result.turns){
      const section=document.createElement('section');section.className='dialogue-context-turn';
      const heading=document.createElement('strong');heading.textContent=(item.model||'历史模型')+' · '+new Date(item.created_at).toLocaleString();
      const q=document.createElement('div');q.className='dialogue-context-question';q.textContent='问题\n'+item.question;
      const a=document.createElement('div');a.className='dialogue-context-answer';a.textContent='回答\n'+(item.answer||'');
      section.append(heading,q,a);
      if(item.attachments?.length){const files=document.createElement('small');files.textContent='附件：'+item.attachments.map(file=>file.name+'（'+readableBytes(file.size)+'）').join('、');section.append(files);}
      panel.append(section);
    }
  }
  function contextView(turn){
    const details=document.createElement('details');details.className='dialogue-context';
    const summary=document.createElement('summary'),info=turn.submission;
    summary.textContent='本次提交：历史 '+info.history_turns+' 轮 · '+info.messages+' 条消息 · 文本 '+info.text_chars.toLocaleString()+' 字 · 请求 '+readableBytes(info.request_bytes)+(info.attachments?' · 附件 '+info.attachments+' 个 / '+readableBytes(info.attachment_bytes):'');
    const panel=document.createElement('div');panel.className='dialogue-context-content';
    const cacheKey=current+':'+turn.id;details.open=contextExpanded.has(cacheKey);
    if(contextCache.has(cacheKey))fillContext(panel,contextCache.get(cacheKey));else panel.textContent='展开后加载本次实际使用的历史问答。';
    details.ontoggle=async()=>{
      if(details.open)contextExpanded.add(cacheKey);else contextExpanded.delete(cacheKey);
      if(!details.open||contextCache.has(cacheKey))return;
      panel.textContent='正在读取本次上下文…';const conversation=current,token=generation;
      try{const result=await api('conversations/'+conversation+'?context='+turn.id);if(token!==generation||conversation!==current)return;contextCache.set(cacheKey,result);fillContext(panel,result);}
      catch(e){panel.textContent=e.message;}
    };
    details.append(summary,panel);return details;
  }
  function directoryView(response,turnId){
    const headings=[...response.querySelectorAll('h1,h2,h3,h4,h5,h6')];if(!headings.length)return null;
    const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ol'),key=turnKey(turnId);details.className='dialogue-directory';details.open=openDirectories.has(key);summary.textContent='标题目录 · '+headings.length;
    headings.forEach((heading,index)=>{heading.id='dialogue-heading-'+turnId+'-'+index;const item=document.createElement('li'),link=document.createElement('a');item.style.setProperty('--directory-depth',String(Number(heading.tagName.slice(1))-1));link.href='#'+heading.id;link.textContent=heading.textContent;link.onclick=event=>{event.preventDefault();heading.scrollIntoView({behavior:'smooth',block:'nearest'});};item.append(link);list.append(item);});
    details.ontoggle=()=>{if(details.open)openDirectories.add(key);else openDirectories.delete(key);localStorage.setItem('dialogue-open-directories',JSON.stringify([...openDirectories]));};details.append(summary,list);return details;
  }
  function render(){
    const transcript=$('#dialogue-transcript'),nearBottom=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<100;
    transcript.replaceChildren();
    if(!turns.length){const empty=document.createElement('p');empty.className='dialogue-empty';empty.textContent='写剧本、讨论镜头，或问一个你正在思考的问题。';transcript.append(empty);}
    for(const turn of turns){
      const article=document.createElement('article');article.className='dialogue-turn';
      const q=document.createElement('div');q.className='dialogue-question';q.textContent=turn.question;
      const meta=document.createElement('small');meta.textContent=turn.model+' · '+turn.key_name+' · '+new Date(turn.created_at).toLocaleString();
      const response=document.createElement('div');response.className='dialogue-answer';
      if(turn.status==='completed'){
        response.innerHTML=DOMPurify.sanitize(marked.parse(turn.answer));
        for(const link of response.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer';}
        for(const table of [...response.querySelectorAll('table')]){const scroll=document.createElement('div');scroll.className='dialogue-table-scroll';table.before(scroll);scroll.append(table);}
      }else response.textContent=turn.status==='running'?'模型正在回答…':turn.error||'回答中断';
      article.append(q);
      if(turn.attachments?.length){const files=document.createElement('div');files.className='dialogue-turn-files';for(const file of turn.attachments)files.append(fileView(file));article.append(files);}
      response.id='dialogue-answer-'+turn.id;
      const collapseKey=turnKey(turn.id);response.classList.toggle('dialogue-answer-collapsed',collapsed.has(collapseKey));if(collapsed.has(collapseKey))applyCardSize(response,turn.id);else clearCardSize(response);applyAnswerFont(response,turn.id);let resizeSaveTimer=null;response.addEventListener('pointerup',()=>saveCardSize(response,turn.id,true));new ResizeObserver(()=>{if(!response.classList.contains('dialogue-answer-collapsed'))return;clearTimeout(resizeSaveTimer);resizeSaveTimer=setTimeout(()=>saveCardSize(response,turn.id,true),250);}).observe(response);
      const directory=turn.status==='completed'?directoryView(response,turn.id):null;if(directory)response.prepend(directory);article.append(meta,response);
      if(turn.submission)article.append(contextView(turn));
      if(turn.status==='completed'){
        const actions=document.createElement('div');actions.className='dialogue-turn-actions';
        const toggle=document.createElement('button');toggle.type='button';toggle.className='quiet dialogue-toggle-answer';toggle.setAttribute('aria-controls',response.id);
        const update=()=>{const folded=response.classList.contains('dialogue-answer-collapsed');toggle.textContent=folded?'展开':'折叠';toggle.setAttribute('aria-expanded',String(!folded));};update();toggle.onclick=()=>{const folded=response.classList.toggle('dialogue-answer-collapsed');if(folded){collapsed.add(collapseKey);applyCardSize(response,turn.id);}else{collapsed.delete(collapseKey);clearCardSize(response);}saveCollapsed();update();};actions.append(toggle);
        const fontButton=document.createElement('button');fontButton.type='button';fontButton.className='quiet dialogue-icon-button dialogue-answer-font-button';const savedLevel=answerFonts()[collapseKey],initialFontLevel=Number.isInteger(savedLevel)?savedLevel:Number($('#dialogue-font').value),fontPanel=document.createElement('div'),fontRange=document.createElement('input'),fontOutput=document.createElement('output');fontButton.title='调整此回答字号（当前：'+fontLabels[initialFontLevel]+'）';fontButton.setAttribute('aria-label',fontButton.title);fontButton.setAttribute('aria-expanded','false');fontButton.textContent='Aa';fontPanel.className='dialogue-answer-font-popover';fontPanel.id='dialogue-answer-font-'+turn.id;fontPanel.hidden=true;fontButton.setAttribute('aria-controls',fontPanel.id);fontRange.type='range';fontRange.min='0';fontRange.max='4';fontRange.step='1';fontRange.value=String(initialFontLevel);fontRange.setAttribute('aria-label','此回答字体大小');fontOutput.value=fontLabels[initialFontLevel];fontRange.oninput=()=>setAnswerFont(response,turn.id,Number(fontRange.value),fontButton,fontOutput);fontPanel.append(fontRange,fontOutput);fontButton.onclick=()=>{fontPanel.hidden=!fontPanel.hidden;fontButton.setAttribute('aria-expanded',String(!fontPanel.hidden));};actions.append(fontButton,fontPanel);
        const copy=document.createElement('button');copy.type='button';copy.className='quiet dialogue-icon-button';copy.title='复制回答';copy.setAttribute('aria-label','复制回答');copy.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h11v11H8z"></path><path d="M5 16H4V4h12v1"></path></svg>';copy.onclick=async()=>{try{await navigator.clipboard.writeText(turn.answer);status.textContent='回答已复制';}catch{status.textContent='复制失败，请选择回答文本复制';}};actions.append(copy);article.append(actions);
        if(turn.usage){const usage=document.createElement('small');usage.className='dialogue-usage';usage.textContent='用量：'+JSON.stringify(turn.usage);article.append(usage);}
      }
      transcript.append(article);
    }
    $('#dialogue-older').hidden=!older;
    if(nearBottom)transcript.scrollTop=transcript.scrollHeight;
  }
  function apply(result,reset=false){
    const body=result.body;current=result.block_id;currentBody=body;
    $('#dialogue-context-turns').value=body.context_turns??20;$('#dialogue-pack-size').value=body.pack_size??25;
    setEditText('#dialogue-title',body.title||'新对话');setEditText('#dialogue-description',body.description||'');$('#dialogue-title').dataset.description=body.description||'';
    $('#dialogue-category').value=categories.find(item=>item.block_id===body.category_id)?.body.name||'';$('#dialogue-archive').textContent=body.archived?'恢复对话':'归档对话';
    const selectionWarning=reset?restoreSelection(body):'';
    if(reset){turns=body.turns;older=body.prev_id;}else{const map=new Map(turns.map(t=>[t.id,t]));for(const t of body.turns)map.set(t.id,t);turns=[...map.values()];}
    pending=Boolean(body.pending_id);$('#dialogue-acknowledge').hidden=!body.interrupted;
    if(body.interrupted)status.textContent='服务或连接中断，请先在服务控制台核对请求；不会自动重发或重复计费。';else if(selectionWarning)status.textContent=selectionWarning;
    render();controls();
  }
  async function poll(token=generation){
    clearTimeout(timer);if(!dialog.open||!current||!pending)return;
    try{const result=await api('conversations/'+current);if(token!==generation||!dialog.open)return;apply(result);if(!pending){status.textContent=turns.at(-1)?.status==='completed'?'回答已保存':turns.at(-1)?.error||'回答已结束';await loadList();}}
    catch(e){if(token!==generation||!dialog.open)return;status.textContent=e.message+'；稍后继续检查已提交请求';}
    if(pending&&dialog.open&&token===generation)timer=setTimeout(()=>poll(token),2000);
  }
  async function openConversation(id){
    if(busy)return;const token=++generation;clearTimeout(timer);current=id;question.value='';requestId='';clearDraft();status.textContent='读取对话…';
    try{const result=await api('conversations/'+id);if(token!==generation||!dialog.open)return;apply(result,true);if(!result.body.interrupted&&!status.textContent.includes('已不存在')&&!status.textContent.includes('已不可用'))status.textContent=pending?'模型正在回答…':'历史记录已加载';await loadList();poll(token);}
    catch(e){if(token===generation)status.textContent=e.message;}
  }
  async function newConversation(){
    ++generation;clearTimeout(timer);const result=await api('conversations',options());apply(result,true);question.value='';requestId='';clearDraft();status.textContent='新对话已创建';await loadList();question.focus();
  }
  async function renameCategory(category){
    const name=await window.directorDialogs.prompt('输入分类名称',{title:'重命名分类',value:category.body.name});
    if(name===null)return;try{await api('categories/'+category.block_id,{name});status.textContent='分类名称已更新';await loadList();}catch(e){status.textContent=e.message;}
  }
  $('#new-dialogue-category').onclick=async()=>{
    const name=await window.directorDialogs.prompt('输入分类名称，例如「市场研究」或「剧本讨论」',{title:'新建对话分类'});
    if(name===null)return;try{const result=await api('categories',{name});await loadList();$('#dialogue-category').value=result.body.name;status.textContent='分类已创建，可保存到当前对话';}catch(e){status.textContent=e.message;}
  };
  $('#toggle-archived').onclick=async()=>{showArchived=!showArchived;$('#toggle-archived').setAttribute('aria-pressed',String(showArchived));$('#toggle-archived').textContent=showArchived?'返回对话':'归档';await loadList();};
  async function saveMetadata(message='对话信息已保存'){
    if(!current||busy)return;clearTimeout(metadataTimer);let payload;try{payload=metadataPayload();}catch(e){status.textContent=e.message;return;}busy=true;controls();try{apply(await api('conversations/'+current,payload));status.textContent=message;await loadList();}catch(e){status.textContent=e.message;}finally{busy=false;controls();if(!$('#dialogue-title').matches(':focus')&&!$('#dialogue-description').matches(':focus'))$('#dialogue-info').classList.remove('dialogue-info-editing');}
  }
  $('#dialogue-archive').onclick=async()=>{
    if(!current||busy)return;let payload;const archived=!Boolean(currentBody?.archived);try{payload=metadataPayload(archived);}catch(e){status.textContent=e.message;return;}busy=true;controls();try{apply(await api('conversations/'+current,payload));status.textContent=archived?'对话已归档':'对话已恢复';await loadList();}catch(e){status.textContent=e.message;}finally{busy=false;controls();}
  };
  for(const editor of [$('#dialogue-title'),$('#dialogue-description')]){
    editor.addEventListener('pointerdown',()=>$('#dialogue-info').classList.add('dialogue-info-editing'));
    editor.addEventListener('click',()=>$('#dialogue-info').classList.add('dialogue-info-editing'));
    editor.addEventListener('focus',()=>$('#dialogue-info').classList.add('dialogue-info-editing'));
    editor.addEventListener('paste',event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));});
    editor.addEventListener('input',()=>{const max=Number(editor.dataset.maxlength);if(editor.textContent.length>max)editor.textContent=editor.textContent.slice(0,max);clearTimeout(metadataTimer);metadataTimer=setTimeout(()=>saveMetadata('对话信息已自动保存'),250);});
    editor.addEventListener('blur',()=>{setTimeout(()=>{if(!$('#dialogue-title').matches(':focus')&&!$('#dialogue-description').matches(':focus'))$('#dialogue-info').classList.remove('dialogue-info-editing');},0);if(current&&!busy){clearTimeout(metadataTimer);metadataTimer=setTimeout(()=>saveMetadata('对话信息已自动保存'),150);}});
  }
  $('#dialogue-category').addEventListener('change',()=>{if(current)saveMetadata('分类已自动保存');});
  document.querySelector('#open-dialogue').onclick=async()=>{
    ++generation;current='';currentBody=null;turns=[];older=null;pending=false;requestId='';question.value='';clearDraft();$('#dialogue-acknowledge').hidden=true;render();dialog.showModal();
    try{await loadModels();await loadList();controls();}catch(e){status.textContent=e.message;}
  };
  $('#close-dialogue').onclick=()=>dialog.close();dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});dialog.addEventListener('close',()=>{++generation;clearTimeout(timer);});
  key.oninput=()=>models(model.value);key.onchange=()=>{models(model.value);if(!keyProfile())status.textContent='请选择搜索结果中的 AK';};
  $('#dialogue-refresh').onclick=async()=>{try{await loadModels(true);}catch(e){status.textContent=e.message;}};
  $('#dialogue-settings').onclick=()=>document.querySelector('#open-inference-settings').click();
  $('#new-dialogue').onclick=async()=>{try{await newConversation();}catch(e){status.textContent=e.message;}};
  $('#dialogue-older').onclick=async()=>{
    const id=current,token=generation;try{const result=await api('conversations/'+id+'?cursor='+older);if(token!==generation)return;turns=[...result.body.turns,...turns];older=result.body.prev_id;render();}catch(e){status.textContent=e.message;}
  };
  $('#dialogue-acknowledge').onclick=async()=>{try{apply(await api('conversations/'+current,{action:'acknowledge'}));status.textContent='中断状态已记录，可以继续提问';}catch(e){status.textContent=e.message;}};
  $('#dialogue-compose').onsubmit=async e=>{
    e.preventDefault();const profile=keyProfile();if(busy||pending||!profile||!profile.models.some(item=>item.id===model.value)||!question.value.trim()){if(!busy&&!pending)status.textContent='请从搜索结果选择可用的 AK 和模型';return;}
    const selectedKey=profile.id,selectedModel=model.value,protocol=$('#dialogue-protocol').value,text=question.value.trim();
    busy=true;controls();for(const b of $('#dialogue-list').querySelectorAll('button'))b.disabled=true;
    try{
      if(!current){const result=await api('conversations',options());apply(result,true);}
      if(!requestId||requestQuestion!==text+JSON.stringify(draftFiles.map(f=>f.id))){requestId=makeId();requestQuestion=text+JSON.stringify(draftFiles.map(f=>f.id));}
      status.textContent='提交问题…';
      const result=await api('conversations/'+current,{request_id:requestId,question:text,credential_id:selectedKey,model:selectedModel,protocol,attachments:draftFiles.map(f=>f.id)});localStorage.setItem('dialogue-key-id',selectedKey);localStorage.setItem('dialogue-model',selectedModel);
      apply(result);question.value='';requestId='';clearDraft();status.textContent='模型正在回答，记录已保存';await loadList();poll();
    }catch(e){status.textContent=e.message+'；若连接中断，请重新打开此对话检查已保存记录';}
    finally{busy=false;controls();for(const b of $('#dialogue-list').querySelectorAll('button'))b.disabled=false;}
  };
  question.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#dialogue-compose').requestSubmit();}};
})();
