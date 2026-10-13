const {app}=require('electron');
const path=require('node:path');
app.setPath('appData',process.env.CAPTURE_SHARED_TEST);
app.setPath('userData',path.join(process.env.CAPTURE_SHARED_TEST,process.env.CAPTURE_PRODUCT));
app.whenReady().then(async()=>{
 const electron=require('electron');
 global.capture=require(path.join(process.env.CAPTURE_ROOT,'desktop/screenshot/index.cjs')).createScreenCapture({directory:app.getPath('userData'),title:process.env.CAPTURE_PRODUCT,defaultPriority:Number(process.env.CAPTURE_PRIORITY),electron:{...electron,Notification:{isSupported:()=>false}}});
 await global.capture.openSettings();
});
