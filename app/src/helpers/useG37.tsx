import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getG37SignedState, type OutputType } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { applyLocal, enqueue, flush, loadCachedState, newId, onOutboxChange, outbox, saveCachedState, withPending } from "../lib/offline";
import { isOnline, useOnline } from "../lib/net";
import { flushRelay, noteServerState, stateAdopted } from "../lib/p2p";

export const G37_STATE_KEY = ["g37", "state"] as const;

// Données de l'atelier, disponibles même sans réseau.
// Chaque modification est enregistrée sur le téléphone puis envoyée au serveur dès que possible.
export const useG37 = () => {
  const queryClient = useQueryClient();
  const online = useOnline();

  const query = useQuery<OutputType, Error>({
    queryKey: G37_STATE_KEY,
    queryFn: async () => {
      const { state: fresh, text, sig } = await getG37SignedState();
      saveCachedState(fresh);
      noteServerState(fresh, text, sig);
      return withPending(fresh);
    },
    initialData: () => {
      const cached = loadCachedState();
      return cached ? withPending(cached) : undefined;
    },
    // Les données gardées sur le téléphone sont affichées tout de suite puis rafraîchies.
    initialDataUpdatedAt: 0,
    placeholderData: (prev) => prev,
    networkMode: "always",
    retry: (count) => isOnline() && count < 1,
    refetchInterval: online ? 60_000 : false,
    refetchOnWindowFocus: true,
  });

  // Données plus récentes reçues d'un collègue proche (sans Internet).
  useEffect(() => stateAdopted.on((adopted) => {
    queryClient.setQueryData<OutputType>(G37_STATE_KEY, withPending(adopted));
  }), [queryClient]);

  const save = useCallback((raw: InputType) => {
    const current = queryClient.getQueryData<OutputType>(G37_STATE_KEY);
    let input = raw;
    // Hors ligne, une quantité saisie devient un mouvement (écart) pour ne pas écraser le travail d'un collègue.
    if (input.action === "stockQty" && input.baseQuantity == null) {
      const item = current?.stock.find((s) => s.id === input.id);
      if (item) input = { ...input, baseQuantity: Number(item.quantity) };
    }
    if (input.action === "gearStock" && input.baseStock == null) {
      const g = current?.gears.find((x) => x.gearType === input.gearType && x.teeth === input.teeth);
      if (g) input = { ...input, baseStock: g.stock };
    }
    if (input.action === "chat" && !input.clientId) input = { ...input, clientId: newId("msg").slice(0, 40) };

    const op = enqueue(input);
    queryClient.setQueryData<OutputType>(G37_STATE_KEY, (prev) => (prev ? applyLocal(prev, op) : prev));
    if (!isOnline()) {
      toast.message("Enregistré sur le téléphone", {
        id: "offline-saved",
        description: "Partira dès le retour du réseau, ou via un collègue proche.",
      });
    }
    void syncNow(queryClient);
  }, [queryClient]);

  return {
    state: query.data,
    isFetching: query.isFetching,
    isLoading: query.isLoading,
    error: query.error,
    save,
    // Les enregistrements sont instantanés (file d'attente locale) : les boutons ne restent jamais bloqués.
    isSaving: false,
  };
};

// Envoie la file d'attente puis recharge les données.
export async function syncNow(queryClient: ReturnType<typeof useQueryClient>) {
  const relayed = await flushRelay();
  if (!outbox().length) {
    if (relayed) await queryClient.invalidateQueries({ queryKey: G37_STATE_KEY });
    return;
  }
  const r = await flush();
  r.messages.forEach((m) => toast.message(m, { duration: m.includes("temporaire") ? 60000 : 6000 }));
  r.errors.forEach((e) => toast.error(`Action non enregistrée : ${e}`));
  if (r.sent || r.errors.length) await queryClient.invalidateQueries({ queryKey: G37_STATE_KEY });
}

// Nombre d'actions encore en attente sur ce téléphone.
export function usePendingCount() {
  const [n, setN] = useState(() => outbox().length);
  useEffect(() => onOutboxChange(() => setN(outbox().length)), []);
  return n;
}
