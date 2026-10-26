// deno-lint-ignore-file no-explicit-any
// Rapport mensuel des pannes (Excel) : résumé, pannes du mois, métiers, causes, pièces sorties et maintenances.
import ExcelJS from "exceljs";
import { db, sql } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { json } from "../lib/http.ts";

const MACHINES = 28;
const hours = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 3600000);
const r1 = (v: number) => Math.round(v * 10) / 10;

function sheet(wb: any, name: string, cols: Array<{ header: string; key: string; width?: number }>, rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
  rows.forEach((r) => ws.addRow(r));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FF1A1205" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF59E0B" } };
  ws.columns.forEach((c: any) => c.eachCell?.({ includeEmpty: false }, (cell: any) => { if (cell.value instanceof Date) cell.numFmt = "dd/mm/yyyy hh:mm"; }));
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

export async function handleReport(request: Request): Promise<Response> {
  let user: any;
  try { ({ user } = await getServerUserSession(request)); } catch { return json({ error: "Authentification requise" }, 401); }
  const me = await db.selectFrom("users").select(["role", "jobRole", "pending"]).where("id", "=", user.id).executeTakeFirst();
  if (!me || me.pending || (me.role !== "admin" && (me.jobRole === "helper" || !me.jobRole))) return json({ error: "Ton compte n'a pas accès au rapport." }, 403);

  const month = new URL(request.url).searchParams.get("month") ?? new Date(Date.now() + 3600000).toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "Mois invalide" }, 400);
  // Mois en heure du Bénin (UTC+1).
  const start = new Date(`${month}-01T00:00:00+01:00`);
  const [y, m] = month.split("-").map(Number);
  const end = new Date(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01T00:00:00+01:00`);
  const now = new Date();
  const periodEnd = end > now ? now : end;
  const periodH = hours(start, periodEnd);

  const [faults, outs, maint, checklists, eff] = await Promise.all([
    sql`SELECT id, machine_id, issue, severity, status, reported_by, fixed_by, opened_at, resolved_at, stopped_at, restarted_at, notes
      FROM failures WHERE opened_at >= ${start} AND opened_at < ${end} ORDER BY opened_at`,
    sql`SELECT m.created_at, i.name, i.unit, m.quantity, m.unit_cost, m.machine_no, m.failure_id, m.author_name, m.reason
      FROM stock_movements m JOIN stock_items i ON i.id = m.item_id
      WHERE m.movement_type = 'sortie' AND m.created_at >= ${start} AND m.created_at < ${end} ORDER BY m.created_at`,
    sql`SELECT r.id, r.machine_id, r.performed_at, r.technician, r.notes FROM maintenance_records r
      WHERE r.performed_at >= ${month + "-01"}::date AND r.performed_at < ${end.toISOString().slice(0, 10)}::date ORDER BY r.performed_at`,
    sql`SELECT maintenance_id, items FROM maint_checklists WHERE done_at >= ${start} AND done_at < ${end}`,
    sql`SELECT avg(value)::float AS v FROM machine_efficiency WHERE month = ${month}`,
  ]);

  const noOf = (id: string) => Number(String(id).replace(/\D/g, "")) || 0;
  const downOf = (f: any) => (f.stopped_at ? hours(new Date(f.stopped_at), new Date(f.restarted_at ?? f.resolved_at ?? periodEnd)) : 0);
  const repairOf = (f: any) => (f.resolved_at ? hours(new Date(f.opened_at), new Date(f.resolved_at)) : null);
  const repairs = faults.map(repairOf).filter((v: number | null): v is number => v != null);
  const totalDown = faults.reduce((a: number, f: any) => a + downOf(f), 0);
  const mttrMin = repairs.length ? (repairs.reduce((a: number, b: number) => a + b, 0) / repairs.length) * 60 : null;
  const mtbfDays = faults.length ? (periodH * MACHINES) / faults.length / 24 : null;
  const cost = outs.reduce((a: number, o: any) => a + (o.unit_cost == null ? 0 : Number(o.unit_cost) * Number(o.quantity)), 0);

  const byMachine = new Map<number, { n: number; down: number; cost: number; issues: Map<string, number> }>();
  faults.forEach((f: any) => {
    const no = noOf(f.machine_id);
    const e = byMachine.get(no) ?? { n: 0, down: 0, cost: 0, issues: new Map() };
    e.n++; e.down += downOf(f); e.issues.set(f.issue, (e.issues.get(f.issue) ?? 0) + 1);
    byMachine.set(no, e);
  });
  outs.forEach((o: any) => {
    if (!o.machine_no || o.unit_cost == null) return;
    const e = byMachine.get(o.machine_no) ?? { n: 0, down: 0, cost: 0, issues: new Map() };
    e.cost += Number(o.unit_cost) * Number(o.quantity);
    byMachine.set(o.machine_no, e);
  });
  const byCause = new Map<string, { n: number; down: number; machines: Set<number> }>();
  faults.forEach((f: any) => {
    const e = byCause.get(f.issue) ?? { n: 0, down: 0, machines: new Set() };
    e.n++; e.down += downOf(f); e.machines.add(noOf(f.machine_id));
    byCause.set(f.issue, e);
  });
  const clByMaint = new Map<string, Array<{ done: boolean }>>(checklists.map((c: any) => [String(c.maintenance_id), c.items as Array<{ done: boolean }>]));

  const wb = new ExcelJS.Workbook();
  wb.creator = "Atelier G37";
  wb.created = now;
  sheet(wb, "Résumé", [{ header: "Indicateur", key: "k", width: 42 }, { header: "Valeur", key: "v", width: 22 }], [
    { k: `Rapport des pannes — ${month}`, v: "" },
    { k: "Pannes signalées", v: faults.length },
    { k: "Pannes encore ouvertes", v: faults.filter((f: any) => f.status !== "resolue").length },
    { k: "Heures d'arrêt (machines arrêtées)", v: r1(totalDown) },
    { k: "Temps moyen de réparation (min)", v: mttrMin == null ? "—" : Math.round(mttrMin) },
    { k: "Temps moyen entre deux pannes (jours, par métier)", v: mtbfDays == null ? "—" : r1(mtbfDays) },
    { k: "Pièces sorties (coût, F CFA)", v: Math.round(cost) },
    { k: "Maintenances faites", v: maint.length },
    { k: "Efficacité moyenne (%)", v: eff[0]?.v == null ? "—" : r1(Number(eff[0].v)) },
    { k: "Généré le", v: now },
  ]);
  sheet(wb, "Pannes", [
    { header: "Signalée le", key: "opened" }, { header: "M/C", key: "no", width: 7 }, { header: "Panne", key: "issue", width: 30 },
    { header: "Gravité", key: "sev", width: 10 }, { header: "Statut", key: "st", width: 10 }, { header: "Signalée par", key: "by" },
    { header: "Réglée par", key: "fix" }, { header: "Réglée le", key: "resolved" }, { header: "Réparation (min)", key: "rep", width: 16 },
    { header: "Arrêt (h)", key: "down", width: 10 }, { header: "Notes", key: "notes", width: 40 },
  ], faults.map((f: any) => ({
    opened: new Date(f.opened_at), no: noOf(f.machine_id), issue: f.issue, sev: f.severity, st: f.status === "resolue" ? "réglée" : "ouverte",
    by: f.reported_by, fix: f.fixed_by, resolved: f.resolved_at ? new Date(f.resolved_at) : null,
    rep: repairOf(f) == null ? null : Math.round((repairOf(f) as number) * 60), down: r1(downOf(f)), notes: f.notes,
  })));
  sheet(wb, "Par métier", [
    { header: "M/C", key: "no", width: 7 }, { header: "Pannes", key: "n", width: 9 }, { header: "Arrêt (h)", key: "down", width: 10 },
    { header: "Temps moyen entre pannes (j)", key: "mtbf", width: 26 }, { header: "Pièces (F CFA)", key: "cost", width: 14 }, { header: "Panne la plus fréquente", key: "top", width: 30 },
  ], [...byMachine.entries()].sort((a, b) => b[1].n - a[1].n || b[1].down - a[1].down).map(([no, e]) => ({
    no, n: e.n, down: r1(e.down), mtbf: e.n ? r1(periodH / e.n / 24) : "—", cost: Math.round(e.cost),
    top: [...e.issues.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—",
  })));
  sheet(wb, "Par cause", [
    { header: "Panne", key: "issue", width: 32 }, { header: "Nombre", key: "n", width: 9 }, { header: "Arrêt (h)", key: "down", width: 10 }, { header: "Métiers touchés", key: "mc", width: 30 },
  ], [...byCause.entries()].sort((a, b) => b[1].n - a[1].n).map(([issue, e]) => ({ issue, n: e.n, down: r1(e.down), mc: [...e.machines].sort((a, b) => a - b).map((n) => `M/C ${n}`).join(", ") })));
  sheet(wb, "Pièces sorties", [
    { header: "Date", key: "at" }, { header: "Article", key: "name", width: 26 }, { header: "Quantité", key: "q", width: 10 }, { header: "Unité", key: "u", width: 8 },
    { header: "Prix unitaire", key: "pu", width: 13 }, { header: "Coût", key: "c", width: 12 }, { header: "M/C", key: "no", width: 7 }, { header: "Par", key: "by" }, { header: "Motif", key: "why", width: 36 },
  ], outs.map((o: any) => ({
    at: new Date(o.created_at), name: o.name, q: Number(o.quantity), u: o.unit, pu: o.unit_cost == null ? null : Number(o.unit_cost),
    c: o.unit_cost == null ? null : Math.round(Number(o.unit_cost) * Number(o.quantity)), no: o.machine_no, by: o.author_name, why: o.reason,
  })));
  sheet(wb, "Maintenances", [
    { header: "Date", key: "at", width: 12 }, { header: "M/C", key: "no", width: 7 }, { header: "Technicien", key: "who" }, { header: "Check-list", key: "cl", width: 14 }, { header: "Notes", key: "notes", width: 44 },
  ], maint.map((r: any) => {
    const items = clByMaint.get(r.id);
    return { at: String(r.performed_at).slice(0, 10), no: noOf(r.machine_id), who: r.technician, cl: items ? `${items.filter((i) => i.done).length}/${items.length}` : "—", notes: r.notes };
  }));

  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="rapport-pannes-G37-${month}.xlsx"`,
    },
  });
}
