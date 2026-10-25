import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  acceptCall, declineCall, getCallMedia, getCallState, hangUp, inviteToCall, MAX_PARTICIPANTS, onCallMedia, onCallState,
  switchCamera, toggleCamera, toggleMute, toggleSpeaker, type CallMedia, type CallState,
} from "../lib/calls";
import { useG37 } from "../helpers/useG37";
import { PeoplePicker } from "./PeoplePicker";
import styles from "./CallOverlay.module.css";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

const Svg = ({ children, w = 2 }: { children: ReactNode; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const MicIcon = ({ off }: { off: boolean }) => <Svg><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />{off && <path d="M4 4l16 16" />}</Svg>;
const SpeakerIcon = () => <Svg><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></Svg>;
const AddIcon = () => <Svg><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></Svg>;
const HangIcon = () => <Svg w={2.2}><path d="M3 14c5-5 13-5 18 0l-2 3-4-1v-3a9 9 0 0 0-6 0v3l-4 1z" /></Svg>;
const PhoneIcon = () => <Svg w={2.2}><path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></Svg>;
const CloseIcon = () => <Svg w={2.4}><path d="M18 6L6 18M6 6l12 12" /></Svg>;
const CamIcon = ({ off }: { off?: boolean }) => <Svg><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" />{off && <path d="M3 3l18 18" />}</Svg>;
const FlipIcon = () => <Svg><path d="M4 7h11a4 4 0 0 1 4 4v1M20 17H9a4 4 0 0 1-4-4v-1" /><path d="M17 9l2 2 2-2M7 15l-2-2-2 2" /></Svg>;

const STATUS: Record<string, string> = { ringing: "sonne…", connecting: "connexion…", connected: "en ligne", left: "parti", declined: "a refusé" };
const VIA: Record<string, string> = { internet: "Par Internet", wifi: "Sans Internet · Wi-Fi local", proche: "Sans Internet · Bluetooth" };

/** Vidéo d'un flux (muette : le son passe par l'élément audio de l'appel). */
const StreamVideo = ({ stream, mirror, className }: { stream: MediaStream; mirror?: boolean; className?: string }) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    void v.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted style={mirror ? { transform: "scaleX(-1)" } : undefined} />;
};

function useCallMedia(): CallMedia & { tick: number } {
  const [tick, setTick] = useState(0);
  useEffect(() => onCallMedia(() => setTick((n) => n + 1)), []);
  return { ...getCallMedia(), tick };
}

const hasLiveVideo = (s: MediaStream | null | undefined) => !!s && s.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);

// Écran d'appel (entrant, sortant, en cours ; voix ou vidéo ; à deux ou en groupe), par-dessus toute l'app.
export const CallOverlay = () => {
  const [s, setS] = useState<CallState>(getCallState());
  const [now, setNow] = useState(Date.now());
  const [adding, setAdding] = useState(false);
  const [hideControls, setHideControls] = useState(false);
  const { state } = useG37();
  const m = useCallMedia();
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
    s.phase === "incoming" ? (s.video ? (s.group ? "Appel vidéo de groupe" : "Appel vidéo entrant") : s.group ? "Appel de groupe entrant" : "Appel entrant")
      : s.phase === "outgoing" ? "Ça sonne…"
        : s.phase === "active" ? `${clock}${s.group ? ` · ${connected + 1} en ligne` : ""}`
          : s.reason ?? "Appel terminé";
  const big = s.phase === "incoming" ? { id: s.inviterId, name: s.inviterName } : others.length === 1 ? { id: others[0].userId, name: others[0].name } : null;
  const canAdd = s.via === "internet" && (s.phase === "active" || s.phase === "outgoing") && others.length + 1 < MAX_PARTICIPANTS;
  const live = s.phase === "active" || s.phase === "outgoing";

  // Images : flux WebRTC (Internet / Wi-Fi) ou images allégées (Bluetooth).
  const remoteOf = (id: number) => (m.remoteCam.get(id) === false ? null : m.remote.get(id) ?? null);
  const liteOf = (id: number) => m.lite.get(id) ?? null;
  const localVideo = s.video && s.cameraOn && hasLiveVideo(m.local) ? m.local : null;
  const bigRemote = big ? remoteOf(big.id) : null;
  const bigLite = big ? liteOf(big.id) : null;
  const fullVideo = live && !!big && (hasLiveVideo(bigRemote) || !!bigLite);
  const mirror = s.facing === "user";

  const tileMedia = (id: number, name: string) => {
    const r = remoteOf(id);
    if (hasLiveVideo(r)) return <StreamVideo stream={r!} className={styles.tileVideo} />;
    const lite = liteOf(id);
    if (lite) return <img className={styles.tileVideo} src={lite} alt="" />;
    return avatarOf.get(id) ? <img className={styles.tileAvatar} src={avatarOf.get(id)!} alt="" /> : <span className={styles.tileAvatar}>{initials(name)}</span>;
  };

  return (
    <div className={`${styles.overlay} ${fullVideo ? styles.videoMode : ""}`} role="dialog" aria-modal="true" aria-label={`Appel : ${title}`}
      onClick={() => { if (fullVideo) setHideControls((h) => !h); }}>
      {fullVideo && (
        <div className={styles.stage}>
          {hasLiveVideo(bigRemote) ? <StreamVideo stream={bigRemote!} className={styles.stageVideo} /> : <img className={styles.stageVideo} src={bigLite!} alt="" />}
        </div>
      )}
      {localVideo && live && (
        <div className={styles.selfView} onClick={(e) => e.stopPropagation()}>
          <StreamVideo stream={localVideo} mirror={mirror} className={styles.selfVideo} />
        </div>
      )}

      <div className={`${styles.via} ${hideControls ? styles.faded : ""}`}>{VIA[s.via] ?? ""}{s.muted ? " · micro coupé" : ""}</div>

      <div className={styles.center} style={fullVideo ? { visibility: hideControls ? "hidden" : "visible", justifyContent: "flex-start" } : undefined}>
        {!fullVideo && (big ? (
          avatarOf.get(big.id) ? <img className={styles.avatar} src={avatarOf.get(big.id)!} alt="" /> : <div className={styles.avatar}>{initials(big.name)}</div>
        ) : (
          <div className={styles.grid}>
            {others.slice(0, 24).map((p) => (
              <div key={p.userId} className={`${styles.tile} ${p.status === "connected" ? styles.tileOn : ""}`}>
                {tileMedia(p.userId, p.name)}
                <span className={styles.tileName}>{p.name.split(" ")[0]}</span>
                <span className={styles.tileStatus}>{STATUS[p.status] ?? ""}</span>
              </div>
            ))}
          </div>
        ))}
        <div className={`${styles.name} ${fullVideo ? styles.shadowText : ""}`}>{title}</div>
        <div className={`${styles.state} ${fullVideo ? styles.shadowText : ""}`} aria-live="polite">{label}</div>
        {big && s.phase === "active" && !s.group && others[0] && others[0].status !== "connected" && (
          <div className={styles.state}>{STATUS[others[0].status]}</div>
        )}
        {s.phase === "incoming" && s.via !== "internet" && (
          <div className={styles.hint}>{s.via === "wifi" ? "Appel reçu par le Wi-Fi local, sans Internet." : "Appel reçu par Bluetooth, sans Internet. Restez à quelques dizaines de mètres."}</div>
        )}
      </div>

      {s.phase === "incoming" ? (
        <div className={styles.answerRow}>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${styles.decline}`} onClick={declineCall} aria-label="Refuser"><CloseIcon /></button>
            <span>Refuser</span>
          </div>
          {s.video && (
            <div className={styles.labeled}>
              <button className={`${styles.round} ${styles.off}`} onClick={() => void acceptCall(false)} aria-label="Répondre sans caméra"><PhoneIcon /></button>
              <span>Sans caméra</span>
            </div>
          )}
          <div className={styles.labeled}>
            <button className={`${styles.round} ${styles.accept} ${styles.pulse}`} onClick={() => void acceptCall()} aria-label={s.video ? "Répondre en vidéo" : "Répondre"}>
              {s.video ? <CamIcon /> : <PhoneIcon />}
            </button>
            <span>{s.video ? "Vidéo" : "Répondre"}</span>
          </div>
        </div>
      ) : s.phase !== "ended" ? (
        <div className={`${styles.controls} ${hideControls ? styles.faded : ""}`} onClick={(e) => e.stopPropagation()}>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${s.muted ? styles.on : styles.off}`} onClick={toggleMute} aria-pressed={s.muted} aria-label={s.muted ? "Réactiver le micro" : "Couper le micro"}><MicIcon off={s.muted} /></button>
            <span>{s.muted ? "Muet" : "Micro"}</span>
          </div>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${s.speaker ? styles.on : styles.off}`} onClick={toggleSpeaker} aria-pressed={s.speaker} aria-label="Haut-parleur"><SpeakerIcon /></button>
            <span>Haut-parleur</span>
          </div>
          <div className={styles.labeled}>
            <button className={`${styles.round} ${s.video && s.cameraOn ? styles.on : styles.off}`} aria-pressed={s.video && s.cameraOn}
              onClick={() => void toggleCamera().catch((e) => toast.error(e instanceof Error ? e.message : "Caméra indisponible"))}
              aria-label={s.video && s.cameraOn ? "Couper la caméra" : "Allumer la caméra"}><CamIcon off={!(s.video && s.cameraOn)} /></button>
            <span>Caméra</span>
          </div>
          {s.video && s.cameraOn ? (
            <div className={styles.labeled}>
              <button className={`${styles.round} ${styles.off}`} onClick={() => void switchCamera().catch(() => toast.error("Impossible de changer de caméra"))} aria-label="Changer de caméra"><FlipIcon /></button>
              <span>Retourner</span>
            </div>
          ) : (
            <div className={styles.labeled}>
              <button className={`${styles.round} ${styles.off}`} disabled={!canAdd} onClick={() => setAdding(true)} aria-label="Ajouter des collègues"><AddIcon /></button>
              <span>Ajouter</span>
            </div>
          )}
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
