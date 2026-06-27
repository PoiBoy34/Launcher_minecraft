# SUS-Launcher

A custom Minecraft launcher that bundles **two modpacks** into a single app. Install the launcher once, pick your pack, click **Play** — everything else (mods, configs, resource packs) downloads and updates on its own.

*(Version française plus bas / French version below ⬇️)*

## Available modpacks

| Modpack | Minecraft version | Loader | Description |
|---|---|---|---|
| **Aventure Cobblemon** | 1.21.1 | Fabric | The Pokémon / Cobblemon adventure |
| **Time Rift Universe** | 1.20.1 | Forge | Adventure on the Time Rift island |

## Installation

Download the latest launcher from the releases page:

👉 **https://github.com/PoiBoy34/Launcher_minecraft/releases/latest**

### Windows
1. Download **`SUS-Launcher-Setup-x.x.x.exe`**
2. Run it and follow the installer
3. Open **SUS-Launcher** from the Start menu or desktop shortcut

### Linux
1. Download **`SUS-Launcher-x.x.x.AppImage`**
2. Make it executable (right-click → Properties → Allow executing, or in a terminal:
   `chmod +x SUS-Launcher-*.AppImage`)
3. Double-click it to launch

## How it works

1. **Log in** with your Microsoft account (button at the top right).
2. **Pick a modpack** from the list.
3. **Click Play.**

From there the launcher does everything automatically:
- it downloads the mods, configs and resource packs for the chosen pack;
- it installs the right loader (Fabric or Forge depending on the pack);
- it checks every file, then launches the game.

You **don't need to install or configure anything by hand**. The first launch takes a while (big download); after that it's almost instant — only missing or changed files are re-downloaded.

## Updates

The launcher updates itself. When a new version is out, a banner appears at the top of the window: click **Download**, then **Install & restart**.

You can also check anytime in **⚙️ Settings → Launcher → Check for updates**.

## ⚠️ Known issue: Java

If the game **crashes on launch** or shows a **Java-related error**, you're missing a recent version of Java.

➡️ **Install Java 21**, then restart the launcher.

You can download it for free here: **https://adoptium.net/temurin/releases/?version=21**
(pick your operating system, choose **JDK 21**).

Once Java 21 is installed, the modpack launches normally.

## Need help?

If something goes wrong, note the error message shown at the bottom of the launcher (the log line) — it tells you exactly what failed.

---

# SUS-Launcher (Français)

Un launcher Minecraft personnalisé qui regroupe **deux modpacks** dans une seule application. Tu installes le launcher une fois, tu choisis ton pack, tu cliques sur **Jouer** : tout le reste (mods, configs, resource packs) se télécharge et se met à jour tout seul.

## Les modpacks disponibles

| Modpack | Version Minecraft | Loader | Description |
|---|---|---|---|
| **Aventure Cobblemon** | 1.21.1 | Fabric | L'aventure Pokémon/Cobblemon |
| **Time Rift Universe** | 1.20.1 | Forge | Aventure sur l'île de Time Rift |

## Installation

Télécharge la dernière version du launcher sur la page des releases :

👉 **https://github.com/PoiBoy34/Launcher_minecraft/releases/latest**

### Windows
1. Télécharge le fichier **`SUS-Launcher-Setup-x.x.x.exe`**
2. Lance-le et suis l'installation
3. Ouvre **SUS-Launcher** depuis le menu Démarrer ou le raccourci bureau

### Linux
1. Télécharge le fichier **`SUS-Launcher-x.x.x.AppImage`**
2. Rends-le exécutable (clic droit → Propriétés → Autoriser l'exécution, ou en terminal :
   `chmod +x SUS-Launcher-*.AppImage`)
3. Double-clique dessus pour lancer

## Comment ça marche

1. **Connecte-toi** avec ton compte Microsoft (bouton en haut à droite).
2. **Choisis un modpack** dans la liste.
3. **Clique sur Jouer.**

À ce moment-là, le launcher fait tout automatiquement :
- il télécharge les mods, configs et resource packs du pack choisi ;
- il installe le bon loader (Fabric ou Forge selon le pack) ;
- il vérifie que chaque fichier est correct, puis lance le jeu.

Tu n'as **rien à installer ni à configurer à la main**. Au premier lancement c'est un peu long (gros téléchargement), les fois suivantes c'est quasi instantané — seuls les fichiers manquants ou modifiés sont re-téléchargés.

## Mises à jour

Le launcher se met à jour tout seul. Quand une nouvelle version sort, une bannière apparaît en haut de la fenêtre : clique **Télécharger** puis **Installer & redémarrer**.

Tu peux aussi vérifier à tout moment dans **⚙️ Paramètres → Launcher → Vérifier les mises à jour**.

## ⚠️ Problème connu : Java

Si le jeu **plante au lancement** ou affiche une **erreur liée à Java**, c'est qu'il te manque une version récente de Java.

➡️ **Installe Java 21**, puis relance le launcher.

Tu peux le télécharger gratuitement ici : **https://adoptium.net/temurin/releases/?version=21**
(choisis ton système d'exploitation, prends le **JDK 21**).

Une fois Java 21 installé, le modpack se lance normalement.

## Besoin d'aide ?

En cas de souci, note le message d'erreur affiché en bas du launcher (la ligne de log) — il indique précisément ce qui a coincé.
