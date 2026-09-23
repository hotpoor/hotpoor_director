const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('backend/web/dialogue.js','utf8');
const count={textContent:''},checkboxes=[],status={textContent:''};
let failPage=0,failSave=false,saved=[],maxActive=0,active=0;
const context={
  wikiSelections:[],wikiBusy:false,busy:false,pending:false,current:'conversation',currentBody:{},
  wikiDirectoryFiles:new Map(),wikiPanel:{querySelector:()=>count,querySelectorAll:()=>[]},
  wikiTreeEl:{querySelectorAll:()=>checkboxes},wikiTreeStatus:status,status,controls(){},
  apiWiki:async url=>{
    const page=Number(new URL('http://local/'+url).searchParams.get('page'));
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,1));active--;
    if(page===failPage)throw Error('page failed');
    return {items:Array.from({length:100},(_,i)=>({kind:'file',path:'folder/'+((page-1)*100+i)+'.md',name:'File'})),pagination:{pages:51,total:5100}};
  },
  api:async (path,data)=>{
    if(failSave)throw Error('save failed');
    saved=data.selections;
    return {body:{wiki_selections:data.selections}};
  }
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function rememberWikiFiles('),source.indexOf('  async function wikiRenderRoot()')),context);
(async()=>{
  await vm.runInContext("wikiSelectDir('folder')",context);
  assert.equal(saved.length,5100);assert.equal(context.wikiSelections.length,5100);assert.ok(maxActive<=4);
  checkboxes.push({dataset:{wikiKind:'directory',wikiPath:'folder'}},{dataset:{wikiKind:'file',wikiPath:'folder/5099.md'}});
  vm.runInContext('refreshWikiSelUI()',context);assert.equal(checkboxes[0].checked,true);assert.equal(checkboxes[1].checked,true);
  context.wikiSelections=context.wikiSelections.slice(0,-1);
  vm.runInContext('refreshWikiSelUI()',context);assert.equal(checkboxes[0].checked,false);assert.equal(checkboxes[0].indeterminate,true);assert.equal(checkboxes[1].checked,false);
  const before=context.wikiSelections;
  failPage=51;
  await vm.runInContext("wikiSelectDir('folder')",context);
  assert.equal(context.wikiSelections,before);assert.match(status.textContent,/未更改/);
  failPage=0;failSave=true;
  await vm.runInContext('wikiChange(()=>[])',context);assert.equal(context.wikiSelections,before);
  assert.equal(context.busy,false);assert.equal(context.wikiBusy,false);
  failSave=false;
  await vm.runInContext('wikiChange(()=>[])',context);assert.equal(context.wikiSelections.length,0);
  console.log('Wiki: 5100 selections, 51 pages, bounded concurrency, partial selection, failed page/save rollback passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
