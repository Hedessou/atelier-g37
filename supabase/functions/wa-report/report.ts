// Rapport du matin du robot WhatsApp G37 — mise en forme (04/11/2026, mis à jour le 08/11/2026).
// Repris de report() de wa-bot (commit a82bc16), avec ces règles :
//   • EN TÊTE : la maintenance programmée pour aujourd'hui (dans l'app : « Programmer la maintenance » du superviseur,
//     ou sur WhatsApp : réponse à l'appel du soir, ou travaux « Maintenance / clg » ajoutés depuis 24 h), avec qui l'a programmée ;
//     sinon « Aucune maintenance programmée aujourd'hui » ;
//   • des métiers sont programmés → la liste des machines en retard n'est PAS affichée ;
//   • aucun métier programmé → la rubrique « ⏰ Maintenance clg » (retards + prochaines échéances) suit.
// Envoyé dans le groupe de maintenance (Ring Fram Local Team) seulement, du lundi au vendredi (config.json du robot : reportDays).
// Aucune dépendance : testable hors Supabase.

export const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
export const diff = (a: string, b: string) => Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400000);
export const when = (days: number) => (days < 0 ? `retard ${-days} j` : days === 0 ? "aujourd'hui" : days === 1 ? "demain" : `dans ${days} j`);
export const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
export const rf = (n: number) => "Mc " + n;

const GREASE_POINTS = [
  { k: "nipples", n: "Nipples", d: 30 }, { k: "front", n: "Front rollers", d: 15 }, { k: "blackmiddle", n: "Black & middle rollers", d: 30 },
  { k: "mainshaft", n: "Main shaft", d: 365 }, { k: "screwrod", n: "Screw rod", d: 30 }, { k: "gearing", n: "All gearing", d: 30 },
];
const LUB_BOXES = [
  { k: "drafting", n: "Drafting gear box", d: 30 }, { k: "ringrail", n: "Ring rail gear box", d: 30 }, { k: "doffer", n: "Doffer gear box", d: 30 }, { k: "servodisc", n: "Servodisc gear box", d: 30 },
];
const CYCLE_OVERRIDES = [{ kind: "grease", point: "front", from: 21, to: 28, d: 7 }];
const DAYS_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

function staticDays(kind: string, point: string, no: number): number {
  const o = CYCLE_OVERRIDES.find((x) => x.kind === kind && x.point === point && no >= x.from && no <= x.to);
  if (o) return o.d;
  return (kind === "grease" ? GREASE_POINTS : LUB_BOXES).find((p) => p.k === point)?.d ?? 30;
}

type Item = { no: number; due: string; days: number; detail?: string };

// Règle d'une rubrique : 3 machines. Les machines en retard d'abord (les plus en retard),
// complétées par les prochaines échéances : 3 en retard → les 3 ; 2 → 2 + 1 ; 1 → 1 + 2 ; 0 → les 3 prochaines.
function section(title: string, items: Item[]): string[] {
  const sorted = [...items].sort((a, b) => a.days - b.days || a.no - b.no);
  const late = sorted.filter((i) => i.days < 0);
  const coming = sorted.filter((i) => i.days >= 0);
  const shown = late.length >= 3 ? late.slice(0, 3) : [...late, ...coming.slice(0, 3 - late.length)];
  const lines = [`*${title}*`];
  if (!shown.length) lines.push("✅ Rien à signaler");
  for (const i of shown) lines.push(`• Mc ${i.no} — ${i.detail ?? `${ddmm(i.due)} (${when(i.days)})`}`);
  const extra = late.slice(3);
  if (extra.length) lines.push(`_+ ${extra.length} autre(s) en retard : ${extra.map((i) => `Mc ${i.no}`).join(", ")}_`);
  return lines;
}

function byMachine(points: Array<{ no: number; name: string; due: string; days: number }>): Item[] {
  const map = new Map<number, Array<{ name: string; due: string; days: number }>>();
  for (const p of points) (map.get(p.no) ?? map.set(p.no, []).get(p.no)!).push(p);
  return [...map.entries()].map(([no, list]) => {
    list.sort((a, b) => a.days - b.days);
    const first = list[0];
    const shown = list.filter((p) => p.days <= Math.max(2, first.days));
    return { no, due: first.due, days: first.days, detail: shown.map((p) => `${p.name} ${ddmm(p.due)} (${when(p.days)})`).join(", ") };
  });
}

// Maintenance ajoutée dans « Travaux à effectuer » (titre « Maintenance », « Maintenance clg », « cleaning »…),
// fautes courantes comprises : « Maint clg », « Maintenace », « Cleanning », « Clening », « Entretien »…
export const isMaintWork = (t: string) => /\b(maint\w*|mtce|mntc|clg|clng|clea?n\w*|nettoy\w*|entretien)\b/i.test(t) && !/\bteam\b/i.test(t);

type Row = Record<string, unknown>;
export type ReportData = {
  machines: Row[];  // machine_no, next_maintenance, maint_planned_by
  greasing: Row[];  // kind, machine_no, point_key, done_on (dernier par point)
  points: Row[];    // kind, point_key, name, interval_days
  failures: Row[];  // machine_id, issue, opened_at
  works: Row[];     // machine_no, title, created_at, author_name
};

/** Métiers qui passent en maintenance aujourd'hui (programmés dans l'app / sur WhatsApp, ou ajoutés en travaux depuis 24 h), avec qui les a programmés. */
export function todayMaintenance(data: ReportData, today: string, nowMs: number): { machines: number[]; fromWorks: Row[]; by: Map<number, string> } {
  const fromWorks = data.works.filter((w) => isMaintWork(String(w.title)) && nowMs - new Date(w.created_at as string).getTime() < 24 * 3600_000);
  const planned = data.machines.filter((m) => m.maint_planned_by && m.next_maintenance && isoDay(m.next_maintenance as string) === today);
  const by = new Map<number, string>();
  for (const m of planned) by.set(Number(m.machine_no), String(m.maint_planned_by));
  for (const w of fromWorks) if (!by.has(Number(w.machine_no)) && w.author_name) by.set(Number(w.machine_no), String(w.author_name).replace(/^WhatsApp · /, ""));
  const machines = [...new Set([...fromWorks.map((w) => Number(w.machine_no)), ...planned.map((m) => Number(m.machine_no))])]
    .filter((n) => n >= 1 && n <= 28).sort((a, b) => a - b);
  return { machines, fromWorks, by };
}

export function buildReport(data: ReportData, today: string, nowMs: number): string {
  const { machines: todayMaint, fromWorks: todayWorks, by } = todayMaintenance(data, today, nowMs);

  const maint: Item[] = data.machines.filter((m) => m.next_maintenance && !todayMaint.includes(Number(m.machine_no))).map((m) => {
    const due = isoDay(m.next_maintenance as string);
    return { no: Number(m.machine_no), due, days: diff(due, today) };
  });

  const custom = new Map(data.points.map((c) => [`${c.kind}:${c.point_key}`, c]));
  const grease: Array<{ no: number; name: string; due: string; days: number }> = [];
  const sched: typeof grease = [];
  for (const r of data.greasing) {
    const no = Number(r.machine_no);
    const c = custom.get(`${r.kind}:${r.point_key}`);
    if (r.kind === "sched" && !c) continue;
    const every = c ? Number(c.interval_days) : staticDays(String(r.kind), String(r.point_key), no);
    const due = addDays(isoDay(r.done_on as string), every);
    const name = String(c?.name ?? (r.kind === "grease" ? GREASE_POINTS : LUB_BOXES).find((p) => p.k === r.point_key)?.n ?? r.point_key);
    (r.kind === "sched" ? sched : grease).push({ no, name, due, days: diff(due, today) });
  }

  const todo: Array<{ no: number; line: string }> = [];
  for (const f of data.failures) {
    const no = Number(String(f.machine_id).replace(/\D/g, "")) || 0;
    const age = diff(today, isoDay(new Date(new Date(f.opened_at as string).getTime() + 3600_000)));
    todo.push({ no, line: `${rf(no)} — ${f.issue} (panne${age > 0 ? `, depuis ${age} j` : ", signalée aujourd'hui"})` });
  }
  for (const w of data.works.filter((x) => !todayWorks.includes(x))) {
    const title = String(w.title);
    todo.push({ no: Number(w.machine_no), line: title.startsWith("Count change") ? title : `${rf(Number(w.machine_no))} — ${title}` });
  }
  todo.sort((a, b) => a.no - b.no);

  const d = new Date(today + "T00:00:00Z");
  const out: string[] = [`*🔧 Atelier G37 — ${DAYS_FR[d.getUTCDay()]} ${today.slice(8, 10)}/${today.slice(5, 7)}*`, ""];
  if (todayMaint.length) {
    // Métiers programmés : on les annonce en tête (avec qui les a programmés), et la liste des retards n'est pas envoyée.
    out.push(`*🧹 Maintenance programmée aujourd'hui : ${todayMaint.map(rf).join(", ")}*`);
    const who = [...new Set(todayMaint.map((n) => by.get(n)).filter(Boolean))];
    if (who.length) out.push(`_Programmée par ${who.join(", ")}_`);
    out.push("");
  } else {
    out.push("*🧹 Aucune maintenance programmée aujourd'hui.*", "_À programmer dans l'app (Accueil) ou en répondant au robot le soir._", "");
    out.push(...section("⏰ Maintenance clg", maint), "");
  }
  out.push(...section("🛢️ Graissage", byMachine(grease)), "");
  out.push(...section("📅 Schedule works", byMachine(sched)), "");
  out.push("*🛠️ Travaux à effectuer*");
  out.push(...(todo.length ? todo.map((t) => `• ${t.line}`) : ["✅ Aucun travail en attente"]));
  return out.join("\n");
}
