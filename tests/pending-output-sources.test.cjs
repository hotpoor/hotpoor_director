const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../backend/web/studio.js'),'utf8');
const chunk=(start,end)=>source.slice(source.indexOf('  function '+start),source.indexOf('  function '+end));
const ctx=vm.createContext({URL,esc:s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')});
vm.runInContext(chunk('publicMediaUrl(','outputUrl(')+chunk('mediaSource(','jobMedia('),ctx);
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

test('completed results keep both archive and provider URLs with expiry notice and received time',()=>{
 const html=ctx.outputSources({body:{provider:'service-inference',source_received_at:1700000000000,outputs:[{remote_url:'https://cloud.example/archive.mp4'}],source_outputs:['https://provider.example/original.mp4']}});
 assert.match(html,/https:\/\/cloud.example\/archive.mp4/);assert.match(html,/https:\/\/provider.example\/original.mp4/);
 assert.match(html,/可能存在时效/);assert.match(html,/收到时间/);
});
test('stage timestamps show measured intervals and unavailable history is explicit',()=>{
 const html=ctx.generationTimeline({provider:'service-inference',generation_timeline:[{stage:'source_received',at:1700000000000},{stage:'reading_output',at:1700000001250},{stage:'archived',at:1700000003500}]});
 assert.match(html,/1\.250 秒/);assert.match(html,/2\.250 秒/);assert.match(html,/归档完成/);assert.match(html,/<time datetime=/);
 assert.match(ctx.generationTimeline({provider:'service-inference'}),/未记录/);
});
