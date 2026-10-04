const { app, BrowserWindow, clipboard, ipcMain, shell, dialog, protocol, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { trustedSender } = require('./electron-security.cjs');
const rendererPath = path.join(__dirname, 'renderer-dist', 'index.html');
const rendererURL = pathToFileURL(rendererPath).href;
protocol.registerSchemesAsPrivileged([{scheme:'portrait-media',privileges:{standard:true,secure:true,stream:true}}]);

// Tests and development can isolate all Electron profile data from the user's app.
if (process.env.PORTRAIT_STUDIO_USER_DATA_DIR && path.isAbsolute(process.env.PORTRAIT_STUDIO_USER_DATA_DIR)) {
  const requestedProfile = process.env.PORTRAIT_STUDIO_USER_DATA_DIR;
  // macOS /tmp is an alias for /private/tmp; keep the selected profile canonical.
  fs.mkdirSync(requestedProfile, { recursive: true, mode: 0o700 });
  const profile = fs.realpathSync(requestedProfile);
  app.setPath('userData', profile);
}
// A remote address alone never changes the default local backend.
const backend = process.env.PORTRAIT_STUDIO_BACKEND === 'remote' ? 'remote' : 'local';
const adapterOptions = {app,BrowserWindow,clipboard,ipcMain,shell,dialog,protocol,nativeImage,rendererURL,trustedSender};
let libraryAdapter;
if (backend === 'remote') {
  const { createRemoteAdapter } = require('./remote-electron.cjs');
  libraryAdapter = createRemoteAdapter(adapterOptions);
} else {
  const { createLocalAdapter } = require('./local-electron.cjs');
  const defaultLibrary = require('./assets/default-library.json');
  const sourceRoot = path.join(__dirname, 'photo_repo');
  libraryAdapter = createLocalAdapter({...adapterOptions,sourceRoot,defaultRoot:app.isPackaged?defaultLibrary.root:sourceRoot,legacyRoot:defaultLibrary.legacyRoot});
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
      additionalArguments: [`--portrait-studio-backend=${backend}`],
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
  await libraryAdapter.initialise();
  ipcMain.handle('copy-text', (event, value) => {
    if (!trustedSender(event, rendererURL) || typeof value !== 'string' || value.length > 65536) return false;
    clipboard.writeText(value);
    return true;
  });

  ipcMain.handle('open-image', async (event, imageName) => {
    if (!trustedSender(event, rendererURL)) return false;
    try {
      const absolute = await libraryAdapter.imageToOpen(imageName);
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

let disposed = false;
app.on('before-quit', event => {
  if (disposed) return;
  event.preventDefault();
  libraryAdapter.dispose().finally(() => { disposed = true; app.quit(); });
});
