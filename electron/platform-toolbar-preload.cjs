const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('platformControls', {
  command: action => ipcRenderer.invoke('platform:control', action),
  onState: callback => ipcRenderer.on('platform:state', (_event, state) => callback(state))
});
