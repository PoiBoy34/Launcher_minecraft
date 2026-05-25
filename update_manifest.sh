#!/bin/bash

echo "Démarrage de la mise à jour des manifests..."

# On boucle sur chaque dossier présent dans modpacks/
for modpack_dir in modpacks/*/; do
  # Récupérer uniquement le nom du dossier (ex: Cobblemon)
  MODPACK_NAME=$(basename "$modpack_dir")
  
  echo "----------------------------------------"
  echo "📦 Traitement du modpack : $MODPACK_NAME"

  MODS_DIR="modpacks/$MODPACK_NAME/mods"
  MANIFEST_FILE="modpacks/$MODPACK_NAME/manifest.json"
  BASE_URL="https://raw.githubusercontent.com/PoiBoy34/Launcher_minecraft/main/modpacks/$MODPACK_NAME/mods"

  # Si le dossier mods n'existe pas, on passe au suivant
  if [ ! -d "$MODS_DIR" ]; then
    echo "⚠️ Aucun dossier 'mods' trouvé dans $MODPACK_NAME, on ignore."
    continue
  fi

  # Début du fichier JSON
  echo '{
  "version": "1.0.0",
  "files": [' > "$MANIFEST_FILE"

  # --- AJOUT MANUEL DES FICHIERS EXTERNES (RELEASES) ---
  if [ "$MODPACK_NAME" = "Cobblemon" ]; then
    echo '    {
      "name": "Cobblemon-fabric-1.7.3+1.21.1.jar",
      "url": "https://github.com/PoiBoy34/Launcher_minecraft/releases/download/METTRE_LE_NOM_DE_TA_RELEASE/Cobblemon-fabric-1.7.3+1.21.1.jar",
      "sha1": "METTRE_LE_VRAI_HASH_ICI"
    }' >> "$MANIFEST_FILE"
    FIRST_FILE=false # Le premier fichier est déjà écrit
  else
    FIRST_FILE=true
  fi
  # -----------------------------------------------------
  
  # Option bash pour éviter les erreurs si le dossier est vide
  shopt -s nullglob
  
  for filepath in "$MODS_DIR"/*.jar; do
    if [ -f "$filepath" ]; then
      filename=$(basename "$filepath")
      hash=$(sha1sum "$filepath" | awk '{print $1}')
      
      if [ "$FIRST_FILE" = true ]; then
        FIRST_FILE=false
      else
        echo "    ," >> "$MANIFEST_FILE"
      fi
      
      echo '    {
      "name": "'"$filename"'",
      "url": "'"$BASE_URL"'/'"$filename"'",
      "sha1": "'"$hash"'"
    }' >> "$MANIFEST_FILE"
      
      echo " -> Ajouté : $filename"
    fi
  done
  
  # Désactiver l'option nullglob
  shopt -u nullglob

  # Fin du fichier JSON
  echo '  ]
}' >> "$MANIFEST_FILE"

  echo "✅ Manifest à jour pour $MODPACK_NAME"
done

echo "----------------------------------------"
echo "🚀 Tous les modpacks ont été mis à jour avec succès !"
