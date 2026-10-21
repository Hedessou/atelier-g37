#!/usr/bin/env bash
# Prépare le projet Android (régénéré à chaque fabrication) : numéro de version, icônes, Firebase.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BUNDLE_VERSION:?}"
NATIVE_CODE=$(node -p "require('./release.json').nativeVersionCode")

if [ ! -d android ]; then npx cap add android; fi

GRADLE=android/app/build.gradle
sed -i -E "s/versionCode [0-9]+/versionCode ${NATIVE_CODE}/" "$GRADLE"
sed -i -E "s/versionName \"[^\"]*\"/versionName \"${BUNDLE_VERSION}\"/" "$GRADLE"
grep -E "versionCode|versionName" "$GRADLE"

# Icônes et écran de démarrage à partir du dossier assets/
npx @capacitor/assets generate --android \
  --iconBackgroundColor '#0f1b2d' --iconBackgroundColorDark '#0f1b2d' \
  --splashBackgroundColor '#0f1b2d' --splashBackgroundColorDark '#0f1b2d'

# Firebase (notifications) si fourni
if [ -n "${GOOGLE_SERVICES_JSON:-}" ]; then
  printf '%s' "$GOOGLE_SERVICES_JSON" > android/app/google-services.json
  echo "google-services.json ajouté"
fi

npx cap sync android
