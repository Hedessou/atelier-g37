import { useEffect, useState } from "react";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Capacitor } from "@capacitor/core";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { postG37Upload } from "../endpoints/g37/upload_POST.schema";
import { b64u, fromB64, fromB64u, openDm, sealDm, toB64, type DmEnvelope } from "./crypto";
import { newId, onOutboxChange, outbox, type RelayOp } from "./offline";
import { isOnline } from "./net";
import { dmFromRelay } from "./p2p";

// ---------------------------------------------------------------------------
// Messagerie privée (façon WhatsApp) entre deux membres : texte, photos, notes vocales, fichiers, réponses.
// Tout est chiffré sur le téléphone de l'expéditeur pour les téléphones du destinataire (et les siens) :
// le serveur et les téléphones relais ne peuvent rien lire.
// Hors ligne, le message part par la file d'attente et peut être porté par un collègue proche (Bluetooth / Wi-Fi).
// Pièces jointes : petites (≤ 40 Ko) dans le message lui-même (marche sans Internet),
// plus lourdes : chiffrées puis déposées sur le serveur (Internet nécessaire).
// ---------------------------------------------------------------------------

export type DmAttachment = {
  kind: "image" | "audio" | "file";
  mime: string; name: string; size: number; dur?: number;
  w?: number; h?: number;
  // contenu inclus (petit) : rangé dans un fichier du téléphone, pas dans la liste des messages
  data?: string; stored?: boolean;
  // contenu sur le serveur, chiffré (clé k, vecteur iv)
  key?: string; k?: string; iv?: string;
  thumb?: string; // aperçu d'image (petit JPEG en base64)
};
export type DmReply = { id: string; from: number; text: string };

export type Dm = {
  id: string;
  from: number;
  to: number;
  at: string;
  text: string | null;
  // pending : encore sur ce téléphone · sent : arrivé au serveur · received : reçu · unreadable : chiffré pour un autre téléphone
  status: "pending" | "sent" | "received" | "unreadable";
  via?: "proche";
  att?: DmAttachment;
  reply?: DmReply;
};
type Plain = { text: string; at: string; att?: DmAttachment; reply?: DmReply };

const STORE_KEY = "g37.dms";
const READ_KEY = "g37.dmRead";
const HIDDEN_KEY = "g37.dmHidden";
export const INLINE_MAX = 40 * 1024;
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

// Contenu des pièces jointes incluses : un fichier par message (la liste reste légère).
const attPath = (id: string) => `g37dm/${id.replace(/[^A-Za-z0-9_-]/g, "_")}.b64`;
const memAtt = new Map<string, string>();
async function storeAtt(id: string, data: string) {
  memAtt.set(id, data);
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Filesystem.writeFile({ path: attPath(id), data, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
    memAtt.delete(id);
  } catch (e) {
    console.warn("Pièce jointe gardée en mémoire seulement :", e);
  }
}
async function readAtt(id: string): Promise<string | null> {
  if (memAtt.has(id)) return memAtt.get(id)!;
  try {
    const r = await Filesystem.readFile({ path: attPath(id), directory: Directory.Data, encoding: Encoding.UTF8 });
    return typeof r.data === "string" ? r.data : null;
  } catch {
    return null;
  }
}

async function upsert(items: Dm[]) {
  if (!items.length) return;
  // Le contenu des pièces jointes ne reste pas dans la liste.
  for (const it of items) {
    if (it.att?.data) {
      await storeAtt(it.id, it.att.data);
      it.att = { ...it.att, data: undefined, stored: true };
    }
  }
  const map = new Map(load().map((d) => [d.id, d]));
  for (const it of items) {
    const prev = map.get(it.id);
    // On ne remplace pas un texte lisible par « illisible ».
    if (prev && prev.text != null && it.text == null) map.set(it.id, { ...prev, status: prev.status === "pending" ? it.status : prev.status });
    else map.set(it.id, { ...prev, ...it });
  }
  save([...map.values()]);
}

export function clearDms() {
  localStorage.removeItem(STORE_KEY);
  localStorage.removeItem(READ_KEY);
  localStorage.removeItem(HIDDEN_KEY);
  emit();
}

const pendingIds = () => new Set(outbox().filter((o) => o.input.action === "dm").map((o) => (o.input as Extract<InputType, { action: "dm" }>).id));

function hiddenSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}
/** Supprimer pour moi (le message reste chez le collègue). */
export function hideDm(id: string) {
  const s = hiddenSet();
  s.add(id);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s].slice(-2000))); } catch { /* plein */ }
  void Filesystem.deleteFile({ path: attPath(id), directory: Directory.Data }).catch(() => {});
  emit();
}

export function allDms(): Dm[] {
  const pend = pendingIds();
  const hidden = hiddenSet();
  return load().filter((d) => !hidden.has(d.id)).map((d) => (d.status === "pending" && !pend.has(d.id) ? { ...d, status: "sent" } : d));
}

const recipientsOf = (state: State, to: number) => (state.devices ?? []).filter((d) => d.userId === to || d.userId === state.me.id);

export function canWriteTo(state: State, to: number): boolean {
  return (state.devices ?? []).some((d) => d.userId === to);
}

export async function sendDm(opts: {
  state: State; to: number; text: string; save: (input: InputType) => void; att?: DmAttachment; reply?: DmReply;
}): Promise<void> {
  const { state, to, text } = opts;
  const me = state.me;
  const devices = recipientsOf(state, to);
  if (!devices.some((d) => d.userId === to)) {
    throw new Error("Ce collègue n'a pas encore ouvert la nouvelle version de l'app avec Internet : la messagerie privée sera possible juste après.");
  }
  const at = new Date().toISOString();
  const plain: Plain = { text, at, ...(opts.att ? { att: opts.att } : {}), ...(opts.reply ? { reply: opts.reply } : {}) };
  const envelope = await sealDm(plain, devices.map((d) => ({ deviceId: d.deviceId, encJwk: d.encJwk })));
  const id = newId("dm").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  opts.save({ action: "dm", id, to, envelope: envelope as unknown as Record<string, unknown> });
  await upsert([{ id, from: me.id, to, at, text, status: "pending", att: opts.att ? { ...opts.att } : undefined, reply: opts.reply }]);
}

// ---------- Pièces jointes ----------
async function blobToB64(b: Blob): Promise<string> {
  return toB64(new Uint8Array(await b.arrayBuffer()));
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image illisible")); };
    img.src = url;
  });
}

async function jpeg(img: HTMLImageElement, maxSide: number, quality: number): Promise<{ blob: Blob; w: number; h: number }> {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Compression impossible"))), "image/jpeg", quality));
  return { blob, w, h };
}

async function encryptBlob(b: Blob): Promise<{ cipher: Blob; k: string; iv: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await b.arrayBuffer());
  return { cipher: new Blob([ct], { type: "application/octet-stream" }), k: b64u(raw), iv: b64u(iv) };
}

async function uploadEncrypted(b: Blob): Promise<{ key: string; k: string; iv: string }> {
  const { cipher, k, iv } = await encryptBlob(b);
  const up = await postG37Upload({ fileName: "dm.bin", contentType: "application/octet-stream", sizeBytes: cipher.size });
  const put = await fetch(up.presignedUrl, { method: "PUT", headers: up.headers, body: cipher });
  if (!put.ok) throw new Error("Le transfert du fichier a échoué.");
  return { key: up.fileKey, k, iv };
}

/** Prépare une photo : incluse dans le message si possible (marche sans Internet), sinon déposée chiffrée. */
export async function prepareImage(file: Blob, name = "photo.jpg"): Promise<DmAttachment> {
  const img = await loadImage(file);
  // Version légère d'abord (passe partout, même par Bluetooth).
  for (const [side, q] of [[1024, 0.6], [800, 0.55], [640, 0.5], [480, 0.45]] as Array<[number, number]>) {
    const r = await jpeg(img, side, q);
    if (r.blob.size <= INLINE_MAX) {
      if (!isOnline() || side >= 800) return { kind: "image", mime: "image/jpeg", name, size: r.blob.size, w: r.w, h: r.h, data: await blobToB64(r.blob) };
      break;
    }
  }
  if (!isOnline()) {
    const r = await jpeg(img, 400, 0.4);
    return { kind: "image", mime: "image/jpeg", name, size: r.blob.size, w: r.w, h: r.h, data: await blobToB64(r.blob) };
  }
  const big = await jpeg(img, 1600, 0.75);
  const thumb = await jpeg(img, 160, 0.5);
  const up = await uploadEncrypted(big.blob);
  return { kind: "image", mime: "image/jpeg", name, size: big.blob.size, w: big.w, h: big.h, ...up, thumb: await blobToB64(thumb.blob) };
}

export async function prepareAudio(blob: Blob, seconds: number): Promise<DmAttachment> {
  const mime = blob.type || "audio/webm";
  const base = { kind: "audio" as const, mime, name: "note-vocale", size: blob.size, dur: Math.round(seconds) };
  if (blob.size <= INLINE_MAX * 2.5 && (!isOnline() || blob.size <= INLINE_MAX)) return { ...base, data: await blobToB64(blob) };
  if (!isOnline()) throw new Error("Note vocale trop longue pour partir sans Internet (30 s maximum).");
  return { ...base, ...(await uploadEncrypted(blob)) };
}

export async function prepareFile(file: File): Promise<DmAttachment> {
  const base = { kind: "file" as const, mime: file.type || "application/octet-stream", name: file.name.slice(0, 120), size: file.size };
  if (file.size <= INLINE_MAX) return { ...base, data: await blobToB64(file) };
  if (!isOnline()) throw new Error("Fichier trop lourd pour partir sans Internet (40 Ko maximum).");
  if (file.size > 15 * 1024 * 1024) throw new Error("Fichier trop lourd (15 Mo maximum).");
  return { ...base, ...(await uploadEncrypted(file)) };
}

// Ouverture : renvoie une adresse locale (blob:) du contenu déchiffré.
const blobCache = new Map<string, string>();
export async function attachmentUrl(dm: Dm): Promise<string | null> {
  if (!dm.att) return null;
  if (blobCache.has(dm.id)) return blobCache.get(dm.id)!;
  const a = dm.att;
  let bytes: Uint8Array | null = null;
  if (a.stored || a.data) {
    const data = a.data ?? (await readAtt(dm.id));
    if (data) bytes = fromB64(data);
  } else if (a.key && a.k && a.iv) {
    if (!isOnline()) return null;
    const res = await fetch("/_api/g37/file_urls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: [a.key] }) });
    if (!res.ok) return null;
    const url = ((await res.json()) as { urls?: Record<string, string> }).urls?.[a.key];
    if (!url) return null;
    const cipher = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const key = await crypto.subtle.importKey("raw", fromB64u(a.k), "AES-GCM", false, ["decrypt"]);
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(a.iv) }, key, cipher));
  }
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: a.mime }));
  blobCache.set(dm.id, url);
  return url;
}

// ---------- Réception ----------
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
      if (prev && prev.text != null && prev.status !== "pending") continue;
      const plain = prev?.text != null ? null : await openDm<Plain>(m.envelope);
      const text = prev?.text ?? plain?.text ?? null;
      items.push({
        id: m.id, from: m.from, to: m.to, at: m.createdAt, text,
        status: m.from === myId ? "sent" : text != null ? "received" : "unreadable",
        ...(plain?.att ? { att: plain.att } : {}), ...(plain?.reply ? { reply: plain.reply } : {}),
      });
    }
    await upsert(items);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Message reçu sans Internet (porté par un collègue proche).
dmFromRelay.on(async ({ opPayload }: { opPayload: RelayOp }) => {
  const input = opPayload.input as Extract<InputType, { action: "dm" }>;
  const plain = await openDm<Plain>(input.envelope as unknown as DmEnvelope);
  await upsert([{
    id: input.id, from: opPayload.userId, to: input.to, at: plain?.at ?? opPayload.clientAt, text: plain?.text ?? null,
    status: plain ? "received" : "unreadable", via: "proche",
    ...(plain?.att ? { att: plain.att } : {}), ...(plain?.reply ? { reply: plain.reply } : {}),
  }]);
  if (plain) newMessage.forEach((l) => l({ from: opPayload.userId }));
});

// Prévenir l'écran (son « message » quand l'app est ouverte).
const newMessage = new Set<(e: { from: number }) => void>();
export function onNewDm(l: (e: { from: number }) => void) {
  newMessage.add(l);
  return () => { newMessage.delete(l); };
}

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

export const previewOf = (d: Dm): string => {
  if (d.att?.kind === "image") return `📷 ${d.text || "Photo"}`;
  if (d.att?.kind === "audio") return `🎤 Note vocale${d.att.dur ? ` (${Math.floor(d.att.dur / 60)}:${String(d.att.dur % 60).padStart(2, "0")})` : ""}`;
  if (d.att?.kind === "file") return `📎 ${d.att.name}`;
  return d.text ?? "";
};

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
