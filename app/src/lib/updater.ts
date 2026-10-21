import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import { AppUpdate, AppUpdateAvailability } from "@capawesome/capacitor-app-update";
import { BUNDLE_VERSION } from "./config";
import { isOnline, onOnlineChange } from "./net";
import { openExternal } from "./links";

// ---------------------------------------------------------------------------
// Mises à jour automatiques
// - Contenu de l'app (écrans, corrections) : téléchargé en arrière-plan dès qu'il y a Internet,
//   appliqué tout seul au prochain démarrage (ou tout de suite avec le bouton « Redémarrer »).
// - Moteur Android (rare) : via le Play Store si l'app vient du Play Store, sinon téléchargement de l'APK.
// ---------------------------------------------------------------------------

export type UpdateStatus =
  | { kind: "none" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string; bundleId: string; notes: string | null }
  | { kind: "native"; required: boolean; apkUrl: string | null; viaStore: boolean; notes: string | null };

type VersionInfo = {
  bundleVersion: string | null; bundleUrl: string | null; bundleChecksum: string | null;
  nativeVersionCode: number | null; minNativeVersionCode: number | null; apkUrl: string | null; notes: string | null;
};

let status: UpdateStatus = { kind: "none" };
const listeners = new Set<(s: UpdateStatus) => void>();
const setStatus = (s: UpdateStatus) => { status = s; listeners.forEach((l) => l(s)); };
export const getUpdateStatus = () => status;
export function onUpdateStatus(l: (s: UpdateStatus) => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

let lastCheck = 0;
let checking = false;

async function checkForUpdates(force = false) {
  if (!Capacitor.isNativePlatform() || !isOnline() || checking) return;
  if (!force && Date.now() - lastCheck < 20 * 60 * 1000) return;
  checking = true;
  lastCheck = Date.now();
  try {
    const res = await fetch("/_api/app/version");
    if (!res.ok) return;
    const v = (await res.json()) as VersionInfo;
    const info = await App.getInfo();
    const build = Number(info.build) || 0;

    // 1. Nouvelle version du moteur Android ?
    if (v.nativeVersionCode && build < v.nativeVersionCode) {
      const required = !!v.minNativeVersionCode && build < v.minNativeVersionCode;
      let viaStore = false;
      try {
        const store = await AppUpdate.getAppUpdateInfo();
        viaStore = store.updateAvailability === AppUpdateAvailability.UPDATE_AVAILABLE;
      } catch {
        // App installée hors Play Store (APK partagé).
      }
      setStatus({ kind: "native", required, apkUrl: v.apkUrl, viaStore, notes: v.notes });
      if (required) return; // le contenu récent peut exiger le nouveau moteur
    }

    // 2. Nouveau contenu de l'app ?
    const current = await CapacitorUpdater.current();
    const running = current.bundle.version === "builtin" ? BUNDLE_VERSION : current.bundle.version;
    if (!v.bundleVersion || !v.bundleUrl || v.bundleVersion === running) return;
    const { bundles } = await CapacitorUpdater.list();
    let bundle = bundles.find((b) => b.version === v.bundleVersion && b.status !== "error");
    if (!bundle) {
      setStatus({ kind: "downloading", version: v.bundleVersion });
      bundle = await CapacitorUpdater.download({ url: v.bundleUrl, version: v.bundleVersion, checksum: v.bundleChecksum ?? undefined });
    }
    // Appliquée automatiquement au prochain démarrage de l'app.
    await CapacitorUpdater.next({ id: bundle.id });
    setStatus({ kind: "ready", version: v.bundleVersion, bundleId: bundle.id, notes: v.notes });
  } catch (e) {
    console.warn("Vérification des mises à jour impossible :", e);
    if (status.kind === "downloading") setStatus({ kind: "none" });
  } finally {
    checking = false;
  }
}

export async function initUpdater() {
  if (!Capacitor.isNativePlatform()) return;
  // Indique que cette version démarre correctement (sinon retour automatique à la précédente).
  await CapacitorUpdater.notifyAppReady().catch(() => {});
  void checkForUpdates(true);
  onOnlineChange((on) => { if (on) void checkForUpdates(); });
  App.addListener("resume", () => void checkForUpdates());
  setInterval(() => void checkForUpdates(), 60 * 60 * 1000);
}

// Redémarre tout de suite sur la nouvelle version.
export async function applyUpdateNow() {
  if (status.kind === "ready") await CapacitorUpdater.set({ id: status.bundleId });
}

// Lance la mise à jour du moteur Android.
export async function installNativeUpdate() {
  if (status.kind !== "native") return;
  if (status.viaStore) {
    try {
      await AppUpdate.performImmediateUpdate();
      return;
    } catch {
      await AppUpdate.openAppStore().catch(() => {});
      return;
    }
  }
  if (status.apkUrl) await openExternal(status.apkUrl);
}
