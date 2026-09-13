const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'pin-sync-profile'));
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
      const records=['generation-record-minimax-h3-ref2va-reference.json','generation-record-minimax-h3-ref2va-reference-multimodal.json'].map(name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8')));
      await js("document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='PIN playback sync';document.querySelector('#project-form').requestSubmit()");
      await waitFor("!document.querySelector('#editor').hidden && !document.querySelector('#project-dialog').open");
      await js("document.querySelector('#add-video').click()");
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      await js(`(async()=>{
        const project=(await(await fetch('/api/projects')).json()).projects[0],card=document.querySelector('[data-card]').dataset.card;
        window.pinTestProject=project.block_id;
        const rows=${JSON.stringify(records)};for(const row of rows){row.body.card_id=card;row.body.status='completed';}
        const original=fetch;window.fetch=(url,options)=>url==='/api/projects/'+project.block_id+'/history'?Promise.resolve(new Response(JSON.stringify({history:rows,reorder_available:true}),{headers:{'Content-Type':'application/json'}})):original(url,options);
      })()`);
      await waitFor("document.querySelectorAll('[data-history]').length===2");
      await js("document.querySelector('.pin-current').click();document.querySelectorAll('[data-history]')[1].click();document.querySelector('.pin-current').click()");
      await waitFor("document.querySelectorAll('.pinned-results video').length===2 && !document.querySelector('.sync-pins').disabled");
      await waitFor("[...document.querySelectorAll('.pinned-results video')].every(v=>v.readyState>=2)");
      await js("window.pins=[...document.querySelectorAll('.pinned-results video')];pins.forEach(v=>{v.muted=true;v.loop=true;});document.querySelector('.sync-pins').click()",true);
      await waitFor('pins.every(v=>!v.paused)');
      await js('pins[0].pause()');await waitFor('pins.every(v=>v.paused)');
      await js('pins[0].currentTime=.4; pins[0].playbackRate=1.5');
      await waitFor('Math.abs(pins[1].currentTime-.4)<.1 && pins[1].playbackRate===1.5');
      await js('pins[0].play()',true);await waitFor('pins.every(v=>!v.paused)');
      await js("document.querySelectorAll('[data-history]')[0].click()");
      await waitFor('pins.every(v=>v.isConnected&&!v.paused)');
      await js("document.querySelector('.sync-pins').click();pins[0].pause()");
      await waitFor('pins[0].paused&&!pins[1].paused');
      await js("document.querySelector('.sync-pins').click()",true);await waitFor('pins.every(v=>!v.paused)');
      await js('pins[0].pause()');await waitFor('pins.every(v=>v.paused)');
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      const id=await js('pinTestProject');await js("document.querySelector('#back-dashboard').click()");await waitFor("!document.querySelector('#dashboard').hidden");await waitFor(`!!document.querySelector('[data-project="${id}"]')`);await js(`document.querySelector('[data-project="${id}"]').click()`);
      await waitFor("!document.querySelector('#editor').hidden && document.querySelector('.sync-pins')?.checked && document.querySelectorAll('.pinned-results video').length===2");
      await js("document.querySelector('.pin-toolbar').scrollIntoView({block:'center'})");window.showInactive();await new Promise(r=>setTimeout(r,800));fs.writeFileSync(path.join(directory,'pin-sync-ui.png'),(await window.webContents.capturePage()).toPNG());window.hide();
      console.log('PASS: two real private videos play/pause/seek/rate together, retain playback across history selection, independent when unchecked, saved preference restores.');app.quit();
    }catch(error){console.error(error);window.destroy();app.quit();}
  });
});
require('../desktop/main.cjs');
