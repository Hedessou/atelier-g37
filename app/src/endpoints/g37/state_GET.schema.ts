import { z } from "zod";
import superjson from "superjson";

export const schema = z.object({});

export type InputType = z.infer<typeof schema>;

export type G37User = {
  id: number;
  email: string;
  displayName: string;
  role: string;
  jobRole: string;
  team: string | null;
  pending: boolean;
  lastSeen: Date | null;
  firstName?: string | null;
  lastName?: string | null;
  postTitle?: string | null;
  avatarUrl?: string | null;
  lastSyncAt?: Date | null;
};

export type G37Machine = {
  id: string;
  no: number;
  name: string;
  groupId: string | null;
  status: string;
  runG: number | null;
  runH: number | null;
  stopReason: string | null;
  stoppedSince: Date | null;
  lastMaintenance: Date | null;
  nextMaintenance: Date | null;
};

export type G37Gear = { gearType: string; teeth: number; stock: number };

export type G37StockItem = {
  id: string;
  name: string;
  category: string;
  unit: string;
  quantity: string;
  minimumQuantity: string;
  // v1.1 : prix unitaire (F CFA), délai de réapprovisionnement, consommation réelle.
  unitPrice?: string | null;
  leadDays?: number;
  used30?: number;
  perDay?: number;
  daysLeft?: number | null;
};

export type G37StockOut = {
  id: string; itemId: string; itemName: string; unit: string; quantity: number; unitCost: number | null;
  machineNo: number | null; failureId: string | null; authorName: string | null; reason: string | null; createdAt: Date | string;
};
export type G37ChecklistStep = { id: string; position: number; text: string };
export type G37ChecklistItem = { text: string; done: boolean; note?: string | null; extra?: boolean };
export type G37Checklist = {
  id: string; machineNo: number; maintenanceId: string | null; doneAt: Date | string; authorName: string | null;
  items: G37ChecklistItem[]; notes: string | null; photoBeforeUrl: string | null; photoAfterUrl: string | null;
};

export type G37Work = {
  id: string;
  machineNo: number;
  title: string;
  status: string;
  auto: boolean;
  authorName: string | null;
  doneByName: string | null;
  createdAt: Date;
};

export type G37Failure = {
  id: string;
  machineId: string;
  machineNo: number;
  issue: string;
  severity: string;
  status: string;
  notes: string | null;
  technician: string | null;
  reportedBy: string | null;
  fixedBy: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  stoppedAt: Date | null;
  restartedAt: Date | null;
};

export type G37Greasing = {
  machineNo: number;
  kind: string;
  pointKey: string;
  doneOn: Date;
  authorName: string | null;
};

export type G37Shift = { day: Date; team: string; shiftCode: string };
export type G37CyclePoint = { id: string; kind: string; key: string; name: string; days: number };
export type G37Efficiency = { machineNo: number; month: string; value: string };
export type G37Specs = { groupId: string; fields: unknown; updatedBy: string | null };
export type G37Maintenance = {
  id: string; machineNo: number; maintenanceType: string; performedAt: Date;
  nextDue: Date | null; technician: string | null; notes: string | null;
};
export type G37ChatMessage = {
  id: string; author: string; message: string; createdAt: Date;
  fileName: string | null; fileType: string | null; fileSize: number | null; fileUrl: string | null;
  replyToId: string | null; replyToAuthor: string | null; replyToMessage: string | null;
  mentionUserIds: number[];
};

export type OutputType = {
  // Heure du serveur au moment du chargement, et présence du manuel indexé pour l'IA.
  serverTime?: Date;
  lastChangeAt?: Date | string | null;
  manualReady?: boolean;
  me: G37User;
  users: G37User[];
  machines: G37Machine[];
  gears: G37Gear[];
  stock: G37StockItem[];
  works: G37Work[];
  failures: G37Failure[];
  greasing: G37Greasing[];
  cyclePoints: G37CyclePoint[];
  stockNames: string[];
  shifts: G37Shift[];
  efficiency: G37Efficiency[];
  specs: G37Specs[];
  maintenance: G37Maintenance[];
  chat: G37ChatMessage[];
  // Mode sans Internet : clés publiques des téléphones et actions déjà appliquées par le serveur.
  devices?: G37Device[];
  appliedOpIds?: string[];
  // v1.1 : sorties du magasin, check-list de maintenance, équipe en poste.
  stockOuts?: G37StockOut[];
  checklistSteps?: G37ChecklistStep[];
  checklists?: G37Checklist[];
  // team vide = aucune équipe A/B/C planifiée ; general = le General shift (09h–17h) est en poste.
  duty?: { team: string; code: string; general?: boolean } | null;
};

export type G37Device = { deviceId: string; userId: number; signJwk: JsonWebKey; encJwk: JsonWebKey };

// Données + texte exact signé par le serveur (pour pouvoir les transmettre à un collègue sans Internet).
export const getG37SignedState = async (): Promise<{ state: OutputType; text: string; sig: string | null }> => {
  const result = await fetch(`/_api/g37/state`, { method: "GET", headers: { "Content-Type": "application/json" } });
  const text = await result.text();
  if (!result.ok) {
    const errorObject = superjson.parse<{ error: string }>(text);
    throw new Error(errorObject.error);
  }
  return { state: superjson.parse<OutputType>(text), text, sig: result.headers.get("x-g37-sig") };
};

export const getG37State = async (init?: RequestInit): Promise<OutputType> => {
  const result = await fetch(`/_api/g37/state`, {
    method: "GET",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!result.ok) {
    const errorObject = superjson.parse<{ error: string }>(await result.text());
    throw new Error(errorObject.error);
  }
  return superjson.parse<OutputType>(await result.text());
};

