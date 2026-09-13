const {app,BrowserWindow,clipboard,nativeImage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'preview-copy-profile'));
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
      const file=path.join(root,'assets/icon.png'),base64=fs.readFileSync(file).toString('base64');
      await js(`(async()=>{const form=new FormData();form.append('file',new File([Uint8Array.from(atob('${base64}'),c=>c.charCodeAt(0))],'copy-test.png',{type:'image/png'}));const r=await fetch('/api/assets',{method:'POST',headers:{'X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:form});if(!r.ok)throw Error('Upload failed');const asset=await r.json();const image=document.createElement('img');image.id='copy-fixture';image.src=asset.url;image.dataset.preview=asset.url;image.dataset.previewTitle='复制原图测试';document.body.append(image);image.click();})()`);
      await waitFor("document.querySelector('#image-preview').open && !document.querySelector('[data-action=copy]').disabled");
      window.show();window.focus();await new Promise(r=>setTimeout(r,300));
      await js("document.querySelector('[data-action=out]').click();document.querySelector('[data-action=out]').click();document.querySelector('.preview-stage').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-2,clientY:innerHeight-2}))",true);
      if(!await js("(()=>{const menu=document.querySelector('.preview-copy-menu'),r=menu.getBoundingClientRect();return !menu.hidden&&r.right<=innerWidth&&r.bottom<=innerHeight;})()"))throw Error('Context menu outside viewport');
      fs.writeFileSync(path.join(directory,'preview-copy-menu.png'),(await window.webContents.capturePage()).toPNG());
      await js("document.querySelector('.preview-copy-menu button').click()",true);
      await waitFor("document.querySelector('.preview-copy-status').textContent.includes('已复制')");
      const item=(await clipboard.read()).find(item=>item.types.includes('image/png'));
      if(!item)throw Error('Clipboard has no PNG image');
      const copied=nativeImage.createFromBuffer(Buffer.from(await(await item.getType('image/png')).arrayBuffer())),expected=nativeImage.createFromPath(file);
      if(copied.isEmpty()||JSON.stringify(copied.getSize())!==JSON.stringify(expected.getSize()))throw Error('Clipboard missing native image dimensions');
      if(!copied.toBitmap().equals(expected.toBitmap()))throw Error('Copied pixels differ from original');
      await js("document.querySelector('.preview-stage').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}));document.querySelector('.preview-copy-menu button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));");
      if(!await js("document.querySelector('#image-preview').open && document.querySelector('.preview-copy-menu').hidden"))throw Error('Escape should close menu before preview');
      await js("document.querySelector('#image-preview').dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true}))",true);
      await waitFor("document.querySelector('.preview-copy-status').textContent.includes('已复制')");
      await js("document.querySelector('[data-action=close]').click()");window.hide();
      console.log('PASS: right-click copy menu stays on screen, actual OS clipboard contains full-size original pixels after zoom, Escape dismissal and Ctrl+C.');app.quit();
    }catch(error){console.error(error);window.destroy();app.quit();}
  });
});
require('../desktop/main.cjs');
