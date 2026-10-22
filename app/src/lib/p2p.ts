import superjson from "superjson";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import { g37 } from "../helpers/g37";
import { getDevice, openPacket, sealPacket, signText, toB64, fromB64, verifyText, deviceIdSync } from "./crypto";
import {
  addRelayOps, dropFromOutbox, loadCachedState, onOutboxChange, onRelayChange, outbox, relayOps, removeRelayOps,
  saveCachedState, setOutboxSignatures, type RelayOp,
} from "./offline";
import { isOnline } from "./net";
import { Nearby, nearbyAvailable, type InboxFile } from "./nearby";

// ---------------------------------------------------------------------------
// Mode « sans Internet » : les téléphones proches (Bluetooth / Wi-Fi) s'échangent automatiquement
//  - les dernières données de l'atelier signées par le serveur (la plus récente gagne),
//  - les actions faites hors ligne (signées par leur auteur), portées au serveur par le premier qui a Internet,
//  - les messages privés (chiffrés pour leur destinataire),
//  - les mises à jour de l'app (vérifiées avec l'empreinte signée par le serveur).
// ---------------------------------------------------------------------------

type Listener<T> = (v: T) => void;
function bus<T>() {
  const ls = new Set<Listener<T>>();
  return {
    on(l: Listener<T>) { ls.add(l); return () => { ls.delete(l); }; },
    emit(v: T) { ls.forEach((l) => { try { l(v); } catch (e) { console.warn(e); } }); },
  };
}

export const stateAdopted = bus<State>();
export const peersChanged = bus<Peer[]>();
export const dmFromRelay = bus<{ opPayload: RelayOp }>();
export const callMessage = bus<{ endpointId: string; userId: number | null; msg: Record<string, unknown> }>();
export const p2pStatus = bus<P2PStatus>();
export const updateFromPeer = bus<{ kind: "bundle" | "apk"; path: string; version: string; notes: string | null }>();

export type P2PStatus = { available: boolean; needsPermission: boolean; running: boolean; lastExchange: number | null };
let status: P2PStatus = { available: false, needsPermission: false, running: false, lastExchange: null };
const setStatus = (patch: Partial<P2PStatus>) => { status = { ...status, ...patch }; p2pStatus.emit(status); };
export const getP2PStatus = () => status;

// ---------- Secrets (donnés par le serveur quand on a Internet) ----------
export type Secrets = { p2pKey: string | null; callTopic: string; serverSignJwk: JsonWebKey; iceServers: RTCIceServer[] };
const SECRETS_KEY = "g37.secrets";
export function getSecrets(): Secrets | null {
  try {
    const raw = localStorage.getItem(SECRETS_KEY);
    return raw ? (JSON.parse(raw) as Secrets) : null;
  } catch {
    return null;
  }
}
export async function refreshSecrets(): Promise<Secrets | null> {
  if (!isOnline()) return getSecrets();
  try {
    const res = await fetch("/_api/g37/secrets");
    if (!res.ok) return getSecrets();
    const s = (await res.json()) as Secrets;
    localStorage.setItem(SECRETS_KEY, JSON.stringify(s));
    return s;
  } catch {
    return getSecrets();
  }
}

// Enregistre les clés publiques de ce téléphone (une fois par compte et par téléphone).
export async function registerDevice(userId: number): Promise<void> {
  if (!isOnline()) return;
  const d = await getDevice();
  const flag = `${userId}:${d.deviceId}`;
  if (localStorage.getItem("g37.deviceReg") === flag) return;
  try {
    const res = await fetch("/_api/g37/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: d.deviceId, signJwk: d.signPub, encJwk: d.encPub, label: navigator.userAgent.slice(0, 110) }),
    });
    if (res.ok) localStorage.setItem("g37.deviceReg", flag);
  } catch {
    // nouvel essai au prochain retour du réseau
  }
}

export function clearP2PData() {
  ["g37.secrets", "g37.snap", "g37.manifest", "g37.deviceReg", "g37.share", "g37.relay"].forEach((k) => localStorage.removeItem(k));
}

// ---------- Données signées par le serveur ----------
type Signed = { text: string; sig: string };
type Snap = Signed & { serverTime: string };
const SNAP_KEY = "g37.snap";
const getSnap = (): Snap | null => { try { const r = localStorage.getItem(SNAP_KEY); return r ? (JSON.parse(r) as Snap) : null; } catch { return null; } };

const tsOf = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

// Appelé après chaque chargement depuis le serveur.
export function noteServerState(state: State, text: string, sig: string | null) {
  if (sig) {
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify({ text, sig, serverTime: new Date(state.serverTime ?? Date.now()).toISOString() }));
    } catch {
      // place insuffisante : la synchro de proche en proche attendra
    }
  }
  pruneApplied(state.appliedOpIds ?? []);
  schedulePacket();
}

function pruneApplied(ids: string[]) {
  if (!ids.length) return;
  const set = new Set(ids);
  dropFromOutbox(set);
  removeRelayOps(set);
}

async function adoptSnapshot(s: Signed, myId: number): Promise<boolean> {
  const secrets = getSecrets();
  if (!secrets?.serverSignJwk || !(await verifyText(secrets.serverSignJwk, s.text, s.sig))) return false;
  let peerState: State;
  try {
    peerState = superjson.parse<State>(s.text);
  } catch {
    return false;
  }
  const mine = getSnap();
  if (mine && tsOf(peerState.serverTime) <= tsOf(mine.serverTime)) return false;
  // Les données d'un poste à accès limité sont incomplètes : on ne les adopte pas.
  if (!(peerState.me.role === "admin" || g37.visibleTabs(peerState.me) === null)) return false;
  const current = loadCachedState();
  const me = peerState.users.find((u) => u.id === myId) ?? current?.me;
  if (!me) return false;
  const adopted: State = { ...peerState, me };
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({ text: s.text, sig: s.sig, serverTime: new Date(peerState.serverTime ?? 0).toISOString() }));
  } catch { /* place insuffisante */ }
  saveCachedState(adopted);
  pruneApplied(adopted.appliedOpIds ?? []);
  stateAdopted.emit(adopted);
  return true;
}

// ---------- Versions de l'app (mises à jour de proche en proche) ----------
export type Manifest = {
  bundleVersion: string | null; bundleChecksum: string | null; nativeVersionCode: number | null; minNativeVersionCode: number | null;
  apkChecksum: string | null; notes: string | null; issuedAt: string;
};
const MANIFEST_KEY = "g37.manifest";
const SHARE_KEY = "g37.share";
type Share = { bundle?: { version: string; path: string }; apk?: { code: number; path: string } };
const getShare = (): Share => { try { return JSON.parse(localStorage.getItem(SHARE_KEY) ?? "{}") as Share; } catch { return {}; } };
const setShare = (s: Share) => localStorage.setItem(SHARE_KEY, JSON.stringify(s));
export function getManifestSigned(): Signed | null {
  try { const r = localStorage.getItem(MANIFEST_KEY); return r ? (JSON.parse(r) as Signed) : null; } catch { return null; }
}
export function getManifest(): Manifest | null {
  const s = getManifestSigned();
  try { return s ? (JSON.parse(s.text) as Manifest) : null; } catch { return null; }
}

export const cmpVersion = (a: string | null | undefined, b: string | null | undefined) => {
  const pa = String(a ?? "0").split(".").map((x) => Number(x) || 0);
  const pb = String(b ?? "0").split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
const newerManifest = (a: Manifest, b: Manifest | null) =>
  !b || cmpVersion(a.bundleVersion, b.bundleVersion) > 0 || (a.nativeVersionCode ?? 0) > (b.nativeVersionCode ?? 0);

async function storeManifest(s: Signed): Promise<Manifest | null> {
  const secrets = getSecrets();
  if (!secrets?.serverSignJwk || !(await verifyText(secrets.serverSignJwk, s.text, s.sig))) return null;
  let m: Manifest;
  try { m = JSON.parse(s.text) as Manifest; } catch { return null; }
  if (newerManifest(m, getManifest())) {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(s));
    schedulePacket();
  }
  return m;
}

// Versions qui tournent sur ce téléphone (renseignées par lib/updater.ts).
let running = { bundle: "0", build: 0 };
export function setRunningVersions(v: { bundle: string; build: number }) { running = v; }

// Appelé par lib/updater.ts après lecture de la version sur le serveur (avec Internet).
export async function noteServerVersion(v: { manifest?: string; manifestSig?: string; bundleUrl: string | null; apkUrl: string | null }, onWifi: boolean) {
  if (!v.manifest || !v.manifestSig) return;
  const m = await storeManifest({ text: v.manifest, sig: v.manifestSig });
  if (!m || !nearbyAvailable()) return;
  // On garde une copie pour la donner aux collègues sans Internet.
  const share = getShare();
  try {
    if (m.bundleVersion && v.bundleUrl && share.bundle?.version !== m.bundleVersion) {
      const path = "g37p2p/share/bundle.zip";
      await Filesystem.downloadFile({ url: v.bundleUrl, path, directory: Directory.Data, recursive: true });
      const h = await Nearby.sha256({ path });
      if (h.hex === m.bundleChecksum) setShare({ ...getShare(), bundle: { version: m.bundleVersion, path } });
    }
    if (onWifi && m.nativeVersionCode && m.apkChecksum && v.apkUrl && share.apk?.code !== m.nativeVersionCode) {
      const path = "g37p2p/share/app.apk";
      await Filesystem.downloadFile({ url: v.apkUrl, path, directory: Directory.Data, recursive: true });
      const h = await Nearby.sha256({ path });
      if (h.hex === m.apkChecksum) setShare({ ...getShare(), apk: { code: m.nativeVersionCode, path } });
    }
  } catch (e) {
    console.warn("Copie de partage non faite :", e);
  }
  schedulePacket();
}

// ---------- Paquet échangé ----------
type WireOp = { payload: string; sig: string };
type Packet = {
  v: 1;
  from: { userId: number; name: string; deviceId: string };
  at: string;
  snapshot: Signed | null;
  manifest: Signed | null;
  has: { bundle: string | null; apk: number | null };
  ops: WireOp[];
};

async function signedOwnOps(me: State["me"]): Promise<WireOp[]> {
  const d = await getDevice();
  const ops = outbox();
  const sigs = new Map<string, WireOp>();
  const out: WireOp[] = [];
  for (const o of ops) {
    if (o.signed) { out.push(o.signed); continue; }
    const payload = JSON.stringify({ opId: o.opId, userId: me.id, deviceId: d.deviceId, clientAt: o.clientAt, input: o.input, name: me.displayName });
    const signed = { payload, sig: await signText(payload) };
    sigs.set(o.opId, signed);
    out.push(signed);
  }
  setOutboxSignatures(sigs);
  return out;
}

const PACKET_PATH = "g37p2p/packet.bin";
let packetTimer: ReturnType<typeof setTimeout> | null = null;
export function schedulePacket() {
  if (!nearbyAvailable()) return;
  if (packetTimer) clearTimeout(packetTimer);
  packetTimer = setTimeout(() => { packetTimer = null; void writePacket(); }, 2500);
}

async function writePacket() {
  const secrets = getSecrets();
  const state = loadCachedState();
  if (!secrets?.p2pKey || !state || state.me.pending) return;
  try {
    const d = await getDevice();
    const share = getShare();
    const snap = getSnap();
    const packet: Packet = {
      v: 1,
      from: { userId: state.me.id, name: state.me.displayName, deviceId: d.deviceId },
      at: new Date().toISOString(),
      snapshot: snap ? { text: snap.text, sig: snap.sig } : null,
      manifest: getManifestSigned(),
      has: { bundle: share.bundle?.version ?? null, apk: share.apk?.code ?? null },
      ops: [...(await signedOwnOps(state.me)), ...relayOps().map(({ payload, sig }) => ({ payload, sig }))].slice(-1200),
    };
    const bytes = await sealPacket(secrets.p2pKey, packet);
    await Filesystem.writeFile({ path: PACKET_PATH, data: toB64(bytes), directory: Directory.Data, recursive: true });
    if (status.running) await Nearby.broadcastPacket();
  } catch (e) {
    console.warn("Paquet non préparé :", e);
  }
}

async function mergeOps(ops: WireOp[], state: State) {
  const applied = new Set(state.appliedOpIds ?? []);
  const own = new Set(outbox().map((o) => o.opId));
  const known = new Set(relayOps().map((o) => o.opId));
  const devices = new Map((state.devices ?? []).map((d) => [d.deviceId, d]));
  const myDevice = deviceIdSync();
  const fresh: RelayOp[] = [];
  for (const w of ops.slice(0, 2000)) {
    if (typeof w?.payload !== "string" || typeof w?.sig !== "string" || w.payload.length > 60000) continue;
    let p: { opId: string; userId: number; deviceId: string; clientAt: string; input: RelayOp["input"]; name?: string };
    try { p = JSON.parse(w.payload); } catch { continue; }
    if (!p?.opId || applied.has(p.opId) || own.has(p.opId) || known.has(p.opId) || p.deviceId === myDevice) continue;
    const dev = devices.get(p.deviceId);
    const verified = !!dev && dev.userId === p.userId && (await verifyText(dev.signJwk, w.payload, w.sig));
    if (dev && !verified) continue; // signature fausse : rejetée
    known.add(p.opId);
    fresh.push({ payload: w.payload, sig: w.sig, opId: p.opId, userId: p.userId, deviceId: p.deviceId, name: String(p.name ?? ""), clientAt: p.clientAt, input: p.input, verified, receivedAt: new Date().toISOString() });
  }
  const added = addRelayOps(fresh);
  for (const o of added) {
    if (o.input.action === "dm" && o.input.to === state.me.id) dmFromRelay.emit({ opPayload: o });
  }
  if (added.some((o) => o.verified)) {
    const cached = loadCachedState();
    if (cached) stateAdopted.emit(cached);
  }
}

// ---------- Collègues à proximité ----------
export type Peer = { endpointId: string; userId: number | null; name: string; connected: boolean; seenAt: number; dataAt?: number | null };

// Fréquence de la vérification en arrière-plan (Paramètres) : 15, 30, 60 ou 120 minutes.
const INTERVAL_KEY = "g37.syncInterval";
export function syncIntervalMinutes(): number {
  try { return Number(localStorage.getItem(INTERVAL_KEY)) || 30; } catch { return 30; }
}
export async function setSyncInterval(minutes: number) {
  try { localStorage.setItem(INTERVAL_KEY, String(minutes)); } catch { /* stockage indisponible */ }
  if (nearbyAvailable() && started) await Nearby.setBackground({ enabled: true, intervalMinutes: minutes }).catch(() => {});
}
// Date des données de ce téléphone (dernière version reçue du serveur ou d'un collègue).
export function myDataAt(): number | null {
  try {
    const s = JSON.parse(localStorage.getItem(SNAP_KEY) ?? "null") as { serverTime?: string } | null;
    return s?.serverTime ? new Date(s.serverTime).getTime() : null;
  } catch { return null; }
}
const peers = new Map<string, Peer>();
export const getPeers = () => [...peers.values()];
export const peerForUser = (userId: number) => getPeers().find((p) => p.userId === userId && p.connected) ?? null;
const userIdFromName = (name: string) => { const m = /^G37:(\d+):/.exec(name ?? ""); return m ? Number(m[1]) : null; };
function touchPeer(endpointId: string, patch: Partial<Peer>) {
  const prev = peers.get(endpointId) ?? { endpointId, userId: null, name: "", connected: false, seenAt: 0 };
  const next = { ...prev, ...patch, seenAt: Date.now() };
  if (next.name && next.userId == null) next.userId = userIdFromName(next.name);
  peers.set(endpointId, next);
  peersChanged.emit(getPeers());
}

export async function sendNearbyMessage(endpointId: string, msg: Record<string, unknown>) {
  await Nearby.sendMessage({ endpointId, data: JSON.stringify(msg) });
}

const wantAsked = new Map<string, number>();
async function maybeWantUpdate(endpointId: string, packet: Packet) {
  const m = getManifest();
  if (!m) return;
  const now = Date.now();
  const ask = async (kind: "bundle" | "apk", version: string) => {
    const k = `${kind}:${version}`;
    if ((wantAsked.get(k) ?? 0) > now - 30 * 60000) return;
    wantAsked.set(k, now);
    await sendNearbyMessage(endpointId, { t: "want", kind, version });
  };
  if (m.bundleVersion && packet.has.bundle === m.bundleVersion && cmpVersion(m.bundleVersion, running.bundle) > 0
      && (!m.minNativeVersionCode || running.build >= m.minNativeVersionCode) && getShare().bundle?.version !== m.bundleVersion) {
    await ask("bundle", m.bundleVersion);
  }
  if (m.nativeVersionCode && m.apkChecksum && packet.has.apk === m.nativeVersionCode && running.build < m.nativeVersionCode
      && getShare().apk?.code !== m.nativeVersionCode) {
    await ask("apk", String(m.nativeVersionCode));
  }
}

async function onMessage(endpointId: string, data: string) {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.t === "hello") {
    touchPeer(endpointId, { userId: Number(msg.userId) || null, connected: true, dataAt: Number(msg.dataAt) || null });
    // Collègue en retard : on lui renvoie tout de suite nos données plus récentes.
    const mine = myDataAt();
    if (mine && (!Number(msg.dataAt) || Number(msg.dataAt) < mine)) await Nearby.sendPacket({ endpointId }).catch(() => {});
  } else if (msg.t === "want") {
    const share = getShare();
    if (msg.kind === "bundle" && share.bundle && share.bundle.version === msg.version) {
      await Nearby.sendFile({ endpointId, path: share.bundle.path, kind: "bundle", name: share.bundle.version });
    } else if (msg.kind === "apk" && share.apk && String(share.apk.code) === msg.version) {
      await Nearby.sendFile({ endpointId, path: share.apk.path, kind: "apk", name: String(share.apk.code) });
    }
  } else if (msg.t === "call") {
    callMessage.emit({ endpointId, userId: peers.get(endpointId)?.userId ?? null, msg });
  }
}

async function readBytes(path: string): Promise<Uint8Array> {
  const r = await Filesystem.readFile({ path, directory: Directory.Data });
  return typeof r.data === "string" ? fromB64(r.data) : new Uint8Array(await (r.data as Blob).arrayBuffer());
}

async function handleFile(f: InboxFile) {
  const state = loadCachedState();
  const secrets = getSecrets();
  try {
    if (f.kind === "packet") {
      if (!state || !secrets?.p2pKey) return; // gardé pour plus tard
      const packet = await openPacket<Packet>(secrets.p2pKey, await readBytes(f.path));
      if (packet && packet.v === 1) {
        if (f.endpointId) touchPeer(f.endpointId, { userId: packet.from.userId, connected: true });
        if (packet.snapshot) await adoptSnapshot(packet.snapshot, state.me.id);
        if (packet.manifest) await storeManifest(packet.manifest);
        await mergeOps(packet.ops ?? [], loadCachedState() ?? state);
        if (f.endpointId) await maybeWantUpdate(f.endpointId, packet);
        setStatus({ lastExchange: Date.now() });
      }
    } else if (f.kind === "bundle" || f.kind === "apk") {
      const m = getManifest();
      const h = await Nearby.sha256({ path: f.path });
      if (m && f.kind === "bundle" && f.name === m.bundleVersion && h.hex === m.bundleChecksum) {
        const path = "g37p2p/share/bundle.zip";
        await Filesystem.rename({ from: f.path, to: path, directory: Directory.Data, toDirectory: Directory.Data }).catch(async () => {
          await Filesystem.copy({ from: f.path, to: path, directory: Directory.Data, toDirectory: Directory.Data });
        });
        setShare({ ...getShare(), bundle: { version: m.bundleVersion!, path } });
        updateFromPeer.emit({ kind: "bundle", path, version: m.bundleVersion!, notes: m.notes });
        schedulePacket();
      } else if (m && f.kind === "apk" && Number(f.name) === m.nativeVersionCode && h.hex === m.apkChecksum) {
        const path = "g37p2p/share/app.apk";
        await Filesystem.rename({ from: f.path, to: path, directory: Directory.Data, toDirectory: Directory.Data }).catch(async () => {
          await Filesystem.copy({ from: f.path, to: path, directory: Directory.Data, toDirectory: Directory.Data });
        });
        setShare({ ...getShare(), apk: { code: m.nativeVersionCode!, path } });
        updateFromPeer.emit({ kind: "apk", path, version: String(m.nativeVersionCode), notes: m.notes });
        schedulePacket();
      }
    }
  } catch (e) {
    console.warn("Fichier reçu non traité :", e);
  }
  await Nearby.deleteFile({ path: f.path }).catch(() => {});
}

let inboxBusy: Promise<void> | null = null;
export function processInbox(): Promise<void> {
  if (!nearbyAvailable()) return Promise.resolve();
  if (inboxBusy) return inboxBusy;
  inboxBusy = (async () => {
    const { files } = await Nearby.listInbox().catch(() => ({ files: [] as InboxFile[] }));
    files.sort((a, b) => a.receivedAt - b.receivedAt);
    for (const f of files) await handleFile(f);
  })().finally(() => { inboxBusy = null; });
  return inboxBusy;
}

// ---------- Démarrage ----------
let started = false;
let listenersReady = false;

export async function requestP2PPermissions(): Promise<boolean> {
  if (!nearbyAvailable()) return false;
  const r = await Nearby.requestNearbyPermissions({ microphone: true });
  setStatus({ needsPermission: !r.nearby });
  return r.nearby;
}

export async function startP2P(me: { id: number; pending: boolean }): Promise<void> {
  if (!nearbyAvailable()) return;
  setStatus({ available: true });
  const perm = await Nearby.checkNearbyPermissions().catch(() => ({ nearby: false, microphone: false }));
  if (!perm.nearby) { setStatus({ needsPermission: true }); return; }
  setStatus({ needsPermission: false });
  if (me.pending || !getSecrets()?.p2pKey) return;
  if (!listenersReady) {
    listenersReady = true;
    await Nearby.addListener("peerFound", (e) => touchPeer(e.endpointId, { name: e.name ?? "" }));
    await Nearby.addListener("peerLost", (e) => { peers.delete(e.endpointId); peersChanged.emit(getPeers()); });
    await Nearby.addListener("connected", async (e) => {
      touchPeer(e.endpointId, { name: e.name ?? "", connected: true });
      const cached = loadCachedState();
      const d = await getDevice();
      if (cached) await sendNearbyMessage(e.endpointId, { t: "hello", userId: cached.me.id, deviceId: d.deviceId, dataAt: myDataAt() }).catch(() => {});
    });
    await Nearby.addListener("disconnected", (e) => touchPeer(e.endpointId, { connected: false }));
    await Nearby.addListener("message", (e) => void onMessage(e.endpointId, e.data));
    await Nearby.addListener("file", () => void processInbox());
    onOutboxChange(schedulePacket);
    onRelayChange(schedulePacket);
    setInterval(() => void writePacket(), 10 * 60000);
  }
  if (!started) {
    const d = await getDevice();
    await Nearby.start({ name: `G37:${me.id}:${d.deviceId.slice(2, 8)}` });
    await Nearby.setBackground({ enabled: true, intervalMinutes: syncIntervalMinutes() }).catch(() => {});
    started = true;
    setStatus({ running: true });
  }
  await writePacket();
  await processInbox();
}

export async function stopP2P() {
  if (!nearbyAvailable() || !started) return;
  started = false;
  setStatus({ running: false });
  peers.clear();
  peersChanged.emit([]);
  await Nearby.stop().catch(() => {});
  await Nearby.setBackground({ enabled: false }).catch(() => {});
}

// ---------- Avec Internet : porter au serveur les actions des collègues ----------
let relayBusy: Promise<number> | null = null;
export function flushRelay(): Promise<number> {
  if (relayBusy) return relayBusy;
  relayBusy = (async () => {
    let sent = 0;
    if (!isOnline()) return 0;
    for (let round = 0; round < 10; round++) {
      const batch = relayOps().slice(0, 100);
      if (!batch.length) break;
      let data: { results: Array<{ opId: string; ok: boolean; retry: boolean }> };
      try {
        const res = await fetch("/_api/g37/relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ops: batch.map(({ payload, sig }) => ({ payload, sig })) }),
        });
        if (!res.ok) break;
        data = superjson.parse(await res.text());
      } catch {
        break;
      }
      const done = new Set(data.results.filter((r) => !r.retry).map((r) => r.opId));
      sent += data.results.filter((r) => r.ok).length;
      // Inconnu du serveur pour l'instant (téléphone pas encore enregistré) : on réessaiera plus tard.
      if (!done.size) break;
      removeRelayOps(done);
    }
    return sent;
  })().finally(() => { relayBusy = null; });
  return relayBusy;
}
