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

// GET g37/quota
export async function handleQuota(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise." }, 401); }
  try {
    const acc = await account(userId);
    if (!acc || acc.pending) return json({ error: "Compte en attente de validation." }, 403);
    let quota = await g37Quota.status(userId, acc);
    if (quota.pendingRequest) {
      await g37Quota.syncPending(userId);
      quota = await g37Quota.status(userId, acc);
    }
    return json(quota);
  } catch (error) {
    console.error("G37 quota:", error);
    return json({ error: "Quota indisponible pour le moment." }, 500);
  }
}

// POST g37/calc — décompte d'un calcul (le calcul lui-même reste fait sur le téléphone).
export async function handleCalc(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise." }, 401); }
  try {
    const acc = await account(userId);
    if (!acc || acc.pending) return json({ error: "Compte en attente de validation." }, 403);
    const result = await g37Quota.tryConsume(userId, acc, "calc");
    if (!result.ok) {
      return json({ error: "Limite gratuite de calculs atteinte pour aujourd'hui : abonne-toi pour continuer ou attends demain.", code: "QUOTA", kind: "calc", quota: result.status }, 402);
    }
    return json({ ok: true, quota: result.status });
  } catch (error) {
    console.error("G37 calc quota:", error);
    return json({ error: "Calcul indisponible pour le moment." }, 500);
  }
}

const subscribeSchema = z.object({
  plan: z.enum(["day", "three_days", "week", "month"]),
  country: z.string().length(2),
  network: z.string().min(1).max(60),
  phone: z.string().trim().min(6, "Numéro Mobile Money requis.").max(25),
  otp: z.string().trim().max(20).optional(),
});

// POST g37/subscribe — paiement Mobile Money SasPay.
export async function handleSubscribe(request: Request): Promise<Response> {
  let session: Awaited<ReturnType<typeof getServerUserSession>>;
  try { session = await getServerUserSession(request); } catch { return json({ error: "Authentification requise." }, 401); }
  const { user } = session;
  const parsed = subscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Données invalides." }, 400);
  const { plan, network, otp } = parsed.data;
  const country = parsed.data.country.toUpperCase();
  const offer = g37Plans.byKey(plan)!;
  if (!g37SasPay.COUNTRIES.some((c) => c.code === country)) return json({ error: "Pays non pris en charge." }, 400);
  const phone = g37SasPay.normalizePhone(country, parsed.data.phone);
  if (!/^\+\d{10,15}$/.test(phone)) return json({ error: "Numéro Mobile Money invalide." }, 400);
  try {
    const acc = await account(user.id);
    if (!acc || acc.pending) return json({ error: "Compte en attente de validation." }, 403);
    if (await g37Quota.syncPending(user.id)) {
      return json({ activated: true, pushed: false, checkoutUrl: null, otpRequired: false, message: null, quota: await g37Quota.status(user.id, acc) });
    }
    const inserted = await sql`INSERT INTO g37_subscriptions (user_id, plan, amount, payer_phone)
      VALUES (${user.id}, ${offer.key}::g37_plan, ${offer.price}, ${phone}) RETURNING id`;
    const subId = Number(inserted[0].id);
    let payment: { id: string; status: string; checkoutUrl: string | null };
    try {
      payment = await g37SasPay.softpay({
        amount: offer.price, country, network, phone, email: user.email, name: user.displayName,
        description: `G37 Maintenance — ${offer.fr}`, otp: otp || null, returnUrl: null,
        metadata: { subscription_id: subId, user_id: user.id, plan: offer.key }, idempotencyKey: crypto.randomUUID(),
      });
    // deno-lint-ignore no-explicit-any
    } catch (error: any) {
      await sql`DELETE FROM g37_subscriptions WHERE id = ${subId}`;
      if (error?.code === "prepayment_otp_missing") {
        return json({ activated: false, pushed: false, checkoutUrl: null, otpRequired: true, message: error.message, quota: null });
      }
      console.error("SasPay softpay:", error);
      const known: Record<string, string> = {
        invalid_customer: "Numéro de téléphone refusé par SasPay : vérifie le numéro Mobile Money.",
        no_route_available: "Ce réseau n'est pas disponible pour le moment. Essaie un autre réseau.",
        invalid_method: "Ce réseau n'est pas pris en charge. Choisis-en un autre.",
        missing_method: "Choisis un réseau Mobile Money.",
      };
      return json({ error: known[error?.code] ?? error?.message ?? "Paiement impossible pour le moment." }, 502);
    }
    await sql`UPDATE g37_subscriptions SET payment_id = ${payment.id}, checkout_url = ${payment.checkoutUrl} WHERE id = ${subId}`;
    if (payment.status === "SUCCESS") await g37Quota.activate(subId, "SasPay");
    const quota = await g37Quota.status(user.id, acc);
    return json({ activated: quota.unlimited, pushed: !payment.checkoutUrl, checkoutUrl: payment.checkoutUrl, otpRequired: false, message: null, quota });
  } catch (error) {
    console.error("G37 subscribe:", error);
    return json({ error: error instanceof Error ? error.message : "Paiement impossible pour le moment." }, 502);
  }
}

// GET g37/pay_networks?country=TG
export async function handlePayNetworks(request: Request): Promise<Response> {
  try { await getServerUserSession(request); } catch { return json({ error: "Authentification requise." }, 401); }
  const country = new URL(request.url).searchParams.get("country")?.toUpperCase() ?? "";
  if (!g37SasPay.COUNTRIES.some((c) => c.code === country)) return json({ error: "Pays non pris en charge." }, 400);
  try {
    return json({ networks: await g37SasPay.networks(country) });
  } catch (error) {
    console.error("SasPay networks:", error);
    return json({ error: "Réseaux de paiement indisponibles pour le moment." }, 502);
  }
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
// deno-lint-ignore no-explicit-any
const toRow = (r: any) => ({
  id: Number(r.id), userName: r.display_name, userEmail: r.email, plan: r.plan, amount: Number(r.amount),
  status: r.status, checkoutId: r.checkout_id, startsAt: iso(r.starts_at), endsAt: iso(r.ends_at),
  createdAt: iso(r.created_at)!, decidedBy: r.decided_by,
});

// GET g37/payments (admin)
export async function handlePayments(request: Request): Promise<Response> {
  try {
    const { user } = await getServerUserSession(request);
    if (user.role !== "admin") return json({ error: "Accès administrateur requis." }, 403);
  } catch { return json({ error: "Authentification requise." }, 401); }
  try {
    const [pending, recent] = await Promise.all([
      sql`SELECT s.*, u.display_name, u.email FROM g37_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status = 'pending' ORDER BY s.created_at DESC LIMIT 50`,
      sql`SELECT s.*, u.display_name, u.email FROM g37_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.status = 'active' ORDER BY s.decided_at DESC NULLS LAST LIMIT 50`,
    ]);
    return json({ pending: pending.map(toRow), recent: recent.map(toRow) });
  } catch (error) {
    console.error("G37 payments:", error);
    return json({ error: "Paiements indisponibles." }, 500);
  }
}

// POST g37/payment_decide (admin)
export async function handlePaymentDecide(request: Request): Promise<Response> {
  let adminName: string;
  try {
    const { user } = await getServerUserSession(request);
    if (user.role !== "admin") return json({ error: "Accès administrateur requis." }, 403);
    adminName = user.displayName;
  } catch { return json({ error: "Authentification requise." }, 401); }
  const parsed = z.object({ id: z.number().int().positive(), approve: z.boolean() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Données invalides." }, 400);
  try {
    if (parsed.data.approve) {
      const res = await g37Quota.activate(parsed.data.id, adminName);
      if (!res.activated) return json({ error: "Ce paiement a déjà été traité." }, 409);
      return json({ ok: true, endsAt: res.endsAt });
    }
    if (!(await g37Quota.reject(parsed.data.id, adminName))) return json({ error: "Ce paiement a déjà été traité." }, 409);
    return json({ ok: true, endsAt: null });
  } catch (error) {
    console.error("G37 payment decide:", error);
    return json({ error: "Décision impossible pour le moment." }, 500);
  }
}

// GET / POST g37/user_limits (propriétaire du site uniquement)
export async function handleUserLimits(request: Request): Promise<Response> {
  let userId: number;
  try { userId = (await getServerUserSession(request)).user.id; } catch { return json({ error: "Authentification requise." }, 401); }
  if (userId !== g37Plans.OWNER_USER_ID) return json({ error: "Réservé au propriétaire du site." }, 403);
  if (request.method === "GET") {
    const rows = await db.selectFrom("users").select(["id", "displayName", "email", "jobRole", "role", "aiFreeLimit", "calcFreeLimit"]).orderBy("displayName", "asc").execute();
    return json({ users: rows.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, jobRole: u.jobRole, isAdmin: u.role === "admin" || u.jobRole === "admin", ai: u.aiFreeLimit, calc: u.calcFreeLimit })) });
  }
  const limit = z.number().int().min(0).max(1000).nullable();
  const parsed = z.object({ userId: z.number().int().positive(), ai: limit, calc: limit }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Limite invalide (nombre entier de 0 à 1000, ou vide)." }, 400);
  const res = await db.updateTable("users").set({ aiFreeLimit: parsed.data.ai, calcFreeLimit: parsed.data.calc }).where("id", "=", parsed.data.userId).executeTakeFirst();
  if (!Number(res.numUpdatedRows)) return json({ error: "Compte introuvable." }, 404);
  return json({ ok: true });
}
