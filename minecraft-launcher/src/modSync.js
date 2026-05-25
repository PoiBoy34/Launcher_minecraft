const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getCatalogUrl() {
    return "https://raw.githubusercontent.com/PoiBoy34/Launcher_minecraft/main/catalog.json?t=" + Date.now();
}

function getUrl(baseUrl) {
    return baseUrl + (baseUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
}

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, { headers: { 'User-Agent': 'minecraft-launcher' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                fetchJSON(res.headers.location).then(resolve).catch(reject);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('JSON invalide : ' + e.message)); }
            });
        }).on('error', reject);
    });
}

function sha1File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, { headers: { 'User-Agent': 'minecraft-launcher' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error('HTTP ' + res.statusCode + ' pour ' + url));
                return;
            }
            const total = parseInt(res.headers['content-length'] || '0');
            let received = 0;
            const file = fs.createWriteStream(destPath);
            res.on('data', chunk => {
                received += chunk.length;
                if (onProgress && total) onProgress(received, total);
            });
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

async function fetchCatalog() {
    return await fetchJSON(getCatalogUrl());
}

async function syncFiles(manifestUrl, destDir, label, onStatus, onProgress) {
    onStatus("Récupération " + label + "...");
    const manifest = await fetchJSON(getUrl(manifestUrl));

    fs.mkdirSync(destDir, { recursive: true });

    const expectedFiles = new Set(manifest.files.map(f => f.name));
    for (const existing of fs.readdirSync(destDir)) {
        if (existing.includes('.part')) continue;
        const isAssembled = fs.readdirSync(destDir).some(f => f === existing + '.part00');
        if (isAssembled) continue;
        if (!expectedFiles.has(existing)) {
            fs.unlinkSync(path.join(destDir, existing));
            onStatus("Supprimé : " + existing);
        }
    }

    for (let i = 0; i < manifest.files.length; i++) {
        const file = manifest.files[i];
        const destPath = path.join(destDir, file.name);

        let needsDownload = true;
        if (fs.existsSync(destPath)) {
            onStatus("Vérification : " + file.name);
            const localSha1 = await sha1File(destPath);
            if (localSha1 === file.sha1) needsDownload = false;
        }

        if (needsDownload) {
            onStatus(label + " (" + (i + 1) + "/" + manifest.files.length + ") : " + file.name);
            await downloadFile(file.url, destPath, (received, total) => {
                onProgress(file.name, received, total);
            });
            onStatus("OK : " + file.name);
        } else {
            onStatus("A jour : " + file.name);
        }
    }

    onStatus(label + " synchronisés ✓");
    return manifest;
}

async function syncMods(manifestUrl, modsDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, modsDir, "Mods", onStatus, onProgress);
}

async function syncDatapacks(manifestUrl, datapacksDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, datapacksDir, "Datapacks", onStatus, onProgress);
}

async function syncShaderpacks(manifestUrl, shaderpacksDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, shaderpacksDir, "Shaders", onStatus, onProgress);
}

async function syncResourcepacks(manifestUrl, resourcepacksDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, resourcepacksDir, "Resource Packs", onStatus, onProgress);
}

module.exports = { fetchCatalog, syncMods, syncDatapacks, syncShaderpacks, syncResourcepacks };
