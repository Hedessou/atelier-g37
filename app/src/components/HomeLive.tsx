import React, { useEffect, useMemo, useRef, useState } from "react";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import { g37 } from "../helpers/g37";
import type { HomeAction, HomeTodo } from "./HomeView";
import styles from "./HomeLive.module.css";

// Accueil « vivant » (atelier et production) — 26/10/2026 :
// fond en verre givré, chiffres qui s'animent, cartes qui s'ouvrent au toucher.
// Atelier : métiers (marche / arrêt / maintenance), pannes non résolues, maintenances, graissages
// et schedule works en retard. Production : métiers, pannes, messages et planning des quarts.

type Props = {
  state: State;
  lang: "fr" | "en";
  todo: HomeTodo[];
  prod: boolean;
  unread: number;
  actions: HomeAction[];
  toggle?: React.ReactNode;              // bascule Atelier / Boss (admin, superviseur)
  onOpenMachine: (no: number) => void;
  goto: (tab: string) => void;
  onMessages: () => void;
  onSchedule?: () => void;               // superviseur : programmer la maintenance de demain
  onWorkLog?: () => void;                // superviseur, manager, Boss : travaux effectués
};

const H = 3600000;
const pad = (n: number) => String(n).padStart(2, "0");
const reduceMotion = () => {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { return false; }
};

/** Chiffre qui monte jusqu'à sa valeur (et se rejoue quand la valeur change). */
function useCountUp(target: number, ms = 750) {
  const [v, setV] = useState(() => (reduceMotion() ? target : 0));
  const from = useRef(reduceMotion() ? target : 0);
  useEffect(() => {
    if (reduceMotion()) { setV(target); from.current = target; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setV(Math.round(a + (target - a) * e));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
const Num = ({ value }: { value: number }) => <>{useCountUp(value)}</>;

const Ico = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const ICONS = {
  fault: "M12 3l10 18H2L12 3zM12 10v5M12 18h.01",
  wrench: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
  drop: "M12 2.7c3 3.4 6 6.9 6 10.3a6 6 0 0 1-12 0c0-3.4 3-6.9 6-10.3z",
  calendar: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4M8 14h3",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  box: "M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10",
  phone: "M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  video: "M3 6h13v12H3zM16 10l5-3v10l-5-3",
  calc: "M5 3h14v18H5zM8 7h8M8 12h2M12 12h2M16 12v5M8 16h2M12 16h2",
  gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
  check: "M5 12.5l4.5 4.5L19 7.5",
  chevron: "M9 6l6 6-6 6",
};

function durText(ms: number, fr: boolean) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return `${h} h${m ? ` ${pad(m)}` : ""}`;
  return fr ? `${Math.round(h / 24)} jours` : `${Math.round(h / 24)} days`;
}

type Tone = "ok" | "crit" | "warn" | "info";
type Tile = { key: string; label: string; icon: string; tone: Tone; count: number; sub: string; late: HomeTodo[]; soon: HomeTodo[]; tab: string; tabLabel: string; direct?: () => void };

export function HomeLive({ state, lang, todo, prod, unread, actions, toggle, onOpenMachine, goto, onMessages, onSchedule, onWorkLog }: Props) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const now = new Date();
  const me = state.me;
  const machines = state.machines;
  const [openStatus, setOpenStatus] = useState<string | null>(null);
  const [openTile, setOpenTile] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(reduceMotion());
  useEffect(() => { const id = requestAnimationFrame(() => setDrawn(true)); return () => cancelAnimationFrame(id); }, []);

  const running = machines.filter((m) => m.status === "service");
  const stopped = machines.filter((m) => m.status === "arret");
  const inMaint = machines.filter((m) => m.status === "maintenance");
  const openFaults = (state.failures ?? []).filter((f) => f.status !== "resolue");
  const faultOn = new Set(openFaults.map((f) => f.machineNo));

  const hour = Number(new Date(now.getTime() + H).toISOString().slice(11, 13));
  const hello = hour < 12 ? t("Bonjour", "Good morning") : hour < 18 ? t("Bon après-midi", "Good afternoon") : t("Bonsoir", "Good evening");
  const firstName = (me.firstName || me.displayName.split(/\s+/)[0] || "").trim();
  const duty = state.duty ?? null;
  const general = duty?.general ?? g37.generalOnDuty(now);
  const dutyTeam = duty?.team || null;
  const shiftHours = dutyTeam ? g37.SHIFT_TYPES.find((s) => s.k === duty?.code)?.h.replace(" — ", "–") : null;

  // ---- Maintenance programmée par le superviseur (aujourd'hui et demain) ----
  const todayIso = new Date(now.getTime() + H).toISOString().slice(0, 10);
  const tomorrowIso = new Date(now.getTime() + H + 86400000).toISOString().slice(0, 10);
  const planned = (iso: string) => machines.filter((m) => m.plannedBy && m.nextMaintenance && new Date(m.nextMaintenance).toISOString().slice(0, 10) === iso);
  const planToday = planned(todayIso);
  const planTomorrow = planned(tomorrowIso);
  const evening = hour >= 14;          // « la veille » : le bouton s'allume l'après-midi
  const showPlan = !prod && (planToday.length > 0 || planTomorrow.length > 0 || !!onSchedule);

  // ---- Cartes « à surveiller » ----
  const faults = todo.filter((x) => x.group === "fault");
  const worst = useMemo(() => {
    const s = openFaults.filter((f) => f.stoppedAt).sort((a, b) => new Date(a.stoppedAt!).getTime() - new Date(b.stoppedAt!).getTime());
    return s[0] ?? null;
  }, [openFaults]);
  const sumN = (l: HomeTodo[]) => l.reduce((a, x) => a + (x.n ?? 1), 0);
  const upkeep = (filter: (x: HomeTodo) => boolean) => {
    const all = todo.filter(filter);
    return { late: all.filter((x) => x.tone === "crit"), soon: all.filter((x) => x.tone !== "crit") };
  };
  const maint = upkeep((x) => x.group === "maint");
  const grease = upkeep((x) => x.group === "cycle" && (x.cat === "grease" || x.cat === "lub"));
  const sched = upkeep((x) => x.group === "cycle" && x.cat === "sched");
  const upSub = (u: { late: HomeTodo[]; soon: HomeTodo[] }) => {
    const late = sumN(u.late);
    if (late) return t(`${late} métier${late > 1 ? "s" : ""} en retard`, `${late} machine${late > 1 ? "s" : ""} overdue`);
    const soon = sumN(u.soon);
    return soon ? t(`À jour · ${soon} bientôt`, `Up to date · ${soon} soon`) : t("Tout est à jour", "All up to date");
  };

  const tiles: Tile[] = [
    {
      key: "fault", label: t("Pannes non résolues", "Unresolved faults"), icon: ICONS.fault, tone: faults.length ? "crit" : "ok", count: faults.length,
      sub: worst ? `${t("la plus longue", "longest")} ${durText(now.getTime() - new Date(worst.stoppedAt!).getTime(), fr)}` : faults.length ? t("sans arrêt machine", "no machine stopped") : t("Aucune panne", "No fault"),
      late: faults, soon: [], tab: "pannes", tabLabel: t("Ouvrir les pannes", "Open faults"),
    },
  ];
  if (prod) {
    tiles.push({
      key: "msg", label: t("Messages non lus", "Unread messages"), icon: ICONS.chat, tone: unread ? "info" : "ok", count: unread,
      sub: unread ? t("Touchez pour lire", "Tap to read") : t("Rien de nouveau", "Nothing new"), late: [], soon: [], tab: "discussion", tabLabel: "", direct: onMessages,
    });
  } else {
    tiles.push(
      { key: "maint", label: t("Maintenances en retard", "Overdue maintenance"), icon: ICONS.wrench, tone: maint.late.length ? "warn" : "ok", count: sumN(maint.late), sub: upSub(maint), late: maint.late, soon: maint.soon, tab: "maintenance", tabLabel: t("Ouvrir la maintenance", "Open maintenance") },
      { key: "grease", label: t("Graissages en retard", "Overdue greasing"), icon: ICONS.drop, tone: grease.late.length ? "warn" : "ok", count: sumN(grease.late), sub: upSub(grease), late: grease.late, soon: grease.soon, tab: "graissage", tabLabel: t("Ouvrir le graissage", "Open greasing") },
      { key: "sched", label: t("Schedule works en retard", "Overdue schedule works"), icon: ICONS.calendar, tone: sched.late.length ? "warn" : "ok", count: sumN(sched.late), sub: upSub(sched), late: sched.late, soon: sched.soon, tab: "schedule", tabLabel: t("Ouvrir les schedule works", "Open schedule works") },
    );
  }
  const active = tiles.find((x) => x.key === openTile) ?? null;

  // ---- Anneau des métiers ----
  const R = 46;
  const C = 2 * Math.PI * R;
  const total = Math.max(machines.length, 1);
  const segs: Array<{ n: number; color: string }> = [
    { n: running.length, color: "var(--hl-ok)" },
    { n: stopped.length, color: "var(--hl-crit)" },
    { n: inMaint.length, color: "var(--hl-warn)" },
  ];
  let acc = 0;
  const statusRows: Array<{ key: string; label: string; n: number; tone: Tone; list: typeof machines }> = [
    { key: "service", label: t("En marche", "Running"), n: running.length, tone: "ok", list: running },
    { key: "arret", label: t("À l'arrêt", "Stopped"), n: stopped.length, tone: "crit", list: stopped },
    { key: "maintenance", label: t("Maintenance", "Maintenance"), n: inMaint.length, tone: "warn", list: inMaint },
  ];
  const openRow = statusRows.find((r) => r.key === openStatus) ?? null;

  const machineChip = (m: (typeof machines)[number]) => {
    const since = m.stoppedSince ? durText(now.getTime() - new Date(m.stoppedSince).getTime(), fr) : null;
    return (
      <button key={m.no} type="button" className={`${styles.mChip} ${styles[`t_${m.status === "arret" ? "crit" : m.status === "maintenance" ? "warn" : "ok"}`]}`} onClick={() => onOpenMachine(m.no)}>
        <span className={styles.mNo}>M/C {pad(m.no)}</span>
        {m.status !== "service" && (m.stopReason || since) && <span className={styles.mWhy}>{[m.stopReason, since].filter(Boolean).join(" · ")}</span>}
        {m.status === "service" && faultOn.has(m.no) && <span className={styles.mWhy}>{t("panne signalée", "fault reported")}</span>}
      </button>
    );
  };

  // ---- Planning des quarts (production) ----
  const shiftDays = useMemo(() => {
    if (!prod) return [];
    const base = new Date(now.getTime() + H);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
      const iso = d.toISOString().slice(0, 10);
      const of = (team: string) => state.shifts.find((s) => new Date(s.day).toISOString().slice(0, 10) === iso && s.team === team)?.shiftCode ?? "";
      return { iso, label: d.toLocaleDateString(fr ? "fr-FR" : "en-GB", { weekday: "short", day: "2-digit", timeZone: "UTC" }), dow: d.getUTCDay(), codes: g37.TEAMS.map((tm) => of(tm)) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prod, state.shifts, lang]);
  const SHIFT_SHORT: Record<string, string> = { m: t("Matin", "Morn."), s: t("A-midi", "Aft."), n: t("Nuit", "Night"), r: t("Repos", "Off") };

  let delay = 0;
  const rise = () => ({ animationDelay: `${(delay++) * 60}ms` });

  return (
    <div className={styles.wrap}>
      {/* Les lueurs du fond sont maintenant communes à tous les menus (G37App.module.css). */}
      <header className={`${styles.head} ${styles.rise}`} style={rise()}>
        <div className={styles.headTop}>
          <div>
            <div className={styles.eyebrow}>{prod ? t("Production R/F", "R/F production") : t("Atelier R/F", "R/F workshop")}</div>
            <h1 className={styles.hello}>{hello}{firstName ? `, ${firstName}` : ""}</h1>
          </div>
          {toggle}
        </div>
        <div className={styles.chips}>
          <span className={`${styles.chip} ${dutyTeam ? styles.chipLive : ""}`}>
            <span className={styles.dot} />
            {dutyTeam ? `${t("Équipe", "Team")} ${dutyTeam} ${t("en poste", "on duty")}${shiftHours ? ` · ${shiftHours}` : ""}` : t("Aucune équipe planifiée", "No team scheduled")}
          </span>
          {general && <span className={`${styles.chip} ${styles.chipLive}`}><span className={styles.dot} />General · 09h–17h</span>}
          {me.team && <span className={styles.chip}>{t("Mon équipe", "My team")} : {me.team === "G" ? "General" : me.team}</span>}
        </div>
      </header>

      {/* Métiers : anneau + trois états qui s'ouvrent au toucher */}
      <section className={`${styles.glass} ${styles.hero} ${styles.rise}`} style={rise()} aria-label={t("État des métiers", "Machine status")}>
        <div className={styles.heroTop}>
          <div className={styles.ring}>
            <svg viewBox="0 0 120 120" className={styles.ringSvg} aria-hidden="true">
              <circle cx="60" cy="60" r={R} className={styles.ringTrack} />
              {segs.map((sg, i) => {
                const len = (sg.n / total) * C;
                const off = -acc;
                acc += len;
                return sg.n ? (
                  <circle key={i} cx="60" cy="60" r={R} className={styles.ringSeg} stroke={sg.color}
                    strokeDasharray={`${drawn ? Math.max(len - 2, 0.1) : 0} ${C}`} strokeDashoffset={off} style={{ transitionDelay: `${i * 120}ms` }} />
                ) : null;
              })}
            </svg>
            <div className={styles.ringCenter}>
              <span className={styles.ringNum}><Num value={running.length} /></span>
              <span className={styles.ringOf}>/{machines.length}</span>
              <span className={styles.ringLabel}>{t("en marche", "running")}</span>
            </div>
          </div>
          <div className={styles.statusList}>
            {statusRows.map((r) => (
              <button key={r.key} type="button" className={`${styles.statusRow} ${openStatus === r.key ? styles.statusOn : ""}`}
                aria-expanded={openStatus === r.key} onClick={() => setOpenStatus((k) => (k === r.key ? null : r.key))}>
                <span className={`${styles.statusDot} ${styles[`d_${r.tone}`]}`} />
                <span className={styles.statusLabel}>{r.label}</span>
                <span className={`${styles.statusNum} ${styles[`c_${r.tone}`]}`}><Num value={r.n} /></span>
                <span className={`${styles.chev} ${openStatus === r.key ? styles.chevOpen : ""}`}><Ico d={ICONS.chevron} size={16} /></span>
              </button>
            ))}
          </div>
        </div>
        <div className={`${styles.reveal} ${openRow ? styles.revealOpen : ""}`}>
          <div className={styles.revealInner}>
            {openRow && (openRow.list.length ? (
              <div className={styles.mGrid}>{openRow.list.map(machineChip)}</div>
            ) : <p className={styles.empty}>{t("Aucun métier.", "No machine.")}</p>)}
          </div>
        </div>
      </section>

      {/* Maintenance programmée (superviseur : bouton pour programmer demain) */}
      {showPlan && (
        <section className={`${styles.glass} ${styles.plan} ${styles.rise} ${onSchedule && evening && planTomorrow.length === 0 ? styles.planCall : ""}`} style={rise()} aria-label={t("Maintenance programmée", "Scheduled maintenance")}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}><Ico d={ICONS.calendar} size={18} /> {t("Maintenance programmée", "Scheduled maintenance")}</span>
          </div>
          {[{ label: t("Aujourd'hui", "Today"), list: planToday }, { label: t("Demain", "Tomorrow"), list: planTomorrow }].filter((x) => x.list.length).map((x) => (
            <div key={x.label} className={styles.planRow}>
              <span className={styles.planDay}>{x.label}</span>
              <div className={styles.planChips}>
                {x.list.map((m) => (
                  <button key={m.no} type="button" className={styles.planChip} onClick={() => onOpenMachine(m.no)}>M/C {pad(m.no)}</button>
                ))}
              </div>
              <span className={styles.planBy}>{t("par", "by")} {x.list[0].plannedBy}{x.list[0].planNote ? ` · « ${x.list[0].planNote} »` : ""}</span>
            </div>
          ))}
          {planToday.length === 0 && planTomorrow.length === 0 && (
            <p className={styles.planEmpty}>{t("Rien de programmé pour aujourd'hui ni demain.", "Nothing scheduled for today or tomorrow.")}</p>
          )}
          {onSchedule && (
            <button type="button" className={styles.planBtn} onClick={onSchedule}>
              <Ico d={ICONS.wrench} size={20} />
              {planTomorrow.length ? t("Modifier la maintenance de demain", "Edit tomorrow's maintenance") : t("Programmer la maintenance de demain", "Schedule tomorrow's maintenance")}
            </button>
          )}
        </section>
      )}

      {/* À surveiller */}
      <section className={`${styles.section} ${styles.rise}`} style={rise()} aria-label={t("À surveiller", "Watch")}>
        <h2 className={styles.h2}>{t("À surveiller", "Watch")}</h2>
        <div className={styles.tiles}>
          {tiles.map((x) => (
            <button key={x.key} type="button"
              className={`${styles.glass} ${styles.tile} ${styles[`tile_${x.tone}`]} ${openTile === x.key ? styles.tileOn : ""} ${x.tone === "crit" ? styles.tilePulse : ""}`}
              aria-expanded={x.direct ? undefined : openTile === x.key}
              onClick={() => (x.direct ? x.direct() : setOpenTile((k) => (k === x.key ? null : x.key)))}>
              <span className={`${styles.tileIco} ${styles[`i_${x.tone}`]}`}>{x.tone === "ok" && !x.direct ? <Ico d={ICONS.check} /> : <Ico d={x.icon} />}</span>
              <span className={`${styles.tileNum} ${styles[`c_${x.tone}`]}`}><Num value={x.count} /></span>
              <span className={styles.tileLabel}>{x.label}</span>
              <span className={styles.tileSub}>{x.sub}</span>
            </button>
          ))}
        </div>
        <div className={`${styles.reveal} ${active ? styles.revealOpen : ""}`}>
          <div className={styles.revealInner}>
            {active && (
              <div className={`${styles.glass} ${styles.panel}`}>
                <div className={styles.panelHead}>
                  <span className={styles.panelTitle}>{active.label}</span>
                  <button type="button" className={styles.link} onClick={() => goto(active.tab)}>{active.tabLabel} ›</button>
                </div>
                {active.late.length === 0 && active.soon.length === 0 && (
                  <p className={styles.calm}><Ico d={ICONS.check} size={18} /> {t("Rien en retard. Bon travail !", "Nothing overdue. Good job!")}</p>
                )}
                {[...active.late, ...active.soon].slice(0, 12).map((x, i) => (
                  <div key={x.key} className={styles.row} style={{ animationDelay: `${i * 40}ms` }}>
                    <span className={`${styles.rowBar} ${styles[`d_${x.tone === "crit" ? (active.key === "fault" ? "crit" : "warn") : "info"}`]}`} />
                    <button type="button" className={styles.rowMain} onClick={() => (x.no ? onOpenMachine(x.no) : goto(active.tab))}>
                      <span className={styles.rowTop}><span className={styles.mono}>{x.mc}</span> · {x.what}</span>
                      <span className={styles.rowWhen}>{x.when}</span>
                    </button>
                    {x.action && <button type="button" className={styles.rowBtn} onClick={x.action.run}>{x.action.label}</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Planning des quarts (production) */}
      {prod && (
        <section className={`${styles.glass} ${styles.shifts} ${styles.rise}`} style={rise()} aria-label={t("Quarts de la semaine", "Shifts this week")}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>{t("Quarts de la semaine", "Shifts this week")}</span>
            <button type="button" className={styles.link} onClick={() => goto("quarts")}>{t("Tout le mois", "Whole month")} ›</button>
          </div>
          <div className={styles.shiftGrid} role="table">
            <div className={styles.shiftHead} role="row">
              <span role="columnheader" />
              {g37.TEAMS.map((tm) => <span key={tm} role="columnheader" className={me.team === tm ? styles.mine : ""}>{t("Éq.", "Team")} {tm}</span>)}
              <span role="columnheader" className={me.team === "G" ? styles.mine : ""}>General</span>
            </div>
            {shiftDays.map((d, i) => (
              <div key={d.iso} role="row" className={`${styles.shiftRow} ${i === 0 ? styles.today : ""}`}>
                <span role="cell" className={styles.shiftDay}>{i === 0 ? t("Auj.", "Today") : d.label}</span>
                {d.codes.map((c, k) => (
                  <span key={k} role="cell" className={`${styles.sh} ${c ? styles[`sh_${c}`] : styles.sh_none} ${me.team === g37.TEAMS[k] ? styles.mineCell : ""}`}>{c ? SHIFT_SHORT[c] ?? c : "—"}</span>
                ))}
                <span role="cell" className={`${styles.sh} ${d.dow === 0 ? styles.sh_r : styles.sh_g} ${me.team === "G" ? styles.mineCell : ""}`}>{d.dow === 0 ? SHIFT_SHORT.r : "9h–17h"}</span>
              </div>
            ))}
          </div>
          <p className={styles.legend}>{t("Matin 07h–15h · Après-midi 15h–23h · Nuit 23h–07h · General 09h–17h (lun.–sam.)", "Morning 07–15 · Afternoon 15–23 · Night 23–07 · General 09–17 (Mon–Sat)")}</p>
        </section>
      )}

      {/* Actions rapides */}
      <section className={`${styles.actions} ${styles.rise}`} style={rise()} aria-label={t("Actions rapides", "Quick actions")}>
        {actions.map((a) => (
          <button key={a.key} type="button" className={`${styles.glass} ${styles.act} ${a.primary ? styles.actMain : ""}`} onClick={a.run}>
            <Ico d={a.icon} /><span>{a.label}</span>
          </button>
        ))}
      </section>

      {onWorkLog && (
        <button type="button" className={`${styles.glass} ${styles.more} ${styles.rise}`} style={rise()} onClick={onWorkLog}>
          <span>{t("Travaux effectués (check-lists, graissages…)", "Work done (checklists, greasing…)")}</span><Ico d={ICONS.chevron} size={18} />
        </button>
      )}

      {!prod && (
        <button type="button" className={`${styles.glass} ${styles.more} ${styles.rise}`} style={rise()} onClick={() => goto("indicateurs")}>
          <span>{t("Indicateurs du mois", "This month's indicators")}</span><Ico d={ICONS.chevron} size={18} />
        </button>
      )}
    </div>
  );
}
