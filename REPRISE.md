# Reprise du projet Atelier G37 — texte à donner à l'autre IA

Copie tout le bloc ci-dessous dans la nouvelle conversation, avec le zip `atelier-g37-v2.zip` en pièce jointe
(et `atelier-g37-cle-signature.zip` si tu dois signer l'APK sur GitHub).

---

> **Projet Atelier G37** : application Android de maintenance d'atelier (Vite + React 19 + Capacitor 7), serveur Supabase
> projet `yrtoimldmzlnmsoapcij`. Je ne code pas : fais le travail toi-même et explique-moi simplement.
> Le code complet est dans le zip joint (dépôt git, branche `main`). Lis d'abord le fichier `REPRISE.md` à la racine,
> section « État technique », puis fais la liste « Ce qu'il reste à faire » dans l'ordre.

---

## Ce que contient cette version (2.0, versionCode natif 2)

1. **Mode sans Internet** : les téléphones se trouvent et se connectent seuls par Bluetooth / Wi-Fi
   (Google Nearby Connections), échangent l'état de l'atelier, les actions faites hors ligne, les messages privés
   et les mises à jour de l'app. Recherche en fond toutes les 2 h (rafale de 2 min), redémarre au démarrage du téléphone.
2. **Messagerie** : le groupe s'appelle « Maintenance R/F » ; chacun peut écrire en privé à n'importe quel membre
   (messages chiffrés de bout en bout, transmissibles hors ligne de téléphone en téléphone).
3. **Appels** : par Internet (WebRTC) ou à proximité sans Internet (audio direct par Bluetooth / Wi-Fi).
4. **Mises à jour sans Internet** : un téléphone à jour transmet le paquet (bundle) ou l'APK aux autres,
   vérifié par une empreinte signée par le serveur.
5. **Nouveau look « A — Atelier de nuit »** : bleu nuit `#0f1b2d`, accent ambre `#f59e0b`, polices IBM Plex Sans/Mono,
   barre de navigation en bas (Accueil, Machines, Pannes, Messages, Plus).
6. **Paiements supprimés** : IA et calculs illimités, IA = Google Gemini (clé dans `app_config`, clé `gemini.api_key`).

## État technique

### Serveur (Supabase `yrtoimldmzlnmsoapcij`)
- Fonction Edge **`api`** (Deno, `verify_jwt: false`). Code source : `supabase/functions/api/` (22 fichiers + `deno.json`).
  - **Déploiement : envoyer TOUS les fichiers du dossier en UN SEUL appel**, sinon « Module not found ».
  - Ne jamais redéployer une ancienne copie de `api` : la version du dépôt est la bonne (v3 : P2P, messages privés, appels, Gemini).
  - Nouvelles routes : `POST g37/device`, `GET g37/secrets`, `POST g37/relay`, `GET g37/dms`, `POST g37/call_signal`.
  - `GET g37/state` renvoie un en-tête `x-g37-sig` (signature ECDSA du serveur) ; `GET version` renvoie `manifest` + `manifestSig`.
- Fonction **`publish`** (v2) : reçoit les fabrications de GitHub Actions (accepte `apkChecksum`).
- Tables ajoutées : `user_devices`, `dm_messages`, `call_log` (RLS activé, accès seulement via la fonction).
- Clés dans la table `app_config` (ne pas les afficher) : `firebase.service_account`, `gemini.api_key`, `cron.key`,
  `publish.key`, et générées automatiquement : `p2p.sign_priv`, `p2p.group_key`, `call.secret`.
  Optionnel : `call.ice` = liste JSON de serveurs STUN/TURN pour les appels Internet sur réseau mobile.
- Notifications push : FCM v1 opérationnel côté serveur (test `POST push/selftest` → tokenOk:true).

### Application (`app/`)
- Plugin natif maison : `app/plugins/g37-nearby/` (Java, package `com.atelierg37.nearby`), déclaré dans
  `app/package.json` comme `"g37-nearby": "file:plugins/g37-nearby"` → pris en compte par `npm install` + `npx cap sync`.
- Fichiers JS principaux : `src/lib/p2p.ts`, `src/lib/crypto.ts`, `src/lib/dms.ts`, `src/lib/calls.ts`, `src/lib/offline.ts`,
  `src/components/P2PBridge.tsx`, `MessagesView.tsx`, `CallOverlay.tsx`, `G37App.tsx`.
- Vérification faite ici : syntaxe de tous les fichiers TS/TSX (esbuild) + imports locaux OK.
  **Pas encore fait : `npm install`, typecheck complet (`npx tsc --noEmit`), compilation Android.** Il y aura peut-être
  de petites erreurs de types ou de Java à corriger.
- `app/release.json` : `nativeVersionCode` 2, `minNativeVersionCode` 2 (tout le monde devra installer le nouvel APK).
- Notifications : il faut `google-services.json` (projet Firebase `atelier-g37-63c6c`) soit en secret GitHub
  `GOOGLE_SERVICES_JSON`, soit en fichier `app/google-services.json` (le script `app/scripts/prepare-android.sh` le copie).

## Ce qu'il reste à faire (dans l'ordre)

1. ✅ FAIT le 22/10/2026 : la fonction `api` v3 est déployée et testée (secrets, état signé + signature vérifiée,
   enregistrement d'un téléphone, messages privés, appels → toutes les routes répondent). Rien à refaire côté serveur.
   Reste du test : une ligne `user_devices` « d_testv3_000001 » (utilisateur de test 31) à supprimer.
2. `cd app && npm install && npx tsc --noEmit` → corriger les erreurs de types éventuelles.
3. `npm run build`, puis `BUNDLE_VERSION=2.0.0 bash scripts/prepare-android.sh`, puis compiler :
   `cd android && ./gradlew assembleRelease` (Termux) ou pousser sur GitHub (workflow `.github/workflows/android.yml`,
   secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `PUBLISH_KEY` = `app_config.publish.key`, `GOOGLE_SERVICES_JSON`).
   Corriger les erreurs Java du plugin si besoin (fusion du manifeste, versions `play-services-nearby` 19.3.0, Java 21).
4. Tester sur 2 téléphones : autorisations au premier lancement, connexion automatique sans Internet (mode avion + Bluetooth),
   message privé, appel à proximité, appel Internet, IA Gemini, mise à jour transmise d'un téléphone à l'autre.
5. Publier (le workflow appelle la fonction `publish`) : tous les téléphones reçoivent la mise à jour.
6. Ménage : désactiver la fonction temporaire `migration-import` ; supprimer l'utilisateur de test n°31.


## Version 3 (23/10/2026) — Spinning R/F
- En-tête « Spinning R/F » + nom de l'utilisateur en petit ; bouton profil (photo) en haut à droite.
- Menu Plus : Profil (nom, prénom, poste, photo → stockage « avatars »), Paramètres, Déconnexion.
- Paramètres : sonneries d'appel / alertes / messages (fichiers `app/plugins/g37-nearby/android/src/main/res/raw/*.ogg`),
  « son fort » (volume réveil), autorisations importantes (notifications, appareils à proximité, micro, Bluetooth,
  localisation, écran d'appel plein écran Android 14, batterie sans restriction, installation des mises à jour),
  fréquence de vérification sans Internet (15/30/60/120 min, défaut 30), état de synchro de chaque collègue, langue.
- Notifications : les téléphones v3 s'enregistrent en `android3` ; le serveur leur envoie des messages « données seules »
  et le service natif `G37MessagingService` affiche lui-même la notification avec la sonnerie choisie (app fermée),
  et un écran d'appel plein écran qui sonne en boucle (FLAG_INSISTENT) avec Répondre / Refuser.
  Le script `app/scripts/prepare-android.sh` retire le service Firebase de Capacitor du manifeste (sinon conflit).
- Appels : salles d'appel serveur (`POST g37/call_room`, `GET g37/call_rooms`, tables `call_rooms`, `call_room_members`),
  à deux ou en groupe jusqu'à 25 (WebRTC maillé, audio seul), rejoindre un appel en cours, ajouter des collègues,
  haut-parleur et muet pour tous les appels. Sans Internet : appel à deux seulement (Bluetooth / Wi-Fi).
- Serveur `api` v4 déployé et vérifié (23 fichiers identiques au dossier `supabase/functions/api`).
- `app/release.json` : versionCode natif 3, minimum 3 (tout le monde doit installer l'APK 3).

## Limites à connaître
- Chaque collègue doit ouvrir **une fois** la nouvelle version avec Internet pour enregistrer son téléphone
  (sinon il ne peut pas recevoir de messages privés ni faire porter ses actions par un autre).
- Portée Bluetooth / Wi-Fi direct : quelques dizaines de mètres.
- Android affiche une notification permanente « Synchronisation de l'atelier » (obligatoire pour le travail en fond).
- Installer un APK reçu d'un collègue demande un appui (« Installer ») et l'autorisation « sources inconnues ».
- Appels Internet entre réseaux mobiles : peut nécessiter un serveur TURN (`app_config` clé `call.ice`).
- Appel de groupe à 25 : chaque téléphone envoie sa voix à chacun (pas de serveur audio) ; au-delà de ~10 personnes
  sur réseau mobile faible, la qualité baisse. Solution plus tard : serveur audio (SFU, ex. LiveKit).
- Le code Java/Android n'a pas pu être compilé ici (pas d'outils Android) : la compilation GitHub peut signaler
  une petite erreur à corriger.
