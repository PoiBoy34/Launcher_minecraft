#!/bin/bash

# Configuration
MODPACK_NAME="survie"
MODS_DIR="modpacks/$MODPACK_NAME/mods"
MANIFEST_FILE="modpacks/$MODPACK_NAME/manifest.json"
BASE_URL="https://raw.githubusercontent.com/PoiBoy34/Launcher_minecraft/main/modpacks/$MODPACK_NAME/mods"

echo "Génération du manifest pour le modpack : $MODPACK_NAME..."

# Début du fichier JSON
echo '{
  "version": "1.0.0",
  "files": [' > "$MANIFEST_FILE"

# Compteur pour gérer la virgule du format JSON
FIRST_FILE=true

# Boucle sur tous les fichiers .jar
for filepath in "$MODS_DIR"/*.jar; do
  # Vérifier s'il y a bien des fichiers .jar
  if [ -f "$filepath" ]; then
    filename=$(basename "$filepath")
    
    # Calcul du SHA-1 (on ne garde que la première colonne)
    hash=$(sha1sum "$filepath" | awk '{print $1}')
    
    # Gestion de la virgule entre les blocs JSON
    if [ "$FIRST_FILE" = true ]; then
      FIRST_FILE=false
    else
      echo "    ," >> "$MANIFEST_FILE"
    fi
    
    # Écriture du bloc pour ce mod
    echo '    {
      "name": "'"$filename"'",
      "url": "'"$BASE_URL"'/'"$filename"'",
      "sha1": "'"$hash"'"
    }' >> "$MANIFEST_FILE"
    
    echo " -> Ajouté : $filename"
  fi
done

# Fin du fichier JSON
echo '  ]
}' >> "$MANIFEST_FILE"

echo "✅ Terminé ! Le fichier $MANIFEST_FILE est à jour."
