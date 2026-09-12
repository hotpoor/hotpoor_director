const {app} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'electron-profile'));
process.env.DIRECTOR_SMOKE_TEST = '1';
process.env.DIRECTOR_DATA_DIR = directory;
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
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
      await js("document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='雨夜来信';document.querySelector('#project-form').elements.subtitle.value='一封未寄出的信，一座不眠的城市';document.querySelector('#project-form').elements.description.value='黑白影像短片。雨夜、街灯、窗边的人。'");
      await js(`(async()=>{const blob=await(await fetch('/static/brand/logo.png')).blob();const dt=new DataTransfer();dt.items.add(new File([blob],'cover-one.png',{type:'image/png'}));dt.items.add(new File([blob],'cover-two.png',{type:'image/png'}));const input=document.querySelector('#cover-upload');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor("document.querySelectorAll('#cover-list img').length===2 && !document.querySelector('#save-project').disabled");
      await js("document.querySelector('#project-form').requestSubmit()");
      await waitFor("!document.querySelector('#editor').hidden && !document.querySelector('#project-dialog').open");
      await js("document.querySelector('#add-image').click();document.querySelector('#add-video').click();document.querySelector('#fit-cards').click()");
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      for (const dir of ['n','s','e','w','ne','nw','se','sw']) {
        const before = await js(`(()=>{const c=document.querySelectorAll('[data-card]')[1],r=c.querySelector('[data-resize=${dir}]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:c.style.width,h:c.style.height}})()`);
        const dx=dir.includes('w')?-12:dir.includes('e')?12:0,dy=dir.includes('n')?-12:dir.includes('s')?12:0;
        window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(before.x),y:Math.round(before.y)});
        window.webContents.sendInputEvent({type:'mouseDown',x:Math.round(before.x),y:Math.round(before.y),button:'left',clickCount:1});
        window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(before.x+dx),y:Math.round(before.y+dy),button:'left'});
        window.webContents.sendInputEvent({type:'mouseUp',x:Math.round(before.x+dx),y:Math.round(before.y+dy),button:'left',clickCount:1});
        await new Promise(r=>setTimeout(r,50));
        const after=await js("(()=>{const c=document.querySelectorAll('[data-card]')[1];return {w:c.style.width,h:c.style.height}})()");
        if(before.w===after.w&&before.h===after.h)throw Error('Resize failed: '+dir);
      }
      const result = await js(`(async()=>{
        const list=await (await fetch('/api/projects')).json();const id=list.projects[0].block_id;
        const project=await (await fetch('/api/projects/'+id)).json();
        if(project.body.canvas.cards.length!==2)throw Error('Cards not saved');
        for(const el of document.querySelectorAll('[data-card]')) {
          const picker=el.querySelector('[data-field=model]'), tabs=el.querySelector('.generation-tabs');
          if(!(picker.compareDocumentPosition(tabs)&Node.DOCUMENT_POSITION_FOLLOWING))throw Error('Model must precede modes');
          if(el.querySelector('[data-mode=reference]') || el.querySelectorAll('[data-mode]').length!==2)throw Error('Unsupported mode visible');
          picker.dispatchEvent(new Event('change',{bubbles:true}));
        }
        const card=document.querySelector('[data-card]');
        card.querySelector('[data-field=prompt]').value='A white cup on a black table';card.querySelector('[data-field=prompt]').dispatchEvent(new Event('input',{bubbles:true}));
        card.querySelector('[data-mode=image]').click();
        card.querySelector('[data-field=prompt]').value='Image draft';card.querySelector('[data-field=prompt]').dispatchEvent(new Event('input',{bubbles:true}));
        card.querySelector('[data-mode=text]').click();
        if(card.querySelector('[data-field=prompt]').value!=='A white cup on a black table')throw Error('Tab drafts lost');
        const selectModel = id => {const select=card.querySelector('[data-field=model]');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));};
        selectModel('z-image');
        if(card.querySelector('[data-field=steps]').value!=='40' || card.querySelector('[data-field=cfg]').value!=='4')throw Error('Standard defaults incorrect');
        const negative=card.querySelector('[data-field=negative_prompt]');negative.value='blur';negative.dispatchEvent(new Event('input',{bubbles:true}));
        card.querySelector('[data-mode=image]').click();
        if(card.querySelector('[data-field=model]').value!=='z-image' || card.querySelector('[data-field=steps]').value!=='40')throw Error('Standard mode lost model/defaults');
        card.querySelector('[data-mode=text]').click();
        if(card.querySelector('[data-field=negative_prompt]').value!=='blur')throw Error('Negative draft lost');
        selectModel('z-image-turbo');
        if(card.querySelector('[data-field=negative_prompt]') || card.querySelector('[data-field=cfg]') || card.querySelector('[data-field=steps]').value!=='8')throw Error('Turbo controls incorrect');
        selectModel('z-image');
        if(card.querySelectorAll('[data-resize]').length!==8)throw Error('Resize handles missing');
        return id;
      })()`);
      await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
      await js("document.querySelector('#fit-cards').click()");
      await new Promise(r=>setTimeout(r,1000));
      fs.writeFileSync(path.join(directory,'canvas.png'),(await window.webContents.capturePage()).toPNG());
      await js("document.querySelector('#back-dashboard').click()");
      await waitFor("!document.querySelector('#dashboard').hidden && document.querySelectorAll('.project-tile').length>0");
      fs.writeFileSync(path.join(directory,'dashboard.png'),(await window.webContents.capturePage()).toPNG());
      await js("document.querySelector('.project-tile').click()");
      await waitFor("!document.querySelector('#editor').hidden && document.querySelectorAll('[data-card]').length===2");
      if(!await js("document.querySelector('[data-field=model]').value==='z-image' && document.querySelector('[data-field=negative_prompt]').value==='blur'"))throw Error('Standard settings not persisted');
      window.setContentSize(640,760);
      await new Promise(r=>setTimeout(r,400));
      if(await js('document.documentElement.scrollWidth > innerWidth'))throw Error('Horizontal page overflow');
      fs.writeFileSync(path.join(directory,'canvas-narrow.png'),(await window.webContents.capturePage()).toPNG());
      const generationRecord = path.join(directory,'generation-record.json');
      if(fs.existsSync(generationRecord)) {
        const record = JSON.parse(fs.readFileSync(generationRecord,'utf8'));
        window.setContentSize(1164,780);
        await js("document.querySelector('#back-dashboard').click()");
        await waitFor("!document.querySelector('#dashboard').hidden");
        await js(`document.querySelector('[data-project="${record.body.project_id}"]').click()`);
        await waitFor("document.querySelector('.history-strip img')?.complete && document.querySelector('.history-strip img')?.naturalWidth > 0");
        await js("document.querySelector('[data-history]').click();document.querySelector('.pin-current').click()");
        await waitFor("document.querySelector('.pinned-results img')?.naturalWidth > 0 && document.querySelector('#save-status').textContent.startsWith('已自动保存')");
        if(!await js("document.querySelector('.history-details').textContent.includes('未提供')"))throw Error('Missing honest token metadata');
        const savedPins=await js(`fetch('/api/projects/${record.body.project_id}').then(r=>r.json()).then(p=>p.body.canvas.cards[0].pins)`);
        if(!savedPins.includes(record.block_id))throw Error('Pinned comparison was not persisted');
        await new Promise(r=>setTimeout(r,700));
        fs.writeFileSync(path.join(directory,'generation-history.png'),(await window.webContents.capturePage()).toPNG());
        await js("document.querySelector('.result-stage img').click()");
        await waitFor("document.querySelector('#image-preview').open && document.querySelector('.preview-stage img').naturalWidth > 0");
        await new Promise(r=>setTimeout(r,500));
        await js("document.querySelector('[data-action=actual]').click();document.querySelector('[data-action=in]').click()");
        if(!await js("document.querySelector('.preview-scale').textContent==='125%'"))throw Error('Preview zoom failed');
        const previewBox=await js("(()=>{const r=document.querySelector('.preview-stage').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
        window.webContents.sendInputEvent({type:'mouseDown',...previewBox,button:'left',clickCount:1});
        await new Promise(r=>setTimeout(r,80));
        window.webContents.sendInputEvent({type:'mouseMove',x:previewBox.x+40,y:previewBox.y+25,button:'left'});
        await new Promise(r=>setTimeout(r,80));
        window.webContents.sendInputEvent({type:'mouseUp',x:previewBox.x+40,y:previewBox.y+25,button:'left',clickCount:1});
        await waitFor("document.querySelector('.preview-stage img').style.transform.replaceAll(' ','').includes('translate(40px,25px)')");
        await js("document.querySelector('[data-action=fullscreen]').click()",true);
        await waitFor('!!document.fullscreenElement');
        await js("document.querySelector('[data-action=fullscreen]').click()",true);
        await waitFor('!document.fullscreenElement');
        if(!await js("document.querySelector('#image-preview').open"))throw Error('Leaving fullscreen closed the viewer');
        await js("document.querySelector('[data-action=fit]').click()");
        await new Promise(r=>setTimeout(r,400));
        fs.writeFileSync(path.join(directory,'image-preview.png'),(await window.webContents.capturePage()).toPNG());
        window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
        window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await waitFor("!document.querySelector('#image-preview').open");
        await js("document.querySelector('.pinned-results img').click()");
        await waitFor("document.querySelector('#image-preview').open");
        await js("document.querySelector('[data-action=close]').click()");
        await js("document.querySelector('.history-strip img').click()");
        await waitFor("!document.querySelector('#image-preview').open && document.querySelector('.history-strip .selected img').src === document.querySelector('.result-stage img').src");
        await waitFor("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
        console.log('Image preview verified: result/pins, history selects without opening preview, zoom, pan, system fullscreen, exit fullscreen, and Escape.');
      }
      console.log('Studio UI verified: project creation, two cards, independent tab drafts, 8 resize handles, autosave/reopen, narrow layout. Project '+result);
      app.quit();
    } catch(error) { console.error(error);process.exitCode=1;app.quit(); }
  });
});
require('../desktop/main.cjs');
