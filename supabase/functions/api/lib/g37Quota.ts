import { sql } from "./db.ts";
import { g37Plans, type G37PlanKey, type G37QuotaStatus } from "../shared/g37Plans.ts";
import { g37SasPay } from "./g37SasPay.ts";

export type QuotaKind = "ai" | "calc";
type Account = { role: string; jobRole: string };
const isAdmin = (a: Account) => a.role === "admin" || a.jobRole === "admin";
const NO_LIMIT = 1_000_000;

async function activeSubscription(userId: number) {
  const rows = await sql`SELECT plan, ends_at FROM g37_subscriptions WHERE user_id = ${userId} AND status = 'active' AND starts_at <= now() AND ends_at > now() ORDER BY ends_at DESC LIMIT 1`;
  return rows[0] ? { plan: rows[0].plan as G37PlanKey, endsAt: new Date(rows[0].ends_at).toISOString() } : null;
}

async function freeLimits(userId: number): Promise<Record<QuotaKind, number>> {
  const rows = await sql`SELECT ai_free_limit, calc_free_limit, (quota_warned_on IS NOT NULL AND quota_warned_on < (now() AT TIME ZONE 'Africa/Lagos')::date) AS reduced FROM users WHERE id = ${userId}`;
  const r = rows[0];
  const def = r?.reduced ? g37Plans.FREE_PER_DAY_AFTER_WARNING : g37Plans.FREE_PER_DAY;
  return { ai: r?.ai_free_limit ?? def, calc: r?.calc_free_limit ?? def };
}

async function usedToday(userId: number) {
  const rows = await sql`SELECT kind, count FROM g37_usage WHERE user_id = ${userId} AND day = (now() AT TIME ZONE 'Africa/Lagos')::date`;
  const out = { ai: 0, calc: 0 };
  for (const r of rows) out[r.kind as QuotaKind] = Number(r.count);
  return out;
}

async function activate(id: number, decidedBy: string): Promise<{ activated: boolean; endsAt: string | null }> {
  return await sql.begin(async (tx) => {
    const rows = await tx`SELECT user_id, plan FROM g37_subscriptions WHERE id = ${id} AND status = 'pending' FOR UPDATE`;
    if (!rows.length) return { activated: false, endsAt: null };
    const days = g37Plans.byKey(rows[0].plan)?.days ?? 1;
    await tx`UPDATE g37_subscriptions SET status = 'active', starts_at = GREATEST(now(), COALESCE((SELECT max(ends_at) FROM g37_subscriptions WHERE user_id = ${rows[0].user_id} AND status = 'active' AND ends_at > now()), now())), decided_at = now(), decided_by = ${decidedBy} WHERE id = ${id}`;
    const ended = await tx`UPDATE g37_subscriptions SET ends_at = starts_at + make_interval(days => ${days}) WHERE id = ${id} RETURNING ends_at`;
    return { activated: true, endsAt: new Date(ended[0].ends_at).toISOString() };
  });
}

async function reject(id: number, decidedBy: string): Promise<boolean> {
  const rows = await sql`UPDATE g37_subscriptions SET status = 'rejected', decided_at = now(), decided_by = ${decidedBy} WHERE id = ${id} AND status = 'pending' RETURNING id`;
  return rows.length > 0;
}

async function syncPending(userId: number): Promise<boolean> {
  const rows = await sql`SELECT id, payment_id, checkout_id, created_at < now() - interval '7 days' AS stale FROM g37_subscriptions WHERE user_id = ${userId} AND status = 'pending' AND (payment_id IS NOT NULL OR checkout_id IS NOT NULL) ORDER BY created_at DESC LIMIT 5`;
  let activated = false;
  for (const r of rows) {
    try {
      const s = r.payment_id ? await g37SasPay.paymentStatus(r.payment_id) : await g37SasPay.checkoutStatus(r.checkout_id);
      if (s.paid) activated = (await activate(Number(r.id), "SasPay")).activated || activated;
      else if (s.closed || r.stale) await reject(Number(r.id), "SasPay (non payé)");
    } catch (error) {
      console.error("SasPay status check:", error);
    }
  }
  return activated;
}

async function status(userId: number, account: Account): Promise<G37QuotaStatus> {
  const [sub, limits, used, pending] = await Promise.all([
    activeSubscription(userId), freeLimits(userId), usedToday(userId),
    sql`SELECT id, plan, amount, created_at, checkout_url FROM g37_subscriptions WHERE user_id = ${userId} AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
  ]);
  const admin = isAdmin(account);
  const unlimited = admin || !!sub;
  const rem = (kind: QuotaKind) => (unlimited ? null : Math.max(0, limits[kind] - used[kind]));
  return {
    unlimited, isAdmin: admin, subscription: sub,
    ai: { used: used.ai, limit: limits.ai, remaining: rem("ai") },
    calc: { used: used.calc, limit: limits.calc, remaining: rem("calc") },
    pendingRequest: pending[0] ? { id: Number(pending[0].id), plan: pending[0].plan as G37PlanKey, amount: Number(pending[0].amount), createdAt: new Date(pending[0].created_at).toISOString(), checkoutUrl: pending[0].checkout_url ?? null } : null,
  };
}

async function consumeOnce(userId: number, kind: QuotaKind) {
  const unlimited = !!(await activeSubscription(userId));
  const limit = unlimited ? NO_LIMIT : (await freeLimits(userId))[kind];
  if (limit <= 0) return false;
  const rows = await sql`INSERT INTO g37_usage (user_id, day, kind, count) VALUES (${userId}, (now() AT TIME ZONE 'Africa/Lagos')::date, ${kind}::g37_usage_kind, 1) ON CONFLICT (user_id, day, kind) DO UPDATE SET count = g37_usage.count + 1 WHERE g37_usage.count < ${limit} RETURNING count`;
  return rows.length > 0;
}

async function tryConsume(userId: number, account: Account, kind: QuotaKind): Promise<{ ok: boolean; status: G37QuotaStatus }> {
  if (isAdmin(account)) return { ok: true, status: await status(userId, account) };
  let ok = await consumeOnce(userId, kind);
  if (!ok && (await syncPending(userId))) ok = await consumeOnce(userId, kind);
  if (!ok) await sql`UPDATE users SET quota_warned_on = (now() AT TIME ZONE 'Africa/Lagos')::date WHERE id = ${userId} AND quota_warned_on IS NULL`;
  return { ok, status: await status(userId, account) };
}

async function refund(userId: number, kind: QuotaKind): Promise<void> {
  await sql`UPDATE g37_usage SET count = GREATEST(count - 1, 0) WHERE user_id = ${userId} AND kind = ${kind}::g37_usage_kind AND day = (now() AT TIME ZONE 'Africa/Lagos')::date`;
}

export const g37Quota = { status, tryConsume, refund, activate, reject, syncPending };
