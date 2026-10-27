import React, { useEffect, useMemo, useState } from "react";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import { g37 } from "../helpers/g37";
import styles from "./MachinesLive.module.css";

// Salle des métiers « en direct » (27/10/2026) : les broches tournent sur les métiers en marche,
// le fil défile ; un métier arrêté s'éteint en rouge avec son chrono qui court ; la maintenance
// fait tourner l'engrenage. Fil d'actualité en haut, filtres, toucher un métier ouvre sa fiche.

type Props = {
  state: State;
  lang: "fr" | "en";
  onOpen: (no: number) => void;
  groupTags: (from: number) => string[];   // ex. « Ring 36 mm », « ACL 160 mm »
  statusName: (code: string) => string;
  stopReasonName: (code: string) => string;
};

const H = 3600000;
const pad = (n: number) => String(n).padStart(2, "0");
const chrono = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h >= 48 ? `${Math.floor(h / 24)} j ${pad(h % 24)} h` : `${pad(h)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const ago = (ms: number, fr: boolean) => {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return fr ? `il y a ${m} min` : `${m} min ago`;
  const h = Math.round(m / 60);
  return fr ? `il y a ${h} h` : `${h} h ago`;
};
const SPINDLES = [12, 31, 50, 69, 88, 107];

type Filter = "all" | "service" | "arret" | "maintenance";

export function MachinesLive({ state, lang, onOpen, groupTags, statusName, stopReasonName }: Props) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const machines = state.machines;
  const openFaults = (state.failures ?? []).filter((f) => f.status !== "resolue");
  const faultOn = new Map<number, number>();
  openFaults.forEach((f) => faultOn.set(f.machineNo, (faultOn.get(f.machineNo) ?? 0) + 1));
  const running = machines.filter((m) => m.status === "service").length;
  const stopped = machines.filter((m) => m.status === "arret").length;
  const maint = machines.filter((m) => m.status === "maintenance").length;
  const pct = machines.length ? Math.round((running / machines.length) * 100) : 0;
  const local = new Date(now + H);
  const clock = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const todayIso = local.toISOString().slice(0, 10);
  const tomorrowIso = new Date(now + H + 86400000).toISOString().slice(0, 10);

  // Fil en direct : ce qui s'est passé ces dernières 24 h.
  const feed = useMemo(() => {
    const since = Date.now() - 24 * H;
    const items: Array<{ at: number; text: string; tone: "crit" | "ok" | "warn" }> = [];
    for (const f of state.failures ?? []) {
      const o = new Date(f.openedAt).getTime();
      if (o > since) items.push({ at: o, tone: "crit", text: `M/C ${pad(f.machineNo)} · ${t("panne", "fault")} : ${f.issue}` });
      if (f.resolvedAt && new Date(f.resolvedAt).getTime() > since) items.push({ at: new Date(f.resolvedAt).getTime(), tone: "ok", text: `M/C ${pad(f.machineNo)} · ${t("réparée", "fixed")}${f.fixedBy ? ` ${t("par", "by")} ${f.fixedBy}` : ""}` });
    }
    for (const c of state.checklists ?? []) {
      const at = new Date(c.doneAt).getTime();
      if (at > since) items.push({ at, tone: "warn", text: `M/C ${pad(c.machineNo)} · ${t("maintenance faite", "maintenance done")}${c.authorName ? ` ${t("par", "by")} ${c.authorName}` : ""}` });
    }
    for (const w of state.works ?? []) {
      if (w.status === "done" && w.doneAt && new Date(w.doneAt).getTime() > since) items.push({ at: new Date(w.doneAt).getTime(), tone: "ok", text: `M/C ${pad(w.machineNo)} · ${w.title}` });
    }
    return items.sort((a, b) => b.at - a.at).slice(0, 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.failures, state.checklists, state.works, lang]);

  const FILTERS: Array<{ k: Filter; label: string; n: number; tone: string }> = [
    { k: "all", label: t("Tous", "All"), n: machines.length, tone: "" },
    { k: "service", label: t("En marche", "Running"), n: running, tone: styles.fOk },
    { k: "arret", label: t("À l'arrêt", "Stopped"), n: stopped, tone: styles.fCrit },
    { k: "maintenance", label: t("Maintenance", "Maintenance"), n: maint, tone: styles.fWarn },
  ];

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div className={styles.heroTop}>
          <div>
            <div className={styles.live}><span className={styles.liveDot} /> {t("EN DIRECT", "LIVE")}</div>
            <h1 className={styles.h1}>{t("Salle des métiers", "Machine floor")}</h1>
          </div>
          <div className={styles.clock} aria-label={t("Heure", "Time")}>{clock}</div>
        </div>
        <div className={styles.gauge} aria-label={t(`${pct} % des métiers tournent`, `${pct}% of machines running`)}>
          <div className={styles.gaugeFill} style={{ width: `${pct}%` }}><span className={styles.gaugeShine} /></div>
        </div>
        <div className={styles.gaugeLegend}>
          <span><strong className={styles.okTxt}>{running}</strong> {t("tournent", "running")}</span>
          <span><strong className={styles.critTxt}>{stopped}</strong> {t("arrêtés", "stopped")}</span>
          <span><strong className={styles.warnTxt}>{maint}</strong> {t("en maintenance", "in maintenance")}</span>
          <span className={styles.pct}>{pct} %</span>
        </div>
        {feed.length > 0 && (
          <div className={styles.ticker} aria-label={t("Fil en direct", "Live feed")}>
            <div className={styles.tickerTrack} style={{ animationDuration: `${Math.max(18, feed.length * 7)}s` }}>
              {[...feed, ...feed].map((f, i) => (
                <span key={i} className={styles.tick}><i className={styles[`d_${f.tone}`]} />{f.text} <em>{ago(now - f.at, fr)}</em></span>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className={styles.filters} role="group" aria-label={t("Filtrer", "Filter")}>
        {FILTERS.map((f) => (
          <button key={f.k} type="button" className={`${styles.filter} ${f.tone} ${filter === f.k ? styles.filterOn : ""}`} onClick={() => setFilter(f.k)} aria-pressed={filter === f.k}>
            {f.label} <span>{f.n}</span>
          </button>
        ))}
      </div>

      {g37.GROUPS.map((grp) => {
        const list = machines.filter((m) => m.no >= grp.from && m.no <= grp.to && (filter === "all" || m.status === filter));
        if (!list.length) return null;
        return (
          <section key={grp.id} className={styles.group}>
            <div className={styles.groupHead}>
              <span className={styles.groupName}>{t("Groupe", "Group")} {grp.id} · M/C {grp.from}–{grp.to}</span>
              {groupTags(grp.from).map((x) => <span key={x} className={styles.tag}>{x}</span>)}
            </div>
            <div className={styles.grid}>
              {list.map((m, i) => {
                const st = m.status === "arret" ? "stop" : m.status === "maintenance" ? "maint" : "run";
                const faults = faultOn.get(m.no) ?? 0;
                const since = m.stoppedSince ? now - new Date(m.stoppedSince).getTime() : null;
                const nextIso = m.nextMaintenance ? new Date(m.nextMaintenance).toISOString().slice(0, 10) : null;
                const plan = m.plannedBy && nextIso ? (nextIso === todayIso ? t("Maint. aujourd'hui", "Maint. today") : nextIso === tomorrowIso ? t("Maint. demain", "Maint. tomorrow") : null) : null;
                const dr = g37.draftOf(m.runG, m.runH);
                const speed = 0.55 + ((m.no * 37) % 30) / 100;   // chaque métier a son propre rythme
                return (
                  <button key={m.no} type="button" className={`${styles.mc} ${styles[st]}`} onClick={() => onOpen(m.no)}
                    style={{ animationDelay: `${Math.min(i, 8) * 45}ms`, "--spin": `${speed}s` } as React.CSSProperties}
                    aria-label={`M/C ${m.no} — ${statusName(m.status)}`}>
                    <span className={styles.mcTop}>
                      <span className={styles.mcNo}>M/C {pad(m.no)}</span>
                      <span className={styles.led} />
                    </span>
                    <svg viewBox="0 0 120 44" className={styles.frame} aria-hidden="true">
                      <rect x="2" y="3" width="116" height="5" rx="2.5" className={styles.bar} />
                      {SPINDLES.map((x, k) => (
                        <g key={x}>
                          <line x1={x} y1="8" x2={x} y2="19" className={styles.yarn} style={{ animationDelay: `${-k * 0.13}s` }} />
                          <g transform={`translate(${x} 25)`}>
                            <circle r="6.5" className={styles.ring} style={{ animationDelay: `${-k * 0.11}s` }} />
                            <circle r="2.4" className={styles.bobbin} />
                          </g>
                        </g>
                      ))}
                      <rect x="2" y="34" width="116" height="7" rx="3" className={styles.body} />
                    </svg>
                    {st === "maint" && <span className={styles.gear} aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></svg></span>}
                    <span className={styles.mcInfo}>
                      {st === "run" && <span className={styles.mono}>G {m.runG ?? "—"} · H {m.runH ?? "—"}{dr ? ` · D ${dr.toFixed(2).replace(".", ",")}` : ""}</span>}
                      {st !== "run" && <span className={styles.why}>{m.stopReason ? stopReasonName(m.stopReason) : statusName(m.status)}</span>}
                      {st !== "run" && since != null && <span className={styles.chrono}>{chrono(since)}</span>}
                    </span>
                    {(faults > 0 || plan) && (
                      <span className={styles.badges}>
                        {faults > 0 && <span className={styles.bFault}>{faults} {t("panne", "fault")}{faults > 1 ? "s" : ""}</span>}
                        {plan && <span className={styles.bPlan}>{plan}</span>}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
