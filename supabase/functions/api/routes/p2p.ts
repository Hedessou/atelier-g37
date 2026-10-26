// deno-lint-ignore-file no-explicit-any
// Mode « sans Internet », messages privés et appels.
//   POST g37/device       — enregistre les clés publiques de ce téléphone
//   GET  g37/secrets      — clé de groupe, canal d'appel, clé publique du serveur, serveurs d'appel
//   POST g37/relay        — actions faites hors ligne par des collègues, apportées par ce téléphone
//   GET  g37/dms          — mes messages privés (chiffrés de bout en bout)
//   POST g37/call_signal  — signalisation d'un appel Internet vers un collègue
import { z } from "zod";
import { sql } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { json, readSuperjson, sj } from "../lib/http.ts";
import { broadcastChanged, broadcastTo } from "../lib/supa.ts";
import { callTopic, groupKey, serverSignKeys, verifyDeviceSig } from "../lib/p2pKeys.ts";
import { applyOnce, loadMe } from "./mutate.ts";

const jwkSchema = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(20).max(80), y: z.string().min(20).max(80) }).passthrough();

async function me(request: Request) {
  const { user } = await getServerUserSession(request);
  const row = await loadMe(user.id);
  if (!row) throw new Error("Compte introuvable");
  return row;
}

export async function handleDevice(request: Request): Promise<Response> {
  let user;
  try { user = await me(request); } catch { return json({ error: "Authentification requise" }, 401); }
  const parsed = z.object({
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
    signJwk: jwkSchema, encJwk: jwkSchema, label: z.string().max(120).optional(),
  }).safeParse(await readSuperjson(request).catch(() => null));
  if (!parsed.success) return json({ error: "Clés invalides" }, 400);
  const { deviceId, signJwk, encJwk, label } = parsed.data;
  const pub = (j: any) => ({ kty: "EC", crv: "P-256", x: j.x, y: j.y });
  await sql`INSERT INTO user_devices (device_id, user_id, sign_jwk, enc_jwk, label, last_seen)
    VALUES (${deviceId}, ${user.id}, ${sql.json(pub(signJwk))}, ${sql.json(pub(encJwk))}, ${label ?? null}, now())
    ON CONFLICT (device_id) DO UPDATE SET user_id = excluded.user_id, sign_jwk = excluded.sign_jwk, enc_jwk = excluded.enc_jwk, label = excluded.label, last_seen = now()`;
  return json({ ok: true });
}

export async function iceServers(): Promise<unknown[]> {
  const rows = await sql`SELECT value FROM app_config WHERE key = 'call.ice'`;
  try {
    const list = rows[0]?.value ? JSON.parse(rows[0].value) : null;
    if (Array.isArray(list) && list.length) return list;
  } catch { /* valeur invalide : serveurs par défaut */ }
  return [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
}

export async function handleSecrets(request: Request): Promise<Response> {
  let user;
  try { user = await me(request); } catch { return json({ error: "Authentification requise" }, 401); }
  const [{ pubJwk }, key, topic, ice] = await Promise.all([serverSignKeys(), groupKey(), callTopic(user.id), iceServers()]);
  return json({ p2pKey: user.pending ? null : key, callTopic: topic, serverSignJwk: pubJwk, iceServers: ice });
}

export async function handleRelay(request: Request): Promise<Response> {
  let relayer;
  try { relayer = await me(request); } catch { return sj({ error: "Authentification requise" }, 401); }
  if (relayer.pending) return sj({ error: "Compte en attente de validation" }, 403);
  let body: any;
  try { body = await readSuperjson(request); } catch { return sj({ error: "Requête invalide" }, 400); }
  const ops: Array<{ payload: string; sig: string }> = Array.isArray(body?.ops) ? body.ops.slice(0, 200) : [];
  const results: Array<{ opId: string; ok: boolean; retry: boolean; error?: string }> = [];
  const keyCache = new Map<string, any>();
  const userCache = new Map<number, any>();
  let changed = false;
  for (const op of ops) {
    if (typeof op?.payload !== "string" || typeof op?.sig !== "string" || op.payload.length > 220000) continue;
    let p: any;
    try { p = JSON.parse(op.payload); } catch { continue; }
    const opId = String(p?.opId ?? "").slice(0, 80);
    const userId = Number(p?.userId);
    const deviceId = String(p?.deviceId ?? "");
    if (!opId || !Number.isInteger(userId) || !deviceId) continue;
    const ck = `${userId}:${deviceId}`;
    if (!keyCache.has(ck)) {
      const rows = await sql`SELECT sign_jwk FROM user_devices WHERE device_id = ${deviceId} AND user_id = ${userId}`;
      keyCache.set(ck, rows[0]?.sign_jwk ?? null);
    }
    const jwk = keyCache.get(ck);
    if (!jwk) { results.push({ opId, ok: false, retry: true, error: "Téléphone inconnu" }); continue; }
    if (!(await verifyDeviceSig(jwk, op.payload, op.sig))) { results.push({ opId, ok: false, retry: false, error: "Signature invalide" }); continue; }
    if (!userCache.has(userId)) userCache.set(userId, await loadMe(userId));
    const author = userCache.get(userId);
    if (!author) { results.push({ opId, ok: false, retry: false, error: "Compte introuvable" }); continue; }
    const r = await applyOnce(author, opId, p.input, p.clientAt);
    if (r.status < 400) changed = true;
    results.push({ opId, ok: r.status < 400, retry: r.status >= 500, error: r.error });
  }
  if (changed) await broadcastChanged();
  return sj({ results });
}

export async function handleDms(request: Request): Promise<Response> {
  let user;
  try { user = await me(request); } catch { return json({ error: "Authentification requise" }, 401); }
  // Mes messages sont arrivés sur mon téléphone : l'expéditeur voit deux traits.
  const delivered = await sql`UPDATE dm_messages SET delivered_at = now() WHERE to_user = ${user.id} AND delivered_at IS NULL RETURNING from_user`;
  await notifySenders(delivered.map((r: any) => Number(r.from_user)), user.id);
  const rows = await sql`SELECT id, from_user, to_user, envelope, created_at, delivered_at, read_at FROM dm_messages
    WHERE from_user = ${user.id} OR to_user = ${user.id} ORDER BY created_at DESC LIMIT 600`;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return json({
    dms: rows.reverse().map((r: any) => ({
      id: r.id, from: r.from_user, to: r.to_user, envelope: r.envelope, createdAt: new Date(r.created_at).toISOString(),
      deliveredAt: iso(r.delivered_at), readAt: iso(r.read_at),
    })),
  });
}

async function notifySenders(senderIds: number[], reader: number) {
  for (const id of [...new Set(senderIds)]) await broadcastTo(await callTopic(id), "dm_status", { by: reader });
}

// Conversation ouverte : les messages reçus de ce collègue jusqu'à « until » sont lus (deux traits bleus chez lui).
export async function handleDmRead(request: Request): Promise<Response> {
  let user;
  try { user = await me(request); } catch { return json({ error: "Authentification requise" }, 401); }
  const parsed = z.object({ peer: z.number().int(), until: z.string().datetime() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Requête invalide" }, 400);
  const rows = await sql`UPDATE dm_messages SET read_at = now(), delivered_at = COALESCE(delivered_at, now())
    WHERE to_user = ${user.id} AND from_user = ${parsed.data.peer} AND created_at <= ${parsed.data.until}::timestamptz AND read_at IS NULL RETURNING id`;
  if (rows.length) await notifySenders([parsed.data.peer], user.id);
  return json({ ok: true, read: rows.length });
}

export async function handleCallSignal(request: Request): Promise<Response> {
  let user;
  try { user = await me(request); } catch { return json({ error: "Authentification requise" }, 401); }
  if (user.pending) return json({ error: "Compte en attente de validation" }, 403);
  const parsed = z.object({ to: z.number().int(), data: z.record(z.any()) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success || JSON.stringify(parsed.data.data).length > 30000) return json({ error: "Signal invalide" }, 400);
  const { to, data } = parsed.data;
  const exists = await sql`SELECT id FROM users WHERE id = ${to}`;
  if (!exists.length) return json({ error: "Collègue introuvable" }, 404);
  await broadcastTo(await callTopic(to), "signal", { from: user.id, fromName: user.displayName, data });
  return json({ ok: true });
}
