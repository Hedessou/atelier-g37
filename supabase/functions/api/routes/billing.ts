// deno-lint-ignore-file no-explicit-any
import { z } from "zod";
import { db, sql } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { g37Quota } from "../lib/g37Quota.ts";
import { g37Plans } from "../shared/g37Plans.ts";
import { g37SasPay } from "../lib/g37SasPay.ts";
import { json } from "../lib/http.ts";

async function account(userId: number) {
  return await db.selectFrom("users").select(["pending", "role", "jobRole"]).where("id", "=", userId).executeTakeFirst();
}

// Les paiements sont désactivés : IA et calcul illimités pour tous les membres validés.
const UNLIMITED = { unlimited: true, isAdmin: false, subscription: null, ai: { used: 0, limit: 0, remaining: null }, calc: { used: 0, limit: 0, remaining: null }, pendingRequest: null };

export async function handleQuota(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise." }, 401); }
  const acc = await account(userId);
  if (!acc || acc.pending) return json({ error: "Compte en attente de validation." }, 403);
  return json({ ...UNLIMITED, isAdmin: acc.role === "admin" });
}

export async function handleCalc(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise." }, 401); }
  const acc = await account(userId);
  if (!acc || acc.pending) return json({ error: "Compte en attente de validation." }, 403);
  return json({ ok: true, quota: { ...UNLIMITED, isAdmin: acc.role === "admin" } });
}

export async function handleSubscribe(_request: Request): Promise<Response> {
  return json({ error: "Les abonnements sont désactivés : l'IA et le calcul sont désormais illimités." }, 410);
}

export async function handlePayNetworks(request: Request): Promise<Response> {
  try { await getServerUserSession(request); } catch { return json({ error: "Authentification requise." }, 401); }
  const country = new URL(request.url).searchParams.get("country")?.toUpperCase() ?? "";
  if (!g37SasPay.COUNTRIES.some((c) => c.code === country)) return json({ error: "Pays non pris en charge." }, 400);
  try { return json({ networks: await g37SasPay.networks(country) }); } catch (error) { console.error("SasPay networks:", error); return json({ error: "Réseaux de paiement indisponibles pour le moment." }, 502); }
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const toRow = (r: any) => ({ id: Number(r.id), userName: r.display_name, userEmail: r.email, plan: r.plan, amount: Number(r.amount), status: r.status, checkoutId: r.checkout_id, startsAt: iso(r.starts_at), endsAt: iso(r.ends_at), createdAt: iso(r.created_at)!, decidedBy: r.decided_by });

export async function handlePayments(request: Request): Promise<Response> {
  try { const { user } = await getServerUserSession(request); if (user.role !== "admin") return json({ error: "Accès administrateur requis." }, 403); } catch { return json({ error: "Authentification requise." }, 401); }
  try {
    const [pending, recent] = await Promise.all([
      sql`SELECT s.*, u.display_name, u.email FROM g37_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status = 'pending' ORDER BY s.created_at DESC LIMIT 50`,
      sql`SELECT s.*, u.display_name, u.email FROM g37_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status = 'active' ORDER BY s.decided_at DESC NULLS LAST LIMIT 50`,
    ]);
    return json({ pending: pending.map(toRow), recent: recent.map(toRow) });
  } catch (error) { console.error("G37 payments:", error); return json({ error: "Paiements indisponibles." }, 500); }
}

export async function handlePaymentDecide(request: Request): Promise<Response> {
  let adminName: string;
  try { const { user } = await getServerUserSession(request); if (user.role !== "admin") return json({ error: "Accès administrateur requis." }, 403); adminName = user.displayName; } catch { return json({ error: "Authentification requise." }, 401); }
  const parsed = z.object({ id: z.number().int().positive(), approve: z.boolean() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Données invalides." }, 400);
  try {
    if (parsed.data.approve) { const res = await g37Quota.activate(parsed.data.id, adminName); if (!res.activated) return json({ error: "Ce paiement a déjà été traité." }, 409); return json({ ok: true, endsAt: res.endsAt }); }
    if (!(await g37Quota.reject(parsed.data.id, adminName))) return json({ error: "Ce paiement a déjà été traité." }, 409);
    return json({ ok: true, endsAt: null });
  } catch (error) { console.error("G37 payment decide:", error); return json({ error: "Décision impossible pour le moment." }, 500); }
}

export async function handleUserLimits(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise." }, 401); }
  if (userId !== g37Plans.OWNER_USER_ID) return json({ error: "Réservé au propriétaire du site." }, 403);
  if (request.method === "GET") {
    const rows = await db.selectFrom("users").select(["id", "displayName", "email", "jobRole", "role", "aiFreeLimit", "calcFreeLimit"]).orderBy("displayName", "asc").execute();
    return json({ users: rows.map((u: any) => ({ id: u.id, displayName: u.displayName, email: u.email, jobRole: u.jobRole, isAdmin: u.role === "admin" || u.jobRole === "admin", ai: u.aiFreeLimit, calc: u.calcFreeLimit })) });
  }
  const limit = z.number().int().min(0).max(1000).nullable();
  const parsed = z.object({ userId: z.number().int().positive(), ai: limit, calc: limit }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Limite invalide (nombre entier de 0 à 1000, ou vide)." }, 400);
  const res = await db.updateTable("users").set({ aiFreeLimit: parsed.data.ai, calcFreeLimit: parsed.data.calc }).where("id", "=", parsed.data.userId).executeTakeFirst();
  if (!Number(res.numUpdatedRows)) return json({ error: "Compte introuvable." }, 404);
  return json({ ok: true });
}
