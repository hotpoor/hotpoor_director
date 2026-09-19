const fs=require('node:fs'),path=require('node:path');
const MONTH_MS=30*24*60*60*1000;
function createAuthorization(directory,now=Date.now){
 const file=path.join(directory,'agent-authorization.json');
 const valid=id=>{if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw Error('请先创建或打开一个对话');};
 const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}};
 const write=data=>{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);};
 return {
  status(id){valid(id);const g=read()[id];return {active:Boolean(g&&Number.isFinite(g.expiresAt)&&now()<g.expiresAt&&g.expiresAt-g.grantedAt<=MONTH_MS),expiresAt:g?.expiresAt||null};},
  grant(id,names){valid(id);const data=read(),time=now();data[id]={grantedAt:time,expiresAt:time+MONTH_MS,credentials:[...names]};write(data);return this.status(id);},
  revoke(id){valid(id);const data=read();delete data[id];write(data);return this.status(id);},
  allows(id,names=[]){try{return this.status(id).active&&names.every(n=>(read()[id]?.credentials||[]).includes(n));}catch{return false;}}
 };
}
module.exports={createAuthorization,MONTH_MS};
