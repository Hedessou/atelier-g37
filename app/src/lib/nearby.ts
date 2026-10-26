import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// Module natif « G37Nearby » (plugins/g37-nearby) : échanges Bluetooth / Wi-Fi sans Internet.
export type Medium = "nearby" | "wifi";
export type NearbyPeer = { endpointId: string; name: string; connected: boolean; medium?: Medium };
export type NearbyInfo = {
  running: boolean; name: string | null; peers: NearbyPeer[]; sdk: number; wifiLan?: boolean; always?: boolean; advertising?: boolean; discovering?: boolean;
  native?: number; errors?: NearbyError[]; hotspot?: HotspotState;
};
export type InboxFile = { path: string; kind: string; name: string; endpointId: string | null; peerName: string; receivedAt: number; size: number; medium?: Medium; meta?: Record<string, unknown> };

export type LaunchCall = {
  room: string; name?: string; from?: string; action?: "ring" | "answer"; group?: boolean;
  // Appel sans Internet repris depuis la notification : « proche » (Bluetooth) ou « wifi » (réseau local).
  via?: "internet" | "proche" | "wifi"; endpoint?: string; mode?: string; video?: boolean;
};
export type LaunchData = { tab?: string; peer?: string; segment?: string; call?: LaunchCall };
export type RingingCall = { endpointId: string; callId: string; from: number; name: string; video: boolean; mode: string; at: number };
export type NetworkStatus = {
  wifiOn: boolean; wifiConnected: boolean; wifiInternet: boolean; ssid: string | null; hotspot: boolean; mobileData: boolean;
  addresses: string[]; manufacturer: string; model: string; lanRunning: boolean; always: boolean;
};
export type SystemStatus = {
  sdk: number; notifications: boolean; fullScreen: boolean; battery: boolean; bluetooth: boolean; location: boolean; locationNeeded: boolean;
  nearby: boolean; microphone: boolean; installApps: boolean; camera?: boolean; always?: boolean; manufacturer?: string;
};
// APK 5 : réseau Wi-Fi créé par le téléphone, erreurs récentes de liaison.
export type HotspotState = {
  supported: boolean; hosting: boolean; ssid: string | null; password: string | null; security: number;
  joined: boolean; joinedSsid: string | null; error?: string; message?: string;
};
export type HotspotInvite = { ssid: string; password: string | null; security: number; from: number };
export type NearbyError = { where: string; code: number; message: string; at: number; peer: string | null };
export type SettingKey = "battery" | "fullScreen" | "notifications" | "bluetooth" | "location" | "installApps" | "app"
  | "wifi" | "hotspot" | "bluetoothSettings" | "autostart";

export interface G37NearbyPlugin {
  checkNearbyPermissions(): Promise<{ nearby: boolean; microphone: boolean }>;
  requestNearbyPermissions(opts?: { microphone?: boolean; camera?: boolean; location?: boolean }): Promise<{ nearby: boolean; microphone: boolean; camera?: boolean; location?: boolean }>;
  start(opts: { name: string }): Promise<NearbyInfo>;
  stop(): Promise<void>;
  getInfo(): Promise<NearbyInfo>;
  setBackground(opts: { enabled: boolean; intervalMinutes?: number }): Promise<void>;
  broadcastPacket(): Promise<void>;
  sendPacket(opts: { endpointId: string }): Promise<void>;
  sendFile(opts: { endpointId: string; path: string; kind: string; name?: string }): Promise<void>;
  sendMessage(opts: { endpointId: string; data: string }): Promise<void>;
  listInbox(): Promise<{ files: InboxFile[] }>;
  deleteFile(opts: { path: string }): Promise<void>;
  sha256(opts: { path: string }): Promise<{ hex: string; size: number }>;
  serveFile(opts: { path: string; name?: string }): Promise<{ url: string }>;
  installApk(opts: { path: string }): Promise<{ started?: boolean; needsPermission?: boolean }>;
  startAudio(opts: { endpointId: string }): Promise<void>;
  stopAudio(): Promise<void>;
  setMuted(opts: { muted: boolean }): Promise<void>;
  setSpeaker(opts: { on: boolean }): Promise<void>;
  consumeLaunch(): Promise<{ launch?: LaunchData; declined?: string; ringing?: RingingCall }>;
  setSoundPrefs(opts: { alert?: string; message?: string; call?: string; loud?: boolean }): Promise<void>;
  playSound(opts: { name: string; loop?: boolean; usage?: "ringtone" | "alarm" | "notification" }): Promise<void>;
  stopSound(): Promise<void>;
  setAudioRoute(opts: { speaker: boolean }): Promise<void>;
  resetAudio(): Promise<void>;
  getSystemStatus(): Promise<SystemStatus>;
  openSystemSetting(opts: { which: SettingKey }): Promise<void>;
  // APK 4
  setReachable(opts: { enabled: boolean }): Promise<NearbyInfo>;
  getNetworkStatus(): Promise<NetworkStatus>;
  setInCall(opts: { active: boolean; title?: string }): Promise<void>;
  setProximity(opts: { on: boolean }): Promise<void>;
  cancelCallNotification(opts?: { callId?: string }): Promise<void>;
  // APK 5
  quickConnect(opts: { name?: string }): Promise<NearbyInfo>;
  getHotspot(): Promise<HotspotState>;
  startHotspot(): Promise<HotspotState>;
  stopHotspot(): Promise<HotspotState>;
  joinHotspot(opts: { ssid: string; password?: string; security?: number }): Promise<HotspotState>;
  leaveHotspot(): Promise<HotspotState>;
  addListener(event: "hotspot", cb: (e: HotspotState) => void): Promise<PluginListenerHandle>;
  addListener(event: "launch", cb: (e: LaunchData) => void): Promise<PluginListenerHandle>;
  addListener(event: "peerFound" | "peerLost" | "connected" | "disconnected", cb: (e: { endpointId: string; name?: string; medium?: Medium }) => void): Promise<PluginListenerHandle>;
  addListener(event: "message", cb: (e: { endpointId: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "file", cb: (e: InboxFile) => void): Promise<PluginListenerHandle>;
  addListener(event: "sent" | "audio" | "error", cb: (e: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
}

export const Nearby = registerPlugin<G37NearbyPlugin>("G37Nearby");

export const nearbyAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("G37Nearby");

// Fonctions apparues avec l'APK 3 (sonneries, écran d'appel app fermée, réglages du téléphone).
let nativeV3: boolean | null = null;
export async function nativeSoundsAvailable(): Promise<boolean> {
  if (!nearbyAvailable()) return false;
  if (nativeV3 !== null) return nativeV3;
  try { await Nearby.getSystemStatus(); nativeV3 = true; } catch { nativeV3 = false; }
  return nativeV3;
}

// Fonctions apparues avec l'APK 4 (Wi-Fi local, appels vidéo, toujours joignable sans Internet).
let nativeV4: boolean | null = null;
export async function nativeV4Available(): Promise<boolean> {
  if (!nearbyAvailable()) return false;
  if (nativeV4 !== null) return nativeV4;
  try { await Nearby.getNetworkStatus(); nativeV4 = true; } catch { nativeV4 = false; }
  return nativeV4;
}

export const isWifiEndpoint = (endpointId: string | null | undefined) => !!endpointId && endpointId.startsWith("lan:");

// Fonctions apparues avec l'APK 5 (liaison Bluetooth fiable, réseau Wi-Fi créé par le téléphone).
let nativeV5: boolean | null = null;
export async function nativeV5Available(): Promise<boolean> {
  if (!nearbyAvailable()) return false;
  if (nativeV5 !== null) return nativeV5;
  try { await Nearby.getHotspot(); nativeV5 = true; } catch { nativeV5 = false; }
  return nativeV5;
}

// Erreur de liaison expliquée simplement (guide de connexion).
export function explainNearbyError(e: NearbyError, fr: boolean, nameFor?: (userId: number) => string | null | undefined): string {
  const t = (a: string, b: string) => (fr ? a : b);
  const uid = /^G37:(\d+):/.exec(e.peer ?? "")?.[1];
  const who = e.peer ? ` (${(uid && nameFor?.(Number(uid))) || t("collègue", "colleague")})` : "";
  switch (e.code) {
    case -2: return t(`Le collègue n'a pas répondu${who} : nouvel essai automatique.`, `No answer from colleague${who}: retrying automatically.`);
    case 8004: return t(`Liaison refusée${who} : nouvel essai automatique.`, `Link refused${who}: retrying.`);
    case 8007: return t("Bluetooth occupé ou en erreur : éteins puis rallume le Bluetooth.", "Bluetooth busy or failing: turn Bluetooth off and on.");
    case 8011: return t(`Collègue hors de portée${who}.`, `Colleague out of range${who}.`);
    case 8012: return t(`Liaison coupée pendant l'établissement${who} : nouvel essai automatique.`, `Link dropped while connecting${who}: retrying.`);
    case 8009: case 8008: return t("Recherche déjà en cours : appuie sur « Relancer la recherche ».", "Search already running: tap “Restart search”.");
    case 13: return t(`Échec de la liaison${who} : nouvel essai automatique. Si cela dure, éteins puis rallume le Bluetooth sur les deux téléphones.`, `Link failed${who}: retrying. If it persists, turn Bluetooth off and on on both phones.`);
    default:
      if (e.code >= 8030 && e.code <= 8040) return t("Autorisation manquante : appuie sur « Autoriser ».", "Missing permission: tap “Allow”.");
      return t(`Erreur ${e.code}${who}${e.message ? ` — ${e.message}` : ""}`, `Error ${e.code}${who}${e.message ? ` — ${e.message}` : ""}`);
  }
}
