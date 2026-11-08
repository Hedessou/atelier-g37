// Rapport du matin du robot WhatsApp G37 (04/11/2026) — appelé par bot.js sur le VPS à la place de wa-bot/report.
// Route : GET /functions/v1/wa-report/report (en-tête x-wa-key, même clé que wa-bot).
//         Paramètre facultatif ?day=AAAA-MM-JJ pour prévisualiser le rapport d'un autre jour (rien n'est envoyé ni modifié).
// La mise en forme est dans report.ts ; la règle ajoutée y est expliquée.
import { config, sql } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/a82bc1692d7bb84b1e33a448386815aa7b777010/supabase/functions/wa-bot/db.ts";
import { buildReport, isoDay } from "./report.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

let keyCache: { v: string; at: number } | null = null;
async function authorized(req: Request): Promise<boolean> {
  const given = req.headers.get("x-wa-key") ?? "";
  if (!given) return false;
  if (!keyCache || Date.now() - keyCache.at > 5 * 60_000) keyCache = { v: await config("wa.key"), at: Date.now() };
  return !!keyCache.v && given === keyCache.v;
}

async function report(day: string | null): Promise<string> {
  const today = day ?? isoDay(new Date(Date.now() + 3600_000)); // heure du Bénin (UTC+1)
  const [machines, greasing, points, failures, works] = await Promise.all([
    sql`SELECT machine_no, next_maintenance, maint_planned_by FROM machines WHERE machine_no BETWEEN 1 AND 28`,
    sql`SELECT DISTINCT ON (kind, machine_no, point_key) kind, machine_no, point_key, done_on
        FROM greasing_records ORDER BY kind, machine_no, point_key, done_on DESC, created_at DESC`,
    sql`SELECT kind, point_key, name, interval_days FROM g37_cycle_points`,
    sql`SELECT machine_id, issue, opened_at FROM failures WHERE status <> 'resolue' ORDER BY opened_at`,
    sql`SELECT machine_no, title, created_at, author_name FROM works WHERE status = 'todo' ORDER BY created_at`,
  ]);
  return buildReport({ machines, greasing, points, failures, works }, today, Date.now());
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/wa-report\/?/, "").replace(/\/+$/, "");
  try {
    if (!(await authorized(req))) return json({ error: "forbidden" }, 403);
    if (req.method === "GET" && path === "report") {
      const day = url.searchParams.get("day");
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day = AAAA-MM-JJ" }, 400);
      return json({ text: await report(day) });
    }
    if (req.method === "GET" && path === "health") return json({ ok: true, at: new Date().toISOString() });
    return json({ error: `Route inconnue : ${req.method} ${path}` }, 404);
  } catch (e) {
    console.error("wa-report:", e);
    return json({ error: e instanceof Error ? e.message : "Erreur serveur" }, 500);
  }
});
