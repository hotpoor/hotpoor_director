const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Element{constructor(){this.children=[];this.textContent='';this.dataset={};}append(...items){this.children.push(...items);}querySelector(){return this.span||(this.span=new Element());}}
const source=fs.readFileSync('backend/web/dialogue.js','utf8');
let finish,runs=0,posts=0,fail=true;
let now=1000;
const scope={authorizationState:{active:false},autoCountdowns:new Map(),autoCancelled:new Set(),crypto:require('node:crypto'),Date:{now:()=>now},setInterval(){},dialog:{querySelectorAll:()=>[]},document:{createElement:()=>new Element()},current:'conversation-a',status:{},render(){},apply(){},poll(){},window:{directorDesktop:{runCommand:()=>{runs++;return new Promise(resolve=>finish=resolve);}}},api:async path=>{assert.equal(path,'conversations/conversation-a');posts++;if(fail)throw Error('offline');return {};}};
vm.createContext(scope);vm.runInContext(source.slice(source.indexOf('  const toolExecutions='),source.indexOf('  function render(){'))+'\nthis.view=toolView;',scope);
(async()=>{for(const [ms,expected] of [[0,'0 秒'],[37000,'37 秒'],[60000,'1 分 0 秒（60 秒）'],[3600000,'1 时 0 分 0 秒（3600 秒）']])assert.equal(vm.runInContext('commandDuration('+ms+')',scope),expected);assert.equal(vm.runInContext('commandDuration(90061000)',scope),'1 天 1 时 1 分 1 秒（90061 秒）');const call={id:'call',status:'approval_required',argv:['pwd'],cwd:'.',reason:'test'};
const button=card=>card.children.at(-1).children.at(-1);
scope.authorizationState={conversation:'conversation-a',active:true,permanent:true};
const automatic=scope.view({},call);assert.equal(button(automatic).textContent,'3 秒后自动执行');const deadline=scope.autoCountdowns.get('conversation-a:call').deadline;
scope.view({},call);assert.equal(scope.autoCountdowns.get('conversation-a:call').deadline,deadline);
automatic.children.at(-1).children[0].onclick();assert.equal(scope.autoCountdowns.size,0);assert.ok(scope.autoCancelled.has('conversation-a:call'));assert.equal(button(scope.view({},call)).textContent,'允许执行');
const first=scope.view({},call),running=button(first).onclick();
now=66000;const refreshed=scope.view({},call);assert.equal(refreshed.children[0].textContent,'已执行 1 分 5 秒（65 秒）');assert.equal(button(refreshed).disabled,true);assert.equal(button(refreshed).textContent,'执行中…');await button(refreshed).onclick();assert.equal(runs,1);
finish({stdout:'ok',exit_code:0,duration_ms:65000});await running;
const retry=scope.view({},call);assert.equal(retry.children[0].textContent,'执行耗时 1 分 5 秒（65 秒）');assert.equal(button(retry).textContent,'重试回传结果');fail=false;await button(retry).onclick();assert.equal(runs,1);assert.equal(posts,2);console.log('Agent polling state, duplicate prevention and result-only retry passed');})().catch(e=>{console.error(e);process.exitCode=1;});
