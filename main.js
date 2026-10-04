const { app, BrowserWindow, clipboard, ipcMain, shell, dialog, protocol, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { trustedSender } = require('./electron-security.cjs');
const { createLocalAdapter } = require('./local-electron.cjs');
const defaultLibrary = require('./assets/default-library.json');
const rendererPath = path.join(__dirname, 'renderer-dist', 'index.html');
const rendererURL = pathToFileURL(rendererPath).href;
protocol.registerSchemesAsPrivileged([{scheme:'portrait-media',privileges:{standard:true,secure:true,stream:true}}]);
const localLibrary = createLocalAdapter({app,BrowserWindow,clipboard,ipcMain,shell,dialog,protocol,nativeImage,rendererURL,trustedSender,sourceRoot:__dirname,defaultRoot:defaultLibrary.root,legacyRoot:defaultLibrary.legacyRoot});

// Tests and development can isolate all Electron profile data from the user's app.
if (process.env.PORTRAIT_STUDIO_USER_DATA_DIR && path.isAbsolute(process.env.PORTRAIT_STUDIO_USER_DATA_DIR)) {
  app.setPath('userData', process.env.PORTRAIT_STUDIO_USER_DATA_DIR);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#101114',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 14 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.loadFile(rendererPath);
}

app.whenReady().then(async () => {
  await localLibrary.initialise();
  ipcMain.handle('copy-text', (event, value) => {
    if (!trustedSender(event, rendererURL) || typeof value !== 'string' || value.length > 65536) return false;
    clipboard.writeText(value);
    return true;
  });

  ipcMain.handle('open-image', async (event, imageName) => {
    if (!trustedSender(event, rendererURL)) return false;
    try {
      const absolute = await localLibrary.imageToOpen(imageName);
      if(!absolute) return false;
      return (await shell.openPath(absolute)) === '';
    }
    catch { return false; }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
