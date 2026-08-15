const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rhwpDesktop', {
  ensureAgentHub: () => ipcRenderer.invoke('agent-hub:ensure'),
  platform: process.platform,
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  onFullScreenChange: (callback) => {
    ipcRenderer.on('window:fullscreen-changed', (_event, fullscreen) => {
      callback(Boolean(fullscreen));
    });
  },
});
