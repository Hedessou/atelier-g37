import { z } from "zod";
import superjson from "superjson";

export const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("machine"),
    no: z.number().int().min(1).max(28),
    runG: z.number().int().nullable(),
    runH: z.number().int().nullable(),
    status: z.enum(["service", "arret", "maintenance"]),
    stopReason: z.string().max(120).nullable(),
    stoppedSince: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("gearStock"),
    gearType: z.enum(["G", "H"]),
    teeth: z.number().int(),
    stock: z.number().int().min(0).max(100000),
    baseStock: z.number().int().min(0).max(100000).nullable().optional(),
  }),
  z.object({
    action: z.literal("workAdd"),
    machineNo: z.number().int().min(1).max(28),
    title: z.string().min(1).max(300),
    status: z.enum(["todo", "done"]),
  }),
  z.object({ action: z.literal("workDone"), id: z.string().min(1) }),
  z.object({
    action: z.literal("faultAdd"),
    machineNo: z.number().int().min(1).max(28),
    issue: z.string().min(1).max(300),
    notes: z.string().max(2000).nullable(),
    severity: z.enum(["basse", "moyenne", "haute"]),
    stoppedAt: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("faultFix"),
    id: z.string().min(1),
    fix: z.string().max(2000).nullable(),
    restartedAt: z.coerce.date().nullable(),
    parts: z.array(z.object({ itemId: z.string().min(1).max(80), quantity: z.number().positive().max(100000) })).max(10).optional(),
  }),
  z.object({
    action: z.literal("cycle"),
    kind: z.enum(["grease", "lub", "sched"]),
    pointKey: z.string().min(1).max(40),
    from: z.number().int().min(1).max(28),
    to: z.number().int().min(1).max(28),
  }),
  z.object({
    action: z.literal("cycleDate"),
    kind: z.enum(["grease", "lub", "sched"]),
    pointKey: z.string().min(1).max(40),
    machineNo: z.number().int().min(1).max(28),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    action: z.literal("cyclePointAdd"),
    kind: z.enum(["grease", "lub", "sched"]),
    name: z.string().trim().min(1).max(80),
    days: z.number().int().min(1).max(3650),
  }),
  z.object({
    action: z.literal("cyclePointEdit"),
    id: z.string().min(1).max(80),
    name: z.string().trim().min(1).max(80),
    days: z.number().int().min(1).max(3650),
  }),
  z.object({ action: z.literal("cyclePointDelete"), id: z.string().min(1).max(80) }),
  z.object({
    action: z.literal("maintPlan"),
    machineNo: z.number().int().min(1).max(28),
    next: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("maintDone"),
    machineNo: z.number().int().min(1).max(28),
    checklist: z.object({
      items: z.array(z.object({ text: z.string().trim().min(1).max(200), done: z.boolean(), note: z.string().max(300).nullable().optional(), extra: z.boolean().optional() })).max(80),
      photoBefore: z.string().max(300).nullable().optional(),
      photoAfter: z.string().max(300).nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
      saveExtras: z.boolean().optional(),
    }).optional(),
  }),
  z.object({
    action: z.literal("stockOut"),
    itemId: z.string().min(1).max(80),
    quantity: z.number().positive().max(100000),
    machineNo: z.number().int().min(1).max(28).nullable(),
    failureId: z.string().max(80).nullable().optional(),
    note: z.string().max(300).nullable().optional(),
  }),
  z.object({ action: z.literal("stockIn"), itemId: z.string().min(1).max(80), quantity: z.number().positive().max(1000000), note: z.string().max(300).nullable().optional() }),
  z.object({ action: z.literal("checklistStepAdd"), text: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("checklistStepEdit"), id: z.string().min(1).max(80), text: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("checklistStepDelete"), id: z.string().min(1).max(80) }),
  z.object({ action: z.literal("checklistStepMove"), id: z.string().min(1).max(80), dir: z.enum(["up", "down"]) }),
  z.object({ action: z.literal("stockQty"), id: z.string().min(1), quantity: z.number().min(0), baseQuantity: z.number().min(0).nullable().optional() }),
  z.object({
    action: z.literal("stockAdd"),
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60),
    unit: z.string().trim().min(1).max(20),
    quantity: z.number().min(0).max(1000000),
    minimumQuantity: z.number().min(0).max(1000000),
    unitPrice: z.number().min(0).max(1e9).nullable().optional(),
    leadDays: z.number().int().min(1).max(365).optional(),
  }),
  z.object({
    action: z.literal("stockEdit"),
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60),
    unit: z.string().trim().min(1).max(20),
    minimumQuantity: z.number().min(0).max(1000000),
    unitPrice: z.number().min(0).max(1e9).nullable().optional(),
    leadDays: z.number().int().min(1).max(365).optional(),
  }),
  z.object({ action: z.literal("stockDelete"), id: z.string().min(1) }),
  z.object({
    action: z.literal("shiftSet"),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    team: z.enum(["A", "B", "C"]),
    shiftCode: z.enum(["m", "s", "n", "r", ""]),
  }),
  z.object({ action: z.literal("shiftRotate"), month: z.string().regex(/^\d{4}-\d{2}$/) }),
  z.object({
    action: z.literal("eff"),
    machineNo: z.number().int().min(1).max(28),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    value: z.number().min(0).max(100),
  }),
  z.object({ action: z.literal("specsSet"), groupId: z.string().min(1).max(2), fields: z.record(z.string()) }),
  z.object({ action: z.literal("specsReset"), groupId: z.string().min(1).max(2) }),
  z.object({
    action: z.literal("chat"),
    message: z.string().max(2000),
    replyToId: z.string().min(1).max(100).nullable().optional(),
    mentionUserIds: z.array(z.number().int()).max(50).optional(),
    file: z.object({
      key: z.string().min(1).max(300),
      name: z.string().min(1).max(200),
      type: z.string().max(120),
      size: z.number().int().min(0),
    }).nullable().optional(),
    clientId: z.string().min(6).max(40).optional(),
  }),
  z.object({ action: z.literal("chatDelete"), id: z.string().min(1) }),
  z.object({
    action: z.literal("passwordResetAdmin"),
    userId: z.number().int(),
  }),
  z.object({
    action: z.literal("grade"),
    userId: z.number().int(),
    jobRole: z.string().min(1).max(40),
    team: z.string().max(2).nullable(),
    pending: z.boolean(),
  }),
  z.object({ action: z.literal("deleteUser"), userId: z.number().int() }),
  z.object({
    action: z.literal("profile"),
    jobRole: z.string().min(1).max(40),
    code: z.string().max(40).nullable(),
  }),
  // Message privé : contenu chiffré pour les téléphones du destinataire (voir lib/crypto.ts).
  z.object({
    action: z.literal("dm"),
    id: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/),
    to: z.number().int(),
    envelope: z.record(z.any()),
  }),
  // Profil : prénom, nom, poste (texte libre) et photo.
  z.object({
    action: z.literal("profileInfo"),
    firstName: z.string().trim().max(60),
    lastName: z.string().trim().max(60),
    postTitle: z.string().trim().max(80),
    avatarKey: z.string().max(200).nullable().optional(),
  }),
]);

export type InputType = z.infer<typeof schema>;

export type OutputType = { success: true; message?: string };

export const postG37Mutate = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/g37/mutate`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!result.ok) {
    const errorObject = superjson.parse<{ error: string }>(await result.text());
    throw new Error(errorObject.error);
  }
  return superjson.parse<OutputType>(await result.text());
};

