const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createVault,resolveCredentials}=require('../desktop/credentials.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'director-vault-'));
const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from([...s].reverse().join('')),decryptString:b=>[...b.toString()].reverse().join('')};
try{
 const vault=createVault(dir,storage);vault.save('database_password','unique-test-password');assert.deepEqual(vault.list(),['database_password']);
 assert(!fs.readFileSync(path.join(dir,'credentials.encrypted.json'),'utf8').includes('unique-test-password'));
 const r=resolveCredentials(['env','DB_PASSWORD={{credential:database_password}}','python3','script.py'],vault);
 assert.deepEqual(r.argv,['python3','script.py']);assert.equal(r.env.DB_PASSWORD,'unique-test-password');assert.equal(r.redact('value unique-test-password'),'value [凭据已隐藏]');
 assert.throws(()=>resolveCredentials(['echo','{{credential:database_password}}'],vault));
 vault.save('database_password','updated');assert.equal(createVault(dir,storage).get('database_password'),'updated');
 vault.remove('database_password');assert.throws(()=>vault.get('database_password'));
 assert.throws(()=>createVault(dir,{isEncryptionAvailable:()=>false}).save('test','secret'));
 console.log('Credential persistence, update/delete, environment injection and redaction passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
