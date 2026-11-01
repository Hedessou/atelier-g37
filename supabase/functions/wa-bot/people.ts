// Personnes connues du robot (table wa_people) : numéro WhatsApp → compte de l'app et droits.
// Et appels au serveur de l'app (fonction « api ») pour les modifications, avec les droits de la personne.
import { config, sql } from "./db.ts";

export type Level = "owner" | "supervisor" | "staff" | "none";
export type Person = { id: number; name: string; phone: string; user_id: number | null; level: Level; call_tier: number | null; name_auto: boolean };

// Ce que chaque niveau peut modifier depuis WhatsApp (types de modification de edits.ts).
// staff : pignons et count, sorties de matériel, fin de maintenance, graissage (consigne du 01/11/2026).
// supervisor : tout sauf les accès. owner : tout.
const STAFF_EDITS = ["gears", "count", "stock_out", "maint_done", "greasing"];
export function canEditType(level: Level | undefined, type: string): boolean {
  if (level === "owner") return true;
  if (level === "supervisor") return type !== "access";
  if (level === "staff") return STAFF_EDITS.includes(type);
  return false;
}
export const LEVEL_FR: Record<Level, string> = { owner: "propriétaire (tout)", supervisor: "superviseur (tout sauf les accès)",
  staff: "pignons/count, sorties de matériel, fin de maintenance, graissage", none: "questions seulement" };

/** Chiffres d'un numéro ou d'un identifiant WhatsApp (« 22901…@s.whatsapp.net », « +229 01 … »). */
export const digits = (s: unknown) => String(s ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");

/** Même numéro ? Comparaison des 8 derniers chiffres (avec ou sans 229, avec ou sans le « 01 » des numéros béninois). */
export function samePhone(a: unknown, b: unknown): boolean {
  const x = digits(a), y = digits(b);
  if (x.length < 8 || y.length < 8 || x.length > 15 || y.length > 15) return false;
  return x.slice(-8) === y.slice(-8);
}

/** Numéro béninois complet : « 0166281605 » ou « 66281605 » → « 2290166281605 ». */
export function fullPhone(s: unknown): string {
  const d = digits(s);
  if (d.startsWith("229")) return d;
  if (d.length === 10 && d.startsWith("01")) return "229" + d;
  if (d.length === 8) return "22901" + d;
  return d;
}

let cache: { at: number; list: Person[] } | null = null;
export async function people(): Promise<Person[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  try {
    const rows = await sql`SELECT id, name, phone, user_id, level, call_tier, name_auto FROM wa_people WHERE active ORDER BY id`;
    cache = { at: Date.now(), list: rows as unknown as Person[] };
  } catch {
    cache = { at: Date.now(), list: [] }; // table pas encore créée : personne n'est connu
  }
  return cache.list;
}

export async function personByPhone(...ids: unknown[]): Promise<Person | null> {
  const list = await people();
  for (const id of ids) {
    if (!id) continue;
    const p = list.find((x) => samePhone(x.phone, id));
    if (p) return p;
  }
  return null;
}

/** Appel d'une route du serveur de l'app réservée au robot (même clé que le robot). */
export async function appApi<T = Record<string, unknown>>(route: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/wa-app/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wa-key": await config("wa.key") },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Nom WhatsApp repris automatiquement tant que l'admin n'a pas donné le vrai nom. */
export async function learnName(p: Person | null, pushName: unknown): Promise<void> {
  const n = String(pushName ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  if (!p || !p.name_auto || !n || n === p.name || /^\+?\d[\d\s]+$/.test(n)) return;
  await sql`UPDATE wa_people SET name = ${n} WHERE id = ${p.id} AND name_auto`.catch(() => {});
  p.name = n;
  cache = null;
}
