// Outils communs : base de données, dates (heure du Bénin), mise en forme.
import postgres from "npm:postgres@3.4.5";

export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, idle_timeout: 20, max: 3 });

export async function config(key: string): Promise<string> {
  const rows = await sql`SELECT value FROM app_config WHERE key = ${key}`;
  return rows[0]?.value ?? "";
}
export async function setConfig(key: string, value: string): Promise<void> {
  await sql`INSERT INTO app_config (key, value, updated_at) VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 21);
export const machineId = (n: number) => "M-" + String(n).padStart(2, "0");
export const rf = (n: number) => "Mc " + n;

export const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export const beninDay = (d: Date = new Date()) => isoDay(new Date(d.getTime() + 3600_000));
export const addDays = (day: string, n: number) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
export const diff = (a: string, b: string) => Math.round((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400000);
export const when = (days: number) => (days < 0 ? `retard ${-days} j` : days === 0 ? "aujourd'hui" : days === 1 ? "demain" : `dans ${days} j`);
export const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

// « 1 à 8 », « 3, 5 et 9 », « 1 à 4, 7 »
export function machineList(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j - i >= 2 ? `${s[i]} à ${s[j]}` : j === i ? `${s[i]}` : `${s[i]}, ${s[j]}`);
    i = j;
  }
  return parts.join(", ");
}

// Message à poster dans « Ring Fram Local Team » (le robot le récupère et l'envoie).
export async function outbox(text: string): Promise<void> {
  await sql`INSERT INTO wa_outbox (text) VALUES (${text})`;
}

// Clé « déjà fait » (évite d'envoyer deux fois le même rappel ou la même alerte).
export async function once(key: string): Promise<boolean> {
  const r = await sql`INSERT INTO notification_log (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING RETURNING key`;
  return r.length > 0;
}

export async function broadcastChanged() {
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: "g37-atelier", event: "changed", payload: { at: Date.now() } }] }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) { console.error("Diffusion temps réel:", e); }
}
