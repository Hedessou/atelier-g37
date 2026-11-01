// Liste des numéros du robot (01/11/2026) : l'admin ajoute, change ou retire des numéros depuis WhatsApp
// (appel du soir : rang d'appel ; droits WhatsApp : superviseur / staff / aucun).
// Opération « waPerson », réservée au niveau owner. Les autres opérations passent par handleWaMutate (wa.ts).
import { sql } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/db.ts";
import { json } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/http.ts";
import { handleWaMutate } from "./wa.ts";

let keyCache: { v: string; at: number } | null = null;
async function robot(request: Request): Promise<boolean> {
  const given = request.headers.get("x-wa-key") ?? "";
  if (!given) return false;
  if (!keyCache || Date.now() - keyCache.at > 5 * 60_000) {
    const [r] = await sql`SELECT value FROM app_config WHERE key = 'wa.key'`;
    keyCache = { v: String(r?.value ?? ""), at: Date.now() };
  }
  return !!keyCache.v && given === keyCache.v;
}

// deno-lint-ignore no-explicit-any
async function waPerson(op: any): Promise<string> {
  const has = (k: string) => op[k] !== undefined && op[k] !== "";
  const phone = has("phone") ? String(op.phone).replace(/\D/g, "") : undefined;
  if (phone !== undefined && !/^229\d{8,10}$/.test(phone)) throw new Error("Numéro invalide.");
  const tierSet = op.callTier !== undefined;
  const tier = op.callTier == null ? null : Math.max(1, Math.min(9, Math.round(Number(op.callTier))));
  const level = op.level != null ? String(op.level) : null;
  if (level !== null && !["supervisor", "staff", "none"].includes(level)) throw new Error("Droits invalides.");
  const name = has("name") && op.name ? String(op.name).slice(0, 60) : null;
  const userId = Number(op.userId) > 0 ? Number(op.userId) : null;
  if (op.id) {
    const [p] = await sql`SELECT id, name, level FROM wa_people WHERE id = ${Number(op.id)}`;
    if (!p) throw new Error("Personne introuvable dans la liste.");
    if (p.level === "owner" && level !== null) throw new Error("On ne change pas les droits de l'admin.");
    if (phone) {
      const [dup] = await sql`SELECT name FROM wa_people WHERE phone = ${phone} AND id <> ${p.id}`;
      if (dup) throw new Error(`Ce numéro est déjà celui de ${dup.name}.`);
    }
    await sql`UPDATE wa_people SET
      phone = COALESCE(${phone ?? null}::text, phone),
      name = COALESCE(${name}::text, name),
      name_auto = CASE WHEN ${name}::text IS NULL THEN name_auto ELSE false END,
      call_tier = CASE WHEN ${tierSet} THEN ${tier}::int ELSE call_tier END,
      level = COALESCE(${level}::text, level),
      user_id = COALESCE(user_id, ${userId}::int),
      active = true
      WHERE id = ${p.id}`;
    return `${name ?? p.name} : liste mise à jour.`;
  }
  if (!phone) throw new Error("Numéro manquant.");
  const [dup] = await sql`SELECT name FROM wa_people WHERE phone = ${phone}`;
  if (dup) throw new Error(`Ce numéro est déjà dans la liste (${dup.name}).`);
  await sql`INSERT INTO wa_people (name, phone, user_id, level, call_tier, name_auto, active)
    VALUES (${name ?? phone}, ${phone}, ${userId}, ${level ?? "staff"}, ${tier}, ${!name}, true)`;
  return `${name ?? phone} ajouté à la liste.`;
}

/** wa/mutate : les opérations « waPerson » sont faites ici ; le reste part dans handleWaMutate. */
export async function handleWaMutateAll(request: Request): Promise<Response> {
  if (!(await robot(request))) return json({ error: "forbidden" }, 403);
  const body = await request.json().catch(() => ({}));
  // deno-lint-ignore no-explicit-any
  const ops: any[] = Array.isArray(body.ops) ? body.ops.slice(0, 40) : [];
  const mine = ops.filter((o) => o?.action === "waPerson");
  const rest = ops.filter((o) => o?.action !== "waPerson");
  const forward = () => handleWaMutate(new Request(request.url, { method: "POST", headers: (() => { const h = new Headers(request.headers); h.delete("content-length"); return h; })(), body: JSON.stringify({ ...body, ops: rest }) }));
  if (!mine.length) return forward();

  const p = body.person ?? {};
  const own: Array<{ action: string; ok: boolean; message?: string; error?: string }> = [];
  for (const op of mine) {
    if (p.level !== "owner") { own.push({ action: "waPerson", ok: false, error: "Seul l'admin peut changer la liste des numéros." }); continue; }
    try { own.push({ action: "waPerson", ok: true, message: await waPerson(op) }); }
    catch (e) { own.push({ action: "waPerson", ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  await sql`INSERT INTO wa_edit_log (phone, person, level, summary, ops, result)
    VALUES (${String(p.phone ?? "").slice(0, 30)}, ${String(p.name ?? "WhatsApp").slice(0, 60)}, ${String(p.level ?? "none")},
      ${String(body.summary ?? "").slice(0, 1000)}, ${sql.json(mine)}, ${sql.json(own)})`;
  let by = String(p.name ?? "WhatsApp");
  let other: typeof own = [];
  if (rest.length) {
    const r = await forward();
    const d = await r.json().catch(() => ({}));
    other = Array.isArray(d.results) ? d.results : rest.map((o) => ({ action: String(o?.action ?? ""), ok: false, error: d.error ?? `HTTP ${r.status}` }));
    if (d.by) by = d.by;
  }
  // Résultats dans l'ordre des opérations (une ligne du résumé par opération).
  let i = 0, j = 0;
  const results = ops.map((o) => o?.action === "waPerson" ? own[i++] : other[j++] ?? { action: String(o?.action ?? ""), ok: false, error: "sans réponse" });
  return json({ results, by });
}
