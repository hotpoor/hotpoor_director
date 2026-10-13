const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const {createShortcut, validate} = require('./shortcut.cjs');
const {createCoordinator} = require('./coordinator.cjs');

function createScreenCapture({directory, defaultPriority, title, electron = require('electron')}) {
  const {app, BrowserWindow, ipcMain, globalShortcut, clipboard, ClipboardItem, nativeImage, screen, desktopCapturer, Notification, dialog} = electron;
  const sharedDirectory = path.join(app.getPath('appData'), 'HOTPOOR', 'screen-capture');
  const filename = path.join(sharedDirectory, 'settings.json');
  const priorityFile = path.join(directory, 'screenshot-priority.json');
  let priority = defaultPriority;
  try { const saved = JSON.parse(fs.readFileSync(priorityFile, 'utf8')); if (Number.isInteger(saved.priority) && saved.priority >= 0 && saved.priority <= 1000) priority = saved.priority; } catch {}
  let initial = {enabled: true, accelerator: 'CommandOrControl+Alt+Shift+S'};
  try { initial = validate(JSON.parse(fs.readFileSync(filename, 'utf8'))); } catch {}
  let settingsWindow = null, busy = false, disposed = false;
  const settingsUrl = pathToFileURL(path.join(__dirname, 'settings.html')).href;
  const notify = (message, failed = false) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('hotpoor:screenshot-status', message);
    if (Notification.isSupported()) new Notification({title: failed ? `${title} · 截图失败` : title, body: message, silent: true}).show();
    else if (failed) dialog.showErrorBox('截图失败', message);
  };
  async function capture() {
    if (busy || disposed) throw Error('截图正在进行，请稍候。');
    busy = true;
    // Select before hiding settings, so the user's current display stays the target.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const hiddenSettings = settingsWindow?.isVisible() ? settingsWindow : null;
    try {
      if (hiddenSettings) { hiddenSettings.hide(); await new Promise(resolve => setTimeout(resolve, 180)); }
      let image;
      if (process.platform === 'darwin') {
        const binary = app.isPackaged ? path.join(process.resourcesPath, 'screen-capture/capture-macos') : path.join(__dirname, 'bin/capture-macos');
        if (!fs.existsSync(binary)) throw Error('截图组件缺失，请运行 npm run build:capture 后重启，或重新安装完整应用。');
        const {stdout} = await run(binary, [String(display.id)], {encoding: 'buffer', timeout: 15000, maxBuffer: 128 * 1024 * 1024});
        image = nativeImage.createFromBuffer(stdout);
      } else {
        const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize: {
          width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor)
        }});
        const source = sources.find(item => item.display_id === String(display.id));
        if (!source) throw Error('未找到当前显示器，无法截图。');
        image = source.thumbnail;
      }
      if (image.isEmpty()) throw Error('截图为空，原剪贴板未更改。');
      if (disposed) throw Error('应用正在退出。');
      await clipboard.write([new ClipboardItem({'image/png': new Blob([image.toPNG()], {type: 'image/png'})})]);
      const size = image.getSize();
      notify(`截图已复制到剪贴板（${size.width} × ${size.height}），可以直接粘贴。`);
      return {width: size.width, height: size.height};
    } catch (error) {
      const detail = error.stderr?.toString().trim();
      throw Error(detail || error.message || '截图失败');
    } finally {
      busy = false;
      if (hiddenSettings && !hiddenSettings.isDestroyed() && !disposed) hiddenSettings.show();
    }
  }
  const shortcut = createShortcut({globalShortcut, initial, active: false, onCapture: () => { if (!busy) void capture().catch(error => notify(error.message, true)); },
    persist(value) {
      fs.mkdirSync(sharedDirectory, {recursive: true, mode: 0o700});
      const temporary = `${filename}.${process.pid}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {mode: 0o600}); fs.renameSync(temporary, filename); }
      finally { fs.rmSync(temporary, {force: true}); }
    }
  });
  let owner = '', syncError = '';
  const coordinator = createCoordinator({directory: path.join(sharedDirectory, 'instances'), title, priority,
    onRequest: value => shortcut.save(value), onElection(election) {
    owner = election.owner;
    shortcut.setActive(election.active);
    try {
      if (fs.existsSync(filename)) {
        const shared = validate(JSON.parse(fs.readFileSync(filename, 'utf8')));
        if (shared.enabled !== shortcut.state().enabled || shared.accelerator !== shortcut.state().accelerator) shortcut.save(shared, false);
      }
      syncError = '';
    } catch (error) { syncError = error.message; }
  }});
  const state = () => ({...shortcut.state(), error: syncError || shortcut.state().error, title, platform: process.platform, owner, priority});
  const handlers = {
    'hotpoor:screenshot-state': state,
    'hotpoor:screenshot-save': async value => {
      if (!Number.isInteger(value?.priority) || value.priority < 0 || value.priority > 1000) throw Error('优先级应为 0–1000 的整数。');
      const next = validate(value);
      // The actual listener validates and applies shared settings, including
      // requests from standby products. An acknowledgement precedes success UI.
      if (shortcut.state().active) shortcut.save(next);
      else { await coordinator.request(next); shortcut.save(next, false); }
      fs.mkdirSync(directory, {recursive: true});
      const temporary = `${priorityFile}.${process.pid}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify({priority: value.priority}), {mode: 0o600}); fs.renameSync(temporary, priorityFile); }
      finally { fs.rmSync(temporary, {force: true}); }
      priority = value.priority;
      coordinator.setPriority(priority);
      return state();
    },
    'hotpoor:screenshot-capture': () => capture()
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, (event, value) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents || event.senderFrame !== settingsWindow.webContents.mainFrame || event.senderFrame.url !== settingsUrl) throw Error('无效的页面来源');
    if (disposed && channel !== 'hotpoor:screenshot-state') throw Error('应用正在退出。');
    return handler(value);
  });
  async function openSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({title: `${title} · 截图设置`, width: 560, height: 640, minWidth: 440, minHeight: 550,
      backgroundColor: '#fafaf8', autoHideMenuBar: true, webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true}});
    settingsWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
    settingsWindow.on('closed', () => { settingsWindow = null; });
    await settingsWindow.loadURL(settingsUrl);
  }
  function dispose() { if (disposed) return; disposed = true; coordinator.dispose(); shortcut.dispose(); }
  app.once('will-quit', () => { dispose(); for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel); });
  app.once('before-quit', dispose);
  if (shortcut.state().error) notify(shortcut.state().error, true);
  return {openSettings, capture, state, dispose};
}
module.exports = {createScreenCapture};
