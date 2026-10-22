import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { g37 } from "../helpers/g37";
import { markRead, sendDm, unreadFrom, useDms, type Dm } from "../lib/dms";
import { callLog, joinRoom, listActiveRooms, MAX_PARTICIPANTS, onCallState, startCall, startGroupCall, type CallLog, type RoomInfo } from "../lib/calls";
import { PeoplePicker } from "./PeoplePicker";
import { getPeers, peersChanged, type Peer } from "../lib/p2p";
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
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
const AVATAR_BG = ["#2b4566", "#3b3357", "#2f4a3b", "#4a3a24", "#4a2b3a", "#24434a"];
const avatarBg = (id: number) => AVATAR_BG[Math.abs(id) % AVATAR_BG.length];

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
);
const GroupIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20a6 6 0 0 1 12 0M14 20a4.5 4.5 0 0 1 7-3.7" /></svg>
);
const BackIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
);
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);
const NearIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 7l10 10-5 5V2l5 5L7 17" /></svg>
);

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

export const MessagesView = ({ state, lang, save, renderGroup, segment, onSegment, roleName }: Props) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const me = state.me;
  const online = useOnline();
  const dms = useDms();
  const peers = usePeers();
  const calls = useCallLog();
  const [view, setView] = useState<{ kind: "list" } | { kind: "group" } | { kind: "dm"; peerId: number } | { kind: "new" }>({ kind: "list" });
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
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
  const nearIds = new Set(peers.filter((p) => p.connected && p.userId != null).map((p) => p.userId as number));
  const presence = (id: number): "near" | "online" | null => {
    if (nearIds.has(id)) return "near";
    const seen = userById.get(id)?.lastSeen;
    return seen && Date.now() - new Date(seen).getTime() < 5 * 60000 ? "online" : null;
  };

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
  const call = async (peerId: number, name: string) => {
    try {
      await startCall(peerId, name);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Appel impossible", "Call failed"));
    }
  };
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" });
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
        {p && <span className={`${styles.presence} ${p === "near" ? styles.presenceNear : styles.presenceOnline}`} aria-label={p === "near" ? t("À portée", "Nearby") : t("En ligne", "Online")} />}
      </span>
    );
  };

  // ---------- Conversation privée ----------
  if (view.kind === "dm") {
    const peer = userById.get(view.peerId);
    const name = peer?.displayName ?? t("Collègue", "Colleague");
    return <DmThread key={view.peerId} {...{ state, lang, save, peerId: view.peerId, name, role: roleOf(view.peerId), presence: presence(view.peerId), onBack: () => setView({ kind: "list" }), onCall: () => void call(view.peerId, name), Avatar }} />;
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
          <div className={styles.threadTitle}><strong>{t("Nouveau message", "New message")}</strong><span>{t("Choisis un collègue", "Choose a colleague")}</span></div>
        </div>
        <label className={styles.searchBox}>
          <span className={styles.srOnly}>{t("Rechercher un collègue", "Search a colleague")}</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Rechercher un collègue", "Search a colleague")} />
        </label>
        <div className={styles.list}>
          {list.map((u) => (
            <div key={u.id} className={styles.row}>
              <button className={styles.rowMain} onClick={() => { setSearch(""); setView({ kind: "dm", peerId: u.id }); }}>
                <Avatar id={u.id} name={u.displayName} />
                <span className={styles.rowText}><strong>{u.displayName}</strong><span>{roleOf(u.id)}</span></span>
              </button>
              <button className={styles.callBtn} aria-label={t(`Appeler ${u.displayName}`, `Call ${u.displayName}`)} onClick={() => void call(u.id, u.displayName)}><PhoneIcon /></button>
            </div>
          ))}
          {!list.length && <div className={styles.empty}>{t("Aucun collègue trouvé.", "No colleague found.")}</div>}
        </div>
      </div>
    );
  }

  // ---------- Liste ----------
  const unreadTotal = threads.reduce((a, [peer]) => a + unreadFrom(peer, me.id, dms), 0);
  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h1 className={styles.h1}>Messages</h1>
        <button className={styles.primaryBtn} aria-label={t("Nouveau message", "New message")} onClick={() => setView({ kind: "new" })}><PlusIcon /></button>
      </div>
      <div className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={segment === "chats"} className={segment === "chats" ? styles.tabOn : styles.tab} onClick={() => onSegment("chats")}>
          {t("Discussions", "Chats")}{unreadTotal > 0 ? ` · ${unreadTotal}` : ""}
        </button>
        <button role="tab" aria-selected={segment === "calls"} className={segment === "calls" ? styles.tabOn : styles.tab} onClick={() => onSegment("calls")}>{t("Appels", "Calls")}</button>
      </div>
      {!online && (
        <div className={styles.banner}>
          <NearIcon />
          <span>{t("Hors ligne : tes messages partent via les téléphones proches, ou dès le retour d'Internet.", "Offline: your messages travel through nearby phones, or as soon as Internet is back.")}</span>
        </div>
      )}

      {segment === "chats" ? (
        <>
          <button className={styles.groupCard} onClick={() => setView({ kind: "group" })}>
            <span className={styles.groupMarkBig}><GroupIcon /></span>
            <span className={styles.rowText}>
              <span className={styles.rowTop}><strong>Maintenance R/F</strong>{groupLast && <span className={styles.time}>{fmtTime(new Date(groupLast.createdAt).toISOString())}</span>}</span>
              <span className={styles.preview}>{groupLast ? `${groupLast.author} : ${groupLast.message || t("fichier joint", "attachment")}` : t("Le groupe de tout l'atelier", "The whole workshop group")}</span>
            </span>
          </button>
          <div className={styles.section}>{t("Messages privés", "Private messages")}</div>
          <div className={styles.list}>
            {threads.map(([peerId, last]) => {
              const u = userById.get(peerId);
              const name = u?.displayName ?? t("Ancien membre", "Former member");
              const unread = unreadFrom(peerId, me.id, dms);
              return (
                <div key={peerId} className={styles.row}>
                  <button className={styles.rowMain} onClick={() => setView({ kind: "dm", peerId })}>
                    <Avatar id={peerId} name={name} />
                    <span className={styles.rowText}>
                      <span className={styles.rowTop}><strong>{name}</strong><span className={styles.time}>{fmtTime(last.at)}</span></span>
                      <span className={`${styles.preview} ${last.status === "pending" ? styles.previewPending : ""}`}>
                        {last.status === "pending" ? t("En attente · partira dès que possible", "Waiting · will leave when possible")
                          : last.text ?? t("Message chiffré pour un autre téléphone", "Message encrypted for another phone")}
                      </span>
                    </span>
                    {unread > 0 && <span className={styles.unread}>{unread}</span>}
                  </button>
                  <button className={styles.callBtn} aria-label={t(`Appeler ${name}`, `Call ${name}`)} onClick={() => void call(peerId, name)}><PhoneIcon /></button>
                </div>
              );
            })}
            {!threads.length && (
              <div className={styles.empty}>{t("Aucun message privé. Touche + pour écrire à un collègue.", "No private message yet. Tap + to write to a colleague.")}</div>
            )}
          </div>
        </>
      ) : (
        <div className={styles.list}>
          <button className={styles.groupCard} onClick={() => setPicking(true)}>
            <span className={styles.groupMarkBig}><GroupIcon /></span>
            <span className={styles.rowText}>
              <strong>{t("Nouvel appel de groupe", "New group call")}</strong>
              <span className={styles.preview}>{t(`Jusqu'à ${MAX_PARTICIPANTS} personnes · par Internet`, `Up to ${MAX_PARTICIPANTS} people · over Internet`)}</span>
            </span>
          </button>
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
                <button className={styles.joinBtn} onClick={() => void joinRoom(r.id, { group: r.group, inviterId: r.createdBy, inviterName: host }).catch((e) => toast.error(e instanceof Error ? e.message : t("Impossible de rejoindre", "Unable to join")))}>
                  {t("Rejoindre", "Join")}
                </button>
              </div>
            );
          })}
          <div className={styles.section}>{t("Historique", "History")}</div>
          {calls.map((c) => (
            <div key={c.id} className={styles.row}>
              <span className={styles.rowMain} style={{ cursor: "default" }}>
                {c.group ? <span className={styles.groupMark}><GroupIcon /></span> : <Avatar id={c.peerId} name={c.peerName} />}
                <span className={styles.rowText}>
                  <span className={styles.rowTop}><strong>{c.peerName}</strong><span className={styles.time}>{fmtTime(c.at)}</span></span>
                  <span className={`${styles.preview} ${c.status === "missed" ? styles.previewMissed : ""}`}>
                    {c.dir === "in" ? t("Entrant", "Incoming") : t("Sortant", "Outgoing")} · {c.via === "proche" ? t("à proximité", "nearby") : "Internet"}
                    {" · "}{c.status === "done" ? `${Math.floor(c.seconds / 60)} min ${c.seconds % 60} s` : c.status === "missed" ? t("manqué", "missed") : c.status === "declined" ? t("refusé", "declined") : t("non abouti", "not connected")}
                  </span>
                </span>
              </span>
              {!c.group && c.peerId > 0 && <button className={styles.callBtn} aria-label={t(`Rappeler ${c.peerName}`, `Call back ${c.peerName}`)} onClick={() => void call(c.peerId, c.peerName)}><PhoneIcon /></button>}
            </div>
          ))}
          {!calls.length && <div className={styles.empty}>{t("Aucun appel pour l'instant.", "No calls yet.")}</div>}
        </div>
      )}
      <PeoplePicker
        open={picking}
        onOpenChange={setPicking}
        people={users}
        max={MAX_PARTICIPANTS - 1}
        title={t("Appel de groupe", "Group call")}
        confirmLabel={t("Appeler", "Call")}
        onConfirm={(ids) => {
          const people = ids.map((id) => ({ userId: id, name: userById.get(id)?.displayName ?? "Collègue" }));
          const go = people.length === 1 ? startCall(people[0].userId, people[0].name) : startGroupCall(people);
          void go.catch((e) => toast.error(e instanceof Error ? e.message : t("Appel impossible", "Call failed")));
        }}
      />
    </div>
  );
};

type ThreadProps = {
  state: State; lang: "fr" | "en"; save: (input: InputType) => void; peerId: number; name: string; role: string;
  presence: "near" | "online" | null; onBack: () => void; onCall: () => void;
  Avatar: (p: { id: number; name: string; big?: boolean }) => React.ReactElement;
};

const DmThread = ({ state, lang, save, peerId, name, role, presence, onBack, onCall, Avatar }: ThreadProps) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const me = state.me;
  const dms = useDms();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => dms.filter((d) => (d.from === me.id && d.to === peerId) || (d.from === peerId && d.to === me.id)), [dms, me.id, peerId]);
  useEffect(() => { markRead(peerId); bottom.current?.scrollIntoView({ block: "end" }); }, [messages.length, peerId]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await sendDm({ state, to: peerId, text: body.slice(0, 4000), save });
      setText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Envoi impossible", "Unable to send"));
    } finally {
      setBusy(false);
    }
  };
  const time = (iso: string) => new Date(iso).toLocaleString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className={styles.wrap}>
      <div className={styles.threadHead}>
        <button className={styles.iconBtn} aria-label={t("Retour", "Back")} onClick={onBack}><BackIcon /></button>
        <Avatar id={peerId} name={name} />
        <div className={styles.threadTitle}>
          <strong>{name}</strong>
          <span>{presence === "near" ? t("À portée Bluetooth / Wi-Fi", "In Bluetooth / Wi-Fi range") : presence === "online" ? t("En ligne", "Online") : role}</span>
        </div>
        <button className={styles.callBtn} aria-label={t(`Appeler ${name}`, `Call ${name}`)} onClick={onCall}><PhoneIcon /></button>
      </div>
      <div className={styles.bubbles}>
        {!messages.length && <div className={styles.empty}>{t("Écris ton premier message. Il est chiffré : seul ton collègue pourra le lire.", "Write your first message. It is encrypted: only your colleague can read it.")}</div>}
        {messages.map((m) => (
          <div key={m.id} className={m.from === me.id ? styles.bubbleMine : styles.bubbleTheirs}>
            <div className={styles.bubbleText}>{m.text ?? t("Message chiffré pour un autre téléphone de ce compte.", "Message encrypted for another phone of this account.")}</div>
            <div className={styles.bubbleMeta}>
              {time(m.at)}
              {m.from === me.id && (m.status === "pending" ? ` · ${t("en attente", "waiting")}` : ` · ${t("envoyé", "sent")}`)}
              {m.via === "proche" ? ` · ${t("reçu à proximité", "received nearby")}` : ""}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className={styles.composer}>
        <label className={styles.composerField}>
          <span className={styles.srOnly}>{t("Message", "Message")}</span>
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Écrire un message…", "Write a message…")}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        </label>
        <button className={styles.sendBtn} disabled={busy || !text.trim()} onClick={() => void send()}>{t("Envoyer", "Send")}</button>
      </div>
    </div>
  );
};
