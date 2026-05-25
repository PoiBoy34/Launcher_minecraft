const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods } = require('./modSync');

const launcher = new Client();
let mcToken = null;

launcher.on('debug', (e) => console.log('[MC]', e));
launcher.on('data',  (e) => console.log('[MC DATA]', e));

function createWindow() {
    const win = new BrowserWindow({
        width: 960, height: 620,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    win.webContents.openDevTools();
    return win;
}

let win;
app.whenReady().then(() => { win = createWindow(); });

ipcMain.handle('get-catalog', async () => {
    try {
        const catalog = await fetchCatalog();
        return { success: true, catalog };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('login-microsoft', async (event) => {
    console.log("Démarrage du login...");
    try {
        const authManager = new Auth("select_account");
        const xboxManager = await authManager.launch("electron");
        mcToken = await xboxManager.getMinecraft();
        console.log("Login réussi :", mcToken.profile.name);
        event.sender.send('auth-success', { name: mcToken.profile.name });
    } catch (err) {
        console.error("Erreur msmc :", err);
        event.sender.send('auth-error', { message: err.message });
    }
});

ipcMain.on('launch-game', async (event, packData) => {
    if (!mcToken) {
        console.error("Lancement impossible : pas de token");
        return;
    }

    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    const modsDir = path.join(gameDir, 'mods');

    try {
        await syncMods(
            packData.manifest_url,
            modsDir,
            (msg) => {
                console.log('[SYNC]', msg);
                event.sender.send('sync-status', { message: msg });
            },
            (fileName, received, total) => {
                const pct = Math.round((received / total) * 100);
                event.sender.send('sync-progress', { fileName, pct });
            }
        );
    } catch (err) {
        console.error("Erreur sync mods :", err);
        event.sender.send('sync-status', { message: "Erreur sync : " + err.message });
        return;
    }

    const opts = {
        authorization: mcToken.mclc(),
        root: gameDir,
        version: { number: packData.minecraft, type: "release" },
        memory: { max: "4G", min: "2G" }
    };
    try {
        await launcher.launch(opts);
    } catch (err) {
        console.error("Erreur lancement :", err);
    }
});
