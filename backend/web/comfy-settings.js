(() => {
  'use strict';
  const dialog=document.querySelector('#comfy-dialog'),form=document.querySelector('#comfy-form');
  const status=document.querySelector('#comfy-status'),url=document.querySelector('#comfy-url');
  let busy=false;
  function updateURL(){const host=form.elements.host.value.trim();url.textContent=`http://${host.includes(':')?'['+host+']':host}:${form.elements.port.value}`;}
  async function request(path,data){
    const response=await fetch(path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf='))?.slice(6)||'')}:{},body:data?JSON.stringify(data):undefined});
    const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
  }
  function lock(value){busy=value;for(const el of form.querySelectorAll('input,button'))el.disabled=value;}
  document.querySelector('#open-comfy-settings').onclick=async()=>{
    dialog.showModal();status.textContent='正在读取配置…';lock(true);
    try{const result=await request('/api/settings/comfyui');form.elements.host.value=result.connection.host;form.elements.port.value=result.connection.port;updateURL();status.textContent='';}
    catch(error){status.textContent=error.message;}
    finally{lock(false);}
  };
  document.querySelector('#close-comfy-settings').onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  form.addEventListener('input',()=>{status.textContent='';updateURL();});
  document.querySelector('#default-comfy').onclick=()=>{form.elements.host.value='127.0.0.1';form.elements.port.value=8188;updateURL();status.textContent='已填入默认值，保存后生效';};
  async function submit(test){
    if(busy||!form.reportValidity())return;
    const data={host:form.elements.host.value.trim(),port:Number(form.elements.port.value)};
    lock(true);status.textContent=test?'正在测试连接…':'正在验证并保存…';
    try{const result=await request('/api/settings/comfyui'+(test?'/test':''),data);status.textContent=test?`连接成功 · ComfyUI ${result.version}（尚未保存）`:`已保存并生效 · ${result.url}`;}
    catch(error){status.textContent=error.message;}
    finally{lock(false);}
  }
  document.querySelector('#test-comfy').onclick=()=>submit(true);
  form.onsubmit=event=>{event.preventDefault();submit(false);};
})();
