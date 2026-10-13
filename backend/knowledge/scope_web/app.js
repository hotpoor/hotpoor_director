'use strict';
const $=id=>document.getElementById(id),thread=new URLSearchParams(location.search).get('thread');
let items=[],filePaths=[],children=new Map(),descendants=new Map(),selected=new Set(),saved=null,folder='',page=1,onlySelected=false,ready=false,saving=false,visible=[];
const pageSize=80;
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data;}
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
function dirty(){if(!saved)return selected.size>0;return selected.size!==saved.paths.length||saved.paths.some(p=>!selected.has(p));}
function pathsFor(item){return item.kind==='file'?[item.path]:(descendants.get(item.path)||[]);}
function stage(item,checked){if(saving)return;for(const path of pathsFor(item)){if(checked)selected.add(path);else selected.delete(path);}render();}
function makeButton(text,fn){const b=document.createElement('button');b.textContent=text;b.type='button';b.onclick=fn;return b;}
function render(){
 if(!ready)return;
 const query=$('search').value.trim().toLocaleLowerCase();
 let filtered=query?items.filter(x=>x.path.toLocaleLowerCase().includes(query)):(children.get(folder)||[]);
 if(onlySelected)filtered=filtered.filter(x=>pathsFor(x).some(p=>selected.has(p)));
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize));page=Math.min(page,pages);visible=filtered.slice((page-1)*pageSize,page*pageSize);
 const crumbs=$('crumbs');crumbs.replaceChildren(makeButton('全部文献',()=>{folder='';page=1;$('search').value='';render();}));
 let path='';for(const part of folder.split('/').filter(Boolean)){path+=(path?'/':'')+part;const target=path,sep=document.createElement('span');sep.textContent='/';crumbs.append(sep,makeButton(part,()=>{folder=target;page=1;$('search').value='';render();}));}
 const list=$('list');list.replaceChildren();
 for(const item of visible){
  const paths=pathsFor(item),n=paths.reduce((sum,p)=>sum+Number(selected.has(p)),0),row=document.createElement('div');row.className='row';
  const cb=document.createElement('input');cb.type='checkbox';cb.checked=paths.length>0&&n===paths.length;cb.indeterminate=n>0&&n<paths.length;cb.disabled=saving;cb.setAttribute('aria-label','选择 '+item.path);cb.onchange=()=>stage(item,cb.checked);
  const icon=document.createElement('span');icon.className='icon';icon.textContent=item.kind==='directory'?'目录':'MD';
  const title=makeButton(item.name,()=>{if(item.kind==='directory'){folder=item.path;page=1;$('search').value='';render();}else stage(item,!selected.has(item.path));});title.className='title';title.disabled=saving;
  if(query){const small=document.createElement('small');small.textContent=item.path;title.append(small);}
  const meta=document.createElement('span');meta.className='meta';meta.textContent=item.kind==='directory'?`${n.toLocaleString()} / ${paths.length.toLocaleString()} 篇 ›`:(n?'已选':'');
  row.append(cb,icon,title,meta);list.append(row);
 }
 if(!visible.length){const p=document.createElement('p');p.className='empty';p.textContent=onlySelected?'此处没有已选文献。':'没有符合条件的文章或文件夹。';list.append(p);}
 const pagePaths=new Set(visible.flatMap(pathsFor)),checked=[...pagePaths].filter(p=>selected.has(p)).length;
 $('select-page').checked=pagePaths.size>0&&checked===pagePaths.size;$('select-page').indeterminate=checked>0&&checked<pagePaths.size;$('select-page').disabled=saving||!pagePaths.size;
 $('results').textContent=`${filtered.length.toLocaleString()} 项 · 全库 ${filePaths.length.toLocaleString()} 篇`;
 $('page-label').textContent=`${page} / ${pages}`;$('prev').disabled=page===1;$('next').disabled=page===pages;
 $('count').textContent=selected.size.toLocaleString();$('view').textContent=onlySelected?'显示全部':'只看已选';$('view').setAttribute('aria-pressed',String(onlySelected));
 $('saved').textContent=saved?.configured?`已应用 ${saved.paths.length.toLocaleString()} 篇 · ${saved.updated_at}`:'尚未应用范围';
 const groups=new Map();for(const p of selected){const key=p.includes('/')?p.split('/')[0]:'根目录文章';groups.set(key,(groups.get(key)||0)+1);}
 $('groups').replaceChildren();for(const [name,count] of [...groups].sort((a,b)=>b[1]-a[1])){const row=document.createElement('div');row.className='group';const title=document.createElement('span'),value=document.createElement('span');title.textContent=name;value.textContent=count.toLocaleString();row.append(title,value);$('groups').append(row);}
 if(!selected.size)$('groups').textContent='从左侧选择你希望参考的文献。';
 $('draft').textContent=dirty()?`待应用：${selected.size.toLocaleString()} 篇文章`:saved?.configured?`已应用：${selected.size.toLocaleString()} 篇文章`:'尚未指定文献范围';
 $('apply').disabled=saving;$('clear').disabled=saving;$('refresh').disabled=saving;$('apply').textContent=saving?'正在应用…':'应用到本次聊天';
}
async function save(){if(!ready||saving)throw Error('目录尚未就绪');saving=true;render();try{saved=await api('/api/scope/'+encodeURIComponent(thread),{revision:saved?.revision??null,paths:[...selected]});notice(`已应用 ${saved.paths.length.toLocaleString()} 篇。回到本次 Codex 聊天提问即可，后续会读取这份范围。`);return {count:saved.paths.length,revision:saved.revision,thread_id:thread};}catch(e){notice(e.message,true);throw e;}finally{saving=false;render();}}
async function load(refresh=false){$('refresh').disabled=true;$('apply').disabled=true;notice(refresh?'正在完整刷新目录，已有勾选会保留…':'正在完整读取知识库目录，请稍候…');try{const data=await api('/api/catalog'+(refresh?'?refresh=1':''));items=data.items;filePaths=items.filter(x=>x.kind==='file').map(x=>x.path);children=new Map();descendants=new Map();for(const item of items){const parent=item.path.includes('/')?item.path.slice(0,item.path.lastIndexOf('/')):'';if(!children.has(parent))children.set(parent,[]);children.get(parent).push(item);if(item.kind==='file'){const parts=item.path.split('/');for(let i=1;i<parts.length;i++){const key=parts.slice(0,i).join('/');if(!descendants.has(key))descendants.set(key,[]);descendants.get(key).push(item.path);}}}for(const rows of children.values())rows.sort((a,b)=>(a.kind===b.kind?0:a.kind==='directory'?-1:1)||a.name.localeCompare(b.name,'zh-CN'));if(!saved){saved=await api('/api/scope/'+encodeURIComponent(thread));selected=new Set(saved.paths);}ready=true;render();notice(`目录已就绪：${filePaths.length.toLocaleString()} 篇文章 · ${items.length-filePaths.length} 个文件夹。`);}catch(e){notice(e.message,true);}finally{$('refresh').disabled=false;$('apply').disabled=!ready;}}
$('search').oninput=()=>{page=1;render();};$('view').onclick=()=>{onlySelected=!onlySelected;page=1;render();};$('prev').onclick=()=>{page--;render();$('list').scrollTop=0;};$('next').onclick=()=>{page++;render();$('list').scrollTop=0;};$('clear').onclick=()=>{selected.clear();render();};$('select-page').onchange=e=>{for(const item of visible)for(const p of pathsFor(item)){if(e.target.checked)selected.add(p);else selected.delete(p);}render();};$('apply').onclick=()=>save().catch(()=>{});$('refresh').onclick=()=>load(true);window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue='';}});
if(!thread||!/^[a-zA-Z0-9_-]{1,100}$/.test(thread)){notice('请从当前 Codex 任务提供的专属链接打开此页。',true);$('refresh').disabled=true;}else{$('task').textContent='当前任务：'+thread;load();}
if(document.modelContext?.registerTool){
 const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort());
 const tools=[{name:'get_wiki_scope',description:'Read saved and draft scope counts for this task.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>({thread_id:thread,saved_count:saved?.paths.length||0,draft_count:selected.size,dirty:dirty()})},{name:'stage_wiki_paths',description:'Stage listed file or directory paths as selected or unselected. Does not apply until apply_wiki_scope.',inputSchema:{type:'object',properties:{paths:{type:'array',items:{type:'string'}},selected:{type:'boolean'}},required:['paths','selected'],additionalProperties:false},execute:input=>{if(!ready||saving||!Array.isArray(input.paths)||typeof input.selected!=='boolean')throw Error('Invalid selection');const rows=input.paths.map(p=>items.find(x=>x.path===p));if(rows.some(x=>!x))throw Error('Unknown path');for(const item of rows)for(const p of pathsFor(item)){if(input.selected)selected.add(p);else selected.delete(p);}render();return {draft_count:selected.size};}},{name:'apply_wiki_scope',description:'Save the visible draft as the scope for this Codex task.',inputSchema:{type:'object',properties:{},additionalProperties:false},execute:save}];
 for(const tool of tools)Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});
}
