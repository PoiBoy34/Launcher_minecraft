const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods, syncDatapacks, syncShaderpacks, syncResourcepacks } = require('./modSync');

const launcher = new Client();
let mcToken = null;
let currentWindow = null;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
    if (currentWindow) currentWindow.webContents.send('update-available', {
        version: info.version
    });
});

autoUpdater.on('update-not-available', () => {
    if (currentWindow) currentWindow.webContents.send('update-not-available');
});

autoUpdater.on('download-progress', (progress) => {
    if (currentWindow) currentWindow.webContents.send('update-progress', {
        pct: Math.round(progress.percent)
    });
});

autoUpdater.on('update-downloaded', () => {
    if (currentWindow) currentWindow.webContents.send('update-downloaded');
});

autoUpdater.on('error', (err) => {
    console.error('[Updater]', err.message);
    if (currentWindow) currentWindow.webContents.send('update-error', err.message);
});

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

app.whenReady().then(() => {
    createWindow();
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => console.error('[Updater check]', err.message));
    }, 3000);
});

ipcMain.on('check-update', () => {
    autoUpdater.checkForUpdates().catch(err => console.error('[Updater]', err.message));
});

ipcMain.on('download-update', () => {
    autoUpdater.downloadUpdate().catch(err => console.error('[Updater]', err.message));
});

ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
});

ipcMain.handle('get-catalog', async () => {
    try {
        const catalog = await fetchCatalog();
        return { success: true, catalog };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-launcher-version', () => app.getVersion());

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

ipcMain.on('open-folder', (event, type, packId) => {
    if (!packId) return; // Sécurité si aucun pack n'est sélectionné

    const baseDir = path.join(app.getPath('userData'), 'instances', packId);
    const dirs = {
        mods:          path.join(baseDir, 'mods'),
           datapacks:     path.join(baseDir, 'datapacks'),
           shaderpacks:   path.join(baseDir, 'shaderpacks'),
           resourcepacks: path.join(baseDir, 'resourcepacks'),
           screenshots:   path.join(baseDir, 'screenshots'),
           game:          baseDir
    };
    const target = dirs[type] || dirs.game;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
});

ipcMain.on('reset-defaults', (event, packId) => {
    if (!packId) return;
    const gameDir = path.join(app.getPath('userData'), 'instances', packId);
    const markerPath = path.join(gameDir, '.defaults_installed');
    if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
        console.log(`[MC] Marker defaults supprimé, sera réinstallé au prochain lancement pour ${packId}`);
    }
    event.sender.send('defaults-reset');
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

async function setupFabric(gameDir, mcVersion, loaderVersion) {
    const customName = `fabric-loader-${loaderVersion}-${mcVersion}`;
    const versionDir = path.join(gameDir, 'versions', customName);
    const jsonFile = path.join(versionDir, `${customName}.json`);

    if (fs.existsSync(jsonFile)) {
        return customName;
    }

    fs.mkdirSync(versionDir, { recursive: true });

    const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;

    await new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'minecraft-launcher' } }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Fabric profile HTTP ${res.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(jsonFile);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });

    console.log('[MC] Profil Fabric installé : ' + customName);
    return customName;
}

async function setupForge(gameDir, mcVersion, forgeVersion, onStatus) {
    fs.mkdirSync(gameDir, { recursive: true });

    const installerName = `forge-${mcVersion}-${forgeVersion}-installer.jar`;
    const installerPath = path.join(gameDir, installerName);

    // Déjà téléchargé (et non corrompu) → on réutilise.
    if (fs.existsSync(installerPath) && fs.statSync(installerPath).size > 0) {
        return installerPath;
    }

    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/` +
                `${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`;

    if (onStatus) onStatus("Téléchargement de Forge " + forgeVersion + "...");

    const res = await fetchWithRedirect(url);
    if (res.statusCode !== 200) {
        throw new Error(`Installer Forge introuvable (HTTP ${res.statusCode}) pour ${mcVersion}-${forgeVersion}`);
    }

    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(installerPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', (err) => { fs.unlink(installerPath, () => {}); reject(err); });
    });

    console.log('[MC] Installer Forge téléchargé : ' + installerName);
    // minecraft-launcher-core se charge d'exécuter l'installer et de générer
    // le profil de version Forge à partir de ce jar (option `forge`).
    return installerPath;
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
    } catch (err) {
        console.error('[MC] Erreur servers.dat :', err.message);
    }
}

async function setupDefaults(gameDir, defaultsUrl) {
    if (!defaultsUrl) return;

    const markerPath = path.join(gameDir, '.defaults_installed');
    if (fs.existsSync(markerPath)) return;

    console.log('[MC] Installation des configs par défaut (keybinds, minimap)...');

    fs.mkdirSync(gameDir, { recursive: true });
    const zipPath = path.join(gameDir, '_defaults.zip');

    try {
        const res = await fetchWithRedirect(defaultsUrl + '?t=' + Date.now());
        if (res.statusCode !== 200) {
            console.error('[MC] defaults.zip HTTP ' + res.statusCode);
            return;
        }

        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(zipPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        });

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(gameDir, true);

        fs.unlinkSync(zipPath);
        fs.writeFileSync(markerPath, new Date().toISOString());
        console.log('[MC] Configs par défaut installées');
    } catch (err) {
        console.error('[MC] Erreur defaults :', err.message);
    }
}

function activateResourcepacks(gameDir, resourcepacksDir, loader) {
    if (!fs.existsSync(resourcepacksDir)) return;
    const optionsPath = path.join(gameDir, 'options.txt');
    const installedRPs = fs.readdirSync(resourcepacksDir).filter(f => f.endsWith('.zip'));
    const packs = ['"vanilla"'];
    // Le pack intégré "fabric" n'existe que sous Fabric (Fabric Resource Loader).
    // Sous Forge, les ressources des mods sont chargées via le loader, pas via options.txt.
    if (loader === 'fabric') packs.push('"fabric"');
    for (const rp of installedRPs) {
        packs.push(`"file/${rp}"`);
    }
    const resourcePacksLine = 'resourcePacks:[' + packs.join(',') + ']';

    let optionsContent = '';
    if (fs.existsSync(optionsPath)) {
        optionsContent = fs.readFileSync(optionsPath, 'utf8');
        if (optionsContent.includes('resourcePacks:')) {
            optionsContent = optionsContent.replace(/resourcePacks:\[.*?\]/, resourcePacksLine);
        } else {
            optionsContent += '\n' + resourcePacksLine + '\n';
        }
    } else {
        optionsContent = resourcePacksLine + '\n';
    }
    fs.writeFileSync(optionsPath, optionsContent);
    console.log('[MC] options.txt mis à jour avec ' + installedRPs.length + ' resource packs');
}

// Télécharge un Java 21 portable (Temurin/Adoptium) une seule fois,
// commun à tous les modpacks, et renvoie le chemin du binaire java.
function findJavaBinary(dir) {
    const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of entries) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else if (ent.name === exe && path.basename(cur) === 'bin') return full;
        }
    }
    return null;
}

function downloadToFile(url, destPath) {
    return new Promise(async (resolve, reject) => {
        try {
            const res = await fetchWithRedirect(url);
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        } catch (err) { reject(err); }
    });
}

async function setupJava(onStatus) {
    const javaRoot = path.join(app.getPath('userData'), 'java', 'jre21');

    // Déjà installé ? On réutilise.
    const existing = findJavaBinary(javaRoot);
    if (existing && fs.existsSync(existing)) return existing;

    const platform = process.platform === 'win32' ? 'windows'
                   : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const ext = platform === 'windows' ? 'zip' : 'tar.gz';
    const url = `https://api.adoptium.net/v3/binary/latest/21/ga/${platform}/${arch}/jre/hotspot/normal/eclipse`;

    fs.mkdirSync(javaRoot, { recursive: true });
    const archivePath = path.join(javaRoot, 'jre21.' + ext);

    if (onStatus) onStatus("Téléchargement de Java 21 (une seule fois)...");
    await downloadToFile(url, archivePath);

    if (onStatus) onStatus("Installation de Java 21...");
    if (ext === 'zip') {
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(javaRoot, true);
    } else {
        await tar.x({ file: archivePath, cwd: javaRoot });
    }
    fs.unlinkSync(archivePath);

    const bin = findJavaBinary(javaRoot);
    if (!bin) throw new Error("binaire Java introuvable après extraction");
    if (process.platform !== 'win32') {
        try { fs.chmodSync(bin, 0o755); } catch (e) {}
    }
    console.log('[MC] Java 21 prêt : ' + bin);
    return bin;
}

ipcMain.on('launch-game', async (event, packData) => {
    if (!mcToken) {
        event.sender.send('launch-error', "Lancement impossible : pas de token");
        return;
    }

    const ram = packData.ram || 4;
    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    const modsDir = path.join(gameDir, 'mods');
    const datapacksDir = path.join(gameDir, 'datapacks');
    const shaderpacksDir = path.join(gameDir, 'shaderpacks');
    const resourcepacksDir = path.join(gameDir, 'resourcepacks');

    if (packData.defaults_url) {
        event.sender.send('sync-status', { message: "Installation des configurations..." });
        await setupDefaults(gameDir, packData.defaults_url);
    }

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
            event.sender.send('sync-status', { message: "Avertissement RP : " + err.message });
        }
    }

    event.sender.send('sync-status', { message: "Configuration serveur multijoueur..." });
    await setupServersDat(gameDir, packData.servers_dat_url);

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

    const loader = (packData.loader || 'fabric').toLowerCase();

    event.sender.send('sync-status', { message: "Activation des resource packs..." });
    activateResourcepacks(gameDir, resourcepacksDir, loader);

    // Java 21 fourni par le launcher (commun à tous les packs).
    // En cas d'échec, on retombe sur le Java système (cf. README).
    let javaPath = null;
    try {
        javaPath = await setupJava((msg) => event.sender.send('sync-status', { message: msg }));
    } catch (err) {
        console.error('[MC] Java auto indisponible :', err.message);
        event.sender.send('sync-status', { message: "Java auto indisponible, utilisation du Java système..." });
    }

    try {
        let opts;

        if (loader === 'forge') {
            const forgeVersion = packData.loader_version || "47.4.10";
            event.sender.send('sync-status', { message: "Installation de Forge " + forgeVersion + "..." });
            const forgeInstaller = await setupForge(
                gameDir, packData.minecraft, forgeVersion,
                (msg) => event.sender.send('sync-status', { message: msg })
            );

            opts = {
                authorization: mcToken.mclc(),
                root: gameDir,
                version: {
                    number: packData.minecraft,
                    type: "release"
                },
                forge: forgeInstaller,
                memory: { max: ram + "G", min: "2G" }
            };
            if (javaPath) opts.javaPath = javaPath;
        } else {
            const loaderVersion = packData.loader_version || "0.18.4";
            event.sender.send('sync-status', { message: "Installation de Fabric..." });
            const fabricVersion = await setupFabric(gameDir, packData.minecraft, loaderVersion);

            opts = {
                authorization: mcToken.mclc(),
                root: gameDir,
                version: {
                    number: packData.minecraft,
                    type: "release",
                    custom: fabricVersion
                },
                memory: { max: ram + "G", min: "2G" }
            };
            if (javaPath) opts.javaPath = javaPath;
        }

        event.sender.send('sync-status', { message: "Démarrage de Minecraft..." });
        await launcher.launch(opts);
    } catch (err) {
        event.sender.send('launch-error', String(err));
    }
});
