import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { acceptCall, declineCall, getCallState, hangUp, inviteToCall, MAX_PARTICIPANTS, onCallState, toggleMute, toggleSpeaker, type CallState } from "../lib/calls";
import { useG37 } from "../helpers/useG37";
import { PeoplePicker } from "./PeoplePicker";
import styles from "./CallOverlay.module.css";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

const MicIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />{off && <path d="M4 4l16 16" />}</svg>
);
const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></svg>
);
const AddIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></svg>
);
const HangIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14c5-5 13-5 18 0l-2 3-4-1v-3a9 9 0 0 0-6 0v3l-4 1z" /></svg>
);
const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
);

const STATUS: Record<string, string> = { ringing: "sonne…", connecting: "connexion…", connected: "en ligne", left: "parti", declined: "a refusé" };

// Écran d'appel (entrant, sortant, en cours ; à deux ou en groupe), par-dessus toute l'app.
export const CallOverlay = () => {
  const [s, setS] = useState<CallState>(getCallState());
  const [now, setNow] = useState(Date.now());
  const [adding, setAdding] = useState(false);
  const { state } = useG37();
  useEffect(() => onCallState(setS), []);
  useEffect(() => {
    if (s.phase !== "active") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [s.phase]);
  const avatarOf = useMemo(() => new Map((state?.users ?? []).map((u) => [u.id, u.avatarUrl ?? null])), [state?.users]);
  if (s.phase === "idle") return null;

  const secs = s.startedAt ? Math.max(0, Math.round((now - s.startedAt) / 1000)) : 0;
  const clock = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  const others = s.participants.filter((p) => p.status !== "left");
  const connected = others.filter((p) => p.status === "connected").length;
  const title = s.phase === "incoming"
    ? s.inviterName
    : s.group ? `Appel de groupe · ${others.length + 1}` : others[0]?.name ?? s.inviterName;
  const label =
    s.phase === "incoming" ? (s.group ? "Appel de groupe entrant" : "Appel entrant")
      : s.phase === "outgoing" ? "Ça sonne…"
        : s.phase === "active" ? `${clock}${s.group ? ` · ${connected + 1} en ligne` : ""}`
          : s.reason ?? "Appel terminé";
  const big = s.phase === "incoming" ? { id: s.inviterId, name: s.inviterName } : others.length === 1 ? { id: others[0].userId, name: others[0].name } : null;
  const canAdd = s.via === "internet" && (s.phase === "active" || s.phase === "outgoing") && others.length + 1 < MAX_PARTICIPANTS;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Appel : ${title}`}>
      <div className={styles.via}>{s.via === "proche" ? "Sans Internet · Bluetooth / Wi-Fi" : "Par Internet"}{s.muted ? " · micro coupé" : ""}</div>
      <div className={styles.center}>
        {big ? (
          avatarOf.get(big.id) ? <img className={styles.avatar} src={avatarOf.get(big.id)!} alt="" /> : <div className={styles.avatar}>{initials(big.name)}</div>
        ) : (
          <div className={styles.grid}>
            {others.slice(0, 24).map((p) => (
              <div key={p.userId} className={`${styles.tile} ${p.status === "connected" ? styles.tileOn : ""}`}>
                {avatarOf.get(p.userId) ? <img className={styles.tileAvatar} src={avatarOf.get(p.userId)!} alt="" /> : <span className={styles.tileAvatar}>{initials(p.name)}</span>}
                <span className={styles.tileName}>{p.name.split(" ")[0]}</span>
                <span className={styles.tileStatus}>{STATUS[p.status] ?? ""}</span>
              </div>
            ))}
          </div>
        )}
        <div className={styles.name}>{title}</div>
        <div className={styles.state} aria-live="polite">{label}</div>
        {big && s.phase === "active" && s.group === false && others[0] && others[0].status !== "connected" && (
          <div className={styles.state}>{STATUS[others[0].status]}</div>
        )}
      </div>

      {s.phase === "incoming" ? (
        <div className={styles.answerRow}>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${styles.decline}`} onClick={declineCall} aria-label="Refuser"><CloseIcon /></button>
            <span>Refuser</span>
          </div>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${styles.accept} ${styles.pulse}`} onClick={() => void acceptCall()} aria-label="Répondre"><PhoneIcon /></button>
            <span>Répondre</span>
          </div>
        </div>
      ) : s.phase !== "ended" ? (
        <div className={styles.controls}>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${s.muted ? styles.on : styles.off}`} onClick={toggleMute} aria-pressed={s.muted} aria-label={s.muted ? "Réactiver le micro" : "Couper le micro"}><MicIcon off={s.muted} /></button>
            <span>{s.muted ? "Muet" : "Micro"}</span>
          </div>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${s.speaker ? styles.on : styles.off}`} onClick={toggleSpeaker} aria-pressed={s.speaker} aria-label="Haut-parleur"><SpeakerIcon /></button>
            <span>Haut-parleur</span>
          </div>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${styles.off}`} disabled={!canAdd} onClick={() => setAdding(true)} aria-label="Ajouter des collègues"><AddIcon /></button>
            <span>Ajouter</span>
          </div>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${styles.decline}`} onClick={hangUp} aria-label="Raccrocher"><HangIcon /></button>
            <span>Raccrocher</span>
          </div>
        </div>
      ) : null}

      <PeoplePicker
        open={adding}
        onOpenChange={setAdding}
        people={(state?.users ?? []).filter((u) => u.id !== state?.me.id)}
        exclude={s.participants.filter((p) => p.status !== "left" && p.status !== "declined").map((p) => p.userId)}
        max={Math.max(1, MAX_PARTICIPANTS - 1 - others.length)}
        title="Ajouter à l'appel"
        confirmLabel="Inviter"
        onConfirm={(ids) => {
          const people = ids.map((id) => ({ userId: id, name: state?.users.find((u) => u.id === id)?.displayName ?? "Collègue" }));
          void inviteToCall(people).catch((e) => toast.error(e instanceof Error ? e.message : "Invitation impossible"));
        }}
      />
    </div>
  );
};
