const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portraitStudio', {
  copyText: (value) => ipcRenderer.invoke('copy-text', value),
  openImage: (value) => ipcRenderer.invoke('open-image', value)
});
