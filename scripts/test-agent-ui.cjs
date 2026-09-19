const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Element{constructor(){this.children=[];this.textContent='';}append(...items){this.children.push(...items);}querySelector(){return this.span||(this.span=new Element());}}
const source=fs.readFileSync('backend/web/dialogue.js','utf8');
let finish,runs=0,posts=0,fail=true;
const scope={document:{createElement:()=>new Element()},current:'conversation-a',status:{},render(){},apply(){},poll(){},window:{directorDesktop:{runCommand:()=>{runs++;return new Promise(resolve=>finish=resolve);}}},api:async path=>{assert.equal(path,'conversations/conversation-a');posts++;if(fail)throw Error('offline');return {};}};
vm.createContext(scope);vm.runInContext(source.slice(source.indexOf('  const toolExecutions='),source.indexOf('  function render(){'))+'\nthis.view=toolView;',scope);
(async()=>{const call={id:'call',status:'approval_required',argv:['pwd'],cwd:'.',reason:'test'};
const button=card=>card.children.at(-1).children.at(-1);
const first=scope.view({},call),running=button(first).onclick();
const refreshed=scope.view({},call);assert.equal(button(refreshed).disabled,true);assert.equal(button(refreshed).textContent,'执行中…');await button(refreshed).onclick();assert.equal(runs,1);
finish({stdout:'ok',exit_code:0});await running;
const retry=scope.view({},call);assert.equal(button(retry).textContent,'重试回传结果');fail=false;await button(retry).onclick();assert.equal(runs,1);assert.equal(posts,2);console.log('Agent polling state, duplicate prevention and result-only retry passed');})().catch(e=>{console.error(e);process.exitCode=1;});
