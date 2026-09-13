const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'queue-profile'));
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
      await js("document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='Cancellation controls UI';document.querySelector('#project-form').requestSubmit()");
      await waitFor("!document.querySelector('#editor').hidden && !document.querySelector('#project-dialog').open");
      await js("document.querySelector('#add-image').click()");
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      await js(`(async()=>{
        const project=(await(await fetch('/api/projects')).json()).projects[0];
        const card=document.querySelector('[data-card]').dataset.card;
        const rows=['running','queued','queued'].map((status,i)=>({block_id:String(i+1).repeat(32),createtime:Date.now(),body:{card_id:card,type:'image',status,queue_position:i||null,model:'z-image-turbo',mode:'text',submitted_at:Date.now(),outputs:[],params:{width:512,height:512,steps:20,prompt:'test',seed:1},usage:{tokens:null},refs:[],progress:{phase:'sampling',node:'8',value:2,maximum:20}}}));
        const original=window.fetch;window.cancelCalls=[];
        window.fetch=async(input,options)=>{
          if(input==='/api/projects/'+project.block_id+'/history')return new Response(JSON.stringify({history:rows,reorder_available:true}),{headers:{'Content-Type':'application/json'}});
          if(input==='/api/projects/'+project.block_id+'/queue-order'){
            const data=JSON.parse(options.body);window.lastOrder=data.order;
            data.order.forEach((id,index)=>rows.find(r=>r.block_id===id).body.queue_position=index+1);
            return new Response(JSON.stringify({reordered:true}),{headers:{'Content-Type':'application/json'}});
          }
          const job=rows.find(r=>input==='/api/generations/'+r.block_id+'/cancel');
          if(job){window.cancelCalls.push(job.block_id);job.body.status='cancelled';return new Response(JSON.stringify(job),{headers:{'Content-Type':'application/json'}});}
          return original(input,options);
        };
      })()`);
      await waitFor("document.querySelector('#queue-count').textContent==='3'");
      await js("document.querySelector('#toggle-queue').click()");
      await waitFor("!document.querySelector('#queue-panel').hidden && document.querySelectorAll('.queue-item').length===3");
      if(!await js("document.querySelector('.queue-item').draggable===false && document.querySelectorAll('.queue-item[draggable=true]').length===2"))throw Error('Running job movable');
      await js("document.querySelectorAll('[data-queue-up]')[2].click()");
      await waitFor("window.lastOrder?.[0]==='3'.repeat(32) && document.querySelectorAll('.queue-item')[1].dataset.queueJob==='3'.repeat(32)");
      await js("(()=>{const dt=new DataTransfer(),source=document.querySelectorAll('.queue-item')[2],target=document.querySelectorAll('.queue-item')[1];source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));})()");
      await waitFor("window.lastOrder?.[0]==='2'.repeat(32) && document.querySelectorAll('.queue-item')[1].dataset.queueJob==='2'.repeat(32)");
      await js("document.querySelector('[data-locate-card]').click()");
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      window.showInactive();await new Promise(r=>setTimeout(r,800));fs.writeFileSync(path.join(directory,'queue-ui.png'),(await window.webContents.capturePage()).toPNG());window.hide();
      await js("document.querySelectorAll('[data-queue-stop]')[2].click()");
      await waitFor("document.querySelectorAll('.queue-item').length===2 && window.cancelCalls.length===1");
      await js("document.querySelector('#close-queue').click()");
      if(!await js("document.querySelector('#queue-panel').hidden && document.querySelector('#toggle-queue').getAttribute('aria-expanded')==='false'"))throw Error('Collapse failed');
      console.log('PASS: queue sidebar, running lock, arrows, drag reorder, card location, cancellation and collapse (mocked transport).');app.quit();
    }catch(error){console.error(error);window.destroy();app.quit();}
  });
});
require('../desktop/main.cjs');
