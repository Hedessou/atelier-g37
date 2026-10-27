import React, { useMemo, useState } from "react";
import type { OutputType as State, G37Checklist } from "../endpoints/g37/state_GET.schema";
import { g37 } from "../helpers/g37";
import { splitZone } from "./Checklist";
import styles from "./WorkLogView.module.css";

// « Travaux effectués » (27/10/2026) : ce qui a été fait sur les métiers, pour le superviseur,
// le manager, le Boss et l'admin. Maintenances avec leur check-list (cases, remarques, photos),
// graissages / lubrifications / schedule works, travaux clôturés et pannes réparées.

type Props = { state: State; lang: "fr" | "en"; onBack: () => void; onOpenMachine: (no: number) => void };
type Kind = "maint" | "cycle" | "work" | "fault";
type Entry = {
  key: string; kind: Kind; at: number; day: string; machines: number[]; title: string; who: string | null;
  sub?: string; tone: "ok" | "warn" | "crit" | "info";
  checklist?: G37Checklist | null; maintNotes?: string | null; faultNotes?: string | null; parts?: string[];
  cycleKind?: string;
  noTime?: boolean;          // date seule connue (pas d'heure)
};

const H = 3600000;
const D = 86400000;
const dayKey = (t: number) => new Date(t + H).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (t: number) => { const d = new Date(t + H); return `${pad(d.getUTCHours())}h${pad(d.getUTCMinutes())}`; };
const mcLabel = (list: number[]) => {
  const s = [...new Set(list)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? pad(s[i]) : `${pad(s[i])}–${pad(s[j])}`);
    i = j + 1;
  }
  return `M/C ${parts.join(", ")}`;
};

const Ico = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const IC = {
  maint: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
  cycle: "M12 2.7c3 3.4 6 6.9 6 10.3a6 6 0 0 1-12 0c0-3.4 3-6.9 6-10.3z",
  work: "M9 5h6M9 3h6v4H9zM6 5H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-1M8 13l2 2 5-5",
  fault: "M12 3l10 18H2L12 3zM12 10v5M12 18h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  cross: "M6 6l12 12M18 6L6 18",
  chev: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
};

export function WorkLogView({ state, lang, onBack, onOpenMachine }: Props) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [period, setPeriod] = useState<1 | 2 | 7 | 30>(7);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [mc, setMc] = useState<number | 0>(0);
  const [open, setOpen] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  const pointName = useMemo(() => {
    const m = new Map<string, string>();
    g37.GREASE_POINTS.forEach((p) => m.set(`grease|${p.k}`, p.n));
    g37.LUB_BOXES.forEach((p) => m.set(`lub|${p.k}`, p.n));
    state.cyclePoints.forEach((p) => m.set(`${p.kind}|${p.key}`, p.name));
    return m;
  }, [state.cyclePoints]);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    const lists = state.checklists ?? [];
    const used = new Set<string>();
    // Maintenances (avec leur check-list quand elle existe).
    for (const r of state.maintenance ?? []) {
      const cl = lists.find((c) => c.maintenanceId === r.id)
        ?? lists.find((c) => !used.has(c.id) && c.machineNo === r.machineNo && dayKey(new Date(c.doneAt).getTime()) === dayKey(new Date(r.performedAt).getTime()))
        ?? null;
      if (cl) used.add(cl.id);
      const at = cl ? new Date(cl.doneAt).getTime() : new Date(r.performedAt).getTime() + 12 * H - H;
      const done = cl ? cl.items.filter((i) => i.done).length : 0;
      const total = cl ? cl.items.length : 0;
      out.push({
        key: `m${r.id}`, kind: "maint", at, day: dayKey(at), machines: [r.machineNo],
        title: r.maintenanceType === "Visite périodique" ? t("Maintenance clg", "Cleaning maintenance") : r.maintenanceType,
        who: r.technician, tone: cl ? (done === total ? "ok" : "warn") : "info",
        sub: cl ? t(`Check-list ${done}/${total}`, `Checklist ${done}/${total}`) : t("Sans check-list", "No checklist"),
        checklist: cl, maintNotes: cl ? cl.notes : r.notes, noTime: !cl,
      });
    }
    // Graissages, lubrifications, schedule works : regroupés par jour, point et personne.
    const groups = new Map<string, { kind: string; key: string; day: string; who: string | null; nos: number[] }>();
    for (const g of state.greasing ?? []) {
      const day = new Date(g.doneOn).toISOString().slice(0, 10);
      const k = `${day}|${g.kind}|${g.pointKey}|${g.authorName ?? ""}`;
      const e = groups.get(k) ?? { kind: g.kind, key: g.pointKey, day, who: g.authorName, nos: [] };
      e.nos.push(g.machineNo);
      groups.set(k, e);
    }
    for (const [k, g] of groups) {
      const at = new Date(`${g.day}T11:00:00Z`).getTime();
      const label = g.kind === "grease" ? t("Graissage", "Greasing") : g.kind === "lub" ? t("Lubrification", "Lubrication") : "Schedule works";
      out.push({ key: `c${k}`, kind: "cycle", at, day: g.day, machines: g.nos, title: `${label} · ${pointName.get(`${g.kind}|${g.key}`) ?? g.key}`, who: g.who, tone: "info", cycleKind: g.kind, noTime: true });
    }
    // Travaux clôturés.
    for (const w of state.works ?? []) {
      if (w.status !== "done" || !w.doneAt) continue;
      const at = new Date(w.doneAt).getTime();
      out.push({ key: `w${w.id}`, kind: "work", at, day: dayKey(at), machines: [w.machineNo], title: w.title, who: w.doneByName, tone: "ok", sub: w.authorName ? t(`Demandé par ${w.authorName}`, `Requested by ${w.authorName}`) : undefined });
    }
    // Pannes réparées (pièces utilisées comprises).
    const partsOf = new Map<string, string[]>();
    for (const o of state.stockOuts ?? []) if (o.failureId) partsOf.set(o.failureId, [...(partsOf.get(o.failureId) ?? []), `${o.quantity} ${o.unit} ${o.itemName}`]);
    for (const f of state.failures ?? []) {
      if (f.status !== "resolue" || !f.resolvedAt) continue;
      const at = new Date(f.resolvedAt).getTime();
      const mins = Math.max(1, Math.round((at - new Date(f.openedAt).getTime()) / 60000));
      const dur = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${pad(mins % 60)}`;
      out.push({
        key: `f${f.id}`, kind: "fault", at, day: dayKey(at), machines: [f.machineNo], title: f.issue, who: f.fixedBy ?? f.technician, tone: "crit",
        sub: t(`Réparée en ${dur}`, `Fixed in ${dur}`), faultNotes: f.notes, parts: partsOf.get(f.id),
      });
    }
    return out.sort((a, b) => b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, lang, pointName]);

  const today = dayKey(Date.now());
  const fromDay = dayKey(Date.now() - (period - 1) * D);
  const inPeriod = entries.filter((e) => e.day >= fromDay && e.day <= today);
  const shown = inPeriod.filter((e) => (kind === "all" || e.kind === kind) && (!mc || e.machines.includes(mc)));
  const count = (k: Kind) => inPeriod.filter((e) => e.kind === k && (!mc || e.machines.includes(mc))).length;
  const days = [...new Set(shown.map((e) => e.day))];
  const dayTitle = (d: string) => {
    if (d === today) return t("Aujourd'hui", "Today");
    if (d === dayKey(Date.now() - D)) return t("Hier", "Yesterday");
    return new Date(`${d}T12:00:00Z`).toLocaleDateString(fr ? "fr-FR" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  };

  const KINDS: Array<{ k: Kind; label: string; icon: string; tone: string }> = [
    { k: "maint", label: t("Maintenances", "Maintenance"), icon: IC.maint, tone: styles.tWarn },
    { k: "cycle", label: t("Graissage & co", "Greasing & co"), icon: IC.cycle, tone: styles.tInfo },
    { k: "work", label: t("Travaux", "Works"), icon: IC.work, tone: styles.tOk },
    { k: "fault", label: t("Pannes réparées", "Faults fixed"), icon: IC.fault, tone: styles.tCrit },
  ];

  const renderChecklist = (cl: G37Checklist) => {
    const zones: Array<{ name: string | null; items: typeof cl.items }> = [];
    for (const it of cl.items) {
      const [z] = splitZone(it.text);
      const last = zones[zones.length - 1];
      if (last && last.name === z) last.items.push(it);
      else zones.push({ name: z, items: [it] });
    }
    const done = cl.items.filter((i) => i.done).length;
    const pct = cl.items.length ? Math.round((done / cl.items.length) * 100) : 0;
    return (
      <div className={styles.cl}>
        <div className={styles.clBar}><span style={{ width: `${pct}%` }} className={pct === 100 ? styles.barOk : styles.barWarn} /></div>
        <div className={styles.clPct}>{done}/{cl.items.length} · {pct} %</div>
        {zones.map((z, zi) => {
          const zDone = z.items.filter((i) => i.done).length;
          return (
            <div key={zi} className={styles.zone}>
              {z.name && <div className={styles.zoneHead}><span>{z.name}</span><span className={zDone === z.items.length ? styles.zOk : styles.zWarn}>{zDone}/{z.items.length}</span></div>}
              {z.items.map((it, i) => (
                <div key={i} className={`${styles.step} ${it.done ? "" : styles.stepMiss}`}>
                  <span className={it.done ? styles.yes : styles.no}><Ico d={it.done ? IC.check : IC.cross} size={14} /></span>
                  <span className={styles.stepText}>
                    {splitZone(it.text)[1]}{it.extra ? <em className={styles.extra}> · {t("ajoutée", "added")}</em> : null}
                    {it.note && <span className={styles.stepNote}>{it.note}</span>}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        {(cl.photoBeforeUrl || cl.photoAfterUrl) && (
          <div className={styles.photos}>
            {cl.photoBeforeUrl && <button type="button" className={styles.photo} onClick={() => setPhoto(cl.photoBeforeUrl)}><img src={cl.photoBeforeUrl} alt="" /><span>{t("Avant", "Before")}</span></button>}
            {cl.photoAfterUrl && <button type="button" className={styles.photo} onClick={() => setPhoto(cl.photoAfterUrl)}><img src={cl.photoAfterUrl} alt="" /><span>{t("Après", "After")}</span></button>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <button type="button" className={styles.back} onClick={onBack} aria-label={t("Retour", "Back")}><Ico d={IC.back} size={22} /></button>
        <div>
          <h1 className={styles.h1}>{t("Travaux effectués", "Work done")}</h1>
          <p className={styles.sub}>{t("Maintenances, check-lists, graissages, travaux et pannes réparées", "Maintenance, checklists, greasing, works and fixed faults")}</p>
        </div>
      </div>

      <div className={styles.seg} role="group" aria-label={t("Période", "Period")}>
        {([[1, t("Aujourd'hui", "Today")], [2, t("Depuis hier", "Since yesterday")], [7, t("7 jours", "7 days")], [30, t("30 jours", "30 days")]] as Array<[1 | 2 | 7 | 30, string]>).map(([p, l]) => (
          <button key={p} type="button" className={period === p ? styles.segOn : styles.segBtn} onClick={() => setPeriod(p)}>{l}</button>
        ))}
      </div>

      <div className={styles.kinds}>
        {KINDS.map((k) => (
          <button key={k.k} type="button" className={`${styles.kind} ${k.tone} ${kind === k.k ? styles.kindOn : ""}`} onClick={() => setKind((v) => (v === k.k ? "all" : k.k))}>
            <span className={styles.kindIco}><Ico d={k.icon} /></span>
            <span className={styles.kindNum}>{count(k.k)}</span>
            <span className={styles.kindLabel}>{k.label}</span>
          </button>
        ))}
      </div>

      <label className={styles.mcPick}>
        <span>{t("Métier", "Machine")}</span>
        <select value={mc} onChange={(e) => setMc(Number(e.target.value))}>
          <option value={0}>{t("Tous les métiers", "All machines")}</option>
          {state.machines.map((m) => <option key={m.no} value={m.no}>M/C {pad(m.no)}</option>)}
        </select>
      </label>

      {days.length === 0 && <div className={styles.empty}>{t("Rien d'enregistré sur cette période.", "Nothing recorded in this period.")}</div>}

      {days.map((d) => (
        <section key={d} className={styles.day}>
          <h2 className={styles.dayTitle}>{dayTitle(d)}</h2>
          {shown.filter((e) => e.day === d).map((e, i) => {
            const isOpen = open === e.key;
            const expandable = e.kind === "maint" || !!e.faultNotes || !!e.parts?.length;
            return (
              <article key={e.key} className={`${styles.entry} ${styles[`e_${e.kind}`]} ${isOpen ? styles.entryOpen : ""}`} style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                <button type="button" className={styles.entryHead} onClick={() => expandable ? setOpen((k) => (k === e.key ? null : e.key)) : onOpenMachine(e.machines[0])} aria-expanded={expandable ? isOpen : undefined}>
                  <span className={`${styles.badge} ${styles[`b_${e.tone}`]}`}><Ico d={IC[e.kind]} /></span>
                  <span className={styles.entryMain}>
                    <span className={styles.entryTop}><span className={styles.mono}>{mcLabel(e.machines)}</span>{!e.noTime && <span className={styles.time}>{hhmm(e.at)}</span>}</span>
                    <span className={styles.entryTitle}>{e.title}</span>
                    <span className={styles.entrySub}>{[e.sub, e.who ? t(`par ${e.who}`, `by ${e.who}`) : null].filter(Boolean).join(" · ")}</span>
                  </span>
                  {expandable && <span className={`${styles.chev} ${isOpen ? styles.chevOpen : ""}`}><Ico d={IC.chev} /></span>}
                </button>
                <div className={`${styles.reveal} ${isOpen ? styles.revealOpen : ""}`}>
                  <div className={styles.revealInner}>
                    {isOpen && (
                      <div className={styles.detail}>
                        {e.checklist && renderChecklist(e.checklist)}
                        {e.maintNotes && <p className={styles.notes}><strong>{t("Remarques", "Notes")} :</strong> {e.maintNotes}</p>}
                        {e.faultNotes && <p className={styles.notes}><strong>{t("Réparation", "Repair")} :</strong> {e.faultNotes}</p>}
                        {e.parts?.length ? <p className={styles.notes}><strong>{t("Pièces", "Parts")} :</strong> {e.parts.join(", ")}</p> : null}
                        <button type="button" className={styles.link} onClick={() => onOpenMachine(e.machines[0])}>{t("Fiche du métier", "Machine sheet")} ›</button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      ))}

      {photo && (
        <button type="button" className={styles.viewer} onClick={() => setPhoto(null)} aria-label={t("Fermer", "Close")}>
          <img src={photo} alt="" />
        </button>
      )}
    </div>
  );
}
