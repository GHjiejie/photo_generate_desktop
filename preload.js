const { contextBridge, ipcRenderer } = require('electron');
const backendFlags = typeof process !== 'undefined' && Array.isArray(process.argv)
  ? process.argv.filter(value => typeof value === 'string' && value.startsWith('--portrait-studio-backend=')) : [];
const backend = backendFlags.length === 1 && backendFlags[0] === '--portrait-studio-backend=remote'
  ? 'remote' : 'local';

contextBridge.exposeInMainWorld('portraitStudio', {
  backend,
  copyText: (value) => ipcRenderer.invoke('copy-text', value),
  copyPrompt: (value) => ipcRenderer.invoke('copy-prompt', value),
  openImage: (value) => ipcRenderer.invoke('open-image', value),
  setUILanguage: (locale) => ipcRenderer.invoke('library-ui-language', locale),
  connectionSettings: () => ipcRenderer.invoke('library-connection-settings'),
  saveConnection: (value) => ipcRenderer.invoke('library-connection-save', value),
  signIn: () => ipcRenderer.invoke('library-connection-login'),
  logout: () => ipcRenderer.invoke('library-connection-logout'),
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryGet: (id) => ipcRenderer.invoke('library-get', id),
  chooseLibrary: () => ipcRenderer.invoke('library-choose'),
  chooseImage: () => ipcRenderer.invoke('library-image-choose'),
  releaseImage: (token) => ipcRenderer.invoke('library-image-release', token),
  chooseBatchDirectory: () => ipcRenderer.invoke('library-batch-directory-choose'),
  previewBatch: (value) => ipcRenderer.invoke('library-batch-preview', value),
  commitBatch: (value) => ipcRenderer.invoke('library-batch-commit', value),
  cancelBatch: (value) => ipcRenderer.invoke('library-batch-cancel', value),
  createPortrait: (value) => ipcRenderer.invoke('library-create', value),
  updatePortrait: (value) => ipcRenderer.invoke('library-update', value),
  deletePortrait: (value) => ipcRenderer.invoke('library-delete', value),
  deletePortraits: (value) => ipcRenderer.invoke('library-delete-batch', value),
});
