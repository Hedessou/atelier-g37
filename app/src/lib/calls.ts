import { toast } from "sonner";
import { openRobotAsk } from "../components/RobotAsk";
import { newId } from "./offline";
import { isOnline } from "./net";
import { Nearby, isWifiEndpoint, nativeSoundsAvailable, nativeV4Available, nearbyAvailable } from "./nearby";
import { callMessage, ensureP2PListeners, getSecrets, peerForUser, sendNearbyMessage } from "./p2p";
import { startRingtone, stopRingtone } from "./sounds";

// ---------------------------------------------------------------------------
// Appels voix et vidéo entre collègues
//  - « internet » : salle d'appel (à deux ou en groupe jusqu'à 25), voix/vidéo directes entre téléphones (WebRTC),
//    mise en relation par le serveur ; on peut rejoindre un appel de groupe en cours.
//  - « wifi »     : sans Internet, sur le même Wi-Fi (box sans abonnement) ou le point d'accès d'un téléphone.
//                   Même qualité qu'Internet (WebRTC), voix et vidéo ; mise en relation par la liaison locale.
//  - « proche »   : sans Internet ni Wi-Fi, par Bluetooth / Wi-Fi direct (Google Nearby).
//                   Voix large bande par le téléphone ; vidéo allégée (images successives) si demandée.
// ---------------------------------------------------------------------------

export const MAX_PARTICIPANTS = 25;
export type Via = "internet" | "proche" | "wifi";
export type Participant = { userId: number; name: string; status: "ringing" | "connecting" | "connected" | "left" | "declined" };
export type ActiveCall = {
  phase: "outgoing" | "incoming" | "active" | "ended";
  roomId: string; group: boolean; via: Via; inviterId: number; inviterName: string;
  participants: Participant[]; muted: boolean; speaker: boolean; startedAt: number | null; reason?: string;
  video: boolean; cameraOn: boolean; facing: "user" | "environment";
};
export type CallState = { phase: "idle" } | ActiveCall;
export type CallLog = {
  id: string; peerId: number; peerName: string; group?: boolean; count?: number; video?: boolean;
  dir: "in" | "out"; via: Via; at: string; status: "done" | "missed" | "declined" | "failed"; seconds: number;
};
export type RoomInfo = {
  id: string; createdBy: number; group: boolean; title: string | null; createdAt: string; endedAt: string | null; video?: boolean;
  members: Array<{ userId: number; name: string; status: "in" | "ringing" | "declined" | "left" | "missed"; joinedAt: string | null }>;
};

type Me = { id: number; displayName: string; noCalls?: boolean };
let me: Me | null = null;
export function setCallIdentity(m: Me | null) { me = m; }

let state: CallState = { phase: "idle" };
const listeners = new Set<(s: CallState) => void>();
export const getCallState = () => state;
// Lecture « fraîche » de l'état (il change pendant les attentes) : évite les fausses déductions de TypeScript.
const cur = (): CallState => state;
export function onCallState(l: (s: CallState) => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function set(next: CallState) {
  const before = state;
  state = next;
  listeners.forEach((l) => l(state));
  void syncNativeCallMode(before, next);
}
function patch(p: Partial<ActiveCall>) {
  if (state.phase === "idle") return;
  set({ ...state, ...p });
}
const busy = () => state.phase !== "idle" && state.phase !== "ended";
function setParticipant(userId: number, name: string, status: Participant["status"]) {
  if (state.phase === "idle") return;
  const list = state.participants.filter((p) => p.userId !== userId);
  const prev = state.participants.find((p) => p.userId === userId);
  list.push({ userId, name: name || prev?.name || "Collègue", status });
  patch({ participants: list });
}

// ---- Images (vidéo) : flux local, flux des collègues, images allégées Bluetooth ----
export type CallMedia = { local: MediaStream | null; remote: Map<number, MediaStream>; lite: Map<number, string>; remoteCam: Map<number, boolean> };
const media: CallMedia = { local: null, remote: new Map(), lite: new Map(), remoteCam: new Map() };
const mediaListeners = new Set<(m: CallMedia) => void>();
export const getCallMedia = () => media;
export function onCallMedia(l: (m: CallMedia) => void) {
  mediaListeners.add(l);
  return () => { mediaListeners.delete(l); };
}
const emitMedia = () => mediaListeners.forEach((l) => l(media));

// ---- Journal des appels (sur ce téléphone) ----
const LOG_KEY = "g37.calls";
export function callLog(): CallLog[] {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as CallLog[]; } catch { return []; }
}
function addLog(entry: CallLog) {
  const list = [entry, ...callLog().filter((c) => c.id !== entry.id)].slice(0, 200);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(list)); } catch { /* plein */ }
  listeners.forEach((l) => l(state));
}

// ---- Tonalité de retour d'appel (côté appelant) ----
let backTimer: ReturnType<typeof setInterval> | null = null;
let backCtx: AudioContext | null = null;
function ringback() {
  stopRingback();
  const tone = () => {
    try {
      backCtx = backCtx ?? new AudioContext();
      const t0 = backCtx.currentTime;
      const osc = backCtx.createOscillator();
      const gain = backCtx.createGain();
      osc.frequency.value = 440;
      osc.connect(gain);
      gain.connect(backCtx.destination);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05);
      gain.gain.setValueAtTime(0.12, t0 + 1.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
      osc.start(t0);
      osc.stop(t0 + 1.35);
    } catch { /* son refusé */ }
  };
  tone();
  backTimer = setInterval(tone, 4000);
}
function stopRingback() {
  if (backTimer) clearInterval(backTimer);
  backTimer = null;
}

// Sonnerie : si l'app est cachée, c'est la notification du téléphone qui sonne (pas de double sonnerie).
function ringIfVisible() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  void startRingtone();
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || state.phase !== "incoming") return;
    void nativeV4Available().then((ok) => { if (ok) void Nearby.cancelCallNotification({ callId: state.phase !== "idle" ? state.roomId : undefined }).catch(() => {}); });
    void startRingtone();
  });
}

// ---- Serveur ----
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/_api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Appel impossible");
  return data as T;
}
async function serverSignal(to: number, data: Record<string, unknown>) {
  await fetch("/_api/g37/call_signal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, data }) });
}
export async function listActiveRooms(): Promise<RoomInfo[]> {
  if (!isOnline()) return [];
  const r = await api<{ rooms: RoomInfo[] }>("g37/call_rooms");
  return r.rooms ?? [];
}

// ---- Transport de la signalisation : serveur (Internet) ou liaison directe (Wi-Fi local / Bluetooth) ----
let localEndpoint: string | null = null;
async function sendSignal(to: number, data: Record<string, unknown>) {
  if (state.phase !== "idle" && state.via !== "internet") {
    if (!localEndpoint) return;
    await sendNearbyMessage(localEndpoint, { t: "call", ...data, callId: data.roomId ?? state.roomId, to, from: me?.id ?? 0 });
    return;
  }
  await serverSignal(to, data);
}

// ---- WebRTC : une connexion par collègue présent dans l'appel ----
type PeerConn = { pc: RTCPeerConnection; audio: HTMLAudioElement; ice: RTCIceCandidateInit[]; remote: MediaStream; offerer: boolean; restarted: boolean };
const conns = new Map<number, PeerConn>();
let localStream: MediaStream | null = null;
let noAnswerTimer: ReturnType<typeof setTimeout> | null = null;
let incomingCall = false;

const videoConstraints = (facing: "user" | "environment", group: boolean): MediaTrackConstraints => ({
  facingMode: facing,
  width: { ideal: group ? 320 : 640 },
  height: { ideal: group ? 240 : 480 },
  frameRate: { ideal: group ? 15 : 24, max: 30 },
});

async function ensurePermissions(video: boolean) {
  if (!nearbyAvailable()) return;
  const r = await Nearby.requestNearbyPermissions({ microphone: true, camera: video }).catch(() => null);
  if (r && !r.microphone) throw new Error("Autorise le micro pour appeler.");
}

async function micStream(video: boolean): Promise<MediaStream> {
  if (localStream) return localStream;
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const s = state.phase !== "idle" ? state : null;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio, video: video ? videoConstraints(s?.facing ?? "user", !!s?.group) : false });
  } catch (e) {
    if (!video) throw e;
    // Caméra refusée ou occupée : on continue en voix seule.
    localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    patch({ video: false, cameraOn: false });
  }
  if (state.phase !== "idle" && state.muted) localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
  media.local = localStream;
  emitMedia();
  return localStream;
}

// Appel de groupe : débit réduit pour tenir à 25 sur un réseau mobile.
function tuneSdp(sdp: string | undefined): string {
  if (!sdp) return "";
  const kbps = state.phase !== "idle" && state.participants.length > 3 ? 20000 : 32000;
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (_m, pt, params) =>
    `a=fmtp:${pt} ${String(params).replace(/;?maxaveragebitrate=\d+/, "")};maxaveragebitrate=${kbps}`);
}

function iceServers(): RTCIceServer[] {
  // Wi-Fi local : les téléphones se voient directement, pas besoin de serveur.
  if (state.phase !== "idle" && state.via === "wifi") return [];
  return getSecrets()?.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }];
}

function peerConn(userId: number, name: string, offerer = false): PeerConn {
  const existing = conns.get(userId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const audio = new Audio();
  audio.autoplay = true;
  const remote = new MediaStream();
  const c: PeerConn = { pc, audio, ice: [], remote, offerer, restarted: false };
  conns.set(userId, c);
  const roomId = state.phase !== "idle" ? state.roomId : "";
  pc.onicecandidate = (e) => {
    if (e.candidate) void sendSignal(userId, { type: "ice", roomId, candidate: e.candidate.toJSON() }).catch(() => {});
  };
  pc.ontrack = (e) => {
    if (!remote.getTracks().includes(e.track)) remote.addTrack(e.track);
    audio.srcObject = remote;
    void audio.play().catch(() => {});
    if (e.track.kind === "video") {
      media.remote.set(userId, remote);
      if (!media.remoteCam.has(userId)) media.remoteCam.set(userId, true);
      e.track.onunmute = () => emitMedia();
      e.track.onmute = () => emitMedia();
      emitMedia();
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      c.restarted = false;
      setParticipant(userId, name, "connected");
      if (state.phase === "outgoing") {
        stopRingback();
        if (noAnswerTimer) clearTimeout(noAnswerTimer);
        patch({ phase: "active", startedAt: Date.now() });
        void applySpeaker();
      }
    }
    if (pc.connectionState === "failed") {
      // Réseau qui change (Wi-Fi ↔ données mobiles) : une nouvelle tentative avant d'abandonner.
      if (c.offerer && !c.restarted) {
        c.restarted = true;
        try { pc.restartIce(); } catch { /* ancien navigateur */ }
        void renegotiate(userId, true).catch(() => {});
        return;
      }
      closePeer(userId);
      setParticipant(userId, name, "left");
      checkAlone();
    }
  };
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream!));
  return c;
}

// L'offre prévoit toujours la vidéo (même en appel voix) : on peut allumer la caméra en cours d'appel.
function prepareTransceivers(pc: RTCPeerConnection) {
  const kinds = pc.getTransceivers().map((t) => t.receiver.track?.kind);
  if (!kinds.includes("audio")) pc.addTransceiver("audio", { direction: "recvonly" });
  if (!kinds.includes("video")) pc.addTransceiver("video", { direction: "recvonly" });
}

function closePeer(userId: number) {
  const c = conns.get(userId);
  if (!c) return;
  conns.delete(userId);
  try { c.pc.close(); } catch { /* déjà fermé */ }
  c.audio.srcObject = null;
  media.remote.delete(userId);
  media.remoteCam.delete(userId);
  emitMedia();
}

async function flushIce(c: PeerConn) {
  if (!c.pc.remoteDescription) return;
  const list = c.ice;
  c.ice = [];
  for (const cand of list) await c.pc.addIceCandidate(cand).catch(() => {});
}

async function offerTo(userId: number, name: string) {
  const c = peerConn(userId, name, true);
  setParticipant(userId, name, "connecting");
  prepareTransceivers(c.pc);
  const offer = await c.pc.createOffer();
  await c.pc.setLocalDescription({ type: "offer", sdp: tuneSdp(offer.sdp) });
  await sendSignal(userId, { type: "offer", roomId: state.phase !== "idle" ? state.roomId : "", sdp: tuneSdp(offer.sdp), name: me?.displayName });
}

async function renegotiate(userId: number, iceRestart = false) {
  const c = conns.get(userId);
  if (!c || c.pc.signalingState !== "stable") return;
  const offer = await c.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
  await c.pc.setLocalDescription({ type: "offer", sdp: tuneSdp(offer.sdp) });
  await sendSignal(userId, { type: "offer", roomId: state.phase !== "idle" ? state.roomId : "", sdp: tuneSdp(offer.sdp), name: me?.displayName, reneg: true });
}

// Signaux WebRTC communs (Internet et Wi-Fi local).
async function onRtcSignal(from: number, name: string, d: Record<string, unknown>) {
  if (d.type === "offer") {
    const c = peerConn(from, name);
    setParticipant(from, name, conns.get(from)?.pc.connectionState === "connected" ? "connected" : "connecting");
    await c.pc.setRemoteDescription({ type: "offer", sdp: String(d.sdp ?? "") });
    const answer = await c.pc.createAnswer();
    await c.pc.setLocalDescription({ type: "answer", sdp: tuneSdp(answer.sdp) });
    await sendSignal(from, { type: "answer", roomId: state.phase !== "idle" ? state.roomId : "", sdp: tuneSdp(answer.sdp) });
    await flushIce(c);
    if (state.phase !== "idle" && state.video) void sendSignal(from, { type: "cam", roomId: state.roomId, on: state.cameraOn }).catch(() => {});
  } else if (d.type === "answer") {
    const c = conns.get(from);
    if (c && c.pc.signalingState === "have-local-offer") {
      await c.pc.setRemoteDescription({ type: "answer", sdp: String(d.sdp ?? "") });
      await flushIce(c);
    }
  } else if (d.type === "ice" && d.candidate) {
    const c = conns.get(from) ?? peerConn(from, name);
    c.ice.push(d.candidate as RTCIceCandidateInit);
    await flushIce(c);
  } else if (d.type === "cam") {
    media.remoteCam.set(from, !!d.on);
    emitMedia();
  }
}

// ---- Vidéo allégée par Bluetooth (images JPEG successives, au rythme que la liaison supporte) ----
let liteTimer: ReturnType<typeof setTimeout> | null = null;
let liteAck: (() => void) | null = null;
let liteVideo: HTMLVideoElement | null = null;
let liteCanvas: HTMLCanvasElement | null = null;

function stopLite() {
  if (liteTimer) clearTimeout(liteTimer);
  liteTimer = null;
  liteAck = null;
  if (liteVideo) { liteVideo.srcObject = null; liteVideo = null; }
}

async function startLite() {
  stopLite();
  if (state.phase === "idle" || state.via !== "proche" || !localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  liteVideo = document.createElement("video");
  liteVideo.muted = true;
  liteVideo.playsInline = true;
  liteVideo.srcObject = new MediaStream([track]);
  await liteVideo.play().catch(() => {});
  liteCanvas = liteCanvas ?? document.createElement("canvas");
  let quality = 0.5;
  const loop = async () => {
    liteTimer = null;
    if (state.phase !== "active" || state.via !== "proche" || !state.cameraOn || !localEndpoint || !liteVideo || !liteCanvas) {
      if (state.phase === "active" && state.via === "proche") liteTimer = setTimeout(() => void loop(), 800);
      return;
    }
    const v = liteVideo;
    const w = 176;
    const h = v.videoWidth && v.videoHeight ? Math.round((w * v.videoHeight) / v.videoWidth) : 144;
    liteCanvas.width = w;
    liteCanvas.height = h;
    const g = liteCanvas.getContext("2d");
    if (g && v.readyState >= 2) {
      g.drawImage(v, 0, 0, w, h);
      let data = liteCanvas.toDataURL("image/jpeg", quality).split(",")[1] ?? "";
      if (data.length > 24000) { quality = Math.max(0.2, quality - 0.1); data = liteCanvas.toDataURL("image/jpeg", quality).split(",")[1] ?? ""; }
      else if (data.length < 9000 && quality < 0.65) quality += 0.05;
      if (data.length <= 28000) {
        const sentAt = Date.now();
        const acked = new Promise<void>((resolve) => { liteAck = resolve; setTimeout(resolve, 1500); });
        await sendNearbyMessage(localEndpoint, { t: "call", type: "vf", callId: state.roomId, d: data }).catch(() => {});
        await acked;
        liteAck = null;
        const spent = Date.now() - sentAt;
        liteTimer = setTimeout(() => void loop(), Math.max(120, 250 - spent));
        return;
      }
    }
    liteTimer = setTimeout(() => void loop(), 300);
  };
  liteTimer = setTimeout(() => void loop(), 200);
}

// ---- Mode appel du téléphone : micro gardé en arrière-plan, écran éteint contre l'oreille ----
async function syncNativeCallMode(before: CallState, next: CallState) {
  if (!(await nativeV4Available())) return;
  const wasActive = before.phase === "active" || before.phase === "outgoing";
  const isActive = next.phase === "active" || next.phase === "outgoing";
  if (isActive && !wasActive) {
    const title = (next as ActiveCall).video ? "Appel vidéo en cours" : "Appel en cours";
    void Nearby.setInCall({ active: true, title }).catch(() => {});
  } else if (!isActive && wasActive) {
    void Nearby.setInCall({ active: false }).catch(() => {});
  }
  const ear = next.phase === "active" && !next.speaker && !(next.video && next.cameraOn);
  void Nearby.setProximity({ on: ear }).catch(() => {});
}

function cleanup() {
  stopRingback();
  stopLite();
  void stopRingtone();
  if (noAnswerTimer) clearTimeout(noAnswerTimer);
  noAnswerTimer = null;
  [...conns.keys()].forEach(closePeer);
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  media.local = null;
  media.remote.clear();
  media.lite.clear();
  media.remoteCam.clear();
  emitMedia();
  if (nearbyAvailable()) {
    void Nearby.stopAudio().catch(() => {});
    void nativeSoundsAvailable().then((ok) => { if (ok) void Nearby.resetAudio().catch(() => {}); });
    void nativeV4Available().then((ok) => { if (ok) void Nearby.cancelCallNotification({}).catch(() => {}); });
  }
  localEndpoint = null;
}

function end(reason: string, status?: CallLog["status"], notify = true) {
  if (state.phase === "idle" || state.phase === "ended") return;
  const s = state;
  if (notify) {
    if (s.via !== "internet" && localEndpoint) void sendNearbyMessage(localEndpoint, { t: "call", type: "hangup", callId: s.roomId }).catch(() => {});
    else if (s.via === "internet" && s.phase !== "incoming") void api("g37/call_room", { action: "leave", id: s.roomId }).catch(() => {});
  }
  const others = s.participants.filter((p) => p.userId !== me?.id);
  const first = incomingCall ? { userId: s.inviterId, name: s.inviterName } : others[0] ?? { userId: 0, name: "Collègue" };
  const seconds = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
  addLog({
    id: s.roomId, peerId: first.userId, peerName: s.group ? `Groupe · ${first.name}` : first.name, group: s.group, count: others.length, video: s.video,
    dir: incomingCall ? "in" : "out", via: s.via, at: new Date().toISOString(),
    status: status ?? (s.startedAt ? "done" : incomingCall ? "missed" : "failed"), seconds,
  });
  cleanup();
  set({ ...s, phase: "ended", reason });
  setTimeout(() => { if (state.phase === "ended") set({ phase: "idle" }); }, 2500);
}

// Personne d'autre dans l'appel : on raccroche.
function checkAlone() {
  if (state.phase === "idle" || state.phase === "ended" || state.phase === "incoming") return;
  const live = state.participants.filter((p) => p.userId !== me?.id && (p.status === "connected" || p.status === "connecting" || p.status === "ringing"));
  if (live.length) return;
  const declined = state.participants.some((p) => p.status === "declined");
  end(state.startedAt ? "Appel terminé" : declined ? "Appel refusé" : "Pas de réponse", state.startedAt ? undefined : declined ? "declined" : "failed");
}

async function applySpeaker() {
  if (state.phase === "idle") return;
  if (state.via === "proche") await Nearby.setSpeaker({ on: state.speaker }).catch(() => {});
  else if (await nativeSoundsAvailable()) await Nearby.setAudioRoute({ speaker: state.speaker }).catch(() => {});
}

const baseCall = (p: Partial<ActiveCall> & Pick<ActiveCall, "phase" | "roomId" | "via">): ActiveCall => ({
  group: false, inviterId: me?.id ?? 0, inviterName: me?.displayName ?? "", participants: [], muted: false,
  speaker: !!p.video, startedAt: null, video: false, cameraOn: !!p.video, facing: "user", ...p,
});

// ---- Actions ----
export type CallOptions = { video?: boolean };

/** Appeler un collègue : par le Wi-Fi local s'il y est, sinon Internet, sinon Bluetooth. */
export async function startCall(peerId: number, peerName: string, opts: CallOptions = {}): Promise<void> {
  if (!me) throw new Error("Session non prête");
  if (busy()) throw new Error("Un appel est déjà en cours");
  const video = !!opts.video;
  const local = nearbyAvailable() ? peerForUser(peerId) : null;
  if (local && local.medium === "wifi") return startLocalRtc(local.endpointId, peerId, peerName, video);
  if (isOnline()) {
    try {
      await startRoom([{ userId: peerId, name: peerName }], false, video);
      return;
    } catch (e) {
      // Serveur injoignable mais collègue à portée Bluetooth : on passe par là.
      if (!local) throw e;
    }
  }
  if (local) return startNearbyCall(local.endpointId, peerId, peerName, video);
  throw new Error(nearbyAvailable()
    ? "Pas d'Internet et ce collègue n'est pas à portée (Bluetooth / Wi-Fi). Rapprochez-vous ou utilisez le même Wi-Fi / point d'accès."
    : "Pas d'Internet : l'appel est impossible pour le moment.");
}

async function startLocalRtc(endpointId: string, peerId: number, peerName: string, video: boolean) {
  await ensurePermissions(video);
  const roomId = newId("call").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  incomingCall = false;
  localEndpoint = endpointId;
  set(baseCall({ phase: "outgoing", roomId, via: "wifi", video, participants: [{ userId: peerId, name: peerName, status: "ringing" }] }));
  try {
    await micStream(video);
    await sendNearbyMessage(endpointId, { t: "call", type: "invite", mode: "rtc", callId: roomId, from: me!.id, to: peerId, name: me!.displayName, video });
  } catch (e) {
    cleanup();
    set({ phase: "idle" });
    throw e;
  }
  ringback();
  noAnswerTimer = setTimeout(() => { if (state.phase === "outgoing") end("Pas de réponse", "failed"); }, 45000);
}

async function startNearbyCall(endpointId: string, peerId: number, peerName: string, video: boolean) {
  await ensurePermissions(video);
  const roomId = newId("call").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  incomingCall = false;
  localEndpoint = endpointId;
  set(baseCall({ phase: "outgoing", roomId, via: "proche", video, participants: [{ userId: peerId, name: peerName, status: "ringing" }] }));
  if (video) await micStream(true).catch(() => patch({ video: false, cameraOn: false }));
  await sendNearbyMessage(endpointId, { t: "call", type: "offer", mode: "nearby", callId: roomId, from: me!.id, to: peerId, name: me!.displayName, video });
  ringback();
  noAnswerTimer = setTimeout(() => { if (state.phase === "outgoing") end("Pas de réponse", "failed"); }, 45000);
}

export async function startGroupCall(people: Array<{ userId: number; name: string }>, opts: CallOptions = {}): Promise<void> {
  if (people.length + 1 > MAX_PARTICIPANTS) throw new Error(`${MAX_PARTICIPANTS} personnes au maximum.`);
  await startRoom(people, true, !!opts.video);
}

async function startRoom(people: Array<{ userId: number; name: string }>, group: boolean, video: boolean) {
  if (!me) throw new Error("Session non prête");
  if (busy()) throw new Error("Un appel est déjà en cours");
  if (!isOnline()) throw new Error("Pas d'Internet : l'appel de groupe a besoin d'Internet.");
  await ensurePermissions(video);
  const roomId = newId("room").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  incomingCall = false;
  set(baseCall({ phase: "outgoing", roomId, group, via: "internet", video, speaker: group || video,
    participants: people.map((p) => ({ ...p, status: "ringing" as const })) }));
  try {
    await micStream(video);
    const created = await api<{ noPush?: Array<{ name: string }> }>("g37/call_room", { action: "create", id: roomId, invite: people.map((p) => p.userId), group, video });
    // Collègue sans notifications enregistrées : l'appel ne sonnera chez lui que si son app est ouverte.
    const noPush = created?.noPush ?? [];
    if (noPush.length) toast.warning(`${noPush.map((x) => x.name).join(", ")} : notifications non activées sur son téléphone. L'appel ne sonnera que si son app est ouverte.`, { duration: 9000 });
  } catch (e) {
    cleanup();
    set({ phase: "idle" });
    throw e;
  }
  void applySpeaker();
  ringback();
  noAnswerTimer = setTimeout(() => {
    if (state.phase === "outgoing") end("Pas de réponse", "failed");
  }, 50000);
}

// Rejoindre (répondre à une invitation ou entrer dans un appel de groupe en cours).
export async function joinRoom(roomId: string, info?: { group?: boolean; inviterId?: number; inviterName?: string; video?: boolean }): Promise<void> {
  if (!me) throw new Error("Session non prête");
  if (busy() && !(state.phase === "incoming" && state.roomId === roomId)) throw new Error("Un appel est déjà en cours");
  void stopRingtone();
  if (noAnswerTimer) clearTimeout(noAnswerTimer);
  const prev = state.phase !== "idle" ? state : null;
  const video = info?.video ?? prev?.video ?? false;
  const group = info?.group ?? prev?.group ?? true;
  set(baseCall({ phase: "active", roomId, group, via: "internet", video, speaker: group || video,
    inviterId: info?.inviterId ?? prev?.inviterId ?? 0, inviterName: info?.inviterName ?? prev?.inviterName ?? "", startedAt: Date.now() }));
  try {
    await ensurePermissions(video);
    await micStream(video);
    const r = await api<{ room: RoomInfo }>("g37/call_room", { action: "join", id: roomId });
    patch({ group: r.room.group, participants: r.room.members.filter((m) => m.userId !== me!.id && (m.status === "in" || m.status === "ringing"))
      .map((m) => ({ userId: m.userId, name: m.name, status: m.status === "in" ? "connecting" : "ringing" })) });
    await applySpeaker();
    for (const m of r.room.members) {
      if (m.userId !== me.id && m.status === "in") await offerTo(m.userId, m.name).catch(() => {});
    }
  } catch (e) {
    end(e instanceof Error ? e.message : "Appel impossible", "failed", false);
    throw e;
  }
}

/** Répondre. withVideo : répondre avec la caméra (appel vidéo) ou en voix seule. */
export async function acceptCall(withVideo?: boolean): Promise<void> {
  if (state.phase !== "incoming") return;
  const s = state;
  const video = withVideo ?? s.video;
  void stopRingtone();
  if (noAnswerTimer) clearTimeout(noAnswerTimer);
  void nativeV4Available().then((ok) => { if (ok) void Nearby.cancelCallNotification({ callId: s.roomId }).catch(() => {}); });
  try {
    if (s.via === "proche") {
      await ensurePermissions(video);
      if (!localEndpoint) throw new Error("Collègue hors de portée.");
      patch({ video, cameraOn: video, speaker: video });
      if (video) await micStream(true).catch(() => patch({ video: false, cameraOn: false }));
      await sendNearbyMessage(localEndpoint, { t: "call", type: "answer", callId: s.roomId, video });
      await Nearby.startAudio({ endpointId: localEndpoint });
      patch({ phase: "active", startedAt: Date.now() });
      await applySpeaker();
      if (video) void startLite();
    } else if (s.via === "wifi") {
      await ensurePermissions(video);
      if (!localEndpoint) throw new Error("Collègue hors de portée.");
      patch({ phase: "active", startedAt: Date.now(), video, cameraOn: video, speaker: video,
        participants: [{ userId: s.inviterId, name: s.inviterName, status: "connecting" }] });
      await micStream(video);
      await applySpeaker();
      await offerTo(s.inviterId, s.inviterName);
    } else {
      await joinRoom(s.roomId, { group: s.group, inviterId: s.inviterId, inviterName: s.inviterName, video });
    }
  } catch (e) {
    if (cur().phase !== "ended" && cur().phase !== "idle") end(e instanceof Error ? e.message : "Appel impossible", "failed");
  }
}

export function declineCall() {
  if (state.phase !== "incoming") return;
  const s = state;
  if (s.via !== "internet" && localEndpoint) void sendNearbyMessage(localEndpoint, { t: "call", type: "decline", callId: s.roomId }).catch(() => {});
  else void api("g37/call_room", { action: "decline", id: s.roomId }).catch(() => {});
  end("Appel refusé", "declined", false);
}

export function hangUp() {
  end("Appel terminé");
}

export async function inviteToCall(people: Array<{ userId: number; name: string }>) {
  if (state.phase !== "active" && state.phase !== "outgoing") return;
  if (state.via !== "internet") throw new Error("Pour inviter d'autres collègues, l'appel doit passer par Internet.");
  const roomId = state.roomId;
  await api("g37/call_room", { action: "invite", id: roomId, invite: people.map((p) => p.userId) });
  const now = cur();
  if (now.phase !== "idle" && now.roomId === roomId) {
    patch({ group: true });
    people.forEach((p) => setParticipant(p.userId, p.name, "ringing"));
  }
}

export function toggleMute() {
  if (state.phase === "idle" || state.phase === "ended") return;
  const muted = !state.muted;
  if (state.via === "proche") void Nearby.setMuted({ muted }).catch(() => {});
  localStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  patch({ muted });
}

export function toggleSpeaker() {
  if (state.phase === "idle" || state.phase === "ended") return;
  patch({ speaker: !state.speaker });
  void applySpeaker();
}

/** Caméra : l'allumer (même dans un appel commencé en voix), l'éteindre, la rallumer. */
export async function toggleCamera(): Promise<void> {
  if (state.phase === "idle" || state.phase === "ended") return;
  const s = state;
  let track = localStream?.getVideoTracks()[0] ?? null;
  if (!track || track.readyState === "ended") {
    await ensurePermissions(true);
    const cam = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(s.facing, s.group) });
    track = cam.getVideoTracks()[0];
    if (!localStream) localStream = new MediaStream();
    localStream.addTrack(track);
    media.local = localStream;
    patch({ video: true, cameraOn: true, speaker: s.speaker || !s.group });
    if (s.via === "proche") { void startLite(); }
    else {
      for (const [userId, c] of conns) {
        const tr = c.pc.getTransceivers().find((t) => t.receiver.track?.kind === "video");
        if (tr) {
          await tr.sender.replaceTrack(track).catch(() => {});
          tr.direction = "sendrecv";
        } else {
          c.pc.addTrack(track, localStream);
        }
        await renegotiate(userId).catch(() => {});
      }
    }
    void applySpeaker();
    emitMedia();
    broadcastCam(true);
    return;
  }
  const on = !s.cameraOn;
  track.enabled = on;
  patch({ cameraOn: on });
  emitMedia();
  broadcastCam(on);
}

function broadcastCam(on: boolean) {
  if (state.phase === "idle") return;
  if (state.via === "proche") return;
  for (const userId of conns.keys()) void sendSignal(userId, { type: "cam", roomId: state.roomId, on }).catch(() => {});
}

/** Caméra avant / arrière (montrer une pièce, une machine). */
export async function switchCamera(): Promise<void> {
  if (state.phase === "idle" || state.phase === "ended" || !localStream) return;
  const facing = state.facing === "user" ? "environment" : "user";
  const old = localStream.getVideoTracks()[0];
  if (!old) return;
  const cam = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing, state.group) });
  const track = cam.getVideoTracks()[0];
  track.enabled = state.cameraOn;
  for (const c of conns.values()) {
    const sender = c.pc.getSenders().find((x) => x.track?.kind === "video");
    if (sender) await sender.replaceTrack(track).catch(() => {});
  }
  localStream.removeTrack(old);
  old.stop();
  localStream.addTrack(track);
  media.local = localStream;
  patch({ facing });
  emitMedia();
  const after = cur();
  if (after.phase !== "idle" && after.via === "proche") void startLite();
}

// ---- Appel reçu ----
function showIncoming(roomId: string, from: number, name: string, group: boolean, via: Via = "internet", video = false) {
  if (busy() || me?.noCalls) return;   // poste sans appels (Boss)
  incomingCall = true;
  set(baseCall({ phase: "incoming", roomId, group, via, inviterId: from, inviterName: name, video, speaker: group || video,
    participants: [{ userId: from, name, status: "connected" }] }));
  ringIfVisible();
  noAnswerTimer = setTimeout(() => { if (state.phase === "incoming") end("Appel manqué", "missed", false); }, 50000);
}

// Ouverture depuis la notification d'appel (app fermée ou en arrière-plan).
export async function handleLaunchCall(c: { room: string; name?: string; from?: string | number; action?: string; group?: boolean; via?: string; endpoint?: string; mode?: string; video?: boolean }) {
  if (!c.room) return;
  // « ask-12 » : appel du Robot G37 (question de 16h30), pas un appel entre collègues → fenêtre de question.
  if (/^ask-\d+$/.test(c.room)) { openRobotAsk(Number(c.room.slice(4)), true); return; }
  const same = state.phase !== "idle" && state.phase !== "ended" && state.roomId === c.room;
  if (c.via === "proche" || c.via === "wifi") {
    await ensureP2PListeners();
    if (!same) {
      if (busy() || !c.endpoint) return;
      localEndpoint = c.endpoint;
      showIncoming(c.room, Number(c.from) || 0, c.name ?? "Collègue", false, isWifiEndpoint(c.endpoint) ? "wifi" : "proche", !!c.video);
    }
    if (c.action === "answer" && state.phase === "incoming") await acceptCall();
    else if (state.phase === "incoming") void startRingtone();
    return;
  }
  if (same) {
    if (c.action === "answer" && state.phase === "incoming") await acceptCall();
    return;
  }
  const rooms = await listActiveRooms().catch(() => [] as RoomInfo[]);
  const room = rooms.find((r) => r.id === c.room);
  if (!room || room.endedAt) {
    addLog({ id: c.room, peerId: Number(c.from) || 0, peerName: c.name ?? "Collègue", group: !!c.group, video: !!c.video, dir: "in", via: "internet", at: new Date().toISOString(), status: "missed", seconds: 0 });
    return;
  }
  const inviter = room.members.find((m) => m.userId === room.createdBy);
  const video = !!(c.video ?? room.video);
  if (c.action === "answer") {
    incomingCall = true;
    await joinRoom(room.id, { group: room.group, inviterId: room.createdBy, inviterName: inviter?.name ?? c.name ?? "", video }).catch(() => {});
  } else {
    showIncoming(room.id, room.createdBy, inviter?.name ?? c.name ?? "Collègue", room.group, "internet", video);
  }
}

// Au démarrage / retour sur l'app : un appel sonne-t-il pour moi ?
export async function checkRinging() {
  if (!me || busy()) return;
  const rooms = await listActiveRooms().catch(() => [] as RoomInfo[]);
  for (const r of rooms) {
    const mine = r.members.find((m) => m.userId === me!.id);
    if (mine?.status === "ringing") {
      const inviter = r.members.find((m) => m.userId === r.createdBy);
      showIncoming(r.id, r.createdBy, inviter?.name ?? "Collègue", r.group, "internet", !!r.video);
      return;
    }
  }
}

export async function declineFromNotification(roomId: string) {
  await api("g37/call_room", { action: "decline", id: roomId }).catch(() => {});
}

// Signaux Internet (canal temps réel personnel).
export async function onInternetSignal(p: { from: number; fromName: string; data: Record<string, unknown> }) {
  const d = p.data;
  const roomId = String(d.roomId ?? "");
  const name = String(d.name ?? p.fromName ?? "Collègue");
  if (d.type === "invite") {
    if (busy()) return;
    showIncoming(roomId, p.from, name, !!d.group, "internet", !!d.video);
    return;
  }
  if (state.phase === "idle" || state.phase === "ended" || state.roomId !== roomId || state.via !== "internet") return;
  if (d.type === "ended") {
    if (state.phase === "incoming") end("Appel manqué", "missed", false);
  } else if (d.type === "joined") {
    setParticipant(p.from, name, "connecting");
  } else if (d.type === "left") {
    closePeer(p.from);
    if (state.phase === "incoming" && p.from === state.inviterId) { end("Appel manqué", "missed", false); return; }
    setParticipant(p.from, name, "left");
    checkAlone();
  } else if (d.type === "declined") {
    setParticipant(p.from, name, "declined");
    checkAlone();
  } else if (d.type === "offer" && state.phase === "incoming") {
    // offre reçue avant d'avoir répondu : ignorée (l'appelant renverra en rejoignant)
  } else {
    await onRtcSignal(p.from, name, d);
  }
}

// Liaison directe (Wi-Fi local ou Bluetooth), appel à deux sans Internet.
callMessage.on(async ({ endpointId, userId, msg }) => {
  const callId = String(msg.callId ?? "");
  const from = Number(msg.from ?? userId ?? 0);
  const name = String(msg.name ?? "Collègue");
  if (me && msg.to != null && Number(msg.to) !== me.id && (msg.type === "invite" || msg.type === "offer")) return;
  // Appel entrant : « invite » (Wi-Fi, WebRTC) ou « offer » sans mode WebRTC (Bluetooth, voix du téléphone).
  if (msg.type === "invite" || (msg.type === "offer" && msg.mode !== "rtc" && !msg.sdp)) {
    if (state.phase === "incoming" && state.roomId === callId) return; // déjà affiché (repris depuis la notification)
    if (busy()) {
      void sendNearbyMessage(endpointId, { t: "call", type: "busy", callId }).catch(() => {});
      return;
    }
    localEndpoint = endpointId;
    showIncoming(callId, from, name, false, msg.type === "invite" ? "wifi" : "proche", !!msg.video);
    return;
  }
  if (state.phase === "idle" || state.phase === "ended" || state.roomId !== callId || state.via === "internet") return;
  if (msg.type === "vf") {
    if (typeof msg.d === "string") {
      media.lite.set(from || state.inviterId || state.participants[0]?.userId || 0, `data:image/jpeg;base64,${msg.d}`);
      emitMedia();
    }
    void sendNearbyMessage(endpointId, { t: "call", type: "vack", callId }).catch(() => {});
    return;
  }
  if (msg.type === "vack") { liteAck?.(); return; }
  if (msg.type === "answer" && !msg.sdp && state.phase === "outgoing" && state.via === "proche") {
    stopRingback();
    if (noAnswerTimer) clearTimeout(noAnswerTimer);
    try {
      await Nearby.startAudio({ endpointId });
      patch({ phase: "active", startedAt: Date.now(), participants: state.participants.map((p) => ({ ...p, status: "connected" as const })) });
      await applySpeaker();
      const after = cur();
      if (after.phase === "active" && after.video) void startLite();
    } catch (e) {
      end(e instanceof Error ? e.message : "Appel impossible", "failed");
    }
  } else if (msg.type === "hangup") {
    end(state.phase === "incoming" ? "Appel manqué" : "Appel terminé", state.phase === "incoming" ? "missed" : undefined, false);
  } else if (msg.type === "decline") {
    end("Appel refusé", "declined", false);
  } else if (msg.type === "busy") {
    end("Ton collègue est déjà en appel", "failed", false);
  } else if (state.via === "wifi" && state.phase !== "incoming") {
    // WebRTC sur le Wi-Fi local : offre (le collègue a répondu), réponse, candidats réseau, caméra.
    if (msg.type === "offer" && state.phase === "outgoing") {
      stopRingback();
      if (noAnswerTimer) clearTimeout(noAnswerTimer);
      setParticipant(from, name || state.participants[0]?.name || "Collègue", "connecting");
    }
    const peerName = state.participants.find((p) => p.userId === from)?.name ?? name;
    await onRtcSignal(from, peerName, msg).catch((e) => console.warn("Signal Wi-Fi :", e));
  }
});
