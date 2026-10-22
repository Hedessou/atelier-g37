import { useEffect, useState } from "react";
import { acceptCall, declineCall, getCallState, hangUp, onCallState, toggleMute, toggleSpeaker, type CallState } from "../lib/calls";
import styles from "./CallOverlay.module.css";

// Écran d'appel (entrant, sortant, en cours), par-dessus toute l'app.
export const CallOverlay = () => {
  const [s, setS] = useState<CallState>(getCallState());
  const [now, setNow] = useState(Date.now());
  useEffect(() => onCallState(setS), []);
  useEffect(() => {
    if (s.phase !== "active") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [s.phase]);
  if (s.phase === "idle") return null;

  const secs = s.startedAt ? Math.max(0, Math.round((now - s.startedAt) / 1000)) : 0;
  const clock = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  const label =
    s.phase === "incoming" ? "Appel entrant"
      : s.phase === "outgoing" ? "Appel en cours…"
        : s.phase === "active" ? clock
          : s.reason ?? "Appel terminé";
  const initials = s.peerName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Appel avec ${s.peerName}`}>
      <div className={styles.via}>{s.via === "proche" ? "À proximité · Bluetooth / Wi-Fi" : "Par Internet"}</div>
      <div className={styles.avatar}>{initials}</div>
      <div className={styles.name}>{s.peerName}</div>
      <div className={styles.state} aria-live="polite">{label}</div>
      <div className={styles.actions}>
        {s.phase === "incoming" ? (
          <>
            <button className={`${styles.round} ${styles.decline}`} onClick={declineCall} aria-label="Refuser">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
            <button className={`${styles.round} ${styles.accept}`} onClick={() => void acceptCall()} aria-label="Répondre">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
            </button>
          </>
        ) : s.phase !== "ended" ? (
          <>
            <button className={`${styles.round} ${s.muted ? styles.on : styles.off}`} onClick={toggleMute} aria-pressed={s.muted} aria-label={s.muted ? "Réactiver le micro" : "Couper le micro"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />{s.muted && <path d="M4 4l16 16" />}</svg>
            </button>
            <button className={`${styles.round} ${styles.decline}`} onClick={hangUp} aria-label="Raccrocher">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14c5-5 13-5 18 0l-2 3-4-1v-3a9 9 0 0 0-6 0v3l-4 1z" /></svg>
            </button>
            {s.via === "proche" && (
              <button className={`${styles.round} ${s.speaker ? styles.on : styles.off}`} onClick={toggleSpeaker} aria-pressed={s.speaker} aria-label="Haut-parleur">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></svg>
              </button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
};
