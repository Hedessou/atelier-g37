// deno-lint-ignore-file no-explicit-any
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, sql } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { g37 } from "../shared/g37.ts";
import { BUCKET_CHAT, supa } from "../lib/supa.ts";
import { json, readSuperjson, sj } from "../lib/http.ts";
import { loadAndRunDueAlerts } from "../lib/dueAlerts.ts";
import { serverSign } from "../lib/p2pKeys.ts";

export async function handleUsers(request: Request): Promise<Response> {
  try {
    const { user } = await getServerUserSession(request);
    if (user.role !== "admin") return sj({ message: "Accès administrateur requis" }, 403);
    const users = await db.selectFrom("users").select(["id", "email", "displayName", "role", "createdAt"]).orderBy("createdAt", "asc").execute();
    return sj({ users });
  } catch { return sj({ message: "Authentification requise" }, 401); }
}

export async function handleUserRole(request: Request): Promise<Response> {
  try {
    const { user } = await getServerUserSession(request);
    if (user.role !== "admin") return sj({ message: "Accès administrateur requis" }, 403);
    const body = z.object({ id: z.number().int().positive(), role: z.enum(["admin", "user"]) }).parse(await readSuperjson(request));
    if (body.id === user.id && body.role !== "admin") return sj({ message: "Un administrateur ne peut pas retirer son propre rôle." }, 400);
    await db.updateTable("users").set({ role: body.role }).where("id", "=", body.id).execute();
    return sj({ success: true });
  } catch (e) { return sj({ message: e instanceof Error ? e.message : "Requête invalide" }, 400); }
}

export async function handlePush(request: Request): Promise<Response> {
  try {
    const { user } = await getServerUserSession(request);
    const input = z.discriminatedUnion("op", [
      z.object({ op: z.literal("save"), token: z.string().min(10).max(4096), platform: z.string().max(20).default("android") }),
      z.object({ op: z.literal("remove"), token: z.string().min(10).max(4096) }),
    ]).parse(await readSuperjson(request));
    if (input.op === "remove") await db.deleteFrom("pushTokens").where("token", "=", input.token).where("userId", "=", user.id).execute();
    else await db.insertInto("pushTokens").values({ token: input.token, userId: user.id, platform: input.platform }).onConflict((oc: any) => oc.column("token").doUpdateSet({ userId: user.id, platform: input.platform, createdAt: new Date() })).execute();
    return sj({ success: true });
  } catch (error) { return sj({ error: error instanceof Error ? error.message : "Requête invalide" }, 400); }
}

const FORBIDDEN = /^(text\/html|application\/(xhtml\+xml|javascript|x-javascript)|text\/javascript)|xml/i;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export async function handleUpload(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return sj({ error: "Authentification requise" }, 401); }
  try {
    const me = await db.selectFrom("users").select(["role", "jobRole", "pending"]).where("id", "=", userId).executeTakeFirst();
    // Fichiers du groupe (droit « forum », vérifié à la publication) et pièces jointes chiffrées des messages privés.
    if (!me || me.pending) return sj({ error: "Ton compte doit être validé par l'admin avant d'envoyer des fichiers." }, 403);
    const input = z.object({ fileName: z.string().min(1).max(200), contentType: z.string().min(1).max(120), sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES) }).parse(await readSuperjson(request));
    if (FORBIDDEN.test(input.contentType)) return sj({ error: "Ce type de fichier n'est pas accepté (HTML, script ou XML)." }, 400);
    const safe = input.fileName.replace(/[^\w.\-]+/g, "_").slice(-80);
    const fileKey = `chat/${nanoid(12)}-${safe}`;
    const { data, error } = await supa.storage.from(BUCKET_CHAT).createSignedUploadUrl(fileKey);
    if (error || !data) return sj({ error: error?.message ?? "Envoi impossible" }, 500);
    return sj({ fileKey, presignedUrl: data.signedUrl, headers: { "Content-Type": input.contentType, "x-upsert": "false" } });
  } catch (error) { return sj({ error: error instanceof Error ? error.message : "Envoi impossible" }, 400); }
}

// Liens de téléchargement (1 h) des fichiers de messagerie : pièces jointes chiffrées des messages privés.
export async function handleFileUrls(request: Request): Promise<Response> {
  try { await getServerUserSession(request); } catch { return json({ error: "Authentification requise" }, 401); }
  const parsed = z.object({ keys: z.array(z.string().min(6).max(300).regex(/^chat\/[\w.\-]+$/)).min(1).max(20) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Requête invalide" }, 400);
  const { data, error } = await supa.storage.from(BUCKET_CHAT).createSignedUrls(parsed.data.keys, 3600);
  if (error) return json({ error: error.message }, 500);
  const urls: Record<string, string> = {};
  (data ?? []).forEach((d) => { if (d.path && d.signedUrl) urls[d.path] = d.signedUrl; });
  return json({ urls });
}

// Photo de profil : envoi direct vers le stockage « avatars » (lien signé, 2 Mo maximum).
export async function handleAvatarUpload(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise" }, 401); }
  const parsed = z.object({ contentType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().min(1).max(2 * 1024 * 1024) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Photo trop lourde ou format non accepté (JPEG, PNG, WebP, 2 Mo max)." }, 400);
  const ext = parsed.data.contentType === "image/png" ? "png" : parsed.data.contentType === "image/webp" ? "webp" : "jpg";
  const key = `u${userId}/${nanoid(10)}.${ext}`;
  const { data, error } = await supa.storage.from("avatars").createSignedUploadUrl(key);
  if (error || !data) return json({ error: error?.message ?? "Envoi impossible" }, 500);
  return json({ key, presignedUrl: data.signedUrl, headers: { "Content-Type": parsed.data.contentType, "x-upsert": "false" } });
}

export async function handleManual(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise." }, 401); }
  if (request.method === "GET") {
    const [cfg] = await sql`SELECT manual_file_name, updated_at FROM g37_manual_config WHERE id = 1`;
    const [cnt] = await sql`SELECT count(*)::int AS n FROM g37_manual_chunks`;
    return json({ manualReady: Number(cnt?.n ?? 0) > 0, chunks: Number(cnt?.n ?? 0), fileName: cfg?.manual_file_name ?? null, updatedAt: cfg?.updated_at ?? null });
  }
  const me = await db.selectFrom("users").select(["role", "displayName"]).where("id", "=", userId).executeTakeFirst();
  if (me?.role !== "admin") return json({ error: "Réservé à l'administrateur." }, 403);
  const body = await request.json().catch(() => ({})) as any;
  if (!Array.isArray(body.chunks)) return json({ error: "Aucun texte reçu." }, 400);
  const sourceId = String(body.sourceId || "g37-manual-text").slice(0, 80);
  const rows = body.chunks.slice(0, 100).map((c: any) => {
    const start = Math.max(1, Math.trunc(Number(c?.pageStart)) || 1);
    const end = Math.max(start, Math.trunc(Number(c?.pageEnd)) || start);
    return { pageStart: start, pageEnd: end, content: String(c?.content ?? "").trim().slice(0, 20000) };
  }).filter((r: any) => r.content.length > 0);
  if (body.replace) await sql`DELETE FROM g37_manual_chunks`;
  if (rows.length) {
    await sql`INSERT INTO g37_manual_chunks (source_file_id, page_no, page_end, content) SELECT ${sourceId}, t.p, t.e, t.c FROM unnest(${rows.map((r: any) => r.pageStart)}::int[], ${rows.map((r: any) => r.pageEnd)}::int[], ${rows.map((r: any) => r.content)}::text[]) AS t(p, e, c)`;
  }
  if (body.finalize) {
    await sql`INSERT INTO g37_manual_config (id, manual_file_name, updated_by, updated_at) VALUES (1, ${String(body.fileName ?? "manuel.pdf").slice(0, 200)}, ${me.displayName}, now()) ON CONFLICT (id) DO UPDATE SET manual_file_name = excluded.manual_file_name, updated_by = excluded.updated_by, updated_at = now()`;
  }
  const [cnt] = await sql`SELECT count(*)::int AS n FROM g37_manual_chunks`;
  return json({ ready: Boolean(body.finalize), sourceId, chunks: Number(cnt?.n ?? 0) });
}

export async function handleVersion(): Promise<Response> {
  const rows = await db.selectFrom("appConfig").select(["key", "value"]).where("key", "like", "app.%").execute();
  const cfg: Record<string, string> = Object.fromEntries(rows.map((r: any) => [r.key.slice(4), r.value]));
  const info = {
    bundleVersion: cfg.bundleVersion || null, bundleUrl: cfg.bundleUrl || null, bundleChecksum: cfg.bundleChecksum || null,
    nativeVersionCode: cfg.nativeVersionCode ? Number(cfg.nativeVersionCode) : null, minNativeVersionCode: cfg.minNativeVersionCode ? Number(cfg.minNativeVersionCode) : null,
    apkUrl: cfg.apkUrl || null, apkChecksum: cfg.apkChecksum || null, notes: cfg.notes || null,
  };
  // Fiche de version signée : elle peut circuler de téléphone en téléphone (mises à jour sans Internet).
  const manifest = JSON.stringify({ ...info, issuedAt: new Date().toISOString() });
  return json({ ...info, manifest, manifestSig: await serverSign(manifest) });
}

export async function handleCron(request: Request): Promise<Response> {
  const key = request.headers.get("x-cron-key") ?? "";
  const row = await db.selectFrom("appConfig").select("value").where("key", "=", "cron.key").executeTakeFirst();
  if (!row || !key || key !== row.value) return json({ error: "forbidden" }, 403);
  await loadAndRunDueAlerts();
  await sql`DELETE FROM sync_ops WHERE applied_at < now() - interval '90 days'`;
  await sql`DELETE FROM app_sessions WHERE expires_at < now()`;
  return json({ ok: true });
}
