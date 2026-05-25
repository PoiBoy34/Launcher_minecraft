const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
    getCatalog:     () => ipcRenderer.invoke('get-catalog'),
    loginMicrosoft: () => ipcRenderer.send('login-microsoft'),
    // Modifié : Envoie le pack ET la ram choisie
    launchGame:     (packData, ram) => ipcRenderer.send('launch-game', { packData, ram }),
    // Nouveau : Signal pour ouvrir le dossier
    openFolder:     (packId) => ipcRenderer.send('open-folder', packId),
    
    onAuthSuccess:  (cb) => ipcRenderer.on('auth-success',  (_, d) => cb(d)),
    onAuthError:    (cb) => ipcRenderer.on('auth-error',    (_, d) => cb(d)),
    onSyncStatus:   (cb) => ipcRenderer.on('sync-status',   (_, d) => cb(d)),
    onSyncProgress: (cb) => ipcRenderer.on('sync-progress', (_, d) => cb(d)),
    onLaunchError:  (cb) => ipcRenderer.on('launch-error',  (_, d) => cb(d))
});
