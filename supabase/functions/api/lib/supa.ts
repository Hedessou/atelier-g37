import { createClient } from "@supabase/supabase-js";

// Client Supabase avec la clé de service : stockage des fichiers et diffusion temps réel.
export const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const BUCKET_CHAT = "chat-files";

// Prévient les téléphones connectés qu'il faut recharger les données (aucune donnée n'est diffusée).
export async function broadcastChanged(kind = "changed"): Promise<void> {
  try {
    const url = `${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(url, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: "g37-atelier", event: kind, payload: { at: Date.now() } }] }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    console.error("Diffusion temps réel:", e);
  }
}
