# Reprise du projet Atelier G37 dans une nouvelle conversation

Coller ce message dans la nouvelle conversation, avec ce fichier zip en pièce jointe :

> Projet Atelier G37 (app Android de maintenance, hors Floot). Le code complet est dans le zip joint
> (dépôt git prêt, branche main). Dézippe-le, relie le dépôt GitHub Hedessou/atelier-g37 (accès push),
> pousse le code, puis configure les secrets GitHub ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD
> (depuis le zip « atelier-g37-cle-signature.zip » que je joins aussi) et PUBLISH_KEY
> (valeur dans la table app_config, clé 'publish.key', projet Supabase yrtoimldmzlnmsoapcij).
> Lance la fabrication de l'APK (workflow .github/workflows/android.yml), corrige les erreurs et envoie-moi l'APK.

## État
- Serveur : Supabase yrtoimldmzlnmsoapcij (fonctions « api » et « publish » déployées, données migrées).
- App : `app/` (Vite + React 19 + Capacitor 7), hors ligne + synchronisation + mises à jour automatiques.
- Encore à fournir : clé Gemini (GEMINI_API_KEY), Firebase (FIREBASE_SERVICE_ACCOUNT + secret GitHub GOOGLE_SERVICES_JSON),
  clé SasPay (SASPAY_SECRET_KEY). Fonction temporaire « migration-import » à désactiver après bascule.
