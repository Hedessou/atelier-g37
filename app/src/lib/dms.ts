import { useEffect, useState } from "react";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { openDm, sealDm, type DmEnvelope } from "./crypto";
import { newId, onOutboxChange, outbox, type RelayOp } from "./offline";
import { isOnline } from "./net";
import { dmFromRelay } from "./p2p";

// ---------------------------------------------------------------------------
// Messages privés entre deux membres. Le texte est chiffré sur le téléphone de l'expéditeur
// pour les téléphones du destinataire (et les siens) : le serveur et les téléphones relais ne peuvent pas le lire.
// Hors ligne, le message part par la file d'attente et peut être porté par un collègue proche.
// ---------------------------------------------------------------------------

export type Dm = {
  id: string;
  from: number;
  to: number;
  at: string;
  text: string | null;
  // pending : encore sur ce téléphone · sent : arrivé au serveur · received : reçu · unreadable : chiffré pour un autre téléphone
  status: "pending" | "sent" | "received" | "unreadable";
  via?: "proche";
};
type Plain = { text: string; at: string };

const STORE_KEY = "g37.dms";
const READ_KEY = "g37.dmRead";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load(): Dm[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Dm[]) : [];
  } catch {
    return [];
  }
}
function save(list: Dm[]) {
  const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at)).slice(-3000);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sorted));
  } catch (e) {
    console.warn("Messages non gardés :", e);
  }
  emit();
}
function upsert(items: Dm[]) {
  if (!items.length) return;
  const map = new Map(load().map((d) => [d.id, d]));
  for (const it of items) {
    const prev = map.get(it.id);
    // On ne remplace pas un texte lisible par « illisible ».
    if (prev && prev.text && !it.text) map.set(it.id, { ...prev, status: prev.status === "pending" ? it.status : prev.status });
    else map.set(it.id, { ...prev, ...it });
  }
  save([...map.values()]);
}

export function clearDms() {
  localStorage.removeItem(STORE_KEY);
  localStorage.removeItem(READ_KEY);
  emit();
}

const pendingIds = () => new Set(outbox().filter((o) => o.input.action === "dm").map((o) => (o.input as Extract<InputType, { action: "dm" }>).id));

export function allDms(): Dm[] {
  const pend = pendingIds();
  return load().map((d) => (d.status === "pending" && !pend.has(d.id) ? { ...d, status: "sent" } : d));
}

export async function sendDm(opts: {
  state: State; to: number; text: string; save: (input: InputType) => void;
}): Promise<void> {
  const { state, to, text } = opts;
  const me = state.me;
  const devices = (state.devices ?? []).filter((d) => d.userId === to || d.userId === me.id);
  if (!devices.some((d) => d.userId === to)) {
    throw new Error("Ce collègue n'a pas encore ouvert la nouvelle version de l'app avec Internet : la messagerie privée sera possible juste après.");
  }
  const at = new Date().toISOString();
  const envelope = await sealDm({ text, at } satisfies Plain, devices.map((d) => ({ deviceId: d.deviceId, encJwk: d.encJwk })));
  const id = newId("dm").slice(0, 60);
  opts.save({ action: "dm", id, to, envelope: envelope as unknown as Record<string, unknown> });
  upsert([{ id, from: me.id, to, at, text, status: "pending" }]);
}

// Avec Internet : récupère mes messages (chiffrés) et les déchiffre sur ce téléphone.
let refreshing: Promise<void> | null = null;
export function refreshDms(myId: number): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!isOnline()) return;
    let list: Array<{ id: string; from: number; to: number; envelope: DmEnvelope; createdAt: string }>;
    try {
      const res = await fetch("/_api/g37/dms");
      if (!res.ok) return;
      list = (await res.json()).dms ?? [];
    } catch {
      return;
    }
    const known = new Map(load().map((d) => [d.id, d]));
    const items: Dm[] = [];
    for (const m of list) {
      const prev = known.get(m.id);
      if (prev && prev.text && prev.status !== "pending") continue;
      const plain = prev?.text ? null : await openDm<Plain>(m.envelope);
      items.push({
        id: m.id, from: m.from, to: m.to, at: m.createdAt,
        text: prev?.text ?? plain?.text ?? null,
        status: m.from === myId ? "sent" : (prev?.text ?? plain?.text) ? "received" : "unreadable",
      });
    }
    upsert(items);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Message reçu sans Internet (porté par un collègue proche).
dmFromRelay.on(async ({ opPayload }: { opPayload: RelayOp }) => {
  const input = opPayload.input as Extract<InputType, { action: "dm" }>;
  const plain = await openDm<Plain>(input.envelope as unknown as DmEnvelope);
  upsert([{ id: input.id, from: opPayload.userId, to: input.to, at: plain?.at ?? opPayload.clientAt, text: plain?.text ?? null, status: plain ? "received" : "unreadable", via: "proche" }]);
});

// ---- Lu / non lu ----
function readMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}"); } catch { return {}; }
}
export function markRead(peerId: number) {
  const m = readMap();
  m[String(peerId)] = new Date().toISOString();
  localStorage.setItem(READ_KEY, JSON.stringify(m));
  emit();
}
export function unreadFrom(peerId: number, myId: number, list = allDms()): number {
  const since = readMap()[String(peerId)] ?? "";
  return list.filter((d) => d.from === peerId && d.to === myId && d.at > since).length;
}

export function useDms(): Dm[] {
  const [list, setList] = useState<Dm[]>(() => allDms());
  useEffect(() => {
    const refresh = () => setList(allDms());
    listeners.add(refresh);
    const off = onOutboxChange(refresh);
    return () => { listeners.delete(refresh); off(); };
  }, []);
  return list;
}
