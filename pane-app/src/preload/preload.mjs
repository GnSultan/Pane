import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("electronAPI", {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
  // File.path on dropped files is undefined in sandboxed renderers (Electron
  // 32+). webUtils.getPathForFile is the supported replacement — a drop
  // handler receives the File synchronously, so it must be called immediately,
  // not stashed and resolved later.
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
