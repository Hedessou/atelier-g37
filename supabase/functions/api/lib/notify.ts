import { db, sql } from "./db.ts";
import { sendPush } from "./push.ts";
import { splitByDuty, teamOnDuty } from "./duty.ts";

async function pushToUsers(userIds: number[], title: string, body: string, tag: string, data?: Record<string, string | number>, kind?: string): Promise<boolean> {
  if (!userIds.length) return false;
  const rows = await db.selectFrom("pushTokens").select(["token", "platform"]).where("userId", "in", userIds).execute();
  if (!rows.length) return false;
  const uniqueTag = kind === "call" || kind === "call_end" ? tag : `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { sent, dead } = await sendPush(rows.map((r: { token: string; platform: string | null }) => ({ token: r.token, platform: r.platform })), { title, body, tag: uniqueTag, data, kind });
  if (dead.length) await db.deleteFrom("pushTokens").where("token", "in", dead).execute();
  return sent > 0;
}

// dutyFirst : alerte de terrain (panne, arrêt, travail à faire) envoyée d'abord à l'équipe en poste et aux postes
// sans quart ; les techniciens des autres équipes ne sont prévenus que si la panne n'est pas réglée à temps.
type EventAlert = { jobRoles: string[]; title: string; body: string; tag: string; excludeUserId?: number; kind?: string; data?: Record<string, string | number>; dutyFirst?: boolean };

async function recipientsFor(jobRoles: string[], excludeUserId?: number): Promise<Array<{ id: number; email: string; team: string | null }>> {
  // deno-lint-ignore no-explicit-any
  let q = db.selectFrom("users").select(["id", "email", "team"]).where((eb: any) => eb.or([eb("role", "=", "admin"), eb("jobRole", "in", jobRoles)]));
  if (excludeUserId != null) q = q.where("id", "!=", excludeUserId);
  return await q.execute();
}

export async function notifyRoles(alert: EventAlert): Promise<boolean> {
  try {
    let recipients = await recipientsFor(alert.jobRoles, alert.excludeUserId);
    if (alert.dutyFirst) recipients = splitByDuty(recipients, await teamOnDuty().catch(() => null)).first;
    return await pushToUsers(recipients.map((r) => r.id), alert.title, alert.body, alert.tag, alert.data, alert.kind);
  } catch (e) {
    console.error("Notification non envoyée:", e);
    return false;
  }
}

export async function notifyUsers(alert: { userIds: number[]; title: string; body: string; tag: string; excludeUserId?: number; data?: Record<string, string | number>; kind?: string }): Promise<void> {
  try {
    await pushToUsers(alert.userIds.filter((id) => id !== alert.excludeUserId), alert.title, alert.body, alert.tag, alert.data, alert.kind);
  } catch (e) {
    console.error("Notification ciblée non envoyée:", e);
  }
}

const ALERTED_JOB_ROLES = ["technicien", "shift", "superviseur", "prodsup", "prodman", "forman", "manager", "admin"];
type FaultAlert = { machineNo: number; issue: string; notes: string | null; severity: string; reportedBy: string; stoppedAt: Date | null };

export async function notifyFault(alert: FaultAlert): Promise<void> {
  const all = await recipientsFor(ALERTED_JOB_ROLES);
  if (all.length === 0) return;
  // L'équipe en poste d'abord : les autres équipes sont prévenues 30 min plus tard si la panne est toujours ouverte.
  const recipients = splitByDuty(all, await teamOnDuty().catch(() => null)).first;
  const when = alert.stoppedAt ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Porto-Novo" }).format(alert.stoppedAt) : null;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_EMAIL_FROM");
  if (resendKey && from) {
    const subject = `Panne M/C ${alert.machineNo} — ${alert.issue}`;
    const text = [`Panne signalée sur la M/C ${alert.machineNo}`, alert.issue, `Gravité : ${alert.severity}`, `Signalée par : ${alert.reportedBy}`, when ? `Arrêtée depuis : ${when}` : "", alert.notes ?? ""].filter(Boolean).join("\n");
    await Promise.allSettled(recipients.map((r) => fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: r.email, subject, text }),
    })));
  }
  try {
    const makeWebhook = "https://hook.eu1.make.com/wmugp7evo565ymgn2tykviwzmxkk99u4";
    const message = [`🚨 PANNE — M/C ${alert.machineNo}`, `Problème : ${alert.issue}`, `Gravité : ${alert.severity}`, `Signalée par : ${alert.reportedBy}`, when ? `Arrêtée depuis : ${when}` : "", alert.notes ? `Notes : ${alert.notes}` : ""].filter(Boolean).join("\\n");
    const response = await fetch(makeWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
    if (!response.ok) console.error("Webhook Make panne refusé:", response.status);
  } catch (e) {
    console.error("Webhook Make panne non envoyé:", e);
  }
  await pushToUsers(recipients.map((r) => r.id), `Panne M/C ${alert.machineNo}`, `${alert.issue} — signalée par ${alert.reportedBy}`, `panne-${alert.machineNo}`, { machineNo: alert.machineNo, tab: "pannes" }, "alert");
}

// Pannes toujours ouvertes 30 min après leur signalement : on prévient aussi les techniciens des autres équipes.
// Appelé toutes les 10 min (tâche planifiée) et à chaque chargement des données ; chaque panne n'est relancée qu'une fois.
export async function escalateOpenFaults(): Promise<number> {
  const rows = await sql`SELECT f.id, f.machine_id, f.issue, f.opened_at FROM failures f
    WHERE f.status <> 'resolue' AND f.opened_at < now() - interval '30 minutes' AND f.opened_at > now() - interval '12 hours'
      AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.key = 'escalade:' || f.id)
    ORDER BY f.opened_at LIMIT 10`;
  if (!rows.length) return 0;
  const duty = await teamOnDuty().catch(() => null);
  let sent = 0;
  for (const f of rows) {
    const claimed = await sql`INSERT INTO notification_log (key) VALUES (${"escalade:" + f.id}) ON CONFLICT (key) DO NOTHING RETURNING key`;
    if (!claimed.length) continue;
    if (!duty) continue; // sans planning, tout le monde avait déjà été prévenu
    const later = splitByDuty(await recipientsFor(ALERTED_JOB_ROLES), duty).later;
    const no = Number(String(f.machine_id).replace(/\D/g, "")) || 0;
    const minutes = Math.round((Date.now() - new Date(f.opened_at).getTime()) / 60000);
    if (await pushToUsers(later.map((r) => r.id), `Panne non réglée — M/C ${no}`, `${f.issue} · ouverte depuis ${minutes} min, l'équipe ${duty.team} a besoin de renfort`, `escalade-${f.id}`, { machineNo: no, tab: "pannes" }, "alert")) sent++;
  }
  return sent;
}
