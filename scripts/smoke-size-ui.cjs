const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'size-profile'));
process.env.DIRECTOR_SMOKE_TEST = '1';
process.env.DIRECTOR_DATA_DIR = directory;
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)console.error('Renderer:',message);});
    const js = (source,userGesture=false) => window.webContents.executeJavaScript(source,userGesture);
    async function waitFor(source) {
      for (let i=0;i<100;i++) { if(await js(source))return; await new Promise(r=>setTimeout(r,100)); }
      throw new Error('Timed out: '+source);
    }
    try {
      await waitFor("typeof window.directorStudio === 'object'");
      await js(`(async()=>{
        const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};
        const user={login:'studio-smoke',password:'local-ui-test-password-123'};
        if((await api('/api/setup')).can_setup)await api('/api/setup',user);
        await api('/api/login',user); await window.directorStudio.enter(await api('/api/me'));
      })()`);
      await js("document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='Model size guidance';document.querySelector('#project-form').requestSubmit()");
      await waitFor("!document.querySelector('#editor').hidden && !document.querySelector('#project-dialog').open");
      await js("document.querySelector('#add-image').click()");
      if(!await js("document.querySelector('.size-help').textContent.includes('16 的倍数') && document.querySelectorAll('[data-size-preset]').length===3"))throw Error('Image guidance absent');
      await js("(()=>{const input=document.querySelector('[data-field=width]');input.value='2048';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
      if(!await js("!document.querySelector('.size-error').hidden && document.querySelector('.size-error').textContent.includes('宽度')"))throw Error('Out of range not shown');
      await js("window.submitCount=0;window.originalFetch=fetch;window.fetch=(url,options)=>{if(String(url).endsWith('/generate'))submitCount++;return originalFetch(url,options);};document.querySelector('.generate').click()");
      if(!await js('window.submitCount===0'))throw Error('Invalid size submitted');
      await js("document.querySelector('[data-size-preset]').click()");
      if(!await js("document.querySelector('[data-field=width]').value==='1024' && document.querySelector('.size-error').hidden"))throw Error('Preset did not fix size');
      await js("document.querySelector('#add-video').click();(()=>{const select=[...document.querySelectorAll('[data-field=model]')].at(-1);select.value='ltx-2.5';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await js("window.videoCard=[...document.querySelectorAll('[data-card]')].at(-1);window.setSize=(w,h)=>{for(const [k,n] of [['width',w],['height',h]]){const input=videoCard.querySelector('[data-field='+k+']');input.value=n;input.dispatchEvent(new Event('input',{bubbles:true}));}};setSize(512,480)");
      if(!await js("videoCard.querySelector('.size-error').textContent.includes('64')"))throw Error('LTX stride error absent');
      await js('setSize(1536,1536)');
      if(!await js("videoCard.querySelector('.size-error').textContent.includes('总像素')"))throw Error('Pixel limit absent');
      await js("videoCard.querySelector('[data-size-preset]').click()");
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      await js(`(async()=>{
        const id=(await(await originalFetch('/api/projects')).json()).projects[0].block_id;
        const headers={'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))};
        for(const [width,height,reason] of [[2048,320,'宽度'],[512,480,'64'],[1536,1536,'总像素'],[512.5,320,'整数']]){
          const r=await originalFetch('/api/projects/'+id+'/generate',{method:'POST',headers,body:JSON.stringify({card_id:videoCard.dataset.card,request_id:crypto.randomUUID().replaceAll('-',''),mode:'text',model:'ltx-2.5',prompt:'test',steps:11,width,height})});
          const result=await r.json();if(r.status!==400||!result.error.includes(reason))throw Error('API size validation incorrect: '+width+'x'+height+' '+JSON.stringify(result));
        }
      })()`);
      await js('setSize(1536,1536);videoCard.querySelector(".size-help").scrollIntoView({block:"center"})');
      window.showInactive();await new Promise(r=>setTimeout(r,800));fs.writeFileSync(path.join(directory,'size-guidance.png'),(await window.webContents.capturePage()).toPNG());window.hide();
      await js("videoCard.querySelector('[data-size-preset]').click()");
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      console.log('PASS: model-specific presets, live width/step/pixel errors, invalid submission prevented, backend API rejection including fractional dimensions.');app.quit();
    }catch(error){console.error(error);window.destroy();app.quit();}
  });
});
require('../desktop/main.cjs');
