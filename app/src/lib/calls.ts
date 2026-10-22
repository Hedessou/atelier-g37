import { newId } from "./offline";
import { isOnline } from "./net";
import { Nearby, nearbyAvailable } from "./nearby";
import { callMessage, getSecrets, peerForUser, sendNearbyMessage } from "./p2p";

// ---------------------------------------------------------------------------
// Appels entre collègues
//  - « proche » : sans Internet, par Bluetooth / Wi-Fi (Google Nearby), qualité talkie-walkie, ~10 à 100 m ;
//  - « internet » : appel WebRTC, signalisation par le serveur.
// La voie « proche » est choisie quand le collègue est à portée.
// ---------------------------------------------------------------------------

export type Via = "internet" | "proche";
export type CallState =
  | { phase: "idle" }
  | {
      phase: "outgoing" | "incoming" | "active" | "ended";
      callId: string; peerId: number; peerName: string; via: Via;
      muted: boolean; speaker: boolean; startedAt: number | null; reason?: string;
    };
export type CallLog = { id: string; peerId: number; peerName: string; dir: "in" | "out"; via: Via; at: string; status: "done" | "missed" | "declined" | "failed"; seconds: number };

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
function patch(p: Partial<Extract<CallState, { phase: "active" }>>) {
  if (state.phase === "idle") return;
  set({ ...state, ...p } as CallState);
}

// ---- Journal des appels (sur ce téléphone) ----
const LOG_KEY = "g37.calls";
export function callLog(): CallLog[] {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as CallLog[]; } catch { return []; }
}
function addLog(entry: CallLog) {
  const list = [entry, ...callLog().filter((c) => c.id !== entry.id)].slice(0, 200);
  localStorage.setItem(LOG_KEY, JSON.stringify(list));
  listeners.forEach((l) => l(state));
}

// ---- Sonnerie ----
let ringTimer: ReturnType<typeof setInterval> | null = null;
let ringCtx: AudioContext | null = null;
function ring(incoming: boolean) {
  stopRing();
  const beep = () => {
    try {
      ringCtx = ringCtx ?? new AudioContext();
      const t0 = ringCtx.currentTime;
      [0, 0.35].forEach((off) => {
        const osc = ringCtx!.createOscillator();
        const gain = ringCtx!.createGain();
        osc.frequency.value = incoming ? 880 : 440;
        osc.connect(gain);
        gain.connect(ringCtx!.destination);
        gain.gain.setValueAtTime(0.0001, t0 + off);
        gain.gain.exponentialRampToValueAtTime(incoming ? 0.35 : 0.12, t0 + off + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.3);
        osc.start(t0 + off);
        osc.stop(t0 + off + 0.32);
      });
      if (incoming && navigator.vibrate) navigator.vibrate([400, 200, 400]);
    } catch { /* son refusé */ }
  };
  beep();
  ringTimer = setInterval(beep, incoming ? 2000 : 3000);
}
function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

// ---- WebRTC (Internet) ----
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let remoteAudio: HTMLAudioElement | null = null;
let pendingOffer: string | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let nearbyEndpoint: string | null = null;
let noAnswerTimer: ReturnType<typeof setTimeout> | null = null;

async function signal(to: number, data: Record<string, unknown>) {
  await fetch("/_api/g37/call_signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, data }),
  });
}

async function micStream(): Promise<MediaStream> {
  return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}

function newPeerConnection(peerId: number, callId: string): RTCPeerConnection {
  const conn = new RTCPeerConnection({ iceServers: getSecrets()?.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }] });
  conn.onicecandidate = (e) => {
    if (e.candidate) void signal(peerId, { type: "ice", callId, candidate: e.candidate.toJSON() }).catch(() => {});
  };
  conn.ontrack = (e) => {
    if (!remoteAudio) {
      remoteAudio = new Audio();
      remoteAudio.autoplay = true;
    }
    remoteAudio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    void remoteAudio.play().catch(() => {});
  };
  conn.onconnectionstatechange = () => {
    if (conn.connectionState === "connected" && state.phase !== "idle" && state.phase !== "active") {
      stopRing();
      patch({ phase: "active", startedAt: Date.now() });
    }
    if (conn.connectionState === "failed") end("Connexion perdue", true);
  };
  return conn;
}

async function flushIce() {
  if (!pc || !pc.remoteDescription) return;
  const list = pendingIce;
  pendingIce = [];
  for (const c of list) await pc.addIceCandidate(c).catch(() => {});
}

function cleanup() {
  stopRing();
  if (noAnswerTimer) clearTimeout(noAnswerTimer);
  noAnswerTimer = null;
  try { pc?.close(); } catch { /* déjà fermé */ }
  pc = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio = null; }
  pendingOffer = null;
  pendingIce = [];
  if (nearbyAvailable()) void Nearby.stopAudio().catch(() => {});
  nearbyEndpoint = null;
}

function end(reason: string, notifyPeer: boolean, status?: CallLog["status"]) {
  if (state.phase === "idle" || state.phase === "ended") return;
  const s = state;
  if (notifyPeer) {
    if (s.via === "proche" && nearbyEndpoint) void sendNearbyMessage(nearbyEndpoint, { t: "call", type: "hangup", callId: s.callId }).catch(() => {});
    else if (s.via === "internet") void signal(s.peerId, { type: "hangup", callId: s.callId }).catch(() => {});
  }
  const seconds = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
  addLog({
    id: s.callId, peerId: s.peerId, peerName: s.peerName, dir: s.phase === "incoming" || (s.phase === "active" && incomingCall) ? "in" : "out",
    via: s.via, at: new Date().toISOString(),
    status: status ?? (s.startedAt ? "done" : s.phase === "incoming" ? "missed" : "failed"), seconds,
  });
  cleanup();
  set({ ...s, phase: "ended", reason });
  setTimeout(() => { if (state.phase === "ended") set({ phase: "idle" }); }, 2500);
}
let incomingCall = false;

// ---- Actions ----
export async function startCall(peerId: number, peerName: string): Promise<void> {
  if (!me) throw new Error("Session non prête");
  if (state.phase !== "idle" && state.phase !== "ended") throw new Error("Un appel est déjà en cours");
  const callId = newId("call").slice(0, 50);
  incomingCall = false;
  const peer = nearbyAvailable() ? peerForUser(peerId) : null;
  if (peer) {
    const perm = await Nearby.requestNearbyPermissions({ microphone: true });
    if (!perm.microphone) throw new Error("Autorise le micro pour appeler.");
    nearbyEndpoint = peer.endpointId;
    set({ phase: "outgoing", callId, peerId, peerName, via: "proche", muted: false, speaker: false, startedAt: null });
    await sendNearbyMessage(peer.endpointId, { t: "call", type: "offer", callId, from: me.id, name: me.displayName });
  } else {
    if (!isOnline()) throw new Error(`${peerName} n'est pas à portée et il n'y a pas d'Internet.`);
    localStream = await micStream();
    pc = newPeerConnection(peerId, callId);
    localStream.getTracks().forEach((t) => pc!.addTrack(t, localStream!));
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    set({ phase: "outgoing", callId, peerId, peerName, via: "internet", muted: false, speaker: false, startedAt: null });
    await signal(peerId, { type: "offer", callId, sdp: offer.sdp, name: me.displayName });
  }
  ring(false);
  noAnswerTimer = setTimeout(() => { if (state.phase === "outgoing") end("Pas de réponse", true, "failed"); }, 45000);
}

export async function acceptCall(): Promise<void> {
  if (state.phase !== "incoming") return;
  const s = state;
  stopRing();
  try {
    if (s.via === "proche") {
      const perm = await Nearby.requestNearbyPermissions({ microphone: true });
      if (!perm.microphone || !nearbyEndpoint) throw new Error("Autorise le micro pour répondre.");
      await sendNearbyMessage(nearbyEndpoint, { t: "call", type: "answer", callId: s.callId });
      await Nearby.startAudio({ endpointId: nearbyEndpoint });
      patch({ phase: "active", startedAt: Date.now() });
    } else {
      if (!pendingOffer) throw new Error("Appel expiré");
      localStream = await micStream();
      pc = newPeerConnection(s.peerId, s.callId);
      localStream.getTracks().forEach((t) => pc!.addTrack(t, localStream!));
      await pc.setRemoteDescription({ type: "offer", sdp: pendingOffer });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await signal(s.peerId, { type: "answer", callId: s.callId, sdp: answer.sdp });
      await flushIce();
      patch({ phase: "active", startedAt: Date.now() });
    }
  } catch (e) {
    end(e instanceof Error ? e.message : "Appel impossible", true, "failed");
  }
}

export function declineCall() {
  if (state.phase !== "incoming") return;
  const s = state;
  if (s.via === "proche" && nearbyEndpoint) void sendNearbyMessage(nearbyEndpoint, { t: "call", type: "decline", callId: s.callId }).catch(() => {});
  else void signal(s.peerId, { type: "decline", callId: s.callId }).catch(() => {});
  end("Appel refusé", false, "declined");
}

export function hangUp() {
  end("Appel terminé", true);
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
  const speaker = !state.speaker;
  if (state.via === "proche") void Nearby.setSpeaker({ on: speaker }).catch(() => {});
  patch({ speaker });
}

// ---- Signaux reçus ----
// Internet (canal temps réel de l'utilisateur)
export async function onInternetSignal(p: { from: number; fromName: string; data: Record<string, unknown> }) {
  const d = p.data;
  const callId = String(d.callId ?? "");
  if (d.type === "offer") {
    if (state.phase !== "idle" && state.phase !== "ended") {
      void signal(p.from, { type: "busy", callId }).catch(() => {});
      return;
    }
    incomingCall = true;
    pendingOffer = String(d.sdp ?? "");
    pendingIce = [];
    set({ phase: "incoming", callId, peerId: p.from, peerName: String(d.name ?? p.fromName), via: "internet", muted: false, speaker: false, startedAt: null });
    ring(true);
    noAnswerTimer = setTimeout(() => { if (state.phase === "incoming") end("Appel manqué", false, "missed"); }, 45000);
    return;
  }
  if (state.phase === "idle" || state.phase === "ended" || state.callId !== callId) return;
  if (d.type === "answer" && pc) {
    await pc.setRemoteDescription({ type: "answer", sdp: String(d.sdp ?? "") });
    await flushIce();
    stopRing();
  } else if (d.type === "ice" && d.candidate) {
    pendingIce.push(d.candidate as RTCIceCandidateInit);
    await flushIce();
  } else if (d.type === "hangup") {
    end(state.phase === "incoming" ? "Appel manqué" : "Appel terminé", false, state.phase === "incoming" ? "missed" : undefined);
  } else if (d.type === "decline") {
    end("Appel refusé", false, "declined");
  } else if (d.type === "busy") {
    end("Ton collègue est déjà en appel", false, "failed");
  }
}

// Proximité (messages Nearby)
callMessage.on(async ({ endpointId, userId, msg }) => {
  const callId = String(msg.callId ?? "");
  if (msg.type === "offer") {
    if (state.phase !== "idle" && state.phase !== "ended") {
      void sendNearbyMessage(endpointId, { t: "call", type: "busy", callId }).catch(() => {});
      return;
    }
    incomingCall = true;
    nearbyEndpoint = endpointId;
    set({ phase: "incoming", callId, peerId: Number(msg.from ?? userId ?? 0), peerName: String(msg.name ?? "Collègue"), via: "proche", muted: false, speaker: false, startedAt: null });
    ring(true);
    noAnswerTimer = setTimeout(() => { if (state.phase === "incoming") end("Appel manqué", false, "missed"); }, 45000);
    return;
  }
  if (state.phase === "idle" || state.phase === "ended" || state.callId !== callId) return;
  if (msg.type === "answer" && state.phase === "outgoing") {
    stopRing();
    try {
      await Nearby.startAudio({ endpointId });
      patch({ phase: "active", startedAt: Date.now() });
    } catch (e) {
      end(e instanceof Error ? e.message : "Appel impossible", true, "failed");
    }
  } else if (msg.type === "hangup") {
    end(state.phase === "incoming" ? "Appel manqué" : "Appel terminé", false, state.phase === "incoming" ? "missed" : undefined);
  } else if (msg.type === "decline") {
    end("Appel refusé", false, "declined");
  } else if (msg.type === "busy") {
    end("Ton collègue est déjà en appel", false, "failed");
  }
});
