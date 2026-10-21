# Atelier G37 — application de maintenance

- `app/` : l'application Android (Vite + React + Capacitor). Fonctionne hors ligne, se synchronise et se met à jour toute seule.
- `supabase/functions/` : le serveur (fonctions `api` et `publish`).
- `.github/workflows/android.yml` : à chaque envoi sur `main`, fabrique l'APK signé et publie la mise à jour automatique.

Pour forcer la mise à jour du moteur Android (rare), augmenter `nativeVersionCode` dans `app/release.json`.
