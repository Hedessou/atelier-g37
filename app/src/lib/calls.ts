import { newId } from "./offline";
import { isOnline } from "./net";
import { Nearby, nativeSoundsAvailable, nearbyAvailable } from "./nearby";
import { callMessage, getSecrets, peerForUser, sendNearbyMessage } from "./p2p";
import { startRingtone, stopRingtone } from "./sounds";

// ---------------------------------------------------------------------------
// Appels entre collègues
//  - « internet » : salle d'appel (à deux ou en groupe jusqu'à 25), audio direct entre téléphones (WebRTC),
//    mise en relation par le serveur ; on peut rejoindre un appel de groupe en cours.
//  - « proche » : à deux, sans Internet, par Bluetooth / Wi-Fi (Google Nearby).
// ---------------------------------------------------------------------------

export const MAX_PARTICIPANTS = 25;
export type Via = "internet" | "proche";
export type Participant = { userId: number; name: string; status: "ringing" | "connecting" | "connected" | "left" | "declined" };
export type ActiveCall = {
  phase: "outgoing" | "incoming" | "active" | "ended";
  roomId: string; group: boolean; via: Via; inviterId: number; inviterName: string;
  participants: Participant[]; muted: boolean; speaker: boolean; startedAt: number | null; reason?: string;
};
export type CallState = { phase: "idle" } | ActiveCall;
export type CallLog = {
  id: string; peerId: number; peerName: string; group?: boolean; count?: number;
  dir: "in" | "out"; via: Via; at: string; status: "done" | "missed" | "declined" | "failed"; seconds: number;
};
export type RoomInfo = {
  id: string; createdBy: number; group: boolean; title: string | null; createdAt: string; endedAt: string | null;
  members: Array<{ userId: number; name: string; status: "in" | "ringing" | "declined" | "left" | "missed"; joinedAt: string | null }>;
};

type Me = { id: number; displayName: string };
let me: Me | null = null;
export function setCallIdentity(m: Me | null) { me = m; }

let state: CallState = { phase: "idle" };
const listeners = new Set<(s: CallState) => void>();
export const getCallState = () => state;
export function onCallState(l: (s: CallState) => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function set(next: CallState) {
  state = next;
  listeners.forEach((l) => l(state));
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
async function signal(to: number, data: Record<string, unknown>) {
  await fetch("/_api/g37/call_signal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, data }) });
}
export async function listActiveRooms(): Promise<RoomInfo[]> {
  if (!isOnline()) return [];
  const r = await api<{ rooms: RoomInfo[] }>("g37/call_rooms");
  return r.rooms ?? [];
}

// ---- WebRTC : une connexion par collègue présent dans l'appel ----
type PeerConn = { pc: RTCPeerConnection; audio: HTMLAudioElement; ice: RTCIceCandidateInit[] };
const conns = new Map<number, PeerConn>();
let localStream: MediaStream | null = null;
let noAnswerTimer: ReturnType<typeof setTimeout> | null = null;
let nearbyEndpoint: string | null = null;
let incomingCall = false;

async function micStream(): Promise<MediaStream> {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  if (state.phase !== "idle" && state.muted) localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
  return localStream;
}

// Appel de groupe : débit audio réduit pour tenir à 25 sur un réseau mobile.
function tuneSdp(sdp: string | undefined): string {
  if (!sdp) return "";
  const kbps = state.phase !== "idle" && state.participants.length > 3 ? 20000 : 32000;
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (_m, pt, params) =>
    `a=fmtp:${pt} ${String(params).replace(/;?maxaveragebitrate=\d+/, "")};maxaveragebitrate=${kbps}`);
}

function peerConn(userId: number, name: string): PeerConn {
  const existing = conns.get(userId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers: getSecrets()?.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }] });
  const audio = new Audio();
  audio.autoplay = true;
  const c: PeerConn = { pc, audio, ice: [] };
  conns.set(userId, c);
  const roomId = state.phase !== "idle" ? state.roomId : "";
  pc.onicecandidate = (e) => {
    if (e.candidate) void signal(userId, { type: "ice", roomId, candidate: e.candidate.toJSON() }).catch(() => {});
  };
  pc.ontrack = (e) => {
    audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    void audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setParticipant(userId, name, "connected");
      if (state.phase === "outgoing") {
        stopRingback();
        if (noAnswerTimer) clearTimeout(noAnswerTimer);
        patch({ phase: "active", startedAt: Date.now() });
        void applySpeaker();
      }
    }
    if (pc.connectionState === "failed") {
      closePeer(userId);
      setParticipant(userId, name, "left");
      checkAlone();
    }
  };
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream!));
  return c;
}

function closePeer(userId: number) {
  const c = conns.get(userId);
  if (!c) return;
  conns.delete(userId);
  try { c.pc.close(); } catch { /* déjà fermé */ }
  c.audio.srcObject = null;
}

async function flushIce(c: PeerConn) {
  if (!c.pc.remoteDescription) return;
  const list = c.ice;
  c.ice = [];
  for (const cand of list) await c.pc.addIceCandidate(cand).catch(() => {});
}

async function offerTo(userId: number, name: string) {
  const c = peerConn(userId, name);
  setParticipant(userId, name, "connecting");
  const offer = await c.pc.createOffer({ offerToReceiveAudio: true });
  await c.pc.setLocalDescription({ type: "offer", sdp: tuneSdp(offer.sdp) });
  await signal(userId, { type: "offer", roomId: state.phase !== "idle" ? state.roomId : "", sdp: tuneSdp(offer.sdp), name: me?.displayName });
}

function cleanup() {
  stopRingback();
  void stopRingtone();
  if (noAnswerTimer) clearTimeout(noAnswerTimer);
  noAnswerTimer = null;
  [...conns.keys()].forEach(closePeer);
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  if (nearbyAvailable()) {
    void Nearby.stopAudio().catch(() => {});
    void nativeSoundsAvailable().then((ok) => { if (ok) void Nearby.resetAudio().catch(() => {}); });
  }
  nearbyEndpoint = null;
}

function end(reason: string, status?: CallLog["status"], notify = true) {
  if (state.phase === "idle" || state.phase === "ended") return;
  const s = state;
  if (notify) {
    if (s.via === "proche" && nearbyEndpoint) void sendNearbyMessage(nearbyEndpoint, { t: "call", type: "hangup", callId: s.roomId }).catch(() => {});
    else if (s.via === "internet" && s.phase !== "incoming") void api("g37/call_room", { action: "leave", id: s.roomId }).catch(() => {});
  }
  const others = s.participants.filter((p) => p.userId !== me?.id);
  const first = incomingCall ? { userId: s.inviterId, name: s.inviterName } : others[0] ?? { userId: 0, name: "Collègue" };
  const seconds = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
  addLog({
    id: s.roomId, peerId: first.userId, peerName: s.group ? `Groupe · ${first.name}` : first.name, group: s.group, count: others.length,
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

// ---- Actions ----
export async function startCall(peerId: number, peerName: string): Promise<void> {
  if (!me) throw new Error("Session non prête");
  if (busy()) throw new Error("Un appel est déjà en cours");
  const peer = nearbyAvailable() ? peerForUser(peerId) : null;
  if (peer && !isOnline()) {
    const perm = await Nearby.requestNearbyPermissions({ microphone: true });
    if (!perm.microphone) throw new Error("Autorise le micro pour appeler.");
    const roomId = newId("call").slice(0, 50);
    incomingCall = false;
    nearbyEndpoint = peer.endpointId;
    set({ phase: "outgoing", roomId, group: false, via: "proche", inviterId: me.id, inviterName: me.displayName,
      participants: [{ userId: peerId, name: peerName, status: "ringing" }], muted: false, speaker: false, startedAt: null });
    await sendNearbyMessage(peer.endpointId, { t: "call", type: "offer", callId: roomId, from: me.id, name: me.displayName });
    ringback();
    noAnswerTimer = setTimeout(() => { if (state.phase === "outgoing") end("Pas de réponse", "failed"); }, 45000);
    return;
  }
  await startRoom([{ userId: peerId, name: peerName }], false);
}

export async function startGroupCall(people: Array<{ userId: number; name: string }>): Promise<void> {
  if (people.length + 1 > MAX_PARTICIPANTS) throw new Error(`${MAX_PARTICIPANTS} personnes au maximum.`);
  await startRoom(people, true);
}

async function startRoom(people: Array<{ userId: number; name: string }>, group: boolean) {
  if (!me) throw new Error("Session non prête");
  if (busy()) throw new Error("Un appel est déjà en cours");
  if (!isOnline()) throw new Error("Pas d'Internet : l'appel de groupe a besoin d'Internet (ou du même Wi-Fi avec Internet).");
  const roomId = newId("room").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  incomingCall = false;
  set({ phase: "outgoing", roomId, group, via: "internet", inviterId: me.id, inviterName: me.displayName,
    participants: people.map((p) => ({ ...p, status: "ringing" as const })), muted: false, speaker: group, startedAt: null });
  try {
    await micStream();
    await api("g37/call_room", { action: "create", id: roomId, invite: people.map((p) => p.userId), group });
  } catch (e) {
    cleanup();
    set({ phase: "idle" });
    throw e;
  }
  ringback();
  noAnswerTimer = setTimeout(() => {
    if (state.phase === "outgoing") end("Pas de réponse", "failed");
  }, 50000);
}

// Rejoindre (répondre à une invitation ou entrer dans un appel de groupe en cours).
export async function joinRoom(roomId: string, info?: { group?: boolean; inviterId?: number; inviterName?: string }): Promise<void> {
  if (!me) throw new Error("Session non prête");
  if (busy() && !(state.phase === "incoming" && state.roomId === roomId)) throw new Error("Un appel est déjà en cours");
  void stopRingtone();
  if (noAnswerTimer) clearTimeout(noAnswerTimer);
  const prev = state.phase !== "idle" ? state : null;
  set({ phase: "active", roomId, group: info?.group ?? prev?.group ?? true, via: "internet",
    inviterId: info?.inviterId ?? prev?.inviterId ?? 0, inviterName: info?.inviterName ?? prev?.inviterName ?? "",
    participants: [], muted: false, speaker: info?.group ?? prev?.group ?? true, startedAt: Date.now() });
  try {
    await micStream();
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

export async function acceptCall(): Promise<void> {
  if (state.phase !== "incoming") return;
  const s = state;
  void stopRingtone();
  try {
    if (s.via === "proche") {
      const perm = await Nearby.requestNearbyPermissions({ microphone: true });
      if (!perm.microphone || !nearbyEndpoint) throw new Error("Autorise le micro pour répondre.");
      await sendNearbyMessage(nearbyEndpoint, { t: "call", type: "answer", callId: s.roomId });
      await Nearby.startAudio({ endpointId: nearbyEndpoint });
      patch({ phase: "active", startedAt: Date.now() });
    } else {
      await joinRoom(s.roomId, { group: s.group, inviterId: s.inviterId, inviterName: s.inviterName });
    }
  } catch (e) {
    if (state.phase !== "ended" && state.phase !== "idle") end(e instanceof Error ? e.message : "Appel impossible", "failed");
  }
}

export function declineCall() {
  if (state.phase !== "incoming") return;
  const s = state;
  if (s.via === "proche" && nearbyEndpoint) void sendNearbyMessage(nearbyEndpoint, { t: "call", type: "decline", callId: s.roomId }).catch(() => {});
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
  if (state.phase !== "idle" && state.roomId === roomId) {
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

// ---- Appel reçu ----
function showIncoming(roomId: string, from: number, name: string, group: boolean) {
  if (busy()) return;
  incomingCall = true;
  set({ phase: "incoming", roomId, group, via: "internet", inviterId: from, inviterName: name,
    participants: [{ userId: from, name, status: "connected" }], muted: false, speaker: group, startedAt: null });
  void startRingtone();
  noAnswerTimer = setTimeout(() => { if (state.phase === "incoming") end("Appel manqué", "missed", false); }, 50000);
}

// Ouverture depuis la notification d'appel (app fermée).
export async function handleLaunchCall(c: { room: string; name?: string; from?: string; action?: string; group?: boolean }) {
  if (!c.room || (state.phase !== "idle" && state.phase !== "ended" && state.roomId === c.room)) return;
  const rooms = await listActiveRooms().catch(() => [] as RoomInfo[]);
  const room = rooms.find((r) => r.id === c.room);
  if (!room || room.endedAt) {
    addLog({ id: c.room, peerId: Number(c.from) || 0, peerName: c.name ?? "Collègue", group: !!c.group, dir: "in", via: "internet", at: new Date().toISOString(), status: "missed", seconds: 0 });
    return;
  }
  const inviter = room.members.find((m) => m.userId === room.createdBy);
  if (c.action === "answer") {
    incomingCall = true;
    await joinRoom(room.id, { group: room.group, inviterId: room.createdBy, inviterName: inviter?.name ?? c.name ?? "" }).catch(() => {});
  } else {
    showIncoming(room.id, room.createdBy, inviter?.name ?? c.name ?? "Collègue", room.group);
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
      showIncoming(r.id, r.createdBy, inviter?.name ?? "Collègue", r.group);
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
    showIncoming(roomId, p.from, name, !!d.group);
    return;
  }
  if (state.phase === "idle" || state.phase === "ended" || state.roomId !== roomId) return;
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
  } else if (d.type === "offer" && state.phase !== "incoming") {
    const c = peerConn(p.from, name);
    setParticipant(p.from, name, "connecting");
    await c.pc.setRemoteDescription({ type: "offer", sdp: String(d.sdp ?? "") });
    const answer = await c.pc.createAnswer();
    await c.pc.setLocalDescription({ type: "answer", sdp: tuneSdp(answer.sdp) });
    await signal(p.from, { type: "answer", roomId, sdp: tuneSdp(answer.sdp) });
    await flushIce(c);
  } else if (d.type === "answer") {
    const c = conns.get(p.from);
    if (c) {
      await c.pc.setRemoteDescription({ type: "answer", sdp: String(d.sdp ?? "") });
      await flushIce(c);
    }
  } else if (d.type === "ice" && d.candidate) {
    const c = conns.get(p.from) ?? peerConn(p.from, name);
    c.ice.push(d.candidate as RTCIceCandidateInit);
    await flushIce(c);
  }
}

// Proximité (messages Nearby), appel à deux sans Internet.
callMessage.on(async ({ endpointId, userId, msg }) => {
  const callId = String(msg.callId ?? "");
  if (msg.type === "offer") {
    if (busy()) {
      void sendNearbyMessage(endpointId, { t: "call", type: "busy", callId }).catch(() => {});
      return;
    }
    incomingCall = true;
    nearbyEndpoint = endpointId;
    const from = Number(msg.from ?? userId ?? 0);
    const name = String(msg.name ?? "Collègue");
    set({ phase: "incoming", roomId: callId, group: false, via: "proche", inviterId: from, inviterName: name,
      participants: [{ userId: from, name, status: "connected" }], muted: false, speaker: false, startedAt: null });
    void startRingtone();
    noAnswerTimer = setTimeout(() => { if (state.phase === "incoming") end("Appel manqué", "missed", false); }, 45000);
    return;
  }
  if (state.phase === "idle" || state.phase === "ended" || state.roomId !== callId) return;
  if (msg.type === "answer" && state.phase === "outgoing") {
    stopRingback();
    if (noAnswerTimer) clearTimeout(noAnswerTimer);
    try {
      await Nearby.startAudio({ endpointId });
      patch({ phase: "active", startedAt: Date.now(), participants: state.participants.map((p) => ({ ...p, status: "connected" as const })) });
    } catch (e) {
      end(e instanceof Error ? e.message : "Appel impossible", "failed");
    }
  } else if (msg.type === "hangup") {
    end(state.phase === "incoming" ? "Appel manqué" : "Appel terminé", state.phase === "incoming" ? "missed" : undefined, false);
  } else if (msg.type === "decline") {
    end("Appel refusé", "declined", false);
  } else if (msg.type === "busy") {
    end("Ton collègue est déjà en appel", "failed", false);
  }
});
