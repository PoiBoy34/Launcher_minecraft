const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
    getCatalog:     () => ipcRenderer.invoke('get-catalog'),
    loginMicrosoft: () => ipcRenderer.send('login-microsoft'),
    launchGame:     (packData) => ipcRenderer.send('launch-game', packData),
    onAuthSuccess:  (cb) => ipcRenderer.on('auth-success',  (_, d) => cb(d)),
    onAuthError:    (cb) => ipcRenderer.on('auth-error',    (_, d) => cb(d)),
    onSyncStatus:   (cb) => ipcRenderer.on('sync-status',   (_, d) => cb(d)),
    onSyncProgress: (cb) => ipcRenderer.on('sync-progress', (_, d) => cb(d)),
});
