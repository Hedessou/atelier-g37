import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

// Canaux temps réel (signal « données changées », messages privés reçus, signalisation des appels).
// Aucune donnée de l'atelier ne transite par ici.
export const realtime = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 10 } },
});
