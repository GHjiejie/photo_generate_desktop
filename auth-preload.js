const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portraitAuthentication', {
  state: () => ipcRenderer.invoke('remote-auth-state'),
  submit: (value) => ipcRenderer.invoke('remote-auth-submit', value),
  cancel: () => ipcRenderer.invoke('remote-auth-cancel'),
});
