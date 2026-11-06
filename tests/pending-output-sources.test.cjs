const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../backend/web/studio.js'),'utf8');
const chunk=(start,end)=>source.slice(source.indexOf('  function '+start),source.indexOf('  function '+end));
const ctx=vm.createContext({URL,esc:s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')});
vm.runInContext(chunk('publicMediaUrl(','outputUrl(')+chunk('mediaSource(','outputSources('),ctx);
test('pending generated links are clickable during transfer, including existing jobs',()=>{
 for(const field of ['source_outputs','pending_outputs']){
  const html=ctx.pendingOutputSources({body:{outputs:[],[field]:['https://provider.example/result.mp4?token=temporary']}});
  assert.match(html,/href="https:\/\/provider.example\/result.mp4\?token=temporary"/);
  assert.match(html,/打开 \/ 下载/);assert.match(html,/转存仍在继续/);
  assert.match(html,/rel="noopener noreferrer"/);
 }
});
test('archived outputs replace pending links, unsafe URLs are omitted',()=>{
 assert.equal(ctx.pendingOutputSources({body:{outputs:[{remote_url:'https://cloud.example/video.mp4'}],source_outputs:['https://provider.example/video.mp4']}}),'');
 assert.equal(ctx.pendingOutputSources({body:{outputs:[],pending_outputs:['javascript:alert(1)','data:text/html,bad','/internal']}}),'');
});
