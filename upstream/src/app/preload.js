// The panel's only bridge to the app: call(method, ...args) -> the same rpc the browser panel uses.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clicker', {
    mode: 'app',
    call: (method, ...args) => ipcRenderer.invoke('rpc', method, args),
});
