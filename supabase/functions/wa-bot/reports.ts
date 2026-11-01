// Rapports PDF de quart (01/11/2026), envoyés chaque jour dans « Spinning Shift Supervisors » :
// MORNING 7h–15h, AFTERNOON 15h–23h, NIGHT 23h–7h. Le robot lit la page « RING-SPINNING PRODUCTION DATA REPORT » :
// • efficience de chaque ring frame → gardée par quart, et moyenne du mois dans l'app (écran Efficacité) ;
// • remarques (« M/F : SERVODISC ISSUE = 20' ») → pannes : réglées avec leur durée, ouvertes s'il n'y a pas de durée.
import { broadcastChanged, outbox, rf, sql } from "./db.ts";
import { gemini, QuotaError } from "./gemini.ts";

export type RingRow = { machine: number; count: string | null; prod: number | null; eff: number | null; reason: string | null };
export type Report = { isReport: boolean; shift: "m" | "s" | "n" | null; team: string | null; date: string | null; totalEff: number | null; ring: RingRow[] };

const PROMPT = `This PDF is a daily production report from a spinning mill. Find the page or section titled "RING-SPINNING PRODUCTION DATA REPORT"
(columns: RING FRAME, COUNT, PRODUCTION (KG), EFF %, OPERATOR NAMES, MONITORS, REASON). Ignore every other section (carding, comber,
draw frame, speed frame, link coner, open end, TFO, winding...).
Read the header of that section: SHIFT (MORNING, AFTERNOON or NIGHT), TEAM (a letter) and DATE (dd/mm/yyyy).
For EVERY ring frame row 1 to 28, return: machine (int), count (text exactly as written, e.g. "12 KW PRO", "60/80 CCW", or null),
prod (kg, number or null), eff (EFF %, number or null), reason (the REASON text exactly as written, or null).
Rows with no values: count, prod and eff = null (keep the reason if there is one, e.g. "APP").
totalEff = the EFF % of the "Total" line of the ring section, or null.
isReport = false if there is no ring spinning section.
Answer ONLY with JSON: {"isReport": bool, "shift": "MORNING"|"AFTERNOON"|"NIGHT"|null, "team": string|null, "date": "YYYY-MM-DD"|null, "totalEff": number|null,
"ring": [{"machine": int, "count": string|null, "prod": number|null, "eff": number|null, "reason": string|null}]}`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    isReport: { type: "BOOLEAN" },
    shift: { type: "STRING", enum: ["MORNING", "AFTERNOON", "NIGHT"], nullable: true },
    team: { type: "STRING", nullable: true },
    date: { type: "STRING", nullable: true },
    totalEff: { type: "NUMBER", nullable: true },
    ring: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          machine: { type: "INTEGER" }, count: { type: "STRING", nullable: true }, prod: { type: "NUMBER", nullable: true },
          eff: { type: "NUMBER", nullable: true }, reason: { type: "STRING", nullable: true },
        },
        required: ["machine"],
      },
    },
  },
  required: ["isReport", "ring"],
};

const SHIFT_CODE: Record<string, "m" | "s" | "n"> = { MORNING: "m", AFTERNOON: "s", NIGHT: "n" };
const SHIFT_FR = { m: "matin (7h–15h)", s: "après-midi (15h–23h)", n: "nuit (23h–7h)" } as const;
const SHIFT_START = { m: 7, s: 15, n: 23 } as const; // heure du Bénin

/** Quart d'après le nom du fichier ou la légende (« MORNING SHIFT », « NIGHT »…). */
export function shiftFromName(s: string): "m" | "s" | "n" | null {
  if (/morning|matin/i.test(s)) return "m";
  if (/after\s*noon|evening|soir|apr[eè]s[- ]?midi/i.test(s)) return "s";
  if (/night|nuit/i.test(s)) return "n";
  return null;
}

/** Nettoie et contrôle la lecture de l'IA. */
export function cleanReport(raw: Record<string, unknown>): Report {
  const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(String(v).replace(",", "."))) ? Number(String(v).replace(",", ".")) : null);
  const txt = (v: unknown, max = 200) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s ? s.slice(0, max) : null; };
  const rows = new Map<number, RingRow>();
  for (const r of Array.isArray(raw.ring) ? raw.ring as Record<string, unknown>[] : []) {
    const machine = Math.round(Number(r.machine));
    if (!(machine >= 1 && machine <= 28)) continue;
    const eff = num(r.eff);
    rows.set(machine, {
      machine, count: txt(r.count, 40), prod: num(r.prod),
      eff: eff != null && eff >= 0 && eff <= 100 ? eff : null,
      reason: txt(r.reason),
    });
  }
  const date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const total = num(raw.totalEff);
  return {
    isReport: !!raw.isReport && rows.size > 0,
    shift: SHIFT_CODE[String(raw.shift ?? "").toUpperCase()] ?? null,
    team: txt(raw.team, 4)?.toUpperCase() ?? null,
    date, totalEff: total != null && total >= 0 && total <= 100 ? total : null,
    ring: [...rows.values()].sort((a, b) => a.machine - b.machine),
  };
}

export type Remark = { kind: "elec" | "meca" | "other"; tag: string | null; issue: string; minutes: number | null };

/** « M/F : SERVODISC ISSUE = 20' » → panne mécanique « Servodisc issue », 20 min. Rien à enregistrer → null. */
export function parseRemark(reason: string | null): Remark | null {
  const r = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (!r) return null;
  // APP / ACC / M/F seul, changement de count ou de lot, nettoyage programmé : pas une panne.
  if (/^(app|acc|a\.?p\.?p\.?|m\/f|stopped|no material|manque.*)$/i.test(r)) return null;
  if (/\b(count|lot|article)\s*chang\w*|\bcount\s*change\b/i.test(r)) return null;
  // Manque de matière ou de personnel : pas une panne machine.
  if (/\b(run\s*out|new\s*lot|material\s*(chg|change|short\w*)|no\s*material|no\s*(operator|labou?r)|manque\s+de\s+(m[èe]che|mati[èe]re|personnel))\b/i.test(r)) return null;
  let kind: Remark["kind"] = /\belectric|\belec\b/i.test(r) ? "elec" : /\bmechanic|\bm[ée]cani/i.test(r) ? "meca" : "other";
  let rest = r;
  // Abréviations du rapport : E/L, E/F = électrique ; M/F, M/C = mécanique.
  const pre = r.match(/^\s*(e\s*\/\s*[lf]|m\s*\/\s*[fc])\s*[:\-]?\s*/i);
  if (pre) {
    kind = /^e/i.test(pre[1]) ? "elec" : "meca";
    rest = r.slice(pre[0].length);
  }
  // Durée : « = 60' », « 20 MIN », « 480 MIN », « 1H », « 1h30 ».
  const END = String.raw`(?![\p{L}\p{N}])`;
  const MIN_RE = new RegExp(String.raw`=?\s*(\d{1,4})\s*(?:'|’|min\p{L}*|mn)${END}`, "iu");
  const H_RE = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|heures?)\s*(\d{1,2})?${END}`, "iu");
  let minutes: number | null = null;
  const m = rest.match(MIN_RE) ?? rest.match(/=\s*(\d{1,4})\s*$/);
  const h = rest.match(H_RE);
  if (m) minutes = Number(m[1]);
  else if (h) minutes = Math.round(Number(h[1].replace(",", ".")) * 60 + Number(h[2] ?? 0));
  let issue = rest.replace(new RegExp(MIN_RE.source, "giu"), " ").replace(/=\s*\d{1,4}\s*$/, " ").replace(new RegExp(H_RE.source, "giu"), " ")
    .replace(/[=:;,\-\s]+$/g, "").replace(/^[=:;,\-\s]+/g, "").replace(/\s+/g, " ").trim();
  // « E/F ON DISPLAY », « E/F + SIDE CUT » : on garde le sens de l'abréviation.
  if (pre && (/^(on|at|in|of|\+|&|and|et)\b/i.test(issue) || /^\+/.test(issue) || issue.length < 3)) {
    issue = `${kind === "elec" ? "Electrical fault" : "Mechanical fault"} ${issue.replace(/^\+\s*/, "+ ")}`.trim();
  }
  if (!issue || issue.length < 3) return null;
  const nice = issue.charAt(0).toUpperCase() + issue.slice(1).toLowerCase();
  const tag = pre ? pre[1].replace(/\s+/g, "").toUpperCase() : null;
  return { kind, tag, issue: nice.slice(0, 200), minutes: minutes != null && minutes > 0 && minutes <= 1440 ? minutes : null };
}

/** Heure de début du quart, en UTC. */
function shiftStart(day: string, shift: "m" | "s" | "n"): Date {
  const d = new Date(Date.parse(`${day}T00:00:00Z`) + (SHIFT_START[shift] - 1) * 3600_000);
  // Quart de nuit daté du jour où il finit (23h la veille → 7h) : on recule d'un jour si l'heure est dans le futur.
  return d.getTime() > Date.now() ? new Date(d.getTime() - 86400_000) : d;
}

export async function readReportPdf(b64: string): Promise<Report> {
  const raw = await gemini([{ role: "user", parts: [{ inline_data: { mime_type: "application/pdf", data: b64 } }, { text: PROMPT }] }],
    { schema: SCHEMA, budgetMs: 110_000, perModelMs: 70_000 });
  return cleanReport(JSON.parse(raw));
}

/** Enregistre un rapport lu : efficience par quart et par mois, pannes des remarques. Renvoie le message pour le groupe. */
export async function saveReport(rep: Report, info: { msgId: string; fileName: string; at: Date; dry?: boolean }) {
  const day = rep.date ?? new Date(info.at.getTime() + 3600_000).toISOString().slice(0, 10);
  const shift = rep.shift ?? shiftFromName(info.fileName);
  if (!shift) return { ok: false, reply: null, error: "quart illisible" };
  const withEff = rep.ring.filter((r) => r.eff != null);
  const avg = rep.totalEff ?? (withEff.length ? withEff.reduce((s, r) => s + (r.eff ?? 0), 0) / withEff.length : null);

  const faults: Array<{ machine: number; remark: Remark; raw: string }> = [];
  for (const r of rep.ring) {
    const rm = parseRemark(r.reason);
    if (rm) faults.push({ machine: r.machine, remark: rm, raw: r.reason! });
  }
  const label = `${SHIFT_FR[shift]}${rep.team ? `, équipe ${rep.team}` : ""} du ${day.slice(8, 10)}/${day.slice(5, 7)}`;
  if (info.dry) return { ok: true, day, shift, avg, rows: rep.ring, faults, reply: null };

  const [row] = await sql`INSERT INTO shift_reports (day, shift, team, msg_id, file_name, total_eff, data)
    VALUES (${day}::date, ${shift}, ${rep.team}, ${info.msgId}, ${info.fileName.slice(0, 200)}, ${avg}, ${sql.json(rep)})
    ON CONFLICT (day, shift) DO UPDATE SET team = EXCLUDED.team, msg_id = EXCLUDED.msg_id, file_name = EXCLUDED.file_name,
      total_eff = EXCLUDED.total_eff, data = EXCLUDED.data, created_at = now() RETURNING id`;
  for (const r of rep.ring) {
    await sql`INSERT INTO machine_shift_eff (day, shift, machine_no, team, count_label, prod_kg, eff, reason, report_id)
      VALUES (${day}::date, ${shift}, ${r.machine}, ${rep.team}, ${r.count}, ${r.prod}, ${r.eff}, ${r.reason}, ${row.id})
      ON CONFLICT (day, shift, machine_no) DO UPDATE SET team = EXCLUDED.team, count_label = EXCLUDED.count_label, prod_kg = EXCLUDED.prod_kg,
        eff = EXCLUDED.eff, reason = EXCLUDED.reason, report_id = EXCLUDED.report_id`;
  }
  // Efficacité du mois dans l'app = moyenne des quarts où la machine a produit.
  const month = day.slice(0, 7);
  const touched = withEff.map((r) => r.machine);
  if (touched.length) {
    await sql`INSERT INTO machine_efficiency (id, machine_no, month, value, author_name, updated_at)
      SELECT machine_no || '-' || ${month}, machine_no, ${month}, round(avg(eff), 1), 'Rapports de quart (robot)', now()
      FROM machine_shift_eff WHERE to_char(day, 'YYYY-MM') = ${month} AND eff IS NOT NULL AND machine_no = ANY(${touched})
      GROUP BY machine_no
      ON CONFLICT (machine_no, month) DO UPDATE SET value = EXCLUDED.value, author_name = EXCLUDED.author_name, updated_at = now()`;
  }

  // Pannes des remarques (une seule fois par rapport, machine et remarque, même si le PDF est renvoyé).
  const start = shiftStart(day, shift);
  const who = `Rapport ${SHIFT_FR[shift].split(" ")[0]}${rep.team ? ` ${rep.team}` : ""}`;
  const saved: string[] = [];
  for (const f of faults) {
    const src = `report:${day}:${shift}:${f.machine}:${f.remark.issue.toLowerCase().replace(/\W+/g, "-").slice(0, 60)}`;
    const issue = `${f.remark.issue}${f.remark.tag ? ` (${f.remark.tag})` : ""}`;
    const end = f.remark.minutes ? new Date(start.getTime() + f.remark.minutes * 60_000) : null;
    const notes = `Rapport de quart ${label} : ${f.raw}${f.remark.minutes ? ` — arrêt ${f.remark.minutes} min` : ""}`;
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 21);
    const ins = end
      ? await sql`INSERT INTO failures (id, machine_id, issue, notes, severity, status, reported_by, stopped_at, opened_at, resolved_at, restarted_at, technician, fixed_by, source)
          VALUES (${id}, ${"M-" + String(f.machine).padStart(2, "0")}, ${issue}, ${notes}, 'moyenne', 'resolue', ${who}, ${start}, ${start}, ${end}, ${end}, ${who}, ${who}, ${src})
          ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING RETURNING id`
      : await sql`INSERT INTO failures (id, machine_id, issue, notes, severity, status, reported_by, stopped_at, opened_at, source)
          VALUES (${id}, ${"M-" + String(f.machine).padStart(2, "0")}, ${issue}, ${notes}, 'moyenne', 'ouverte', ${who}, ${start}, ${start}, ${src})
          ON CONFLICT (source) WHERE source IS NOT NULL DO NOTHING RETURNING id`;
    if (ins.length) saved.push(`• ${rf(f.machine)} : ${issue}${f.remark.minutes ? ` — ${f.remark.minutes} min (réglée)` : " — *ouverte*"}`);
  }
  await broadcastChanged();

  const low = withEff.filter((r) => (r.eff ?? 100) < 80).map((r) => `${rf(r.machine)} ${Math.round(r.eff!)} %`);
  const lines = [`📊 *Rapport du quart ${label}* lu par le robot`,
    `Efficience : ${withEff.length} métier(s)${avg != null ? `, moyenne *${Math.round(avg)} %*` : ""}${low.length ? `\n⚠️ Sous 80 % : ${low.join(", ")}` : ""}`];
  if (saved.length) lines.push(`🛠️ Pannes enregistrées (${saved.length}) :\n${saved.join("\n")}`);
  const reply = lines.join("\n\n");
  await outbox(reply);
  return { ok: true, day, shift, avg, rows: rep.ring.length, faults: saved.length, reply };
}

export async function handleReportPdf(body: { pdf?: string; fileName?: string; dry?: boolean }, m: { msgId: string; at: Date }) {
  if (!body.pdf) return { ok: false, error: "pdf manquant" };
  let rep: Report;
  try { rep = await readReportPdf(body.pdf); }
  catch (e) {
    console.error("Rapport PDF:", e);
    return { ok: false, quota: e instanceof QuotaError, error: e instanceof Error ? e.message : String(e) };
  }
  if (!rep.isReport) return { ok: true, ignored: "pas un rapport de ring frames" };
  return await saveReport(rep, { msgId: m.msgId, fileName: String(body.fileName ?? ""), at: m.at, dry: !!body.dry });
}
