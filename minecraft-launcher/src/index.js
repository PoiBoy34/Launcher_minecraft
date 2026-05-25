const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods } = require('./modSync');

const launcher = new Client();
let mcToken = null;
let currentWindow = null;

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
    try {
        const authManager = new Auth("select_account");
        const xboxManager = await authManager.launch("electron");
        mcToken = await xboxManager.getMinecraft();
        event.sender.send('auth-success', { name: mcToken.profile.name });
    } catch (err) {
        event.sender.send('auth-error', { message: err.message });
    }
});

function assembleParts(modsDir, baseName, onStatus) {
    return new Promise((resolve, reject) => {
        const finalPath = path.join(modsDir, baseName);
        const writeStream = fs.createWriteStream(finalPath);

        let idx = 0;
        function writeNext() {
            const partPath = path.join(modsDir, `${baseName}.part${String(idx).padStart(2, '0')}`);
            if (!fs.existsSync(partPath)) {
                writeStream.end();
                return;
            }
            const data = fs.readFileSync(partPath);
            const canContinue = writeStream.write(data);
            idx++;
            if (canContinue) {
                writeNext();
            } else {
                writeStream.once('drain', writeNext);
            }
        }

        writeStream.on('finish', () => {
            onStatus('Assemblé : ' + baseName);
            resolve();
        });
        writeStream.on('error', reject);
        writeNext();
    });
}

ipcMain.on('launch-game', async (event, packData) => {
    if (!mcToken) {
        event.sender.send('launch-error', "Lancement impossible : pas de token");
        return;
    }

    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    const modsDir = path.join(gameDir, 'mods');

    // 1. SYNCHRONISATION
    try {
        await syncMods(
            packData.manifest_url,
            modsDir,
            (msg) => event.sender.send('sync-status', { message: msg }),
            (fileName, received, total) => event.sender.send('sync-progress', {
                fileName,
                pct: Math.round((received / total) * 100)
            })
        );
    } catch (err) {
        event.sender.send('launch-error', "Erreur sync : " + err.message);
        return;
    }

    // 2. ASSEMBLAGE des .part
    try {
        const allFiles = fs.readdirSync(modsDir);
        const part00Files = allFiles.filter(f => f.endsWith('.part00'));

        for (const part00 of part00Files) {
            const baseName = part00.replace('.part00', '');
            const finalPath = path.join(modsDir, baseName);

            const partPaths = allFiles
                .filter(f => f.startsWith(baseName + '.part'))
                .map(f => path.join(modsDir, f));

            const totalPartsSize = partPaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
            const needsAssembly = !fs.existsSync(finalPath) ||
                fs.statSync(finalPath).size !== totalPartsSize;

            if (needsAssembly) {
                event.sender.send('sync-status', { message: 'Assemblage : ' + baseName + '...' });
                await assembleParts(modsDir, baseName, (msg) =>
                    event.sender.send('sync-status', { message: msg })
                );
            } else {
                event.sender.send('sync-status', { message: 'Déjà assemblé : ' + baseName });
            }
        }
    } catch (err) {
        console.error("Erreur assemblage :", err);
        event.sender.send('launch-error', "Erreur assemblage : " + err.message);
        return;
    }

    // 3. LANCEMENT
    const opts = {
        authorization: mcToken.mclc(),
        root: gameDir,
        version: { number: packData.minecraft, type: "release" },
        memory: { max: "4G", min: "2G" }
    };

    try {
        event.sender.send('sync-status', { message: "Démarrage de Minecraft..." });
        await launcher.launch(opts);
    } catch (err) {
        event.sender.send('launch-error', String(err));
    }
});
