const {createAuthorization}=require('./agent-authorization.cjs');
const {createCommandOutput}=require('./command-output.cjs');
const {app, BrowserWindow, nativeTheme, ipcMain, shell, dialog, safeStorage} = require('electron');
const {spawn} = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const {randomBytes} = require('node:crypto');
const fs = require('node:fs');
const {showFailure} = require('./failure.cjs');
const {createVault,resolveCredentials}=require('./credentials.cjs');

let backend;
let closing = false;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  app.setAppUserModelId('com.hotpoor.director');
  const root = path.resolve(__dirname, '..');
  if (process.platform === 'darwin') app.dock.setIcon(path.join(root, 'assets', 'icon.png'));
  const development = !app.isPackaged;
  const localDirectory = path.join(root, '.local');
  const savedDirectory = app.getPath('userData');
  const dataDirectory = process.env.DIRECTOR_DATA_DIR || (development &&
    (fs.existsSync(path.join(localDirectory, 'config.json')) || !fs.existsSync(path.join(savedDirectory, 'config.json')))
    ? localDirectory : savedDirectory);
  const vault=createVault(dataDirectory,safeStorage);
  const authorization=createAuthorization(dataDirectory);
  const agentPermissionsPath=path.join(dataDirectory,'agent-permissions.json');
  const defaultAgentFolder=fs.existsSync(path.join(app.getPath('home'),'Sites'))?path.join(app.getPath('home'),'Sites'):root;
  const readAgentFolders=()=>{try{const value=JSON.parse(fs.readFileSync(agentPermissionsPath,'utf8'));return [...new Set(value.folders.filter(item=>typeof item==='string'&&path.isAbsolute(item)&&fs.existsSync(item)&&fs.statSync(item).isDirectory()).map(item=>fs.realpathSync(item)))];}catch{return [fs.realpathSync(defaultAgentFolder)];}};
  const writeAgentFolders=folders=>{fs.mkdirSync(dataDirectory,{recursive:true});const temporary=agentPermissionsPath+'.tmp-'+process.pid;fs.writeFileSync(temporary,JSON.stringify({folders},null,2),{mode:0o600});fs.renameSync(temporary,agentPermissionsPath);};
  const bootstrapToken = randomBytes(32).toString('hex');
  const windows = process.platform === 'win32';
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', windows ? 'director-backend.exe' : 'director-backend')
    : path.join(root, '.venv', windows ? 'Scripts/python.exe' : 'bin/python');
  const args = [...(app.isPackaged ? [] : ['-m', 'backend']), 'serve', '--port', '0', '--desktop', ...(development ? ['--dev'] : [])];
  backend = spawn(executable, args, {
    cwd: app.isPackaged ? process.resourcesPath : root,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env,
      DIRECTOR_BOOTSTRAP_TOKEN: bootstrapToken,
      DIRECTOR_DATA_DIR: dataDirectory,
      DIRECTOR_PG_BIN: path.join(app.isPackaged ? process.resourcesPath : path.join(root, 'runtime'), 'pgsql', 'bin')}
  });
  backend.stderr.on('data', data => process.stderr.write(data));
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后端启动超时，请检查本地 PostgreSQL 配置。')), 360000);
      const lines = readline.createInterface({input: backend.stdout});
      lines.on('line', line => {
        try { const data = JSON.parse(line); if (data.event === 'ready') {clearTimeout(timer); lines.close(); resolve(data.port);} } catch {}
      });
      backend.once('error', error => {clearTimeout(timer); reject(error);});
      backend.once('exit', () => {clearTimeout(timer); reject(new Error('后端启动失败。请运行 npm run backend 查看详情。'));});
    });
    const origin = `http://127.0.0.1:${port}`;
    const window = new BrowserWindow({width:1180,height:820,minWidth:640,minHeight:660, show:process.env.DIRECTOR_SMOKE_TEST !== '1',
      title:'Hotpoor Director · 导演工作站', backgroundColor:'#101010', autoHideMenuBar:true,
      icon:path.join(root, 'assets', windows ? 'icon.ico' : 'icon.png'),
      webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:process.env.DIRECTOR_SMOKE_TEST !== '1'}});
    ipcMain.handle('director:open-authorization', async (event, value) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== origin + '/') throw Error('Invalid sender');
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !url.pathname.endsWith('/authorize') || !/^[A-F0-9]{8}$/.test(url.searchParams.get('code') || '')) throw Error('Invalid authorization URL');
      await shell.openExternal(url.href);
    });
    ipcMain.handle('director:authorization-status',(event,id)=>{if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');return authorization.status(id);});
    ipcMain.handle('director:authorization-set',async(event,value)=>{
      if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');
      authorization.status(value?.conversationId);
      if(value.enabled!==true)return authorization.revoke(value.conversationId);
      const decision=await dialog.showMessageBox(window,{type:'warning',title:'完全访问 · 授权一个月',message:'允许此对话自动执行命令并使用现有凭据？',detail:'有效期30天。命令倒计时3秒后自动运行，可读写当前系统账号能访问的文件，并使用目前已保存的凭据。执行目录不是沙箱；系统权限仍由操作系统控制。可随时取消倒计时、停止命令或撤销授权。',buttons:['取消','授权30天'],defaultId:0,cancelId:0});
      return decision.response===1?authorization.grant(value.conversationId,vault.list()):authorization.status(value.conversationId);
    });
    const activeCommands=new Map();
    ipcMain.handle('director:stop-command',(event,id)=>{
      if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');
      const stop=activeCommands.get(id);if(!stop)return false;stop();return true;
    });
    ipcMain.handle('director:run-command', async (event, request) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== origin + '/') throw Error('Invalid sender');
      if(typeof request?.executionId!=='string'||! /^[a-f0-9-]{36}$/.test(request.executionId)||activeCommands.has(request.executionId))throw Error('执行标识不正确');
      const argv=request?.argv,cwdValue=request?.cwd||'.';
      if(!Array.isArray(argv)||!argv.length||argv.length>128||argv.some(value=>typeof value!=='string'||!value||value.length>8192))throw Error('命令参数不正确');
      if(typeof cwdValue!=='string'||cwdValue.length>2048)throw Error('工作目录不正确');
      const folders=readAgentFolders();if(!folders.length)throw Error('请先在对话设置中添加允许执行的文件夹');
      const expanded=cwdValue==='~'||cwdValue.startsWith('~/')?path.join(app.getPath('home'),cwdValue.slice(2)):cwdValue;
      const candidate=path.isAbsolute(expanded)?expanded:path.resolve(folders[0],expanded),cwd=fs.existsSync(candidate)?fs.realpathSync(candidate):candidate;
      if(!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory()||!folders.some(folder=>{const relative=path.relative(folder,cwd);return relative===''||!relative.startsWith('..')&&!path.isAbsolute(relative);}))throw Error('工作目录不在允许执行的文件夹内');
      if(request.automatic&&!authorization.allows(request.conversationId))throw Error('自动执行授权已失效，请手动确认');
      const resolved=resolveCredentials(argv,vault);
      if(resolved.names.length&&!authorization.allows(request.conversationId,resolved.names)){const decision=await dialog.showMessageBox(window,{type:'question',title:'允许使用凭据',message:'此命令申请使用：'+resolved.names.join('、'),detail:'工作目录：'+cwd+'\n命令：'+JSON.stringify(argv)+'\n密码将注入命令环境变量，命令本身可以读取该密码。',buttons:['取消','允许本次使用'],defaultId:0,cancelId:0});if(decision.response!==1)throw Error('已取消凭据使用');}
      if(request.automatic&&!authorization.allows(request.conversationId))throw Error('自动执行授权已撤销或到期');
      const startedAt=Date.now();
      return await new Promise(resolve=>{
        let finished=false,timedOut=false,cancelled=false,publishTimer=null,killTimer=null;
        const capture=createCommandOutput(resolved.secrets);
        const publish=()=>{publishTimer=null;if(!event.sender.isDestroyed())event.sender.send('director:command-output',{executionId:request.executionId,...capture.snapshot()});};
        const child=spawn(resolved.argv[0],resolved.argv.slice(1),{cwd,detached:process.platform!=='win32',windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,...resolved.env,TERM:'dumb',NO_COLOR:'1'}});
        const append=(name,data)=>{capture.append(name,data);if(!publishTimer)publishTimer=setTimeout(publish,100);};
        child.stdout.on('data',data=>append('stdout',data));child.stderr.on('data',data=>append('stderr',data));
        const signalTree=signal=>{if(!child.pid)return;try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
        const stop=()=>{if(finished||cancelled)return;cancelled=true;signalTree('SIGINT');killTimer=setTimeout(()=>{if(!finished)signalTree('SIGKILL');},3000);};
        activeCommands.set(request.executionId,stop);publish();
        const timer=setTimeout(()=>{timedOut=true;signalTree('SIGTERM');killTimer=setTimeout(()=>{if(!finished)signalTree('SIGKILL');},2000);},120000);
        const done=(code,signal,error)=>{if(finished)return;finished=true;activeCommands.delete(request.executionId);clearTimeout(killTimer);clearTimeout(timer);clearTimeout(publishTimer);capture.finish();publish();resolve({exit_code:Number.isInteger(code)?code:null,signal:signal||null,...capture.snapshot(),error:error?resolved.redact(error.message):cancelled?'用户已停止命令':null,cancelled,timed_out:timedOut,duration_ms:Date.now()-startedAt,cwd});};
        child.once('error',error=>done(null,null,error));child.once('close',(code,signal)=>done(code,signal));
      });
    });
    for(const [channel,handler] of Object.entries({
      'director:credentials-list':()=>vault.list(),
      'director:credentials-entries':()=>vault.entries(),
      'director:credentials-describe':value=>vault.describe(value?.name,value?.description),
      'director:credentials-save':value=>vault.save(value?.name,value?.secret,value?.description),
      'director:credentials-remove':value=>vault.remove(value)
    }))ipcMain.handle(channel,(event,value)=>{if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');return handler(value);});
    ipcMain.handle('director:agent-folders',event=>{if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');return readAgentFolders();});
    ipcMain.handle('director:add-agent-folder',async event=>{if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');const result=await dialog.showOpenDialog(window,{title:'选择允许代理执行命令的文件夹',properties:['openDirectory','createDirectory']});if(result.canceled||!result.filePaths[0])return readAgentFolders();const folders=[...new Set([...readAgentFolders(),fs.realpathSync(result.filePaths[0])])];writeAgentFolders(folders);return folders;});
    ipcMain.handle('director:remove-agent-folder',(event,value)=>{if(event.sender!==window.webContents||event.senderFrame?.url!==origin+'/')throw Error('Invalid sender');if(typeof value!=='string')throw Error('Invalid folder');const target=fs.existsSync(value)?fs.realpathSync(value):value,folders=readAgentFolders().filter(folder=>folder!==target);writeAgentFolders(folders);return folders;});
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    window.webContents.on('will-navigate', (event, url) => {if (new URL(url).origin !== origin) event.preventDefault();});
    await window.webContents.session.cookies.set({url:origin,name:'director_bootstrap',value:bootstrapToken,httpOnly:true,sameSite:'strict',path:'/'});
    await window.loadURL(origin);
    if (development) {
      console.log('Source development workspace ready:', origin);
      let refreshTimer;
      const watcher = fs.watch(path.join(root, 'backend', 'web'), {recursive:true}, () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {if (!window.isDestroyed()) window.webContents.reloadIgnoringCache();}, 200);
      });
      window.on('closed', () => {clearTimeout(refreshTimer); watcher.close();});
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') {
          event.preventDefault(); window.webContents.toggleDevTools();
        }
      });
    }
    backend.on('exit', async () => {if (!closing) {await showFailure('服务已停止', '请退出后重新启动应用。', window); app.quit();}});
  } catch (error) {await showFailure('无法启动', error.message); app.quit();}
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null || quitting) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  backend.stdin.on('error', () => {});
  backend.stdin.end('shutdown\n');
  backend.once('exit', () => {quitting = true; app.quit();});
  setTimeout(() => {backend.kill(); quitting = true; app.quit();}, 150000).unref();
});
