const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  part: (o) => ipcRenderer.send('probe:part', o),
  done: (o) => ipcRenderer.send('probe:done', o),
});
