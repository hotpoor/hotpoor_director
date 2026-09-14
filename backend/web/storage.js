(() => {
  'use strict';
  const dialog=document.querySelector('#storage-dialog'),form=document.querySelector('#storage-form'),status=document.querySelector('#storage-status');
  let config;
  async function request(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
  }
  const field=name=>form.elements[name];
  function preview(){const prefix=field('path_prefix').value.trim().replace(/^\/+|\/+$/g,'').split('/').filter(Boolean).map(encodeURIComponent).join('/');let domain=field('domain').value.trim().replace(/\/+$/,'');if(domain&&!domain.includes('://'))domain='https://'+domain;if(!domain&&field('provider').value!=='qiniu'&&field('bucket_name').value)domain='https://'+field('bucket_name').value+'.'+field('endpoint').value.replace(/^https?:\/\//,'');document.querySelector('#storage-url-preview').textContent='访问地址示例：'+(domain||'<访问域名>')+'/'+(prefix?prefix+'/':'')+'<项目 block_id>/<MD5>.<后缀>'; }
  form.addEventListener('input',preview);
  function autoEndpoint(){const p=field('provider').value,r=field('region').value;field('endpoint').value=p==='qiniu'?`https://up-${r}.qiniup.com`:p==='aliyun'?`https://oss-${r}.aliyuncs.com`:`https://cos.${r}.myqcloud.com`;preview();}
  function render(){
    const p=field('provider').value,meta=config.providers[p],saved=config.profiles[p]||{};
    document.querySelector('#storage-key-label').textContent=meta.key_label;document.querySelector('#storage-secret-label').textContent=meta.secret_label;
    for(const name of ['access_key_id','access_key_secret']){field(name).value='';field(name).placeholder=saved.credentials_configured?'已保存，留空保留':'请输入'+meta[name==='access_key_id'?'key_label':'secret_label'];}
    for(const name of ['bucket_name','region','endpoint','domain','path_prefix'])field(name).value=saved[name]||'';
    field('path_prefix').value=saved.path_prefix??'director/references';
    field('bucket_name').placeholder=meta.bucket_hint;field('domain').required=meta.domain_required;
    document.querySelector('#storage-domain-label').textContent='访问域名'+(meta.domain_required?'（必填）':'（选填，留空使用 Bucket 域名）');
    document.querySelector('#storage-regions').replaceChildren(...meta.regions.map(([value,label])=>{const o=document.createElement('option');o.value=value;o.label=label;return o;}));
    if(!field('region').value)field('region').value=meta.regions[0][0];if(!field('endpoint').value)autoEndpoint();
    document.querySelector('#storage-help').textContent=meta.help;preview();
    status.textContent=(saved.credentials_configured?'本厂商配置已保存':'本厂商尚未配置')+' · 当前启用：'+(config.providers[config.active_provider]?.name||'未启用');
  }
  async function open(){dialog.showModal();status.textContent='读取配置…';try{config=await request('/api/settings/storage');field('provider').value=config.active_provider||'qiniu';render();}catch(e){status.textContent=e.message;}}
  document.querySelector('#open-storage-settings').onclick=open;
  document.querySelector('#close-storage').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{field('access_key_id').value='';field('access_key_secret').value='';});
  field('provider').onchange=render;field('region').onchange=autoEndpoint;
  document.querySelector('#storage-auto-endpoint').onclick=autoEndpoint;
  async function submit(action){
    const inputs=[...form.querySelectorAll('input,select,button')],data=Object.fromEntries(new FormData(form));
    if(!['clear','disable'].includes(action)&&!form.reportValidity())return;
    inputs.forEach(x=>x.disabled=true);status.textContent=action==='test'?'验证空间访问…':'保存配置…';
    try{const result=await request('/api/settings/storage'+(action==='test'?'/test':''),action==='clear'?{provider:data.provider,clear:true}:action==='disable'?{disable:true}:data);
      if(action==='test')status.textContent=result.note;else{config=result;render();status.textContent+=' · 保存完成';}
    }catch(e){status.textContent=e.message;}finally{inputs.forEach(x=>x.disabled=false);}
  }
  form.onsubmit=e=>{e.preventDefault();submit('save');};
  for(const action of ['test','clear','disable'])document.querySelector('#storage-'+action).onclick=()=>submit(action);
  const panel=document.querySelector('#upload-progress'),bar=document.querySelector('#upload-progress-bar');
  const closeProgress=document.querySelector('#close-upload-progress');
  closeProgress.onclick=()=>{panel.hidden=true;};
  const bytes=n=>n<1024*1024?(n/1024).toFixed(1)+' KB':(n/1024/1024).toFixed(1)+' MB';
  function directUpload(grant,body,report){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open(grant.upload.method,grant.upload.url);xhr.withCredentials=false;xhr.timeout=30*60*1000;
      for(const [key,value] of Object.entries(grant.upload.headers||{}))xhr.setRequestHeader(key,value);
      xhr.upload.onprogress=event=>report('upload','正在上传到云存储',event.lengthComputable?Math.min(100,Math.floor(event.loaded/event.total*100)):null,
        '已传输 '+bytes(event.loaded)+(event.lengthComputable?' / '+bytes(event.total):''));
      xhr.upload.onload=()=>report('upload','文件已发送，等待云存储响应',100,'正在等待服务端接收结果…');
      xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300||(grant.provider==='qiniu'&&xhr.status===614))resolve();else reject(Error('直传失败（HTTP '+xhr.status+'），请检查上传权限和地域'));};
      xhr.onerror=()=>reject(Error('直传连接失败，请检查网络和存储空间 CORS 配置'));
      xhr.ontimeout=()=>reject(Error('直传超时，请检查网络后重试'));
      xhr.onabort=()=>reject(Error('直传已中断'));xhr.send(body);
    });
  }
  // Keep a failed confirmation retryable without uploading another object.
  const pending=new WeakMap();
  async function uploadFile(file,progress=()=>{},projectId=null,batch=null){
    panel.hidden=false;closeProgress.hidden=true;panel.dataset.state='running';
    document.querySelector('#upload-progress-title').textContent='云存储直传'+(batch?' · '+batch.index+' / '+batch.total:'');
    document.querySelector('#upload-progress-file').textContent=file.name+' · '+bytes(file.size);
    const report=(stage,label,percent=null,detail='')=>{
      panel.dataset.stage=stage;document.querySelector('#upload-progress-stage').textContent=label+(percent===null?'':' · '+percent+'%');
      if(percent===null)bar.removeAttribute('value');else bar.value=percent;
      document.querySelector('#upload-progress-detail').textContent=detail;
      progress(label+(percent===null?'':' · '+percent+'%'));
    };
    try{
      let id=pending.get(file);
      if(!id){
        report('md5','正在校验 MD5',0,'在本机计算文件指纹，用于识别重复素材');const hash=new SparkMD5.ArrayBuffer();
        for(let offset=0;offset<file.size;offset+=2*1024*1024){
          hash.append(await file.slice(offset,offset+2*1024*1024).arrayBuffer());
          const done=Math.min(file.size,offset+2*1024*1024);
          report('md5','正在校验 MD5',Math.floor(done/file.size*100),bytes(done)+' / '+bytes(file.size));
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        report('check','检查重复文件与上传凭证',null,'正在查询是否已有相同素材…');
        const grant=await request('/api/storage/uploads',{name:file.name,mime:file.type,size:file.size,md5:hash.end(),project_id:projectId});
        if(grant.reused){report('done','已复用相同文件',100,'无需再次上传，不新增云端文件');panel.dataset.state='done';return grant.asset;}
        let body=file;if(grant.upload.method==='POST'){body=new FormData();for(const [k,v] of Object.entries(grant.upload.fields))body.append(k,v);body.append('file',file);}
        report('upload','正在上传到云存储',0,'准备发送文件…');await directUpload(grant,body,report);
        id=grant.upload_id;pending.set(file,id);
      }
      report('confirm','确认文件与公网访问',null,'文件已上传，正在检查大小、类型与访问 URL…');
      const result=await request('/api/storage/uploads/'+id+'/confirm',{});pending.delete(file);
      report('done','上传完成',100,'公网访问已确认，素材可以使用');panel.dataset.state='done';return result;
    }catch(error){report('error','上传未完成',null,error.message);panel.dataset.state='error';throw error;}
    finally{closeProgress.hidden=false;}
  }
  window.directorStorage={uploadFile,open};
})();
