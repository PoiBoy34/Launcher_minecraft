const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods, syncDatapacks, syncShaderpacks } = require('./modSync');

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
            if (!fs.existsSync(partPath)) { writeStream.end(); return; }
            const data = fs.readFileSync(partPath);
            const canContinue = writeStream.write(data);
            idx++;
            if (canContinue) { writeNext(); }
            else { writeStream.once('drain', writeNext); }
        }
        writeStream.on('finish', () => { onStatus('Assemblé : ' + baseName); resolve(); });
        writeStream.on('error', reject);
        writeNext();
    });
}

async function setupFabric(gameDir, mcVersion, loaderVersion) {
    const customName = `fabric-${mcVersion}`;
    const versionDir = path.join(gameDir, 'versions', customName);
    const jsonFile = path.join(versionDir, `${customName}.json`);

    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    if (!fs.existsSync(jsonFile)) {
        console.log(`[MC] Téléchargement du profil Fabric pour ${mcVersion}...`);
        const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
        
        await new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) return reject(new Error('Erreur téléchargement Fabric'));
                const file = fs.createWriteStream(jsonFile);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', reject);
            }).on('error', reject);
        });
    }
    return customName;
}

// Fonction pour télécharger le fichier servers.dat
async function setupServersDat(gameDir, fileUrl) {
    if (!fileUrl) return;
    const serversDatPath = path.join(gameDir, 'servers.dat');
    if (!fs.existsSync(serversDatPath)) {
        await new Promise((resolve) => {
            https.get(fileUrl + '?t=' + Date.now(), (res) => {
                if (res.statusCode !== 200) return resolve();
                const file = fs.createWriteStream(serversDatPath);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
            }).on('error', resolve);
        });
    }
}

ipcMain.on('launch-game', async (event, packData) => {
    if (!mcToken) {
        event.sender.send('launch-error', "Lancement impossible : pas de token");
        return;
    }

    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    const modsDir = path.join(gameDir, 'mods');
    const datapacksDir = path.join(gameDir, 'datapacks');
    const shaderpacksDir = path.join(gameDir, 'shaderpacks');

    // 1. SYNC MODS
    try {
        await syncMods(
            packData.manifest_url,
            modsDir,
            (msg) => event.sender.send('sync-status', { message: msg }),
            (fileName, received, total) => event.sender.send('sync-progress', {
                fileName, pct: Math.round((received / total) * 100)
            })
        );
    } catch (err) {
        event.sender.send('launch-error', "Erreur sync mods : " + err.message);
        return;
    }

    // 2. SYNC DATAPACKS
    if (packData.datapacks_manifest_url) {
        try {
            await syncDatapacks(
                packData.datapacks_manifest_url,
                datapacksDir,
                (msg) => event.sender.send('sync-status', { message: msg }),
                (fileName, received, total) => event.sender.send('sync-progress', {
                    fileName, pct: Math.round((received / total) * 100)
                })
            );
        } catch (err) {
            console.error("Erreur sync datapacks :", err);
            event.sender.send('sync-status', { message: "Avertissement datapacks : " + err.message });
        }
    }

    // 3. SYNC SHADERS
    if (packData.shaderpacks_manifest_url) {
        try {
            await syncShaderpacks(
                packData.shaderpacks_manifest_url,
                shaderpacksDir,
                (msg) => event.sender.send('sync-status', { message: msg }),
                (fileName, received, total) => event.sender.send('sync-progress', {
                    fileName, pct: Math.round((received / total) * 100)
                })
            );
        } catch (err) {
            console.error("Erreur sync shaderpacks :", err);
            event.sender.send('sync-status', { message: "Avertissement shaders : " + err.message });
        }
    }

    // 4. CONFIG SERVEUR PRÉ-ENREGISTRÉ
    event.sender.send('sync-status', { message: "Configuration du serveur multijoueur..." });
    await setupServersDat(gameDir, packData.servers_dat_url);

    // 5. ASSEMBLAGE .part
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
            }
        }
    } catch (err) {
        event.sender.send('launch-error', "Erreur assemblage : " + err.message);
        return;
    }

    // 6. LANCEMENT AVEC FABRIC
    try {
        event.sender.send('sync-status', { message: "Préparation de Fabric..." });
        
        const customVersionName = await setupFabric(gameDir, packData.minecraft, "0.18.0");

        const opts = {
            authorization: mcToken.mclc(),
            root: gameDir,
            version: { 
                number: packData.minecraft, 
                type: "release",
                custom: customVersionName
            },
            memory: { max: "4G", min: "2G" }
        };
        
        event.sender.send('sync-status', { message: "Démarrage de Minecraft..." });
        await launcher.launch(opts);
    } catch (err) {
        event.sender.send('launch-error', String(err));
    }
});
