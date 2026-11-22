// The panel's only bridge to the app: call(method, ...args) -> the same rpc the browser panel uses.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clicker', {
    mode: 'app',
    // Whether this run asked for the dedicated graphics card (main.js: Graphics was Fancy at start).
    highGpu: process.argv.includes('--zsb-high-gpu=1'),
    call: (method, ...args) => ipcRenderer.invoke('rpc', method, args),
});
