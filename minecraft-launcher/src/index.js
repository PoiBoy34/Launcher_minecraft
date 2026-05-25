const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods, syncDatapacks, syncShaderpacks, syncResourcepacks } = require('./modSync');

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

ipcMain.on('auto-login', async (event) => {
    try {
        const authPath = path.join(app.getPath('userData'), 'msmc-auth.json');
        if (fs.existsSync(authPath)) {
            const savedData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            if (savedData.refresh_token) {
                const authManager = new Auth("select_account");
                const xboxManager = await authManager.refresh(savedData.refresh_token);
                mcToken = await xboxManager.getMinecraft();
                if (xboxManager.msToken) {
                    fs.writeFileSync(authPath, JSON.stringify(xboxManager.msToken));
                }
                event.sender.send('auth-success', { name: mcToken.profile.name });
                return;
            }
        }
        event.sender.send('auth-missing');
    } catch (err) {
        console.log("[AutoLogin] Session expirée :", err.message);
        event.sender.send('auth-missing');
    }
});

ipcMain.on('login-microsoft', async (event) => {
    try {
        const authManager = new Auth("select_account");
        const xboxManager = await authManager.launch("electron");
        mcToken = await xboxManager.getMinecraft();
        if (xboxManager.msToken) {
            const authPath = path.join(app.getPath('userData'), 'msmc-auth.json');
            fs.writeFileSync(authPath, JSON.stringify(xboxManager.msToken));
        }
        event.sender.send('auth-success', { name: mcToken.profile.name });
    } catch (err) {
        event.sender.send('auth-error', { message: err.message });
    }
});

ipcMain.on('open-folder', (event, type) => {
    const baseDir = path.join(app.getPath('userData'), 'instances');
    const dirs = {
        mods:          path.join(baseDir, 'pack_cobblemon', 'mods'),
        datapacks:     path.join(baseDir, 'pack_cobblemon', 'global_packs', 'required_data'),
        shaderpacks:   path.join(baseDir, 'pack_cobblemon', 'shaderpacks'),
        resourcepacks: path.join(baseDir, 'pack_cobblemon', 'resourcepacks'),
        screenshots:   path.join(baseDir, 'pack_cobblemon', 'screenshots'),
        game:          path.join(baseDir, 'pack_cobblemon')
    };
    const target = dirs[type] || dirs.game;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
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

function fetchWithRedirect(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'minecraft-launcher' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 ||
                res.statusCode === 307 || res.statusCode === 308) {
                fetchWithRedirect(res.headers.location).then(resolve).catch(reject);
                return;
            }
            resolve(res);
        }).on('error', reject);
    });
}

async function setupServersDat(gameDir, fileUrl) {
    if (!fileUrl) return;
    const serversDatPath = path.join(gameDir, 'servers.dat');
    if (fs.existsSync(serversDatPath)) return;
    try {
        const res = await fetchWithRedirect(fileUrl + '?t=' + Date.now());
        if (res.statusCode !== 200) return;
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(serversDatPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        });
        console.log('[MC] servers.dat installé');
    } catch (err) {
        console.error('[MC] Erreur servers.dat :', err.message);
    }
}

ipcMain.on('launch-game', async (event, packData) => {
    if (!mcToken) {
        event.sender.send('launch-error', "Lancement impossible : pas de token");
        return;
    }

    const ram = packData.ram || 4;
    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    const modsDir = path.join(gameDir, 'mods');
    const datapacksDir = path.join(gameDir, 'global_packs', 'required_data');
    const shaderpacksDir = path.join(gameDir, 'shaderpacks');
    const resourcepacksDir = path.join(gameDir, 'resourcepacks');

    // 1. SYNC MODS
    try {
        await syncMods(
            packData.manifest_url, modsDir,
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
                packData.datapacks_manifest_url, datapacksDir,
                (msg) => event.sender.send('sync-status', { message: msg }),
                (fileName, received, total) => event.sender.send('sync-progress', {
                    fileName, pct: Math.round((received / total) * 100)
                })
            );
        } catch (err) {
            event.sender.send('sync-status', { message: "Avertissement datapacks : " + err.message });
        }
    }

    // 3. SYNC SHADERPACKS
    if (packData.shaderpacks_manifest_url) {
        try {
            await syncShaderpacks(
                packData.shaderpacks_manifest_url, shaderpacksDir,
                (msg) => event.sender.send('sync-status', { message: msg }),
                (fileName, received, total) => event.sender.send('sync-progress', {
                    fileName, pct: Math.round((received / total) * 100)
                })
            );
        } catch (err) {
            event.sender.send('sync-status', { message: "Avertissement shaders : " + err.message });
        }
    }

    // 4. SYNC RESOURCEPACKS
    if (packData.resourcepacks_manifest_url) {
        try {
            await syncResourcepacks(
                packData.resourcepacks_manifest_url, resourcepacksDir,
                (msg) => event.sender.send('sync-status', { message: msg }),
                (fileName, received, total) => event.sender.send('sync-progress', {
                    fileName, pct: Math.round((received / total) * 100)
                })
            );
        } catch (err) {
            event.sender.send('sync-status', { message: "Avertissement resource packs : " + err.message });
        }
    }

    // 5. SERVERS.DAT
    event.sender.send('sync-status', { message: "Configuration serveur multijoueur..." });
    await setupServersDat(gameDir, packData.servers_dat_url);

    // 6. ASSEMBLAGE .part
    try {
        const allFiles = fs.readdirSync(modsDir);
        for (const part00 of allFiles.filter(f => f.endsWith('.part00'))) {
            const baseName = part00.replace('.part00', '');
            const finalPath = path.join(modsDir, baseName);
            const partPaths = allFiles
                .filter(f => f.startsWith(baseName + '.part'))
                .map(f => path.join(modsDir, f));
            const totalPartsSize = partPaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
            if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size !== totalPartsSize) {
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

    // 7. LANCEMENT
    const opts = {
        authorization: mcToken.mclc(),
        root: gameDir,
        version: { number: packData.minecraft, type: "release" },
        memory: { max: ram + "G", min: "2G" }
    };
    try {
        event.sender.send('sync-status', { message: "Démarrage de Minecraft..." });
        await launcher.launch(opts);
    } catch (err) {
        event.sender.send('launch-error', String(err));
    }
});
