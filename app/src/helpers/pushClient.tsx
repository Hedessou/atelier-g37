import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { postG37Push } from "../endpoints/g37/push_POST.schema";
import { PUSH_ENABLED } from "../lib/config";
import { isOnline, onOnlineChange } from "../lib/net";
import { nativeSoundsAvailable } from "../lib/nearby";
import { session } from "../lib/session";

// Notifications Android (Firebase). Même interface que l'ancienne version web :
// enablePush, disablePush, isPushOptedIn, onPushEnabledChange, onPushMessage.
const TOKEN_KEY = "g37.push.token";
const SYNCED_KEY = "g37.push.synced";

const enabledListeners = new Set<(on: boolean) => void>();
const messageListeners = new Set<(p: { title?: string; body?: string; data?: Record<string, string> }) => void>();
let listenersReady = false;

export const pushSupported = () => Capacitor.isNativePlatform() && PUSH_ENABLED;

export function isPushOptedIn(): boolean {
  try { return !!localStorage.getItem(TOKEN_KEY); } catch { return false; }
}

export function onPushEnabledChange(cb: (on: boolean) => void) {
  enabledListeners.add(cb);
  return () => { enabledListeners.delete(cb); };
}

export function onPushMessage(cb: (p: { title?: string; body?: string; data?: Record<string, string> }) => void) {
  messageListeners.add(cb);
  return () => { messageListeners.delete(cb); };
}

// Le jeton est renvoyé à chaque lancement et après chaque connexion (il est lié au compte connecté) :
// un téléphone qui a changé de compte ou dont le serveur a oublié le jeton recevra quand même appels et alertes.
let syncedThisRun: string | null = null;
async function sendTokenToServer() {
  const token = localStorage.getItem(TOKEN_KEY);
  // « android3 » : le téléphone fait sonner lui-même (sonnerie choisie, écran d'appel même app fermée).
  const platform = (await nativeSoundsAvailable()) ? "android3" : "android";
  const synced = `${platform}:${token}:${session.user()?.id ?? ""}`;
  if (!token || !session.token() || syncedThisRun === synced || !isOnline()) return;
  try {
    await postG37Push({ op: "save", token, platform });
    syncedThisRun = synced;
    localStorage.setItem(SYNCED_KEY, synced);
  } catch (e) {
    console.warn("Jeton de notification non envoyé (nouvel essai au retour du réseau)", e);
  }
}

async function setupListeners() {
  if (listenersReady || !pushSupported()) return;
  listenersReady = true;
  await PushNotifications.createChannel({
    id: "g37_alertes", name: "Alertes de l'atelier", description: "Pannes, échéances, messages",
    importance: 5, visibility: 1, sound: "default", vibration: true, lights: true,
  }).catch(() => {});
  await PushNotifications.addListener("registration", (t) => {
    localStorage.setItem(TOKEN_KEY, t.value);
    enabledListeners.forEach((l) => l(true));
    void sendTokenToServer();
  });
  await PushNotifications.addListener("pushNotificationReceived", (n) => {
    const data = (n.data ?? {}) as Record<string, string>;
    messageListeners.forEach((l) => l({ title: n.title ?? data.title, body: n.body ?? data.body, data }));
  });
  await PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
    const tab = (a.notification.data as Record<string, string> | undefined)?.tab;
    if (tab) window.dispatchEvent(new CustomEvent("g37:open-tab", { detail: tab }));
  });
  onOnlineChange((on) => { if (on) void sendTokenToServer(); });
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("Notifications non disponibles sur cet appareil.");
  await setupListeners();
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") throw new Error("Notifications refusées.");
  await PushNotifications.register();
}

export async function disablePush(): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SYNCED_KEY);
  enabledListeners.forEach((l) => l(false));
  if (token && isOnline()) await postG37Push({ op: "remove", token }).catch(() => {});
  if (pushSupported()) await PushNotifications.unregister().catch(() => {});
}

// Au démarrage : si les notifications étaient activées, on se réabonne (le jeton peut changer).
export async function restorePush() {
  if (!pushSupported() || !isPushOptedIn()) return;
  try {
    await setupListeners();
    const perm = await PushNotifications.checkPermissions();
    if (perm.receive === "granted") await PushNotifications.register();
  } catch (e) {
    console.warn("Notifications non rétablies", e);
  }
}

export function pushTokenForLogout(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

// Après chaque connexion : jeton renvoyé, ou notifications activées automatiquement la première fois
// (sinon les appels et messages n'arrivent pas app fermée).
let autoPushTried = false;
export function installPushAutoSync() {
  if (!pushSupported()) return;
  session.onChange((user) => {
    if (!user) { syncedThisRun = null; return; }
    if (isPushOptedIn()) void sendTokenToServer();
    else if (!autoPushTried) { autoPushTried = true; void enablePush().catch(() => {}); }
  });
}
