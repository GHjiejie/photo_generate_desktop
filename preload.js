const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portraitStudio', {
  copyText: (value) => ipcRenderer.invoke('copy-text', value),
  openImage: (value) => ipcRenderer.invoke('open-image', value),
  setUILanguage: (locale) => ipcRenderer.invoke('library-ui-language', locale),
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryGet: (id) => ipcRenderer.invoke('library-get', id),
  chooseLibrary: () => ipcRenderer.invoke('library-choose'),
  chooseImage: () => ipcRenderer.invoke('library-image-choose'),
  releaseImage: (token) => ipcRenderer.invoke('library-image-release', token),
  chooseBatchImages: () => ipcRenderer.invoke('library-batch-images-choose'),
  chooseBatchManifest: () => ipcRenderer.invoke('library-batch-manifest-choose'),
  previewBatch: (value) => ipcRenderer.invoke('library-batch-preview', value),
  commitBatch: (value) => ipcRenderer.invoke('library-batch-commit', value),
  cancelBatch: (value) => ipcRenderer.invoke('library-batch-cancel', value),
  createPortrait: (value) => ipcRenderer.invoke('library-create', value),
  updatePortrait: (value) => ipcRenderer.invoke('library-update', value),
  deletePortrait: (value) => ipcRenderer.invoke('library-delete', value),
});
