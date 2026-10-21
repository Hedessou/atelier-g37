import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../lib/config";
import { G37_STATE_KEY } from "../helpers/useG37";

// Quand un collègue enregistre quelque chose, le serveur envoie un simple signal « changé » :
// l'app recharge alors les données (aucune donnée ne transite par ce canal).
const realtime = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 2 } },
});

export const RealtimeBridge = () => {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = realtime
      .channel("g37-atelier")
      .on("broadcast", { event: "changed" }, () => {
        // Regroupe les signaux rapprochés en un seul rechargement.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: G37_STATE_KEY }), 800);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void realtime.removeChannel(channel);
    };
  }, [queryClient]);
  return null;
};
