// deno-lint-ignore-file no-explicit-any
// Fonction « wa-app » — Robot WhatsApp G37 (01/11/2026) : ce que le robot fait dans l'app passe par ici, avec les mêmes règles que les boutons.
//   POST wa/mutate      (robot, en-tête x-wa-key) { person, ops[], summary } — modifications confirmées sur WhatsApp
//   POST wa/ask_call    (robot)  { askId } — fait sonner l'écran d'appel de l'app (question du soir)
//   POST wa/ask_answer  (robot)  { askId, done?, tomorrow? } — réponse donnée sur WhatsApp
//   GET  g37/ask        (app)    ?id= — question du soir en attente pour moi
//   POST g37/ask_answer (app)    { id, done?, tomorrow? } — réponse donnée dans l'app (boutons)
//   GET  g37/ask_audio  (app)    ?id= — voix de la question (WAV)
// Le reste du serveur de l'app est repris tel quel depuis GitHub (version du 27/10/2026, la même que la fonction « api » en ligne) :
// mêmes règles, mêmes droits, mêmes notifications que les boutons de l'app, sans toucher à la fonction « api ».
import { sql } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/db.ts";
import { getServerUserSession } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/session.ts";
import { json } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/http.ts";
import { broadcastChanged } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/supa.ts";
import { notifyRoles, notifyUsers } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/notify.ts";
import { g37 } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/shared/g37.ts";
import { applyOnce, loadMe } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/routes/mutate.ts";

const beninDay = (d = new Date()) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);
const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const addDays = (day: string, n: number) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const machineId = (n: number) => "M-" + String(n).padStart(2, "0");
const mcs = (list: number[]) => list.map((n) => `Mc ${n}`).join(", ");

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

// ---------- Qui agit : la personne du robot, avec les droits de son niveau ----------
type Level = "owner" | "supervisor" | "staff" | "none";
type Me = NonNullable<Awaited<ReturnType<typeof loadMe>>>;

// Actions permises par niveau (vérifiées ici une deuxième fois, après le robot).
const STAFF_ACTIONS = ["machine", "machineCount", "stockOut", "maintDone", "cycle", "cycleDate"];
const SUPERVISOR_ACTIONS = ["machine", "machineCount", "gearStock", "workAdd", "workDone", "faultAdd", "faultFix", "cycle", "cycleDate",
  "maintPlan", "maintSchedule", "maintDone", "stockQty", "stockIn", "stockOut", "shiftSet"];
const allowed = (level: Level, action: string) =>
  level === "owner" ? [...SUPERVISOR_ACTIONS, "grade"].includes(action) : level === "supervisor" ? SUPERVISOR_ACTIONS.includes(action) : level === "staff" ? STAFF_ACTIONS.includes(action) : false;

/** Compte qui agit dans l'app : le propriétaire avec son vrai compte ; les autres avec leur nom et les droits de leur niveau. */
async function actorFor(p: { name: string; level: Level; userId?: number | null }): Promise<Me | null> {
  if (p.level === "owner") return p.userId ? await loadMe(p.userId) : await loadMe(g37.OWNER_USER_ID);
  const own = p.userId ? await loadMe(p.userId) : null;
  return {
    id: own?.id ?? g37.OWNER_USER_ID,
    displayName: own?.displayName ?? p.name,
    role: "user",
    jobRole: p.level === "supervisor" ? "superviseur" : "technicien",
    pending: false,
  } as Me;
}

export async function handleWaMutate(request: Request): Promise<Response> {
  if (!(await robot(request))) return json({ error: "forbidden" }, 403);
  const body = await request.json().catch(() => ({}));
  const p = body.person ?? {};
  const level = (["owner", "supervisor", "staff"].includes(p.level) ? p.level : "none") as Level;
  const ops: any[] = Array.isArray(body.ops) ? body.ops.slice(0, 40) : [];
  if (!ops.length || level === "none") return json({ error: "Rien à modifier ou personne non autorisée." }, 400);
  const me = await actorFor({ name: String(p.name ?? "WhatsApp").slice(0, 60), level, userId: Number(p.userId) || null });
  if (!me) return json({ error: "Compte introuvable." }, 404);
  const results: Array<{ action: string; ok: boolean; message?: string; error?: string }> = [];
  for (const op of ops) {
    const action = String(op?.action ?? "");
    if (!allowed(level, action)) { results.push({ action, ok: false, error: "Pas permis à ton niveau depuis WhatsApp." }); continue; }
    // Niveau staff : sur une machine, seulement les pignons (pas l'état de marche).
    if (level === "staff" && action === "machine") {
      const [m] = await sql`SELECT status FROM machines WHERE machine_no = ${Number(op.no)}`;
      if (!m || m.status !== op.status) { results.push({ action, ok: false, error: "Tu peux changer les pignons, pas l'état de la machine." }); continue; }
    }
    // Count filé (pas de bouton dans l'app pour ça) : mis à jour ici, avec le même droit que les relevés de machine.
    if (action === "machineCount") {
      const no = Number(op.no), count = Number(op.count);
      if (!g37.can("machine", me)) { results.push({ action, ok: false, error: "Tu n'as pas le droit de modifier les relevés d'une machine." }); continue; }
      if (!(no >= 1 && no <= 28 && count > 0 && count <= 500)) { results.push({ action, ok: false, error: "Count invalide." }); continue; }
      await sql`UPDATE machines SET run_count = ${count} WHERE machine_no = ${no}`;
      results.push({ action, ok: true, message: `M/C ${no} : count ${count}.` });
      continue;
    }
    const r = await applyOnce(me, null, op, null);
    results.push({ action, ok: r.status < 400, message: r.message, error: r.error });
  }
  if (results.some((r) => r.ok)) await broadcastChanged();
  await sql`INSERT INTO wa_edit_log (phone, person, level, summary, ops, result)
    VALUES (${String(p.phone ?? "").slice(0, 30)}, ${me.displayName}, ${level}, ${String(body.summary ?? "").slice(0, 1000)}, ${sql.json(ops)}, ${sql.json(results)})`;
  return json({ results, by: me.displayName });
}

// ---------- Appel du soir ----------
type Ask = { id: number; day: string; person_id: number; machines: number[]; ask_tomorrow: boolean; question: string; status: string;
  done_answer: number[] | null; tomorrow: number[] | null; planned_tomorrow: number[]; user_id: number | null; name: string; level: Level };

async function loadAsk(id: number): Promise<Ask | null> {
  const [a] = await sql`SELECT a.id, a.day::text AS day, a.person_id, a.machines, a.ask_tomorrow, a.question, a.status, a.done_answer, a.tomorrow, a.planned_tomorrow,
      p.user_id, p.name, p.level
    FROM wa_asks a JOIN wa_people p ON p.id = a.person_id WHERE a.id = ${id}`;
  return (a as Ask) ?? null;
}

async function doneOn(machines: number[], day: string): Promise<number[]> {
  if (!machines.length) return [];
  const rows = await sql`SELECT DISTINCT machine_id FROM maintenance_records WHERE performed_at = ${day}::date AND machine_id = ANY(${machines.map(machineId)})`;
  return rows.map((r: any) => Number(String(r.machine_id).replace(/\D/g, "")));
}

/**
 * Applique une réponse : done = machines du jour finies (null = pas répondu), tomorrow = machines de demain (null = pas répondu, [] = aucune).
 * Renvoie les lignes de confirmation et ce qui reste à demander.
 */
export async function resolveAsk(ask: Ask, done: number[] | null, tomorrow: number[] | null, via: "whatsapp" | "app")
  : Promise<{ lines: string[]; missing: Array<"done" | "tomorrow"> }> {
  const lines: string[] = [];
  const day = ask.day;
  const next = ddmm(addDays(beninDay(), 30));

  // 1) Maintenance du jour
  if (done && ask.done_answer == null && ask.machines.length) {
    const already = await doneOn(ask.machines, day);
    const wanted = [...new Set(done.map(Number))].filter((n) => ask.machines.includes(n));
    const todo = wanted.filter((n) => !already.includes(n));
    const me = await actorFor({ name: ask.name, level: ask.level === "none" ? "staff" : ask.level, userId: ask.user_id });
    for (const n of todo) {
      const r = me ? await applyOnce(me, null, { action: "maintDone", machineNo: n }, null) : { status: 500, error: "compte introuvable" };
      lines.push(r.status < 400 ? `✅ Mc ${n} : maintenance faite, prochaine le ${next}` : `⚠️ Mc ${n} : ${(r as any).error ?? "non enregistrée"}`);
    }
    for (const n of wanted.filter((x) => already.includes(x))) lines.push(`ℹ️ Mc ${n} : déjà enregistrée aujourd'hui`);
    for (const n of ask.machines.filter((x) => !wanted.includes(x) && !already.includes(x))) lines.push(`⏳ Mc ${n} : pas encore finie`);
    await sql`UPDATE wa_asks SET done_answer = ${wanted}::int[] WHERE id = ${ask.id}`;
    ask.done_answer = wanted;
  }

  // 2) Machine(s) de demain : programmées comme le bouton « Programmer la maintenance » (les techniciens sont prévenus).
  if (tomorrow && ask.tomorrow == null && ask.ask_tomorrow) {
    const list = [...new Set(tomorrow.map(Number))].filter((n) => n >= 1 && n <= 28).sort((a, b) => a - b);
    const dayAfter = addDays(day, 1);
    const same = list.length > 0 && list.length === (ask.planned_tomorrow ?? []).length && list.every((n) => ask.planned_tomorrow.includes(n));
    if (same) lines.push(`📅 Demain (${ddmm(dayAfter)}) : ${mcs(list)} confirmée(s)`);
    else if (list.length) {
      // Machines prévues demain mais retirées par la réponse : on les enlève du programme.
      for (const no of (ask.planned_tomorrow ?? []).filter((n) => !list.includes(n))) {
        await sql`UPDATE machines SET maint_planned_by = NULL, maint_planned_at = NULL, maint_plan_note = NULL WHERE id = ${machineId(no)} AND next_maintenance = ${dayAfter}::date`;
      }
      for (const no of list) {
        await sql`UPDATE machines SET next_maintenance = ${dayAfter}::date, maint_planned_by = ${ask.name}, maint_planned_at = now(),
          maint_plan_note = 'Confirmée au robot G37' WHERE id = ${machineId(no)}`;
      }
      const when = new Date(`${dayAfter}T00:00:00Z`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
      await notifyRoles({ jobRoles: ["technicien", "shift", "genmaint", "superviseur", "manager"], tag: `maint-prog-${dayAfter}`,
        title: `Maintenance programmée — ${when}`, body: `${list.map((n) => `M/C ${n}`).join(", ")} (confirmé par ${ask.name} au robot)`, data: { tab: "maintenance" } });
      lines.push(`📅 Demain (${ddmm(dayAfter)}) en maintenance : ${mcs(list)}`);
    } else {
      for (const no of ask.planned_tomorrow ?? []) {
        await sql`UPDATE machines SET maint_planned_by = NULL, maint_planned_at = NULL, maint_plan_note = NULL WHERE id = ${machineId(no)} AND next_maintenance = ${dayAfter}::date`;
      }
      lines.push(`📅 Demain : aucune machine en maintenance`);
    }
    await sql`UPDATE wa_asks SET tomorrow = ${list}::int[] WHERE id = ${ask.id}`;
    ask.tomorrow = list;
  }

  const missing: Array<"done" | "tomorrow"> = [];
  if (ask.machines.length && ask.done_answer == null) missing.push("done");
  if (ask.ask_tomorrow && ask.tomorrow == null) missing.push("tomorrow");
  if (!missing.length) {
    await sql`UPDATE wa_asks SET status = 'answered', answered_by = ${ask.name}, answered_via = ${via}, answered_at = now() WHERE id = ${ask.id}`;
    // Quelqu'un a répondu : les autres personnes appelées ce soir n'ont plus à répondre.
    await sql`UPDATE wa_asks SET status = 'closed' WHERE day = ${day}::date AND status = 'pending' AND id <> ${ask.id}`;
  }
  if (lines.length) {
    await sql`INSERT INTO wa_outbox (text) VALUES (${[`🧹 *Maintenance* — réponse de ${ask.name} au robot (${via === "app" ? "appel dans l'app" : "WhatsApp"})`, ...lines].join("\n")})`;
    await broadcastChanged();
  }
  return { lines, missing };
}

export async function handleWaAskCall(request: Request): Promise<Response> {
  if (!(await robot(request))) return json({ error: "forbidden" }, 403);
  const { askId } = await request.json().catch(() => ({}));
  const ask = await loadAsk(Number(askId));
  if (!ask) return json({ error: "Question introuvable" }, 404);
  if (!ask.user_id) return json({ called: false, reason: "pas de compte dans l'app" });
  // Même écran que les appels entre collègues (sonnerie plein écran, Répondre / Refuser) ; « ask-… » = question du robot.
  await notifyUsers({
    userIds: [ask.user_id], tag: `appel-ask-${ask.id}`, kind: "call",
    title: "Appel du Robot G37", body: "Maintenance : question du soir",
    data: { room: `ask-${ask.id}`, from: 0, name: "Robot G37", group: 0, video: 0, tab: "maintenance" },
  });
  return json({ called: true });
}

const numList = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : null);

export async function handleWaAskAnswer(request: Request): Promise<Response> {
  if (!(await robot(request))) return json({ error: "forbidden" }, 403);
  const body = await request.json().catch(() => ({}));
  const ask = await loadAsk(Number(body.askId));
  if (!ask) return json({ error: "Question introuvable" }, 404);
  if (ask.status !== "pending") return json({ lines: ["ℹ️ Quelqu'un a déjà répondu à cette question, merci."], missing: [] });
  return json(await resolveAsk(ask, numList(body.done), numList(body.tomorrow), "whatsapp"));
}

// Session absente ou expirée → 401 (l'app redemande la connexion) ; toute autre erreur → 500 (surtout pas de déconnexion).
function authError(e: unknown): Response {
  const name = (e as { name?: string; constructor?: { name?: string } })?.constructor?.name ?? (e as { name?: string })?.name;
  if (name === "NotAuthenticatedError") return json({ error: "Authentification requise" }, 401);
  console.error("wa-app session:", e);
  return json({ error: "Serveur momentanément indisponible" }, 500);
}

async function myAsk(request: Request, id: number | null): Promise<Ask | null> {
  const { user } = await getServerUserSession(request);
  if (id) {
    const ask = await loadAsk(id);
    return ask && ask.user_id === user.id ? ask : null;
  }
  const [r] = await sql`SELECT a.id FROM wa_asks a JOIN wa_people p ON p.id = a.person_id
    WHERE p.user_id = ${user.id} AND a.status = 'pending' AND a.day = ${beninDay()}::date ORDER BY a.id DESC LIMIT 1`;
  return r ? await loadAsk(Number(r.id)) : null;
}

export async function handleAsk(request: Request): Promise<Response> {
  let ask;
  try { ask = await myAsk(request, Number(new URL(request.url).searchParams.get("id")) || null); } catch (e) { return authError(e); }
  if (!ask) return json({ ask: null });
  const already = await doneOn(ask.machines, ask.day);
  return json({ ask: { id: ask.id, question: ask.question, machines: ask.machines, already, status: ask.status,
    askDone: ask.machines.length > 0 && ask.done_answer == null, askTomorrow: ask.ask_tomorrow && ask.tomorrow == null, tomorrowDay: addDays(ask.day, 1), planned: ask.planned_tomorrow ?? [] } });
}

export async function handleAskAnswer(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  let ask;
  try { ask = await myAsk(request, Number(body.id) || null); } catch (e) { return authError(e); }
  if (!ask) return json({ error: "Question introuvable" }, 404);
  if (ask.status !== "pending") return json({ lines: ["ℹ️ Quelqu'un a déjà répondu à cette question, merci."], missing: [] });
  return json(await resolveAsk(ask, numList(body.done), numList(body.tomorrow), "app"));
}

export async function handleAskAudio(request: Request): Promise<Response> {
  let ask;
  try { ask = await myAsk(request, Number(new URL(request.url).searchParams.get("id")) || null); } catch (e) { return authError(e); }
  if (!ask) return json({ error: "Question introuvable" }, 404);
  const [a] = await sql`SELECT audio FROM wa_asks WHERE id = ${ask.id}`;
  if (!a?.audio) return json({ error: "Pas de voix pour cette question" }, 404);
  const bin = Uint8Array.from(atob(String(a.audio)), (c) => c.charCodeAt(0));
  return new Response(bin, { status: 200, headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=86400" } });
}
