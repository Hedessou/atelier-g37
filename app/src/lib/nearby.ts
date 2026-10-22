import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// Module natif « G37Nearby » (plugins/g37-nearby) : échanges Bluetooth / Wi-Fi sans Internet.
export type NearbyPeer = { endpointId: string; name: string; connected: boolean };
export type NearbyInfo = { running: boolean; name: string | null; peers: NearbyPeer[]; sdk: number };
export type InboxFile = { path: string; kind: string; name: string; endpointId: string | null; peerName: string; receivedAt: number; size: number; meta?: Record<string, unknown> };

export interface G37NearbyPlugin {
  checkNearbyPermissions(): Promise<{ nearby: boolean; microphone: boolean }>;
  requestNearbyPermissions(opts?: { microphone?: boolean }): Promise<{ nearby: boolean; microphone: boolean }>;
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
  addListener(event: "peerFound" | "peerLost" | "connected" | "disconnected", cb: (e: { endpointId: string; name?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "message", cb: (e: { endpointId: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "file", cb: (e: InboxFile) => void): Promise<PluginListenerHandle>;
  addListener(event: "sent" | "audio" | "error", cb: (e: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
}

export const Nearby = registerPlugin<G37NearbyPlugin>("G37Nearby");

export const nearbyAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("G37Nearby");
