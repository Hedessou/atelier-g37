import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import { ALERT_SOUNDS, CALL_SOUNDS, previewSound, setSoundPrefs, soundPrefs, type SoundPrefs } from "../lib/sounds";
import { Nearby, nativeSoundsAvailable, nativeV4Available, nearbyAvailable, type SettingKey, type SystemStatus } from "../lib/nearby";
import { getPeers, myDataAt, peersChanged, reachableEnabled, requestP2PPermissions, setReachable, setSyncInterval, startP2P, syncIntervalMinutes, type Peer } from "../lib/p2p";
import { enablePush, isPushOptedIn, pushSupported } from "../helpers/pushClient";
import { syncNow } from "../helpers/useG37";
import { useOnline } from "../lib/net";
import { BUNDLE_VERSION } from "../lib/config";
import styles from "./SettingsView.module.css";

type Props = { state: State; lang: "fr" | "en"; setLang: (l: "fr" | "en") => void; onBack: () => void; onGuide?: () => void };

const ago = (ms: number, fr: boolean) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return fr ? "à l'instant" : "just now";
  if (m < 60) return fr ? `il y a ${m} min` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return fr ? `il y a ${h} h` : `${h} h ago`;
  return fr ? `il y a ${Math.round(h / 24)} j` : `${Math.round(h / 24)} d ago`;
};

export const SettingsView = ({ state, lang, setLang, onBack, onGuide }: Props) => {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const online = useOnline();
  const queryClient = useQueryClient();
  const [prefs, setPrefs] = useState<SoundPrefs>(soundPrefs());
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [native, setNative] = useState(false);
  const [interval, setIntervalMin] = useState(syncIntervalMinutes());
  const [peers, setPeers] = useState<Peer[]>(getPeers());
  const [pushOn, setPushOn] = useState(isPushOptedIn());
  const [v4, setV4] = useState(false);
  const [reach, setReach] = useState(reachableEnabled());
  const [autostartDone, setAutostartDone] = useState(() => { try { return localStorage.getItem("g37.autostartSeen") === "1"; } catch { return false; } });

  const refresh = useCallback(async () => {
    const ok = await nativeSoundsAvailable();
    setNative(ok);
    if (ok) setSys(await Nearby.getSystemStatus().catch(() => null));
    setV4(await nativeV4Available());
    setPushOn(isPushOptedIn());
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // Retour des réglages Android : on relit l'état.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);
  useEffect(() => peersChanged.on(setPeers), []);

  const update = async (p: Partial<SoundPrefs>) => setPrefs(await setSoundPrefs(p));
  const open = async (which: SettingKey) => {
    await Nearby.openSystemSetting({ which }).catch(() => toast.error(t("Réglage introuvable sur ce téléphone.", "Setting not found on this phone.")));
  };

  const activateAll = async () => {
    try {
      if (pushSupported() && !isPushOptedIn()) await enablePush().catch(() => {});
      if (nearbyAvailable()) {
        await requestP2PPermissions();
        await Nearby.requestNearbyPermissions({ microphone: true }).catch(() => {});
        await startP2P({ id: state.me.id, pending: state.me.pending }).catch(() => {});
      }
      await refresh();
      const s = native ? await Nearby.getSystemStatus().catch(() => null) : null;
      if (s && !s.battery) await open("battery");
      else if (s && !s.fullScreen) await open("fullScreen");
      else if (s && !s.bluetooth) await open("bluetooth");
      else toast.success(t("Autorisations vérifiées.", "Permissions checked."));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Autorisation refusée", "Permission refused"));
    }
  };

  type Row = { key: string; label: string; help: string; ok: boolean; action: () => void | Promise<void> };
  const rows: Row[] = [];
  if (pushSupported()) rows.push({
    key: "push", label: t("Notifications", "Notifications"), help: t("Pannes, messages et appels, même app fermée.", "Faults, messages and calls, even when closed."),
    ok: pushOn && (sys?.notifications ?? true), action: async () => {
      if (!pushOn) { await enablePush().catch(() => toast.error(t("Notifications refusées : autorise-les dans les réglages.", "Notifications refused: allow them in settings."))); await refresh(); }
      else await open("notifications");
    },
  });
  if (sys) {
    rows.push(
      { key: "nearby", label: t("Appareils à proximité", "Nearby devices"), help: t("Échanges sans Internet (Bluetooth, Wi-Fi direct, même Wi-Fi, point d'accès).", "Offline exchange (Bluetooth, Wi-Fi Direct, same Wi-Fi, hotspot)."),
        ok: sys.nearby, action: async () => { await requestP2PPermissions(); await startP2P({ id: state.me.id, pending: state.me.pending }).catch(() => {}); await refresh(); } },
      { key: "mic", label: t("Micro", "Microphone"), help: t("Pour les appels et les notes vocales.", "For calls and voice notes."), ok: sys.microphone,
        action: async () => { await Nearby.requestNearbyPermissions({ microphone: true }).catch(() => {}); await refresh(); } },
      ...(v4 ? [{ key: "cam", label: t("Caméra", "Camera"), help: t("Pour les appels vidéo et les photos.", "For video calls and photos."), ok: !!sys.camera,
        action: async () => { await Nearby.requestNearbyPermissions({ microphone: true, camera: true }).catch(() => {}); await refresh(); } }] : []),
      { key: "bt", label: t("Bluetooth allumé", "Bluetooth on"), help: t("Indispensable pour trouver les collègues sans Internet.", "Needed to find colleagues offline."), ok: sys.bluetooth, action: () => open("bluetooth") },
    );
    if (sys.locationNeeded) rows.push({ key: "loc", label: t("Localisation activée", "Location on"), help: t("Exigée par Android pour la recherche Bluetooth.", "Required by Android for Bluetooth search."), ok: sys.location, action: () => open("location") });
    if (sys.sdk >= 34) rows.push({ key: "fs", label: t("Écran d'appel plein écran", "Full-screen call screen"), help: t("Pour que l'appel s'affiche et sonne écran verrouillé.", "So calls show and ring on the lock screen."), ok: sys.fullScreen, action: () => open("fullScreen") });
    rows.push(
      { key: "bat", label: t("Batterie sans restriction", "Unrestricted battery"), help: t("Sinon Android coupe la synchronisation et les appels en arrière-plan.", "Otherwise Android stops background sync and calls."), ok: sys.battery, action: () => open("battery") },
      ...(v4 ? [{ key: "auto", label: t("Démarrage automatique", "Auto-start"),
        help: t("Tecno, Infinix, itel, Xiaomi, Oppo, Vivo… : autorise « Spinning R/F » à démarrer seule, sinon les appels n'arrivent pas app fermée.", "Tecno, Infinix, itel, Xiaomi, Oppo, Vivo…: allow the app to auto-start, otherwise calls don't arrive when closed."),
        ok: autostartDone, action: async () => { await open("autostart"); try { localStorage.setItem("g37.autostartSeen", "1"); } catch { /* */ } setAutostartDone(true); } }] : []),
      { key: "apk", label: t("Installer les mises à jour", "Install updates"), help: t("Pour installer une mise à jour reçue d'un collègue.", "To install an update received from a colleague."), ok: sys.installApps, action: () => open("installApps") },
    );
  }
  const missing = rows.filter((r) => !r.ok).length;

  // Qui a les dernières données ?
  const lastChange = state.lastChangeAt ? new Date(state.lastChangeAt).getTime() : null;
  const mine = myDataAt();
  const nearBy = new Map(peers.filter((p) => p.userId != null).map((p) => [p.userId as number, p]));
  const team = state.users.filter((u) => u.id !== state.me.id).map((u) => {
    const server = u.lastSyncAt ? new Date(u.lastSyncAt).getTime() : 0;
    const near = nearBy.get(u.id)?.dataAt ?? 0;
    const at = Math.max(server, near);
    const upToDate = at > 0 && (!lastChange || at >= lastChange - 60000);
    return { u, at, upToDate, near: !!nearBy.get(u.id)?.connected };
  }).sort((a, b) => Number(a.upToDate) - Number(b.upToDate) || b.at - a.at);
  const lateCount = team.filter((x) => !x.upToDate).length;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <button className={styles.back} onClick={onBack} aria-label={t("Retour", "Back")}>‹</button>
        <h1 className={styles.h1}>{t("Paramètres", "Settings")}</h1>
      </div>

      <section className={styles.card}>
        <h2 className={styles.h2}>{t("Sonneries", "Ringtones")}</h2>
        {!native && <p className={styles.note}>{t("Installe la dernière version de l'app (APK) pour choisir les sonneries.", "Install the latest app (APK) to choose ringtones.")}</p>}
        <SoundRow label={t("Appels", "Calls")} value={prefs.call} options={CALL_SOUNDS} lang={lang} onChange={(v) => void update({ call: v })} onPlay={() => void previewSound(prefs.call, "ringtone")} />
        <SoundRow label={t("Alertes (pannes, arrêts, échéances)", "Alerts (faults, stops, due tasks)")} value={prefs.alert} options={ALERT_SOUNDS} lang={lang} onChange={(v) => void update({ alert: v })} onPlay={() => void previewSound(prefs.alert, prefs.loud ? "alarm" : "notification")} />
        <SoundRow label={t("Messages", "Messages")} value={prefs.message} options={ALERT_SOUNDS} lang={lang} onChange={(v) => void update({ message: v })} onPlay={() => void previewSound(prefs.message, prefs.loud ? "alarm" : "notification")} />
        <label className={styles.switchRow}>
          <span>
            <strong>{t("Son fort", "Loud sound")}</strong>
            <span className={styles.help}>{t("Les alertes et messages sonnent au volume du réveil (bien audible dans l'atelier).", "Alerts and messages ring at alarm volume (audible in the workshop).")}</span>
          </span>
          <input type="checkbox" checked={prefs.loud} onChange={(e) => void update({ loud: e.target.checked })} />
        </label>
      </section>

      <section className={styles.card}>
        <div className={styles.rowBetween}>
          <h2 className={styles.h2}>{t("Autorisations importantes", "Important permissions")}</h2>
          {missing > 0 && <span className={styles.badge}>{missing}</span>}
        </div>
        <p className={styles.note}>{t("Nécessaires pour que les notifications et les appels sonnent même app fermée, et pour l'échange sans Internet.", "Needed so notifications and calls ring even when closed, and for offline exchange.")}</p>
        {rows.map((r) => (
          <div key={r.key} className={styles.permRow}>
            <span className={`${styles.dot} ${r.ok ? styles.dotOk : styles.dotWarn}`} aria-hidden="true" />
            <span className={styles.permText}><strong>{r.label}</strong><span className={styles.help}>{r.help}</span></span>
            {r.ok ? <span className={styles.ok}>{t("OK", "OK")}</span> : <button className={styles.small} onClick={() => void r.action()}>{t("Activer", "Enable")}</button>}
          </div>
        ))}
        {missing > 0 && <button className={styles.primary} onClick={() => void activateAll()}>{t("Tout activer", "Enable all")}</button>}
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>{t("Synchronisation", "Sync")}</h2>
        <p className={styles.note}>
          {t("Avec Internet : immédiate. Sans Internet : le téléphone cherche les collègues (Bluetooth, Wi-Fi direct, même Wi-Fi, point d'accès) et vérifie qui a les dernières données.",
            "With Internet: instant. Offline: the phone looks for colleagues (Bluetooth, Wi-Fi Direct, same Wi-Fi, hotspot) and checks who has the latest data.")}
        </p>
        {v4 && (
          <label className={styles.switchRow}>
            <span>
              <strong>{t("Toujours joignable sans Internet", "Always reachable offline")}</strong>
              <span className={styles.help}>{t("Même app fermée, le téléphone reste visible des collègues proches (Bluetooth, même Wi-Fi, point d'accès) : appels, messages et pannes arrivent sans Internet. Consomme un peu plus de batterie.", "Even when closed, the phone stays visible to nearby colleagues (Bluetooth, same Wi-Fi, hotspot): calls, messages and faults arrive offline. Uses a bit more battery.")}</span>
            </span>
            <input type="checkbox" checked={reach} onChange={(e) => { setReach(e.target.checked); void setReachable(e.target.checked); }} />
          </label>
        )}
        {onGuide && (
          <button className={styles.primary} style={{ marginBottom: 12 }} onClick={onGuide}>{t("Guide : connexion automatique sans Internet", "Guide: automatic offline connection")}</button>
        )}
        <div className={styles.field}>
          <span>{t("Vérifier sans Internet toutes les", "Check offline every")}</span>
          <div className={styles.seg}>
            {[15, 30, 60, 120].map((m) => (
              <button key={m} className={interval === m ? styles.segOn : styles.segBtn} onClick={() => { setIntervalMin(m); void setSyncInterval(m); }}>{m < 60 ? `${m} min` : `${m / 60} h`}</button>
            ))}
          </div>
        </div>
        <div className={styles.rowBetween}>
          <span className={styles.help}>{t("Mes données", "My data")} : {mine ? ago(Date.now() - mine, fr) : "—"}</span>
          <button className={styles.small} disabled={!online} onClick={() => { void syncNow(queryClient); if (nearbyAvailable()) void Nearby.broadcastPacket().catch(() => {}); toast.success(t("Synchronisation lancée", "Sync started")); }}>
            {t("Synchroniser", "Sync now")}
          </button>
        </div>
        <h3 className={styles.h3}>{t("État de l'équipe", "Team status")} {lateCount > 0 ? `· ${lateCount} ${t("en retard", "behind")}` : `· ${t("tous à jour", "all up to date")}`}</h3>
        <div className={styles.team}>
          {team.map(({ u, at, upToDate, near }) => (
            <div key={u.id} className={styles.teamRow}>
              <span className={`${styles.dot} ${upToDate ? styles.dotOk : styles.dotWarn}`} aria-hidden="true" />
              <span className={styles.permText}>
                <strong>{u.displayName}</strong>
                <span className={styles.help}>{at ? `${upToDate ? t("À jour", "Up to date") : t("Données anciennes", "Old data")} · ${ago(Date.now() - at, fr)}` : t("Pas encore synchronisé avec la nouvelle version", "Not synced with the new version yet")}{near ? ` · ${t("à proximité", "nearby")}` : ""}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>{t("Langue", "Language")}</h2>
        <div className={styles.seg}>
          <button className={lang === "fr" ? styles.segOn : styles.segBtn} onClick={() => setLang("fr")}>Français</button>
          <button className={lang === "en" ? styles.segOn : styles.segBtn} onClick={() => setLang("en")}>English</button>
        </div>
      </section>
      <p className={styles.version}>Spinning R/F · {t("version", "version")} {BUNDLE_VERSION}</p>
    </div>
  );
};

const SoundRow = ({ label, value, options, lang, onChange, onPlay }: {
  label: string; value: string; options: ReadonlyArray<{ key: string; fr: string; en: string }>; lang: "fr" | "en"; onChange: (v: string) => void; onPlay: () => void;
}) => (
  <div className={styles.soundRow}>
    <label className={styles.soundLabel}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.key} value={o.key}>{lang === "fr" ? o.fr : o.en}</option>)}
      </select>
    </label>
    <button className={styles.play} onClick={onPlay} aria-label={lang === "fr" ? "Écouter" : "Play"}>▶</button>
  </div>
);
