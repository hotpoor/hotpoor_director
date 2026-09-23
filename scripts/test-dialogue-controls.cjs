const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map(),buttons=[{disabled:true},{disabled:true}];
function $(id){if(!nodes.has(id))nodes.set(id,{id,value:'model',setAttribute(){},querySelectorAll:()=>id==='#dialogue-list'?buttons:[]});return nodes.get(id);}
const context={$,refreshWikiSelUI(){},busy:true,pending:true,current:'conversation',model:$('#model'),key:$('#key'),question:$('#question')};
vm.createContext(context);
const source=fs.readFileSync('backend/web/dialogue.js','utf8');vm.runInContext(source.slice(source.indexOf('  function controls(){'),source.indexOf('  function fileLink(')),context);
vm.runInContext('controls()',context);assert.ok(buttons.every(b=>b.disabled));
assert.equal($('#dialogue-title').contentEditable,'false');assert.equal($('#dialogue-category').disabled,true);assert.equal($('#dialogue-archive').disabled,true);
context.busy=false;vm.runInContext('controls()',context);assert.ok(buttons.every(b=>!b.disabled));assert.equal($('#dialogue-send').disabled,true);
assert.equal($('#dialogue-title').contentEditable,'true');assert.equal($('#dialogue-description').contentEditable,'true');assert.equal($('#dialogue-category').disabled,false);assert.equal($('#dialogue-archive').disabled,false);
context.pending=false;vm.runInContext('controls()',context);assert.ok(buttons.every(b=>!b.disabled));assert.equal($('#dialogue-send').disabled,false);
console.log('Conversation navigation unlocks after busy operations, including while response is pending');
