import { sql } from "./db.ts";
import { g37 } from "../shared/g37.ts";

// Équipe de quart en poste maintenant, d'après le planning (heure du Bénin, UTC+1, sans heure d'été).
// Matin 07h–15h, après-midi 15h–23h, nuit 23h–07h (la nuit appartient au jour où elle commence).
export type Duty = { team: string; code: "m" | "s" | "n"; day: string };

export function dutySlot(now = new Date()): { code: "m" | "s" | "n"; day: string } {
  const local = new Date(now.getTime() + 3600000);
  const h = local.getUTCHours();
  const code = h >= 7 && h < 15 ? "m" : h >= 15 && h < 23 ? "s" : "n";
  if (h < 7) local.setUTCDate(local.getUTCDate() - 1);
  return { code, day: local.toISOString().slice(0, 10) };
}

export async function teamOnDuty(now = new Date()): Promise<Duty | null> {
  const slot = dutySlot(now);
  const rows = await sql`SELECT team FROM shift_plan WHERE day = ${slot.day}::date AND shift_code = ${slot.code} ORDER BY team LIMIT 1`;
  return rows.length ? { team: String(rows[0].team), ...slot } : null;
}

// Répartit des destinataires : d'abord l'équipe en poste et les postes sans quart (superviseurs, Boss…),
// ensuite les techniciens des équipes qui ne sont pas en poste.
// Le General shift (09h–17h, lundi–samedi) est prévenu d'abord pendant ses heures, ensuite seulement en renfort.
export function splitByDuty<T extends { team: string | null }>(users: T[], duty: Duty | null, now = new Date()): { first: T[]; later: T[] } {
  if (!duty) return { first: users, later: [] };
  const general = g37.generalOnDuty(now);
  const offDuty = (u: T) => !!u.team && ((["A", "B", "C"].includes(u.team) && u.team !== duty.team) || (u.team === "G" && !general));
  return { first: users.filter((u) => !offDuty(u)), later: users.filter(offDuty) };
}
