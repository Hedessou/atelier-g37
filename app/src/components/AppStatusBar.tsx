import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./Button";
import { useOnline } from "../lib/net";
import { syncNow, usePendingCount } from "../helpers/useG37";
import { applyUpdateNow, getUpdateStatus, installNativeUpdate, onUpdateStatus, type UpdateStatus } from "../lib/updater";
import { getP2PStatus, getPeers, p2pStatus, peersChanged } from "../lib/p2p";
import { toast } from "sonner";
import styles from "./AppStatusBar.module.css";

// Bandeau d'état : hors ligne, actions en attente d'envoi, mise à jour disponible.
export const AppStatusBar = ({ lang }: { lang: "fr" | "en" }) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const online = useOnline();
  const pending = usePendingCount();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>(getUpdateStatus());
  useEffect(() => onUpdateStatus(setUpdate), []);
  const [near, setNear] = useState(() => getPeers().filter((p) => p.connected).length);
  const [lastExchange, setLastExchange] = useState<number | null>(getP2PStatus().lastExchange);
  useEffect(() => {
    const a = peersChanged.on((list) => setNear(list.filter((p) => p.connected).length));
    const b = p2pStatus.on((s) => setLastExchange(s.lastExchange));
    return () => { a(); b(); };
  }, []);
  const ago = (ms: number) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? t("à l'instant", "just now") : t(`il y a ${m} min`, `${m} min ago`); };

  // Envoi automatique dès que le réseau revient, puis toutes les 30 s tant qu'il reste des actions.
  useEffect(() => {
    if (!online || pending === 0) return;
    void syncNow(queryClient);
    const id = setInterval(() => void syncNow(queryClient), 30_000);
    return () => clearInterval(id);
  }, [online, pending, queryClient]);

  const items: React.ReactElement[] = [];
  if (!online) {
    items.push(
      <div key="off" className={`${styles.bar} ${styles.offline}`}>
        <span className={styles.dot} />
        <span>
          {t("Hors ligne — tu peux continuer à travailler.", "Offline — you can keep working.")}
          {near > 0
            ? ` ${t(`Synchro avec ${near} téléphone(s) proche(s)`, `Syncing with ${near} nearby phone(s)`)}${lastExchange ? ` · ${ago(lastExchange)}` : ""}.`
            : pending > 0 && ` ${t(`${pending} action(s) partiront au retour du réseau ou via un collègue proche.`, `${pending} action(s) will leave when back online or through a nearby colleague.`)}`}
        </span>
      </div>,
    );
  } else if (pending > 0) {
    items.push(
      <div key="pending" className={`${styles.bar} ${styles.pending}`}>
        <span className={styles.dot} />
        <span>{t(`Synchronisation de ${pending} action(s)…`, `Syncing ${pending} action(s)…`)}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { await syncNow(queryClient); } finally { setBusy(false); } }}>
          {t("Envoyer", "Send")}
        </Button>
      </div>,
    );
  }
  if (update.kind === "ready") {
    items.push(
      <div key="upd" className={`${styles.bar} ${styles.update}`}>
        <span>{t(`Nouvelle version prête (${update.version}). Elle s'installera au prochain démarrage.`, `New version ready (${update.version}). It will install on next start.`)}</span>
        <Button size="sm" onClick={() => void applyUpdateNow()}>{t("Redémarrer", "Restart")}</Button>
      </div>,
    );
  }
  if (update.kind === "native") {
    items.push(
      <div key="native" className={`${styles.bar} ${update.required ? styles.offline : styles.update}`}>
        <span>
          {update.required
            ? t("Une mise à jour de l'application est nécessaire.", "An app update is required.")
            : t("Une nouvelle version de l'application est disponible.", "A new app version is available.")}
          {update.notes ? ` ${update.notes}` : ""}
        </span>
        {(update.viaStore || update.apkUrl || update.localApk) && (
          <Button size="sm" onClick={() => void installNativeUpdate().catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}>
            {update.viaStore ? t("Mettre à jour", "Update") : update.localApk ? t("Installer", "Install") : t("Télécharger", "Download")}
          </Button>
        )}
      </div>,
    );
  }
  if (!items.length) return null;
  return <div className={styles.wrap}>{items}</div>;
};
