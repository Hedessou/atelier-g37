// deno-lint-ignore-file no-explicit-any
import ExcelJS from "exceljs";
import { db } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { json } from "../lib/http.ts";

type Col = { header: string; key: string; width?: number };
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const machineNoFromId = (id: string | null | undefined) => { const digits = (id ?? "").replace(/\D/g, ""); return digits ? parseInt(digits, 10) : null; };

function addSheet(wb: any, name: string, cols: Col[], rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
  rows.forEach((r) => ws.addRow(r));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
  ws.columns.forEach((c: any) => { c.eachCell?.({ includeEmpty: false }, (cell: any) => { if (cell.value instanceof Date) cell.numFmt = "dd/mm/yyyy hh:mm"; }); });
  if (rows.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

export async function handleExport(request: Request): Promise<Response> {
  let user;
  try { ({ user } = await getServerUserSession(request)); } catch { return json({ error: "Authentification requise" }, 401); }
  if (user.role !== "admin") return json({ error: "Seul l'admin peut exporter la sauvegarde." }, 403);
  try {
    const [machines, failures, maintenance, greasing, cyclePoints, works, stock, movements, gears, shifts, efficiency, specs, users, chat] = await Promise.all([
      db.selectFrom("machines").selectAll().orderBy("machineNo", "asc").execute(),
      db.selectFrom("failures").selectAll().orderBy("openedAt", "desc").execute(),
      db.selectFrom("maintenanceRecords").leftJoin("machines", "machines.id", "maintenanceRecords.machineId").select(["maintenanceRecords.machineId", "machines.machineNo", "maintenanceRecords.maintenanceType", "maintenanceRecords.performedAt", "maintenanceRecords.nextDue", "maintenanceRecords.technician", "maintenanceRecords.notes"]).orderBy("maintenanceRecords.performedAt", "desc").execute(),
      db.selectFrom("greasingRecords").selectAll().orderBy("doneOn", "desc").execute(),
      db.selectFrom("g37CyclePoints").selectAll().orderBy("createdAt", "asc").execute(),
      db.selectFrom("works").selectAll().orderBy("createdAt", "desc").execute(),
      db.selectFrom("stockItems").selectAll().orderBy("category", "asc").orderBy("name", "asc").execute(),
      db.selectFrom("stockMovements").leftJoin("stockItems", "stockItems.id", "stockMovements.itemId").select(["stockMovements.createdAt", "stockItems.name", "stockMovements.movementType", "stockMovements.quantity", "stockMovements.reason"]).orderBy("stockMovements.createdAt", "desc").execute(),
      db.selectFrom("gears").selectAll().orderBy("gearType", "asc").orderBy("teeth", "asc").execute(),
      db.selectFrom("shiftPlan").selectAll().orderBy("day", "asc").execute(),
      db.selectFrom("machineEfficiency").selectAll().orderBy("month", "asc").orderBy("machineNo", "asc").execute(),
      db.selectFrom("groupSpecs").selectAll().orderBy("groupId", "asc").execute(),
      db.selectFrom("users").select(["displayName", "email", "role", "jobRole", "team", "pending", "createdAt"]).orderBy("displayName", "asc").execute(),
      db.selectFrom("chatMessages").select(["createdAt", "author", "message", "fileName", "replyToAuthor"]).orderBy("createdAt", "asc").execute(),
    ]);
    const wb = new ExcelJS.Workbook();
    wb.creator = "Atelier G37";
    wb.created = new Date();
    const now = new Date();
    addSheet(wb, "Infos", [{ header: "Élément", key: "k", width: 30 }, { header: "Valeur", key: "v", width: 40 }], [
      { k: "Sauvegarde de l'atelier G37", v: "" }, { k: "Exportée le", v: now }, { k: "Exportée par", v: user.displayName }, { k: "Machines", v: machines.length }, { k: "Pannes", v: failures.length },
      { k: "Maintenances", v: maintenance.length }, { k: "Graissages / lubrifications", v: greasing.length }, { k: "Travaux", v: works.length }, { k: "Articles du magasin", v: stock.length }, { k: "Messages de discussion", v: chat.length },
    ]);
    addSheet(wb, "Machines", [{ header: "N°", key: "no", width: 6 }, { header: "Nom", key: "name", width: 22 }, { header: "Groupe", key: "group", width: 8 }, { header: "Statut", key: "status" }, { header: "Running G", key: "runG", width: 11 }, { header: "Running H", key: "runH", width: 11 }, { header: "Compte", key: "count", width: 10 }, { header: "Motif d'arrêt", key: "stopReason", width: 24 }, { header: "Arrêtée depuis", key: "stoppedSince" }, { header: "Dernière maintenance", key: "last", width: 20 }, { header: "Prochaine maintenance", key: "next", width: 20 }, { header: "Notes", key: "notes", width: 40 }],
      machines.map((m: any) => ({ no: m.machineNo ?? machineNoFromId(m.id), name: m.name, group: m.groupId, status: m.status, runG: m.runG, runH: m.runH, count: num(m.runCount), stopReason: m.stopReason, stoppedSince: m.stoppedSince, last: m.lastMaintenance, next: m.nextMaintenance, notes: m.notes })));
    addSheet(wb, "Pannes", [{ header: "Ouverte le", key: "openedAt" }, { header: "Machine", key: "no", width: 9 }, { header: "Problème", key: "issue", width: 34 }, { header: "Gravité", key: "severity", width: 11 }, { header: "Statut", key: "status", width: 11 }, { header: "Signalée par", key: "reportedBy" }, { header: "Technicien", key: "technician" }, { header: "Réparée par", key: "fixedBy" }, { header: "Arrêt", key: "stoppedAt" }, { header: "Redémarrage", key: "restartedAt" }, { header: "Résolue le", key: "resolvedAt" }, { header: "Durée d'arrêt (h)", key: "downtime", width: 16 }, { header: "Notes", key: "notes", width: 40 }],
      failures.map((f: any) => ({ ...f, no: machineNoFromId(f.machineId), downtime: f.stoppedAt && f.restartedAt ? Math.round(((new Date(f.restartedAt).getTime() - new Date(f.stoppedAt).getTime()) / 3600000) * 10) / 10 : null })));
    addSheet(wb, "Maintenance", [{ header: "Date", key: "performedAt" }, { header: "Machine", key: "no", width: 9 }, { header: "Type", key: "maintenanceType", width: 26 }, { header: "Technicien", key: "technician" }, { header: "Prochaine échéance", key: "nextDue" }, { header: "Notes", key: "notes", width: 40 }], maintenance.map((r: any) => ({ ...r, no: r.machineNo ?? machineNoFromId(r.machineId) })));
    addSheet(wb, "Graissage-Lubrif", [{ header: "Fait le", key: "doneOn" }, { header: "Machine", key: "machineNo", width: 9 }, { header: "Type", key: "kind", width: 12 }, { header: "Point", key: "pointKey", width: 20 }, { header: "Par", key: "authorName" }], greasing);
    addSheet(wb, "Points personnalisés", [{ header: "Type", key: "kind", width: 12 }, { header: "Code", key: "pointKey", width: 18 }, { header: "Nom", key: "name", width: 28 }, { header: "Intervalle (jours)", key: "intervalDays", width: 16 }, { header: "Créé par", key: "createdBy" }, { header: "Créé le", key: "createdAt" }], cyclePoints);
    addSheet(wb, "Travaux", [{ header: "Créé le", key: "createdAt" }, { header: "Machine", key: "machineNo", width: 9 }, { header: "Travail", key: "title", width: 46 }, { header: "Statut", key: "status", width: 10 }, { header: "Automatique", key: "auto", width: 12 }, { header: "Créé par", key: "authorName" }, { header: "Fait par", key: "doneByName" }], works.map((w: any) => ({ ...w, auto: w.auto ? "oui" : "non" })));
    addSheet(wb, "Magasin", [{ header: "Catégorie", key: "category", width: 18 }, { header: "Article", key: "name", width: 30 }, { header: "Unité", key: "unit", width: 9 }, { header: "Quantité", key: "quantity", width: 10 }, { header: "Seuil minimum", key: "minimumQuantity", width: 14 }, { header: "Manque", key: "missing", width: 9 }, { header: "Emplacement", key: "location" }, { header: "Mis à jour", key: "updatedAt" }],
      stock.map((s: any) => { const q = num(s.quantity) ?? 0; const min = num(s.minimumQuantity) ?? 0; return { ...s, quantity: q, minimumQuantity: min, missing: q < min ? "OUI" : "" }; }));
    addSheet(wb, "Mouvements stock", [{ header: "Date", key: "createdAt" }, { header: "Article", key: "name", width: 30 }, { header: "Mouvement", key: "movementType", width: 12 }, { header: "Quantité", key: "quantity", width: 10 }, { header: "Motif", key: "reason", width: 34 }], movements.map((m: any) => ({ ...m, quantity: num(m.quantity) })));
    addSheet(wb, "Pignons", [{ header: "Type", key: "gearType", width: 8 }, { header: "Dents (Z)", key: "teeth", width: 10 }, { header: "Stock", key: "stock", width: 8 }, { header: "Mis à jour par", key: "updatedBy" }, { header: "Mis à jour le", key: "updatedAt" }], gears);
    addSheet(wb, "Quarts", [{ header: "Jour", key: "day" }, { header: "Équipe", key: "team", width: 9 }, { header: "Quart", key: "shiftCode", width: 9 }, { header: "Modifié par", key: "updatedBy" }], shifts);
    addSheet(wb, "Efficacité", [{ header: "Mois", key: "month", width: 10 }, { header: "Machine", key: "machineNo", width: 9 }, { header: "Efficacité", key: "value", width: 11 }, { header: "Saisi par", key: "authorName" }], efficiency.map((e: any) => ({ ...e, value: num(e.value) })));
    addSheet(wb, "Specs groupes", [{ header: "Groupe", key: "groupId", width: 8 }, { header: "Valeurs", key: "fields", width: 90 }, { header: "Modifié par", key: "updatedBy" }, { header: "Modifié le", key: "updatedAt" }], specs.map((s: any) => ({ ...s, fields: JSON.stringify(s.fields) })));
    addSheet(wb, "Équipe", [{ header: "Nom", key: "displayName", width: 24 }, { header: "E-mail", key: "email", width: 30 }, { header: "Rôle", key: "role", width: 8 }, { header: "Poste", key: "jobRole", width: 14 }, { header: "Équipe", key: "team", width: 8 }, { header: "En attente", key: "pending", width: 10 }, { header: "Inscrit le", key: "createdAt" }], users.map((u: any) => ({ ...u, pending: u.pending ? "oui" : "non" })));
    addSheet(wb, "Discussion", [{ header: "Date", key: "createdAt" }, { header: "Auteur", key: "author", width: 20 }, { header: "Message", key: "message", width: 70 }, { header: "Fichier joint", key: "fileName", width: 24 }, { header: "En réponse à", key: "replyToAuthor" }], chat);
    const buffer = await wb.xlsx.writeBuffer();
    const stamp = now.toISOString().slice(0, 10);
    return new Response(buffer as ArrayBuffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="sauvegarde-atelier-G37-${stamp}.xlsx"`, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Export G37:", error);
    return json({ error: error instanceof Error ? error.message : "Export impossible" }, 500);
  }
}
