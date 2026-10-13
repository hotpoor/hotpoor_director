const {_electron}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const shared=fs.mkdtempSync(path.join(os.tmpdir(),'hotpoor-capture-ui-'));const apps=[];
const root=path.resolve(__dirname,'../../');
const roots={Director:root,SayAgain:process.env.CAPTURE_PEER_ROOT||root};
const harness=path.join(__dirname,'smoke-harness.cjs');
async function launch(name,priority){const env={...process.env,CAPTURE_SHARED_TEST:shared,CAPTURE_PRODUCT:name,CAPTURE_PRIORITY:String(priority),CAPTURE_ROOT:roots[name]};delete env.ELECTRON_RUN_AS_NODE;const a=await _electron.launch({executablePath:require(path.join(roots[name],'node_modules/electron')),args:[harness],env});apps.push(a);return a;}
async function until(fn){for(let n=0;n<80;n++){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('condition timed out');}
const state=a=>a.evaluate(()=>global.capture.state());
(async()=>{
 const low=await launch('SayAgain',50);const lp=await low.firstWindow();await lp.waitForSelector('#accelerator');await until(async()=>(await state(low)).registered);
 const high=await launch('Director',100);const hp=await high.firstWindow();await hp.waitForSelector('#accelerator');await until(async()=>(await state(high)).registered&&!(await state(low)).registered);
 assert.equal((await state(low)).owner,'Director');console.log('PASS two real Electron processes register one global shortcut');
 await lp.locator('#accelerator').fill('Control+Alt+Shift+F10');await lp.locator('#save').click();await until(async()=>(await state(high)).accelerator==='Control+Alt+Shift+F10'&&(await state(high)).registered);console.log('PASS shared shortcut synchronized');
 await high.evaluate(({globalShortcut})=>globalShortcut.register('Control+Alt+Shift+F11',()=>{}));
 await hp.locator('#accelerator').fill('Control+Alt+Shift+F11');await hp.locator('#save').click();await hp.waitForFunction(()=>document.querySelector('#status').textContent.includes('占用'));assert.equal((await state(high)).accelerator,'Control+Alt+Shift+F10');console.log('PASS conflict retains old registration');
 await lp.locator('#accelerator').fill('Control+Alt+Shift+F11');await lp.locator('#save').click();await lp.waitForFunction(()=>document.querySelector('#status').textContent.includes('占用'));assert.equal((await state(low)).accelerator,'Control+Alt+Shift+F10');await lp.locator('#accelerator').fill('Control+Alt+Shift+F10');console.log('PASS standby rejects external shortcut conflict');
 await high.evaluate(({globalShortcut})=>globalShortcut.unregister('Control+Alt+Shift+F11'));
 await lp.locator('#enabled').uncheck();await lp.locator('#save').click();await until(async()=>!(await state(high)).registered);console.log('PASS shared disable');
 await lp.locator('#enabled').check();await lp.locator('#priority').fill('200');await lp.locator('#save').click();await until(async()=>(await state(low)).registered&&!(await state(high)).registered);console.log('PASS priority handoff');
 await low.close();apps.splice(apps.indexOf(low),1);await until(async()=>(await state(high)).registered);console.log('PASS exit takeover');
 await hp.locator('#capture').click();await hp.waitForFunction(()=>!document.querySelector('#capture').disabled,{},{timeout:25000});console.log('CAPTURE STATUS',await hp.locator('#status').textContent());assert((await hp.locator('#status').textContent()).includes('已复制到剪贴板'));
 const size=await high.evaluate(async({clipboard,nativeImage})=>{const items=await clipboard.read();const blob=await items[0].getType('image/png');return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize();});assert(size.width>100&&size.height>100);console.log('PASS native capture writes clipboard',JSON.stringify(size));
 const before=await high.evaluate(async({clipboard})=>Buffer.from(await (await (await clipboard.read())[0].getType('image/png')).arrayBuffer()).toString('base64'));
 await high.evaluate(({nativeImage})=>{global.realCreateImage=nativeImage.createFromBuffer;nativeImage.createFromBuffer=()=>global.realCreateImage(Buffer.from('invalid'));});
 const failed=await high.evaluate(async()=>{try{await global.capture.capture();return false;}catch(error){return error.message.includes('截图为空');}});assert(failed);
 await high.evaluate(({nativeImage})=>{nativeImage.createFromBuffer=global.realCreateImage;});
 const after=await high.evaluate(async({clipboard})=>Buffer.from(await (await (await clipboard.read())[0].getType('image/png')).arrayBuffer()).toString('base64'));assert.equal(after,before);console.log('PASS invalid capture preserves previous clipboard');

 await hp.screenshot({path:path.join(shared,'settings.png')});assert(await hp.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const bad=await hp.evaluate(async()=>{try{await window.screenCapture.save({enabled:true,accelerator:'S',priority:100});return false;}catch{return true;}});assert(bad);console.log('PASS renderer validation and settings layout');
 const restarted=await launch('SayAgain',50);await until(async()=>(await state(restarted)).registered);assert.equal((await state(restarted)).priority,200);assert.equal((await state(restarted)).accelerator,'Control+Alt+Shift+F10');console.log('PASS persisted priority and shared shortcut after restart');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{for(const a of apps.reverse())await a.close().catch(()=>{});fs.rmSync(shared,{recursive:true,force:true});});
