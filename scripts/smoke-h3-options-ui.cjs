// Isolated database and real renderer. Generation is intercepted: no GPU jobs.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
const directory=process.env.DIRECTOR_H3_TEST_DIR||fs.mkdtempSync(path.join(root,'.test-data','h3-options-ui-'));
app.setPath('userData',path.join(directory,'profile'));
let backend,failed=false;
app.whenReady().then(async()=>{
  const bootstrap=`import json, socket
import backend.generation as generation
original_comfy_at = generation.comfy_at
async def stub_comfy_at(base, path, data=None):
    if path.startswith('/object_info/'):
        return {}
    return await original_comfy_at(base, path, data)
generation.comfy_at = stub_comfy_at
from backend.config import load_config
from backend.__main__ import main
config = load_config()
if not (config['data_dir'] / 'postgres' / 'PG_VERSION').exists():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        config['postgres']['port'] = sock.getsockname()[1]
with (config['data_dir'] / 'config.json').open('r+', encoding='utf-8') as stream:
    json.dump({k:v for k,v in config.items() if k not in ('data_dir','pg_bin')}, stream)
    stream.truncate()
main()
`;
  backend=spawn(path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['-c',bootstrap,'serve','--port','0','--desktop','--dev'],{
    cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...process.env,DIRECTOR_DATA_DIR:directory,DIRECTOR_BOOTSTRAP_TOKEN:'h3-turbo-ui-bootstrap'}});
  backend.stderr.on('data',data=>process.stderr.write(data));
  try{
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Backend timeout')),360000);
      readline.createInterface({input:backend.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.event==='ready'){clearTimeout(timer);resolve(v.port);}}catch{}});
      backend.once('error',error=>{clearTimeout(timer);reject(error);});
      backend.once('exit',()=>{clearTimeout(timer);reject(Error('Backend exited'));});
    });
    const origin=`http://127.0.0.1:${port}`;
    const win=new BrowserWindow({width:1180,height:900,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    await win.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:'h3-turbo-ui-bootstrap',httpOnly:true,path:'/',sameSite:'strict'});
    await win.loadURL(origin);
    const js=code=>win.webContents.executeJavaScript(code,true).catch(error=>{console.error('Renderer failed:',code);throw error;});
    const wait=async code=>{for(let n=0;n<300;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+code);};
    const check=async(code,message)=>{if(!await js(code))throw Error(message);};
    await wait("!!document.querySelector('#login-panel h2')");
    await js(`window.smokeApi=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(JSON.stringify(d));return d;};void 0;`);
    await js(`(async()=>{if(document.querySelector('#login-panel h2').textContent==='创建第一个账号')await smokeApi('/api/setup',{login:'h3-ui',password:'h3-ui-password-123'});await smokeApi('/api/login',{login:'h3-ui',password:'h3-ui-password-123'});await directorStudio.enter(await smokeApi('/api/me'));document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='H3 Turbo UI';document.querySelector('#project-form').requestSubmit();})()`);
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
    await js(`(()=>{const s=document.querySelector('[data-field=model]');s.value='minimax-h3';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await check("document.querySelector('[data-field=h3_sampling]').value==='turbo'",'FL2VA defaults to Turbo');
    await js(`(()=>{const s=document.querySelector('[data-field=h3_sampling]');s.value='standard';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await check("Number(document.querySelector('[data-field=steps]').value)===20",'Standard restores 20 steps');
    await js(`(()=>{const s=document.querySelector('[data-field=h3_upscale]');s.value='4';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-field=h3_sage]').click();})()`);
    await check("document.querySelector('.h3-output-size').textContent.includes('3328 × 1920')",'Upscale dimensions incorrect');
    await js("directorStudio.save()");
    await js("document.querySelector('#back-dashboard').click()");
    await wait("!document.querySelector('#dashboard').hidden");
    await js("directorStudio.openProject(smokeProject)");
    await check("document.querySelector('[data-field=h3_sampling]').value==='standard' && document.querySelector('[data-field=h3_upscale]').value==='4' && document.querySelector('[data-field=h3_sage]').checked",'H3 options lost on reopen');
    // The shared API must reject missing extensions before inserting/submitting a job.
    await js(`(async()=>{const c=directorStudio.currentProject().body.canvas.cards[0];const r=await fetch('/api/projects/'+smokeProject+'/generate',{method:'POST',headers:{'Content-Type':'application/json','X-XSRFToken':decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('_xsrf=')).slice(6))},body:JSON.stringify({...c.drafts.text,model:'minimax-h3',card_id:c.id,mode:'text',prompt:'A bird flies.',request_id:crypto.randomUUID().replaceAll('-','')})});window.preflightStatus=r.status;window.preflightReply=await r.json();})()`);
    await check("preflightStatus===400 && /H3|缺少/.test(preflightReply.error)",'Missing node preflight must fail before generating');
    await check("(async()=>(await smokeApi('/api/projects/'+smokeProject+'/history')).history.length===0)()",'Failed preflight inserted generation history');
    await js("document.querySelector('[data-field=model]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    // Mixed reference numbering must remain per media type, and be literal text in HTML.
    await js(`(()=>{const c=directorStudio.currentProject().body.canvas.cards[0];c.drafts.reference={model:'minimax-h3-ref2va',prompt:'',refs:['1'.repeat(32),'2'.repeat(32),'3'.repeat(32),'4'.repeat(32)],ref_info:{['1'.repeat(32)]:{mime:'image/png'},['2'.repeat(32)]:{mime:'audio/wav'},['3'.repeat(32)]:{mime:'image/png'},['4'.repeat(32)]:{mime:'video/mp4'}}};const s=document.querySelector('[data-field=model]');s.value='minimax-h3-ref2va';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    console.log("Reference tokens:", await js("JSON.stringify([...document.querySelectorAll('.reference-token')].map(x=>x.textContent))"));
    await check("JSON.stringify([...document.querySelectorAll('.reference-token')].map(x=>x.textContent))===JSON.stringify(['<Picture 1>','<Audio 1>','<Picture 2>','<Video 1>'])",'H3 reference tokens incorrect');
    await js("document.querySelector('[data-field=prompt]').focus();directorEditing.claim('card:'+document.querySelector('[data-card]').dataset.card)");
    await js("document.querySelector('.reference-token').click()");
    await check("document.querySelector('[data-field=prompt]').value==='<Picture 1>'",'Reference insertion must preserve literal angle brackets');
    console.log('PASS: H3 modes, steps, upscale dimensions, persistence, missing-node preflight and reference tokens. No GPU generation submitted.');
    win.destroy();
  }catch(error){failed=true;console.error(error);}
  finally{
    if(backend.exitCode===null){backend.stdin.end('shutdown\n');await new Promise(resolve=>backend.once('exit',resolve));}
    app.exit(failed?1:0);
  }
});
