// Types de la base Supabase (mêmes tables que sur Floot, plus les tables de l'app Android).
import type { ColumnType } from "kysely";

export type G37Plan = "day" | "month" | "three_days" | "week";
export type G37SubscriptionStatus = "active" | "pending" | "rejected";
export type G37UsageKind = "ai" | "calc";
export type UserRole = "admin" | "user";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;
export type Json = unknown;
export type Numeric = ColumnType<string, number | string, number | string>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface ChatMessages {
  author: string; createdAt: Generated<Timestamp>; fileKey: string | null; fileName: string | null;
  fileSize: number | null; fileType: string | null; id: string; mentionUserIds: Generated<Json>;
  message: string; replyToAuthor: string | null; replyToId: string | null; replyToMessage: string | null;
}
export interface Failures {
  fixedBy: string | null; id: string; issue: string; machineId: string; notes: Generated<string | null>;
  openedAt: Generated<Timestamp>; reportedBy: string | null; resolvedAt: Timestamp | null;
  restartedAt: Timestamp | null; severity: string; status: Generated<string>; stoppedAt: Timestamp | null;
  technician: Generated<string | null>;
}
export interface G37AiUsage { count: Generated<number>; day: Timestamp; userId: number }
export interface G37CyclePoints {
  createdAt: Generated<Timestamp>; createdBy: string | null; id: string; intervalDays: number;
  kind: string; name: string; pointKey: string;
}
export interface G37ManualChunks {
  content: string; createdAt: Generated<Timestamp>; id: Generated<Int8>; pageEnd: number | null;
  pageNo: number; sourceFileId: string; tsv: Generated<string | null>;
}
export interface G37ManualConfig {
  id: Generated<number>; manualFileKey: string | null; manualFileName: string | null;
  updatedAt: Generated<Timestamp>; updatedBy: string | null;
}
export interface G37Subscriptions {
  amount: number; checkoutId: string | null; checkoutUrl: string | null; createdAt: Generated<Timestamp>;
  decidedAt: Timestamp | null; decidedBy: string | null; endsAt: Timestamp | null; id: Generated<number>;
  payerPhone: string | null; paymentId: string | null; plan: G37Plan; reference: string | null;
  startsAt: Timestamp | null; status: Generated<G37SubscriptionStatus>; userId: number;
}
export interface G37Usage { count: Generated<number>; day: Timestamp; kind: G37UsageKind; userId: number }
export interface Gears {
  gearType: string; id: string; stock: Generated<number>; teeth: number;
  updatedAt: Generated<Timestamp>; updatedBy: string | null;
}
export interface GreasingRecords {
  authorId: number | null; authorName: string | null; createdAt: Generated<Timestamp>; doneOn: Timestamp;
  id: string; kind: string; machineNo: number; pointKey: string;
}
export interface GroupSpecs { fields: Json; groupId: string; updatedAt: Generated<Timestamp>; updatedBy: string | null }
export interface LoginAttempts {
  attemptedAt: Generated<Timestamp | null>; email: string; id: Generated<number>; success: Generated<boolean | null>;
}
export interface LubricationTasks {
  component: string; id: string; intervalDays: number; lastDone: Timestamp | null; lubricant: Generated<string | null>;
  machineId: string | null; nextDue: Timestamp | null; notes: Generated<string | null>;
}
export interface MachineEfficiency {
  authorName: string | null; id: string; machineNo: number; month: string; updatedAt: Generated<Timestamp>; value: Numeric;
}
export interface Machines {
  createdAt: Generated<Timestamp>; groupId: string | null; id: string; lastMaintenance: Timestamp | null;
  machineNo: number | null; name: string; nextMaintenance: Timestamp | null; notes: Generated<string | null>;
  runCount: Numeric | null; runG: number | null; runH: number | null; status: Generated<string>;
  stoppedSince: Timestamp | null; stopReason: string | null;
}
export interface MaintenanceRecords {
  createdAt: Generated<Timestamp>; id: string; machineId: string; maintenanceType: string; nextDue: Timestamp | null;
  notes: Generated<string | null>; performedAt: Timestamp; technician: Generated<string | null>;
}
export interface NotificationLog { createdAt: Generated<Timestamp>; key: string }
export interface ShiftPlan {
  day: Timestamp; id: string; shiftCode: string; team: string; updatedAt: Generated<Timestamp>; updatedBy: string | null;
}
export interface StockItems {
  category: string; id: string; location: Generated<string | null>; minimumQuantity: Generated<Numeric>;
  name: string; quantity: Generated<Numeric>; unit: string; updatedAt: Generated<Timestamp>;
}
export interface StockMovements {
  createdAt: Generated<Timestamp>; id: string; itemId: string; movementType: string; quantity: Numeric;
  reason: Generated<string | null>;
}
export interface UserPasswords { createdAt: Generated<Timestamp | null>; id: Generated<number>; passwordHash: string; userId: number }
export interface Users {
  aiFreeLimit: number | null; avatarUrl: string | null; calcFreeLimit: number | null; createdAt: Generated<Timestamp | null>;
  displayName: string; email: string; id: Generated<number>; jobRole: Generated<string>; lastSeen: Timestamp | null;
  pending: Generated<boolean>; quotaWarnedOn: Timestamp | null; role: Generated<UserRole>; team: string | null;
  updatedAt: Generated<Timestamp | null>;
}
export interface Works {
  authorId: number | null; authorName: string | null; auto: Generated<boolean>; createdAt: Generated<Timestamp>;
  doneByName: string | null; id: string; machineNo: number; status: Generated<string>; title: string;
}
export interface AppSessions {
  tokenHash: string; userId: number; deviceLabel: string | null; createdAt: Generated<Timestamp>;
  lastSeen: Generated<Timestamp>; expiresAt: Timestamp;
}
export interface PushTokens { token: string; userId: number; platform: Generated<string>; createdAt: Generated<Timestamp> }
export interface SyncOps {
  opId: string; userId: number; action: string; clientCreatedAt: Timestamp | null;
  appliedAt: Generated<Timestamp>; ok: Generated<boolean>; result: Json | null;
}
export interface AppConfig { key: string; value: string; updatedAt: Generated<Timestamp> }

export interface DB {
  appConfig: AppConfig;
  appSessions: AppSessions;
  chatMessages: ChatMessages;
  failures: Failures;
  g37AiUsage: G37AiUsage;
  g37CyclePoints: G37CyclePoints;
  g37ManualChunks: G37ManualChunks;
  g37ManualConfig: G37ManualConfig;
  g37Subscriptions: G37Subscriptions;
  g37Usage: G37Usage;
  gears: Gears;
  greasingRecords: GreasingRecords;
  groupSpecs: GroupSpecs;
  loginAttempts: LoginAttempts;
  lubricationTasks: LubricationTasks;
  machineEfficiency: MachineEfficiency;
  machines: Machines;
  maintenanceRecords: MaintenanceRecords;
  notificationLog: NotificationLog;
  pushTokens: PushTokens;
  shiftPlan: ShiftPlan;
  stockItems: StockItems;
  stockMovements: StockMovements;
  syncOps: SyncOps;
  userPasswords: UserPasswords;
  users: Users;
  works: Works;
}
