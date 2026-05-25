const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const extract = require('extract-zip');
const tar = require('tar');
const os = require('os');

async function downloadFile(url, dest) {
    const writer = fs.createWriteStream(dest);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function ensureJava(userDataPath, onProgress) {
    const javaBaseDir = path.join(userDataPath, 'java21-portable');
    const platform = os.platform(); // 'win32' ou 'linux'
    
    // Vérifier si Java est déjà extrait et prêt
    if (fs.existsSync(javaBaseDir)) {
        const items = await fs.readdir(javaBaseDir);
        const subDir = items.find(i => fs.statSync(path.join(javaBaseDir, i)).isDirectory());
        if (subDir) {
            let javaExec = path.join(javaBaseDir, subDir, 'bin', 'java');
            if (platform === 'win32') javaExec += '.exe';
            if (fs.existsSync(javaExec)) return javaExec;
        }
    }

    onProgress("Téléchargement de Java 21 en arrière-plan...");
    
    let downloadUrl = '';
    let ext = '';
    
    if (platform === 'win32') {
        downloadUrl = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse';
        ext = '.zip';
    } else if (platform === 'linux') {
        downloadUrl = 'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse';
        ext = '.tar.gz';
    } else {
        throw new Error("OS non supporté.");
    }

    const archivePath = path.join(userDataPath, `java21_archive${ext}`);
    
    // Créer le dossier et télécharger
    await fs.ensureDir(javaBaseDir);
    await downloadFile(downloadUrl, archivePath);
    
    onProgress("Installation de Java 21...");
    
    // Extraire l'archive
    if (platform === 'win32') {
        await extract(archivePath, { dir: javaBaseDir });
    } else {
        await tar.x({ file: archivePath, cwd: javaBaseDir });
    }

    // Nettoyer l'archive
    await fs.remove(archivePath);

    // Trouver l'exécutable dans le dossier extrait
    const items = await fs.readdir(javaBaseDir);
    const subDir = items.find(i => fs.statSync(path.join(javaBaseDir, i)).isDirectory());
    let finalExec = path.join(javaBaseDir, subDir, 'bin', 'java');
    if (platform === 'win32') finalExec += '.exe';

    // Donner les droits d'exécution sur Linux
    if (platform === 'linux') {
        fs.chmodSync(finalExec, '755');
    }

    return finalExec;
}

module.exports = { ensureJava };
