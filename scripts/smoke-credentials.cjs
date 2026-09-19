const {app,safeStorage}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {createVault}=require('../desktop/credentials.cjs');
app.whenReady().then(()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'director-real-vault-'));try{const v=createVault(dir,safeStorage);v.save('test_password','test-only-493!');assert.equal(v.get('test_password'),'test-only-493!');assert(!fs.readFileSync(path.join(dir,'credentials.encrypted.json'),'utf8').includes('test-only-493!'));v.remove('test_password');console.log('Electron OS encryption roundtrip passed');}finally{fs.rmSync(dir,{recursive:true,force:true});}app.quit();}).catch(e=>{console.error(e.message);app.exit(1);});
