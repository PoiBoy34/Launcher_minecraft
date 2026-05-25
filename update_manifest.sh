#!/bin/bash

echo "Démarrage de la mise à jour des manifests..."

for modpack_dir in modpacks/*/; do
  MODPACK_NAME=$(basename "$modpack_dir")
  echo "----------------------------------------"
  echo "📦 Traitement du modpack : $MODPACK_NAME"

  generate_manifest() {
    local FOLDER_NAME=$1
    local MANIFEST_NAME=$2
    local TARGET_DIR="modpacks/$MODPACK_NAME/$FOLDER_NAME"
    local MANIFEST_FILE="modpacks/$MODPACK_NAME/$MANIFEST_NAME"
    local BASE_URL="https://raw.githubusercontent.com/PoiBoy34/Launcher_minecraft/main/modpacks/$MODPACK_NAME/$FOLDER_NAME"

    # Si le dossier n'existe pas, on ignore
    if [ ! -d "$TARGET_DIR" ]; then
      return
    fi

    echo "⚙️ Génération de $MANIFEST_NAME..."
    echo '{
  "version": "1.0.0",
  "files": [' > "$MANIFEST_FILE"

    local FIRST_FILE=true

    # 1. Injection du gros Mod Cobblemon
    if [ "$FOLDER_NAME" = "mods" ] && [ "$MODPACK_NAME" = "Cobblemon" ]; then
      echo '    {
      "name": "Cobblemon-fabric-1.7.3+1.21.1.jar",
      "url": "https://github.com/PoiBoy34/Launcher_minecraft/releases/download/mods-v1/Cobblemon-fabric-1.7.3+1.21.1.jar",
      "sha1": "f192cda3fdfec0f20d1dee1887ec1b9e77b1618c"
    }' >> "$MANIFEST_FILE"
      FIRST_FILE=false
    fi

    # 2. Injection des gros Resource Packs Audio (Avec le bon lien !)
    if [ "$FOLDER_NAME" = "resourcepacks" ] && [ "$MODPACK_NAME" = "Cobblemon" ]; then
      if [ "$FIRST_FILE" = false ]; then echo "    ," >> "$MANIFEST_FILE"; fi
      echo '    {
      "name": "COBBLEVERSE Soundtrack.zip",
      "url": "https://github.com/PoiBoy34/Launcher_minecraft/releases/download/mods-v1/COBBLEVERSE.Soundtrack.zip",
      "sha1": "b3a3d35c4e49e2dfee9c752b6287dcf107020708"
    },
    {
      "name": "JigglyRadio.zip",
      "url": "https://github.com/PoiBoy34/Launcher_minecraft/releases/download/mods-v1/JigglyRadio.zip",
      "sha1": "a2afd8ba31b89d46feb30919808155783821119a"
    }' >> "$MANIFEST_FILE"
      FIRST_FILE=false
    fi

    # 3. Boucle sur les fichiers locaux du dossier
    shopt -s nullglob
    for filepath in "$TARGET_DIR"/*; do
      if [ -f "$filepath" ]; then
        local filename=$(basename "$filepath")
        local hash=$(sha1sum "$filepath" | awk '{print $1}')
        
        # Sécurité : Encodage des espaces et crochets pour les fichiers classiques
        local url_filename=${filename// /%20}
        url_filename=${url_filename//\[/%5B}
        url_filename=${url_filename//\]/%5D}
        
        if [ "$FIRST_FILE" = true ]; then
          FIRST_FILE=false
        else
          echo "    ," >> "$MANIFEST_FILE"
        fi
        
        echo '    {
      "name": "'"$filename"'",
      "url": "'"$BASE_URL"'/'"$url_filename"'",
      "sha1": "'"$hash"'"
    }' >> "$MANIFEST_FILE"
        echo " -> Ajouté : $filename"
      fi
    done
    shopt -u nullglob

    echo '  ]
}' >> "$MANIFEST_FILE"
  }

  generate_manifest "mods" "manifest.json"
  generate_manifest "datapacks" "datapacks_manifest.json"
  generate_manifest "shaderpacks" "shaderpacks_manifest.json"
  generate_manifest "resourcepacks" "resourcepacks_manifest.json"

  echo "✅ Modpack $MODPACK_NAME à jour"
done

echo "----------------------------------------"
echo "🚀 Tous les manifests ont été mis à jour avec succès !"
