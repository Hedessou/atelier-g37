import React, { useEffect, useMemo, useState } from "react";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import { g37 } from "../helpers/g37";
import styles from "./MachinesLive.module.css";

// Salle des métiers en direct — version allégée (27/10/2026, retour : « animation moche, app lente »).
// Plus de broches animées ni de flou : des tuiles nettes, une fine ligne qui défile sur les métiers
// en marche (une seule animation légère), le chrono des arrêts. Seuls l'horloge et les chronos
// se mettent à jour chaque seconde, pas toute la liste.

type Props = {
  state: State;
  lang: "fr" | "en";
  onOpen: (no: number) => void;
  groupTags: (from: number) => string[];
  statusName: (code: string) => string;
  stopReasonName: (code: string) => string;
};

const H = 3600000;
const pad = (n: number) => String(n).padStart(2, "0");
type Filter = "all" | "service" | "arret" | "maintenance";

function useTick(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const Clock = () => {
  const now = useTick(1000);
  const d = new Date(now + H);
  return <span className={styles.clock}>{pad(d.getUTCHours())}:{pad(d.getUTCMinutes())}:{pad(d.getUTCSeconds())}</span>;
};

const Chrono = ({ since }: { since: string | Date }) => {
  const now = useTick(1000);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const txt = h >= 48 ? `${Math.floor(h / 24)} j ${pad(h % 24)} h` : `${pad(h)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return <span className={styles.chrono}>{txt}</span>;
};

export function MachinesLive({ state, lang, onOpen, groupTags, statusName, stopReasonName }: Props) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [filter, setFilter] = useState<Filter>("all");
  const minute = useTick(60000);   // badges « aujourd'hui / demain » et fil récent

  const machines = state.machines;
  const faultOn = useMemo(() => {
    const m = new Map<number, number>();
    (state.failures ?? []).filter((f) => f.status !== "resolue").forEach((f) => m.set(f.machineNo, (m.get(f.machineNo) ?? 0) + 1));
    return m;
  }, [state.failures]);
  const running = machines.filter((m) => m.status === "service").length;
  const stopped = machines.filter((m) => m.status === "arret").length;
  const maint = machines.filter((m) => m.status === "maintenance").length;
  const pct = machines.length ? Math.round((running / machines.length) * 100) : 0;
  const todayIso = new Date(minute + H).toISOString().slice(0, 10);
  const tomorrowIso = new Date(minute + H + 86400000).toISOString().slice(0, 10);

  // Les 3 derniers événements des 24 h (liste fixe, pas de défilement).
  const recent = useMemo(() => {
    const since = minute - 24 * H;
    const items: Array<{ at: number; text: string; tone: "crit" | "ok" | "warn" }> = [];
    for (const f of state.failures ?? []) {
      const o = new Date(f.openedAt).getTime();
      if (o > since) items.push({ at: o, tone: "crit", text: `M/C ${pad(f.machineNo)} · ${f.issue}` });
      if (f.resolvedAt && new Date(f.resolvedAt).getTime() > since) items.push({ at: new Date(f.resolvedAt).getTime(), tone: "ok", text: `M/C ${pad(f.machineNo)} · ${t("réparée", "fixed")}` });
    }
    for (const c of state.checklists ?? []) {
      const at = new Date(c.doneAt).getTime();
      if (at > since) items.push({ at, tone: "warn", text: `M/C ${pad(c.machineNo)} · ${t("maintenance faite", "maintenance done")}` });
    }
    return items.sort((a, b) => b.at - a.at).slice(0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.failures, state.checklists, minute, lang]);
  const ago = (at: number) => {
    const m = Math.max(1, Math.round((minute - at) / 60000));
    return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
  };

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
          <Clock />
        </div>
        <div className={styles.gauge} aria-hidden="true">
          {running > 0 && <span className={styles.gOk} style={{ flex: running }} />}
          {stopped > 0 && <span className={styles.gCrit} style={{ flex: stopped }} />}
          {maint > 0 && <span className={styles.gWarn} style={{ flex: maint }} />}
        </div>
        <div className={styles.legend}>
          <span><b className={styles.okTxt}>{running}</b> {t("en marche", "running")}</span>
          <span><b className={styles.critTxt}>{stopped}</b> {t("à l'arrêt", "stopped")}</span>
          <span><b className={styles.warnTxt}>{maint}</b> {t("maintenance", "maintenance")}</span>
          <span className={styles.pct}>{pct} %</span>
        </div>
        {recent.length > 0 && (
          <ul className={styles.recent}>
            {recent.map((r, i) => (
              <li key={i}><i className={styles[`d_${r.tone}`]} /><span>{r.text}</span><em>{ago(r.at)}</em></li>
            ))}
          </ul>
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
              {list.map((m) => {
                const st = m.status === "arret" ? "stop" : m.status === "maintenance" ? "maint" : "run";
                const faults = faultOn.get(m.no) ?? 0;
                const nextIso = m.nextMaintenance ? new Date(m.nextMaintenance).toISOString().slice(0, 10) : null;
                const plan = m.plannedBy && nextIso ? (nextIso === todayIso ? t("Maint. aujourd'hui", "Maint. today") : nextIso === tomorrowIso ? t("Maint. demain", "Maint. tomorrow") : null) : null;
                const dr = g37.draftOf(m.runG, m.runH);
                return (
                  <button key={m.no} type="button" className={`${styles.mc} ${styles[st]}`} onClick={() => onOpen(m.no)} aria-label={`M/C ${m.no} — ${statusName(m.status)}`}>
                    <span className={styles.mcTop}>
                      <span className={styles.mcNo}>{pad(m.no)}</span>
                      <span className={styles.state}>{st === "run" ? t("En marche", "Running") : st === "stop" ? t("Arrêt", "Stopped") : t("Maintenance", "Maintenance")}</span>
                    </span>
                    {st === "run" ? (
                      <span className={styles.data}>G {m.runG ?? "—"} · H {m.runH ?? "—"}{dr ? <><br />Draft {dr.toFixed(2).replace(".", ",")}</> : null}</span>
                    ) : (
                      <span className={styles.data}>
                        <span className={styles.why}>{m.stopReason ? stopReasonName(m.stopReason) : statusName(m.status)}</span>
                        {m.stoppedSince && <Chrono since={m.stoppedSince} />}
                      </span>
                    )}
                    {(faults > 0 || plan) && (
                      <span className={styles.badges}>
                        {faults > 0 && <span className={styles.bFault}>{faults} {t("panne", "fault")}{faults > 1 ? "s" : ""}</span>}
                        {plan && <span className={styles.bPlan}>{plan}</span>}
                      </span>
                    )}
                    <span className={styles.flow} aria-hidden="true"><span /></span>
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
