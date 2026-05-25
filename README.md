## 🏗️ Phase 1 : Initialisation et Architecture (Setup)
*Mise en place de l'environnement de travail et des fondations du projet.*

### 🛠️ Les tâches de Joseph (Infrastructure & Serveur)
- [ ] Créer le dépôt GitHub public (ex: `custom-mc-launcher`).
- [ ] Créer la structure de dossiers pour héberger les mods sur le dépôt (ex: `/modpacks/survie/mods/`).
- [ ] Rédiger la première version du fichier `catalog.json` à la racine (avec les infos du premier modpack).
- [ ] Créer le `manifest.json` du premier modpack (lister 2 ou 3 mods avec leurs liens directs et leur hash SHA-1 pour tester).
- [ ] Ajouter Eman en tant que collaborateur sur le dépôt GitHub.

### 💻 Les tâches d'Eman (Développement Windows)
- [ ] Cloner le dépôt GitHub sur sa machine Windows.
- [ ] Initialiser le projet Node.js (`npm init -y`).
- [ ] Installer les dépendances principales : `npm install minecraft-launcher-core electron download`.
- [ ] Installer les dépendances de développement : `npm install electron-builder --save-dev`.
- [ ] Configurer le fichier `.gitignore` pour exclure `node_modules` et les dossiers `.minecraft` locaux.

---

## ⚙️ Phase 2 : Le Moteur (Lancement sans interface)
*Prouver que le jeu peut se lancer via du code JavaScript pur.*

### 💻 Les tâches d'Eman (Développement)
- [ ] Créer un script `launcher-core.js` (hors Electron pour l'instant).
- [ ] Importer `minecraft-launcher-core` et configurer une instance de test (mode Offline).
- [ ] Réussir à lancer Minecraft Vanilla (ex: 1.20.1) depuis le terminal Windows (`node launcher-core.js`).
- [ ] *Push* ce code fonctionnel sur GitHub.

### 🛠️ Les tâches de Joseph (Infrastructure & Tests)
- [ ] *Pull* le code d'Eman sur ta machine Linux.
- [ ] Faire un `npm install` pour récupérer les modules.
- [ ] Lancer le script via ton terminal pour vérifier que `minecraft-launcher-core` télécharge bien les assets et lance le jeu sous Linux.

---

## 🔄 Phase 3 : Synchronisation Réseau (Le cœur du système)
*Faire communiquer le code local avec l'architecture GitHub.*

### 💻 Les tâches d'Eman (Développement)
- [ ] Coder une fonction `fetchCatalog()` qui lit le `catalog.json` sur GitHub via une requête HTTP (`fetch`).
- [ ] Coder une fonction `checkUpdates()` qui compare le dossier `mods` local avec le `manifest.json` du modpack sélectionné.
- [ ] Coder la logique de téléchargement : si un mod manque ou a un SHA-1 différent, le télécharger et le placer dans le bon dossier d'instance.
- [ ] Intégrer cette logique juste avant le lancement de `minecraft-launcher-core`.

### 🛠️ Les tâches de Joseph (Infrastructure)
- [ ] Préparer un "vrai" modpack de test complet.
- [ ] Uploader tous les fichiers `.jar` sur GitHub (attention à la limite de 100 Mo par fichier, utiliser les Releases GitHub si les fichiers sont trop gros).
- [ ] Valider que le JSON est correctement formaté (utiliser un validateur JSON en ligne pour éviter les erreurs de syntaxe qui feraient planter le code d'Eman).

---

## 🖥️ Phase 4 : L'Interface Graphique (Intégration Electron)
*Créer le logiciel final avec sa fenêtre et ses boutons.*

### 💻 Les tâches d'Eman (Développement)
- [ ] Créer le `main.js` (cerveau d'Electron) et le `index.html` (interface visuelle).
- [ ] Coder le pont de communication (IPC) : l'interface HTML doit pouvoir envoyer l'ordre "Lance le modpack X" au `main.js`.
- [ ] Lier la barre de progression HTML aux événements de téléchargement de `minecraft-launcher-core` (pour voir l'avancement).
- [ ] Peaufiner le CSS (boutons, liste dynamique générée à partir du `catalog.json`).

### 🛠️ Les tâches de Joseph (Design & Tests)
- [ ] Créer ou trouver les assets visuels (images de fond, icônes pour les modpacks, icône de l'application en `.ico` et `.png`).
- [ ] Envoyer ces assets sur le dépôt GitHub.
- [ ] Tester l'interface complète sur Linux (vérifier que les boutons répondent bien et que les chemins de dossiers locaux ne buggent pas).

---

## 📦 Phase 5 : Compilation et Distribution (Le livrable final)
*Transformer le code source en exécutables prêts à l'emploi.*

### 💻 Les tâches d'Eman (Build Windows)
- [ ] Configurer la section `build` dans le `package.json` pour cibler Windows (format `nsis` ou `portable`).
- [ ] Lancer la commande de *build* (`npx electron-builder --win`).
- [ ] Tester le `.exe` généré sur son PC comme un utilisateur normal.

### 🛠️ Les tâches de Joseph (Build Linux)
- [ ] Récupérer la toute dernière version du code final sur ton Linux.
- [ ] Configurer (si ce n'est pas déjà fait par Eman) la cible Linux dans le `package.json` (format `AppImage` recommandé).
- [ ] Lancer la commande de *build* sur ta machine (`npx electron-builder --linux`).
- [ ] Distribuer le `.AppImage` (pour toi) et récupérer le `.exe` (généré par Eman) pour les autres joueurs.
