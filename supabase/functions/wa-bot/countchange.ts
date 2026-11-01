// Count change par WhatsApp (27/10/2026).
// - « RF 6 count change finish / attend / done » : applique le changement en attente de la machine
//   (comme le bouton « Fait » de l'app : pignons, count, stock et confirmation dans le groupe).
// - Photo de fiche avec la légende « count change finish » : appliquée tout de suite.
// - Photo de fiche sans légende : le robot demande « 1 = déjà changé · 2 = à changer » et applique selon la réponse.
import { rf, sql } from "./db.ts";
import { extractMachines, normalize } from "./parse.ts";

const CC_RE = /\b(count\s*chang\w*|count\s+(?:is\s+|will\s+be\s+|to\s+be\s+)?(?:going\s+to\s+be\s+)?chang\w*|changing\s*slip|slip)\b/i;
const DONE_RE = /(?<![\p{L}\p{N}])(finish\p{L}*|attend(?:ed)?|done|fait|termin\p{L}*|complet\p{L}*|changed|already|d[ée]j[aà]|posed|pos[ée]s?|install\p{L}*|ok|okay)(?![\p{L}\p{N}])/iu;
const TODO_RE = /\b(will|going\s+to|to\s+be|tomorrow|demain|pr[ée]vu\w*|plan\w*|later|bient[oô]t|not\s+yet|pas\s+encore|to\s+do|todo|attente|wait\w*|prochain\w*|next)\b|[àa]\s+(?:faire|changer)/i;
const REQ_RE = /\b(pls|please|plz|kindly|need|come|help)\b/i;

/** « done » = le changement est fait ; « todo » = il est prévu ; null = ce n'est pas un count change. */
export function countChangeState(text: string): "done" | "todo" | null {
  const s = normalize(text);
  if (!CC_RE.test(s)) return null;
  if (TODO_RE.test(s) || REQ_RE.test(s)) return "todo";
  return DONE_RE.test(s) ? "done" : "todo";
}

// Réponses à la question du robot.
const YES_RE = /^\W*(1|oui|yes|yeah|yep|d[ée]j[aà](?:\s+(?:fait|chang\p{L}*|pos\p{L}*))?|already(?:\s+(?:changed|done))?|done|fait|finish\p{L}*|attend(?:ed)?|changed|c'?est\s+fait|ok\s+done)\W*$/iu;
const NO_RE = /^\W*(2|non|no|not\s+yet|pas\s+encore|[àa]\s+(?:faire|changer)|to\s+(?:do|change)|will\s+change|later|plus\s+tard|demain|tomorrow)\W*$/iu;

/** Applique les changements en attente (marque le travail « fait » : le déclencheur de la base fait le reste). */
export async function applyPending(requestIds: string[], who: string, at: Date): Promise<string[]> {
  const done: string[] = [];
  for (const id of requestIds) {
    const [r] = await sql`SELECT machine_no, work_id, new_g, new_h, count_label FROM gear_change_requests WHERE id = ${id} AND status = 'pending'`;
    if (!r?.work_id) continue;
    await sql`UPDATE gear_change_requests SET asked_at = NULL WHERE id = ${id}`;
    const w = await sql`UPDATE works SET status = 'done', done_by_name = ${who}, done_at = ${at} WHERE id = ${r.work_id} AND status = 'todo' RETURNING id`;
    if (w.length) done.push(`${rf(Number(r.machine_no))} : count change appliqué (G${r.new_g} · H${r.new_h}${r.count_label ? ` · ${r.count_label}` : ""})`);
  }
  return done;
}

async function pendingFor(machines: number[]) {
  if (!machines.length) return [];
  return await sql`SELECT DISTINCT ON (machine_no) id, machine_no FROM gear_change_requests
    WHERE machine_no = ANY(${machines}) AND status = 'pending' ORDER BY machine_no, created_at DESC`;
}

export type CcResult = { action: string; machines: number[]; done: string[]; reply: string | null } | null;

/** Message écrit : « RF 6 count change finish », ou réponse « 1 / 2 » à la question du robot. */
export async function countChangeText(m: { group: string; sender: string; at: Date }, text: string, quoted: string | null): Promise<CcResult> {
  // 1) Réponse à la question posée après une photo de fiche (même personne, même groupe, ou citation du message du robot).
  const short = normalize(text);
  if (short.length <= 40 && (YES_RE.test(short) || NO_RE.test(short))) {
    const quotedBot = !!quoted && /count change/i.test(quoted) && /(1|2)\s*[:=]?/.test(quoted);
    // Réponse à un autre message qui cite une machine : ce n'est pas pour la question du robot.
    const otherQuote = !!quoted && !quotedBot && extractMachines(quoted).length > 0;
    const asked = otherQuote ? [] : await sql`SELECT id, machine_no FROM gear_change_requests
      WHERE status = 'pending' AND asked_at > now() - interval '8 hours' AND asked_group = ${m.group}
        AND (asked_sender = ${m.sender} OR ${quotedBot})
      ORDER BY asked_at DESC`;
    if (asked.length) {
      const nos = asked.map((r) => Number(r.machine_no));
      if (YES_RE.test(short)) {
        const done = await applyPending(asked.map((r) => String(r.id)), m.sender, m.at);
        return { action: "count_done", machines: nos, done, reply: null };   // la confirmation part du déclencheur
      }
      await sql`UPDATE gear_change_requests SET asked_at = NULL WHERE id = ANY(${asked.map((r) => String(r.id))})`;
      const list = nos.map(rf).join(", ");
      return { action: "count_todo", machines: nos, done: [`${list} : count change gardé à faire`],
        reply: `👍 Noté : le count change *${list}* reste à faire.\nUne fois fait, appuyez sur *Fait* dans l'app ou écrivez « ${rf(nos[0])} count change finish ».` };
    }
  }

  // 2) « RF 6 count change finish / attend / done »
  if (countChangeState(text) !== "done") return null;
  let machines = extractMachines(text);
  if (!machines.length && quoted) machines = extractMachines(quoted);
  if (!machines.length) return null;
  const pending = await pendingFor(machines);
  const done = await applyPending(pending.map((r) => String(r.id)), m.sender, m.at);
  let missing = machines.filter((n) => !pending.some((r) => Number(r.machine_no) === n));
  // Count change annoncé par message, sans fiche : on clôture le travail « Count change » ouvert.
  if (missing.length) {
    const closed = await sql`UPDATE works SET status = 'done', done_by_name = ${m.sender}, done_at = ${m.at}
      WHERE machine_no = ANY(${missing}) AND status = 'todo' AND title ILIKE 'Count change%' RETURNING machine_no`;
    const nos = [...new Set(closed.map((r) => Number(r.machine_no)))];
    for (const n of nos) done.push(`${rf(n)} : travail « Count change » clôturé (sans fiche, pignons non modifiés)`);
    missing = missing.filter((n) => !nos.includes(n));
  }
  const reply = missing.length
    ? `ℹ️ *${missing.map(rf).join(", ")}* : aucune fiche count change en attente.\nEnvoyez la photo de la fiche avec la légende *count change finish* : le robot mettra la machine à jour.`
    : null;
  return { action: "count_done", machines, done, reply };
}

/** Marque les demandes créées depuis une photo sans légende : la réponse « 1 / 2 » de cette personne les appliquera. */
export async function markAsked(requestIds: string[], group: string, sender: string) {
  if (!requestIds.length) return;
  await sql`UPDATE gear_change_requests SET asked_at = now(), asked_group = ${group}, asked_sender = ${sender} WHERE id = ANY(${requestIds})`;
}
