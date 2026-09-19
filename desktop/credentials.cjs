const fs=require('node:fs');
const path=require('node:path');
function createVault(directory,safeStorage){
 const file=path.join(directory,'credentials.encrypted.json');
 function available(){if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('系统安全存储不可用，无法保存或使用密码');}
 function read(){if(!fs.existsSync(file))return {};const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw Error('凭据文件格式错误');return value;}
 function name(value){if(typeof value!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value))throw Error('凭据名称需为字母开头的英文、数字、下划线或短横线（最多64字）');return value;}
 function write(value){fs.mkdirSync(directory,{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);}
 return {
  list:()=>Object.keys(read()),
  entries:()=>Object.entries(read()).map(([name,value])=>({name,description:typeof value==='object'?value.description||'':''})),
  save:(key,secret,description='')=>{name(key);available();if(typeof description!=='string'||description.length>200)throw Error('中文描述最多200字符');if(typeof secret!=='string'||!secret||secret.length>8192)throw Error('密码需为1–8192字符');const data=read();if(!Object.hasOwn(data,key)&&Object.keys(data).length>=100)throw Error('最多保存100个凭据');Object.defineProperty(data,key,{value:{encrypted:safeStorage.encryptString(secret).toString('base64'),description:description.trim()},enumerable:true,configurable:true,writable:true});write(data);return Object.keys(data);},
  describe:(key,description)=>{name(key);if(typeof description!=='string'||description.length>200)throw Error('中文描述最多200字符');const data=read();if(!Object.hasOwn(data,key))throw Error('凭据不存在');data[key]={encrypted:typeof data[key]==='string'?data[key]:data[key].encrypted,description:description.trim()};write(data);},
  remove:key=>{name(key);const data=read();delete data[key];write(data);return Object.keys(data);},
  get:key=>{name(key);available();const data=read();if(!Object.hasOwn(data,key))throw Error('凭据不存在：'+key);return safeStorage.decryptString(Buffer.from(typeof data[key]==='string'?data[key]:data[key].encrypted,'base64'));}
 };
}
function resolveCredentials(argv,vault){
 const env={},secrets=[],names=[];let args=[...argv];
 // Explicit env prefix is consumed here, never passed to the env executable.
 if(args[0]==='env'){
  args.shift();while(args.length&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])){
   const assignment=args.shift(),i=assignment.indexOf('='),key=assignment.slice(0,i),value=assignment.slice(i+1),match=/^\{\{credential:([A-Za-z][A-Za-z0-9_-]{0,63})\}\}$/.exec(value);
   if(match){const secret=vault.get(match[1]);env[key]=secret;secrets.push(secret);names.push(match[1]);}else env[key]=value;
  }
 }
 if(!args.length||args.some(a=>a.includes('{{credential:')))throw Error('凭据只能通过 env NAME={{credential:name}} 注入环境变量');
 return {argv:args,env,names,secrets,redact:text=>secrets.reduce((s,secret)=>s.split(secret).join('[凭据已隐藏]'),text)};
}
module.exports={createVault,resolveCredentials};
