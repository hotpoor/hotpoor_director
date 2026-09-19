const {StringDecoder}=require('node:string_decoder');
// Hold any suffix that might be the beginning of a credential until more data arrives.
function redactLive(text,secrets,final=false){
  let end=text.length;
  if(!final)for(const secret of secrets)for(let n=1;n<secret.length&&n<=text.length;n++)if(text.endsWith(secret.slice(0,n)))end=Math.min(end,text.length-n);
  const pattern=secrets.filter(Boolean).sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  if(pattern)for(const match of text.matchAll(new RegExp(pattern,'g')))if(match.index<end&&match.index+match[0].length>end)end=match.index;
  const safe=text.slice(0,end);
  return pattern?safe.replace(new RegExp(pattern,'g'),'[凭据已隐藏]'):safe;
}
function createCommandOutput(secrets,limit=1024*1024){
  const text={stdout:'',stderr:''},decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};let truncated=false;
  function append(name,value){const room=limit-text[name].length;if(value.length>room)truncated=true;text[name]+=value.slice(0,room);}
  return {append:(name,data)=>append(name,decoders[name].write(data)),finish:()=>{for(const name of Object.keys(text))append(name,decoders[name].end());},snapshot:()=>({stdout:redactLive(text.stdout,secrets),stderr:redactLive(text.stderr,secrets),truncated})};
}
module.exports={redactLive,createCommandOutput};
