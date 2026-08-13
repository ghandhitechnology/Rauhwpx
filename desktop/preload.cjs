const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rhwpDesktop', {
  ensureAgentHub: () => ipcRenderer.invoke('agent-hub:ensure'),
});
