import { db } from "./db.ts";
import { g37 } from "../shared/g37.ts";
import { notifyRoles } from "./notify.ts";

// Alertes d'échéance (maintenance, graissage, lubrification, travaux en attente).
// Lancées toutes les heures par la tâche planifiée de la base, et aussi au chargement de l'app.
// Au plus une vérification toutes les 6 h ; chaque échéance n'est notifiée qu'une fois.

const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const diffDays = (a: string, b: string) =>
  Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400000);
const dueText = (n: number) => (n < 0 ? `retard ${-n} j` : n === 0 ? "aujourd'hui" : `dans ${n} j`);

type MachineRow = { machineNo: number | null; id: string; nextMaintenance: Date | null };
type GreaseRow = { machineNo: number; kind: string; pointKey: string; doneOn: Date };
type WorkRow = { id: string; machineNo: number; title: string; status: string; createdAt: Date };

export async function loadAndRunDueAlerts(): Promise<void> {
  const [machines, greasing, works] = await Promise.all([
    db.selectFrom("machines").select(["id", "machineNo", "nextMaintenance"]).execute(),
    db.selectFrom("greasingRecords").select(["machineNo", "kind", "pointKey", "doneOn"]).orderBy("doneOn", "desc").limit(4000).execute(),
    db.selectFrom("works").select(["id", "machineNo", "title", "status", "createdAt"]).where("status", "=", "todo").execute(),
  ]);
  await runDueAlerts(machines, greasing, works);
}

export async function runDueAlerts(machines: MachineRow[], greasing: GreaseRow[], works: WorkRow[] = []): Promise<void> {
  const now = new Date();
  const today = iso(now);
  const bucketKey = `due-check:${today}:${Math.floor(now.getUTCHours() / 6)}`;

  const done = await db.selectFrom("notificationLog").select("key").where("key", "=", bucketKey).executeTakeFirst();
  if (done) return;
  const claimed = await db.insertInto("notificationLog").values({ key: bucketKey })
    .onConflict((oc) => oc.column("key").doNothing()).executeTakeFirst();
  if (Number(claimed?.numInsertedOrUpdatedRows ?? 0) === 0) return;

  await db.deleteFrom("notificationLog").where("createdAt", "<", new Date(now.getTime() - 120 * 86400000)).execute();

  type Item = { key: string; label: string; days: number };
  const maint: Item[] = [];
  const cycles: Item[] = [];
  const pendingWorks: Item[] = [];

  works.forEach((w) => {
    if (w.status !== "todo") return;
    const ageDays = diffDays(today, iso(w.createdAt));
    if (ageDays < 1) return;
    pendingWorks.push({ key: `work-pending:${w.id}:${today}`, label: `M/C ${w.machineNo} — ${w.title} (en attente depuis ${ageDays} j)`, days: -ageDays });
  });

  machines.forEach((m) => {
    const no = m.machineNo;
    if (!no || !m.nextMaintenance) return;
    const due = iso(m.nextMaintenance);
    const days = diffDays(due, today);
    if (days <= 2) maint.push({ key: `maint:${no}:${due}`, label: `M/C ${no} (${dueText(days)})`, days });
  });

  const seen = new Set<string>();
  const customPoints = await db.selectFrom("g37CyclePoints").select(["kind", "pointKey", "name", "intervalDays"]).execute();
  const customMap = new Map(customPoints.map((c) => [`${c.kind}:${c.pointKey}`, c]));
  greasing.forEach((r) => {
    const k = `${r.kind}:${r.machineNo}:${r.pointKey}`;
    if (seen.has(k)) return;
    seen.add(k);
    const custom = customMap.get(`${r.kind}:${r.pointKey}`);
    if (r.kind === "sched" && !custom) return;
    const due = addDays(iso(r.doneOn), custom ? custom.intervalDays : g37.cycleDays(r.kind, r.pointKey, r.machineNo));
    const days = diffDays(due, today);
    if (days > 1) return;
    const defs = r.kind === "grease" ? g37.GREASE_POINTS : g37.LUB_BOXES;
    const name = custom?.name ?? defs.find((p) => p.k === r.pointKey)?.n ?? r.pointKey;
    cycles.push({ key: `${k}:${due}`, label: `M/C ${r.machineNo} ${name} (${dueText(days)})`, days });
  });

  const fresh = async (items: Item[]) => {
    if (items.length === 0) return [];
    const existing = await db.selectFrom("notificationLog").select("key").where("key", "in", items.map((i) => i.key)).execute();
    const known = new Set(existing.map((e) => e.key));
    const news = items.filter((i) => !known.has(i.key));
    if (news.length > 0) {
      await db.insertInto("notificationLog").values(news.map((i) => ({ key: i.key })))
        .onConflict((oc) => oc.column("key").doNothing()).execute();
    }
    return news.sort((a, b) => a.days - b.days);
  };
  const summary = (items: Item[]) =>
    items.slice(0, 5).map((i) => i.label).join(", ") + (items.length > 5 ? `… +${items.length - 5}` : "");

  const send = async (items: Item[], jobRoles: string[], tag: string, title: string) => {
    const news = await fresh(items);
    if (!news.length) return;
    const sent = await notifyRoles({ jobRoles, tag, title: `${title} (${news.length})`, body: summary(news) });
    if (!sent) await db.deleteFrom("notificationLog").where("key", "in", news.map((i) => i.key)).execute();
  };

  await send(maint, ["superviseur", "technicien", "genmaint"], "echeance-maintenance", "Maintenance à faire");
  await send(cycles, ["superviseur", "technicien", "greaser"], "echeance-graissage", "Entretien à faire");
  await send(pendingWorks, ["superviseur", "technicien", "genmaint"], "travaux-en-attente", "Travaux non effectués");
}
