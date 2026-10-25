import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// Module natif « G37Nearby » (plugins/g37-nearby) : échanges Bluetooth / Wi-Fi sans Internet.
export type Medium = "nearby" | "wifi";
export type NearbyPeer = { endpointId: string; name: string; connected: boolean; medium?: Medium };
export type NearbyInfo = { running: boolean; name: string | null; peers: NearbyPeer[]; sdk: number; wifiLan?: boolean; always?: boolean; advertising?: boolean; discovering?: boolean };
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
export type SettingKey = "battery" | "fullScreen" | "notifications" | "bluetooth" | "location" | "installApps" | "app"
  | "wifi" | "hotspot" | "bluetoothSettings" | "autostart";

export interface G37NearbyPlugin {
  checkNearbyPermissions(): Promise<{ nearby: boolean; microphone: boolean }>;
  requestNearbyPermissions(opts?: { microphone?: boolean; camera?: boolean }): Promise<{ nearby: boolean; microphone: boolean; camera?: boolean }>;
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
