const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  onAgentInbox: cb => ipcRenderer.on('open-agent-inbox', (_, target) => cb(target)),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  minimize: () => ipcRenderer.invoke('minimize-window'),
  close: () => ipcRenderer.invoke('close-window'),
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize'),
  dockRight: () => ipcRenderer.invoke('dock-right'),
  dockLeft: () => ipcRenderer.invoke('dock-left'),
  setTabletMode: () => ipcRenderer.invoke('set-tablet-mode'),
  toggleAutoHide: () => ipcRenderer.invoke('toggle-autohide'),
  getAutoHide: () => ipcRenderer.invoke('get-autohide'),
  toggleReserveSpace: () => ipcRenderer.invoke('toggle-reserve-space'),
  getReserveSpace: () => ipcRenderer.invoke('get-reserve-space'),
  getAccentColor: () => ipcRenderer.invoke('get-accent-color'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openSpotify: (uri, fallbackUrl) => ipcRenderer.invoke('open-spotify', uri, fallbackUrl),
  onAutoHideState: (cb) => ipcRenderer.on('autohide-state', (_, hidden) => cb(hidden)),
  onDockSideState: (cb) => ipcRenderer.on('dock-side-state', (_, side) => cb(side)),
  onReserveState: (cb) => ipcRenderer.on('reserve-state', (_, on) => cb(on)),
  onAccentColorState: (cb) => ipcRenderer.on('accent-color-state', (_, color) => cb(color)),
});
