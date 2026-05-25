const { app, BrowserWindow, ipcMain, shell } = require('electron'); // Ajout de 'shell'
const path = require('path');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods } = require('./modSync');
const { ensureJava } = require('./javaManager'); // Ajout du gestionnaire Java

const launcher = new Client();
let mcToken = null;
let currentWindow = null;

// Envoi des logs MCLC directement à la fenêtre si elle existe
launcher.on('debug', (e) => console.log('[MC]', e));
launcher.on('data',  (e) => console.log('[MC DATA]', e));
launcher.on('error', (e) => {
    console.error('[MC ERREUR]', e);
    if (currentWindow) currentWindow.webContents.send('launch-error', String(e));
});

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
    currentWindow = win;
    return win;
}

app.whenReady().then(createWindow);

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

// NOUVEAU : Ouvre le dossier du modpack dans l'explorateur de fichiers
ipcMain.on('open-folder', (event, packId) => {
    if (!packId) return;
    const gameDir = path.join(app.getPath('userData'), 'instances', packId);
    shell.openPath(gameDir).catch(err => console.error("Erreur ouverture dossier :", err));
});

// MODIFIÉ : Récupère packData ET ram
ipcMain.on('launch-game', async (event, { packData, ram }) => {
    if (!mcToken) {
        event.sender.send('launch-error', "Lancement impossible : pas de token");
        return;
    }

    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    const modsDir = path.join(gameDir, 'mods');

    // 1. Sync mods
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
        event.sender.send('launch-error', "Erreur sync : " + err.message);
        return;
    }

    // 2. Vérification/Téléchargement de Java 21 automatique
    let javaPath;
    try {
        event.sender.send('sync-status', { message: "Vérification de Java 21..." });
        javaPath = await ensureJava(app.getPath('userData'), (msg) => {
            event.sender.send('sync-status', { message: msg });
        });
    } catch (err) {
        console.error("Erreur Java :", err);
        event.sender.send('launch-error', "Erreur Java : " + err.message);
        return;
    }

    // 3. Calcul de la RAM
    const maxRam = ram ? `${ram}G` : "4G";
    const minRam = ram ? `${Math.max(2, Math.floor(ram / 2))}G` : "2G";

    const opts = {
        authorization: mcToken.mclc(),
        root: gameDir,
        version: { number: packData.minecraft, type: "release" },
        memory: { max: maxRam, min: minRam },
        javaPath: javaPath // On injecte le chemin du Java téléchargé
    };
    
    try {
        event.sender.send('sync-status', { message: "Démarrage de Minecraft..." });
        await launcher.launch(opts);
    } catch (err) {
        console.error("Erreur lancement :", err);
        event.sender.send('launch-error', String(err));
    }
});
