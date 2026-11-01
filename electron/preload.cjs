const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mediahubDesktop', {
  openAccount: (accountId, url) => ipcRenderer.invoke('platform:open', {accountId, url}),
});
