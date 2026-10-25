import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import { Nearby, nativeSoundsAvailable, nativeV4Available, nearbyAvailable, type NetworkStatus, type SettingKey, type SystemStatus } from "../lib/nearby";
import { getPeers, peersChanged, reachableEnabled, requestP2PPermissions, setReachable, startP2P, type Peer } from "../lib/p2p";
import styles from "./SettingsView.module.css";
import g from "./ConnectGuide.module.css";

type Props = { state: State; lang: "fr" | "en"; onBack: () => void };

// Guide de réglage : connexion automatique entre les téléphones de l'atelier sans Internet
// (Bluetooth, Wi-Fi sans Internet, point d'accès), avec l'état en direct de ce téléphone.
export const ConnectGuide = ({ state, lang, onBack }: Props) => {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [net, setNet] = useState<NetworkStatus | null>(null);
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [peers, setPeers] = useState<Peer[]>(getPeers());
  const [native, setNative] = useState<boolean | null>(null);
  const [reach, setReach] = useState(reachableEnabled());

  const refresh = useCallback(async () => {
    const v4 = await nativeV4Available();
    setNative(v4);
    if (await nativeSoundsAvailable()) setSys(await Nearby.getSystemStatus().catch(() => null));
    if (v4) setNet(await Nearby.getNetworkStatus().catch(() => null));
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);
  useEffect(() => peersChanged.on(setPeers), []);

  const open = async (which: SettingKey) => {
    await Nearby.openSystemSetting({ which }).catch(() => toast.error(t("Réglage introuvable sur ce téléphone : ouvre-le à la main.", "Setting not found on this phone: open it manually.")));
  };
  const Btn = ({ which, children }: { which: SettingKey; children: string }) =>
    native ? <button className={styles.small} onClick={() => void open(which)}>{children}</button> : null;

  const linked = peers.filter((p) => p.connected);
  const names = (list: Peer[]) => [...new Set(list.map((p) => state.users.find((u) => u.id === p.userId)?.displayName ?? t("Collègue", "Colleague")))];
  const wifiPeers = linked.filter((p) => p.medium === "wifi");
  const btPeers = linked.filter((p) => p.medium !== "wifi" && !wifiPeers.some((w) => w.userId === p.userId));
  const brand = (net?.manufacturer || sys?.manufacturer || "").toLowerCase();
  const transsion = /tecno|infinix|itel/.test(brand);

  const Status = ({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) => (
    <div className={styles.permRow}>
      <span className={`${styles.dot} ${ok ? styles.dotOk : styles.dotWarn}`} aria-hidden="true" />
      <span className={styles.permText}><strong>{label}</strong>{detail && <span className={styles.help}>{detail}</span>}</span>
    </div>
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <button className={styles.back} onClick={onBack} aria-label={t("Retour", "Back")}>‹</button>
        <h1 className={styles.h1}>{t("Connexion sans Internet", "Offline connection")}</h1>
      </div>

      <section className={styles.card}>
        <h2 className={styles.h2}>{t("Ce téléphone en ce moment", "This phone right now")}</h2>
        {!nearbyAvailable() && <p className={styles.note}>{t("Ouvre l'application installée (APK) sur le téléphone pour voir l'état.", "Open the installed app (APK) on the phone to see the status.")}</p>}
        {nearbyAvailable() && native === false && <p className={styles.note}>{t("Installe la nouvelle version de l'app (APK 4) : connexion Wi-Fi locale, appels vidéo et réception app fermée.", "Install the new app (APK 4): local Wi-Fi, video calls and reception while closed.")}</p>}
        {sys && <Status ok={sys.bluetooth} label={t("Bluetooth", "Bluetooth")} detail={sys.bluetooth ? t("Allumé", "On") : t("Éteint : les collègues proches ne te trouvent pas", "Off: nearby colleagues can't find you")} />}
        {sys && <Status ok={sys.nearby} label={t("Appareils à proximité", "Nearby devices")} detail={sys.nearby ? t("Autorisé", "Allowed") : t("Non autorisé", "Not allowed")} />}
        {net && (
          <Status ok={net.wifiConnected || net.hotspot}
            label={net.hotspot ? t("Point d'accès allumé", "Hotspot on") : net.wifiConnected ? `Wi-Fi${net.ssid ? ` « ${net.ssid} »` : ""}` : t("Pas de Wi-Fi", "No Wi-Fi")}
            detail={net.hotspot ? t("Les collègues peuvent se connecter à ce téléphone", "Colleagues can connect to this phone")
              : net.wifiConnected ? (net.wifiInternet ? t("avec Internet", "with Internet") : t("sans Internet : parfait pour l'atelier", "without Internet: fine for the workshop"))
                : t("Bluetooth seulement (voix et messages, vidéo allégée)", "Bluetooth only (voice and messages, light video)")} />
        )}
        {net && <Status ok={net.lanRunning} label={t("Recherche sur le Wi-Fi local", "Local Wi-Fi search")} detail={net.lanRunning ? t("Active", "Active") : t("Arrêtée (ouvre Messages ou active « Toujours joignable »)", "Stopped (open Messages or enable “Always reachable”)")} />}
        <Status ok={linked.length > 0} label={t(`${wifiPeers.length + btPeers.length} collègue(s) relié(s)`, `${wifiPeers.length + btPeers.length} colleague(s) linked`)}
          detail={[
            wifiPeers.length ? `Wi-Fi : ${names(wifiPeers).join(", ")}` : "",
            btPeers.length ? `Bluetooth : ${names(btPeers).join(", ")}` : "",
          ].filter(Boolean).join(" · ") || t("Personne pour l'instant", "Nobody yet")} />
        <div className={g.btnRow}>
          <Btn which="bluetoothSettings">{t("Bluetooth", "Bluetooth")}</Btn>
          <Btn which="wifi">Wi-Fi</Btn>
          <Btn which="hotspot">{t("Point d'accès", "Hotspot")}</Btn>
          {sys && !sys.nearby && <button className={styles.small} onClick={async () => { await requestP2PPermissions(); await startP2P({ id: state.me.id, pending: state.me.pending }).catch(() => {}); void refresh(); }}>{t("Autoriser", "Allow")}</button>}
        </div>
        {native && (
          <label className={styles.switchRow}>
            <span><strong>{t("Toujours joignable sans Internet", "Always reachable offline")}</strong>
              <span className={styles.help}>{t("Recevoir appels, messages et pannes des collègues proches même app fermée.", "Receive calls, messages and faults from nearby colleagues even when closed.")}</span></span>
            <input type="checkbox" checked={reach} onChange={(e) => { setReach(e.target.checked); void setReachable(e.target.checked); }} />
          </label>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>{t("Comment ça marche", "How it works")}</h2>
        <p className={styles.note}>
          {t("L'app relie toute seule les téléphones de l'atelier, sans appairage ni code : elle choisit le meilleur chemin disponible.",
            "The app links the workshop phones by itself, without pairing or code: it picks the best available path.")}
        </p>
        <div className={g.table}>
          <div className={g.th}>{t("Chemin", "Path")}</div><div className={g.th}>{t("Portée", "Range")}</div><div className={g.th}>{t("Possible", "Works for")}</div>
          <div>Internet</div><div>{t("partout", "anywhere")}</div><div>{t("tout, appels de groupe (25)", "everything, group calls (25)")}</div>
          <div>{t("Même Wi-Fi / point d'accès", "Same Wi-Fi / hotspot")}</div><div>{t("tout le bâtiment du Wi-Fi", "Wi-Fi coverage")}</div><div>{t("voix + vidéo HD, synchro rapide, mises à jour", "voice + HD video, fast sync, updates")}</div>
          <div>Bluetooth</div><div>{t("10 à 30 m", "10 to 30 m")}</div><div>{t("voix, messages, pannes, vidéo allégée", "voice, messages, faults, light video")}</div>
        </div>
      </section>

      <details className={`${styles.card} ${g.details}`} open>
        <summary className={g.summary}>{t("1 · Bluetooth — automatique", "1 · Bluetooth — automatic")}</summary>
        <ol className={g.steps}>
          <li>{t("Allume le Bluetooth (et la Localisation sur Android 12 ou plus ancien).", "Turn on Bluetooth (and Location on Android 12 or older).")} <Btn which="bluetooth">{t("Allumer", "Turn on")}</Btn></li>
          <li>{t("Autorise « Appareils à proximité » quand l'app le demande.", "Allow “Nearby devices” when the app asks.")}</li>
          <li>{t("N'appaire pas les téléphones dans les réglages Bluetooth : ce n'est pas nécessaire, l'app s'en charge.", "Don't pair phones in Bluetooth settings: not needed, the app handles it.")}</li>
          <li>{t("Les collègues à portée apparaissent avec un point bleu dans Messages. Ils échangent les données toutes les 15 à 120 min (Paramètres), et tout de suite quand l'app est ouverte.", "Colleagues in range show a blue dot in Messages. Data is exchanged every 15–120 min (Settings), and instantly when the app is open.")}</li>
        </ol>
      </details>

      <details className={`${styles.card} ${g.details}`}>
        <summary className={g.summary}>{t("2 · Wi-Fi de l'atelier sans Internet (box, routeur)", "2 · Workshop Wi-Fi without Internet (router)")}</summary>
        <ol className={g.steps}>
          <li>{t("Connecte tous les téléphones au même Wi-Fi. Pas besoin d'abonnement Internet : un simple routeur allumé suffit.", "Connect all phones to the same Wi-Fi. No Internet plan needed: a powered router is enough.")} <Btn which="wifi">Wi-Fi</Btn></li>
          <li>{t("Quand Android affiche « Ce réseau n'a pas accès à Internet », choisis « Rester connecté » / « Oui » et coche « Ne plus demander ».", "When Android says “This network has no Internet access”, choose “Stay connected” / “Yes” and tick “Don't ask again”.")}</li>
          <li>{t("Dans les réglages du réseau Wi-Fi : active « Connexion automatique » et désactive « Basculer vers les données mobiles » (Samsung), « Wi-Fi+ » / « Assistant réseau » (Tecno, Infinix, Huawei).", "In the Wi-Fi network settings: turn on “Auto-connect” and turn off “Switch to mobile data” (Samsung), “Wi-Fi+” / “Network assistant” (Tecno, Infinix, Huawei).")}</li>
          <li>{t("Sur le routeur, l'« isolation des clients » (AP isolation) doit être désactivée, sinon les téléphones ne se voient pas.", "On the router, “client isolation” (AP isolation) must be off, otherwise phones can't see each other.")}</li>
          <li>{t("C'est tout : dès qu'un téléphone arrive sur ce Wi-Fi, il se relie aux autres en quelques secondes (appels vidéo possibles).", "That's it: when a phone joins this Wi-Fi, it links to the others within seconds (video calls work).")}</li>
        </ol>
      </details>

      <details className={`${styles.card} ${g.details}`}>
        <summary className={g.summary}>{t("3 · Point d'accès d'un téléphone (sans box)", "3 · A phone's hotspot (no router)")}</summary>
        <ol className={g.steps}>
          <li>{t("Choisis un téléphone « base » (chef d'équipe, bien chargé). Réglages → Point d'accès et partage de connexion → Point d'accès mobile.", "Pick a “base” phone (team lead, charged). Settings → Hotspot & tethering → Mobile hotspot.")} <Btn which="hotspot">{t("Ouvrir", "Open")}</Btn></li>
          <li>{t("Donne un nom simple et toujours le même, par exemple ATELIER-G37, et un mot de passe connu de l'équipe. Désactive « Éteindre automatiquement » si l'option existe.", "Use a simple, fixed name such as ATELIER-G37 and a password known to the team. Turn off “Turn off automatically” if available.")}</li>
          <li>{t("Sur chaque autre téléphone, connecte-toi une seule fois à ATELIER-G37 et laisse « Connexion automatique » activée. Ensuite le téléphone s'y reconnecte tout seul dès que le point d'accès est allumé.", "On each other phone, join ATELIER-G37 once and keep “Auto-connect” on. After that it reconnects by itself whenever the hotspot is on.")}</li>
          <li>{t("Astuce équipe jour / nuit : configure le même nom et le même mot de passe sur deux téléphones « base ». Les autres se connectent automatiquement à celui qui est allumé.", "Day/night tip: set the same name and password on two “base” phones. Others auto-connect to whichever is on.")}</li>
          <li>{t("Les données mobiles du téléphone base peuvent rester coupées. Si elles sont allumées, les autres auront aussi Internet (attention au forfait).", "The base phone's mobile data can stay off. If on, others also get Internet (mind the data plan).")}</li>
        </ol>
      </details>

      <details className={`${styles.card} ${g.details}`} open>
        <summary className={g.summary}>{t("4 · Recevoir appels, messages et pannes app fermée", "4 · Receive calls, messages and faults when closed")}</summary>
        <ol className={g.steps}>
          <li>{t("Notifications autorisées, « Écran d'appel plein écran » autorisé (Android 14).", "Notifications allowed, “Full-screen call screen” allowed (Android 14).")} <Btn which="notifications">{t("Notifications", "Notifications")}</Btn> <Btn which="fullScreen">{t("Plein écran", "Full screen")}</Btn></li>
          <li>{t("Batterie : « Sans restriction » / « Ne pas optimiser ».", "Battery: “Unrestricted” / “Don't optimise”.")} <Btn which="battery">{t("Batterie", "Battery")}</Btn></li>
          <li>{transsion
            ? t("Tecno / Infinix / itel : Phone Master → Gestion du démarrage auto → active Spinning R/F. Dans Batterie → « Gestion des applis en arrière-plan », mets l'app en « Autoriser ».", "Tecno / Infinix / itel: Phone Master → Auto-start management → enable Spinning R/F. In Battery → background app management, set the app to “Allow”.")
            : t("Démarrage automatique : Xiaomi (Sécurité → Autorisations → Démarrage auto), Oppo / Realme / Vivo (Gestion des applis → Démarrage auto), Samsung (Batterie → Applis jamais en veille), Tecno / Infinix (Phone Master → Démarrage auto).", "Auto-start: Xiaomi (Security → Permissions → Autostart), Oppo / Realme / Vivo (App management → Auto-start), Samsung (Battery → Never sleeping apps), Tecno / Infinix (Phone Master → Auto-start).")}
            {" "}<Btn which="autostart">{t("Démarrage auto", "Auto-start")}</Btn></li>
          <li>{t("Ne ferme pas l'app en la balayant dans la liste des applis récentes : sur beaucoup de téléphones, cela bloque les appels. Tu peux la « verrouiller » (cadenas) dans cette liste.", "Don't swipe the app away from recent apps: on many phones that blocks calls. You can “lock” it (padlock) in that list.")}</li>
          <li>{t("Laisse « Toujours joignable sans Internet » activé (ci-dessus). Une petite notification « Spinning R/F » reste affichée : c'est normal, Android l'exige.", "Keep “Always reachable offline” on (above). A small “Spinning R/F” notification stays visible: that's normal, Android requires it.")}</li>
          <li>{t("Chaque collègue doit ouvrir une fois la nouvelle version avec Internet (enregistrement du téléphone pour les messages chiffrés).", "Each colleague must open the new version once with Internet (phone registration for encrypted messages).")}</li>
        </ol>
      </details>

      <details className={`${styles.card} ${g.details}`}>
        <summary className={g.summary}>{t("5 · Tester en 1 minute", "5 · Test in 1 minute")}</summary>
        <ol className={g.steps}>
          <li>{t("Mets deux téléphones en mode avion, puis rallume seulement le Bluetooth (ou le Wi-Fi sans Internet).", "Put two phones in airplane mode, then turn back on only Bluetooth (or the offline Wi-Fi).")}</li>
          <li>{t("Ouvre Messages sur les deux : chacun doit voir l'autre avec un point bleu (« à portée » ou « même Wi-Fi »), et ce guide affiche « 1 collègue relié ».", "Open Messages on both: each should see the other with a blue dot (“nearby” or “same Wi-Fi”), and this guide shows “1 colleague linked”.")}</li>
          <li>{t("Envoie un message, puis fais un appel. Ferme l'app sur l'un des deux et rappelle-le : l'écran d'appel doit s'afficher et sonner.", "Send a message, then call. Close the app on one phone and call it again: the call screen should show and ring.")}</li>
        </ol>
      </details>
    </div>
  );
};
