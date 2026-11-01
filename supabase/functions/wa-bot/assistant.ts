// Assistant technique G37 sur WhatsApp : questions en privé (ou « ? » dans Ring Fram Local Team),
// photos d'écran, notes vocales. Répond avec les données de l'atelier + l'IA, propose d'enregistrer
// (panne, remise en marche, maintenance, magasin, graissage) avec confirmation Oui / Non.
import { beninDay, config, ddmm, diff, isoDay, once, outbox, sql, when } from "./db.ts";
import { availableStock, draftOf, fmt2, pct, proposals } from "./gears.ts";
import { gemini, QuotaError, quotaMessage, type Part, type Turn } from "./gemini.ts";
import { extractMachines, normalize, parseMessage } from "./parse.ts";
import { buildEdits, EDITS_HELP, EDITS_SCHEMA, type Intent } from "./edits.ts";
import { pendingAsk, readAnswer } from "./evening.ts";
import { appApi, learnName, LEVEL_FR, personByPhone, type Person } from "./people.ts";

export type ChatIn = {
  user: string; name?: string; channel?: "private" | "group"; member?: boolean; phone?: string | null;
  text?: string; quoted?: string | null; image?: string; imageMime?: string; audio?: string; audioMime?: string;
};
export type ChatOut = { reply: string; executed?: boolean };
export type Exec = (text: string, sender: string, id: string, solution: string | null) => Promise<{ done?: string[]; reply?: string | null; action?: string }>;

const STATUS_FR: Record<string, string> = { service: "en service", arret: "À L'ARRÊT", maintenance: "EN MAINTENANCE" };
const YES = /^\s*(oui|yes|y|ok|okay|d'?accord|vas[- ]?y|confirm\w*|go|ouais|yep|yeah|c'?est bon|fais[- ]le|valide\w*|👍|✅)\W*$/iu;
const NO = /^\s*(non|no|n|nope|annule\w*|cancel\w*|stop|laisse\w*|pas besoin|❌)\W*$/iu;

// ---------- Données de l'atelier ----------
async function snapshot(today: string): Promise<string> {
  const [machines, faults, works, pendingGears] = await Promise.all([
    sql`SELECT machine_no, status, stop_reason, stopped_since, run_g, run_h, run_count, next_maintenance FROM machines ORDER BY machine_no`,
    sql`SELECT machine_id, issue, opened_at, reported_by FROM failures WHERE status <> 'resolue' ORDER BY opened_at`,
    sql`SELECT machine_no, title FROM works WHERE status = 'todo' ORDER BY created_at`,
    sql`SELECT machine_no, new_g, new_h, count_label FROM gear_change_requests WHERE status = 'pending'`,
  ]);
  const lines = machines.map((m) => {
    const no = Number(m.machine_no);
    const parts = [`Mc ${no}: ${STATUS_FR[m.status] ?? m.status}${m.status !== "service" && m.stop_reason ? ` (${m.stop_reason})` : ""}`,
      `G${m.run_g ?? "?"}/H${m.run_h ?? "?"}${m.run_count != null ? ` count ${Number(m.run_count)}` : ""}`];
    if (m.next_maintenance) { const d = isoDay(m.next_maintenance); parts.push(`maintenance clg ${ddmm(d)} (${when(diff(d, today))})`); }
    const f = faults.filter((x) => Number(String(x.machine_id).replace(/\D/g, "")) === no);
    if (f.length) parts.push(`pannes ouvertes: ${f.map((x) => `${x.issue} depuis ${ddmm(beninDay(new Date(x.opened_at)))} (signalé par ${x.reported_by ?? "?"})`).join("; ")}`);
    const w = works.filter((x) => Number(x.machine_no) === no);
    if (w.length) parts.push(`à faire: ${w.map((x) => x.title).join("; ")}`);
    const g = pendingGears.find((x) => Number(x.machine_no) === no);
    if (g) parts.push(`count change en attente du bouton Fait: G${g.new_g}/H${g.new_h}${g.count_label ? ` (${g.count_label})` : ""}`);
    return parts.join(" · ");
  });
  return lines.join("\n");
}

async function machineDetails(nums: number[], today: string): Promise<string> {
  const out: string[] = [];
  for (const n of nums.slice(0, 4)) {
    const mid = "M-" + String(n).padStart(2, "0");
    const [faults, sols, maint, greasing] = await Promise.all([
      sql`SELECT id, issue, status, opened_at, resolved_at, fixed_by, reported_by FROM failures WHERE machine_id = ${mid} ORDER BY opened_at DESC LIMIT 15`,
      sql`SELECT failure_id, issue, solution, author, created_at FROM wa_solutions WHERE machine_no = ${n} ORDER BY created_at DESC LIMIT 10`,
      sql`SELECT maintenance_type, performed_at, technician FROM maintenance_records WHERE machine_id = ${mid} ORDER BY performed_at DESC LIMIT 3`,
      sql`SELECT DISTINCT ON (kind, point_key) kind, point_key, done_on FROM greasing_records WHERE machine_no = ${n} ORDER BY kind, point_key, done_on DESC`,
    ]);
    const lines = [`### Mc ${n}`];
    lines.push("Historique des pannes (récent d'abord) :");
    if (!faults.length) lines.push("- aucune");
    for (const f of faults) {
      const sol = sols.find((s) => s.failure_id === f.id);
      const dur = f.resolved_at ? Math.round((new Date(f.resolved_at).getTime() - new Date(f.opened_at).getTime()) / 60_000) : null;
      lines.push(`- ${ddmm(beninDay(new Date(f.opened_at)))}: ${f.issue} — ${f.status === "resolue" ? `réglée${dur != null ? ` en ${dur >= 120 ? Math.round(dur / 60) + " h" : dur + " min"}` : ""}${f.fixed_by ? ` par ${f.fixed_by}` : ""}` : "OUVERTE"}${sol ? ` — solution: ${sol.solution}` : ""}`);
    }
    const loose = sols.filter((s) => !s.failure_id || !faults.some((f) => f.id === s.failure_id));
    for (const s of loose) lines.push(`- solution notée le ${ddmm(beninDay(new Date(s.created_at)))} (${s.issue ?? "panne"}): ${s.solution}`);
    if (maint.length) lines.push(`Maintenances: ${maint.map((x) => `${ddmm(isoDay(x.performed_at))} ${x.maintenance_type}${x.technician ? ` (${x.technician})` : ""}`).join("; ")}`);
    if (greasing.length) lines.push(`Derniers graissages/lubrifications: ${greasing.map((x) => `${x.kind}:${x.point_key} ${ddmm(isoDay(x.done_on))}`).join(", ")}`);
    out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}

async function stockText(): Promise<string> {
  const [gears, items] = await Promise.all([
    sql`SELECT gear_type, teeth, stock FROM gears WHERE stock > 0 ORDER BY gear_type, teeth`,
    sql`SELECT name, category, quantity, minimum_quantity, unit FROM stock_items ORDER BY category, name`,
  ]);
  const g = gears.map((x) => `${x.gear_type}${x.teeth}×${x.stock}`).join(", ");
  const i = items.map((x) => `${x.name}: ${Number(x.quantity)} ${x.unit}${Number(x.minimum_quantity) > 0 && Number(x.quantity) < Number(x.minimum_quantity) ? ` (SOUS LE SEUIL ${Number(x.minimum_quantity)})` : ""}`).join("; ");
  return `Pignons en stock (pièces, 6 par machine): ${g || "aucun"}\nMagasin: ${i}`;
}

const STOP = new Set(["the", "and", "for", "what", "how", "why", "this", "that", "with", "please", "machine", "mc", "rf", "est", "les", "des", "une", "pour", "quoi", "comment", "pourquoi", "dans", "sur", "avec", "faire", "fait", "qui", "que", "quel", "quelle", "problem", "issue", "panne", "aide", "help"]);
const keywords = (s: string) => [...new Set(normalize(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);

// Recherche dans le manuel (anglais) : mots de la question traduits du français, codes de défaut (285, F10, Y20) gardés tels quels.
const FR_EN: Record<string, string> = {
  pression: "pressure", basse: "low", bas: "low", faible: "low", haute: "high", elevee: "high", courroie: "belt", courroies: "belt",
  broche: "spindle", broches: "spindle", anneau: "ring", anneaux: "ring", curseur: "traveller", curseurs: "traveller",
  etirage: "drafting", cylindre: "roller", cylindres: "roller", manchon: "apron cot", manchons: "apron cot", capteur: "sensor",
  capteurs: "sensor", moteur: "motor", variateur: "converter inverter", convertisseur: "converter", levee: "doffing doffer",
  leveuse: "doffer", aspiration: "suction vacuum", casse: "break broken", cassee: "broken", rupture: "break", fil: "yarn",
  fils: "yarn", meche: "roving", meches: "roving", defaut: "fault", panne: "fault", erreur: "error", alarme: "alarm",
  graissage: "grease lubrication", graisser: "grease", huile: "oil", lubrification: "lubrication", vitesse: "speed",
  bobine: "bobbin", bobines: "bobbin", tube: "tube", tubes: "tube", frein: "brake", ventilateur: "fan", filtre: "filter",
  fuite: "leak", vanne: "valve", electrovanne: "valve solenoid", refroidissement: "cooling", temperature: "temperature",
  surchauffe: "overheating temperature", ecran: "display screen", demarrage: "start startup", demarre: "start", arret: "stop",
  nettoyage: "cleaning", bruit: "noise", reglage: "setting adjustment", regler: "adjust", torsion: "twist", pignon: "gear wheel",
  pignons: "gear wheel", engrenage: "gear", guide: "guide", ballon: "balloon", separateur: "separator", chaine: "chain",
  poulie: "pulley", roulement: "bearing", palier: "bearing", tambour: "drum", armoire: "cabinet", electrique: "electrical",
  fusible: "fuse", disjoncteur: "circuit breaker", coupure: "power failure", courant: "power current", compteur: "counter",
  tension: "tension voltage", chariot: "ring rail", banc: "ring rail", porte: "door", securite: "safety", vide: "vacuum",
  bourrage: "jam", bloque: "blocked", bloquee: "blocked", tourne: "running", marche: "running", entretien: "maintenance",
};
const STOP_EN = new Set(["the", "and", "for", "what", "how", "why", "this", "that", "with", "please", "est", "les", "des", "une", "pour", "quoi",
  "comment", "pourquoi", "dans", "sur", "avec", "faire", "fait", "qui", "que", "quel", "quelle", "aide", "help", "dois", "doit", "verifier",
  "check", "mc", "rf", "machine", "affiche", "show", "shows", "message", "il", "elle", "on", "je", "tu", "nous", "vous", "de", "du", "la", "le"]);
const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export async function knowledge(question: string): Promise<string> {
  const words = new Set<string>();
  for (const w of plain(normalize(question)).split(/[^a-z0-9]+/)) {
    if (!w || STOP_EN.has(w)) continue;
    if (/^\d+$/.test(w) && w.length < 3) continue; // « 25 » (numéro de machine) : pas utile dans le manuel
    if (w.length < 3 && !/^[a-z]\d+$/.test(w)) continue;
    words.add(w);
    for (const t of (FR_EN[w] ?? "").split(" ").filter(Boolean)) words.add(t);
  }
  const list = [...words].slice(0, 16);
  if (!list.length) return "";
  const q = list.join(" | ");
  // Classement : d'abord les pages qui contiennent le plus de mots de la question (codes compris), puis la pertinence.
  const rows = await sql`SELECT source, title, page, content,
      (SELECT count(*) FROM unnest(${list}::text[]) t WHERE tsv_en @@ plainto_tsquery('english', t)) AS hits,
      ts_rank(tsv_en, to_tsquery('english', ${q})) AS r
    FROM wa_knowledge WHERE tsv_en @@ to_tsquery('english', ${q})
    ORDER BY hits DESC, r DESC LIMIT 5`.catch((e) => { console.error("Manuel:", e); return []; });
  return rows.map((r) => `[${r.source}${r.page ? ` p.${r.page}` : ""}${r.title ? " — " + r.title : ""}]\n${String(r.content).slice(0, 2200)}`).join("\n\n");
}

// Photo : lecture rapide du texte affiché (message, code de défaut) pour chercher dans le manuel.
async function readScreen(b64: string, mime: string): Promise<string> {
  try {
    const raw = await gemini([{ role: "user", parts: [
      { inline_data: { mime_type: mime, data: b64 } },
      { text: 'Copy all text visible on this machine screen/photo (fault messages, fault codes, numbers, labels). JSON: {"text": string}' },
    ] }], { schema: { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] }, budgetMs: 40_000 });
    return String(JSON.parse(raw).text ?? "").slice(0, 600);
  } catch (e) { if (e instanceof QuotaError) throw e; return ""; }
}

async function similarFixes(question: string): Promise<string> {
  const words = keywords(question).filter((w) => w.length >= 4 && !/^\d+$/.test(w)).slice(0, 5);
  if (!words.length) return "";
  const pats = words.map((w) => `%${w}%`);
  const rows = await sql`SELECT f.machine_id, f.issue, f.opened_at, f.resolved_at, f.fixed_by, s.solution
    FROM failures f LEFT JOIN wa_solutions s ON s.failure_id = f.id
    WHERE f.status = 'resolue' AND (f.issue ILIKE ANY(${pats}) OR s.solution ILIKE ANY(${pats}))
    ORDER BY (s.solution IS NOT NULL) DESC, f.opened_at DESC LIMIT 8`;
  return rows.map((r) => `- ${String(r.machine_id).replace("M-", "Mc ").replace(/Mc 0/, "Mc ")} ${ddmm(beninDay(new Date(r.opened_at)))}: ${r.issue}${r.fixed_by ? ` — réglé par ${r.fixed_by}` : ""}${r.solution ? ` — solution: ${r.solution}` : ""}`).join("\n");
}

// Calculs de pignons exacts (l'IA ne calcule pas elle-même).
async function gearCalc(text: string): Promise<string> {
  const t = normalize(text).replace(/(\d),(\d)/g, "$1.$2");
  const out: string[] = [];
  const g = t.match(/\bg\s*[:=]?\s*(\d{2})\b/i), h = t.match(/\bh\s*[:=]?\s*(\d{2,3})\b/i);
  if (g && h) out.push(`G${g[1]}/H${h[1]} → draft ${fmt2(draftOf(+g[1], +h[1]))}`);
  const d = t.match(/\bdraft\s*(?:de|of|=|:)?\s*(\d{2}(?:\.\d+)?)\b/i);
  if (d) {
    const target = Number(d[1]);
    const stock = await availableStock([]);
    const p = proposals(target, { g: null, h: null }, stock, 1);
    out.push(`Draft ${fmt2(target)} — couples G/H en stock (6 pièces chacun) ${p.close ? "à moins de 1 %" : "les plus proches (aucun à moins de 1 %)"} : ${p.list.map((x) => `G${x.g}/H${x.h} = ${fmt2(x.d)} (${pct(x.err)})`).join(" ; ") || "aucun"}`);
  }
  return out.join("\n");
}

// ---------- Consigne de l'assistant ----------
const SYSTEM = `Tu es « l'assistant G37 », l'assistant technique de l'atelier Ring Frame (continus à filer) d'une filature, joignable sur WhatsApp.
Tu parles avec des maintenanciers, des superviseurs et des techniciens.

Sources (dans cet ordre) :
1. DONNÉES ATELIER G37 ci-dessous (état réel des machines, pannes, solutions passées, stock) : toujours prioritaires. Cite-les simplement (« d'après G37 … »).
2. MANUEL RIETER G 37 ci-dessous (extraits du manuel d'utilisation officiel) : pour les codes et messages de défaut, suis ses causes et remèdes,
   et indique la page (« manuel p. 1239 »). Les extraits viennent d'un PDF : les colonnes du tableau (code, texte, cause, remède) peuvent être mélangées.
3. Ta connaissance générale du filage à anneaux (ring spinning) : précise alors que c'est un conseil général à vérifier sur la machine.
N'invente jamais de chiffre de l'atelier (stock, dates, pignons, pannes). Si l'information n'est pas dans les données, dis-le.

Style : réponds dans la langue de la personne (français ou anglais). Message WhatsApp court et concret : 3 à 10 lignes en général,
puces « • », gras avec *astérisques*, pas de titres markdown (#), pas de tableaux. Pour un dépannage : causes probables dans l'ordre,
puis vérifications pas à pas. Rappelle la sécurité quand il le faut (machine arrêtée, consignation électrique/pneumatique avant d'intervenir).

Photo d'écran ou de machine : lis le message ou le code d'erreur, explique-le et donne les vérifications. Si c'est une fiche « Count change slip »,
résume ce que tu lis et dis que pour lancer le changement il faut l'envoyer dans le groupe Ring Fram Local Team.
Note vocale : comprends-la, mets ce que tu as compris dans "heard", et réponds normalement.

Calculs : draft = 16,068 × H ÷ G. Count ≈ R. hank × draft (approximatif). Utilise les CALCULS EXACTS fournis s'il y en a ; ne recalcule pas toi-même des couples G/H.

Actions (champ "action") : seulement si ACTIONS AUTORISÉES = oui ET que la personne annonce un fait à enregistrer (pas une question) :
- close : machine remise en marche / panne réglée → command « Mc 25 running » ; mets dans "solution" ce qui a été fait si la personne l'a dit.
- fault : nouvelle panne → command « Mc 25 <description courte en anglais ou français> »
- maint : maintenance clg faite → command « Rf 25 maintenance clg finish »
- stock : arrivée ou sortie magasin → command « Arrivé de 2 belt 1600 » ou « Sortie de 1 belt 1600 » (nom de l'article comme dans le magasin)
- greasing : graissage / lubrification faits → command « front rollers greasing mc 1 to 8 »
"summary" = phrase courte en français de ce qui sera enregistré. Sinon action = null. Ne dis pas dans "reply" que c'est enregistré : le système demandera la confirmation.

${EDITS_HELP}
Si MODIFICATIONS AUTORISÉES = non et que la personne demande de modifier l'app : explique gentiment que seules les personnes choisies par l'admin peuvent modifier G37 depuis WhatsApp, et qu'elle peut le faire dans l'app.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    heard: { type: "STRING", nullable: true },
    action: {
      type: "OBJECT", nullable: true,
      properties: {
        type: { type: "STRING", enum: ["close", "fault", "maint", "stock", "greasing"] },
        command: { type: "STRING" },
        summary: { type: "STRING" },
        solution: { type: "STRING", nullable: true },
      },
      required: ["type", "command", "summary"],
    },
    edits: EDITS_SCHEMA,
  },
  required: ["reply"],
};

// ---------- Vérification d'une action proposée par l'IA ----------
function validAction(a: { type: string; command: string }): boolean {
  const c = String(a.command ?? "").trim();
  if (!c || c.length > 200) return false;
  if (a.type === "stock") return /^\s*(arriv|re[çc]u|received|entr[ée]e|sortie|sorti|used|utilis|issued?)/i.test(c);
  if (a.type === "greasing") return /(greas|lubri|graiss|gauge|ring rail)/i.test(c) && extractMachines(c).length > 0;
  const p = parseMessage(c, null);
  const want = { close: "close", fault: "fault", maint: "maint" }[a.type as "close"];
  return !!want && p.kind === want && p.machines.length > 0;
}

// ---------- Limites par personne ----------
async function usage(user: string) {
  const [d] = await sql`SELECT count(*)::int AS n FROM wa_chat WHERE user_jid = ${user} AND role = 'user'
    AND created_at >= (date_trunc('day', now() + interval '1 hour') - interval '1 hour')`;
  const [b] = await sql`SELECT count(*)::int AS n FROM wa_chat WHERE user_jid = ${user} AND role = 'user' AND created_at > now() - interval '5 minutes'`;
  return { today: d.n as number, burst: b.n as number };
}

async function history(user: string): Promise<Turn[]> {
  const rows = await sql`SELECT role, content FROM wa_chat WHERE user_jid = ${user} AND created_at > now() - interval '12 hours'
    ORDER BY created_at DESC LIMIT 10`;
  const turns: Turn[] = [];
  for (const r of rows.reverse()) {
    const role = r.role === "user" ? "user" : "model";
    const last = turns[turns.length - 1];
    if (last && last.role === role) (last.parts[0] as { text: string }).text += "\n" + r.content;
    else turns.push({ role, parts: [{ text: String(r.content) }] });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

async function save(user: string, name: string, channel: string, role: "user" | "assistant", content: string) {
  await sql`INSERT INTO wa_chat (user_jid, user_name, channel, role, content) VALUES (${user}, ${name}, ${channel}, ${role}, ${content.slice(0, 4000)})`;
}

// ---------- Modification confirmée : appliquée par le serveur de l'app, avec les droits du compte de la personne ----------
async function applyEdit(pend: Record<string, unknown>, person: Person | null, name: string): Promise<string> {
  const p = person ?? await personByPhone(pend.phone);
  if (!p || p.level === "none") {
    await sql`UPDATE wa_pending_action SET status = 'cancelled', done_at = now() WHERE id = ${pend.id as number}`;
    return "🚫 Tu n'es plus autorisé à modifier G37 depuis WhatsApp.";
  }
  let res: { results?: Array<{ ok: boolean; message?: string; error?: string }>; by?: string };
  try {
    res = await appApi("wa/mutate", { person: { id: p.id, name: p.name, level: p.level, userId: p.user_id, phone: p.phone }, ops: pend.ops, summary: pend.summary });
  } catch (e) {
    console.error("Modification:", e);
    return `⚠️ Modification impossible pour l'instant (${e instanceof Error ? e.message : e}). Rien n'a été changé, réessaie dans quelques minutes.`;
  }
  const results = res.results ?? [];
  await sql`UPDATE wa_pending_action SET status = 'done', done_at = now(), result = ${sql.json(results)} WHERE id = ${pend.id as number}`;
  const lines = String(pend.summary ?? "").split("\n");
  const okLines = lines.filter((_, i) => results[i]?.ok ?? results.every((r) => r.ok));
  const refused = results.filter((r) => !r.ok).map((r) => r.error ?? "refusé");
  // Chaque opération correspond en général à une ligne du résumé ; si ce n'est pas le cas, on reste simple.
  const sameShape = results.length === lines.length;
  const done = sameShape ? okLines : results.some((r) => r.ok) ? lines : [];
  if (done.length) await outbox(`✏️ *Modifié dans G37 par ${p.name}* (via le robot)\n${done.map((l) => `• ${l}`).join("\n")}`);
  const out: string[] = [];
  if (done.length) out.push(`✅ *Modifié dans G37 :*\n${done.map((l) => `• ${l}`).join("\n")}`);
  const extra = results.map((r) => r.ok ? r.message : null).filter(Boolean);
  if (extra.length) out.push(extra.map((m) => `ℹ️ ${m}`).join("\n"));
  if (refused.length) out.push(`🚫 Refusé par l'app :\n${[...new Set(refused)].map((m) => `• ${m}`).join("\n")}`);
  return out.join("\n\n") || `⚠️ Rien n'a été modifié, ${name}.`;
}

// ---------- Point d'entrée ----------
export async function chat(body: ChatIn, exec: Exec): Promise<ChatOut> {
  const user = String(body.user ?? "").slice(0, 80);
  const name = (String(body.name ?? "").trim() || user.split("@")[0]).slice(0, 60);
  const channel = body.channel === "group" ? "group" : "private";
  const text = String(body.text ?? "").replace(/^\?\s*/, "").trim().slice(0, 3000);
  const canAct = channel === "private" && !!body.member;
  if (!user || (!text && !body.image && !body.audio)) return { reply: "" };
  const person: Person | null = await personByPhone(body.phone, user);
  await learnName(person, body.name);
  const canEdit = channel === "private" && !!person && person.level !== "none";

  let preHeard = ""; // note vocale déjà transcrite à l'étape 0
  // 0) Réponse à la question du soir (« la maintenance de la Mc 3 est-elle finie ? »), par écrit ou par note vocale.
  if (person && channel === "private" && !body.image) {
    const ask = await pendingAsk(person.id);
    if (ask) {
      let said = text;
      if (!said && body.audio) said = preHeard = await transcribe(body.audio, body.audioMime || "audio/ogg").catch(() => "");
      const ans = said ? readAnswer(said, ask) : null;
      if (ans) {
        try {
          const r = await appApi<{ lines?: string[]; missing?: string[] }>("wa/ask_answer", { askId: ask.id, done: ans.done, tomorrow: ans.tomorrow });
          const still = r.missing ?? [];
          const follow = still.includes("tomorrow")
            ? (ask.planned.length ? `\n\n📅 Et pour *demain* : ${ask.planned.map((n) => `Mc ${n}`).join(", ")}, c'est confirmé ? (oui, ou donne la bonne machine)`
              : "\n\n📅 Et *quelle machine passe en maintenance demain* ? (ex. « demain 5 », ou « aucune »)")
            : still.includes("done") ? `\n\n1️⃣ Et la maintenance ${ask.machines.map((n) => `Mc ${n}`).join(", ")} d'aujourd'hui, *finie* ? (oui / non)` : "";
          const reply = `${body.audio ? `🎤 J'ai compris : « ${said} »\n` : ""}Merci ${person.name.split(" ")[0]} 👍\n${(r.lines ?? []).map((l) => `• ${l}`).join("\n")}${follow}`;
          await save(user, name, channel, "user", said);
          await save(user, name, channel, "assistant", reply);
          return { reply, executed: true };
        } catch (e) {
          console.error("Réponse du soir:", e);
          return { reply: "⚠️ Je n'ai pas pu enregistrer ta réponse. Réessaie dans quelques minutes, ou utilise le bouton « Maintenance faite » de l'app." };
        }
      }
    }
  }

  // 1) Réponse « Oui / Non » à une action en attente.
  const [pend] = person
    ? await sql`SELECT * FROM wa_pending_action WHERE (user_jid = ${user} OR phone = ${person.phone}) AND status = 'pending'
        AND created_at > now() - interval '15 minutes' ORDER BY id DESC LIMIT 1`
    : await sql`SELECT * FROM wa_pending_action WHERE user_jid = ${user} AND status = 'pending'
        AND created_at > now() - interval '15 minutes' ORDER BY id DESC LIMIT 1`;
  if (pend && text && !body.image && !body.audio && (YES.test(text) || NO.test(text))) {
    if (NO.test(text)) {
      await sql`UPDATE wa_pending_action SET status = 'cancelled', done_at = now() WHERE id = ${pend.id}`;
      return { reply: "👌 D'accord, rien n'est enregistré." };
    }
    if (pend.kind === "edit") return { reply: await applyEdit(pend, person, name), executed: true };
    const r = await exec(pend.command, name, `chat:${pend.id}`, pend.solution);
    await sql`UPDATE wa_pending_action SET status = 'done', done_at = now(), result = ${sql.json(r as Record<string, unknown>)} WHERE id = ${pend.id}`;
    const lines = (r.done ?? []).filter(Boolean);
    if (!lines.length && !r.reply) return { reply: `⚠️ Je n'ai rien pu enregistrer (« ${pend.command} » non reconnu). Écris-le dans le groupe Ring Fram Local Team.` };
    await outbox(`🤖 Via l'assistant — ${name} : ${pend.summary}`);
    return { reply: `✅ Enregistré dans G37 :\n${lines.map((l: string) => `• ${l}`).join("\n")}${r.reply && !lines.includes(r.reply) ? `\n${r.reply}` : ""}`, executed: true };
  }
  if (pend) await sql`UPDATE wa_pending_action SET status = 'expired' WHERE id = ${pend.id}`;

  // 2) Limite par personne (le quota gratuit de Google est partagé par toute l'équipe).
  const limit = Number(await config("wa.chat_daily_limit")) || 30;
  const warnAt = Math.max(5, Math.round((limit * 2) / 3));
  const use = await usage(user);
  if (use.today >= limit) {
    const slot = Math.floor(Date.now() / (30 * 60_000));
    if (!(await once(`wa-limit:${user}:${slot}`))) return { reply: "" };
    return { reply: `🚫 *${name}*, tu as atteint la limite de *${limit} questions* pour aujourd'hui.\nLe quota gratuit de l'IA est partagé par toute l'équipe : si une personne l'épuise, plus personne ne peut s'en servir (lecture des fiches Count change comprise).\nTu pourras reposer des questions demain. Les commandes *!mc 25* et *!stock G41* marchent toujours.` };
  }

  // 3) Vocal : transcrit d'abord (la question devient du texte). Photo : texte de l'écran lu d'abord.
  let heard = "";
  let screen = "";
  try {
    if (preHeard) heard = preHeard;
    else if (body.audio) heard = await transcribe(body.audio, body.audioMime || "audio/ogg").catch((e) => { if (e instanceof QuotaError) throw e; return ""; });
    if (body.image) screen = await readScreen(body.image, body.imageMime || "image/jpeg");
  } catch (e) {
    if (e instanceof QuotaError) return { reply: quotaMessage() };
  }
  const question = [text, heard].filter(Boolean).join(" ");
  const sendAudio = !!body.audio && !heard; // transcription ratée : on envoie l'audio à l'IA

  // 4) Contexte : données de l'atelier + manuel + calculs exacts.
  const today = beninDay();
  const past = await history(user);
  const recentText = past.slice(-4).map((t) => (t.parts[0] as { text: string }).text).join("\n");
  const nums = [...new Set([...extractMachines(`${question}\n${body.quoted ?? ""}`), ...extractMachines(recentText)])];
  const [snap, details, stock, manual, fixes, calc] = await Promise.all([
    snapshot(today), nums.length ? machineDetails(nums, today) : Promise.resolve(""), stockText(),
    knowledge(`${question} ${screen} ${body.quoted ?? ""}`), similarFixes(`${question} ${screen}`), gearCalc(question),
  ]);
  const context = [
    `Aujourd'hui : ${today} (${['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][new Date(today + 'T00:00:00Z').getUTCDay()]}, heure du Bénin). Personne : ${name}. ACTIONS AUTORISÉES = ${canAct ? "oui" : "non"}. MODIFICATIONS AUTORISÉES = ${canEdit ? `oui (${LEVEL_FR[person!.level]})` : "non"}.`,
    `== DONNÉES ATELIER G37 : MACHINES ==\n${snap}`,
    details && `== DÉTAIL DES MACHINES CITÉES ==\n${details}`,
    fixes && `== PANNES SEMBLABLES DÉJÀ RÉGLÉES ==\n${fixes}`,
    `== STOCK ==\n${stock}`,
    calc && `== CALCULS EXACTS ==\n${calc}`,
    manual ? `== MANUEL RIETER G 37 (extraits) ==\n${manual}` : "== MANUEL RIETER G 37 ==\n(aucun extrait trouvé pour cette question)",
  ].filter(Boolean).join("\n\n");

  const parts: Part[] = [{ text: context }];
  if (body.quoted) parts.push({ text: `Message auquel la personne répond : « ${String(body.quoted).slice(0, 1000)} »` });
  if (body.image) parts.push({ inline_data: { mime_type: body.imageMime || "image/jpeg", data: body.image } });
  if (screen) parts.push({ text: `Texte lu sur la photo : « ${screen} »` });
  if (sendAudio) parts.push({ inline_data: { mime_type: body.audioMime || "audio/ogg", data: body.audio! } });
  if (heard) parts.push({ text: `(La personne a envoyé une note vocale, transcrite : « ${heard} »)` });
  parts.push({ text: `QUESTION DE ${name.toUpperCase()} : ${question || (sendAudio ? "(note vocale)" : "(photo sans texte : explique ce que tu vois et aide à régler le problème)")}` });

  let out: { reply?: string; heard?: string | null; action?: { type: string; command: string; summary: string; solution?: string | null } | null; edits?: Intent[] | null };
  try {
    const raw = await gemini([...past, { role: "user", parts }], { system: SYSTEM, schema: SCHEMA, budgetMs: 100_000 });
    try { out = JSON.parse(raw); } catch { out = { reply: raw }; }
  } catch (e) {
    console.error("Assistant:", e);
    if (e instanceof QuotaError) return { reply: quotaMessage() };
    return { reply: "⚠️ Je n'arrive pas à joindre l'IA pour l'instant. Réessaie dans quelques minutes (les commandes *!mc 25*, *!stock G41* marchent toujours)." };
  }

  let reply = String(out.reply ?? "").trim().slice(0, 3500) || "Je n'ai pas compris, peux-tu reformuler ?";
  const asked = text || (body.audio ? `[vocal] ${heard || out.heard || ""}`.trim() : "") || "[photo]";
  await save(user, name, channel, "user", body.image ? `[photo] ${asked === "[photo]" ? "" : asked}`.trim() : asked);

  // 5) Modifications demandées : résumé exact + « oui » avant de modifier (personnes autorisées seulement).
  const a = out.action;
  if (canEdit && out.edits?.length) {
    const b = await buildEdits(out.edits, person!.level);
    if (b.ops.length) {
      await sql`INSERT INTO wa_pending_action (user_jid, user_name, command, summary, kind, ops, phone)
        VALUES (${user}, ${name}, ${"edit"}, ${b.lines.join("\n").slice(0, 3000)}, 'edit', ${sql.json(b.ops)}, ${person!.phone})`;
      reply += `\n\n✏️ *Je modifie dans G37 :*\n${b.lines.map((l) => `• ${l}`).join("\n")}\n\nRéponds *Oui* pour confirmer ou *Non* pour annuler.`;
    }
    if (b.problems.length) reply += `\n\n⚠️ ${b.problems.join("\n⚠️ ")}`;
  } else if (canAct && a && validAction(a)) {
    await sql`INSERT INTO wa_pending_action (user_jid, user_name, command, summary, solution)
      VALUES (${user}, ${name}, ${a.command.trim()}, ${String(a.summary).slice(0, 300)}, ${a.solution ? String(a.solution).slice(0, 500) : null})`;
    reply += `\n\n👉 J'enregistre dans G37 : *${String(a.summary).slice(0, 300)}* ?\nRéponds *Oui* ou *Non*.`;
  }

  // 6) Avertissements quota.
  const n = use.today + 1;
  const warn: string[] = [];
  if (n === warnAt) warn.push(`⚠️ Tu en es à *${n} questions* aujourd'hui (limite ${limit}). Le quota gratuit de l'IA est *partagé par toute l'équipe* : à ce rythme, tu risques de l'épuiser pour tout le monde. Regroupe tes questions en un seul message.`);
  else if (n === limit - 3) warn.push(`⚠️ Il te reste *3 questions* pour aujourd'hui.`);
  else if (n === limit) warn.push(`⚠️ C'était ta dernière question pour aujourd'hui.`);
  if (use.burst >= 5 && await once(`wa-burst:${user}:${Math.floor(Date.now() / (30 * 60_000))}`)) {
    warn.push(`⚠️ Beaucoup de questions en peu de temps : tu risques d'épuiser le quota gratuit de l'IA pour toute l'équipe. Mets tout dans un seul message si possible.`);
  }
  if (warn.length) reply += `\n\n${warn.join("\n")}`;

  await save(user, name, channel, "assistant", reply);
  return { reply };
}

// ---------- Notes vocales des groupes : transcription seule ----------
export async function transcribe(b64: string, mime: string): Promise<string> {
  const raw = await gemini([{ role: "user", parts: [
    { inline_data: { mime_type: mime || "audio/ogg", data: b64 } },
    { text: `Voice note from a spinning mill WhatsApp group (ring frames). Transcribe it exactly, in its original language (French or English, sometimes mixed).
Write machine numbers as digits with "Mc", e.g. "Mc 25". Keep technical words as spoken. If nothing understandable, return an empty text.
Answer ONLY with JSON: {"text": string}` },
  ] }], { schema: { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] }, budgetMs: 90_000 });
  try { return String(JSON.parse(raw).text ?? "").trim(); } catch { return raw.trim(); }
}

