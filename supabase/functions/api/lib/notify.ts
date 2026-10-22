import { db } from "./db.ts";
import { sendPush } from "./push.ts";

async function pushToUsers(userIds: number[], title: string, body: string, tag: string, data?: Record<string, string | number>): Promise<boolean> {
  if (!userIds.length) return false;
  const rows = await db.selectFrom("pushTokens").select("token").where("userId", "in", userIds).execute();
  if (!rows.length) return false;
  const { sent, dead } = await sendPush(rows.map((r: { token: string }) => r.token), { title, body, tag: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, data });
  if (dead.length) await db.deleteFrom("pushTokens").where("token", "in", dead).execute();
  return sent > 0;
}

type EventAlert = { jobRoles: string[]; title: string; body: string; tag: string; excludeUserId?: number };

export async function notifyRoles(alert: EventAlert): Promise<boolean> {
  try {
    // deno-lint-ignore no-explicit-any
    let q = db.selectFrom("users").select("id").where((eb: any) => eb.or([eb("role", "=", "admin"), eb("jobRole", "in", alert.jobRoles)]));
    if (alert.excludeUserId != null) q = q.where("id", "!=", alert.excludeUserId);
    const recipients = await q.execute();
    return await pushToUsers(recipients.map((r: { id: number }) => r.id), alert.title, alert.body, alert.tag);
  } catch (e) {
    console.error("Notification non envoyée:", e);
    return false;
  }
}

export async function notifyUsers(alert: { userIds: number[]; title: string; body: string; tag: string; excludeUserId?: number; data?: Record<string, string | number> }): Promise<void> {
  try {
    await pushToUsers(alert.userIds.filter((id) => id !== alert.excludeUserId), alert.title, alert.body, alert.tag, alert.data);
  } catch (e) {
    console.error("Notification ciblée non envoyée:", e);
  }
}

const ALERTED_JOB_ROLES = ["technicien", "shift", "superviseur", "prodsup", "prodman", "admin"];
type FaultAlert = { machineNo: number; issue: string; notes: string | null; severity: string; reportedBy: string; stoppedAt: Date | null };

export async function notifyFault(alert: FaultAlert): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const recipients = await db.selectFrom("users").select(["id", "email"]).where((eb: any) => eb.or([eb("role", "=", "admin"), eb("jobRole", "in", ALERTED_JOB_ROLES)])).execute();
  if (recipients.length === 0) return;
  const when = alert.stoppedAt ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Porto-Novo" }).format(alert.stoppedAt) : null;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_EMAIL_FROM");
  if (resendKey && from) {
    const subject = `Panne M/C ${alert.machineNo} — ${alert.issue}`;
    const text = [`Panne signalée sur la M/C ${alert.machineNo}`, alert.issue, `Gravité : ${alert.severity}`, `Signalée par : ${alert.reportedBy}`, when ? `Arrêtée depuis : ${when}` : "", alert.notes ?? ""].filter(Boolean).join("\n");
    await Promise.allSettled(recipients.map((r: { email: string }) => fetch("https://api.resend.com/emails", {
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
  await pushToUsers(recipients.map((r: { id: number }) => r.id), `Panne M/C ${alert.machineNo}`, `${alert.issue} — signalée par ${alert.reportedBy}`, `panne-${alert.machineNo}`, { machineNo: alert.machineNo, tab: "pannes" });
}
