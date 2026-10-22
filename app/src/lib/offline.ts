import superjson from "superjson";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { g37 } from "../helpers/g37";
import { isOnline } from "./net";

// ---------------------------------------------------------------------------
// Mode hors ligne
// 1. Les données de l'atelier sont gardées sur le téléphone (dernier chargement réussi).
// 2. Chaque action est mise en file d'attente avec un identifiant unique et la date réelle de saisie,
//    puis appliquée tout de suite à l'écran.
// 3. Dès que le réseau revient, la file est envoyée dans l'ordre au serveur, qui n'applique jamais
//    deux fois la même action (même si l'envoi est répété après une coupure).
// ---------------------------------------------------------------------------

const STATE_KEY = "g37.state";
const OUTBOX_KEY = "g37.outbox";
const RELAY_KEY = "g37.relay";

// signed : copie signée par ce téléphone, pour qu'un collègue puisse la porter au serveur (mode sans Internet).
export type Op = { opId: string; clientAt: string; input: InputType; tries?: number; signed?: { payload: string; sig: string } };
export type SyncResult = { sent: number; messages: string[]; errors: string[] };

type Listener = () => void;
const listeners = new Set<Listener>();
export function onOutboxChange(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const emit = () => listeners.forEach((l) => l());

export function newId(prefix = "op") {
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  return `${prefix}_${Date.now().toString(36)}_${[...rnd].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14)}`;
}

// ---- Données gardées sur le téléphone ----
export function loadCachedState(): State | undefined {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? superjson.parse<State>(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function saveCachedState(state: State) {
  try {
    localStorage.setItem(STATE_KEY, superjson.stringify(state));
  } catch (e) {
    console.warn("Données non gardées sur le téléphone :", e);
  }
}

// ---- File d'attente ----
export function outbox(): Op[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    return raw ? superjson.parse<Op[]>(raw) : [];
  } catch {
    return [];
  }
}

function setOutbox(ops: Op[]) {
  localStorage.setItem(OUTBOX_KEY, superjson.stringify(ops));
  emit();
}

// Ajoute les signatures calculées (sans toucher aux actions ajoutées entre-temps).
export function setOutboxSignatures(sigs: Map<string, { payload: string; sig: string }>) {
  if (!sigs.size) return;
  setOutbox(outbox().map((o) => (sigs.has(o.opId) ? { ...o, signed: sigs.get(o.opId) } : o)));
}

// Actions déjà appliquées par le serveur (apportées par un collègue) : retirées de la file.
export function dropFromOutbox(ids: Set<string>) {
  const ops = outbox();
  const rest = ops.filter((o) => !ids.has(o.opId));
  if (rest.length !== ops.length) setOutbox(rest);
}

// ---- Actions de collègues portées par ce téléphone (relais sans Internet) ----
export type RelayOp = {
  payload: string; sig: string; opId: string; userId: number; deviceId: string; name: string;
  clientAt: string; input: InputType; verified: boolean; receivedAt: string;
};
const relayListeners = new Set<Listener>();
export function onRelayChange(l: Listener) {
  relayListeners.add(l);
  return () => relayListeners.delete(l);
}
export function relayOps(): RelayOp[] {
  try {
    const raw = localStorage.getItem(RELAY_KEY);
    return raw ? (JSON.parse(raw) as RelayOp[]) : [];
  } catch {
    return [];
  }
}
function setRelay(ops: RelayOp[]) {
  // 30 jours maximum, 1500 actions au plus.
  const limit = Date.now() - 30 * 86400000;
  const kept = ops.filter((o) => new Date(o.receivedAt).getTime() > limit).slice(-1500);
  try {
    localStorage.setItem(RELAY_KEY, JSON.stringify(kept));
  } catch (e) {
    console.warn("Relais non gardé :", e);
  }
  relayListeners.forEach((l) => l());
}
export function addRelayOps(list: RelayOp[]): RelayOp[] {
  if (!list.length) return [];
  const current = relayOps();
  const known = new Set(current.map((o) => o.opId));
  const added = list.filter((o) => !known.has(o.opId));
  if (added.length) setRelay([...current, ...added]);
  return added;
}
export function removeRelayOps(ids: Set<string>) {
  const current = relayOps();
  const rest = current.filter((o) => !ids.has(o.opId));
  if (rest.length !== current.length) setRelay(rest);
}

export function enqueue(input: InputType): Op {
  const op: Op = { opId: newId(), clientAt: new Date().toISOString(), input };
  setOutbox([...outbox(), op]);
  return op;
}

let flushing: Promise<SyncResult> | null = null;

// Envoie la file au serveur. Une action refusée (droits, donnée invalide) est retirée avec un message ;
// une erreur passagère laisse la file intacte pour le prochain essai.
export function flush(): Promise<SyncResult> {
  if (flushing) return flushing;
  flushing = (async () => {
    const result: SyncResult = { sent: 0, messages: [], errors: [] };
    if (!isOnline()) return result;
    for (let round = 0; round < 20; round++) {
      const batch = outbox().slice(0, 50);
      if (!batch.length) break;
      let data: { results: Array<{ opId: string; ok: boolean; retry: boolean; message?: string; error?: string }> };
      try {
        const res = await fetch("/_api/g37/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: superjson.stringify({ ops: batch.map(({ opId, clientAt, input }) => ({ opId, clientAt, input })) }),
        });
        if (!res.ok) break;
        data = superjson.parse(await res.text());
      } catch {
        break;
      }
      const done = new Set<string>();
      let stop = false;
      for (const r of data.results ?? []) {
        if (r.retry) { stop = true; break; }
        done.add(r.opId);
        if (r.ok) {
          result.sent++;
          if (r.message) result.messages.push(r.message);
        } else if (r.error) {
          result.errors.push(r.error);
        }
      }
      if (done.size) setOutbox(outbox().filter((o) => !done.has(o.opId)));
      if (stop || done.size === 0) break;
    }
    return result;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// ---- Application locale (affichage immédiat d'une action pas encore envoyée) ----
type Me = State["me"];
const machineIdOf = (no: number) => "M-" + String(no).padStart(2, "0");
const dayOf = (d: Date) => new Date(d.getTime() + 3600000).toISOString().slice(0, 10);

export function applyLocal(state: State, op: Pick<Op, "opId" | "clientAt" | "input">, actor?: Me): State {
  const s: State = { ...state };
  const input = op.input;
  const now = new Date(op.clientAt);
  const me: Me = actor ?? s.me;
  const need = (p: Parameters<typeof g37.can>[0]) => g37.can(p, me);
  const localId = `local-${op.opId}`;

  switch (input.action) {
    case "machine":
      if (!need("machine")) return state;
      s.machines = s.machines.map((m) => m.no === input.no ? {
        ...m, runG: input.runG, runH: input.runH, status: input.status,
        stopReason: input.status === "service" ? null : input.stopReason,
        stoppedSince: input.status === "service" ? null : input.stoppedSince,
      } : m);
      return s;
    case "gearStock":
      if (!need("gears")) return state;
      s.gears = s.gears.map((g) => g.gearType === input.gearType && g.teeth === input.teeth ? { ...g, stock: input.stock } : g);
      return s;
    case "workAdd":
      if (!need("works")) return state;
      s.works = [{ id: localId, machineNo: input.machineNo, title: input.title, status: input.status, auto: false, authorName: me.displayName, doneByName: null, createdAt: now }, ...s.works];
      return s;
    case "workDone":
      if (!need("works")) return state;
      s.works = s.works.map((w) => w.id === input.id ? { ...w, status: "done", doneByName: me.displayName } : w);
      return s;
    case "faultAdd":
      if (!need("faultReport")) return state;
      s.failures = [{
        id: localId, machineId: machineIdOf(input.machineNo), machineNo: input.machineNo, issue: input.issue, severity: input.severity,
        status: "ouverte", notes: input.notes, technician: null, reportedBy: me.displayName, fixedBy: null,
        openedAt: now, resolvedAt: null, stoppedAt: input.stoppedAt, restartedAt: null,
      }, ...s.failures];
      return s;
    case "faultFix":
      if (!need("faults")) return state;
      s.failures = s.failures.map((f) => f.id === input.id ? { ...f, status: "resolue", resolvedAt: now, restartedAt: input.restartedAt, fixedBy: me.displayName, technician: me.displayName, notes: input.fix ?? f.notes } : f);
      return s;
    case "cycle": {
      if (!(input.kind === "sched" ? need("works") : need("grease"))) return state;
      const keys = input.pointKey === "__all"
        ? [...(input.kind === "grease" ? g37.GREASE_POINTS : input.kind === "lub" ? g37.LUB_BOXES : []).map((p) => p.k), ...s.cyclePoints.filter((p) => p.kind === input.kind).map((p) => p.key)]
        : [input.pointKey];
      const doneOn = new Date(dayOf(now) + "T00:00:00Z");
      const rows: State["greasing"] = [];
      for (let n = input.from; n <= input.to; n++) for (const k of keys) rows.push({ machineNo: n, kind: input.kind, pointKey: k, doneOn, authorName: me.displayName });
      s.greasing = [...rows, ...s.greasing];
      return s;
    }
    case "cycleDate": {
      if (!(input.kind === "sched" ? need("works") : need("grease"))) return state;
      const doneOn = new Date(input.date + "T00:00:00Z");
      let replaced = false;
      s.greasing = s.greasing.map((r) => {
        if (!replaced && r.kind === input.kind && r.machineNo === input.machineNo && r.pointKey === input.pointKey) { replaced = true; return { ...r, doneOn, authorName: me.displayName }; }
        return r;
      });
      if (!replaced) s.greasing = [{ machineNo: input.machineNo, kind: input.kind, pointKey: input.pointKey, doneOn, authorName: me.displayName }, ...s.greasing];
      return s;
    }
    case "maintPlan":
      if (!need("maint")) return state;
      s.machines = s.machines.map((m) => m.no === input.machineNo ? { ...m, nextMaintenance: input.next } : m);
      return s;
    case "maintDone": {
      if (!need("maint")) return state;
      const next = new Date(now.getTime() + 30 * 86400000);
      s.machines = s.machines.map((m) => m.no === input.machineNo ? { ...m, lastMaintenance: now, nextMaintenance: next } : m);
      s.maintenance = [{ id: localId, machineNo: input.machineNo, maintenanceType: "Visite périodique", performedAt: now, nextDue: next, technician: me.displayName, notes: null }, ...s.maintenance];
      return s;
    }
    case "stockQty":
      if (!need("stock")) return state;
      s.stock = s.stock.map((it) => it.id === input.id ? { ...it, quantity: String(input.quantity) } : it);
      return s;
    case "shiftSet": {
      if (!need("shifts")) return state;
      const day = new Date(input.day + "T00:00:00Z");
      const rest = s.shifts.filter((x) => !(new Date(x.day).toISOString().slice(0, 10) === input.day && x.team === input.team));
      s.shifts = input.shiftCode ? [...rest, { day, team: input.team, shiftCode: input.shiftCode }] : rest;
      return s;
    }
    case "eff": {
      if (!need("eff")) return state;
      const rest = s.efficiency.filter((e) => !(e.machineNo === input.machineNo && e.month === input.month));
      s.efficiency = [...rest, { machineNo: input.machineNo, month: input.month, value: String(input.value) }];
      return s;
    }
    case "specsSet":
      if (!need("specs")) return state;
      s.specs = [...s.specs.filter((x) => x.groupId !== input.groupId), { groupId: input.groupId, fields: input.fields, updatedBy: me.displayName }];
      return s;
    case "specsReset":
      if (!need("specs")) return state;
      s.specs = s.specs.filter((x) => x.groupId !== input.groupId);
      return s;
    case "chat":
      if (!need("forum")) return state;
      if (s.chat.some((c) => c.id === input.clientId)) return state;
      s.chat = [{
        id: input.clientId ?? localId, author: me.displayName, message: input.message.trim(), createdAt: now,
        fileName: input.file?.name ?? null, fileType: input.file?.type ?? null, fileSize: input.file?.size ?? null, fileUrl: null,
        replyToId: input.replyToId ?? null, replyToAuthor: null, replyToMessage: null, mentionUserIds: input.mentionUserIds ?? [],
      }, ...s.chat];
      return s;
    case "chatDelete":
      s.chat = s.chat.filter((c) => c.id !== input.id);
      return s;
    case "stockDelete":
      if (!need("stockManage")) return state;
      s.stock = s.stock.filter((x) => x.id !== input.id);
      return s;
    default:
      // Actions d'administration : visibles après la synchronisation.
      return state;
  }
}

// Données du serveur + actions de collègues reçues sans Internet + actions encore en attente sur ce téléphone.
export function withPending(state: State): State {
  const applied = new Set(state.appliedOpIds ?? []);
  const relayed = relayOps()
    .filter((o) => o.verified && !applied.has(o.opId) && o.userId !== state.me.id)
    .sort((a, b) => a.clientAt.localeCompare(b.clientAt));
  let acc = state;
  for (const o of relayed) {
    const u = state.users.find((x) => x.id === o.userId);
    const actor: Me = u ? { ...u } : { ...state.me, id: o.userId, displayName: o.name, role: "user", jobRole: "helper", pending: false };
    acc = applyLocal(acc, o, actor);
  }
  return outbox().filter((o) => !applied.has(o.opId)).reduce((a, op) => applyLocal(a, op), acc);
}
