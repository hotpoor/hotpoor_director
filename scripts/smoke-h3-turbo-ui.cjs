// Isolated database and real renderer. Generation is intercepted: no GPU jobs.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.test-data','h3-turbo-ui-'));
app.setPath('userData',path.join(directory,'profile'));
let backend,failed=false;
app.whenReady().then(async()=>{
  const bootstrap=`import json, socket
from backend.config import load_config
from backend.__main__ import main
config = load_config()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    config['postgres']['port'] = sock.getsockname()[1]
with (config['data_dir'] / 'config.json').open('r+', encoding='utf-8') as stream:
    json.dump({k:v for k,v in config.items() if k not in ('data_dir','pg_bin')}, stream)
    stream.truncate()
main()
`;
  backend=spawn(path.join(root,'.venv','Scripts','python.exe'),['-c',bootstrap,'serve','--port','0','--desktop','--dev'],{
    cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'h3-turbo-ui-bootstrap'}});
  backend.stderr.on('data',data=>process.stderr.write(data));
  try{
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Backend timeout')),180000);
      readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(timer);resolve(v.port);}}catch{}});
      backend.once('error',error=>{clearTimeout(timer);reject(error);});
      backend.once('exit',()=>{clearTimeout(timer);reject(Error('Backend exited'));});
    });
    const origin=`http://127.0.0.1:${port}`;
    const win=new BrowserWindow({width:1180,height:900,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'h3-turbo-ui-bootstrap',httpOnly:true,path:'/',sameSite:'strict'});
    await win.loadURL(origin);
    const js=code=>win.webContents.executeJavaScript(code,true);
    const wait=async code=>{for(let n=0;n<300;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+code);};
    const check=async(code,message)=>{if(!await js(code))throw Error(message);};
    await wait("document.querySelector('#login-panel h2').textContent==='创建第一个账号'");
    await js(`window.smokeApi=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};void 0;`);
    await js(`(async()=>{await smokeApi('/api/setup',{login:'h3-ui',password:'h3-ui-password-123'});await smokeApi('/api/login',{login:'h3-ui',password:'h3-ui-password-123'});await directorStudio.enter(await smokeApi('/api/me'));document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='H3 Turbo UI';document.querySelector('#project-form').requestSubmit();})()`);
    await wait("!document.querySelector('#editor').hidden");
    await js("document.querySelector('#add-video').click()");
    await js("document.querySelector('[data-field=model]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js(`(()=>{const s=document.querySelector('[data-field=model]');s.value='minimax-h3-ref2va';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait("!!document.querySelector('[data-field=turbo_mode]')");
    await js("document.querySelector('[data-field=turbo_mode]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await check("!document.querySelector('[data-field=turbo_mode]').checked && Number(document.querySelector('[data-field=steps]').value)===20",'Legacy/default mode should remain standard 20 steps');
    await js("document.querySelector('[data-field=turbo_mode]').click()");
    await check("document.querySelector('[data-field=turbo_mode]').checked && document.querySelector('[data-field=steps]').readOnly && Number(document.querySelector('[data-field=steps]').value)===4",'Turbo should lock to 4 steps');
    await js("directorStudio.save()");
    await js("window.smokeProject=directorStudio.currentProject().block_id;document.querySelector('#back-dashboard').click()");
    await wait("!document.querySelector('#dashboard').hidden");
    await js("directorStudio.openProject(smokeProject)");
    await wait("!!document.querySelector('[data-field=turbo_mode]')");
    await js("document.querySelector('[data-field=turbo_mode]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await check("document.querySelector('[data-field=turbo_mode]').checked && Number(document.querySelector('[data-field=steps]').value)===4",'Turbo setting lost on reopen');
    await js("document.querySelector('[data-field=turbo_mode]').click()");
    await check("!document.querySelector('[data-field=steps]').readOnly && Number(document.querySelector('[data-field=steps]').value)===20",'Standard mode should restore 20 steps');
    await js("document.querySelector('[data-field=turbo_mode]').click();directorStudio.save()");
    await check("directorStudio.currentProject().body.canvas.cards[0].drafts.reference.turbo_mode===true",'Turbo not saved as boolean');
    console.log('PASS: H3 Turbo default, 4-step lock, standard restore, boolean persistence and save/reopen. No generation submitted.');
    win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{
    if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}
    app.exit(failed?1:0);
  }
});
