const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
if(process.platform==='win32')process.exit(0);
const child=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{console.log('interrupted');process.exit(0)});console.log('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','pipe']});
const source=fs.readFileSync('desktop/main.cjs','utf8');let output='';
const scope={child,process,setTimeout,activeCommands:new Map(),request:{executionId:'test'},publish(){}};
vm.createContext(scope);vm.runInContext('let finished=false,cancelled=false,killTimer;'+source.slice(source.indexOf('        const signalTree='),source.indexOf('        const timer=setTimeout(()=>{timedOut=true;'))+'\nthis.cleanup=()=>{finished=true;clearTimeout(killTimer)};',Object.assign(scope,{clearTimeout}));
child.stdout.on('data',data=>{output+=data;if(output.includes('ready'))scope.activeCommands.get('test')();});
child.on('close',code=>{scope.cleanup();assert.equal(code,0);assert.ok(output.includes('interrupted'));assert.equal(vm.runInContext('cancelled',scope),true);console.log('Live command received SIGINT and preserved output');});
