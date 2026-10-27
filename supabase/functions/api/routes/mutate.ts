// deno-lint-ignore-file no-explicit-any
import { z } from "zod";
import { nanoid } from "nanoid";
import { hash } from "bcryptjs";
import { db, sql } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { g37, type Perm } from "../shared/g37.ts";
import { notifyFault, notifyRoles, notifyUsers } from "../lib/notify.ts";
import { BUCKET_CHAT, broadcastChanged, broadcastTo, supa } from "../lib/supa.ts";
import { callTopic } from "../lib/p2pKeys.ts";
import { readSuperjson, sj } from "../lib/http.ts";

export const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("machine"), no: z.number().int().min(1).max(28), runG: z.number().int().nullable(), runH: z.number().int().nullable(), status: z.enum(["service", "arret", "maintenance"]), stopReason: z.string().max(120).nullable(), stoppedSince: z.coerce.date().nullable() }),
  z.object({ action: z.literal("gearStock"), gearType: z.enum(["G", "H"]), teeth: z.number().int(), stock: z.number().int().min(0).max(100000), baseStock: z.number().int().min(0).max(100000).nullable().optional() }),
  z.object({ action: z.literal("workAdd"), machineNo: z.number().int().min(1).max(28), title: z.string().min(1).max(300), status: z.enum(["todo", "done"]) }),
  z.object({ action: z.literal("workDone"), id: z.string().min(1) }),
  z.object({ action: z.literal("faultAdd"), machineNo: z.number().int().min(1).max(28), issue: z.string().min(1).max(300), notes: z.string().max(2000).nullable(), severity: z.enum(["basse", "moyenne", "haute"]), stoppedAt: z.coerce.date().nullable() }),
  z.object({ action: z.literal("faultFix"), id: z.string().min(1), fix: z.string().max(2000).nullable(), restartedAt: z.coerce.date().nullable(), parts: z.array(z.object({ itemId: z.string().min(1).max(80), quantity: z.number().positive().max(100000) })).max(10).optional() }),
  z.object({ action: z.literal("cycle"), kind: z.enum(["grease", "lub", "sched"]), pointKey: z.string().min(1).max(40), from: z.number().int().min(1).max(28), to: z.number().int().min(1).max(28) }),
  z.object({ action: z.literal("cycleDate"), kind: z.enum(["grease", "lub", "sched"]), pointKey: z.string().min(1).max(40), machineNo: z.number().int().min(1).max(28), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal("cyclePointAdd"), kind: z.enum(["grease", "lub", "sched"]), name: z.string().trim().min(1).max(80), days: z.number().int().min(1).max(3650) }),
  z.object({ action: z.literal("cyclePointEdit"), id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), days: z.number().int().min(1).max(3650) }),
  z.object({ action: z.literal("cyclePointDelete"), id: z.string().min(1).max(80) }),
  z.object({ action: z.literal("maintPlan"), machineNo: z.number().int().min(1).max(28), next: z.coerce.date().nullable() }),
  z.object({ action: z.literal("maintSchedule"), machines: z.array(z.number().int().min(1).max(28)).min(1).max(28), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(300).nullable().optional() }),
  z.object({ action: z.literal("maintDone"), machineNo: z.number().int().min(1).max(28), checklist: z.object({
    items: z.array(z.object({ text: z.string().trim().min(1).max(200), done: z.boolean(), note: z.string().max(300).nullable().optional(), extra: z.boolean().optional() })).max(80),
    photoBefore: z.string().max(300).nullable().optional(), photoAfter: z.string().max(300).nullable().optional(), notes: z.string().max(1000).nullable().optional(),
    saveExtras: z.boolean().optional(),
  }).optional() }),
  z.object({ action: z.literal("stockQty"), id: z.string().min(1), quantity: z.number().min(0), baseQuantity: z.number().min(0).nullable().optional() }),
  z.object({ action: z.literal("stockAdd"), name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60), unit: z.string().trim().min(1).max(20), quantity: z.number().min(0).max(1000000), minimumQuantity: z.number().min(0).max(1000000), unitPrice: z.number().min(0).max(1e9).nullable().optional(), leadDays: z.number().int().min(1).max(365).optional() }),
  z.object({ action: z.literal("stockEdit"), id: z.string().min(1), name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60), unit: z.string().trim().min(1).max(20), minimumQuantity: z.number().min(0).max(1000000), unitPrice: z.number().min(0).max(1e9).nullable().optional(), leadDays: z.number().int().min(1).max(365).optional() }),
  z.object({ action: z.literal("stockOut"), itemId: z.string().min(1).max(80), quantity: z.number().positive().max(100000), machineNo: z.number().int().min(1).max(28).nullable(), failureId: z.string().max(80).nullable().optional(), note: z.string().max(300).nullable().optional() }),
  z.object({ action: z.literal("stockIn"), itemId: z.string().min(1).max(80), quantity: z.number().positive().max(1000000), note: z.string().max(300).nullable().optional() }),
  z.object({ action: z.literal("checklistStepAdd"), text: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("checklistStepEdit"), id: z.string().min(1).max(80), text: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("checklistStepDelete"), id: z.string().min(1).max(80) }),
  z.object({ action: z.literal("checklistStepMove"), id: z.string().min(1).max(80), dir: z.enum(["up", "down"]) }),
  z.object({ action: z.literal("stockDelete"), id: z.string().min(1) }),
  z.object({ action: z.literal("shiftSet"), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), team: z.enum(["A", "B", "C"]), shiftCode: z.enum(["m", "s", "n", "r", ""]) }),
  z.object({ action: z.literal("shiftRotate"), month: z.string().regex(/^\d{4}-\d{2}$/) }),
  z.object({ action: z.literal("eff"), machineNo: z.number().int().min(1).max(28), month: z.string().regex(/^\d{4}-\d{2}$/), value: z.number().min(0).max(100) }),
  z.object({ action: z.literal("specsSet"), groupId: z.string().min(1).max(2), fields: z.record(z.string()) }),
  z.object({ action: z.literal("specsReset"), groupId: z.string().min(1).max(2) }),
  z.object({ action: z.literal("chat"), message: z.string().max(2000), replyToId: z.string().min(1).max(100).nullable().optional(), mentionUserIds: z.array(z.number().int()).max(50).optional(), file: z.object({ key: z.string().min(1).max(300), name: z.string().min(1).max(200), type: z.string().max(120), size: z.number().int().min(0) }).nullable().optional(), clientId: z.string().min(6).max(40).optional() }),
  z.object({ action: z.literal("chatDelete"), id: z.string().min(1) }),
  z.object({ action: z.literal("passwordResetAdmin"), userId: z.number().int() }),
  z.object({ action: z.literal("grade"), userId: z.number().int(), jobRole: z.string().min(1).max(40), team: z.enum(["A", "B", "C", "G"]).nullable(), pending: z.boolean() }),
  z.object({ action: z.literal("deleteUser"), userId: z.number().int() }),
  z.object({ action: z.literal("profile"), jobRole: z.string().min(1).max(40), code: z.string().max(40).nullable() }),
  z.object({ action: z.literal("dm"), id: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/), to: z.number().int(), envelope: z.record(z.any()) }),
  z.object({ action: z.literal("profileInfo"), firstName: z.string().trim().max(60), lastName: z.string().trim().max(60), postTitle: z.string().trim().max(80), avatarKey: z.string().max(200).nullable().optional() }),
]);

export type InputType = z.infer<typeof schema>;
type Me = { id: number; displayName: string; role: string; jobRole: string; pending: boolean };
export type MutationResult = { status: number; message?: string; error?: string };

const deny = (error: string, status = 403): MutationResult => ({ status, error });
const ok = (message?: string): MutationResult => ({ status: 200, message });
const machineId = (no: number) => "M-" + String(no).padStart(2, "0");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const escapeRegExp = (value: string) => value.replace(/[\^$.*+?()[\]{}|]/g, "\\$&");

async function userIdsMentionedInText(message: string): Promise<number[]> {
  if (!message.includes("@")) return [];
  const users = await db.selectFrom("users").select(["id", "displayName"]).execute();
  return users.filter((u: any) => u.displayName.trim()).filter((u: any) => {
    const name = escapeRegExp(u.displayName.trim());
    const pattern = "(^|[^\\p{L}\\p{N}_])@" + name + "(?=$|[^\\p{L}\\p{N}_])";
    return new RegExp(pattern, "iu").test(message);
  }).map((u: any) => u.id);
}

async function moveGears(type: "G" | "H", oldZ: number | null, newZ: number | null, no: number, me: Me, now: Date): Promise<string | null> {
  if (oldZ === newZ) return null;
  const had = g37.inGearRange(type, oldZ);
  const has = g37.inGearRange(type, newZ);
  if (!had && !has) return null;
  const N = g37.GEARS_PER_MACHINE;
  let warning: string | null = null;
  if (!had) {
    await db.insertInto("works").values({ id: nanoid(), machineNo: no, auto: true, status: "done", createdAt: now, title: `Pignons ${type} : mise en service Z${newZ} (déclaration, sans mouvement de stock)`, authorId: me.id, authorName: me.displayName }).execute();
    return null;
  }
  await db.updateTable("gears").set((eb: any) => ({ stock: eb("stock", "+", N) })).where("gearType", "=", type).where("teeth", "=", oldZ as number).execute();
  if (has) {
    const row = await db.selectFrom("gears").select("stock").where("gearType", "=", type).where("teeth", "=", newZ as number).executeTakeFirst();
    const have = row?.stock ?? 0;
    if (have < N) warning = `Z${newZ} : seulement ${have} en stock pour ${N} nécessaires — vérifie l'inventaire.`;
    await db.updateTable("gears").set({ stock: Math.max(0, have - N) }).where("gearType", "=", type).where("teeth", "=", newZ as number).execute();
  }
  await db.insertInto("works").values({ id: nanoid(), machineNo: no, auto: true, status: "done", createdAt: now, title: `Pignons ${type} (${N} pièces) : Z${had ? oldZ : "?"} → Z${has ? newZ : "?"}`, authorId: me.id, authorName: me.displayName }).execute();
  return warning;
}

const staticKeys = (kind: "grease" | "lub" | "sched"): string[] => kind === "grease" ? g37.GREASE_POINTS.map((d) => d.k) : kind === "lub" ? g37.LUB_BOXES.map((d) => d.k) : [];

async function cycleKeys(kind: "grease" | "lub" | "sched"): Promise<string[]> {
  const rows = await db.selectFrom("g37CyclePoints").select("pointKey").where("kind", "=", kind).execute();
  return [...staticKeys(kind), ...rows.map((r: any) => r.pointKey)];
}

// ---- Magasin : sorties de pièces, consommation réelle, alerte de réapprovisionnement ----
const STOCK_ROLES = ["superviseur", "technicien", "shift", "forman", "manager"];

// Consommation moyenne par jour sur 60 jours, jours de stock restants, et alerte (une fois par jour et par article).
async function stockAlert(itemId: string, me: Me): Promise<void> {
  const rows = await sql`SELECT i.name, i.quantity, i.minimum_quantity, i.lead_days, i.unit,
      COALESCE((SELECT sum(m.quantity) FROM stock_movements m WHERE m.item_id = i.id AND m.movement_type = 'sortie' AND m.created_at > now() - interval '60 days'), 0) AS used60
    FROM stock_items i WHERE i.id = ${itemId}`;
  const it = rows[0];
  if (!it) return;
  const qty = Number(it.quantity);
  const min = Number(it.minimum_quantity) || g37.STOCK_ALERT;
  const perDay = Number(it.used60) / 60;
  const daysLeft = perDay > 0 ? qty / perDay : null;
  const lead = Number(it.lead_days) || 14;
  const low = qty < min;
  const soon = daysLeft != null && daysLeft <= lead;
  if (!low && !soon) return;
  const key = `stock-alert:${itemId}:${new Date(Date.now() + 3600000).toISOString().slice(0, 10)}`;
  const claimed = await sql`INSERT INTO notification_log (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING RETURNING key`;
  if (!claimed.length) return;
  const body = soon && daysLeft != null
    ? `${it.name} : ${qty} ${it.unit} restant(s), environ ${Math.max(0, Math.floor(daysLeft))} jour(s) au rythme actuel (délai ${lead} j)`
    : `${it.name} : ${qty} ${it.unit} restant(s) (seuil ${min})`;
  await notifyRoles({ jobRoles: STOCK_ROLES, excludeUserId: me.id, tag: `stock-${itemId}`, title: "À commander", body, data: { tab: "magasin" } });
}

async function takeOut(me: Me, now: Date, itemId: string, quantity: number, machineNo: number | null, failureId: string | null, note: string | null): Promise<string | null> {
  const item = await db.selectFrom("stockItems").select(["name", "quantity", "unit", "unitPrice"]).where("id", "=", itemId).executeTakeFirst();
  if (!item) return "Cet article a été supprimé entre-temps.";
  const have = Number(item.quantity);
  await db.updateTable("stockItems").set({ quantity: Math.max(0, have - quantity), updatedAt: now }).where("id", "=", itemId).execute();
  await db.insertInto("stockMovements").values({
    id: nanoid(), itemId, movementType: "sortie", quantity, createdAt: now, machineNo, failureId, authorName: me.displayName,
    unitCost: item.unitPrice ?? null,
    reason: note?.trim() || `Sortie par ${me.displayName}${machineNo ? ` pour la M/C ${machineNo}` : ""}`,
  }).execute();
  await stockAlert(itemId, me);
  return have < quantity ? `${item.name} : le stock affichait ${have} ${item.unit}, vérifie l'inventaire.` : null;
}

export async function loadMe(userId: number): Promise<Me | null> {
  const row = await db.selectFrom("users").select(["id", "displayName", "role", "jobRole", "pending"]).where("id", "=", userId).executeTakeFirst();
  return (row as Me | undefined) ?? null;
}

export async function applyMutation(me: Me, input: InputType, now: Date): Promise<MutationResult> {
  const need = (perm: Perm) => g37.can(perm, me);
  switch (input.action) {
    case "machine": {
      if (!need("machine")) return deny("Tu n'as pas le droit de modifier les relevés d'une machine.");
      for (const [t, v] of [["G", input.runG], ["H", input.runH]] as const) {
        if (v != null && !g37.inGearRange(t, v)) { const [lo, hi] = g37.GEAR_RANGE[t]; return deny(`${t} Z doit être un entier entre ${lo} et ${hi}.`, 400); }
      }
      const id = machineId(input.no);
      const cur = await db.selectFrom("machines").select(["runG", "runH", "status"]).where("id", "=", id).executeTakeFirst();
      if (!cur) return deny("Machine introuvable", 404);
      await db.updateTable("machines").set({ runG: input.runG, runH: input.runH, status: input.status, stopReason: input.status === "service" ? null : input.stopReason, stoppedSince: input.status === "service" ? null : input.stoppedSince }).where("id", "=", id).execute();
      const w1 = await moveGears("G", cur.runG ?? null, input.runG, input.no, me, now);
      const w2 = await moveGears("H", cur.runH ?? null, input.runH, input.no, me, now);
      if (cur.status === "service" && input.status !== "service") {
        await notifyRoles({ dutyFirst: true, jobRoles: ["superviseur", "technicien", "shift"], excludeUserId: me.id, tag: `arret-${input.no}`, title: `M/C ${input.no} à l'arrêt`, body: `${input.stopReason ?? "motif non précisé"} — saisi par ${me.displayName}` });
      } else if (cur.status !== "service" && input.status === "service") {
        await notifyRoles({ jobRoles: ["superviseur", "prodsup", "prodman"], excludeUserId: me.id, tag: `reprise-${input.no}`, title: `M/C ${input.no} remise en service`, body: `Remise en service par ${me.displayName}` });
      }
      for (const w of [w1, w2]) {
        if (w) await notifyRoles({ jobRoles: ["superviseur", "technicien", "shift"], excludeUserId: me.id, tag: `pignons-${input.no}`, title: "Stock de pignons insuffisant", body: `M/C ${input.no} : ${w}` });
      }
      return ok([w1, w2].filter(Boolean).join(" ") || undefined);
    }
    case "gearStock": {
      if (!need("gears")) return deny("Seuls l'admin, le superviseur, le technicien et le shift technician modifient les pignons.");
      if (!g37.inGearRange(input.gearType, input.teeth)) return deny("Denture hors plage.", 400);
      if (input.baseStock != null) {
        const delta = input.stock - input.baseStock;
        await db.updateTable("gears").set((eb: any) => ({ stock: eb.fn("greatest", [eb.val(0), eb("stock", "+", delta)]), updatedBy: me.displayName, updatedAt: now })).where("gearType", "=", input.gearType).where("teeth", "=", input.teeth).execute();
      } else {
        await db.updateTable("gears").set({ stock: input.stock, updatedBy: me.displayName, updatedAt: now }).where("gearType", "=", input.gearType).where("teeth", "=", input.teeth).execute();
      }
      return ok();
    }
    case "workAdd": {
      if (!need("works")) return deny("Tu n'as pas le droit d'ajouter un travail.");
      await db.insertInto("works").values({ id: nanoid(), machineNo: input.machineNo, title: input.title, status: input.status, auto: false, authorId: me.id, authorName: me.displayName, createdAt: now }).execute();
      if (input.status === "todo") await notifyRoles({ dutyFirst: true, jobRoles: ["superviseur", "technicien", "genmaint"], excludeUserId: me.id, tag: `travail-a-faire-${input.machineNo}`, title: `Travail à effectuer — M/C ${input.machineNo}`, body: `${input.title} — ajouté par ${me.displayName}` });
      return ok();
    }
    case "workDone": {
      if (!need("works")) return deny("Tu n'as pas le droit de clôturer un travail.");
      const work = await db.selectFrom("works").select(["machineNo", "title", "status"]).where("id", "=", input.id).executeTakeFirst();
      if (!work) return ok("Ce travail a été supprimé entre-temps.");
      if (work.status === "done") return ok();
      await db.updateTable("works").set({ status: "done", doneByName: me.displayName, doneAt: now }).where("id", "=", input.id).execute();
      await notifyRoles({ jobRoles: ["superviseur", "technicien", "genmaint"], excludeUserId: me.id, tag: `travail-termine-${input.id}`, title: `Travail terminé — M/C ${work.machineNo}`, body: `${work.title} — clôturé par ${me.displayName}` });
      return ok();
    }
    case "faultAdd": {
      if (!need("faultReport")) return deny("Tu n'as pas le droit de signaler une panne.");
      await db.insertInto("failures").values({ id: nanoid(), machineId: machineId(input.machineNo), issue: input.issue, notes: input.notes, severity: input.severity, status: "ouverte", reportedBy: me.displayName, stoppedAt: input.stoppedAt, openedAt: now }).execute();
      try { await notifyFault({ machineNo: input.machineNo, issue: input.issue, notes: input.notes, severity: input.severity, reportedBy: me.displayName, stoppedAt: input.stoppedAt }); } catch (e) { console.error("Alerte panne non envoyée:", e); }
      return ok();
    }
    case "faultFix": {
      if (!need("faults")) return deny("Tu n'as pas le droit de clôturer une panne.");
      const fault = await db.selectFrom("failures").select(["machineId", "issue", "status"]).where("id", "=", input.id).executeTakeFirst();
      if (!fault) return ok("Cette panne a été supprimée entre-temps.");
      if (fault.status === "resolue") return ok("Cette panne avait déjà été réglée par un collègue.");
      await db.updateTable("failures").set({ status: "resolue", resolvedAt: now, restartedAt: input.restartedAt, technician: me.displayName, fixedBy: me.displayName, notes: input.fix ? input.fix : undefined }).where("id", "=", input.id).execute();
      const no = Number(fault.machineId.replace(/\D/g, "")) || 0;
      // Pièces utilisées pour la réparation : sorties du magasin liées à la panne et à la machine.
      const warnings: string[] = [];
      if (input.parts?.length && need("stock")) {
        for (const p of input.parts) {
          const w = await takeOut(me, now, p.itemId, p.quantity, no || null, input.id, `Réparation : ${fault.issue}`);
          if (w) warnings.push(w);
        }
      }
      await notifyRoles({ jobRoles: ["superviseur", "prodsup", "prodman"], excludeUserId: me.id, tag: `regle-${input.id}`, title: `Panne réglée — M/C ${no}`, body: `${fault.issue} — réglée par ${me.displayName}` });
      return ok(warnings.join(" ") || undefined);
    }
    case "cycleDate": {
      const perm: Perm = input.kind === "sched" ? "works" : "grease";
      if (!need(perm)) return deny("Tu n'as pas le droit de modifier cette date.");
      const allKeys = await cycleKeys(input.kind);
      if (!allKeys.includes(input.pointKey)) return deny("Point inconnu.", 400);
      if (input.date > iso(new Date(Date.now() + 86400000))) return deny("La date ne peut pas être dans le futur.", 400);
      const last = await db.selectFrom("greasingRecords").select("id").where("kind", "=", input.kind).where("machineNo", "=", input.machineNo).where("pointKey", "=", input.pointKey).orderBy("doneOn", "desc").orderBy("createdAt", "desc").limit(1).executeTakeFirst();
      if (last) await db.updateTable("greasingRecords").set({ doneOn: input.date, authorId: me.id, authorName: me.displayName }).where("id", "=", last.id).execute();
      else await db.insertInto("greasingRecords").values({ id: nanoid(), machineNo: input.machineNo, kind: input.kind, pointKey: input.pointKey, doneOn: input.date, authorId: me.id, authorName: me.displayName }).execute();
      return ok("Date enregistrée.");
    }
    case "cyclePointAdd": {
      const perm: Perm = input.kind === "sched" ? "works" : "grease";
      if (!need(perm)) return deny("Tu n'as pas le droit d'ajouter ce type d'opération.");
      const baseKeys = staticKeys(input.kind);
      let key = input.name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "").slice(0, 30);
      if (!key) key = `x${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "z")}`;
      if (baseKeys.includes(key)) return deny("Ce type existe déjà.", 400);
      const dup = await db.selectFrom("g37CyclePoints").select("id").where("kind", "=", input.kind).where("pointKey", "=", key).executeTakeFirst();
      if (dup) return deny("Ce type existe déjà.", 400);
      await db.insertInto("g37CyclePoints").values({ id: nanoid(), kind: input.kind, pointKey: key, name: input.name, intervalDays: input.days, createdBy: me.displayName }).execute();
      return ok("Type ajouté.");
    }
    case "cyclePointEdit":
    case "cyclePointDelete": {
      const row = await db.selectFrom("g37CyclePoints").select(["id", "kind"]).where("id", "=", input.id).executeTakeFirst();
      if (!row) return deny("Type introuvable.", 404);
      const perm: Perm = row.kind === "sched" ? "works" : "grease";
      if (!need(perm)) return deny("Tu n'as pas le droit de modifier ce type d'opération.");
      if (input.action === "cyclePointEdit") { await db.updateTable("g37CyclePoints").set({ name: input.name, intervalDays: input.days }).where("id", "=", row.id).execute(); return ok("Type modifié."); }
      await db.deleteFrom("g37CyclePoints").where("id", "=", row.id).execute();
      return ok("Type supprimé.");
    }
    case "cycle": {
      const perm: Perm = input.kind === "sched" ? "works" : "grease";
      if (!need(perm)) return deny(input.kind === "sched" ? "Tu n'as pas le droit d'enregistrer les travaux planifiés." : "Seuls l'admin, le superviseur, le technicien et l'opérateur graissage enregistrent le graissage.");
      if (input.to < input.from) return deny("Plage de machines invalide.", 400);
      const allKeys = await cycleKeys(input.kind);
      const points = input.pointKey === "__all" ? allKeys : [input.pointKey];
      if (!points.length || !points.every((p) => allKeys.includes(p))) return deny("Point inconnu.", 400);
      const day = iso(new Date(now.getTime() + 3600000));
      const rows = [];
      for (let n = input.from; n <= input.to; n++) for (const p of points) rows.push({ id: nanoid(), machineNo: n, kind: input.kind, pointKey: p, doneOn: day, authorId: me.id, authorName: me.displayName, createdAt: now });
      if (rows.length) await db.insertInto("greasingRecords").values(rows).execute();
      return ok(`${rows.length} opération(s) enregistrée(s).`);
    }
    case "maintPlan": {
      if (!need("maint")) return deny("Seuls l'admin, le superviseur, le technicien et le responsable maintenance planifient les visites.");
      await db.updateTable("machines").set({ nextMaintenance: input.next, maintPlannedBy: null, maintPlannedAt: null, maintPlanNote: null }).where("id", "=", machineId(input.machineNo)).execute();
      return ok();
    }
    case "maintSchedule": {
      // Le superviseur programme, la veille, les métiers qui passent en maintenance (27/10/2026).
      if (!g37.canScheduleMaint(me)) return deny("Seul le superviseur programme la maintenance depuis l'accueil.");
      const list = [...new Set(input.machines)].sort((a, b) => a - b);
      const day = new Date(`${input.day}T00:00:00Z`);
      const note = input.note?.trim() || null;
      for (const no of list) {
        await db.updateTable("machines").set({ nextMaintenance: day, maintPlannedBy: me.displayName, maintPlannedAt: now, maintPlanNote: note }).where("id", "=", machineId(no)).execute();
      }
      const when = day.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
      const mcs = list.map((n) => `M/C ${n}`).join(", ");
      await notifyRoles({ jobRoles: ["technicien", "shift", "genmaint", "superviseur", "manager"], excludeUserId: me.id, tag: `maint-prog-${input.day}`,
        title: `Maintenance programmée — ${when}`, body: `${mcs}${note ? ` — ${note}` : ""} (par ${me.displayName})`, data: { tab: "maintenance" } });
      return ok(`${list.length} métier${list.length > 1 ? "s" : ""} programmé${list.length > 1 ? "s" : ""} pour ${when}.`);
    }
    case "maintDone": {
      if (!need("maint")) return deny("Tu n'as pas le droit de valider une maintenance.");
      const next = new Date(now.getTime() + 30 * 86400000);
      const recordId = nanoid();
      const cl = input.checklist;
      const doneCount = cl ? cl.items.filter((i) => i.done).length : 0;
      const summary = cl ? `Check-list : ${doneCount}/${cl.items.length} étape(s) faite(s)${cl.notes?.trim() ? ` — ${cl.notes.trim()}` : ""}` : null;
      await db.insertInto("maintenanceRecords").values({ id: recordId, machineId: machineId(input.machineNo), maintenanceType: "Visite périodique", performedAt: now, nextDue: next, technician: me.displayName, notes: summary }).execute();
      await db.updateTable("machines").set({ lastMaintenance: now, nextMaintenance: next, maintPlannedBy: null, maintPlannedAt: null, maintPlanNote: null }).where("id", "=", machineId(input.machineNo)).execute();
      if (cl) {
        const photo = (k: string | null | undefined) => (k && /^chat\/[\w.\-]+$/.test(k) ? k : null);
        await sql`INSERT INTO maint_checklists (id, machine_no, maintenance_id, done_at, author_name, items, photo_before, photo_after, notes)
          VALUES (${nanoid()}, ${input.machineNo}, ${recordId}, ${now}, ${me.displayName}, ${sql.json(cl.items.map((i) => ({ text: i.text, done: i.done, note: i.note?.trim() || null, extra: !!i.extra })))},
            ${photo(cl.photoBefore)}, ${photo(cl.photoAfter)}, ${cl.notes?.trim() || null})`;
        // Étapes ajoutées pendant la visite : gardées dans le modèle si la personne a le droit de le modifier.
        if (cl.saveExtras && need("specs")) {
          const known = new Set((await sql`SELECT lower(text) AS t FROM checklist_steps`).map((r: any) => r.t));
          const pos = Number((await sql`SELECT COALESCE(max(position), 0) AS p FROM checklist_steps`)[0].p);
          let k = 0;
          for (const i of cl.items.filter((x) => x.extra && !known.has(x.text.toLowerCase()))) {
            k++;
            await sql`INSERT INTO checklist_steps (id, position, text, created_by) VALUES (${nanoid()}, ${pos + k * 10}, ${i.text}, ${me.displayName})`;
          }
        }
        if (doneCount < cl.items.length) {
          await notifyRoles({ jobRoles: ["superviseur", "genmaint", "forman"], excludeUserId: me.id, tag: `checklist-${input.machineNo}`, title: `Maintenance M/C ${input.machineNo} incomplète`,
            body: `${cl.items.length - doneCount} étape(s) non faite(s) — ${me.displayName}`, data: { tab: "maintenance" } });
        }
      }
      return ok(cl ? `Maintenance de la M/C ${input.machineNo} enregistrée (${doneCount}/${cl.items.length}).` : undefined);
    }
    case "stockQty": {
      if (!need("stock")) return deny("Tu n'as pas le droit de modifier le magasin.");
      const before = await db.selectFrom("stockItems").select(["name", "quantity", "minimumQuantity"]).where("id", "=", input.id).executeTakeFirst();
      if (!before) return ok("Cet article a été supprimé entre-temps.");
      const current = Number(before.quantity);
      const newQty = input.baseQuantity != null ? Math.max(0, current + (input.quantity - input.baseQuantity)) : input.quantity;
      await db.updateTable("stockItems").set({ quantity: newQty, updatedAt: now }).where("id", "=", input.id).execute();
      await db.insertInto("stockMovements").values({ id: nanoid(), itemId: input.id, movementType: "correction", quantity: newQty, createdAt: now,
        reason: input.baseQuantity != null && input.baseQuantity !== current ? `Inventaire par ${me.displayName} (hors ligne : ${input.baseQuantity} → ${input.quantity})` : `Inventaire par ${me.displayName}` }).execute();
      const min = Number(before.minimumQuantity) || g37.STOCK_ALERT;
      if (current >= min && newQty < min) await notifyRoles({ jobRoles: ["superviseur", "technicien", "shift"], excludeUserId: me.id, tag: `stock-${input.id}`, title: "Stock sous le seuil", body: `${before.name} : ${newQty} restant(s) (seuil ${min})` });
      return ok();
    }
    case "stockAdd": {
      if (!need("stockManage")) return deny("Seuls l'admin et le superviseur ajoutent du matériel au magasin.");
      const id = nanoid();
      await db.insertInto("stockItems").values({ id, name: input.name, category: input.category, unit: input.unit, quantity: input.quantity, minimumQuantity: input.minimumQuantity, unitPrice: input.unitPrice ?? null, leadDays: input.leadDays ?? 14 }).execute();
      await db.insertInto("stockMovements").values({ id: nanoid(), itemId: id, movementType: "entrée", quantity: input.quantity, reason: `Création par ${me.displayName}`, authorName: me.displayName }).execute();
      if (input.quantity < input.minimumQuantity) await notifyRoles({ jobRoles: ["superviseur", "technicien", "shift"], excludeUserId: me.id, tag: `stock-${id}`, title: "Stock sous le seuil", body: `${input.name} : ${input.quantity} (seuil ${input.minimumQuantity})` });
      return ok(`« ${input.name} » ajouté au magasin.`);
    }
    case "stockEdit": {
      if (!need("stockManage")) return deny("Seuls l'admin et le superviseur modifient le matériel du magasin.");
      const cur = await db.selectFrom("stockItems").select(["quantity", "minimumQuantity"]).where("id", "=", input.id).executeTakeFirst();
      if (!cur) return deny("Article introuvable.", 404);
      await db.updateTable("stockItems").set({ name: input.name, category: input.category, unit: input.unit, minimumQuantity: input.minimumQuantity, updatedAt: now,
        ...(input.unitPrice !== undefined ? { unitPrice: input.unitPrice } : {}), ...(input.leadDays !== undefined ? { leadDays: input.leadDays } : {}) }).where("id", "=", input.id).execute();
      const qty = Number(cur.quantity);
      if (qty < input.minimumQuantity && qty >= (Number(cur.minimumQuantity) || 0)) await notifyRoles({ jobRoles: ["superviseur", "technicien", "shift"], excludeUserId: me.id, tag: `stock-${input.id}`, title: "Stock sous le seuil", body: `${input.name} : ${qty} restant(s) (seuil ${input.minimumQuantity})` });
      return ok("Article modifié.");
    }
    case "stockDelete": {
      if (!need("stockManage")) return deny("Seuls l'admin et le superviseur suppriment du matériel.");
      const cur = await db.selectFrom("stockItems").select("name").where("id", "=", input.id).executeTakeFirst();
      if (!cur) return ok();
      await db.deleteFrom("stockMovements").where("itemId", "=", input.id).execute();
      await db.deleteFrom("stockItems").where("id", "=", input.id).execute();
      return ok(`« ${cur.name} » supprimé du magasin.`);
    }
    case "stockOut": {
      if (!need("stock")) return deny("Tu n'as pas le droit de sortir des pièces du magasin.");
      const w = await takeOut(me, now, input.itemId, input.quantity, input.machineNo, input.failureId ?? null, input.note ?? null);
      return ok(w ?? undefined);
    }
    case "stockIn": {
      if (!need("stock")) return deny("Tu n'as pas le droit d'enregistrer une arrivée au magasin.");
      const item = await db.selectFrom("stockItems").select(["name", "quantity"]).where("id", "=", input.itemId).executeTakeFirst();
      if (!item) return ok("Cet article a été supprimé entre-temps.");
      await db.updateTable("stockItems").set({ quantity: Number(item.quantity) + input.quantity, updatedAt: now }).where("id", "=", input.itemId).execute();
      await db.insertInto("stockMovements").values({ id: nanoid(), itemId: input.itemId, movementType: "entrée", quantity: input.quantity, createdAt: now, authorName: me.displayName, reason: input.note?.trim() || `Arrivée enregistrée par ${me.displayName}` }).execute();
      return ok(`${item.name} : +${input.quantity} enregistré.`);
    }
    case "checklistStepAdd": {
      if (!need("specs")) return deny("Seuls l'admin, le superviseur, le manager et le Boss modifient la check-list.");
      const pos = Number((await sql`SELECT COALESCE(max(position), 0) AS p FROM checklist_steps`)[0].p);
      await sql`INSERT INTO checklist_steps (id, position, text, created_by) VALUES (${nanoid()}, ${pos + 10}, ${input.text}, ${me.displayName})`;
      return ok("Étape ajoutée.");
    }
    case "checklistStepEdit": {
      if (!need("specs")) return deny("Seuls l'admin, le superviseur, le manager et le Boss modifient la check-list.");
      await sql`UPDATE checklist_steps SET text = ${input.text}, created_by = ${me.displayName}, updated_at = now() WHERE id = ${input.id}`;
      return ok("Étape modifiée.");
    }
    case "checklistStepDelete": {
      if (!need("specs")) return deny("Seuls l'admin, le superviseur, le manager et le Boss modifient la check-list.");
      await sql`DELETE FROM checklist_steps WHERE id = ${input.id}`;
      return ok("Étape retirée.");
    }
    case "checklistStepMove": {
      if (!need("specs")) return deny("Seuls l'admin, le superviseur, le manager et le Boss modifient la check-list.");
      const steps = await sql`SELECT id, position FROM checklist_steps ORDER BY position, id`;
      const i = steps.findIndex((s: any) => s.id === input.id);
      const j = input.dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= steps.length) return ok();
      const order = steps.map((s: any) => s.id);
      [order[i], order[j]] = [order[j], order[i]];
      for (let k = 0; k < order.length; k++) await sql`UPDATE checklist_steps SET position = ${(k + 1) * 10} WHERE id = ${order[k]}`;
      return ok();
    }
    case "shiftSet": {
      if (!need("shifts")) return deny("Seuls l'admin et le superviseur modifient le planning des quarts.");
      const dayDate = new Date(input.day + "T00:00:00Z");
      if (input.shiftCode === "") { await db.deleteFrom("shiftPlan").where("day", "=", dayDate).where("team", "=", input.team).execute(); return ok(); }
      await db.insertInto("shiftPlan").values({ id: `${input.day}-${input.team}`, day: dayDate, team: input.team, shiftCode: input.shiftCode, updatedBy: me.displayName })
        .onConflict((oc: any) => oc.columns(["day", "team"]).doUpdateSet({ shiftCode: input.shiftCode, updatedBy: me.displayName, updatedAt: now })).execute();
      return ok();
    }
    case "shiftRotate": {
      if (!need("shifts")) return deny("Seuls l'admin et le superviseur modifient le planning des quarts.");
      const [y, m] = input.month.split("-").map(Number);
      const days = new Date(y, m, 0).getDate();
      const order = ["m", "s", "n"];
      const rows: Array<{ id: string; day: Date; team: string; shiftCode: string; updatedBy: string }> = [];
      for (let d = 1; d <= days; d++) {
        const dayStr = `${input.month}-${String(d).padStart(2, "0")}`;
        const w = Math.floor((d - 1) / 7);
        g37.TEAMS.forEach((t, i) => rows.push({ id: `${dayStr}-${t}`, day: new Date(dayStr + "T00:00:00Z"), team: t, shiftCode: order[(w + i) % 3], updatedBy: me.displayName }));
      }
      await db.insertInto("shiftPlan").values(rows).onConflict((oc: any) => oc.columns(["day", "team"]).doUpdateSet((eb: any) => ({ shiftCode: eb.ref("excluded.shiftCode"), updatedBy: me.displayName, updatedAt: now }))).execute();
      return ok("Rotation appliquée — ajuste les repos à la main.");
    }
    case "eff": {
      if (!need("eff")) return deny("Tu n'as pas le droit de saisir l'efficacité.");
      await db.insertInto("machineEfficiency").values({ id: `${input.machineNo}-${input.month}`, machineNo: input.machineNo, month: input.month, value: input.value, authorName: me.displayName })
        .onConflict((oc: any) => oc.columns(["machineNo", "month"]).doUpdateSet({ value: input.value, authorName: me.displayName, updatedAt: now })).execute();
      return ok();
    }
    case "specsSet": {
      if (!need("specs")) return deny("Seuls l'admin et le superviseur modifient les réglages d'un groupe.");
      await db.insertInto("groupSpecs").values({ groupId: input.groupId, fields: input.fields, updatedBy: me.displayName })
        .onConflict((oc: any) => oc.column("groupId").doUpdateSet({ fields: input.fields, updatedBy: me.displayName, updatedAt: now })).execute();
      return ok();
    }
    case "specsReset": {
      if (!need("specs")) return deny("Seuls l'admin et le superviseur modifient les réglages d'un groupe.");
      await db.deleteFrom("groupSpecs").where("groupId", "=", input.groupId).execute();
      return ok();
    }
    case "chat": {
      if (!need("forum")) return deny("Tu n'as pas le droit de publier dans la discussion.");
      const text = input.message.trim();
      const file = input.file ?? null;
      if (!text && !file) return deny("Écris un message ou joins un fichier.", 400);
      if (file && !file.key.startsWith("chat/")) return deny("Fichier invalide.", 400);
      const msgId = input.clientId ?? nanoid();
      const exists = await db.selectFrom("chatMessages").select("id").where("id", "=", msgId).executeTakeFirst();
      if (exists) return ok();
      const typedMentionIds = await userIdsMentionedInText(text);
      const mentionUserIds = [...new Set([...typedMentionIds, ...(input.mentionUserIds ?? []).filter((id) => Number.isInteger(id))])];
      let knownMentions = mentionUserIds;
      if (mentionUserIds.length) {
        const known = await db.selectFrom("users").select("id").where("id", "in", mentionUserIds).execute();
        knownMentions = known.map((k: any) => k.id);
      }
      let replyToAuthor: string | null = null;
      let replyToMessage: string | null = null;
      let replyToId = input.replyToId ?? null;
      if (replyToId) {
        const reply = await db.selectFrom("chatMessages").select(["id", "author", "message"]).where("id", "=", replyToId).executeTakeFirst();
        if (reply) { replyToAuthor = reply.author; replyToMessage = reply.message.slice(0, 500); } else replyToId = null;
      }
      await db.insertInto("chatMessages").values({ id: msgId, author: me.displayName, message: text, createdAt: now, fileKey: file?.key ?? null, fileName: file?.name ?? null, fileType: file?.type ?? null, fileSize: file?.size ?? null, replyToId, replyToAuthor, replyToMessage, mentionUserIds: knownMentions }).execute();
      const forumRoles = Object.entries(g37.ROLES).filter(([, r]) => r.p.includes("forum")).map(([k]) => k);
      await notifyRoles({ jobRoles: forumRoles, excludeUserId: me.id, tag: "discussion", kind: "chat", data: { tab: "discussion" }, title: `Maintenance R/F · ${me.displayName}`, body: text ? text.slice(0, 120) : `📎 ${file?.name ?? "fichier"}` });
      if (knownMentions.length) await notifyUsers({ userIds: knownMentions, excludeUserId: me.id, kind: "chat", data: { tab: "discussion" }, tag: `mention-${knownMentions.join("-")}`, title: `${me.displayName} t'a mentionné dans Maintenance R/F`, body: text ? text.slice(0, 120) : `📎 ${file?.name ?? "fichier"}` });
      return ok();
    }
    case "chatDelete": {
      const msg = await db.selectFrom("chatMessages").select(["author", "fileKey"]).where("id", "=", input.id).executeTakeFirst();
      if (!msg) return ok();
      if (msg.author !== me.displayName && !need("chatModerate")) return deny("Tu ne peux supprimer que tes propres messages.");
      await db.deleteFrom("chatMessages").where("id", "=", input.id).execute();
      if (msg.fileKey && msg.fileKey.startsWith("chat/")) {
        const { error } = await supa.storage.from(BUCKET_CHAT).remove([msg.fileKey]);
        if (error) console.error("Fichier de discussion non supprimé:", error.message);
      }
      return ok("Message supprimé.");
    }
    case "passwordResetAdmin": {
      if (!need("roles") || me.id !== g37.OWNER_USER_ID) return deny("Seul l'admin peut réinitialiser un mot de passe.");
      if (input.userId === me.id) return deny("Pour ton propre compte, utilise la procédure de récupération.");
      const target = await db.selectFrom("users").select(["id", "displayName", "role"]).where("id", "=", input.userId).executeTakeFirst();
      if (!target) return deny("Compte introuvable.", 404);
      if (target.role === "admin") return deny("Le mot de passe d'un administrateur ne peut pas être réinitialisé ici.", 400);
      const temporaryPassword = `G37-${nanoid(10)}`;
      const passwordHash = await hash(temporaryPassword, 10);
      await db.updateTable("userPasswords").set({ passwordHash, createdAt: now }).where("userId", "=", input.userId).execute();
      await db.deleteFrom("appSessions").where("userId", "=", input.userId).execute();
      return ok(`Compte de ${target.displayName} réinitialisé. Mot de passe temporaire : ${temporaryPassword}`);
    }
    case "grade": {
      if (!need("roles") || me.id !== g37.OWNER_USER_ID) return deny("Seul l'admin change les grades.");
      if (!g37.ROLES[input.jobRole]) return deny("Poste inconnu.", 400);
      await db.updateTable("users").set({ jobRole: input.jobRole, team: input.team, pending: input.pending, updatedAt: now }).where("id", "=", input.userId).execute();
      return ok();
    }
    case "deleteUser": {
      if (!need("roles") || me.id !== g37.OWNER_USER_ID) return deny("Seul l'admin supprime un compte.");
      if (input.userId === me.id) return deny("Tu ne peux pas supprimer ton propre compte.", 400);
      const target = await db.selectFrom("users").select(["id", "role", "displayName"]).where("id", "=", input.userId).executeTakeFirst();
      if (!target) return ok();
      if (target.role === "admin") return deny("Un compte administrateur ne peut pas être supprimé ici.", 400);
      await db.deleteFrom("appSessions").where("userId", "=", input.userId).execute();
      await db.deleteFrom("userPasswords").where("userId", "=", input.userId).execute();
      await db.deleteFrom("users").where("id", "=", input.userId).execute();
      return ok(`Compte de ${target.displayName} supprimé.`);
    }
    case "dm": {
      if (me.pending) return deny("Ton compte doit être validé par l'admin avant d'écrire en privé.");
      if (!g37.canChat(me)) return deny("Les messages ne sont pas disponibles pour ton poste.");
      if (input.to === me.id) return deny("Destinataire invalide.", 400);
      // Photos et notes vocales courtes incluses dans le message chiffré (envoi possible sans Internet).
      if (JSON.stringify(input.envelope).length > 200000) return deny("Message trop long.", 400);
      const target = await db.selectFrom("users").select(["id", "jobRole"]).where("id", "=", input.to).executeTakeFirst();
      if (!target) return deny("Collègue introuvable.", 404);
      if (!g37.canChat(target)) return deny("Ce collègue ne reçoit pas de messages.", 403);
      const inserted = await sql`INSERT INTO dm_messages (id, from_user, to_user, envelope, created_at)
        VALUES (${input.id}, ${me.id}, ${input.to}, ${sql.json(input.envelope)}, ${now}) ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (inserted.length) await broadcastTo(await callTopic(input.to), "dm", { from: me.id, id: input.id });
      if (inserted.length) await notifyUsers({ userIds: [input.to], tag: `dm-${me.id}`, title: `Message de ${me.displayName}`, body: "Nouveau message privé", kind: "dm", data: { tab: "discussion", peer: me.id } });
      return ok();
    }
    case "profileInfo": {
      const first = input.firstName.trim();
      const last = input.lastName.trim();
      const set: Record<string, unknown> = { firstName: first || null, lastName: last || null, postTitle: input.postTitle.trim() || null, updatedAt: now };
      const full = [first, last].filter(Boolean).join(" ");
      if (full) set.displayName = full.slice(0, 120);
      if (input.avatarKey !== undefined) {
        if (input.avatarKey === null) set.avatarUrl = null;
        else {
          if (!input.avatarKey.startsWith(`u${me.id}/`)) return deny("Photo invalide.", 400);
          set.avatarUrl = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/avatars/${input.avatarKey}`;
        }
      }
      await db.updateTable("users").set(set).where("id", "=", me.id).execute();
      return ok("Profil enregistré.");
    }
    case "profile": {
      const role = g37.ROLES[input.jobRole];
      if (!role) return deny("Poste inconnu.", 400);
      if (input.jobRole === "admin") return deny("Le poste d'admin ne s'attribue pas soi-même.");
      if (role.code && (input.code ?? "").trim().toUpperCase() !== g37.ACCESS_CODE) return deny("Code d'habilitation incorrect. Demande-le à l'admin.", 400);
      await db.updateTable("users").set({ jobRole: input.jobRole, pending: me.role === "admin" ? false : !!role.code, updatedAt: now }).where("id", "=", me.id).execute();
      return ok(role.code && me.role !== "admin" ? "Ton accès doit être validé par l'admin." : undefined);
    }
  }
}

function clampClientDate(raw: unknown): Date {
  const serverNow = Date.now();
  const t = raw ? new Date(raw as string).getTime() : NaN;
  if (!Number.isFinite(t)) return new Date(serverNow);
  return new Date(Math.min(serverNow, Math.max(serverNow - 60 * 86400000, t)));
}

export async function applyOnce(me: Me, opId: string | null, rawInput: unknown, clientAt: unknown): Promise<MutationResult & { opId?: string | null }> {
  if (opId) {
    const done = await db.selectFrom("syncOps").select(["ok", "result"]).where("opId", "=", opId).executeTakeFirst();
    if (done) return { opId, ...(done.result as MutationResult) };
  }
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    const r: MutationResult = { status: 400, error: parsed.error.issues[0]?.message ?? "Requête invalide" };
    if (opId) await db.insertInto("syncOps").values({ opId, userId: me.id, action: "invalid", ok: false, result: r }).onConflict((oc: any) => oc.column("opId").doNothing()).execute();
    return { opId, ...r };
  }
  const now = clampClientDate(clientAt);
  let result: MutationResult;
  try {
    result = await applyMutation(me, parsed.data, now);
  } catch (error) {
    return { opId, status: 500, error: error instanceof Error ? error.message : "Enregistrement impossible" };
  }
  if (opId) await db.insertInto("syncOps").values({ opId, userId: me.id, action: parsed.data.action, clientCreatedAt: now, ok: result.status < 400, result }).onConflict((oc: any) => oc.column("opId").doNothing()).execute();
  return { opId, ...result };
}

export async function handleMutate(request: Request): Promise<Response> {
  let me: Me | null;
  try {
    const { user } = await getServerUserSession(request);
    me = await loadMe(user.id);
    if (!me) return sj({ error: "Compte introuvable" }, 401);
  } catch {
    return sj({ error: "Authentification requise" }, 401);
  }
  let body: any;
  try { body = await readSuperjson(request); } catch { return sj({ error: "Requête invalide" }, 400); }
  const wrapped = body && typeof body === "object" && "input" in body && !("action" in body);
  const res = await applyOnce(me, wrapped ? String(body.opId ?? "") || null : null, wrapped ? body.input : body, wrapped ? body.clientAt : null);
  if (res.status < 400) await broadcastChanged();
  if (res.status >= 400) return sj({ error: res.error }, res.status);
  return sj({ success: true, message: res.message });
}

export async function handleSync(request: Request): Promise<Response> {
  let me: Me | null;
  try {
    const { user } = await getServerUserSession(request);
    me = await loadMe(user.id);
    if (!me) return sj({ error: "Compte introuvable" }, 401);
  } catch {
    return sj({ error: "Authentification requise" }, 401);
  }
  let body: any;
  try { body = await readSuperjson(request); } catch { return sj({ error: "Requête invalide" }, 400); }
  const ops: Array<{ opId: string; clientAt?: string; input: unknown }> = Array.isArray(body?.ops) ? body.ops.slice(0, 200) : [];
  const results: Array<{ opId: string; ok: boolean; retry: boolean; message?: string; error?: string }> = [];
  let changed = false;
  for (const op of ops) {
    if (!op?.opId) continue;
    const r = await applyOnce(me, String(op.opId).slice(0, 80), op.input, op.clientAt);
    if (r.status < 400) changed = true;
    results.push({ opId: op.opId, ok: r.status < 400, retry: r.status >= 500, message: r.message, error: r.error });
    if (r.status >= 500) break;
  }
  if (changed) await broadcastChanged();
  return sj({ results });
}
