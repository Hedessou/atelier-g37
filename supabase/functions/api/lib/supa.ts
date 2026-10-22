import { createClient } from "@supabase/supabase-js";

export const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const BUCKET_CHAT = "chat-files";

export async function broadcastTo(topic: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const url = `${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(url, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic, event, payload }] }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    console.error("Diffusion temps réel:", e);
  }
}

export async function broadcastChanged(kind = "changed"): Promise<void> {
  await broadcastTo("g37-atelier", kind, { at: Date.now() });
}
