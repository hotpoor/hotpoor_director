const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAuthorization}=require('../desktop/agent-authorization.cjs');
const {createVault}=require('../desktop/credentials.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'director-auth-'));let time=1000;
try{
 const a=createAuthorization(dir,()=>time),id='a'.repeat(32),other='b'.repeat(32);
 assert.equal(a.status(id).active,false);a.grant(id,['existing']);assert.ok(a.allows(id,['existing']));assert.equal(a.allows(id,['new']),false);assert.equal(a.allows(other),false);
 assert.ok(createAuthorization(dir,()=>time).status(id).active);time+=10*365*24*60*60*1000;assert.equal(a.allows(id),true);
 fs.writeFileSync(path.join(dir,'agent-authorization.json'),JSON.stringify({[id]:{grantedAt:time,expiresAt:time+1000,credentials:['existing']},[other]:{grantedAt:0,expiresAt:1,credentials:[]}}));
 assert.ok(a.status(id).permanent);time+=2000;assert.ok(a.allows(id,['existing']));assert.equal(a.status(other).active,false);
 a.grant(id,['existing']);a.revoke(id);assert.equal(a.allows(id),false);assert.throws(()=>a.grant('../../x',[]));
 const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
 fs.writeFileSync(path.join(dir,'credentials.encrypted.json'),JSON.stringify({legacy:Buffer.from('fixture-secret').toString('base64')}));
 const v=createVault(dir,storage);assert.equal(v.get('legacy'),'fixture-secret');v.describe('legacy','开发数据库密码');assert.equal(v.get('legacy'),'fixture-secret');assert.equal(v.entries()[0].description,'开发数据库密码');assert.ok(!JSON.stringify(v.entries()).includes('fixture-secret'));
 v.save('token','fixture-token','资料服务令牌');assert.equal(v.get('token'),'fixture-token');assert.throws(()=>v.describe('token','x'.repeat(201)));
 console.log('Permanent authorization, legacy migration, scope, revocation and credential description migration passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
