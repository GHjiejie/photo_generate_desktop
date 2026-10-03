const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portraitStudio', {
  copyText: (value) => ipcRenderer.invoke('copy-text', value),
  openImage: (value) => ipcRenderer.invoke('open-image', value),
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryGet: (id) => ipcRenderer.invoke('library-get', id),
  chooseLibrary: () => ipcRenderer.invoke('library-choose'),
  chooseImage: () => ipcRenderer.invoke('library-image-choose'),
  releaseImage: (token) => ipcRenderer.invoke('library-image-release', token),
  createPortrait: (value) => ipcRenderer.invoke('library-create', value),
  updatePortrait: (value) => ipcRenderer.invoke('library-update', value),
  deletePortrait: (value) => ipcRenderer.invoke('library-delete', value),
  getUpdateState: () => ipcRenderer.invoke('update-state'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  chooseUpdateSource: () => ipcRenderer.invoke('update-source-choose'),
  downloadUpdate: (value) => ipcRenderer.invoke('update-prepare', value),
  installUpdate: (value) => ipcRenderer.invoke('update-install', value),
  acknowledgeAppReady: () => ipcRenderer.invoke('update-app-ready'),
  onUpdateState: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Update listener must be a function');
    const callback = (_event, state) => listener(state);
    ipcRenderer.on('update-state-changed', callback);
    return () => ipcRenderer.removeListener('update-state-changed', callback);
  }
});
