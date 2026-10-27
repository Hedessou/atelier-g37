import { db } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { g37 } from "../shared/g37.ts";
import { runDueAlerts } from "../lib/dueAlerts.ts";
import { BUCKET_CHAT, supa } from "../lib/supa.ts";
import { sj } from "../lib/http.ts";
import superjson from "superjson";
import { sql } from "../lib/db.ts";
import { serverSign } from "../lib/p2pKeys.ts";
import { teamOnDuty } from "../lib/duty.ts";
import { escalateOpenFaults } from "../lib/notify.ts";

function noFromId(id: string): number { const digits = id.replace(/\D/g, ""); return digits ? parseInt(digits, 10) : 0; }

// deno-lint-ignore no-explicit-any
type Row = any;

export async function handleState(request: Request): Promise<Response> {
  try {
    const { user } = await getServerUserSession(request);
    const [cyclePointRows, stockNameRows, users, machines, gears, stock, works, failures, greasing, shifts, efficiency, specs, maintenance, chat, manual] = await Promise.all([
      db.selectFrom("g37CyclePoints").select(["id", "kind", "pointKey", "name", "intervalDays"]).orderBy("createdAt", "asc").execute(),
      db.selectFrom("stockItems").select("name").orderBy("name", "asc").execute(),
      db.selectFrom("users").select(["id", "email", "displayName", "role", "jobRole", "team", "pending", "lastSeen", "firstName", "lastName", "postTitle", "avatarUrl"]).orderBy("displayName", "asc").execute(),
      db.selectFrom("machines").select(["id", "name", "machineNo", "groupId", "status", "runG", "runH", "runCount", "stopReason", "stoppedSince", "lastMaintenance", "nextMaintenance", "maintPlannedBy", "maintPlannedAt", "maintPlanNote"]).execute(),
      db.selectFrom("gears").select(["gearType", "teeth", "stock"]).orderBy("gearType", "asc").orderBy("teeth", "asc").execute(),
      db.selectFrom("stockItems").select(["id", "name", "category", "unit", "quantity", "minimumQuantity", "unitPrice", "leadDays"]).orderBy("category", "asc").orderBy("name", "asc").execute(),
      db.selectFrom("works").select(["id", "machineNo", "title", "status", "auto", "authorName", "doneByName", "doneAt", "createdAt"]).orderBy("createdAt", "desc").limit(400).execute(),
      db.selectFrom("failures").select(["id", "machineId", "issue", "severity", "status", "notes", "technician", "reportedBy", "fixedBy", "openedAt", "resolvedAt", "stoppedAt", "restartedAt"]).orderBy("openedAt", "desc").limit(1500).execute(),
      db.selectFrom("greasingRecords").select(["machineNo", "kind", "pointKey", "doneOn", "authorName"]).orderBy("doneOn", "desc").limit(4000).execute(),
      db.selectFrom("shiftPlan").select(["day", "team", "shiftCode"]).orderBy("day", "asc").execute(),
      db.selectFrom("machineEfficiency").select(["machineNo", "month", "value"]).orderBy("month", "asc").execute(),
      db.selectFrom("groupSpecs").select(["groupId", "fields", "updatedBy"]).execute(),
      db.selectFrom("maintenanceRecords").innerJoin("machines", "machines.id", "maintenanceRecords.machineId")
        .select(["maintenanceRecords.id", "maintenanceRecords.machineId", "machines.machineNo", "maintenanceRecords.maintenanceType", "maintenanceRecords.performedAt", "maintenanceRecords.nextDue", "maintenanceRecords.technician", "maintenanceRecords.notes"])
        .orderBy("maintenanceRecords.performedAt", "desc").limit(1000).execute(),
      db.selectFrom("chatMessages").select(["id", "author", "message", "createdAt", "fileKey", "fileName", "fileType", "fileSize", "replyToId", "replyToAuthor", "replyToMessage", "mentionUserIds"]).orderBy("createdAt", "desc").limit(200).execute(),
      db.selectFrom("g37ManualChunks").select((eb: Row) => eb.fn.countAll().as("n")).executeTakeFirst(),
    ]);

    // Ce téléphone vient de recevoir les dernières données : on le note (suivi « qui est à jour »).
    const deviceId = request.headers.get("x-g37-device") ?? "";
    if (/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) {
      await sql`UPDATE user_devices SET last_state_at = now(), last_seen = now() WHERE device_id = ${deviceId} AND user_id = ${user.id}`.catch(() => {});
    }
    const [syncRows, lastChange] = await Promise.all([
      sql`SELECT user_id, max(last_state_at) AS at FROM user_devices WHERE last_state_at IS NOT NULL GROUP BY user_id`,
      sql`SELECT max(applied_at) AS at FROM sync_ops`,
    ]);
    const syncBy = new Map(syncRows.map((r: Row) => [r.user_id, r.at]));
    const withSeen = users.map((u: Row) => ({
      ...u, team: u.team ?? null, lastSeen: u.lastSeen ?? null, firstName: u.firstName ?? null, lastName: u.lastName ?? null,
      postTitle: u.postTitle ?? null, avatarUrl: u.avatarUrl ?? null, lastSyncAt: syncBy.get(u.id) ?? null,
    }));
    const me = withSeen.find((u: Row) => u.id === user.id);
    const allowed = g37.visibleTabs(me ?? user);
    const sees = (tab: string) => allowed === null || allowed.includes(tab);

    let chatOut: unknown[] = [];
    if (sees("discussion")) {
      const keys = chat.map((c: Row) => c.fileKey).filter((k: string | null): k is string => !!k && k.startsWith("chat/"));
      const urlByKey = new Map<string, string>();
      if (keys.length) {
        const { data } = await supa.storage.from(BUCKET_CHAT).createSignedUrls(keys, 86400);
        (data ?? []).forEach((d) => { if (d.path && d.signedUrl) urlByKey.set(d.path, d.signedUrl); });
      }
      chatOut = chat.map(({ fileKey, fileName, fileType, fileSize, ...c }: Row) => ({
        ...c, fileName: fileName ?? null, fileType: fileType ?? null, fileSize: fileSize ?? null,
        fileUrl: fileKey ? urlByKey.get(fileKey) ?? null : null,
        replyToId: c.replyToId ?? null, replyToAuthor: c.replyToAuthor ?? null, replyToMessage: c.replyToMessage ?? null,
        mentionUserIds: Array.isArray(c.mentionUserIds) ? (c.mentionUserIds as unknown[]).map(Number).filter(Number.isInteger) : [],
      }));
    }

    try { await runDueAlerts(machines, greasing, works); } catch (e) { console.error("Alertes d'échéance:", e); }
    try { await escalateOpenFaults(); } catch (e) { console.error("Relance des pannes:", e); }

    // Magasin : consommation réelle (sorties des 30 et 60 derniers jours) et sorties récentes (coûts, fiche machine).
    const seesStock = sees("magasin") || sees("machines") || sees("pannes");
    const [usageRows, outRows, stepRows, checklistRows, duty] = await Promise.all([
      sql`SELECT item_id, sum(quantity) FILTER (WHERE created_at > now() - interval '30 days') AS u30, sum(quantity) AS u60
        FROM stock_movements WHERE movement_type = 'sortie' AND created_at > now() - interval '60 days' GROUP BY item_id`,
      seesStock ? sql`SELECT m.id, m.item_id, i.name, i.unit, m.quantity, m.unit_cost, m.machine_no, m.failure_id, m.author_name, m.reason, m.created_at
        FROM stock_movements m JOIN stock_items i ON i.id = m.item_id
        WHERE m.movement_type = 'sortie' AND m.created_at > now() - interval '400 days' ORDER BY m.created_at DESC LIMIT 800` : Promise.resolve([]),
      sql`SELECT id, position, text FROM checklist_steps ORDER BY position, id`,
      sees("maintenance") || sees("machines") ? sql`SELECT id, machine_no, maintenance_id, done_at, author_name, items, photo_before, photo_after, notes
        FROM maint_checklists ORDER BY done_at DESC LIMIT 150` : Promise.resolve([]),
      teamOnDuty().catch(() => null),
    ]);
    const usage = new Map<string, { u30: number; u60: number }>(usageRows.map((r: Row) => [String(r.item_id), { u30: Number(r.u30 ?? 0), u60: Number(r.u60 ?? 0) }]));
    const photoKeys = checklistRows.flatMap((c: Row) => [c.photo_before, c.photo_after]).filter((k: string | null): k is string => !!k);
    const photoUrls = new Map<string, string>();
    if (photoKeys.length) {
      const { data } = await supa.storage.from(BUCKET_CHAT).createSignedUrls(photoKeys, 86400);
      (data ?? []).forEach((d) => { if (d.path && d.signedUrl) photoUrls.set(d.path, d.signedUrl); });
    }

    // Pour le mode sans Internet : clés publiques des téléphones (messages privés chiffrés, actions relayées)
    // et actions déjà appliquées par le serveur (les téléphones relais peuvent les oublier).
    const [deviceRows, opRows] = await Promise.all([
      sql`SELECT device_id, user_id, sign_jwk, enc_jwk FROM user_devices WHERE last_seen > now() - interval '120 days'`,
      sql`SELECT op_id FROM sync_ops WHERE applied_at > now() - interval '14 days' ORDER BY applied_at DESC LIMIT 1500`,
    ]);

    const payload = {
      serverTime: new Date(),
      lastChangeAt: lastChange[0]?.at ?? null,
      manualReady: Number(manual?.n ?? 0) > 0,
      me: me ?? { id: user.id, email: user.email, displayName: user.displayName, role: user.role, jobRole: "helper", team: null, pending: false, lastSeen: null },
      // Messagerie privée et appels : tout poste qui a l'onglet Messages voit la liste des collègues.
      users: allowed === null || sees("discussion") ? withSeen : withSeen.filter((u: Row) => u.id === user.id),
      machines: machines.map((m: Row) => ({
        id: m.id, no: m.machineNo ?? noFromId(m.id), name: m.name, groupId: m.groupId ?? null, status: m.status,
        runG: m.runG ?? null, runH: m.runH ?? null, runCount: m.runCount == null ? null : String(m.runCount),
        stopReason: m.stopReason ?? null, stoppedSince: m.stoppedSince ?? null, lastMaintenance: m.lastMaintenance ?? null, nextMaintenance: m.nextMaintenance ?? null,
        plannedBy: m.maintPlannedBy ?? null, plannedAt: m.maintPlannedAt ?? null, planNote: m.maintPlanNote ?? null,
      })).filter((m: Row) => m.no > 0).sort((a: Row, b: Row) => a.no - b.no),
      gears: sees("gears") || sees("calcul") ? gears.map((x: Row) => ({ gearType: x.gearType, teeth: x.teeth, stock: x.stock })) : [],
      stock: sees("magasin") ? stock.map((s: Row) => {
        const u = usage.get(s.id) ?? { u30: 0, u60: 0 };
        const perDay = u.u60 / 60;
        return {
          id: s.id, name: s.name, category: s.category, unit: s.unit, quantity: String(s.quantity), minimumQuantity: String(s.minimumQuantity),
          unitPrice: s.unitPrice == null ? null : String(s.unitPrice), leadDays: Number(s.leadDays ?? 14),
          used30: u.u30, perDay: Math.round(perDay * 1000) / 1000, daysLeft: perDay > 0 ? Math.floor(Number(s.quantity) / perDay) : null,
        };
      }) : [],
      stockOuts: outRows.map((m: Row) => ({
        id: m.id, itemId: m.item_id, itemName: m.name, unit: m.unit, quantity: Number(m.quantity), unitCost: m.unit_cost == null ? null : Number(m.unit_cost),
        machineNo: m.machine_no ?? null, failureId: m.failure_id ?? null, authorName: m.author_name ?? null, reason: m.reason ?? null, createdAt: m.created_at,
      })),
      checklistSteps: stepRows.map((r: Row) => ({ id: r.id, position: r.position, text: r.text })),
      checklists: checklistRows.map((c: Row) => ({
        id: c.id, machineNo: c.machine_no, maintenanceId: c.maintenance_id ?? null, doneAt: c.done_at, authorName: c.author_name ?? null,
        items: Array.isArray(c.items) ? c.items : [], notes: c.notes ?? null,
        photoBeforeUrl: c.photo_before ? photoUrls.get(c.photo_before) ?? null : null, photoAfterUrl: c.photo_after ? photoUrls.get(c.photo_after) ?? null : null,
      })),
      duty: duty ? { team: duty.team, code: duty.code, general: g37.generalOnDuty() } : (g37.generalOnDuty() ? { team: "", code: "g", general: true } : null),
      works: sees("travaux") || sees("machines") ? works.map((w: Row) => ({ ...w, authorName: w.authorName ?? null, doneByName: w.doneByName ?? null, doneAt: w.doneAt ?? null })) : [],
      failures: !sees("pannes") && !sees("machines") ? [] : failures.map((f: Row) => ({
        ...f, machineNo: noFromId(f.machineId), notes: f.notes ?? null, technician: f.technician ?? null, reportedBy: f.reportedBy ?? null,
        fixedBy: f.fixedBy ?? null, resolvedAt: f.resolvedAt ?? null, stoppedAt: f.stoppedAt ?? null, restartedAt: f.restartedAt ?? null,
      })),
      greasing: sees("graissage") || sees("lubrification") || sees("schedule") || sees("machines") ? greasing.map((r: Row) => ({ ...r, authorName: r.authorName ?? null })) : [],
      cyclePoints: cyclePointRows.map((p: Row) => ({ id: p.id, kind: p.kind, key: p.pointKey, name: p.name, days: p.intervalDays })),
      stockNames: [...new Set(stockNameRows.map((r: Row) => r.name.trim()).filter(Boolean))],
      shifts: sees("quarts") ? shifts : [],
      efficiency: sees("machines") || sees("accueil") ? efficiency.map((e: Row) => ({ machineNo: e.machineNo, month: e.month, value: String(e.value) })) : [],
      specs: sees("machines") ? specs.map((s: Row) => ({ groupId: s.groupId, fields: s.fields, updatedBy: s.updatedBy ?? null })) : [],
      maintenance: sees("maintenance") || sees("machines") ? maintenance.map((r: Row) => ({
        id: r.id, machineNo: r.machineNo ?? noFromId(r.machineId), maintenanceType: r.maintenanceType,
        performedAt: r.performedAt, nextDue: r.nextDue ?? null, technician: r.technician ?? null, notes: r.notes ?? null,
      })) : [],
      chat: chatOut,
      devices: deviceRows.map((d: Row) => ({ deviceId: d.device_id, userId: d.user_id, signJwk: d.sign_jwk, encJwk: d.enc_jwk })),
      appliedOpIds: opRows.map((r: Row) => r.op_id),
    };
    // Réponse signée par le serveur : un téléphone peut la transmettre à un autre sans pouvoir la falsifier.
    const body = superjson.stringify(payload);
    const sig = await serverSign(body);
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json", "x-g37-sig": sig } });
  } catch (error) {
    return sj({ error: error instanceof Error ? error.message : "Authentification requise" }, 401);
  }
}
