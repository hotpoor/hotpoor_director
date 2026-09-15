// Real Chromium top-layer and keyboard checks; no accounts or backend required.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.test-data/dialogs-'));
app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{try{
  const win=new BrowserWindow({width:1000,height:740,show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  const js=s=>win.webContents.executeJavaScript(s,true);
  const wait=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,20));}throw Error(s);};
  await win.loadFile(path.join(root,'desktop/failure.html'));
  await js(`document.body.insertAdjacentHTML('beforeend','<dialog id="under"><button id="trigger">移除卡片</button></dialog>');document.querySelector('#under').showModal();document.querySelector('#trigger').focus();window.result='pending';void directorDialogs.confirm('移除此卡片？项目中的生成历史仍会保留。',{title:'移除卡片',acceptLabel:'移除卡片'}).then(v=>window.result=v);`);
  await wait("!!document.querySelector('.director-message-dialog[open]')");
  assert.equal(await js("document.activeElement.hasAttribute('data-cancel')"),true);
  assert.equal(await js("(()=>{const r=document.querySelector('.director-message-dialog').getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2).closest('dialog').className})()"),'director-message-dialog');
  fs.writeFileSync(path.join(directory,'confirmation.png'),(await win.webContents.capturePage()).toPNG());
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await wait("window.result===false");
  assert.equal(await js("document.activeElement.id"),'trigger');
  assert.equal(await js("document.querySelector('#under').open"),true);
  await js("window.results=[];void directorDialogs.confirm('<img src=x onerror=alert(1)>').then(v=>results.push(v));void directorDialogs.prompt('输入名称',{value:'项目'}).then(v=>results.push(v));");
  await wait("!!document.querySelector('.director-message-dialog[open]')");
  assert.equal(await js("document.querySelectorAll('.director-message-dialog').length"),1);
  assert.equal(await js("document.querySelector('.director-message-dialog p').children.length"),0);
  await js("document.querySelector('[data-accept]').click()");
  await wait("document.activeElement.tagName==='INPUT'");
  await js("document.querySelector('.director-message-dialog input').value='新名称';document.querySelector('[data-accept]').click()");
  await wait("results.length===2");assert.deepEqual(await js('results'),[true,'新名称']);
  await js("window.result='pending';void directorDialogs.prompt('取消输入').then(v=>result=v)");
  await wait("!!document.querySelector('[data-cancel]')");await js("document.querySelector('[data-cancel]').click()");await wait('result===null');
  win.setContentSize(360,460);
  const {showFailure}=require('../desktop/failure.cjs');
  const failure=showFailure('服务已停止','请退出后重新启动应用。',win);
  await wait("document.querySelector('#director-message-title')?.textContent==='服务已停止'");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await new Promise(r=>setTimeout(r,60));assert.equal(await js("document.querySelector('.director-message-dialog').open"),true);
  assert.equal(await js("document.documentElement.scrollWidth>innerWidth"),false);
  fs.writeFileSync(path.join(directory,'failure-narrow.png'),(await win.webContents.capturePage()).toPNG());
  await js("document.querySelector('[data-accept]').click()");await failure;
  // A startup error must render even when no backend or workspace exists.
  const startup=showFailure('无法启动','后端启动失败。');
  let errorWindow;
  for(let i=0;i<100;i++) {errorWindow=BrowserWindow.getAllWindows().find(w=>w!==win);if(errorWindow&&await errorWindow.webContents.executeJavaScript("!!document.querySelector('.director-message-dialog[open]')").catch(()=>false))break;await new Promise(r=>setTimeout(r,20));}
  assert.ok(errorWindow);assert.equal(await errorWindow.webContents.executeJavaScript("document.querySelector('#director-message-title').textContent"),'无法启动');
  await errorWindow.webContents.executeJavaScript("document.querySelector('[data-accept]').click()");await startup;
  console.log('Dialogs passed: nested top layer, Escape, focus restoration, confirmation, prompt, queue, literal text, narrow layout, runtime and offline startup failures. Screenshots: '+directory);
}catch(error){console.error(error);process.exitCode=1;}finally{app.exit(process.exitCode||0);}});
