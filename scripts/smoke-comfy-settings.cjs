const {app,BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.test-data', 'studio-smoke');
fs.mkdirSync(directory, {recursive:true});
app.setPath('userData', path.join(directory, 'comfy-settings-profile'));
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
      await js("document.querySelector('#open-comfy-settings').click()");
      await waitFor("document.querySelector('#comfy-dialog').open && !document.querySelector('#test-comfy').disabled");
      if(!await js("document.querySelector('#comfy-form').elements.host.value==='127.0.0.1' && document.querySelector('#comfy-form').elements.port.value==='8188'"))throw Error('Unexpected defaults');
      await js("document.querySelector('#test-comfy').click()");
      await waitFor("document.querySelector('#comfy-status').textContent.includes('连接成功')");
      await js("document.querySelector('#comfy-form').requestSubmit()");
      await waitFor("document.querySelector('#comfy-status').textContent.includes('已保存并生效')");
      const saved=JSON.parse(fs.readFileSync(path.join(directory,'.comfyui.json'),'utf8'));
      if(saved.host!=='127.0.0.1'||saved.port!==8188)throw Error('Persistence incorrect');
      await js("document.querySelector('#comfy-form').elements.port.value=1;document.querySelector('#test-comfy').click()");
      await waitFor("document.querySelector('#comfy-status').textContent.includes('连接失败')");
      if(JSON.parse(fs.readFileSync(path.join(directory,'.comfyui.json'),'utf8')).port!==8188)throw Error('Test changed saved settings');
      await js("document.querySelector('#default-comfy').click()");
      window.showInactive();await new Promise(r=>setTimeout(r,500));fs.writeFileSync(path.join(directory,'comfy-settings.png'),(await window.webContents.capturePage()).toPNG());window.hide();
      await js("document.querySelector('#close-comfy-settings').click();document.querySelector('#open-comfy-settings').click()");
      await waitFor("!document.querySelector('#test-comfy').disabled && document.querySelector('#comfy-form').elements.port.value==='8188'");
      console.log('PASS: dashboard settings, real connection probe, save persistence, failed probe preserves settings, defaults and reopen.');app.quit();
    }catch(error){console.error(error);window.destroy();app.quit();}
  });
});
require('../desktop/main.cjs');
