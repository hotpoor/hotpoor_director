const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'cancel-profile'));
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
        const rows=['running','queued'].map((status,i)=>({block_id:String(i+1).repeat(32),createtime:Date.now(),body:{card_id:card,type:'image',status,model:'z-image-turbo',mode:'text',submitted_at:Date.now(),outputs:[],params:{width:512,height:512,steps:20,prompt:'test',seed:1},usage:{tokens:null},refs:[],progress:{phase:'sampling',node:'8',value:2,maximum:20}}}));
        const original=window.fetch;window.cancelCalls=[];
        window.fetch=async(input,options)=>{
          if(input==='/api/projects/'+project.block_id+'/history')return new Response(JSON.stringify({history:rows}),{headers:{'Content-Type':'application/json'}});
          const job=rows.find(r=>input==='/api/generations/'+r.block_id+'/cancel');
          if(job){window.cancelCalls.push(job.block_id);job.body.status='cancelled';return new Response(JSON.stringify(job),{headers:{'Content-Type':'application/json'}});}
          return original(input,options);
        };
      })()`);
      await waitFor("document.querySelectorAll('[data-cancel-job]').length===2");
      await js("document.querySelector('.generation-queue').open=true;document.querySelector('.card-content').scrollTop=10000");
      await new Promise(r=>setTimeout(r,1500));
      if(!await js("document.querySelector('.generation-queue').open && !document.querySelector('.card-content').contains(document.querySelector('[data-cancel-job]'))"))throw Error('Queue collapsed or control inside scrolling area');
      await js("document.querySelector('.generation-queue [data-cancel-job]').click()");
      await waitFor("window.cancelCalls.length===1 && document.querySelectorAll('[data-cancel-job]').length===1");
      if(!await js("window.cancelCalls[0]==='2'.repeat(32)"))throw Error('Wrong queued job cancelled');
      window.showInactive();await new Promise(r=>setTimeout(r,500));fs.writeFileSync(path.join(directory,'cancel-ui.png'),(await window.webContents.capturePage()).toPNG());window.hide();
      await js("document.querySelector('[data-cancel-job]').click()");
      await waitFor("window.cancelCalls.length===2 && !document.querySelector('[data-cancel-job]')");
      if(!await js("document.querySelector('.history-strip').textContent.includes('已停止')"))throw Error('Stopped history label absent');
      console.log('PASS: mocked queue UI, sticky controls, expansion persistence, targeted buttons, stopped history.');app.quit();
    }catch(error){console.error(error);window.destroy();app.quit();}
  });
});
require('../desktop/main.cjs');
