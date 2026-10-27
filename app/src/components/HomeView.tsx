import React, { useMemo, useState } from "react";
import type { OutputType as State, G37Failure } from "../endpoints/g37/state_GET.schema";
import { g37 } from "../helpers/g37";
import styles from "./HomeView.module.css";
import { HomeLive } from "./HomeLive";

// Accueil premium (validé sur maquette le 26/10/2026) :
// Boss = vue d'ensemble du mois (ici). Atelier et production = accueil « vivant » (HomeLive).

export type HomeTodo = {
  key: string;
  group: "fault" | "maint" | "cycle" | "work";
  kind: string;            // libellé court affiché en capitales (Panne, Maintenance clg, Graissage…)
  tone: "crit" | "warn" | "info";
  mc: string;              // « M/C 07 » ou « M/C 21–24 »
  what: string;
  when: string;
  rank: number;            // tri : plus petit = plus urgent
  action?: { label: string; run: () => void };
  cat?: "grease" | "lub" | "sched";   // type d'entretien périodique (group « cycle »)
  n?: number;              // nombre de métiers concernés (« M/C 21–24 » = 4)
  no?: number;             // premier métier concerné (ouvrir sa fiche)
};

export type HomeAction = { key: string; label: string; icon: string; run: () => void; primary?: boolean };

type Props = {
  state: State;
  lang: "fr" | "en";
  todo: HomeTodo[];
  boss: boolean;           // poste Boss / Manager
  canBossView: boolean;    // l'admin peut basculer entre les deux vues
  onOpenMachine: (no: number) => void;
  goto: (tab: string) => void;
  prod?: boolean;          // postes de production (Prod superviseur / Prod manager)
  unread?: number;         // messages non lus
  actions: HomeAction[];   // actions rapides de l'accueil atelier / production
  onMessages: () => void;
  onSchedule?: () => void;   // superviseur : programmer la maintenance de demain
  onWorkLog?: () => void;    // superviseur, manager, Boss : travaux effectués
};

const H = 3600000;
const pad = (n: number) => String(n).padStart(2, "0");
const monthKeyOf = (d: Date) => new Date(d.getTime() + H).toISOString().slice(0, 7);
const fmtH = (h: number) => (h < 10 ? h.toFixed(1).replace(".", ",") : String(Math.round(h)));
const money = (v: number) => Math.round(v).toLocaleString("fr-FR").replace(/ | /g, " ");

function durText(ms: number, fr: boolean) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return `${h} h${m ? ` ${pad(m)}` : ""}`;
  return fr ? `${Math.round(h / 24)} jours` : `${Math.round(h / 24)} days`;
}

function downHours(f: G37Failure, until: Date) {
  if (!f.stoppedAt) return 0;
  const end = f.restartedAt ?? f.resolvedAt ?? until;
  return Math.max(0, (new Date(end).getTime() - new Date(f.stoppedAt).getTime()) / H);
}

export function HomeView({ state, lang, todo, boss, canBossView, onOpenMachine, goto, prod = false, unread = 0, actions, onMessages, onSchedule, onWorkLog }: Props) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [view, setView] = useState<"atelier" | "boss">(() => {
    try { return (localStorage.getItem("g37.homeView") as "atelier" | "boss") || (boss ? "boss" : "atelier"); } catch { return boss ? "boss" : "atelier"; }
  });
  const showBoss = boss || (canBossView && view === "boss");
  const pick = (v: "atelier" | "boss") => { setView(v); try { localStorage.setItem("g37.homeView", v); } catch { /* ignore */ } };

  const now = new Date();
  const me = state.me;
  const machines = state.machines;
  const failures = state.failures ?? [];
  const openFaults = failures.filter((f) => f.status !== "resolue");
  const running = machines.filter((m) => m.status === "service").length;
  const stoppedN = machines.filter((m) => m.status === "arret").length;
  const maintN = machines.filter((m) => m.status === "maintenance").length;

  const hour = Number(new Date(now.getTime() + H).toISOString().slice(11, 13));
  const hello = hour < 12 ? t("Bonjour", "Good morning") : hour < 18 ? t("Bon après-midi", "Good afternoon") : t("Bonsoir", "Good evening");
  const firstName = (me.firstName || me.displayName.split(/\s+/)[0] || "").trim();
  const duty = state.duty ?? null;
  const shiftHours = duty ? g37.SHIFT_TYPES.find((s) => s.k === duty.code)?.h.replace(" — ", "–") : null;

  // Panne la plus longue (machine arrêtée) pour le bandeau rouge.
  const worst = useMemo(() => {
    const stopped = openFaults.filter((f) => f.stoppedAt).sort((a, b) => new Date(a.stoppedAt!).getTime() - new Date(b.stoppedAt!).getTime());
    return stopped[0] ?? openFaults[0] ?? null;
  }, [openFaults]);

  // ---- Chiffres du mois ----
  const month = monthKeyOf(now);
  const prevMonth = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 15));
  const inMonth = (d: Date | string, mk: string) => monthKeyOf(new Date(d)) === mk;
  const monthFaults = failures.filter((f) => inMonth(f.openedAt, month));
  const prevFaults = failures.filter((f) => inMonth(f.openedAt, prevMonth));
  const downMonth = monthFaults.reduce((a, f) => a + downHours(f, now), 0);
  const repairs = monthFaults.filter((f) => f.resolvedAt).map((f) => (new Date(f.resolvedAt!).getTime() - new Date(f.openedAt).getTime()) / 60000).filter((v) => v >= 0);
  const mttr = repairs.length ? repairs.reduce((a, b) => a + b, 0) / repairs.length : null;
  const outs = (state.stockOuts ?? []).filter((o) => inMonth(o.createdAt, month));
  const cost = outs.reduce((a, o) => a + (o.unitCost == null ? 0 : o.unitCost * o.quantity), 0);
  const priced = outs.some((o) => o.unitCost != null);
  const lateMaint = machines.filter((m) => m.nextMaintenance && new Date(m.nextMaintenance).getTime() < now.getTime() - 86400000).length;

  // ---- Magasin : à commander selon la consommation réelle ----
  const toOrder = (state.stock ?? [])
    .map((s) => {
      const qty = Number(s.quantity);
      const min = Number(s.minimumQuantity || g37.STOCK_ALERT);
      const lead = s.leadDays ?? 14;
      const days = s.daysLeft ?? null;
      const urgent = qty < min || (days != null && days <= lead);
      return { s, qty, min, lead, days, urgent };
    })
    .filter((x) => x.urgent)
    .sort((a, b) => (a.days ?? (a.qty < a.min ? -1 : 999)) - (b.days ?? (b.qty < b.min ? -1 : 999)));

  const toggle = canBossView && !boss ? (
    <div className={styles.segment} role="group" aria-label={t("Vue de l'accueil", "Home view")}>
      <button type="button" className={`${styles.segBtn} ${view === "atelier" ? styles.segOn : ""}`} aria-pressed={view === "atelier"} onClick={() => pick("atelier")}>{t("Atelier", "Workshop")}</button>
      <button type="button" className={`${styles.segBtn} ${view === "boss" ? styles.segOn : ""}`} aria-pressed={view === "boss"} onClick={() => pick("boss")}>Boss</button>
    </div>
  ) : null;

  const header = (
    <div className={styles.hello}>
      <div className={styles.helloTop}>
        <div>
          <div className={styles.eyebrow}>{showBoss ? t("Vue d'ensemble", "Overview") : t("Atelier R/F", "R/F workshop")}</div>
          <p className={styles.greet}>{hello}{firstName ? `, ${firstName}` : ""}</p>
        </div>
        {toggle}
      </div>
      <div className={styles.chips}>
        <span className={styles.chip}>
          <span className={styles.chipDot} style={{ background: duty?.team || duty?.general ? "var(--g-accent)" : "var(--g-dim)" }} />
          {duty?.team ? `${t("Équipe", "Team")} ${duty.team} ${t("en poste", "on duty")}${shiftHours ? ` · ${shiftHours}` : ""}` : duty?.general ? `General ${t("en poste", "on duty")} · 09h–17h` : t("Aucune équipe planifiée", "No team scheduled")}
        </span>
        {me.team && (
          <span className={styles.chip}>
            <span className={styles.chipDot} style={{ background: duty?.team === me.team ? "var(--g-ok)" : "var(--g-dim)" }} />
            {t("Mon équipe", "My team")} : {me.team === "G" ? "General" : me.team}
          </span>
        )}
      </div>
    </div>
  );

  const stockCard = toOrder.length > 0 && (
    <section className={styles.card} aria-label={t("À commander", "To order")}>
      <div className={styles.sectionHead}>
        <h2 className={styles.h2} style={{ fontSize: "1rem" }}>{t("À commander bientôt", "Order soon")}</h2>
        <button type="button" className={styles.link} onClick={() => goto("magasin")}>{t("Magasin", "Store")}</button>
      </div>
      {toOrder.slice(0, 4).map(({ s, qty, min, lead, days }) => {
        const pct = days != null ? Math.max(6, Math.min(100, (days / Math.max(lead * 2, 1)) * 100)) : Math.max(6, Math.min(100, (qty / Math.max(min, 1)) * 100));
        const color = (days != null && days <= lead / 2) || qty === 0 ? "var(--g-crit)" : "var(--g-warn)";
        return (
          <div key={s.id} className={styles.stockRow}>
            <div className={styles.stockTop}>
              <span>{s.name}</span>
              <span className={styles.mono} style={{ color }}>{days != null ? `≈ ${days} ${t("j", "d")}` : `${qty} ${s.unit}`}</span>
            </div>
            <div className={styles.track}><div className={styles.fill} style={{ width: `${pct}%`, background: color }} /></div>
          </div>
        );
      })}
    </section>
  );

  // =================== Vue Boss ===================
  if (showBoss) {
    const months: Array<{ key: string; v: number | null }> = [];
    for (let i = 9; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
      const key = monthKeyOf(d);
      const vals = (state.efficiency ?? []).filter((e) => e.month === key).map((e) => Number(e.value)).filter((v) => Number.isFinite(v));
      months.push({ key, v: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null });
    }
    const effNow = months[months.length - 1].v;
    const effPrev = months[months.length - 2].v;
    const known = months.map((m) => m.v).filter((v): v is number => v != null);
    const lo = known.length ? Math.min(...known) - 2 : 0;
    const hi = known.length ? Math.max(...known) + 1 : 100;
    const monthName = new Date(now.getTime()).toLocaleDateString(fr ? "fr-FR" : "en-GB", { month: "long" });

    const cycleLate = todo.filter((x) => x.group === "cycle" && x.tone === "crit").length;
    const since30 = now.getTime() - 30 * 86400000;
    const top = new Map<number, { n: number; down: number; issues: Map<string, number> }>();
    failures.filter((f) => new Date(f.openedAt).getTime() > since30).forEach((f) => {
      const e = top.get(f.machineNo) ?? { n: 0, down: 0, issues: new Map() };
      e.n++; e.down += downHours(f, now); e.issues.set(f.issue, (e.issues.get(f.issue) ?? 0) + 1);
      top.set(f.machineNo, e);
    });
    const topList = [...top.entries()].sort((a, b) => b[1].n - a[1].n || b[1].down - a[1].down).slice(0, 3);
    const n30 = [...top.values()].reduce((a, e) => a + e.n, 0);
    const mtbfDays = n30 ? (30 * machines.length) / n30 : null;
    const team = duty?.team ? state.users.filter((u) => u.team === duty.team && !u.pending) : [];
    const costByMc = new Map<number, number>();
    outs.forEach((o) => { if (o.machineNo && o.unitCost != null) costByMc.set(o.machineNo, (costByMc.get(o.machineNo) ?? 0) + o.unitCost * o.quantity); });
    const topCost = [...costByMc.entries()].sort((a, b) => b[1] - a[1])[0];

    return (
      <div className={styles.home}>
        {header}
        {onWorkLog && (
          <button type="button" className={`${styles.card} ${styles.costCard}`} style={{ flexDirection: "row", alignItems: "center", cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }} onClick={onWorkLog}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
              <span className={styles.statLabel}>{t("Travaux effectués", "Work done")}</span>
              <span style={{ fontWeight: 600 }}>{t("Check-lists, maintenances, graissages et réparations", "Checklists, maintenance, greasing and repairs")}</span>
            </span>
            <span className={styles.costBtn}>{t("Voir", "View")}</span>
          </button>
        )}
        <section className={styles.pulse} aria-label={t("Efficacité du mois", "Monthly efficiency")}>
          <div className={styles.effTop}>
            <div>
              <div className={styles.eyebrow}>{t("Efficacité", "Efficiency")} · {monthName}</div>
              <div className={styles.bigNum} style={{ marginTop: 6 }}>
                {effNow != null ? effNow.toFixed(1).replace(".", ",") : "—"}<span className={styles.bigOf}> %</span>
              </div>
            </div>
            {effNow != null && effPrev != null && (
              <span className={`${styles.delta} ${effNow >= effPrev ? styles.deltaUp : styles.deltaDown}`}>
                {effNow >= effPrev ? "+" : "−"}{Math.abs(effNow - effPrev).toFixed(1).replace(".", ",")} pt {t("vs mois dernier", "vs last month")}
              </span>
            )}
          </div>
          {known.length > 1 ? (
            <>
              <div className={styles.bars} aria-hidden="true">
                {months.map((m, i) => (
                  <div key={m.key} className={`${styles.barCol} ${i === months.length - 1 ? styles.barNow : ""}`}
                    style={{ height: m.v == null ? 4 : `${Math.max(6, ((m.v - lo) / Math.max(hi - lo, 1)) * 64)}px`, opacity: m.v == null ? 0.35 : 1 }} />
                ))}
              </div>
              <div className={styles.barLabels}><span>{new Date(now.getFullYear(), now.getMonth() - 9, 15).toLocaleDateString(fr ? "fr-FR" : "en-GB", { month: "short" })}</span><span>{new Date().toLocaleDateString(fr ? "fr-FR" : "en-GB", { month: "short" })}</span></div>
            </>
          ) : (
            <span className={styles.hint}>{t("L'évolution s'affichera quand l'efficacité de plusieurs mois sera saisie (fiche de chaque métier).", "The trend appears once several months of efficiency are entered (each machine's sheet).")}</span>
          )}
          <div style={{ height: 1, background: "var(--g-line)" }} />
          <div className={styles.split} aria-hidden="true">
            {running > 0 && <span style={{ flex: running, background: "var(--g-ok)" }} />}
            {stoppedN > 0 && <span style={{ flex: stoppedN, background: "var(--g-crit)" }} />}
            {maintN > 0 && <span style={{ flex: maintN, background: "var(--g-warn)" }} />}
          </div>
          <div className={styles.splitLegend}>
            <span><strong className={styles.mono} style={{ color: "var(--g-ok)" }}>{running}</strong> {t("en service", "running")}</span>
            <span><strong className={styles.mono} style={{ color: "var(--g-crit)" }}>{stoppedN}</strong> {t("à l'arrêt", "stopped")}</span>
            <span><strong className={styles.mono} style={{ color: "var(--g-warn)" }}>{maintN}</strong> {t("en maintenance", "in maintenance")}</span>
          </div>
        </section>

        <section className={styles.section} aria-label={t("Points d'attention", "Watch points")}>
          <h2 className={styles.h2}>{t("Points d'attention", "Watch points")}</h2>
          <div className={styles.att}>
            <button type="button" className={`${styles.attCard} ${openFaults.length ? styles.attCrit : styles.attCalm}`} onClick={() => goto("pannes")}>
              <span className={styles.attNum}>{openFaults.length}</span>
              <span className={styles.attLabel}>{t("Pannes ouvertes", "Open faults")}</span>
              <span className={styles.attSub}>{worst?.stoppedAt ? `${t("la plus longue", "longest")} ${durText(now.getTime() - new Date(worst.stoppedAt).getTime(), fr)}` : t("aucune machine arrêtée", "no machine stopped")}</span>
            </button>
            <button type="button" className={`${styles.attCard} ${lateMaint + cycleLate ? styles.attWarn : styles.attCalm}`} onClick={() => goto("maintenance")}>
              <span className={styles.attNum}>{lateMaint + cycleLate}</span>
              <span className={styles.attLabel}>{t("Entretiens en retard", "Overdue upkeep")}</span>
              <span className={styles.attSub}>{lateMaint} {t("maint.", "maint.")} · {cycleLate} {t("graiss.", "grease")}</span>
            </button>
            <button type="button" className={`${styles.attCard} ${toOrder.length ? styles.attWarn : styles.attCalm}`} onClick={() => goto("magasin")}>
              <span className={styles.attNum}>{toOrder.length}</span>
              <span className={styles.attLabel}>{t("À commander", "To order")}</span>
              <span className={styles.attSub}>{t("selon la conso réelle", "by real usage")}</span>
            </button>
          </div>
        </section>

        <section className={styles.card} aria-label={t("Métiers qui tombent le plus", "Most failing machines")}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2} style={{ fontSize: "1rem" }}>{t("Métiers qui tombent le plus", "Most failing machines")}</h2>
            <span className={styles.hint}>{t("30 derniers jours", "last 30 days")}</span>
          </div>
          {topList.length ? topList.map(([no, e]) => {
            const cause = [...e.issues.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
            return (
              <button key={no} type="button" className={styles.topRow} style={{ background: "none", border: 0, padding: 0, color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }} onClick={() => onOpenMachine(no)}>
                <span className={styles.topLine}>
                  <span><strong className={styles.mono}>M/C {pad(no)}</strong> · {cause}</span>
                  <span className={styles.topStat}>{e.n} {t("panne", "fault")}{e.n > 1 ? "s" : ""} · {fmtH(e.down)} h</span>
                </span>
                <span className={styles.track} style={{ display: "block" }}><span className={styles.fill} style={{ display: "block", width: `${(e.n / topList[0][1].n) * 100}%`, background: "var(--g-accent)" }} /></span>
              </button>
            );
          }) : <span className={styles.hint}>{t("Aucune panne ces 30 derniers jours.", "No fault in the last 30 days.")}</span>}
          <div className={styles.kpiRow}>
            <div className={styles.kpiMini}><span className={styles.kpiMiniLabel}>{t("Entre deux pannes", "Between faults")}</span><span className={styles.kpiMiniValue}>{mtbfDays == null ? "—" : `${mtbfDays.toFixed(1).replace(".", ",")} ${t("j", "d")}`}</span></div>
            <div className={styles.kpiMini}><span className={styles.kpiMiniLabel}>{t("Réparation moyenne", "Avg. repair")}</span><span className={styles.kpiMiniValue}>{mttr == null ? "—" : `${Math.round(mttr)} min`}</span></div>
            <div className={styles.kpiMini}><span className={styles.kpiMiniLabel}>{t("Arrêt ce mois", "Downtime (month)")}</span><span className={styles.kpiMiniValue}>{fmtH(downMonth)} h</span></div>
          </div>
        </section>

        {duty?.team && (
          <section className={styles.card} aria-label={t("Équipe en poste", "Team on duty")}>
            <div className={styles.sectionHead}>
              <h2 className={styles.h2} style={{ fontSize: "1rem" }}>{t("Équipe", "Team")} {duty.team} {t("en poste", "on duty")}</h2>
              <span className={styles.hint}>{shiftHours}</span>
            </div>
            {team.length ? team.map((u) => {
              const seen = u.lastSeen ? now.getTime() - new Date(u.lastSeen).getTime() : null;
              const online = seen != null && seen < 10 * 60000;
              const busy = openFaults.find((f) => f.technician && f.technician === u.displayName);
              return (
                <div key={u.id} className={styles.person}>
                  <span className={styles.avatar}>{u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : u.displayName.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("")}</span>
                  <span className={styles.personText}>
                    <span className={styles.personName}>{u.displayName}</span>
                    <span className={styles.personRole}>{g37.ROLES[u.jobRole]?.n ?? u.jobRole}</span>
                  </span>
                  <span className={styles.personNow} style={{ color: busy ? "#fca5a5" : online ? "#6ee7b7" : "var(--g-dim)" }}>
                    {busy ? `${t("Sur", "On")} M/C ${pad(busy.machineNo)}` : online ? t("En ligne", "Online") : t("Hors ligne", "Offline")}
                  </span>
                </div>
              );
            }) : <span className={styles.hint}>{t("Aucun technicien rattaché à cette équipe (onglet Accès).", "No technician assigned to this team (Access tab).")}</span>}
          </section>
        )}

        <section className={`${styles.card} ${styles.costCard}`} aria-label={t("Coût du mois", "Monthly cost")} style={{ flexDirection: "row" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
            <span className={styles.statLabel}>{t("Pièces sorties ce mois", "Parts used this month")}</span>
            <span className={styles.statValue}>{priced ? `${money(cost)} F` : `${outs.length} ${t("sortie", "item")}${outs.length > 1 ? "s" : ""}`}</span>
            <span className={styles.statNote}>
              {priced && topCost && cost > 0 ? `${t("dont", "of which")} ${Math.round((topCost[1] / cost) * 100)} % ${t("pour la", "for")} M/C ${pad(topCost[0])}` : t("Ajoute les prix dans le Magasin pour voir les coûts.", "Add prices in the Store to see costs.")}
            </span>
          </div>
          <button type="button" className={styles.costBtn} onClick={() => goto("indicateurs")}>{t("Rapport", "Report")}</button>
        </section>
        {stockCard}
      </div>
    );
  }

  // =================== Atelier / production ===================
  return (
    <HomeLive state={state} lang={lang} todo={todo} prod={prod} unread={unread} actions={actions} toggle={toggle}
      onOpenMachine={onOpenMachine} goto={goto} onMessages={onMessages} onSchedule={onSchedule} onWorkLog={onWorkLog} />
  );
}
