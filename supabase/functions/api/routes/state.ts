import { db } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { g37 } from "../shared/g37.ts";
import { runDueAlerts } from "../lib/dueAlerts.ts";
import { BUCKET_CHAT, supa } from "../lib/supa.ts";
import { sj } from "../lib/http.ts";

function noFromId(id: string): number {
  const digits = id.replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

// GET g37/state — toutes les données de l'atelier (le téléphone les garde en mémoire pour le hors ligne).
export async function handleState(request: Request): Promise<Response> {
  try {
    const { user } = await getServerUserSession(request);
    const [cyclePointRows, stockNameRows, users, machines, gears, stock, works, failures, greasing, shifts, efficiency, specs, maintenance, chat, manual] = await Promise.all([
      db.selectFrom("g37CyclePoints").select(["id", "kind", "pointKey", "name", "intervalDays"]).orderBy("createdAt", "asc").execute(),
      db.selectFrom("stockItems").select("name").orderBy("name", "asc").execute(),
      db.selectFrom("users").select(["id", "email", "displayName", "role", "jobRole", "team", "pending", "lastSeen"]).orderBy("displayName", "asc").execute(),
      db.selectFrom("machines").select(["id", "name", "machineNo", "groupId", "status", "runG", "runH", "runCount", "stopReason", "stoppedSince", "lastMaintenance", "nextMaintenance"]).execute(),
      db.selectFrom("gears").select(["gearType", "teeth", "stock"]).orderBy("gearType", "asc").orderBy("teeth", "asc").execute(),
      db.selectFrom("stockItems").select(["id", "name", "category", "unit", "quantity", "minimumQuantity"]).orderBy("category", "asc").orderBy("name", "asc").execute(),
      db.selectFrom("works").select(["id", "machineNo", "title", "status", "auto", "authorName", "doneByName", "createdAt"]).orderBy("createdAt", "desc").limit(400).execute(),
      db.selectFrom("failures").select(["id", "machineId", "issue", "severity", "status", "notes", "technician", "reportedBy", "fixedBy", "openedAt", "resolvedAt", "stoppedAt", "restartedAt"]).orderBy("openedAt", "desc").limit(400).execute(),
      db.selectFrom("greasingRecords").select(["machineNo", "kind", "pointKey", "doneOn", "authorName"]).orderBy("doneOn", "desc").limit(4000).execute(),
      db.selectFrom("shiftPlan").select(["day", "team", "shiftCode"]).orderBy("day", "asc").execute(),
      db.selectFrom("machineEfficiency").select(["machineNo", "month", "value"]).orderBy("month", "asc").execute(),
      db.selectFrom("groupSpecs").select(["groupId", "fields", "updatedBy"]).execute(),
      db.selectFrom("maintenanceRecords").innerJoin("machines", "machines.id", "maintenanceRecords.machineId")
        .select(["maintenanceRecords.id", "maintenanceRecords.machineId", "machines.machineNo", "maintenanceRecords.maintenanceType", "maintenanceRecords.performedAt", "maintenanceRecords.nextDue", "maintenanceRecords.technician", "maintenanceRecords.notes"])
        .orderBy("maintenanceRecords.performedAt", "desc").limit(1000).execute(),
      db.selectFrom("chatMessages").select(["id", "author", "message", "createdAt", "fileKey", "fileName", "fileType", "fileSize", "replyToId", "replyToAuthor", "replyToMessage", "mentionUserIds"]).orderBy("createdAt", "desc").limit(200).execute(),
      db.selectFrom("g37ManualChunks").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst(),
    ]);

    const withSeen = users.map((u) => ({ ...u, team: u.team ?? null, lastSeen: u.lastSeen ?? null }));
    const me = withSeen.find((u) => u.id === user.id);
    const allowed = g37.visibleTabs(me ?? user);
    const sees = (tab: string) => allowed === null || allowed.includes(tab);

    // Liens temporaires (24 h) vers les fichiers de la discussion.
    let chatOut: unknown[] = [];
    if (sees("discussion")) {
      const keys = chat.map((c) => c.fileKey).filter((k): k is string => !!k && k.startsWith("chat/"));
      const urlByKey = new Map<string, string>();
      if (keys.length) {
        const { data } = await supa.storage.from(BUCKET_CHAT).createSignedUrls(keys, 86400);
        (data ?? []).forEach((d) => { if (d.path && d.signedUrl) urlByKey.set(d.path, d.signedUrl); });
      }
      chatOut = chat.map(({ fileKey, fileName, fileType, fileSize, ...c }) => ({
        ...c,
        fileName: fileName ?? null, fileType: fileType ?? null, fileSize: fileSize ?? null,
        fileUrl: fileKey ? urlByKey.get(fileKey) ?? null : null,
        replyToId: c.replyToId ?? null, replyToAuthor: c.replyToAuthor ?? null, replyToMessage: c.replyToMessage ?? null,
        mentionUserIds: Array.isArray(c.mentionUserIds) ? (c.mentionUserIds as unknown[]).map(Number).filter(Number.isInteger) : [],
      }));
    }

    try {
      await runDueAlerts(machines, greasing, works);
    } catch (e) {
      console.error("Alertes d'échéance:", e);
    }

    return sj({
      serverTime: new Date(),
      manualReady: Number(manual?.n ?? 0) > 0,
      me: me ?? { id: user.id, email: user.email, displayName: user.displayName, role: user.role, jobRole: "helper", team: null, pending: false, lastSeen: null },
      users: allowed === null ? withSeen : withSeen.filter((u) => u.id === user.id),
      machines: machines.map((m) => ({
        id: m.id, no: m.machineNo ?? noFromId(m.id), name: m.name, groupId: m.groupId ?? null, status: m.status,
        runG: m.runG ?? null, runH: m.runH ?? null, runCount: m.runCount == null ? null : String(m.runCount),
        stopReason: m.stopReason ?? null, stoppedSince: m.stoppedSince ?? null,
        lastMaintenance: m.lastMaintenance ?? null, nextMaintenance: m.nextMaintenance ?? null,
      })).filter((m) => m.no > 0).sort((a, b) => a.no - b.no),
      gears: sees("gears") || sees("calcul") ? gears.map((x) => ({ gearType: x.gearType, teeth: x.teeth, stock: x.stock })) : [],
      stock: sees("magasin") ? stock.map((s) => ({ id: s.id, name: s.name, category: s.category, unit: s.unit, quantity: String(s.quantity), minimumQuantity: String(s.minimumQuantity) })) : [],
      works: sees("travaux") || sees("machines") ? works.map((w) => ({ ...w, authorName: w.authorName ?? null, doneByName: w.doneByName ?? null })) : [],
      failures: !sees("pannes") && !sees("machines") ? [] : failures.map((f) => ({
        ...f, machineNo: noFromId(f.machineId), notes: f.notes ?? null, technician: f.technician ?? null, reportedBy: f.reportedBy ?? null,
        fixedBy: f.fixedBy ?? null, resolvedAt: f.resolvedAt ?? null, stoppedAt: f.stoppedAt ?? null, restartedAt: f.restartedAt ?? null,
      })),
      greasing: sees("graissage") || sees("lubrification") || sees("schedule") || sees("machines") ? greasing.map((r) => ({ ...r, authorName: r.authorName ?? null })) : [],
      cyclePoints: cyclePointRows.map((p) => ({ id: p.id, kind: p.kind, key: p.pointKey, name: p.name, days: p.intervalDays })),
      stockNames: [...new Set(stockNameRows.map((r) => r.name.trim()).filter(Boolean))],
      shifts: sees("quarts") ? shifts : [],
      efficiency: sees("machines") || sees("accueil") ? efficiency.map((e) => ({ machineNo: e.machineNo, month: e.month, value: String(e.value) })) : [],
      specs: sees("machines") ? specs.map((s) => ({ groupId: s.groupId, fields: s.fields, updatedBy: s.updatedBy ?? null })) : [],
      maintenance: sees("maintenance") || sees("machines") ? maintenance.map((r) => ({
        id: r.id, machineNo: r.machineNo ?? noFromId(r.machineId), maintenanceType: r.maintenanceType,
        performedAt: r.performedAt, nextDue: r.nextDue ?? null, technician: r.technician ?? null, notes: r.notes ?? null,
      })) : [],
      chat: chatOut,
    });
  } catch (error) {
    return sj({ error: error instanceof Error ? error.message : "Authentification requise" }, 401);
  }
}
