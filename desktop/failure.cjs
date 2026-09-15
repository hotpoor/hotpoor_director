const {BrowserWindow} = require('electron');
const path = require('node:path');

async function showFailure(title, message, window) {
  const script = `window.directorDialogs.alert(${JSON.stringify(String(message))}, {title:${JSON.stringify(title)},acceptLabel:'退出应用',dismissible:false})`;
  try {
    if (window && !window.isDestroyed() && await window.webContents.executeJavaScript('!!window.directorDialogs')) {
      window.show();
      await window.webContents.executeJavaScript(script, true);
      return;
    }
  } catch {
    if (window?.isDestroyed()) return;
    // Renderer unavailable: use the same dialog without the backend.
  }
  try {
    const errorWindow = new BrowserWindow({width:640,height:460,minWidth:360,minHeight:300,
      title:'Hotpoor Director · 导演工作站',backgroundColor:'#101010',autoHideMenuBar:true,
      icon:path.join(__dirname,'../assets/icon.png'),
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    errorWindow.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    errorWindow.webContents.on('will-navigate', event => event.preventDefault());
    await errorWindow.loadFile(path.join(__dirname,'failure.html'));
    await errorWindow.webContents.executeJavaScript(script, true);
  } catch (error) { console.error('Unable to display application error:', error.message); }
}
module.exports = {showFailure};
