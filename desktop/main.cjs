const {app, BrowserWindow, nativeTheme, ipcMain, shell} = require('electron');
const {spawn} = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const {randomBytes} = require('node:crypto');
const fs = require('node:fs');
const {showFailure} = require('./failure.cjs');

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
    ipcMain.handle('director:run-command', async (event, request) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== origin + '/') throw Error('Invalid sender');
      const argv=request?.argv,cwdValue=request?.cwd||'.';
      if(!Array.isArray(argv)||!argv.length||argv.length>128||argv.some(value=>typeof value!=='string'||!value||value.length>8192))throw Error('命令参数不正确');
      if(typeof cwdValue!=='string'||cwdValue.length>2048||path.isAbsolute(cwdValue))throw Error('工作目录必须是工作区内的相对路径');
      const cwd=path.resolve(root,cwdValue),relative=path.relative(root,cwd);
      if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory())throw Error('工作目录不在当前工作区内');
      const startedAt=Date.now();
      return await new Promise(resolve=>{
        let stdout='',stderr='',finished=false,timedOut=false,truncated=false;
        const child=spawn(argv[0],argv.slice(1),{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,TERM:'dumb',NO_COLOR:'1'}});
        const append=(name,data)=>{const value=data.toString('utf8'),limit=1024*1024;let current=name==='stdout'?stdout:stderr;if(current.length<limit)current+=value.slice(0,limit-current.length);if(value.length>limit-current.length)truncated=true;if(name==='stdout')stdout=current;else stderr=current;};
        child.stdout.on('data',data=>append('stdout',data));child.stderr.on('data',data=>append('stderr',data));
        const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>{if(!finished)child.kill('SIGKILL');},2000).unref();},120000);
        const done=(code,signal,error)=>{if(finished)return;finished=true;clearTimeout(timer);resolve({exit_code:Number.isInteger(code)?code:null,signal:signal||null,stdout,stderr,error:error?.message||null,timed_out:timedOut,truncated,duration_ms:Date.now()-startedAt,cwd:relative||'.'});};
        child.once('error',error=>done(null,null,error));child.once('close',(code,signal)=>done(code,signal));
      });
    });
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
