// Ajouts du robot : graissage / lubrification / schedule et magasin par message, commandes « ! »,
// rappels, pannes répétitives, surveillance du robot.
import { addDays, beninDay, config, ddmm, diff, isoDay, machineList, newId, once, outbox, rf, setConfig, sql, when } from "./db.ts";
import { extractMachines, hasRequestWords, normalize, withoutMachineRefs } from "./parse.ts";
import { pushAdmins } from "./push.ts";
import { eveningRun } from "./evening.ts";

export type Meta = { msgId: string; group: string; sender: string; at: Date };
export type Result = { action: string; machines?: number[]; done: string[]; reply?: string | null } | null;

// ---------- Graissage, lubrification, schedule works ----------
export type Point = { kind: "grease" | "lub" | "sched"; key: string; name: string; aliases: string[] };
const STATIC_POINTS: Point[] = [
  { kind: "grease", key: "nipples", name: "Nipples", aliases: ["nipples", "nipple"] },
  { kind: "grease", key: "front", name: "Front rollers", aliases: ["front rollers", "front roller", "front rolls", "front roll"] },
  { kind: "grease", key: "blackmiddle", name: "Black & middle rollers", aliases: ["back and middle rollers", "back & middle rollers", "black and middle rollers", "black & middle rollers", "back and middle roller", "black and middle roller", "middle rollers", "middle roller", "back rollers", "back roller"] },
  { kind: "grease", key: "mainshaft", name: "Main shaft", aliases: ["main shaft", "mainshaft"] },
  { kind: "grease", key: "screwrod", name: "Screw rod", aliases: ["screw rods", "screw rod", "screwrod"] },
  { kind: "grease", key: "gearing", name: "All gearing", aliases: ["all gearing", "all gears", "gearings", "gearing"] },
  { kind: "lub", key: "drafting", name: "Drafting gear box", aliases: ["drafting gear box", "drafting gearbox", "drafting box"] },
  { kind: "lub", key: "ringrail", name: "Ring rail gear box", aliases: ["ring rail gear box", "ring rail gearbox", "ringrail gear box"] },
  { kind: "lub", key: "doffer", name: "Doffer gear box", aliases: ["doffer gear box", "doffer gearbox"] },
  { kind: "lub", key: "servodisc", name: "Servodisc gear box", aliases: ["servodisc gear box", "servo disc gear box", "servodisc gearbox", "servo disc gearbox"] },
];
const KIND_FR = { grease: "Graissage", lub: "Lubrification", sched: "Schedule works" } as const;

export async function allPoints(): Promise<Point[]> {
  const custom = await sql`SELECT kind, point_key, name FROM g37_cycle_points`;
  return [...STATIC_POINTS, ...custom.map((c) => ({ kind: c.kind, key: c.point_key, name: c.name, aliases: [String(c.name).toLowerCase()] } as Point))];
}

export async function cycleEntry(m: Meta, text: string): Promise<Result> {
  if (hasRequestWords(text)) return null;
  const machines = extractMachines(text);
  if (!machines.length) return null;
  let rest = " " + withoutMachineRefs(text).toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, " ") + " ";
  const points = await allPoints();
  const found: Point[] = [];
  // Les noms les plus longs d'abord (« abc ring gauge » avant « ring gauge »).
  const byLength = points.flatMap((p) => p.aliases.map((a) => ({ p, a }))).sort((x, y) => y.a.length - x.a.length);
  for (const { p, a } of byLength) {
    const needle = " " + a.replace(/[^\p{L}\p{N}&]+/gu, " ") + " ";
    if (rest.includes(needle)) { if (!found.includes(p)) found.push(p); rest = rest.replace(needle, " "); }
  }
  const allGrease = /\b(full|all|complete|total|tous)\s+(greas\w*|points?|graissage)\b|\bgreas\w*\s+(all|complete|full)\b/i.test(text);
  if (!found.length && allGrease) found.push(...STATIC_POINTS.filter((p) => p.kind === "grease"));
  if (!found.length) {
    if (/\b(greas\w*|graiss\w*|lubri\w*)\b/i.test(text)) {
      return { action: "cycle-ask", machines, done: [], reply: `❓ Graissage ${machines.map(rf).join(", ")} : précise le point (ex. « front rollers greasing mc 1 to 8 », « screw rod greasing mc 3 », « full greasing mc 5 »).` };
    }
    return null;
  }
  const day = beninDay(m.at);
  const known = (await sql`SELECT machine_no FROM machines WHERE machine_no = ANY(${machines})`).map((r) => Number(r.machine_no));
  const lines: string[] = [];
  for (const p of found) {
    let added = 0;
    for (const n of known) {
      const dup = await sql`SELECT id FROM greasing_records WHERE machine_no = ${n} AND kind = ${p.kind} AND point_key = ${p.key} AND done_on = ${day}::date LIMIT 1`;
      if (dup.length) continue;
      await sql`INSERT INTO greasing_records (id, machine_no, kind, point_key, done_on, author_name)
        VALUES (${newId()}, ${n}, ${p.kind}, ${p.key}, ${day}::date, ${m.sender})`;
      added++;
    }
    lines.push(`${KIND_FR[p.kind]} ${p.name}${added ? "" : " (déjà noté)"}`);
  }
  const reply = `✅ ${lines.join(" · ")} — Mc ${machineList(known)} — enregistré le ${ddmm(day)} (${m.sender}).`;
  return { action: "cycle", machines: known, done: [reply], reply };
}

// ---------- Magasin : « Arrivé de 2 belt 1600 », « Sortie de 1 belt 1600 », « Arrivé de 12 G41 » ----------
const IN_RE = /^\s*(?:arriv[ée]{1,2}e?s?|arrival|arrived|received?|re[çc]ue?s?|entr[ée]e?s?)\s*(?:de|d'|du|des|of|:)?\s*/i;
const OUT_RE = /^\s*(?:sortie|sorti|utilis[ée]e?s?|used|issued?|pris|prise|consomm[ée]e?s?)\s*(?:de|d'|du|des|of|:)?\s*/i;
const UNIT_WORDS = new Set(["pcs", "pc", "piece", "pieces", "pièce", "pièces", "de", "of", "the", "x", "nos", "no", "unit", "units", "kg"]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/(\d),(\d)/g, "$1.$2").split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, "")).filter((t) => t && !UNIT_WORDS.has(t))
    .map((t) => (t.length > 3 && /\p{L}s$/u.test(t) ? t.slice(0, -1) : t));
}

export type Item = { id: string; name: string; unit: string; quantity: number; minimum: number };
export async function findItems(query: string): Promise<{ best: Item | null; candidates: Item[] }> {
  const rows = await sql`SELECT id, name, unit, quantity, minimum_quantity FROM stock_items`;
  const items: Item[] = rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, quantity: Number(r.quantity), minimum: Number(r.minimum_quantity) }));
  const q = tokens(query);
  if (!q.length) return { best: null, candidates: [] };
  const scored = items.map((it) => {
    const t = tokens(it.name);
    const all = q.every((w) => t.includes(w));
    const shared = q.filter((w) => t.includes(w)).length;
    return { it, all, score: all ? q.length / t.length : shared / (q.length + t.length) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const full = scored.filter((x) => x.all);
  if (full.length && (full.length === 1 || full[0].score > full[1].score)) return { best: full[0].it, candidates: [] };
  return { best: null, candidates: (full.length ? full : scored).slice(0, 4).map((x) => x.it) };
}

export async function stockEntry(m: Meta, text: string): Promise<Result> {
  const t = normalize(text);
  const dir = IN_RE.test(t) ? 1 : OUT_RE.test(t) ? -1 : 0;
  if (!dir) return null;
  const body = t.replace(dir > 0 ? IN_RE : OUT_RE, "").trim();
  let qty: number | null = null;
  let name = body;
  const lead = body.match(/^(\d+(?:[.,]\d+)?)\s*(?:pcs|pc|pièces?|pieces?|kg|x)?\s+(.+)$/i);
  const tail = body.match(/^(.+?)\s*(?:[x×:=]|qty|qté)\s*(\d+(?:[.,]\d+)?)\s*(?:pcs|pièces?|kg)?$/i);
  if (lead) { qty = Number(lead[1].replace(",", ".")); name = lead[2]; }
  else if (tail) { qty = Number(tail[2].replace(",", ".")); name = tail[1]; }
  if (!qty || qty <= 0) return { action: "stock-ask", done: [], reply: `❓ Magasin : quantité introuvable dans « ${text.slice(0, 80)} ». Exemple : « Arrivé de 2 belt 1600 ».` };
  name = name.replace(/[.\s]+$/, "").trim();
  const verb = dir > 0 ? "arrivée" : "sortie";

  // Pignons : « 12 G41 », « 6 H 108 »
  const gear = name.match(/^([gh])\s*-?\s*(\d{2,3})\s*t?$/i);
  if (gear) {
    const type = gear[1].toUpperCase(); const teeth = Number(gear[2]);
    const r = await sql`UPDATE gears SET stock = greatest(0, stock + ${dir * qty}), updated_at = now(), updated_by = ${m.sender}
      WHERE gear_type = ${type} AND teeth = ${teeth} RETURNING stock`;
    if (!r.length) return { action: "stock-ask", done: [], reply: `❓ Pignon ${type}${teeth} inconnu dans G37.` };
    const reply = `📦 *Pignons* : ${dir > 0 ? "+" : "−"}${qty} ${type}${teeth} → ${r[0].stock} en stock (${verb}, ${m.sender}).`;
    return { action: "stock", done: [reply], reply };
  }

  const { best, candidates } = await findItems(name);
  if (!best) {
    const list = candidates.length ? ` Articles proches : ${candidates.map((c) => `« ${c.name} »`).join(", ")}.` : "";
    return { action: "stock-ask", done: [], reply: `❓ Magasin : je ne sais pas quel article est « ${name} ».${list} Réécris avec le nom exact.` };
  }
  const newQty = Math.max(0, best.quantity + dir * qty);
  await sql`UPDATE stock_items SET quantity = ${newQty}, updated_at = now() WHERE id = ${best.id}`;
  await sql`INSERT INTO stock_movements (id, item_id, movement_type, quantity, reason, created_at)
    VALUES (${newId()}, ${best.id}, ${dir > 0 ? "entrée" : "sortie"}, ${qty}, ${`${dir > 0 ? "Arrivage" : "Sortie"} WhatsApp par ${m.sender}`}, now())`;
  let reply = `📦 *Magasin* : ${dir > 0 ? "+" : "−"}${qty} ${best.name} → ${newQty} ${best.unit} (${verb}, ${m.sender}).`;
  if (dir < 0 && best.quantity + dir * qty < 0) reply += ` ⚠️ Le stock affiché n'était que de ${best.quantity}.`;
  if (best.minimum > 0 && newQty < best.minimum) reply += ` ⚠️ Sous le seuil (min ${best.minimum}).`;
  return { action: "stock", done: [reply], reply };
}

// ---------- Commandes dans le groupe ----------
const STATUS_FR: Record<string, string> = { service: "🟢 en service", arret: "🔴 à l'arrêt", maintenance: "🟠 en maintenance" };

export async function command(text: string): Promise<string | null> {
  const t = text.trim();
  if (/^!(aide|help)\b/i.test(t)) {
    return ["*🤖 Commandes du robot G37*", "• !rapport — rapport du jour", "• !mc 22 — état de la machine 22", "• !stock G41 — stock d'un pignon ou d'un article (ex. !stock belt 1600)",
      "• Photo de fiche Count change (légende !test = essai sans enregistrer)", "• « front rollers greasing mc 1 to 8 » — graissage enregistré",
      "• « Arrivé de 2 belt 1600 » / « Sortie de 1 belt 1600 » — magasin",
      "• *? question* — l'assistant G37 répond (ex. « ? Mc 25 air pressure low que vérifier »)",
      "• En privé avec ce numéro : questions, photos d'écran, notes vocales"].join("\n");
  }
  const mc = t.match(/^!mc\s*(\d{1,2})\b/i);
  if (mc) {
    const n = Number(mc[1]);
    const [m] = await sql`SELECT * FROM machines WHERE machine_no = ${n}`;
    if (!m) return `❓ Mc ${n} inconnue.`;
    const today = beninDay();
    const [faults, works, req] = await Promise.all([
      sql`SELECT issue, opened_at FROM failures WHERE machine_id = ${m.id} AND status <> 'resolue' ORDER BY opened_at`,
      sql`SELECT title FROM works WHERE machine_no = ${n} AND status = 'todo' ORDER BY created_at`,
      sql`SELECT new_g, new_h FROM gear_change_requests WHERE machine_no = ${n} AND status = 'pending' LIMIT 1`,
    ]);
    const lines = [`*🔧 Mc ${n}* — ${STATUS_FR[m.status] ?? m.status}${m.stop_reason && m.status !== "service" ? ` (${m.stop_reason})` : ""}`,
      `Pignons : G${m.run_g ?? "?"} · H${m.run_h ?? "?"}${m.run_count != null ? ` · count ${Number(m.run_count)}` : ""}`];
    if (m.next_maintenance) { const d = isoDay(m.next_maintenance); lines.push(`Maintenance : ${ddmm(d)} (${when(diff(d, today))})`); }
    if (req.length) lines.push(`⏳ Changement en attente : G${req[0].new_g} · H${req[0].new_h}`);
    lines.push(faults.length ? `Pannes ouvertes : ${faults.map((f) => f.issue).join(" ; ")}` : "Pannes ouvertes : aucune");
    if (works.length) lines.push(`À faire : ${works.map((w) => w.title).join(" ; ")}`);
    return lines.join("\n");
  }
  const st = t.match(/^!stock\s+(.+)$/i);
  if (st) {
    const q = st[1].trim();
    const gear = q.match(/^([gh])\s*-?\s*(\d{2,3})$/i);
    if (gear) {
      const type = gear[1].toUpperCase(); const teeth = Number(gear[2]);
      const [g] = await sql`SELECT stock FROM gears WHERE gear_type = ${type} AND teeth = ${teeth}`;
      if (!g) return `❓ Pignon ${type}${teeth} inconnu.`;
      const [p] = await sql`SELECT count(*)::int AS n FROM gear_change_requests WHERE status = 'pending' AND ${sql(type === "G" ? "new_g" : "new_h")} = ${teeth}`;
      const free = g.stock - 6 * p.n;
      return `📦 ${type}${teeth} : ${g.stock} pièce(s)${p.n ? ` dont ${6 * p.n} réservée(s) pour ${p.n} changement(s) en attente` : ""} → de quoi équiper ${Math.max(0, Math.floor(free / 6))} machine(s).`;
    }
    const { best, candidates } = await findItems(q);
    const list = best ? [best] : candidates;
    if (!list.length) return `❓ Aucun article ne ressemble à « ${q} ».`;
    return list.map((i) => `📦 ${i.name} : ${i.quantity} ${i.unit}${i.minimum > 0 && i.quantity < i.minimum ? ` ⚠️ sous le seuil (${i.minimum})` : ""}`).join("\n");
  }
  return null;
}

// ---------- Tâches périodiques (appelées par le robot toutes les 10 min) ----------
const STOP = new Set(["issue", "problem", "probleme", "problème", "panne", "broken", "break", "check", "verifier", "vérifier", "please", "team", "maintenance",
  "the", "and", "side", "lhs", "rhs", "not", "working", "come", "with", "for", "de", "le", "la", "les", "des", "du", "une", "un", "est", "sur", "vérifier"]);
const faultWords = (s: string) => [...new Set(tokens(s).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w)))];

async function remindPendingChanges() {
  const rows = await sql`SELECT r.work_id, r.machine_no, r.count_label, r.new_g, r.new_h, w.created_at
    FROM gear_change_requests r JOIN works w ON w.id = r.work_id
    WHERE r.status = 'pending' AND w.status = 'todo' AND w.created_at < now() - interval '12 hours'`;
  for (const r of rows) {
    const hours = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 3600_000);
    if (!(await once(`wa-remind:${r.work_id}:${Math.floor(hours / 12)}`))) continue;
    await outbox(`⏰ *Count change Mc ${r.machine_no}*${r.count_label ? ` (${r.count_label})` : ""} en attente depuis ${hours} h (G${r.new_g} · H${r.new_h}). Quand c'est fait, appuyez sur « Fait » dans l'app (accueil).`);
  }
}

async function detectRepeatedFaults() {
  const since = (await config("wa.fault_scan_at")) || new Date(Date.now() - 3600_000).toISOString();
  const now = new Date().toISOString();
  // Pannes signalées depuis le dernier passage (l'app peut antidater une panne : marge de 2 jours, chaque panne n'est vue qu'une fois).
  const fresh = await sql`SELECT id, machine_id, issue, opened_at FROM failures WHERE opened_at > ${since}::timestamptz - interval '2 days'`;
  for (const f of fresh) {
    if (!(await once(`wa-scanned:${f.id}`))) continue;
    const words = faultWords(f.issue);
    if (!words.length) continue;
    const past = await sql`SELECT issue, opened_at FROM failures WHERE machine_id = ${f.machine_id} AND opened_at > now() - interval '30 days' ORDER BY opened_at`;
    for (const w of words) {
      const same = past.filter((p) => faultWords(p.issue).includes(w));
      if (same.length < 3) continue;
      const no = Number(String(f.machine_id).replace(/\D/g, ""));
      const week = Math.floor(Date.now() / (7 * 86400_000));
      if (!(await once(`wa-repeat:${no}:${w}:${week}`))) continue;
      const dates = same.map((p) => ddmm(beninDay(new Date(p.opened_at)))).join(", ");
      await outbox(`🔁 *Problème répétitif — Mc ${no}* : « ${f.issue} » — ${same.length} fois en 30 jours (${dates}). À vérifier en profondeur (cause racine).`);
      break;
    }
  }
  await setConfig("wa.fault_scan_at", now);
}

export async function tick(): Promise<{ ok: true }> {
  await remindPendingChanges();
  await detectRepeatedFaults();
  await eveningRun().catch((e) => console.error("Question du soir:", e));
  return { ok: true };
}

// ---------- Surveillance du robot ----------
export async function heartbeat() {
  await setConfig("wa.last_seen", new Date().toISOString());
  if (await config("wa.alerted_for")) {
    await setConfig("wa.alerted_for", "");
    await pushAdmins("Robot WhatsApp G37 de retour", "Le robot est de nouveau connecté.").catch(() => 0);
  }
}

export async function watchdog() {
  // Question du soir : lancée aussi par la tâche planifiée du serveur (toutes les 15 min), même si le robot est coupé :
  // l'appel dans l'app sonne quand même ; les messages WhatsApp partiront à son retour.
  await eveningRun().catch((e) => console.error("Question du soir:", e));
  const last = await config("wa.last_seen");
  if (!last) return { ok: true, state: "jamais vu" };
  const minutes = Math.round((Date.now() - new Date(last).getTime()) / 60_000);
  if (minutes < 20) return { ok: true, minutes };
  if ((await config("wa.alerted_for")) === last) return { ok: true, minutes, alerted: true };
  const sent = await pushAdmins("⚠️ Robot WhatsApp G37 hors ligne", `Plus de nouvelles du robot depuis ${minutes} min. Vérifie le VPS (bot.log) et le téléphone du numéro robot.`);
  await setConfig("wa.alerted_for", last);
  return { ok: true, minutes, alerted: true, sent };
}

export async function takeOutbox() {
  await heartbeat();
  // to_phone : message privé (sinon le groupe) ; voice : note vocale (WAV en base64) à envoyer avant le texte.
  try {
    return await sql`SELECT id, text, to_phone, voice FROM wa_outbox WHERE sent_at IS NULL AND created_at > now() - interval '2 days' ORDER BY id LIMIT 10`;
  } catch {
    // Base pas encore mise à jour (colonnes to_phone / voice absentes) : comme avant.
    return await sql`SELECT id, text FROM wa_outbox WHERE sent_at IS NULL AND created_at > now() - interval '2 days' ORDER BY id LIMIT 20`;
  }
}
export async function ackOutbox(ids: number[]) {
  if (ids.length) await sql`UPDATE wa_outbox SET sent_at = now() WHERE id = ANY(${ids})`;
  return { ok: true };
}

export { addDays };
