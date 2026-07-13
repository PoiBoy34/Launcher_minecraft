// ===========================================================================
// SUS-Launcher — process principal Electron
// v2 : logs persistants + rapport de diagnostic, test voice chat,
//      réseau durci (timeouts/retries/DoH), auth Microsoft robuste.
// ===========================================================================
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const log = require('electron-log');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods, syncDatapacks, syncShaderpacks, syncResourcepacks } = require('./modSync');
const { fetchWithRedirect, dnsDiagnostic, safeLookup } = require('./netUtils');

// ---------------------------------------------------------------------------
// Logs : tout (launcher + sortie Minecraft) part dans un fichier rotatif.
// C'est la matière première du bouton "Copier le rapport".
// ---------------------------------------------------------------------------
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 Mo puis rotation
log.transports.file.level = 'info';
Object.assign(console, log.functions); // console.log/error → fichier + terminal

// Tampon circulaire de la sortie Minecraft (pour le rapport, sans relire le disque)
const MC_BUFFER_MAX = 400;
const mcOutputBuffer = [];
function pushMcLine(line) {
    const clean = String(line).trimEnd();
    if (!clean) return;
    mcOutputBuffer.push(clean);
    if (mcOutputBuffer.length > MC_BUFFER_MAX) mcOutputBuffer.shift();
}

process.on('uncaughtException', (err) => {
    log.error('[FATAL]', err);
});
process.on('unhandledRejection', (reason) => {
    log.error('[UNHANDLED REJECTION]', reason);
});

// ---------------------------------------------------------------------------
// Instance unique : deux launchers ouverts = deux jeux + fichiers verrouillés.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
    app.quit();
}
app.on('second-instance', () => {
    if (currentWindow) {
        if (currentWindow.isMinimized()) currentWindow.restore();
        currentWindow.focus();
    }
});

const launcher = new Client();
let mcToken = null;
let mcTokenTimestamp = 0;      // pour rafraîchir un token trop vieux avant lancement
let currentWindow = null;
let isLaunching = false;       // anti double-clic sur JOUER
let lastSelectedPackName = ''; // contexte pour le rapport de diagnostic

const TOKEN_MAX_AGE_MS = 50 * 60 * 1000; // les tokens MC expirent ~1h ; marge de sécurité

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = log;

autoUpdater.on('update-available', (info) => {
    if (currentWindow) currentWindow.webContents.send('update-available', { version: info.version });
});
autoUpdater.on('update-not-available', () => {
    if (currentWindow) currentWindow.webContents.send('update-not-available');
});
autoUpdater.on('download-progress', (progress) => {
    if (currentWindow) currentWindow.webContents.send('update-progress', { pct: Math.round(progress.percent) });
});
autoUpdater.on('update-downloaded', () => {
    if (currentWindow) currentWindow.webContents.send('update-downloaded');
});
autoUpdater.on('error', (err) => {
    log.error('[Updater]', err.message);
    if (currentWindow) currentWindow.webContents.send('update-error', err.message);
});

launcher.on('debug', (e) => { log.info('[MC]', e); pushMcLine('[debug] ' + e); });
launcher.on('data',  (e) => { pushMcLine(e); });
launcher.on('close', (code) => {
    log.info('[MC] Jeu fermé, code', code);
    pushMcLine('[launcher] Jeu fermé avec le code ' + code);
    isLaunching = false;
});
launcher.on('error', (e) => {
    log.error('[MC ERREUR]', e);
    pushMcLine('[erreur] ' + e);
    isLaunching = false;
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
    log.info('=== SUS-Launcher v' + app.getVersion() + ' démarré (' + process.platform + ' ' + os.release() + ') ===');
    createWindow();
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => log.error('[Updater check]', err.message));
    }, 3000);
});

ipcMain.on('check-update', () => {
    autoUpdater.checkForUpdates().catch(err => log.error('[Updater]', err.message));
});
ipcMain.on('download-update', () => {
    autoUpdater.downloadUpdate().catch(err => log.error('[Updater]', err.message));
});
ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
});

ipcMain.handle('get-catalog', async () => {
    try {
        const catalog = await fetchCatalog();
        return { success: true, catalog };
    } catch (err) {
        log.error('[Catalog]', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-launcher-version', () => app.getVersion());

// ---------------------------------------------------------------------------
// Auth Microsoft — durcie.
// Points corrigés vs v1 :
//  - JSON corrompu sur disque → suppression du fichier au lieu de crasher en boucle
//  - le refresh_token le plus récent est TOUJOURS resauvegardé
//  - rafraîchissement automatique avant lancement si le token est trop vieux
// ---------------------------------------------------------------------------
function authFilePath() {
    return path.join(app.getPath('userData'), 'msmc-auth.json');
}

function readSavedAuth() {
    const p = authFilePath();
    if (!fs.existsSync(p)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return (data && data.refresh_token) ? data : null;
    } catch (e) {
        log.error('[Auth] Fichier auth corrompu, suppression :', e.message);
        try { fs.unlinkSync(p); } catch (e2) {}
        return null;
    }
}

function saveAuth(msToken) {
    try {
        if (msToken && msToken.refresh_token) {
            fs.writeFileSync(authFilePath(), JSON.stringify(msToken));
        }
    } catch (e) {
        log.error('[Auth] Sauvegarde impossible :', e.message);
    }
}

async function refreshFromSaved() {
    const saved = readSavedAuth();
    if (!saved) throw new Error('Aucune session sauvegardée');
    const authManager = new Auth('select_account');
    const xboxManager = await authManager.refresh(saved.refresh_token);
    mcToken = await xboxManager.getMinecraft();
    mcTokenTimestamp = Date.now();
    saveAuth(xboxManager.msToken);
    return mcToken;
}

ipcMain.on('auto-login', async (event) => {
    try {
        const token = await refreshFromSaved();
        event.sender.send('auth-success', { name: token.profile.name });
    } catch (err) {
        log.info('[AutoLogin] Session absente ou expirée :', err.message);
        event.sender.send('auth-missing');
    }
});

ipcMain.on('login-microsoft', async (event) => {
    try {
        const authManager = new Auth('select_account');
        const xboxManager = await authManager.launch('electron');
        mcToken = await xboxManager.getMinecraft();
        mcTokenTimestamp = Date.now();
        saveAuth(xboxManager.msToken);
        event.sender.send('auth-success', { name: mcToken.profile.name });
    } catch (err) {
        log.error('[Login]', err.message);
        // Message plus utile que le brut msmc pour les cas fréquents
        let message = err.message;
        if (/network|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
            message = 'Problème réseau pendant la connexion Microsoft. Vérifie ta connexion / ton DNS puis réessaie. (' + err.message + ')';
        } else if (/cancel|closed/i.test(message)) {
            message = 'Connexion annulée.';
        }
        event.sender.send('auth-error', { message });
    }
});

ipcMain.on('open-folder', (event, type, packId) => {
    if (!packId) return;
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
        log.info('[MC] Marker defaults supprimé pour ' + packId);
    }
    event.sender.send('defaults-reset');
});

// ---------------------------------------------------------------------------
// DIAGNOSTIC : rapport de logs + tests réseau
// ---------------------------------------------------------------------------
function tail(filePath, maxLines) {
    try {
        if (!fs.existsSync(filePath)) return '(fichier absent)';
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        return lines.slice(-maxLines).join('\n');
    } catch (e) {
        return '(illisible : ' + e.message + ')';
    }
}

function findLatestGameLog(packId) {
    if (!packId) return null;
    const p = path.join(app.getPath('userData'), 'instances', packId, 'logs', 'latest.log');
    return fs.existsSync(p) ? p : null;
}

async function buildDiagnosticReport(packData) {
    const lines = [];
    const pack = packData || {};
    lines.push('===== RAPPORT SUS-LAUNCHER =====');
    lines.push('Date          : ' + new Date().toISOString());
    lines.push('Launcher      : v' + app.getVersion());
    lines.push('OS            : ' + process.platform + ' ' + os.release() + ' (' + process.arch + ')');
    lines.push('RAM machine   : ' + Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' Go');
    lines.push('Modpack       : ' + (pack.name || lastSelectedPackName || '(aucun)'));
    lines.push('Connecté      : ' + (mcToken ? mcToken.profile.name : 'non'));
    lines.push('');

    // Tests DNS : révèle immédiatement les joueurs au DNS routeur cassé
    lines.push('--- Tests DNS (système vs Cloudflare/Google) ---');
    const hostsToTest = [
        'raw.githubusercontent.com',
        pack.server_host ? pack.server_host.split(':')[0] : 'timerift.mekhorizon.org',
        (pack.voice_test || 'taken-gig.nyc.at.playit.plus:1088').split(':')[0]
    ];
    for (const h of [...new Set(hostsToTest)]) {
        try {
            const d = await dnsDiagnostic(h);
            lines.push(h + ' → système: ' + (d.system || ('ÉCHEC ' + d.systemError)) +
                       ' | DoH: ' + (d.doh || ('ÉCHEC ' + d.dohError)));
        } catch (e) {
            lines.push(h + ' → erreur test : ' + e.message);
        }
    }
    lines.push('');

    lines.push('--- Dernières lignes du log launcher ---');
    lines.push(tail(log.transports.file.getFile().path, 120));
    lines.push('');

    lines.push('--- Sortie Minecraft (session en cours) ---');
    lines.push(mcOutputBuffer.length ? mcOutputBuffer.slice(-150).join('\n') : '(aucune session lancée)');
    lines.push('');

    const gameLog = findLatestGameLog(pack.id);
    if (gameLog) {
        lines.push('--- instances/' + pack.id + '/logs/latest.log (fin) ---');
        lines.push(tail(gameLog, 150));
    }

    lines.push('===== FIN DU RAPPORT =====');
    return lines.join('\n');
}

ipcMain.handle('get-diagnostics', async (event, packData) => {
    try {
        const report = await buildDiagnosticReport(packData);
        clipboard.writeText(report); // copie directe : le joueur n'a qu'à coller sur Discord
        return { success: true, report };
    } catch (err) {
        log.error('[Diag]', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('save-diagnostics', async (event, packData) => {
    try {
        const report = await buildDiagnosticReport(packData);
        const { filePath } = await dialog.showSaveDialog(currentWindow, {
            title: 'Enregistrer le rapport',
            defaultPath: path.join(app.getPath('desktop'), 'sus-launcher-rapport.txt'),
            filters: [{ name: 'Texte', extensions: ['txt'] }]
        });
        if (!filePath) return { success: false, error: 'annulé' };
        fs.writeFileSync(filePath, report);
        return { success: true, path: filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('open-logs-folder', () => {
    shell.openPath(path.dirname(log.transports.file.getFile().path));
});

// ---------------------------------------------------------------------------
// TEST VOICE CHAT
// 1) DNS système vs DoH sur le voice host  → détecte le DNS cassé du joueur
// 2) TCP vers le serveur Minecraft          → détecte un blocage réseau général
// 3) Ping UDP SVC via le binaire officiel `svc` (henkelmax/svc-cli-utils)
//    s'il est embarqué dans resources/bin/  → détecte le blocage UDP
// NOTE : vérifie la syntaxe exacte avec `svc ping --help` et ajuste SVC_ARGS.
// ---------------------------------------------------------------------------
function tcpTest(host, port, timeoutMs = 6000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const socket = net.createConnection({ host, port, lookup: safeLookup, timeout: timeoutMs });
        socket.on('connect', () => { socket.destroy(); resolve({ ok: true, ms: Date.now() - started }); });
        socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }); });
        socket.on('error', (e) => { resolve({ ok: false, error: e.code || e.message }); });
    });
}

function findSvcBinary() {
    const exe = process.platform === 'win32' ? 'svc.exe' : 'svc';
    const candidates = [
        path.join(process.resourcesPath || '', 'bin', exe),
        path.join(app.getAppPath(), 'bin', exe),
        path.join(app.getPath('userData'), 'bin', exe)
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

function svcPing(binPath, host, port) {
    return new Promise((resolve) => {
        // Syntaxe à valider avec `svc ping --help` — ajuste ici si besoin.
        const SVC_ARGS = ['ping', host, '-p', String(port)];
        let output = '';
        let child;
        try {
            child = spawn(binPath, SVC_ARGS, { timeout: 20000 });
        } catch (e) {
            resolve({ ran: false, ok: false, output: 'Lancement impossible : ' + e.message });
            return;
        }
        child.stdout.on('data', d => output += d);
        child.stderr.on('data', d => output += d);
        child.on('error', (e) => resolve({ ran: false, ok: false, output: String(e.message) }));
        child.on('close', (code) => {
            resolve({ ran: true, ok: code === 0, output: output.trim() });
        });
    });
}

ipcMain.handle('test-voicechat', async (event, packData) => {
    const pack = packData || {};
    const voiceTarget = pack.voice_test || 'taken-gig.nyc.at.playit.plus:1088';
    const [voiceHost, voicePortStr] = voiceTarget.split(':');
    const voicePort = parseInt(voicePortStr || '24454');
    const mcTarget = pack.server_host || 'timerift.mekhorizon.org:25565';
    const [mcHost, mcPortStr] = mcTarget.split(':');
    const mcPort = parseInt(mcPortStr || '25565');

    const result = { voiceTarget, steps: [] };
    log.info('[VoiceTest] Démarrage pour', voiceTarget);

    // 1) DNS
    const d = await dnsDiagnostic(voiceHost);
    if (d.system) {
        result.steps.push({ id: 'dns', ok: true, detail: 'DNS OK → ' + d.system });
    } else if (d.doh) {
        result.steps.push({
            id: 'dns', ok: false, warn: true,
            detail: 'TON DNS EST CASSÉ : le système ne résout pas ' + voiceHost +
                    ' (' + d.systemError + ') mais Cloudflare/Google y arrivent (' + d.doh + '). ' +
                    'Configure 1.1.1.1 et 8.8.8.8 dans tes paramètres réseau Windows.'
        });
    } else {
        result.steps.push({
            id: 'dns', ok: false,
            detail: 'Résolution impossible partout (' + (d.systemError || '?') + '). Pas de connexion Internet ?'
        });
    }

    // 2) TCP Minecraft (chemin réseau général)
    const tcp = await tcpTest(mcHost, mcPort);
    result.steps.push({
        id: 'tcp', ok: tcp.ok,
        detail: tcp.ok ? ('Serveur Minecraft joignable (' + tcp.ms + ' ms)')
                       : ('Serveur Minecraft injoignable en TCP : ' + tcp.error)
    });

    // 3) Ping UDP voice chat via binaire svc si présent
    const bin = findSvcBinary();
    if (bin) {
        const ping = await svcPing(bin, voiceHost, voicePort);
        result.steps.push({
            id: 'udp', ok: ping.ok,
            detail: ping.ok ? ('Voice chat UDP OK — ' + ping.output)
                            : ('Voice chat UDP en échec — ' + (ping.output || 'aucune réponse') +
                               '. Si le DNS et le TCP sont OK, ton réseau (pare-feu, école, 4G, VPN) bloque probablement l\'UDP.')
        });
    } else {
        result.steps.push({
            id: 'udp', ok: null,
            detail: 'Test UDP indisponible (binaire svc non embarqué dans cette version du launcher).'
        });
    }

    log.info('[VoiceTest] Résultat :', JSON.stringify(result));
    return result;
});

// ---------------------------------------------------------------------------
// Assemblage des mods splittés (.partXX)
// ---------------------------------------------------------------------------
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
    const customName = `fabric-loader-${loaderVersion}-${mcVersion}`;
    const versionDir = path.join(gameDir, 'versions', customName);
    const jsonFile = path.join(versionDir, `${customName}.json`);
    if (fs.existsSync(jsonFile)) return customName;

    fs.mkdirSync(versionDir, { recursive: true });
    const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
    const res = await fetchWithRedirect(url);
    if (res.statusCode !== 200) throw new Error(`Fabric profile HTTP ${res.statusCode}`);
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(jsonFile);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
    });
    log.info('[MC] Profil Fabric installé : ' + customName);
    return customName;
}

// Purge les profils/libs d'une ANCIENNE version de Forge quand la version
// demandée change. Sans ça, une instance déjà installée en 47.4.0 reste
// coincée dessus même après un bump du catalog → crash "requires forge X".
// On ne touche QUE ce qui concerne Forge : mods/, config/, saves/, options.txt
// sont préservés.
function cleanOldForge(gameDir, mcVersion, oldForgeVersion, onStatus) {
    if (onStatus) onStatus("Nettoyage de l'ancienne version de Forge (" + oldForgeVersion + ")...");
    log.info('[MC] Purge Forge ' + oldForgeVersion + ' avant réinstallation');

    // 1. Profils de version dans versions/.
    //    PIÈGE : avec ForgeWrapper, le profil Forge ne s'appelle PAS "forge-x"
    //    mais porte le nom de la version Minecraft (ex. dossier "1.20.1" contenant
    //    1.20.1.json dont les arguments codent en dur --fml.forgeVersion 47.4.0).
    //    Filtrer sur "forge" laisse donc l'ancien profil en place → le jeu relance
    //    l'ancienne version. On purge donc TOUT versions/ : minecraft-launcher-core
    //    régénère le profil (client vanilla + Forge) au prochain lancement.
    const versionsDir = path.join(gameDir, 'versions');
    if (fs.existsSync(versionsDir)) {
        try {
            fs.rmSync(versionsDir, { recursive: true, force: true });
            log.info('[MC] Supprimé versions/ (profils régénérés au prochain lancement)');
        } catch (e) { log.error('[MC] Purge versions/ : ' + e.message); }
    }

    // 2. Libs Forge (net/minecraftforge). On ne vire QUE ce dossier : les autres
    //    libs seront revalidées/retéléchargées par le launcher au besoin.
    const forgeLibs = path.join(gameDir, 'libraries', 'net', 'minecraftforge');
    if (fs.existsSync(forgeLibs)) {
        try {
            fs.rmSync(forgeLibs, { recursive: true, force: true });
            log.info('[MC] Supprimé libraries/net/minecraftforge');
        } catch (e) { log.error('[MC] Purge libs Forge : ' + e.message); }
    }

    // 3. Anciens installers Forge qui traînent à la racine de l'instance
    try {
        for (const f of fs.readdirSync(gameDir)) {
            if (/^forge-.*-installer\.jar$/.test(f)) {
                try { fs.unlinkSync(path.join(gameDir, f)); } catch (e) {}
            }
        }
    } catch (e) {}
}

async function setupForge(gameDir, mcVersion, forgeVersion, onStatus) {
    fs.mkdirSync(gameDir, { recursive: true });

    // --- Détection FIABLE de la version réellement installée --------------
    // On NE se fie PAS au marqueur seul : il peut mentir (dire "47.4.20" alors
    // que les libs FML sur le disque sont en 47.4.0, ce qui fait relancer
    // l'ancienne version via ForgeWrapper). La source de vérité, c'est le
    // dossier des libs FML : libraries/net/minecraftforge/fmlloader/<mcVer>-<forgeVer>/
    // Si la version demandée n'y est PAS présente, l'install est périmée → purge.
    const fmlLoaderDir = path.join(gameDir, 'libraries', 'net', 'minecraftforge', 'fmlloader');
    const expectedFmlDir = path.join(fmlLoaderDir, `${mcVersion}-${forgeVersion}`);
    let correctFmlPresent = false;
    try {
        correctFmlPresent = fs.existsSync(expectedFmlDir) &&
            fs.readdirSync(expectedFmlDir).some(f => f.endsWith('.jar'));
    } catch (e) {}

    // Y a-t-il une install Forge quelconque (bonne ou périmée) ?
    let anyForgeInstalled = false;
    try {
        anyForgeInstalled = fs.existsSync(fmlLoaderDir) && fs.readdirSync(fmlLoaderDir).length > 0;
    } catch (e) {}
    // Ou un profil dans versions/ (cas de l'ancien launcher)
    if (!anyForgeInstalled) {
        const versionsDir = path.join(gameDir, 'versions');
        try {
            anyForgeInstalled = fs.existsSync(versionsDir) && fs.readdirSync(versionsDir).length > 0;
        } catch (e) {}
    }

    const markerPath = path.join(gameDir, '.forge_version');

    // Purge si : une install existe MAIS ce n'est pas la bonne version FML.
    // Couvre d'un coup le bump de version ET les instances de l'ancien launcher.
    if (anyForgeInstalled && !correctFmlPresent) {
        cleanOldForge(gameDir, mcVersion, 'périmée', onStatus);
        try { fs.unlinkSync(markerPath); } catch (e) {}
    }

    const installerName = `forge-${mcVersion}-${forgeVersion}-installer.jar`;
    const installerPath = path.join(gameDir, installerName);

    // Bonnes libs FML déjà présentes ET installer présent → rien à faire,
    // réutilisation directe (démarrage rapide).
    if (correctFmlPresent &&
        fs.existsSync(installerPath) && fs.statSync(installerPath).size > 0) {
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
    log.info('[MC] Installer Forge téléchargé : ' + installerName);

    // Marque la version comme installée : minecraft-launcher-core va exécuter
    // l'installer au lancement à partir de ce jar. Au prochain démarrage même
    // version → réutilisation ; version différente → purge auto.
    try { fs.writeFileSync(markerPath, forgeVersion); } catch (e) {}

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
        log.error('[MC] Erreur servers.dat :', err.message);
    }
}

async function setupDefaults(gameDir, defaultsUrl) {
    if (!defaultsUrl) return;
    const markerPath = path.join(gameDir, '.defaults_installed');
    if (fs.existsSync(markerPath)) return;

    log.info('[MC] Installation des configs par défaut (keybinds, minimap)...');
    fs.mkdirSync(gameDir, { recursive: true });
    const zipPath = path.join(gameDir, '_defaults.zip');
    try {
        const res = await fetchWithRedirect(defaultsUrl + '?t=' + Date.now());
        if (res.statusCode !== 200) {
            log.error('[MC] defaults.zip HTTP ' + res.statusCode);
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
        log.info('[MC] Configs par défaut installées');
    } catch (err) {
        log.error('[MC] Erreur defaults :', err.message);
    }
}

function activateResourcepacks(gameDir, resourcepacksDir, loader) {
    if (!fs.existsSync(resourcepacksDir)) return;
    const optionsPath = path.join(gameDir, 'options.txt');
    const installedRPs = fs.readdirSync(resourcepacksDir).filter(f => f.endsWith('.zip'));
    const packs = ['"vanilla"'];
    if (loader === 'fabric') packs.push('"fabric"');
    for (const rp of installedRPs) packs.push(`"file/${rp}"`);
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
    log.info('[MC] options.txt mis à jour avec ' + installedRPs.length + ' resource packs');
}

// ---------------------------------------------------------------------------
// Java 21 portable (Temurin), commun à tous les packs
// ---------------------------------------------------------------------------
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

async function downloadToFile(url, destPath) {
    const res = await fetchWithRedirect(url);
    if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
    });
}

async function setupJava(onStatus) {
    const javaRoot = path.join(app.getPath('userData'), 'java', 'jre21');
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
    log.info('[MC] Java 21 prêt : ' + bin);
    return bin;
}

// ---------------------------------------------------------------------------
// Synchronisation complète d'un pack
// ---------------------------------------------------------------------------
async function syncAllContent(event, packData, gameDir) {
    const modsDir          = path.join(gameDir, 'mods');
    const datapacksDir     = path.join(gameDir, 'datapacks');
    const shaderpacksDir   = path.join(gameDir, 'shaderpacks');
    const resourcepacksDir = path.join(gameDir, 'resourcepacks');

    const statusCb = (msg) => event.sender.send('sync-status', { message: msg });
    const progressCb = (fileName, received, total) => event.sender.send('sync-progress', {
        fileName, pct: Math.round((received / total) * 100)
    });

    await syncMods(packData.manifest_url, modsDir, statusCb, progressCb);

    if (packData.datapacks_manifest_url) {
        try { await syncDatapacks(packData.datapacks_manifest_url, datapacksDir, statusCb, progressCb); }
        catch (err) { statusCb("Avertissement datapacks : " + err.message); }
    }
    if (packData.shaderpacks_manifest_url) {
        try { await syncShaderpacks(packData.shaderpacks_manifest_url, shaderpacksDir, statusCb, progressCb); }
        catch (err) { statusCb("Avertissement shaders : " + err.message); }
    }
    if (packData.resourcepacks_manifest_url) {
        try { await syncResourcepacks(packData.resourcepacks_manifest_url, resourcepacksDir, statusCb, progressCb); }
        catch (err) { statusCb("Avertissement RP : " + err.message); }
    }

    const allFiles = fs.readdirSync(modsDir);
    for (const part00 of allFiles.filter(f => f.endsWith('.part00'))) {
        const baseName = part00.replace('.part00', '');
        const finalPath = path.join(modsDir, baseName);
        const partPaths = allFiles
            .filter(f => f.startsWith(baseName + '.part'))
            .map(f => path.join(modsDir, f));
        const totalPartsSize = partPaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
        if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size !== totalPartsSize) {
            statusCb('Assemblage : ' + baseName + '...');
            await assembleParts(modsDir, baseName, statusCb);
        }
    }
}

ipcMain.on('sync-now', async (event, packData) => {
    if (!packData || !packData.id) return;
    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    try {
        if (packData.defaults_url) {
            event.sender.send('sync-status', { message: "Installation des configurations..." });
            await setupDefaults(gameDir, packData.defaults_url);
        }
        await syncAllContent(event, packData, gameDir);
        const loader = (packData.loader || 'fabric').toLowerCase();
        activateResourcepacks(gameDir, path.join(gameDir, 'resourcepacks'), loader);
        event.sender.send('sync-status', { message: "Synchronisation terminée ✓" });
    } catch (err) {
        log.error('[SyncNow]', err.message);
        event.sender.send('sync-status', { message: "Erreur sync : " + err.message });
    } finally {
        event.sender.send('sync-done');
    }
});

// ---------------------------------------------------------------------------
// Lancement du jeu
// ---------------------------------------------------------------------------
ipcMain.on('launch-game', async (event, packData) => {
    if (isLaunching) {
        event.sender.send('sync-status', { message: "Lancement déjà en cours..." });
        return;
    }
    if (!mcToken) {
        event.sender.send('launch-error', "Lancement impossible : pas de token");
        return;
    }
    isLaunching = true;
    lastSelectedPackName = packData.name || packData.id || '';

    try {
        // Token trop vieux (launcher resté ouvert) → refresh silencieux avant
        // lancement, sinon Minecraft démarre avec un token expiré et le
        // multijoueur refuse la connexion.
        if (Date.now() - mcTokenTimestamp > TOKEN_MAX_AGE_MS) {
            event.sender.send('sync-status', { message: "Rafraîchissement de la session Microsoft..." });
            try {
                await refreshFromSaved();
            } catch (e) {
                log.error('[Launch] Refresh token échoué :', e.message);
                isLaunching = false;
                event.sender.send('auth-missing');
                event.sender.send('launch-error', "Session Microsoft expirée, reconnecte-toi.");
                return;
            }
        }

        const ram = packData.ram || 4;
        const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
        const modsDir = path.join(gameDir, 'mods');
        const resourcepacksDir = path.join(gameDir, 'resourcepacks');

        if (packData.defaults_url) {
            event.sender.send('sync-status', { message: "Installation des configurations..." });
            await setupDefaults(gameDir, packData.defaults_url);
        }

        const autoSync = packData.autoSync !== false;
        let modsPresent = false;
        try {
            modsPresent = fs.existsSync(modsDir) &&
                fs.readdirSync(modsDir).some(f => f.endsWith('.jar') || f.endsWith('.part00'));
        } catch (e) {}

        const doSync = autoSync || !modsPresent;
        if (doSync) {
            await syncAllContent(event, packData, gameDir);
        } else {
            event.sender.send('sync-status', { message: "Mode libre : mods gérés manuellement, synchronisation ignorée" });
        }

        event.sender.send('sync-status', { message: "Configuration serveur multijoueur..." });
        await setupServersDat(gameDir, packData.servers_dat_url);

        const loader = (packData.loader || 'fabric').toLowerCase();
        event.sender.send('sync-status', { message: "Activation des resource packs..." });
        activateResourcepacks(gameDir, resourcepacksDir, loader);

        let javaPath = null;
        try {
            javaPath = await setupJava((msg) => event.sender.send('sync-status', { message: msg }));
        } catch (err) {
            log.error('[MC] Java auto indisponible :', err.message);
            event.sender.send('sync-status', { message: "Java auto indisponible, utilisation du Java système..." });
        }

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
                version: { number: packData.minecraft, type: "release" },
                forge: forgeInstaller,
                memory: { max: ram + "G", min: "2G" }
            };
        } else {
            const loaderVersion = packData.loader_version || "0.18.4";
            event.sender.send('sync-status', { message: "Installation de Fabric..." });
            const fabricVersion = await setupFabric(gameDir, packData.minecraft, loaderVersion);
            opts = {
                authorization: mcToken.mclc(),
                root: gameDir,
                version: { number: packData.minecraft, type: "release", custom: fabricVersion },
                memory: { max: ram + "G", min: "2G" }
            };
        }
        if (javaPath) opts.javaPath = javaPath;

        event.sender.send('sync-status', { message: "Démarrage de Minecraft..." });
        await launcher.launch(opts);
        // isLaunching repasse à false via l'event 'close' ou 'error' du launcher
    } catch (err) {
        log.error('[Launch]', err);
        isLaunching = false;
        event.sender.send('launch-error', String(err && err.message ? err.message : err));
    }
});
