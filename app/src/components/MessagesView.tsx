import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { g37 } from "../helpers/g37";
import {
  attachmentUrl, canWriteTo, hideDm, markRead, prepareAudio, prepareFile, prepareImage, previewOf, sendDm, unreadFrom, useDms,
  type Dm, type DmAttachment, type DmReply,
} from "../lib/dms";
import { callLog, joinRoom, listActiveRooms, MAX_PARTICIPANTS, onCallState, startCall, startGroupCall, type CallLog, type RoomInfo } from "../lib/calls";
import { PeoplePicker } from "./PeoplePicker";
import { getPeers, peersChanged, type Peer } from "../lib/p2p";
import { Nearby, nearbyAvailable } from "../lib/nearby";
import { useOnline } from "../lib/net";
import styles from "./MessagesView.module.css";

type Props = {
  state: State;
  lang: "fr" | "en";
  save: (input: InputType) => void;
  renderGroup: () => React.ReactNode;
  segment: "chats" | "calls";
  onSegment: (s: "chats" | "calls") => void;
  roleName: (key: string, fallback: string) => string;
  // Le groupe « Maintenance R/F » (postes de production : messages privés et appels seulement).
  showGroup?: boolean;
  openPeer?: number | null;
  onPeerOpened?: () => void;
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
const AVATAR_BG = ["#2b4566", "#3b3357", "#2f4a3b", "#4a3a24", "#4a2b3a", "#24434a"];
const avatarBg = (id: number) => AVATAR_BG[Math.abs(id) % AVATAR_BG.length];

const Svg = ({ children, w = 2 }: { children: React.ReactNode; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const PhoneIcon = () => <Svg><path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></Svg>;
const VideoIcon = () => <Svg><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" /></Svg>;
const GroupIcon = () => <Svg><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20a6 6 0 0 1 12 0M14 20a4.5 4.5 0 0 1 7-3.7" /></Svg>;
const BackIcon = () => <Svg w={2.2}><path d="M15 18l-6-6 6-6" /></Svg>;
const PlusIcon = () => <Svg w={2.4}><path d="M12 5v14M5 12h14" /></Svg>;
const NearIcon = () => <Svg><path d="M7 7l10 10-5 5V2l5 5L7 17" /></Svg>;
const SearchIcon = () => <Svg><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Svg>;
const ClipIcon = () => <Svg><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" /></Svg>;
const MicIcon = () => <Svg><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>;
const SendIcon = () => <Svg w={2.2}><path d="M4 12l16-8-6 16-2-7z" /></Svg>;
const CloseIcon = () => <Svg w={2.4}><path d="M18 6L6 18M6 6l12 12" /></Svg>;
const CamIcon = () => <Svg><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></Svg>;
const ImgIcon = () => <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 9" /></Svg>;
const FileIcon = () => <Svg><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /></Svg>;
const MissedIcon = () => <Svg><path d="M3 7l6 6 4-4 8 8" /><path d="M21 12v5h-5" /></Svg>;

function usePeers(): Peer[] {
  const [list, setList] = useState<Peer[]>(() => getPeers());
  useEffect(() => peersChanged.on(setList), []);
  return list;
}

function useCallLog(): CallLog[] {
  const [list, setList] = useState<CallLog[]>(() => callLog());
  useEffect(() => onCallState(() => setList(callLog())), []);
  return list;
}

type Presence = "wifi" | "near" | "online" | null;

export const MessagesView = ({ state, lang, save, renderGroup, segment, onSegment, roleName, showGroup = true, openPeer, onPeerOpened }: Props) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const me = state.me;
  const online = useOnline();
  const dms = useDms();
  const peers = usePeers();
  const calls = useCallLog();
  const [view, setView] = useState<{ kind: "list" } | { kind: "group" } | { kind: "dm"; peerId: number } | { kind: "new" }>({ kind: "list" });
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState<null | "voice" | "video">(null);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);

  // Ouverture directe d'une conversation (depuis une notification).
  useEffect(() => {
    if (openPeer) { setView({ kind: "dm", peerId: openPeer }); onPeerOpened?.(); }
  }, [openPeer, onPeerOpened]);

  // Appels de groupe en cours (on peut les rejoindre).
  useEffect(() => {
    if (segment !== "calls" || !online) return;
    let alive = true;
    const load = () => void listActiveRooms().then((r) => { if (alive) setRooms(r); }).catch(() => {});
    load();
    const id = setInterval(load, 10000);
    const off = onCallState(() => setTimeout(load, 1500));
    return () => { alive = false; clearInterval(id); off(); };
  }, [segment, online]);

  const users = useMemo(() => state.users.filter((u) => u.id !== me.id), [state.users, me.id]);
  const userById = useMemo(() => new Map(state.users.map((u) => [u.id, u])), [state.users]);
  const linked = peers.filter((p) => p.connected && p.userId != null);
  const wifiIds = new Set(linked.filter((p) => p.medium === "wifi").map((p) => p.userId as number));
  const nearIds = new Set(linked.map((p) => p.userId as number));
  const presence = (id: number): Presence => {
    if (wifiIds.has(id)) return "wifi";
    if (nearIds.has(id)) return "near";
    const seen = userById.get(id)?.lastSeen;
    return seen && Date.now() - new Date(seen).getTime() < 5 * 60000 ? "online" : null;
  };
  const nameOf = (id: number) => userById.get(id)?.displayName ?? t("Ancien membre", "Former member");

  // Conversations privées triées par dernier message.
  const threads = useMemo(() => {
    const last = new Map<number, Dm>();
    for (const d of dms) {
      const peer = d.from === me.id ? d.to : d.from;
      const prev = last.get(peer);
      if (!prev || prev.at < d.at) last.set(peer, d);
    }
    return [...last.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at));
  }, [dms, me.id]);

  const groupLast = state.chat?.[0];
  const call = async (peerId: number, name: string, video = false) => {
    try {
      await startCall(peerId, name, { video });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Appel impossible", "Call failed"));
    }
  };
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString() === d.toDateString();
    if (today) return d.toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
    if (yesterday) return t("Hier", "Yesterday");
    return d.toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" });
  };
  const roleOf = (id: number) => {
    const u = userById.get(id);
    if (!u) return "";
    return u.role === "admin" ? "Admin" : roleName(u.jobRole, g37.ROLES[u.jobRole]?.n ?? u.jobRole);
  };

  const Avatar = ({ id, name, big }: { id: number; name: string; big?: boolean }) => {
    const p = presence(id);
    const photo = userById.get(id)?.avatarUrl;
    return (
      <span className={`${styles.avatar} ${big ? styles.avatarBig : ""}`} style={{ background: avatarBg(id) }}>
        {photo ? <img className={styles.avatarImg} src={photo} alt="" /> : initials(name)}
        {p && <span className={`${styles.presence} ${p === "online" ? styles.presenceOnline : styles.presenceNear}`}
          aria-label={p === "wifi" ? t("Même Wi-Fi", "Same Wi-Fi") : p === "near" ? t("À portée Bluetooth", "Bluetooth range") : t("En ligne", "Online")} />}
      </span>
    );
  };

  // ---------- Conversation privée ----------
  if (view.kind === "dm") {
    const name = nameOf(view.peerId);
    return <DmThread key={view.peerId} {...{
      state, lang, save, peerId: view.peerId, name, role: roleOf(view.peerId), presence: presence(view.peerId), nameOf,
      onBack: () => setView({ kind: "list" }), onCall: (video: boolean) => void call(view.peerId, name, video), Avatar,
    }} />;
  }

  // ---------- Groupe ----------
  if (view.kind === "group") {
    return (
      <div className={styles.wrap}>
        <div className={styles.threadHead}>
          <button className={styles.iconBtn} aria-label={t("Retour", "Back")} onClick={() => setView({ kind: "list" })}><BackIcon /></button>
          <span className={styles.groupMark}><GroupIcon /></span>
          <div className={styles.threadTitle}><strong>Maintenance R/F</strong><span>{t(`${state.users.length} membres`, `${state.users.length} members`)}</span></div>
        </div>
        {renderGroup()}
      </div>
    );
  }

  // ---------- Nouveau message ----------
  if (view.kind === "new") {
    const q = search.trim().toLowerCase();
    const list = users.filter((u) => !q || u.displayName.toLowerCase().includes(q)).sort((a, b) => a.displayName.localeCompare(b.displayName));
    return (
      <div className={styles.wrap}>
        <div className={styles.threadHead}>
          <button className={styles.iconBtn} aria-label={t("Retour", "Back")} onClick={() => setView({ kind: "list" })}><BackIcon /></button>
          <div className={styles.threadTitle}><strong>{t("Nouvelle discussion", "New chat")}</strong><span>{t(`${list.length} collègues`, `${list.length} colleagues`)}</span></div>
        </div>
        <label className={styles.searchBox}>
          <span className={styles.srOnly}>{t("Rechercher un collègue", "Search a colleague")}</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Rechercher un collègue", "Search a colleague")} />
        </label>
        {users.length === 0 && (
          <div className={styles.empty}>{t("La liste des collègues arrive avec la prochaine synchronisation (Internet ou collègue proche).", "The colleague list arrives with the next sync (Internet or nearby colleague).")}</div>
        )}
        <div className={styles.list}>
          {list.map((u) => (
            <div key={u.id} className={styles.row}>
              <button className={styles.rowMain} onClick={() => { setSearch(""); setView({ kind: "dm", peerId: u.id }); }}>
                <Avatar id={u.id} name={u.displayName} />
                <span className={styles.rowText}><strong>{u.displayName}</strong><span>{roleOf(u.id)}{presence(u.id) === "wifi" ? ` · ${t("même Wi-Fi", "same Wi-Fi")}` : presence(u.id) === "near" ? ` · ${t("à portée", "nearby")}` : ""}</span></span>
              </button>
              <button className={styles.callBtn} aria-label={t(`Appeler ${u.displayName}`, `Call ${u.displayName}`)} onClick={() => void call(u.id, u.displayName)}><PhoneIcon /></button>
              <button className={styles.callBtn} aria-label={t(`Appel vidéo ${u.displayName}`, `Video call ${u.displayName}`)} onClick={() => void call(u.id, u.displayName, true)}><VideoIcon /></button>
            </div>
          ))}
          {!list.length && users.length > 0 && <div className={styles.empty}>{t("Aucun collègue trouvé.", "No colleague found.")}</div>}
        </div>
      </div>
    );
  }

  // ---------- Liste ----------
  const unreadTotal = threads.reduce((a, [peer]) => a + unreadFrom(peer, me.id, dms), 0);
  const q = search.trim().toLowerCase();
  const shownThreads = threads.filter(([peerId, last]) => !q || nameOf(peerId).toLowerCase().includes(q) || (last.text ?? "").toLowerCase().includes(q));
  const tick = (d: Dm) => d.from !== me.id ? null : d.status === "pending" ? <span className={styles.tickWait} aria-label={t("en attente", "waiting")}>🕓</span> : <span className={styles.tick} aria-label={t("envoyé", "sent")}>✓</span>;
  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h1 className={styles.h1}>{segment === "calls" ? t("Appels", "Calls") : "Messages"}</h1>
        <button className={styles.iconBtn} aria-label={t("Rechercher", "Search")} onClick={() => { setSearching((v) => !v); setSearch(""); }}><SearchIcon /></button>
        <button className={styles.primaryBtn} aria-label={t("Nouvelle discussion", "New chat")} onClick={() => { setSearch(""); setView({ kind: "new" }); }}><PlusIcon /></button>
      </div>
      {searching && (
        <label className={styles.searchBox}>
          <span className={styles.srOnly}>{t("Rechercher", "Search")}</span>
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Rechercher une discussion…", "Search a chat…")} />
        </label>
      )}
      <div className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={segment === "chats"} className={segment === "chats" ? styles.tabOn : styles.tab} onClick={() => onSegment("chats")}>
          {t("Discussions", "Chats")}{unreadTotal > 0 ? ` · ${unreadTotal}` : ""}
        </button>
        <button role="tab" aria-selected={segment === "calls"} className={segment === "calls" ? styles.tabOn : styles.tab} onClick={() => onSegment("calls")}>{t("Appels", "Calls")}</button>
      </div>
      {!online && (
        <div className={styles.banner}>
          <NearIcon />
          <span>
            {linked.length
              ? t(`Hors ligne · ${linked.length} collègue(s) relié(s) en direct : messages et appels passent par Bluetooth / Wi-Fi.`, `Offline · ${linked.length} colleague(s) linked directly: messages and calls go over Bluetooth / Wi-Fi.`)
              : t("Hors ligne : tes messages partent via les téléphones proches, ou dès le retour d'Internet.", "Offline: your messages travel through nearby phones, or as soon as Internet is back.")}
          </span>
        </div>
      )}

      {segment === "chats" ? (
        <>
          {showGroup && (!q || "maintenance r/f".includes(q)) && (
            <button className={styles.groupCard} onClick={() => setView({ kind: "group" })}>
              <span className={styles.groupMarkBig}><GroupIcon /></span>
              <span className={styles.rowText}>
                <span className={styles.rowTop}><strong>Maintenance R/F</strong>{groupLast && <span className={styles.time}>{fmtTime(new Date(groupLast.createdAt).toISOString())}</span>}</span>
                <span className={styles.preview}>{groupLast ? `${groupLast.author} : ${groupLast.message || t("fichier joint", "attachment")}` : t("Le groupe de tout l'atelier", "The whole workshop group")}</span>
              </span>
            </button>
          )}
          <div className={styles.list}>
            {shownThreads.map(([peerId, last]) => {
              const name = nameOf(peerId);
              const unread = unreadFrom(peerId, me.id, dms);
              return (
                <div key={peerId} className={styles.row}>
                  <button className={styles.rowMain} onClick={() => setView({ kind: "dm", peerId })}>
                    <Avatar id={peerId} name={name} />
                    <span className={styles.rowText}>
                      <span className={styles.rowTop}><strong>{name}</strong><span className={`${styles.time} ${unread ? styles.timeUnread : ""}`}>{fmtTime(last.at)}</span></span>
                      <span className={styles.rowTop}>
                        <span className={`${styles.preview} ${last.status === "pending" ? styles.previewPending : ""}`}>
                          {tick(last)}{" "}
                          {last.text == null && !last.att ? t("Message chiffré pour un autre téléphone", "Message encrypted for another phone") : previewOf(last)}
                        </span>
                        {unread > 0 && <span className={styles.unread}>{unread}</span>}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
            {!shownThreads.length && (
              <div className={styles.empty}>{q ? t("Aucune discussion trouvée.", "No chat found.") : t("Aucune discussion. Touche + pour écrire à un collègue.", "No chat yet. Tap + to write to a colleague.")}</div>
            )}
          </div>
        </>
      ) : (
        <div className={styles.list}>
          <div className={styles.callActions}>
            <button className={styles.groupCard} onClick={() => setPicking("voice")}>
              <span className={styles.groupMarkBig}><PhoneIcon /></span>
              <span className={styles.rowText}><strong>{t("Appel", "Call")}</strong><span className={styles.preview}>{t("À deux ou en groupe", "One-to-one or group")}</span></span>
            </button>
            <button className={styles.groupCard} onClick={() => setPicking("video")}>
              <span className={styles.groupMarkBig}><VideoIcon /></span>
              <span className={styles.rowText}><strong>{t("Appel vidéo", "Video call")}</strong><span className={styles.preview}>{t("Caméra avant ou arrière", "Front or back camera")}</span></span>
            </button>
          </div>
          {rooms.filter((r) => r.members.some((m) => m.status === "in") && !r.members.some((m) => m.userId === me.id && m.status === "in")).map((r) => {
            const inCall = r.members.filter((m) => m.status === "in");
            const host = r.members.find((m) => m.userId === r.createdBy)?.name ?? "";
            return (
              <div key={r.id} className={styles.row}>
                <span className={styles.rowMain} style={{ cursor: "default" }}>
                  <span className={styles.groupMark}><GroupIcon /></span>
                  <span className={styles.rowText}>
                    <strong>{r.group ? t("Appel de groupe en cours", "Group call in progress") : t("Appel en cours", "Call in progress")}</strong>
                    <span className={styles.preview}>{inCall.map((m) => m.name.split(" ")[0]).join(", ")} · {inCall.length}/{MAX_PARTICIPANTS}{host ? ` · ${t("lancé par", "started by")} ${host}` : ""}</span>
                  </span>
                </span>
                <button className={styles.joinBtn} onClick={() => void joinRoom(r.id, { group: r.group, inviterId: r.createdBy, inviterName: host, video: !!r.video }).catch((e) => toast.error(e instanceof Error ? e.message : t("Impossible de rejoindre", "Unable to join")))}>
                  {t("Rejoindre", "Join")}
                </button>
              </div>
            );
          })}
          <div className={styles.section}>{t("Récents", "Recent")}</div>
          {calls.filter((c) => !q || c.peerName.toLowerCase().includes(q)).map((c) => (
            <div key={c.id} className={styles.row}>
              <span className={styles.rowMain} style={{ cursor: "default" }}>
                {c.group ? <span className={styles.groupMark}><GroupIcon /></span> : <Avatar id={c.peerId} name={c.peerName} />}
                <span className={styles.rowText}>
                  <span className={styles.rowTop}><strong className={c.status === "missed" ? styles.missedName : ""}>{c.peerName}</strong><span className={styles.time}>{fmtTime(c.at)}</span></span>
                  <span className={`${styles.preview} ${c.status === "missed" ? styles.previewMissed : ""}`}>
                    {c.status === "missed" ? <MissedInline /> : c.dir === "in" ? "↙ " : "↗ "}
                    {c.video ? "📹 " : ""}{c.via === "proche" ? t("Bluetooth", "Bluetooth") : c.via === "wifi" ? "Wi-Fi" : "Internet"}
                    {" · "}{c.status === "done" ? `${Math.floor(c.seconds / 60)} min ${c.seconds % 60} s` : c.status === "missed" ? t("manqué", "missed") : c.status === "declined" ? t("refusé", "declined") : t("non abouti", "not connected")}
                  </span>
                </span>
              </span>
              {!c.group && c.peerId > 0 && (
                <>
                  <button className={styles.callBtn} aria-label={t(`Rappeler ${c.peerName}`, `Call back ${c.peerName}`)} onClick={() => void call(c.peerId, c.peerName, false)}><PhoneIcon /></button>
                  <button className={styles.callBtn} aria-label={t(`Appel vidéo ${c.peerName}`, `Video call ${c.peerName}`)} onClick={() => void call(c.peerId, c.peerName, true)}><VideoIcon /></button>
                </>
              )}
            </div>
          ))}
          {!calls.length && <div className={styles.empty}>{t("Aucun appel pour l'instant.", "No calls yet.")}</div>}
        </div>
      )}
      <PeoplePicker
        open={picking !== null}
        onOpenChange={(o) => { if (!o) setPicking(null); }}
        people={users}
        max={MAX_PARTICIPANTS - 1}
        title={picking === "video" ? t("Appel vidéo", "Video call") : t("Appel", "Call")}
        confirmLabel={t("Appeler", "Call")}
        onConfirm={(ids) => {
          const video = picking === "video";
          const people = ids.map((id) => ({ userId: id, name: userById.get(id)?.displayName ?? "Collègue" }));
          const go = people.length === 1 ? startCall(people[0].userId, people[0].name, { video }) : startGroupCall(people, { video });
          void go.catch((e) => toast.error(e instanceof Error ? e.message : t("Appel impossible", "Call failed")));
        }}
      />
    </div>
  );
};

const MissedInline = () => <span className={styles.missedIcon}><MissedIcon /></span>;

// ---------------------------------------------------------------------------
type ThreadProps = {
  state: State; lang: "fr" | "en"; save: (input: InputType) => void; peerId: number; name: string; role: string;
  presence: Presence; onBack: () => void; onCall: (video: boolean) => void; nameOf: (id: number) => string;
  Avatar: (p: { id: number; name: string; big?: boolean }) => React.ReactElement;
};

const DmThread = ({ state, lang, save, peerId, name, role, presence, onBack, onCall, nameOf, Avatar }: ThreadProps) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const me = state.me;
  const online = useOnline();
  const dms = useDms();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<DmReply | null>(null);
  const [menu, setMenu] = useState<Dm | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [rec, setRec] = useState<{ started: number; recorder: MediaRecorder; chunks: Blob[]; stream: MediaStream } | null>(null);
  const [recNow, setRecNow] = useState(Date.now());
  const bottom = useRef<HTMLDivElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const messages = useMemo(() => dms.filter((d) => (d.from === me.id && d.to === peerId) || (d.from === peerId && d.to === me.id)), [dms, me.id, peerId]);
  useEffect(() => { markRead(peerId); bottom.current?.scrollIntoView({ block: "end" }); }, [messages.length, peerId]);
  useEffect(() => {
    if (!rec) return;
    const id = setInterval(() => setRecNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [rec]);
  const writable = canWriteTo(state, peerId);

  const send = async (att?: DmAttachment, caption?: string) => {
    const body = (caption ?? text).trim();
    if ((!body && !att) || busy) return;
    setBusy(true);
    try {
      await sendDm({ state, to: peerId, text: body.slice(0, 4000), save, att, reply: reply ?? undefined });
      if (caption === undefined) setText("");
      setReply(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Envoi impossible", "Unable to send"));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (f: File | undefined, kind: "image" | "file") => {
    if (!f) return;
    setAttachOpen(false);
    setBusy(true);
    try {
      const att = kind === "image" && f.type.startsWith("image/") ? await prepareImage(f, f.name || "photo.jpg") : await prepareFile(f);
      setBusy(false);
      await send(att, text);
      setText("");
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : t("Pièce jointe impossible", "Attachment failed"));
    }
  };

  const startRec = async () => {
    try {
      if (nearbyAvailable()) await Nearby.requestNearbyPermissions({ microphone: true }).catch(() => null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 16000 } : { audioBitsPerSecond: 16000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.start(500);
      setRec({ started: Date.now(), recorder, chunks, stream });
    } catch {
      toast.error(t("Micro indisponible : autorise-le dans les réglages.", "Microphone unavailable: allow it in settings."));
    }
  };
  const stopRec = async (keep: boolean) => {
    const r = rec;
    if (!r) return;
    setRec(null);
    const done = new Promise<void>((resolve) => { r.recorder.onstop = () => resolve(); });
    try { r.recorder.stop(); } catch { /* déjà arrêté */ }
    await done.catch(() => {});
    r.stream.getTracks().forEach((tr) => tr.stop());
    const seconds = (Date.now() - r.started) / 1000;
    if (!keep || seconds < 0.8) return;
    try {
      const blob = new Blob(r.chunks, { type: r.recorder.mimeType || "audio/webm" });
      setBusy(true);
      const att = await prepareAudio(blob, seconds);
      setBusy(false);
      await send(att, "");
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : t("Note vocale non envoyée", "Voice note not sent"));
    }
  };
  // Note vocale : 2 minutes au maximum.
  useEffect(() => {
    if (rec && recNow - rec.started > 120000) void stopRec(true);
  });

  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return t("Aujourd'hui", "Today");
    if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return t("Hier", "Yesterday");
    return d.toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { weekday: "long", day: "numeric", month: "long" });
  };
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const recSecs = rec ? Math.floor((recNow - rec.started) / 1000) : 0;

  let lastDay = "";
  return (
    <div className={`${styles.wrap} ${styles.threadWrap}`}>
      <div className={`${styles.threadHead} ${styles.threadHeadSticky}`}>
        <button className={styles.iconBtn} aria-label={t("Retour", "Back")} onClick={onBack}><BackIcon /></button>
        <Avatar id={peerId} name={name} />
        <div className={styles.threadTitle}>
          <strong>{name}</strong>
          <span>{presence === "wifi" ? t("Même Wi-Fi · appels sans Internet", "Same Wi-Fi · offline calls") : presence === "near" ? t("À portée Bluetooth", "In Bluetooth range") : presence === "online" ? t("En ligne", "Online") : role}</span>
        </div>
        <button className={styles.callBtn} aria-label={t(`Appel vidéo ${name}`, `Video call ${name}`)} onClick={() => onCall(true)}><VideoIcon /></button>
        <button className={styles.callBtn} aria-label={t(`Appeler ${name}`, `Call ${name}`)} onClick={() => onCall(false)}><PhoneIcon /></button>
      </div>
      <div className={styles.bubbles}>
        {!messages.length && <div className={styles.empty}>{t("Écris ton premier message. Il est chiffré : seul ton collègue pourra le lire.", "Write your first message. It is encrypted: only your colleague can read it.")}</div>}
        {messages.map((m) => {
          const day = new Date(m.at).toDateString();
          const sep = day !== lastDay ? <div className={styles.daySep}><span>{dayLabel(m.at)}</span></div> : null;
          lastDay = day;
          const mine = m.from === me.id;
          return (
            <React.Fragment key={m.id}>
              {sep}
              <div className={mine ? styles.bubbleMine : styles.bubbleTheirs}
                onContextMenu={(e) => { e.preventDefault(); setMenu(m); }}
                {...longPress(() => setMenu(m))}>
                {m.reply && (
                  <div className={styles.quote}>
                    <strong>{m.reply.from === me.id ? t("Toi", "You") : nameOf(m.reply.from)}</strong>
                    <span>{m.reply.text}</span>
                  </div>
                )}
                {m.att && <Attachment dm={m} lang={lang} onOpenImage={setViewer} online={online} />}
                {m.text ? <div className={styles.bubbleText}>{m.text}</div>
                  : !m.att && <div className={styles.bubbleText}><em>{t("Message chiffré pour un autre téléphone de ce compte.", "Message encrypted for another phone of this account.")}</em></div>}
                <div className={styles.bubbleMeta}>
                  {m.via === "proche" ? `${t("sans Internet", "offline")} · ` : ""}{hhmm(m.at)}
                  {mine && (m.status === "pending" ? <span className={styles.tickWait}> 🕓</span> : <span className={styles.tick}> ✓</span>)}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        <div ref={bottom} />
      </div>

      {!writable && (
        <div className={styles.banner}><span>{t("Ce collègue doit ouvrir une fois la nouvelle version de l'app avec Internet avant de recevoir des messages privés. Tu peux déjà l'appeler.", "This colleague must open the new app version once with Internet before receiving private messages. You can already call them.")}</span></div>
      )}

      <div className={styles.composerWrap}>
        {reply && (
          <div className={styles.replyBar}>
            <div className={styles.quote}><strong>{reply.from === me.id ? t("Toi", "You") : nameOf(reply.from)}</strong><span>{reply.text}</span></div>
            <button className={styles.iconBtnSmall} aria-label={t("Annuler la réponse", "Cancel reply")} onClick={() => setReply(null)}><CloseIcon /></button>
          </div>
        )}
        {attachOpen && (
          <div className={styles.attachSheet}>
            <button onClick={() => cameraInput.current?.click()}><span className={styles.attachIcon} style={{ background: "#be185d" }}><CamIcon /></span>{t("Caméra", "Camera")}</button>
            <button onClick={() => photoInput.current?.click()}><span className={styles.attachIcon} style={{ background: "#7c3aed" }}><ImgIcon /></span>{t("Galerie", "Gallery")}</button>
            <button onClick={() => fileInput.current?.click()}><span className={styles.attachIcon} style={{ background: "#2563eb" }}><FileIcon /></span>{t("Document", "Document")}</button>
          </div>
        )}
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pickFile(e.target.files?.[0], "image"); e.target.value = ""; }} />
        <input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => { void pickFile(e.target.files?.[0], "image"); e.target.value = ""; }} />
        <input ref={fileInput} type="file" hidden onChange={(e) => { void pickFile(e.target.files?.[0], "file"); e.target.value = ""; }} />
        {rec ? (
          <div className={styles.composer}>
            <button className={styles.iconBtn} aria-label={t("Annuler l'enregistrement", "Cancel recording")} onClick={() => void stopRec(false)}><CloseIcon /></button>
            <div className={styles.recording}><span className={styles.recDot} />{`${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, "0")}`} · {t("enregistrement…", "recording…")}</div>
            <button className={styles.sendRound} aria-label={t("Envoyer la note vocale", "Send voice note")} onClick={() => void stopRec(true)}><SendIcon /></button>
          </div>
        ) : (
          <div className={styles.composer}>
            <button className={styles.iconBtn} disabled={!writable} aria-label={t("Joindre", "Attach")} aria-expanded={attachOpen} onClick={() => setAttachOpen((v) => !v)}><ClipIcon /></button>
            <label className={styles.composerField}>
              <span className={styles.srOnly}>{t("Message", "Message")}</span>
              <textarea rows={1} value={text} disabled={!writable} onChange={(e) => setText(e.target.value)} placeholder={t("Message", "Message")}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            </label>
            {text.trim() ? (
              <button className={styles.sendRound} disabled={busy || !writable} aria-label={t("Envoyer", "Send")} onClick={() => void send()}><SendIcon /></button>
            ) : (
              <button className={styles.sendRound} disabled={busy || !writable} aria-label={t("Enregistrer une note vocale", "Record a voice note")} onClick={() => void startRec()}><MicIcon /></button>
            )}
          </div>
        )}
      </div>

      {menu && (
        <div className={styles.sheetBackdrop} onClick={() => setMenu(null)}>
          <div className={styles.sheet} role="menu" onClick={(e) => e.stopPropagation()}>
            <button role="menuitem" onClick={() => { setReply({ id: menu.id, from: menu.from, text: (menu.text || previewOf(menu)).slice(0, 140) }); setMenu(null); }}>{t("Répondre", "Reply")}</button>
            {menu.text && <button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(menu.text ?? "").then(() => toast.success(t("Copié", "Copied"))).catch(() => {}); setMenu(null); }}>{t("Copier", "Copy")}</button>}
            <button role="menuitem" className={styles.sheetDanger} onClick={() => { hideDm(menu.id); setMenu(null); }}>{t("Supprimer pour moi", "Delete for me")}</button>
            <button role="menuitem" onClick={() => setMenu(null)}>{t("Annuler", "Cancel")}</button>
          </div>
        </div>
      )}
      {viewer && (
        <div className={styles.viewer} onClick={() => setViewer(null)} role="dialog" aria-label={t("Photo", "Photo")}>
          <img src={viewer} alt="" />
          <button className={styles.viewerClose} aria-label={t("Fermer", "Close")}><CloseIcon /></button>
        </div>
      )}
    </div>
  );
};

// Appui long (mobile) → menu du message.
function longPress(cb: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  return {
    onTouchStart: () => { clear(); timer = setTimeout(cb, 500); },
    onTouchEnd: clear,
    onTouchMove: clear,
  };
}

const Attachment = ({ dm, lang, onOpenImage, online }: { dm: Dm; lang: "fr" | "en"; onOpenImage: (url: string) => void; online: boolean }) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const a = dm.att!;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const inline = !!(a.stored || a.data);
  const load = async () => {
    try {
      const u = await attachmentUrl(dm);
      if (u) setUrl(u);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  };
  // Images et notes vocales incluses : chargées tout de suite ; sur le serveur : chargées si Internet.
  useEffect(() => {
    if (a.kind !== "file" && (inline || online)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dm.id, online]);

  if (a.kind === "image") {
    const src = url ?? (a.thumb ? `data:image/jpeg;base64,${a.thumb}` : null);
    const ratio = a.w && a.h ? `${a.w} / ${a.h}` : "4 / 3";
    return (
      <button className={styles.photo} style={{ aspectRatio: ratio }} onClick={() => { if (url) onOpenImage(url); else void load(); }} aria-label={t("Voir la photo", "View photo")}>
        {src ? <img src={src} alt="" className={url ? "" : styles.photoBlur} /> : <span className={styles.photoWait}>{failed ? t("Photo indisponible hors ligne", "Photo unavailable offline") : t("Chargement…", "Loading…")}</span>}
      </button>
    );
  }
  if (a.kind === "audio") {
    return url ? <audio className={styles.audio} controls src={url} preload="metadata" />
      : <div className={styles.fileRow}>🎤 {t("Note vocale", "Voice note")}{a.dur ? ` · ${Math.floor(a.dur / 60)}:${String(a.dur % 60).padStart(2, "0")}` : ""}{failed ? ` · ${t("indisponible hors ligne", "unavailable offline")}` : ""}</div>;
  }
  const kb = a.size > 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(a.size / 1024))} Ko`;
  return (
    <button className={styles.fileRow} onClick={async () => {
      const u = url ?? (await attachmentUrl(dm).catch(() => null));
      if (!u) { toast.error(t("Fichier indisponible pour le moment (Internet nécessaire).", "File unavailable for now (Internet needed).")); return; }
      setUrl(u);
      const link = document.createElement("a");
      link.href = u;
      link.download = a.name;
      link.click();
    }}>
      📎 <span className={styles.fileName}>{a.name}</span><span className={styles.fileSize}>{kb}</span>
    </button>
  );
};
