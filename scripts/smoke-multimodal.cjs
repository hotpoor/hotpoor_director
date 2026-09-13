const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'multimodal-profile'));
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
      const fixtures=[['generated-ltx-2.5-image.mp4','video/mp4'],['reference-audio.wav','audio/wav']].map(([name,mime])=>({name,mime,data:fs.readFileSync(path.join(directory,name)).toString('base64')}));
      await js(`(async()=>{
        window.testApi=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{...(body instanceof FormData?{}:{'Content-Type':'application/json'}),'X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};
        const ids=()=>crypto.randomUUID().replaceAll('-',''),assets=[];
        for(const f of ${JSON.stringify(fixtures)}){const form=new FormData();form.append('file',new File([Uint8Array.from(atob(f.data),c=>c.charCodeAt(0))],f.name,{type:f.mime}));assets.push(await testApi('/api/assets',form));}
        const target=ids(),sources=assets.map((a,i)=>({id:ids(),type:'asset',mode:'media',asset_id:a.id,x:10,y:i*250,w:380,h:220}));
        const project=await testApi('/api/projects',{title:'Multimodal reference UI',canvas:{viewport:{x:0,y:0,zoom:1},cards:[...sources,{id:target,type:'video',mode:'reference',model:'minimax-h3-ref2va',x:420,y:10,w:480,h:850,drafts:{reference:{model:'minimax-h3-ref2va',refs:[]}}}],connections:sources.map(c=>({id:ids(),source:c.id,target}))}});
        window.testProjectId=project.block_id;window.testTarget=target;
        await window.directorStudio.enter(await testApi('/api/me'));
      })()`);
      const id=await js('window.testProjectId');
      await waitFor(`!!document.querySelector('[data-project="${id}"]')`);
      await js(`document.querySelector('[data-project="${id}"]').click()`);
      await waitFor("!document.querySelector('#editor').hidden && document.querySelectorAll('[data-use-material]:not(:disabled)').length===2");
      await js("document.querySelectorAll('[data-use-material]')[0].click()");
      await waitFor("document.querySelectorAll('.ref-list video').length===1");
      await js("document.querySelectorAll('[data-use-material]')[1].click()");
      await waitFor("document.querySelectorAll('.ref-list audio').length===1");
      if(!await js("document.querySelector('.ref-list').textContent.includes('Video 1')&&document.querySelector('.ref-list').textContent.includes('Audio 1')"))throw Error('Reference labels missing');
      const image=fs.readFileSync(path.join(root,'assets/icon.png')).toString('base64');
      await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob('${image}'),c=>c.charCodeAt(0))],'image.png',{type:'image/png'}));const input=document.querySelector('.ref-upload');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor("document.querySelector('.ref-list').textContent.includes('Picture 1')");
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      await js("document.querySelector('#back-dashboard').click()");await waitFor("!document.querySelector('#dashboard').hidden");await waitFor(`!!document.querySelector('[data-project="${id}"]')`);await js(`document.querySelector('[data-project="${id}"]').click()`);
      await waitFor("!document.querySelector('#editor').hidden && document.querySelector('.ref-list audio') && document.querySelector('.ref-list video') && document.querySelector('.ref-list img')");
      await js("(()=>{const select=document.querySelector('[data-field=model]');select.value='ltx-2.5';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
      if(!await js("document.querySelectorAll('[data-use-material]:disabled').length===2 && !document.querySelector('[data-mode=reference]')"))throw Error('LTX incorrectly accepts multimodal references');
      await js("(()=>{const select=document.querySelector('[data-field=model]');select.value='minimax-h3-ref2va';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.ref-zone').scrollIntoView({block:'center'});})()");
      await waitFor("document.querySelector('.ref-list audio') && document.querySelector('.ref-list video')");
      window.showInactive();await new Promise(r=>setTimeout(r,1000));fs.writeFileSync(path.join(directory,'multimodal-ui.png'),(await window.webContents.capturePage()).toPNG());window.hide();
      console.log('PASS: video/audio connection references, image upload, typed labels and previews, autosave/reopen, model capability filtering.');app.quit();
    }catch(error){console.error(error);window.destroy();app.quit();}
  });
});
require('../desktop/main.cjs');
