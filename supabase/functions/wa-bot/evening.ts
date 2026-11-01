// Appel du soir (01/11/2026). Vers 16h30, le robot appelle le superviseur :
//   1) la maintenance des machines prévues aujourd'hui est-elle finie ?
//   2) quelle(s) machine(s) passe(nt) en maintenance demain ?
// « Appeler » = note vocale + question en privé sur WhatsApp, et écran d'appel dans l'app (question lue, boutons).
// Sans réponse au bout de 15 min : les responsables de maintenance, puis le propriétaire en dernier recours.
// La première réponse complète clôt la question pour tout le monde.
import { beninDay, config, once, outbox, rf, sql } from "./db.ts";
import { speak } from "./gemini.ts";
import { appApi, people, type Person } from "./people.ts";

const isMaintWork = (t: string) => /\b(maint\w*|mtce|mntc|clg|clng|clea?n\w*|nettoy\w*|entretien)\b/i.test(t) && !/\bteam\b/i.test(t);
const addDays = (day: string, n: number) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Machines prévues en maintenance ce jour-là et pas encore enregistrées comme faites. */
export async function plannedToday(day = beninDay()): Promise<number[]> {
  const planned = await sql`SELECT machine_no FROM machines WHERE next_maintenance = ${day}::date AND maint_planned_by IS NOT NULL`;
  const works = await sql`SELECT machine_no, title FROM works WHERE status = 'todo' AND (created_at + interval '1 hour')::date = ${day}::date`;
  const all = new Set<number>([...planned.map((r) => Number(r.machine_no)), ...works.filter((w) => isMaintWork(String(w.title))).map((w) => Number(w.machine_no))]);
  if (!all.size) return [];
  const done = await sql`SELECT DISTINCT machine_id FROM maintenance_records WHERE performed_at = ${day}::date`;
  const doneNos = new Set(done.map((r) => Number(String(r.machine_id).replace(/\D/g, ""))));
  return [...all].filter((n) => n >= 1 && n <= 28 && !doneNos.has(n)).sort((a, b) => a - b);
}

/** Machines déjà programmées pour demain (le superviseur l'a peut-être fait dans l'app). */
async function plannedTomorrow(day: string): Promise<number[]> {
  const rows = await sql`SELECT machine_no FROM machines WHERE next_maintenance = ${addDays(day, 1)}::date AND maint_planned_by IS NOT NULL ORDER BY machine_no`;
  return rows.map((r) => Number(r.machine_no));
}

const list = (nums: number[]) => nums.length === 1 ? `de la ${rf(nums[0])}` : `des ${nums.slice(0, -1).map(rf).join(", ")} et ${rf(nums[nums.length - 1])}`;
const spoken = (nums: number[]) => nums.length === 1 ? `de la machine ${nums[0]}` : `des machines ${nums.slice(0, -1).join(", ")} et ${nums[nums.length - 1]}`;

async function minutesOf(key: string, def: string): Promise<number> {
  const [h, m] = ((await config(key)) || def).split(":").map(Number);
  return (Number.isFinite(h) ? h : 16) * 60 + (Number.isFinite(m) ? m : 30);
}

function questionFor(p: Person, today: number[], askTomorrow: boolean, tier: number, planned: number[]): string {
  const first = p.name.split(" ")[0];
  const parts: string[] = [`🤖 *Bonsoir ${first}*, ici le robot G37.${tier > 1 ? " (Le superviseur n'a pas encore répondu.)" : ""}`];
  if (today.length) parts.push(`1️⃣ La *maintenance ${list(today)}* (prévue aujourd'hui) est-elle *finie* ?`);
  const t2 = today.length ? "2️⃣" : "📅";
  if (askTomorrow && planned.length) parts.push(`${t2} Demain, *${planned.map(rf).join(", ")}* ${planned.length > 1 ? "sont prévues" : "est prévue"} en maintenance. *C'est confirmé ?* (sinon, donne la bonne machine)`);
  else if (askTomorrow) parts.push(`${t2} *Quelle machine passe en maintenance demain ?*`);
  const ex = today.length && askTomorrow
    ? (planned.length ? `« oui, confirmé »  ·  « non, demain 5 »  ·  « oui, demain 8 à la place »` : `« oui, demain 5 »  ·  « non, demain 5 et 6 »  ·  « oui, demain aucune »`)
    : today.length ? `« oui »  ·  « non »${today.length > 1 ? `  ·  « ${today[0]} finie »` : ""}`
    : planned.length ? `« oui »  ·  « demain 5 à la place »  ·  « aucune »` : `« demain 5 »  ·  « 5 et 6 »  ·  « aucune »`;
  parts.push(`Réponds par exemple : ${ex}\n_(écrit ou note vocale)_`);
  return parts.join("\n\n");
}

function voiceFor(today: number[], askTomorrow: boolean, planned: number[]): string {
  const v = ["Bonsoir. Ici le robot G37."];
  if (today.length) v.push(`La maintenance ${spoken(today)} est-elle terminée ?`);
  if (askTomorrow && planned.length) v.push(`Demain, la maintenance ${spoken(planned)} est prévue. Pouvez-vous confirmer ?`);
  else if (askTomorrow) v.push("Et quelle machine passe en maintenance demain ?");
  v.push("Répondez par message, ou dans l'application.");
  return v.join(" ");
}

export async function eveningRun(force = false): Promise<Record<string, unknown>> {
  const now = new Date(Date.now() + 3600_000); // heure du Bénin
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const day = beninDay();
  const at = await minutesOf("wa.evening_at", "16:30");
  const step = Number(await config("wa.escalate_min")) || 15;
  if (!force && minutes < at) return { state: "trop tôt" };
  if (!force && minutes >= at + 240) return { state: "fenêtre passée" };

  const asks = await sql`SELECT id, person_id, tier, status, created_at FROM wa_asks WHERE day = ${day}::date ORDER BY tier, id`;
  if (asks.some((a) => a.status === "answered")) return { state: "répondu" };

  const everyone = (await people()).filter((p) => p.call_tier != null);
  const tiers = [...new Set<number>(everyone.map((p) => Number(p.call_tier)))].sort((a, b) => a - b);
  if (!tiers.length) return { state: "personne à appeler" };

  // Palier suivant : le premier au départ ; ensuite un nouveau palier toutes les 15 min sans réponse.
  const askedTiers: number[] = [...new Set<number>(asks.map((a) => Number(a.tier)))];
  const lastTier = askedTiers.length ? Math.max(...askedTiers) : null;
  let tier: number | null = null;
  if (lastTier == null) tier = tiers[0];
  else {
    const lastAt = Math.max(...asks.filter((a) => Number(a.tier) === lastTier).map((a) => new Date(a.created_at).getTime()));
    const next = tiers.find((t) => t > lastTier);
    if (next != null && Date.now() - lastAt >= step * 60_000) tier = next;
  }
  // Toujours sans réponse 1 h après le dernier appel : message dans le groupe (une fois).
  if (tier == null) {
    const lastAt = asks.length ? Math.max(...asks.map((a) => new Date(a.created_at).getTime())) : 0;
    if (lastAt && Date.now() - lastAt > 60 * 60_000 && await once(`wa-evening-late:${day}`)) await lateNotice(day);
    return { state: "en attente de réponse", tier: lastTier };
  }

  const today = await plannedToday(day);
  const tomorrowSet = await plannedTomorrow(day);
  const askTomorrow = Number(now.getUTCDay()) !== 6 || !!(await config("wa.ask_sunday")); // samedi soir : pas de maintenance le dimanche
  if (!today.length && !askTomorrow) return { state: "rien à demander" };

  const callees = everyone.filter((p) => Number(p.call_tier) === tier && !asks.some((a) => Number(a.person_id) === p.id));
  const audio = await speak(voiceFor(today, askTomorrow, tomorrowSet)).catch(() => "");
  let asked = 0;
  for (const p of callees) {
    const question = questionFor(p, today, askTomorrow, tier, tomorrowSet);
    const [row] = await sql`INSERT INTO wa_asks (day, person_id, tier, machines, ask_tomorrow, planned_tomorrow, question, audio)
      VALUES (${day}::date, ${p.id}, ${tier}, ${today}::int[], ${askTomorrow}, ${tomorrowSet}::int[], ${question}, ${audio || null})
      ON CONFLICT (day, person_id) DO NOTHING RETURNING id`;
    if (!row) continue;
    asked++;
    await sql`INSERT INTO wa_outbox (text, to_phone, voice) VALUES (${question}, ${p.phone}, ${audio || null})`;
    if (p.user_id) await appApi("wa/ask_call", { askId: Number(row.id) }).catch((e) => console.error("Appel app:", e));
  }
  return { state: "appel envoyé", tier, asked, today, askTomorrow };
}

async function lateNotice(day: string) {
  const left = await plannedToday(day);
  const tomorrow = await plannedTomorrow(day);
  const lines = ["⏰ *Maintenance* : personne n'a répondu au robot ce soir."];
  if (left.length) lines.push(`• À confirmer : ${left.map(rf).join(", ")} → *Rf ${left[0]} maintenance clg finish* quand c'est fini.`);
  if (!tomorrow.length) lines.push("• Aucune machine programmée pour demain : le superviseur peut la programmer depuis l'accueil de l'app.");
  await outbox(lines.join("\n"));
}

/** Question du soir en attente pour cette personne (aujourd'hui). */
export async function pendingAsk(personId: number) {
  const [a] = await sql`SELECT id, machines, ask_tomorrow, planned_tomorrow, done_answer, tomorrow FROM wa_asks WHERE person_id = ${personId} AND status = 'pending'
    AND day = ${beninDay()}::date ORDER BY id DESC LIMIT 1`.catch(() => [] as never[]);
  if (!a) return null;
  return {
    id: Number(a.id), machines: (a.machines as number[]).map(Number),
    needDone: (a.machines as number[]).length > 0 && a.done_answer == null, needTomorrow: !!a.ask_tomorrow && a.tomorrow == null,
    planned: ((a.planned_tomorrow ?? []) as number[]).map(Number),
  };
}

const YES = /^\W*(oui|yes|y|ok|okay|ouais|yep|yeah|c'?est fini|fini(?:e|es|s)?|termin\p{L}*|fait|done|finish\p{L}*|tout(?:es)? fini\p{L}*|all done)\W*$/iu;
const NO = /^\W*(non|no|n|pas encore|pas fini\p{L}*|not yet|not finished|en cours)\W*$/iu;
const NEG = /\b(pas|non|not|no|encore|reste|restant|en cours)\b/i;
const NONE_RE = /\b(aucune?|rien|personne|none|nothing|no machine|pas de machine|pas de maintenance)\b/i;
const TOMORROW_RE = /\b(demain|tomorrow|tmrw|next day|lendemain)\b/i;

function todayPart(t: string, machines: number[]): number[] | null {
  const s = t.trim().replace(/^[\s,;.:-]+|[\s,;.:-]+$/g, "");
  if (!s) return null;
  if (YES.test(s) || /^\W*(oui|yes|ok|fini\w*|done|fait)\b/i.test(s) && !NEG.test(s.replace(/^\W*\w+/, ""))) return machines;
  if (NO.test(s) || /^\W*(non|no|pas encore|not yet)\b/i.test(s)) return [];
  const cited = (x: string) => [...x.matchAll(/(?<!\d)\d{1,2}(?!\d)/g)].map((m) => Number(m[0])).filter((n) => machines.includes(n));
  if (!cited(s).length) return null;
  // Morceau par morceau : « Mc 7 fini, 3 pas encore » → 7 finie, 3 non. Un numéro sans mot négatif = fini.
  const done = new Set<number>(), notDone = new Set<number>();
  for (const part of s.split(/[,;.\n]|\b(?:et|and|mais|but)\b/i)) {
    const nums = cited(part);
    for (const n of nums) (NEG.test(part) ? notDone : done).add(n);
  }
  if (!done.size && notDone.size) return machines.filter((n) => !notDone.has(n));
  return [...done].filter((n) => !notDone.has(n));
}

function tomorrowPart(t: string): number[] | null {
  if (NONE_RE.test(t)) return [];
  // « pas la 5 mais la 6 », « not 5 but 6 » : le numéro refusé est retiré.
  t = t.replace(/\b(?:pas|not|plut[oô]t que|au lieu de|instead of)\s+(?:la\s+|le\s+|de\s+la\s+|mc\s*|machine\s*)?\d{1,2}(?!\d)/gi, " ");
  const nums = [...t.matchAll(/(?<!\d)\d{1,2}(?!\d)/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= 28);
  return nums.length ? [...new Set(nums)] : null;
}

/**
 * Lit la réponse au message du soir.
 * done : machines du jour finies (null = pas de réponse sur ce point) ; tomorrow : machines de demain (null = pas de réponse, [] = aucune).
 * Renvoie null si le message ne répond à rien.
 */
export function readAnswer(text: string, ask: { machines: number[]; needDone: boolean; needTomorrow: boolean; planned?: number[] }): { done: number[] | null; tomorrow: number[] | null } | null {
  const t = text.trim();
  if (!t) return null;
  let done: number[] | null = null, tomorrow: number[] | null = null;
  const k = t.search(TOMORROW_RE);
  if (k >= 0) {
    if (ask.needDone) done = todayPart(t.slice(0, k), ask.machines);
    if (ask.needTomorrow) tomorrow = tomorrowPart(t.slice(k));
  } else if (ask.needDone && ask.needTomorrow) {
    // Sans le mot « demain » : « oui » / « non » = aujourd'hui ; des numéros hors des machines du jour = demain.
    const head = t.match(/^\W*(oui|yes|ok|okay|non|no|fini\w*|done|fait|pas encore|not yet)\b/i);
    if (head) {
      done = todayPart(head[0], ask.machines);
      const rest = t.slice(head[0].length);
      const nums = tomorrowPart(rest);
      if (nums) tomorrow = nums;
    } else {
      const d = todayPart(t, ask.machines);
      const other = [...t.matchAll(/(?<!\d)\d{1,2}(?!\d)/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= 28 && !ask.machines.includes(n));
      if (d && d.length) done = d;
      if (other.length) tomorrow = [...new Set(other)];
      else if (NONE_RE.test(t)) tomorrow = [];
    }
  } else if (ask.needDone) done = todayPart(t, ask.machines);
  else if (ask.needTomorrow) tomorrow = tomorrowPart(t);
  // Machine de demain déjà prévue : « oui », « confirmé », « ok » sans autre numéro = on garde ce qui est prévu.
  const planned = ask.planned ?? [];
  if (ask.needTomorrow && tomorrow == null && planned.length && /\b(oui|yes|ok|okay|confirm\p{L}*|d'?accord|c'?est (?:bon|ça|ca)|exact|correct)\b/iu.test(t)
    && !(k >= 0 && /\b(non|no|pas)\b/i.test(t.slice(k)))) tomorrow = planned;
  if (done == null && tomorrow == null) return null;
  return { done, tomorrow };
}
