const {app} = require('electron');
let dockIconSet = process.platform !== 'darwin';
if (process.platform === 'darwin') {
  const setIcon = app.dock.setIcon.bind(app.dock);
  app.dock.setIcon = icon => {dockIconSet = require('electron').nativeImage.createFromPath(icon).isEmpty() === false; return setIcon(icon);};
}
const fs = require('node:fs');
const path = require('node:path');
process.env.DIRECTOR_SMOKE_TEST = '1';
process.env.DIRECTOR_DATA_DIR = path.resolve(__dirname, '..', '.test-data', 'electron-smoke');
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      for (let n = 0; n < 50; n++) {
        const heading = await window.webContents.executeJavaScript("document.querySelector('#login-panel h2').textContent");
        if (heading === '创建第一个账号') {
          const brandReady = await window.webContents.executeJavaScript("Array.from(document.images).filter(img => img.getAttribute('src')).every(img => img.complete && img.naturalWidth > 0)");
          if (!brandReady) {await new Promise(resolve => setTimeout(resolve, 100)); continue;}
          const faviconOk = await window.webContents.executeJavaScript("fetch(document.querySelector('link[rel=icon]').href).then(r => r.ok && r.headers.get('Content-Type').includes('image/png'))");
          if (!faviconOk) throw new Error('Black PNG favicon did not load');
          if (!dockIconSet) throw new Error('macOS Dock icon was not set');
          const screenshot = await window.webContents.capturePage();
          fs.writeFileSync(path.join(process.env.DIRECTOR_DATA_DIR, 'first-launch.png'), screenshot.toPNG());
          window.setContentSize(640, 760);
          await new Promise(resolve => setTimeout(resolve, 300));
          const overflow = await window.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth');
          if (overflow) throw new Error('Narrow window has horizontal overflow');
          fs.writeFileSync(path.join(process.env.DIRECTOR_DATA_DIR, 'first-launch-narrow.png'), (await window.webContents.capturePage()).toPNG());
          console.log('Electron first-launch setup UI verified.');
          app.quit();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('First-launch setup screen did not load');
    } catch (error) {console.error(error); process.exitCode = 1; app.quit();}
  });
});
require('../desktop/main.cjs');
