import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useG37, G37_STATE_KEY } from "../helpers/useG37";
import { useOnline } from "../lib/net";
import { realtime } from "../lib/realtime";
import { ensureP2PListeners, flushRelay, getSecrets, processInbox, refreshSecrets, registerDevice, startP2P, stopP2P } from "../lib/p2p";
import { onNewDm, refreshDms } from "../lib/dms";
import { checkRinging, declineFromNotification, handleLaunchCall, onInternetSignal, setCallIdentity } from "../lib/calls";
import { Nearby, isWifiEndpoint, nativeSoundsAvailable, type LaunchData, type RingingCall } from "../lib/nearby";
import { applySoundPrefs, playAlert } from "../lib/sounds";

// Fait tourner en fond : synchro sans Internet, messages privés, appels entrants.
export const P2PBridge = () => {
  const { state } = useG37();
  const online = useOnline();
  const queryClient = useQueryClient();
  const me = state?.me;
  const myId = me?.id;
  const pending = me?.pending ?? true;
  const [topic, setTopic] = useState<string | null>(() => getSecrets()?.callTopic ?? null);

  useEffect(() => {
    setCallIdentity(me ? { id: me.id, displayName: me.displayName } : null);
  }, [me?.id, me?.displayName]);

  // Avec Internet : clés, enregistrement du téléphone, actions des collègues à porter, messages privés.
  useEffect(() => {
    if (!myId) return;
    let cancelled = false;
    (async () => {
      if (online) {
        const secrets = await refreshSecrets();
        if (!cancelled) setTopic(secrets?.callTopic ?? null);
        await registerDevice(myId);
        const relayed = await flushRelay();
        if (relayed) void queryClient.invalidateQueries({ queryKey: G37_STATE_KEY });
        await refreshDms(myId);
      }
      if (!cancelled) await startP2P({ id: myId, pending });
    })().catch((e) => console.warn("Synchro de proximité :", e));
    return () => { cancelled = true; };
  }, [myId, pending, online, queryClient]);

  useEffect(() => () => { void stopP2P(); }, []);

  // Message privé reçu sans Internet (app ouverte) : petit son.
  useEffect(() => onNewDm(() => { if (document.visibilityState === "visible") void playAlert("message"); }), []);

  // Sonneries choisies, ouverture depuis une notification (onglet, conversation, appel à afficher ou à prendre).
  useEffect(() => {
    if (!myId) return;
    let off: { remove: () => Promise<void> } | null = null;
    const handle = (l?: LaunchData) => {
      if (!l) return;
      if (l.call?.room) void handleLaunchCall(l.call);
      else if (l.peer || l.segment) window.dispatchEvent(new CustomEvent("g37:open-peer", { detail: { peer: l.peer ? Number(l.peer) : undefined, segment: l.segment } }));
      else if (l.tab) window.dispatchEvent(new CustomEvent("g37:open-tab", { detail: l.tab }));
    };
    (async () => {
      await applySoundPrefs();
      if (!(await nativeSoundsAvailable())) return;
      await ensureP2PListeners().catch(() => {});
      off = await Nearby.addListener("launch", handle);
      const r = await Nearby.consumeLaunch().catch(() => ({} as { launch?: LaunchData; declined?: string; ringing?: RingingCall }));
      if (r.declined) void declineFromNotification(r.declined);
      if (r.launch) handle(r.launch);
      else if (r.ringing) {
        // Appel sans Internet qui sonnait pendant que l'app était fermée (ouverte sans toucher la notification).
        void handleLaunchCall({
          room: r.ringing.callId, name: r.ringing.name, from: String(r.ringing.from), action: "ring",
          via: isWifiEndpoint(r.ringing.endpointId) ? "wifi" : "proche", endpoint: r.ringing.endpointId, mode: r.ringing.mode, video: r.ringing.video,
        });
      }
    })().catch(() => {});
    return () => { void off?.remove(); };
  }, [myId]);

  // Avec Internet : un collègue m'appelle-t-il en ce moment ?
  useEffect(() => {
    if (!myId || !online) return;
    const id = setTimeout(() => void checkRinging(), 1500);
    return () => clearTimeout(id);
  }, [myId, online]);

  // Actions de collègues portées par ce téléphone : envoi régulier quand Internet est là.
  useEffect(() => {
    if (!online || !myId) return;
    const id = setInterval(async () => {
      const n = await flushRelay();
      if (n) void queryClient.invalidateQueries({ queryKey: G37_STATE_KEY });
    }, 120_000);
    return () => clearInterval(id);
  }, [online, myId, queryClient]);

  // Retour sur l'app : fichiers reçus en arrière-plan et nouveaux messages.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !myId) return;
    const sub = App.addListener("resume", () => {
      void processInbox();
      void refreshDms(myId);
    });
    return () => { void sub.then((s) => s.remove()); };
  }, [myId]);

  // Canal personnel : appels Internet entrants et messages privés reçus.
  useEffect(() => {
    if (!myId || !online || !topic) return;
    const channel = realtime
      .channel(topic)
      .on("broadcast", { event: "signal" }, (msg) => {
        const p = (msg as { payload?: { from: number; fromName: string; data: Record<string, unknown> } }).payload;
        if (p) void onInternetSignal(p);
      })
      .on("broadcast", { event: "dm" }, () => void refreshDms(myId))
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, [myId, online, topic]);

  return null;
};
