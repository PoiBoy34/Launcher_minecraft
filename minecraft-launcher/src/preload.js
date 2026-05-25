const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
    getCatalog:     () => ipcRenderer.invoke('get-catalog'),
    loginMicrosoft: () => ipcRenderer.send('login-microsoft'),
    autoLogin:      () => ipcRenderer.send('auto-login'),
    launchGame:     (packData) => ipcRenderer.send('launch-game', packData),
    openFolder:     (type) => ipcRenderer.send('open-folder', type),
    onAuthSuccess:  (cb) => ipcRenderer.on('auth-success',  (_, d) => cb(d)),
    onAuthError:    (cb) => ipcRenderer.on('auth-error',    (_, d) => cb(d)),
    onAuthMissing:  (cb) => ipcRenderer.on('auth-missing',  () => cb()),
    onSyncStatus:   (cb) => ipcRenderer.on('sync-status',   (_, d) => cb(d)),
    onSyncProgress: (cb) => ipcRenderer.on('sync-progress', (_, d) => cb(d)),
    onLaunchError:  (cb) => ipcRenderer.on('launch-error',  (_, d) => cb(d))
});
